import type {
  DeviceDeletion,
  TailnetAdmin,
  TailnetAdminOpening,
  TailnetAdminSession,
  TailnetDeviceList,
} from "../application/tailnet-admin";
import type { SecretMaterial } from "../domain/secrets";
import type { TailnetDevice } from "../domain/tailnet";
import { isRecord } from "../domain/validation";

/** Tailscale's API. */
export const TAILSCALE_API = "https://api.tailscale.com";
/** The deadline of each request: the token exchange, the device list, one deletion. */
export const TAILSCALE_API_TIMEOUT_MS = 15_000;

/**
 * The client ID sent with the secret. Tailscale's API reference sends an OAuth client's ID and
 * secret; this adapter, like Tailscale's own CLI exchanging a `tskey-client-` secret, sends the
 * secret with a placeholder ID, which Tailscale ignores. That is undocumented behavior
 * (`docs/specs/worker-lifecycle.md` §Tailnet device removal): factory.json keeps only the secret.
 */
const PLACEHOLDER_CLIENT_ID = "fffactory";

const CLIENT_SECRET_PREFIX = "tskey-client-";

/** A device ID that may be put in a URL path: the API's node and legacy IDs are such tokens. */
const DEVICE_ID = /^[A-Za-z0-9_-]+$/;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TailscaleApiAdminOptions {
  readonly baseUrl?: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One listed device; a field of the wrong type reads as absent, so it can never match. */
function deviceOf(value: Readonly<Record<string, unknown>>): TailnetDevice {
  const nodeId = text(value.nodeId);
  return {
    id: nodeId === "" ? text(value.id) : nodeId,
    hostName: text(value.hostname),
    dnsName: text(value.name),
    tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === "string") : [],
  };
}

const UNREADABLE_LIST = "Tailscale answered a device list fffactory cannot read";

function devicesOf(body: string): TailnetDeviceList {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return { kind: "failed", reason: UNREADABLE_LIST };
  }
  if (!isRecord(document) || !Array.isArray(document.devices))
    return { kind: "failed", reason: UNREADABLE_LIST };
  return { kind: "devices", devices: document.devices.filter(isRecord).map(deviceOf) };
}

/** Thrown inside a request: why it failed, in fffactory's words. */
class ApiFailure extends Error {}

/** Statuses with which Tailscale refuses an OAuth client's credentials. */
const REFUSED = new Set([400, 401, 403]);

/** One answer, read whole within the request's deadline. */
interface Answer {
  readonly status: number;
  readonly body: string;
}

/** The answer's body; a status other than `ok`'s is named, its body never quoted. */
function bodyOf(answer: Answer, ok: (status: number) => boolean): string {
  if (ok(answer.status)) return answer.body;
  throw new ApiFailure(`Tailscale answered HTTP ${answer.status}`);
}

/** The access token the token exchange answered; never the answer itself. */
function tokenOf(exchange: Answer): string {
  if (REFUSED.has(exchange.status))
    throw new ApiFailure(`Tailscale refused the admin client (HTTP ${exchange.status})`);
  const body = bodyOf(exchange, (status) => status === 200);
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    answer = undefined;
  }
  const token = isRecord(answer) ? text(answer.access_token) : "";
  if (token === "") throw new ApiFailure("Tailscale answered no usable token");
  return token;
}

/** The status with which Tailscale refuses an expired token. */
const UNAUTHORIZED = 401;

/**
 * TailnetAdmin over Tailscale's API with `fetch`: the OAuth token exchange, the tailnet's device
 * list and device deletion, each request within `timeoutMs` and never following a redirect.
 * Failures are named by HTTP status or network error code: no answer body, token or secret
 * ever reaches a reason. The token, and the secret it is renewed from, live only in the
 * session's closure: a token lasts about an hour, which a slow confirmation and terminate's wait
 * can outlast, so a call refused with HTTP 401 renews it once and is retried.
 */
export function tailscaleApiAdmin(options: TailscaleApiAdminOptions = {}): TailnetAdmin {
  const base = options.baseUrl ?? TAILSCALE_API;
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TAILSCALE_API_TIMEOUT_MS;

  /** One request's whole answer within the deadline; rejects with an `ApiFailure`. */
  async function request(path: string, init: RequestInit): Promise<Answer> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await send(`${base}${path}`, { ...init, signal, redirect: "error" });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (signal.aborted)
        throw new ApiFailure(`Tailscale did not answer within ${timeoutMs / 1000} s`);
      const code = (error as { code?: unknown } | undefined)?.code;
      const named = typeof code === "string" && /^[A-Za-z_]+$/.test(code) ? code : "network error";
      throw new ApiFailure(`Tailscale could not be reached (${named})`);
    }
  }

  /** Runs `work`, resolving its `ApiFailure` to `failed`; anything else is a defect. */
  async function settled<T>(
    work: () => Promise<T>,
  ): Promise<T | { readonly kind: "failed"; readonly reason: string }> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiFailure) return { kind: "failed", reason: error.message };
      throw error;
    }
  }

  /** A fresh access token for the client secret; rejects with an `ApiFailure`. */
  async function exchange(secret: string): Promise<string> {
    const answer = await request("/api/v2/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: PLACEHOLDER_CLIENT_ID,
        client_secret: secret,
      }).toString(),
    });
    return tokenOf(answer);
  }

  function session(clientSecret: SecretMaterial, first: string): TailnetAdminSession {
    let token = first;
    /** One request with the token; refused with 401, it renews the token once and is retried. */
    async function authorized(path: string, init: RequestInit = {}): Promise<Answer> {
      const attempt = () =>
        request(path, { ...init, headers: { authorization: `Bearer ${token}` } });
      const answer = await attempt();
      if (answer.status !== UNAUTHORIZED) return answer;
      token = await exchange(clientSecret.reveal());
      return attempt();
    }
    return {
      devices: () =>
        settled(async () => {
          const listing = await authorized("/api/v2/tailnet/-/devices");
          return devicesOf(bodyOf(listing, (status) => status === 200));
        }),
      remove: (deviceId) =>
        settled(async (): Promise<DeviceDeletion> => {
          if (!DEVICE_ID.test(deviceId))
            return { kind: "failed", reason: "Tailscale listed no usable ID for the device" };
          const deletion = await authorized(`/api/v2/device/${deviceId}`, { method: "DELETE" });
          // Already gone: what the deletion was for.
          bodyOf(deletion, (status) => (status >= 200 && status < 300) || status === 404);
          return { kind: "removed" };
        }),
    };
  }

  return {
    open: (clientSecret: SecretMaterial) =>
      settled(async (): Promise<TailnetAdminOpening> => {
        const secret = clientSecret.reveal();
        if (!secret.startsWith(CLIENT_SECRET_PREFIX))
          return {
            kind: "failed",
            reason:
              "the stored admin client secret is not a Tailscale OAuth client secret (tskey-client-...)",
          };
        return { kind: "open", session: session(clientSecret, await exchange(secret)) };
      }),
  };
}
