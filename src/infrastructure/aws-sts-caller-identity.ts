import type { STSClientConfig } from "@aws-sdk/client-sts";
import type { CallerIdentity } from "../application/caller-identity";
import type { CallerObservation, UnresolvedCaller } from "../domain/aws-account";

/** Matches doctor's tool timeout: doctor never waits longer than this on STS. */
export const STS_TIMEOUT_MS = 5000;

export interface GetCallerIdentityRequest {
  readonly region: string;
  /** The selected profile, or undefined for the standard AWS credential chain. */
  readonly profile: string | undefined;
  readonly abortSignal: AbortSignal;
}

/** The fields of a GetCallerIdentity answer the adapter reads. */
export interface GetCallerIdentityAnswer {
  readonly Account?: string;
  readonly Arn?: string;
}

/** One STS GetCallerIdentity call. Rejects with the AWS SDK's own errors. */
export type GetCallerIdentity = (
  request: GetCallerIdentityRequest,
) => Promise<GetCallerIdentityAnswer>;

/**
 * GetCallerIdentity over AWS SDK for JavaScript v3. A selected profile is resolved from the
 * shared config and credentials files only, never by falling through to environment keys
 * or instance metadata; without one, the SDK's standard credential chain applies. The SDK
 * is imported on first use, so commands that never call AWS never load it. `config` adds
 * client configuration, such as a test endpoint and credentials.
 */
export function sdkGetCallerIdentity(config: Partial<STSClientConfig> = {}): GetCallerIdentity {
  return async ({ region, profile, abortSignal }) => {
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const selected =
      profile === undefined
        ? {}
        : {
            profile,
            credentials: (await import("@aws-sdk/credential-provider-ini")).fromIni({ profile }),
          };
    const client = new STSClient({ region, ...selected, ...config });
    try {
      return await client.send(new GetCallerIdentityCommand({}), { abortSignal });
    } finally {
      client.destroy();
    }
  };
}

const EXPIRED: UnresolvedCaller = { kind: "expired" };
const REJECTED: UnresolvedCaller = { kind: "rejected" };
const DENIED: UnresolvedCaller = { kind: "access_denied" };

/** STS error codes doctor can interpret, as the SDK names its service errors. */
const SERVICE_ERRORS: Readonly<Record<string, UnresolvedCaller>> = {
  ExpiredToken: EXPIRED,
  ExpiredTokenException: EXPIRED,
  RequestExpired: EXPIRED,
  InvalidClientTokenId: REJECTED,
  SignatureDoesNotMatch: REJECTED,
  UnrecognizedClientException: REJECTED,
  AccessDenied: DENIED,
  AccessDeniedException: DENIED,
  RegionDisabledException: { kind: "region_disabled" },
};

const CREDENTIAL_ERRORS = new Set(["CredentialsProviderError", "TokenProviderError"]);

/**
 * Credential provider messages, matched against the SDK's own text (pinned by the adapter
 * tests). Every SSO failure the SDK can fix by logging in says `aws sso login`; SSO
 * refusing a revoked session arrives as its wrapped `UnauthorizedException`.
 */
const CREDENTIAL_MESSAGES: readonly (readonly [RegExp, UnresolvedCaller])[] = [
  [/\bsso login\b/i, { kind: "sso_login_required" }],
  [/^UnauthorizedException\b/, { kind: "sso_login_required" }],
  [/^Could not resolve credentials using profile\b/, { kind: "profile_not_configured" }],
  [/^Could not load credentials from any providers$/, { kind: "no_credentials" }],
];

/** Node network error codes that mean AWS could not be reached. */
export const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

interface ErrorShape {
  readonly name: string;
  readonly message: string;
  readonly code?: unknown;
  readonly $fault?: unknown;
}

function credentialObservation(message: string, name: string): UnresolvedCaller {
  const known = CREDENTIAL_MESSAGES.find(([pattern]) => pattern.test(message));
  return known
    ? known[1]
    : { kind: "unusable", reason: `the credential provider failed (${name})` };
}

/**
 * Interprets an SDK failure by error name and code only. Messages are never echoed: they
 * are the SDK's or AWS's output, not something doctor derived.
 */
function unresolved(error: unknown, timeoutMs: number): UnresolvedCaller {
  if (!(error instanceof Error)) return { kind: "unusable", reason: "unexpected error" };
  const { name, message, code, $fault } = error as ErrorShape;
  if (CREDENTIAL_ERRORS.has(name)) return credentialObservation(message, name);
  if (Object.hasOwn(SERVICE_ERRORS, name)) return SERVICE_ERRORS[name] as UnresolvedCaller;
  if ($fault !== undefined) return { kind: "unusable", reason: `STS answered ${name}` };
  if (typeof code === "string" && NETWORK_CODES.has(code))
    return { kind: "unreachable", reason: `network error (${code})` };
  if (name === "TimeoutError") return timedOut(timeoutMs);
  return { kind: "unusable", reason: `unexpected ${name}` };
}

function timedOut(timeoutMs: number): UnresolvedCaller {
  return { kind: "unreachable", reason: `timed out after ${timeoutMs / 1000} s` };
}

const ACCOUNT_ID = /^\d{12}$/;

function observed({ Account, Arn }: GetCallerIdentityAnswer): CallerObservation {
  if (Account === undefined || !ACCOUNT_ID.test(Account) || !Arn?.startsWith("arn:"))
    return { kind: "unusable", reason: "STS returned no caller account and principal" };
  return { kind: "caller", caller: { account: Account, arn: Arn } };
}

/**
 * CallerIdentity over one STS call. At `timeoutMs` it aborts the call and reports STS as
 * unreachable, whether the credential chain or the request was still running.
 */
export function stsCallerIdentity(
  call: GetCallerIdentity = sdkGetCallerIdentity(),
  timeoutMs: number = STS_TIMEOUT_MS,
): CallerIdentity {
  return {
    async resolve(credentials, region) {
      const controller = new AbortController();
      const profile = credentials.source === "chain" ? undefined : credentials.profile;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      try {
        const answer = await Promise.race([
          call({ region, profile, abortSignal: controller.signal }),
          deadline,
        ]);
        if (answer) return observed(answer);
        controller.abort();
        return timedOut(timeoutMs);
      } catch (error) {
        return unresolved(error, timeoutMs);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
