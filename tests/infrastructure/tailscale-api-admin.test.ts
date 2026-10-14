import { afterEach, describe, expect, test } from "bun:test";
import type { TailnetAdminSession } from "../../src/application/tailnet-admin";
import { SecretMaterial } from "../../src/domain/secrets";
import {
  TAILSCALE_API,
  TAILSCALE_API_TIMEOUT_MS,
  tailscaleApiAdmin,
} from "../../src/infrastructure/tailscale-api-admin";
import {
  type StubTailscaleApi,
  type StubTailscaleApiOptions,
  stubTailscaleApi,
  TOKEN,
} from "../support/stub-tailscale-api";

const SECRET = "tskey-client-kExample1CNTRL-0123456789abcdefSECRET";
const HOSTNAME = "fff-abcd1234-builder-1";
const WORKER = {
  nodeId: "nWorker1CNTRL",
  id: "123456789",
  hostname: HOSTNAME,
  name: `${HOSTNAME}.example-tailnet.ts.net`,
  tags: ["tag:factory"],
};

let stub: StubTailscaleApi | undefined;
afterEach(() => {
  stub?.stop();
  stub = undefined;
});

function against(options: Partial<StubTailscaleApiOptions> = {}, timeoutMs?: number) {
  stub = stubTailscaleApi({ secret: SECRET, devices: [WORKER], ...options });
  return tailscaleApiAdmin({ baseUrl: stub.url, ...(timeoutMs ? { timeoutMs } : {}) });
}

async function session(options: Partial<StubTailscaleApiOptions> = {}) {
  const opening = await against(options).open(new SecretMaterial(SECRET));
  if (opening.kind !== "open") throw new Error(`not open: ${opening.reason}`);
  return opening.session;
}

/** Everything the adapter said, which must never hold the secret, the token or an API body. */
function said(...values: unknown[]): string {
  return JSON.stringify(values);
}

