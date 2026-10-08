/**
 * What the mutating AWS adapters share: one deadline per port call, with every request in it
 * aborted when it passes, and failures described by error name and code only. AWS and SDK
 * messages are never quoted: they are not fffactory's to show, and may echo request data.
 */
import type { CredentialSelection } from "../domain/aws-account";
import { NETWORK_CODES } from "./aws-sts-caller-identity";

/** What every call in one port call shares. */
export interface AwsSession {
  readonly region: string;
  /** The selected profile, or undefined for the standard AWS credential chain. */
  readonly profile: string | undefined;
  readonly abortSignal: AbortSignal;
}

/** The calls of one session, released by `close`. */
export interface AwsCalls {
  close(): void;
}

export type OpenCalls<T extends AwsCalls> = (session: AwsSession) => Promise<T>;

/**
 * A refusal the adapter itself words, such as a bucket owned by another account. It passes
 * through a session unchanged; every other failure becomes an `AwsFailure`.
 */
export class AdapterRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterRefusal";
  }
}

/** An AWS call that failed, described without quoting AWS. */
export class AwsFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsFailure";
  }
}

/** What a call rejects with when its deadline passes. */
const DEADLINE_EXCEEDED = Symbol("deadline exceeded");

const CREDENTIAL_ERRORS = new Set(["CredentialsProviderError", "TokenProviderError"]);

interface ErrorShape {
  readonly name: string;
  readonly code?: unknown;
  readonly $fault?: unknown;
}

/** Why a call failed, by error name or network code: never the error's message. */
export function failureReason(error: unknown, timeoutMs: number): string {
  if (error === DEADLINE_EXCEEDED) return `timed out after ${timeoutMs / 1000} s`;
  if (!(error instanceof Error)) return "unexpected error";
  const { name, code, $fault } = error as ErrorShape;
  if (CREDENTIAL_ERRORS.has(name)) return `the credential provider failed (${name})`;
  if ($fault !== undefined) return name;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return `network error (${code})`;
  return `unexpected ${name}`;
}

/** The SDK error's name, for adapters that handle particular service errors. */
export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** The HTTP status AWS answered a failed call with, when it answered at all. */
export function httpStatus(error: unknown): number | undefined {
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } } | undefined)?.$metadata;
  const status = metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Runs `work` with calls opened for the credentials and Region, within `timeoutMs`. At the
 * deadline every request is aborted and the call fails; the calls are always closed.
 * Failures other than an `AdapterRefusal` reject as an `AwsFailure` naming `what`.
 */
export async function withAwsSession<C extends AwsCalls, T>(
  open: OpenCalls<C>,
  target: { readonly credentials: CredentialSelection; readonly region: string },
  timeoutMs: number,
  what: string,
  work: (calls: C) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const profile = target.credentials.source === "chain" ? undefined : target.credentials.profile;
  const session = { region: target.region, profile, abortSignal: controller.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(DEADLINE_EXCEEDED), timeoutMs);
  });
  const running = (async () => {
    const calls = await open(session);
    try {
      return await work(calls);
    } finally {
      calls.close();
    }
  })();
  // After the deadline the aborted calls still settle; nothing waits for them.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, deadline]);
  } catch (error) {
    if (error instanceof AdapterRefusal) throw error;
    throw new AwsFailure(`${what} failed: ${failureReason(error, timeoutMs)}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * The client settings for a session: its Region, and a selected profile resolved from the
 * shared config and credentials files only, never falling through to environment keys or
 * instance metadata.
 */
export async function clientSettings({ region, profile }: AwsSession) {
  if (profile === undefined) return { region };
  const { fromIni } = await import("@aws-sdk/credential-provider-ini");
  return { region, profile, credentials: fromIni({ profile }) };
}
