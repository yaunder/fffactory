import { afterEach, describe, expect, test } from "bun:test";
import type { CredentialSelection } from "../../src/domain/aws-account";
import {
  type GetCallerIdentity,
  STS_TIMEOUT_MS,
  sdkGetCallerIdentity,
  stsCallerIdentity,
} from "../../src/infrastructure/aws-sts-caller-identity";
import { EXAMPLE_CREDENTIALS, type StubSts, stubSts } from "../support/stub-sts";

const ACCOUNT = "123456789012";
const ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/FactoryAdmin/operator`;
const CHAIN: CredentialSelection = { source: "chain" };

/** A stubbed STS call answering with `answer`, recording each request. */
function stubbed(answer: () => Promise<{ Account?: string; Arn?: string }>) {
  const requests: Parameters<GetCallerIdentity>[0][] = [];
  const call: GetCallerIdentity = (request) => {
    requests.push(request);
    return answer();
  };
  return { call, requests };
}

/** An error shaped as the AWS SDK throws it. */
function sdkError(name: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name, ...extra });
}

function failingWith(error: unknown) {
  return stsCallerIdentity(stubbed(() => Promise.reject(error)).call);
}

describe("STS caller identity over a stubbed STS call", () => {
  test("resolves the caller's account and principal", async () => {
    const { call } = stubbed(async () => ({ Account: ACCOUNT, Arn: ARN, UserId: "AIDA" }));
    expect(await stsCallerIdentity(call).resolve(CHAIN, "eu-west-2")).toEqual({
      kind: "caller",
      caller: { account: ACCOUNT, arn: ARN },
    });
  });

  test("calls STS in the requested Region, with a profile only when one is selected", async () => {
    const { call, requests } = stubbed(async () => ({ Account: ACCOUNT, Arn: ARN }));
    const identity = stsCallerIdentity(call);
    await identity.resolve(CHAIN, "eu-west-2");
    await identity.resolve({ source: "--profile", profile: "flagged" }, "us-east-1");
    await identity.resolve({ source: "AWS_PROFILE", profile: "environment" }, "us-east-1");
    expect(requests.map(({ region, profile }) => ({ region, profile }))).toEqual([
      { region: "eu-west-2", profile: undefined },
      { region: "us-east-1", profile: "flagged" },
      { region: "us-east-1", profile: "environment" },
    ]);
  });

  test("an answer without a well-formed account is unusable", async () => {
    for (const answer of [{}, { Account: "12345", Arn: ARN }, { Account: ACCOUNT }]) {
      const { call } = stubbed(async () => answer);
      expect(await stsCallerIdentity(call).resolve(CHAIN, "us-east-1")).toEqual({
        kind: "unusable",
        reason: "STS returned no caller account and principal",
      });
    }
  });

  test.each([
    ["Could not load credentials from any providers", "no_credentials"],
    [
      "Could not resolve credentials using profile: [nope] in configuration/credentials file(s).",
      "profile_not_configured",
    ],
    [
      "The SSO session associated with this profile has expired. To refresh this SSO session " +
        "run aws sso login with the corresponding profile.",
      "sso_login_required",
    ],
    [
      "Token is expired. To refresh this SSO session run 'aws sso login' with the " +
        "corresponding profile.",
      "sso_login_required",
    ],
    // SSO GetRoleCredentials refused a revoked session; the SDK wraps the service error.
    ["UnauthorizedException: Session token not found or invalid", "sso_login_required"],
  ])("the credential provider error %p is %p", async (message, kind) => {
    expect(
      await failingWith(sdkError("CredentialsProviderError", message)).resolve(CHAIN, "us-east-1"),
    ).toEqual({ kind } as never);
  });

  test("an SSO token provider error asking for a login is sso_login_required", async () => {
    const error = sdkError(
      "TokenProviderError",
      "The SSO session token associated with profile=x was not found or is invalid. " +
        "To refresh this SSO session run 'aws sso login' with the corresponding profile.",
    );
    expect(await failingWith(error).resolve(CHAIN, "us-east-1")).toEqual({
      kind: "sso_login_required",
    });
  });

  test("any other credential provider failure is unusable, without its message", async () => {
    const error = sdkError("CredentialsProviderError", "credential_process printed AKIASECRET");
    const observation = await failingWith(error).resolve(CHAIN, "us-east-1");
    expect(observation).toEqual({
      kind: "unusable",
      reason: "the credential provider failed (CredentialsProviderError)",
    });
    expect(JSON.stringify(observation)).not.toContain("AKIASECRET");
  });

  test.each([
    ["ExpiredToken", "expired"],
    ["ExpiredTokenException", "expired"],
    ["RequestExpired", "expired"],
    ["InvalidClientTokenId", "rejected"],
    ["SignatureDoesNotMatch", "rejected"],
    ["UnrecognizedClientException", "rejected"],
    ["AccessDenied", "access_denied"],
    ["AccessDeniedException", "access_denied"],
    ["RegionDisabledException", "region_disabled"],
  ])("the STS error %p is %p", async (name, kind) => {
    const error = sdkError(name, "from STS", { $fault: "client", $metadata: {} });
    expect(await failingWith(error).resolve(CHAIN, "us-east-1")).toEqual({ kind } as never);
  });

  test("any other STS error is unusable and named by its code only", async () => {
    const error = sdkError("ThrottlingException", "Rate exceeded for AKIASECRET", {
      $fault: "client",
    });
    expect(await failingWith(error).resolve(CHAIN, "us-east-1")).toEqual({
      kind: "unusable",
      reason: "STS answered ThrottlingException",
    });
  });

  test("a network failure is unreachable and named by its error code", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "ETIMEDOUT"]) {
      const error = sdkError("Error", `connect ${code} 10.0.0.1:443`, { code, $metadata: {} });
      expect(await failingWith(error).resolve(CHAIN, "us-east-1")).toEqual({
        kind: "unreachable",
        reason: `network error (${code})`,
      });
    }
  });

  test("an SDK timeout is unreachable", async () => {
    expect(await failingWith(sdkError("TimeoutError", "socket")).resolve(CHAIN, "x")).toEqual({
      kind: "unreachable",
      reason: `timed out after ${STS_TIMEOUT_MS / 1000} s`,
    });
  });

  test("anything else is unusable, never echoing its message", async () => {
    const observation = await failingWith(new Error("aws_secret_access_key=abc")).resolve(
      CHAIN,
      "us-east-1",
    );
    expect(observation).toEqual({ kind: "unusable", reason: "unexpected Error" });
    expect(await failingWith("thrown string").resolve(CHAIN, "us-east-1")).toEqual({
      kind: "unusable",
      reason: "unexpected error",
    });
  });

  test("stops waiting at the timeout and aborts the call", async () => {
    const { call, requests } = stubbed(() => new Promise(() => {}));
    const started = Date.now();
    expect(await stsCallerIdentity(call, 50).resolve(CHAIN, "us-east-1")).toEqual({
      kind: "unreachable",
      reason: "timed out after 0.05 s",
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(requests[0]?.abortSignal.aborted).toBe(true);
  });

  test("defaults to the doctor tool timeout of 5 s", () => {
    expect(STS_TIMEOUT_MS).toBe(5000);
  });
});

describe("STS caller identity over the AWS SDK and a local stub STS", () => {
  let stub: StubSts | undefined;
  afterEach(() => stub?.stop());

  /** The real SDK client, pointed at the stub with example credentials: never at AWS. */
  function againstStub(answer: Parameters<typeof stubSts>[0], timeoutMs?: number) {
    stub = stubSts(answer);
    const call = sdkGetCallerIdentity({
      endpoint: stub.endpoint,
      credentials: EXAMPLE_CREDENTIALS,
    });
    return stsCallerIdentity(call, timeoutMs);
  }

  test("parses GetCallerIdentity", async () => {
    const identity = againstStub({ kind: "caller", account: ACCOUNT, arn: ARN });
    expect(await identity.resolve(CHAIN, "eu-west-2")).toEqual({
      kind: "caller",
      caller: { account: ACCOUNT, arn: ARN },
    });
    expect(stub?.requests).toHaveLength(1);
    expect(stub?.requests[0]).toContain("Action=GetCallerIdentity");
  });

  test.each([
    [403, "AccessDenied", "access_denied"],
    [400, "ExpiredToken", "expired"],
    [403, "InvalidClientTokenId", "rejected"],
    [403, "RegionDisabledException", "region_disabled"],
  ])("maps an HTTP %p %p answer to %p", async (status, code, kind) => {
    const identity = againstStub({ kind: "error", status, code });
    expect(await identity.resolve(CHAIN, "us-east-1")).toEqual({ kind } as never);
  });

  test("a selected profile comes only from the shared files, which here have none", async () => {
    stub = stubSts({ kind: "caller", account: ACCOUNT, arn: ARN });
    const identity = stsCallerIdentity(sdkGetCallerIdentity({ endpoint: stub.endpoint }));
    expect(
      await identity.resolve({ source: "--profile", profile: "missing" }, "us-east-1"),
    ).toEqual({ kind: "profile_not_configured" });
    expect(stub.requests).toEqual([]);
  });

  test("a stub that never answers times out", async () => {
    const identity = againstStub({ kind: "hang" }, 200);
    expect(await identity.resolve(CHAIN, "us-east-1")).toEqual({
      kind: "unreachable",
      reason: "timed out after 0.2 s",
    });
  });

  test("a closed port is a network error", async () => {
    const closed = stubSts({ kind: "hang" });
    closed.stop();
    const call = sdkGetCallerIdentity({
      endpoint: closed.endpoint,
      credentials: EXAMPLE_CREDENTIALS,
    });
    expect(await stsCallerIdentity(call).resolve(CHAIN, "us-east-1")).toEqual({
      kind: "unreachable",
      reason: "network error (ECONNREFUSED)",
    });
  });
});