describe("the Tailscale API admin client (worker-lifecycle §Tailnet device removal)", () => {
  test("talks to Tailscale's API with a deadline", () => {
    expect(TAILSCALE_API).toBe("https://api.tailscale.com");
    expect(TAILSCALE_API_TIMEOUT_MS).toBe(15_000);
  });

  test("exchanges the client secret for a token with a placeholder client ID, as Tailscale's CLI does", async () => {
    await session();
    const [exchange] = stub?.requests ?? [];
    expect(exchange).toMatchObject({
      method: "POST",
      path: "/api/v2/oauth/token",
      authorization: null,
      contentType: "application/x-www-form-urlencoded",
    });
    const form = new URLSearchParams(exchange?.body);
    expect([...form.keys()]).toEqual(["grant_type", "client_id", "client_secret"]);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("fffactory");
    expect(form.get("client_secret")).toBe(SECRET);
  });

  test("lists the tailnet's devices with the token, by node ID, hostname, DNS name and tags", async () => {
    const legacy = { id: "987654321", hostname: "legacy", name: "legacy.ts.net", tags: [] };
    const listing = await (await session({ devices: [WORKER, legacy] })).devices();
    expect(listing).toEqual({
      kind: "devices",
      devices: [
        {
          id: "nWorker1CNTRL",
          hostName: HOSTNAME,
          dnsName: `${HOSTNAME}.example-tailnet.ts.net`,
          tags: ["tag:factory"],
        },
        { id: "987654321", hostName: "legacy", dnsName: "legacy.ts.net", tags: [] },
      ],
    });
    expect(stub?.requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/api/v2/tailnet/-/devices",
      authorization: `Bearer ${TOKEN}`,
    });
  });

  test("a field of the wrong type reads as absent, so it can never match", async () => {
    const odd = { nodeId: 7, hostname: 42, name: null, tags: ["tag:factory", 3] };
    const listing = await (await session({ devices: [odd] })).devices();
    expect(listing).toEqual({
      kind: "devices",
      devices: [{ id: "", hostName: "", dnsName: "", tags: ["tag:factory"] }],
    });
  });

  test("deletes a device by its ID; one already gone counts as removed", async () => {
    const admin = await session();
    expect(await admin.remove("nWorker1CNTRL")).toEqual({ kind: "removed" });
    expect(stub?.remaining()).toEqual([]);
    expect(stub?.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/api/v2/device/nWorker1CNTRL",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(await admin.remove("nWorker1CNTRL")).toEqual({ kind: "removed" });
  });

  test("an ID that is not a plain token never reaches a URL", async () => {
    const admin = await session();
    const before = stub?.requests.length;
    for (const id of ["", "../tailnet/-/devices", "n1?x=1", "n 1"])
      expect(await admin.remove(id)).toEqual({
        kind: "failed",
        reason: "Tailscale listed no usable ID for the device",
      });
    expect(stub?.requests.length).toBe(before);
  });

  test("a secret that is not an OAuth client secret is refused without a request", async () => {
    const admin = against();
    expect(await admin.open(new SecretMaterial("tskey-auth-kAuthKey1CNTRL-abc"))).toEqual({
      kind: "failed",
      reason:
        "the stored admin client secret is not a Tailscale OAuth client secret (tskey-client-...)",
    });
    expect(stub?.requests).toEqual([]);
  });

  test("a refused client and failed calls are named by HTTP status, never quoting Tailscale", async () => {
    const refused = await against({ secret: "tskey-client-other" }).open(
      new SecretMaterial(SECRET),
    );
    expect(refused).toEqual({
      kind: "failed",
      reason: "Tailscale refused the admin client (HTTP 401)",
    });
    stub?.stop();
    const down = await against({ statuses: { token: 503 } }).open(new SecretMaterial(SECRET));
    expect(down).toEqual({ kind: "failed", reason: "Tailscale answered HTTP 503" });
    stub?.stop();
    const admin = await session({ statuses: { list: 500, nWorker1CNTRL: 403 } });
    const listing = await admin.devices();
    const deletion = await admin.remove("nWorker1CNTRL");
    expect(listing).toEqual({ kind: "failed", reason: "Tailscale answered HTTP 500" });
    expect(deletion).toEqual({ kind: "failed", reason: "Tailscale answered HTTP 403" });
    // Only 401 renews the token: 500 and 403 are answers, not an expired token.
    expect(stub?.requests.map((r) => r.path)).toEqual([
      "/api/v2/oauth/token",
      "/api/v2/tailnet/-/devices",
      "/api/v2/device/nWorker1CNTRL",
    ]);
    const text = said(refused, down, listing, deletion);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("refused:");
  });

  test("a token exchange that grants no token is refused", async () => {
    for (const tokenBody of ["not json", '{"token_type": "Bearer"}', '{"access_token": 7}']) {
      const opening = await against({ tokenBody }).open(new SecretMaterial(SECRET));
      expect(opening).toEqual({ kind: "failed", reason: "Tailscale answered no usable token" });
      stub?.stop();
    }
  });

  test("an answer it cannot read is refused, never quoted", async () => {
    const listing = await (await session({ listBody: `not json ${TOKEN}` })).devices();
    expect(listing).toEqual({
      kind: "failed",
      reason: "Tailscale answered a device list fffactory cannot read",
    });
    stub?.stop();
    const shapeless = await (await session({ listBody: '{"devices": 3}' })).devices();
    expect(shapeless).toEqual({
      kind: "failed",
      reason: "Tailscale answered a device list fffactory cannot read",
    });
  });

  test("every call has a deadline", async () => {
    const opening = await against({ hang: true }, 50).open(new SecretMaterial(SECRET));
    expect(opening).toEqual({
      kind: "failed",
      reason: "Tailscale did not answer within 0.05 s",
    });
  });

  test("an API that cannot be reached is named by its error code", async () => {
    const closed = tailscaleApiAdmin({ baseUrl: "http://127.0.0.1:1" });
    const opening = await closed.open(new SecretMaterial(SECRET));
    expect(opening.kind).toBe("failed");
    expect(opening.kind === "failed" && opening.reason).toMatch(
      /^Tailscale could not be reached \([A-Za-z]+\)$/,
    );
  });

  test("an expired token is renewed once, from the same secret, and the call retried", async () => {
    const admin = await session();
    stub?.expireTokens();
    expect((await admin.devices()).kind).toBe("devices");
    stub?.expireTokens();
    expect(await admin.remove("nWorker1CNTRL")).toEqual({ kind: "removed" });
    expect(stub?.remaining()).toEqual([]);
    expect(stub?.requests.map((r) => [r.method, r.path, r.authorization])).toEqual([
      ["POST", "/api/v2/oauth/token", null],
      ["GET", "/api/v2/tailnet/-/devices", `Bearer ${TOKEN}`],
      ["POST", "/api/v2/oauth/token", null],
      ["GET", "/api/v2/tailnet/-/devices", `Bearer ${TOKEN}-2`],
      ["DELETE", "/api/v2/device/nWorker1CNTRL", `Bearer ${TOKEN}-2`],
      ["POST", "/api/v2/oauth/token", null],
      ["DELETE", "/api/v2/device/nWorker1CNTRL", `Bearer ${TOKEN}-3`],
    ]);
    expect(new URLSearchParams(stub?.requests[2]?.body).get("client_secret")).toBe(SECRET);
  });

  test("a call refused again after renewing its token fails, renewing only once", async () => {
    const admin = await session({ statuses: { list: 401 } });
    const listing = await admin.devices();
    expect(listing).toEqual({ kind: "failed", reason: "Tailscale answered HTTP 401" });
    expect(said(listing)).not.toContain(TOKEN);
    expect(stub?.requests.map((r) => r.path)).toEqual([
      "/api/v2/oauth/token",
      "/api/v2/tailnet/-/devices",
      "/api/v2/oauth/token",
      "/api/v2/tailnet/-/devices",
    ]);
  });

  test("follows no redirect: another host receives nothing", async () => {
    const elsewhere = stubTailscaleApi({ secret: SECRET, devices: [WORKER] });
    try {
      const opening = await against({ redirectTo: elsewhere.url }).open(new SecretMaterial(SECRET));
      expect(opening.kind).toBe("failed");
      expect(opening.kind === "failed" && opening.reason).toMatch(
        /^Tailscale could not be reached \([A-Za-z_ ]+\)$/,
      );
      expect(stub?.requests.map((request) => request.path)).toEqual(["/api/v2/oauth/token"]);
      expect(elsewhere.requests).toEqual([]);
    } finally {
      elsewhere.stop();
    }
  });

  test("a session keeps its token to itself", async () => {
    const admin: TailnetAdminSession = await session();
    expect(said(admin, Object.keys(admin))).not.toContain(TOKEN);
  });
});
