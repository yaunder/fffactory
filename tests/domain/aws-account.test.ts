import { describe, expect, test } from "bun:test";
import {
  type AccountExpectation,
  type AccountVerdict,
  awsAccountCheck,
  type Caller,
  type CredentialSelection,
  compareAccount,
  stsRegion,
  type UnresolvedCaller,
} from "../../src/domain/aws-account";

const EXPECTED = "123456789012";
const OTHER = "210987654321";
const caller = (account: string): Caller => ({
  account,
  arn: `arn:aws:sts::${account}:assumed-role/Admin/operator`,
});
const CHAIN: CredentialSelection = { source: "chain" };
const FLAG: CredentialSelection = { source: "--profile", profile: "factory-admin" };
const ENV: CredentialSelection = { source: "AWS_PROFILE", profile: "factory-admin" };
const DECLARED: AccountExpectation = {
  kind: "declared",
  accountId: EXPECTED,
  region: "eu-west-2",
};

function check(
  verdict: AccountVerdict,
  expectation: AccountExpectation = DECLARED,
  credentials = CHAIN,
) {
  return awsAccountCheck(verdict, { expectation, credentials });
}

function unresolved(observation: UnresolvedCaller, credentials = CHAIN) {
  return check({ kind: "unresolved", observation }, DECLARED, credentials);
}

describe("account-match rule", () => {
  test("the caller's account matching the expected account is a match", () => {
    const observed = { kind: "caller", caller: caller(EXPECTED) } as const;
    expect(compareAccount(EXPECTED, observed)).toEqual({ kind: "match", caller: caller(EXPECTED) });
  });

  test("any other account is a mismatch that keeps both account IDs", () => {
    const observed = { kind: "caller", caller: caller(OTHER) } as const;
    expect(compareAccount(EXPECTED, observed)).toEqual({
      kind: "mismatch",
      caller: caller(OTHER),
      expected: EXPECTED,
    });
  });

  test("without an expected account the caller cannot be compared, never assumed to match", () => {
    const observed = { kind: "caller", caller: caller(EXPECTED) } as const;
    expect(compareAccount(undefined, observed)).toEqual({
      kind: "no_expected_account",
      caller: caller(EXPECTED),
    });
  });

  test("an unresolved caller stays unresolved whatever is expected", () => {
    for (const expected of [EXPECTED, undefined]) {
      expect(compareAccount(expected, { kind: "no_credentials" })).toEqual({
        kind: "unresolved",
        observation: { kind: "no_credentials" },
      });
    }
  });
});

describe("STS Region", () => {
  test("is the factory Region from factory.json", () => {
    expect(stsRegion(DECLARED)).toBe("eu-west-2");
  });

  test("is us-east-1 only when factory.json declares no Region", () => {
    expect(stsRegion({ kind: "declared", accountId: EXPECTED })).toBe("us-east-1");
    expect(stsRegion({ kind: "unavailable" })).toBe("us-east-1");
  });
});

describe("AWS account check with a resolved caller", () => {
  test("a match is ready and reports the account, principal, Region and credential source", () => {
    const result = check({ kind: "match", caller: caller(EXPECTED) });
    expect(result).toMatchObject({
      id: "aws_account",
      title: "AWS account",
      status: "ready",
      summary: `Account ${EXPECTED} matches factory.json`,
      nextAction: null,
    });
    expect(result.details).toEqual([
      `Principal: arn:aws:sts::${EXPECTED}:assumed-role/Admin/operator`,
      "Region: eu-west-2 (factory.json)",
      "Credentials: standard AWS credential chain",
    ]);
  });

  test("a mismatch is not ready and shows both account IDs", () => {
    const result = check({ kind: "mismatch", caller: caller(OTHER), expected: EXPECTED });
    expect(result.status).toBe("not_ready");
    expect(result.summary).toBe(`Account ${OTHER} is not the factory's account ${EXPECTED}`);
    expect(result.nextAction).toBe(
      `Select credentials for account ${EXPECTED} with --profile NAME or AWS_PROFILE, or ` +
        "correct aws.account_id in factory.json, then rerun `fffactory doctor`.",
    );
    expect(result.details[0]).toBe(`Principal: arn:aws:sts::${OTHER}:assumed-role/Admin/operator`);
  });

  test("names a profile and how it was selected", () => {
    const flagged = check({ kind: "match", caller: caller(EXPECTED) }, DECLARED, FLAG);
    expect(flagged.details).toContain("Credentials: profile factory-admin (--profile)");
    const environment = check({ kind: "match", caller: caller(EXPECTED) }, DECLARED, ENV);
    expect(environment.details).toContain("Credentials: profile factory-admin (AWS_PROFILE)");
  });

  test("without a valid factory.json it reports the caller but cannot compare", () => {
    const result = check(
      { kind: "no_expected_account", caller: caller(EXPECTED) },
      { kind: "unavailable" },
    );
    expect(result.status).toBe("not_ready");
    expect(result.summary).toBe(
      `Caller is in account ${EXPECTED}; there is no valid factory.json to compare it with`,
    );
    expect(result.nextAction).toBe(
      "Make the factory.json check ready so doctor can compare the account, " +
        "then rerun `fffactory doctor`.",
    );
    expect(result.details).toContain(
      "Region: us-east-1 (no factory Region available; used for STS)",
    );
  });

  test("a factory.json without aws.account_id reports the caller and asks for the account", () => {
    const result = check(
      { kind: "no_expected_account", caller: caller(EXPECTED) },
      { kind: "declared" },
    );
    expect(result.status).toBe("not_ready");
    expect(result.summary).toBe(
      `Caller is in account ${EXPECTED}; factory.json sets no aws.account_id to compare it with`,
    );
    expect(result.nextAction).toContain("Set aws.account_id in factory.json");
  });
});

describe("AWS account check when the caller is unresolved", () => {
  test("missing credentials are not ready with a next action, not a stack trace", () => {
    const result = unresolved({ kind: "no_credentials" });
    expect(result).toMatchObject({ status: "not_ready", summary: "No AWS credentials found" });
    expect(result.nextAction).toBe(
      "Configure AWS credentials, for example with `aws configure sso`, and select them with " +
        "--profile NAME or AWS_PROFILE, then rerun `fffactory doctor`.",
    );
    expect(result.details).toEqual([
      "Region: eu-west-2 (factory.json)",
      "Credentials: standard AWS credential chain",
    ]);
  });

  test("a profile that does not exist is not ready and names it", () => {
    const result = unresolved({ kind: "profile_not_configured" }, FLAG);
    expect(result).toMatchObject({
      status: "not_ready",
      summary: "Profile factory-admin has no credentials configured, or does not exist",
    });
    expect(result.nextAction).toContain("`aws configure sso --profile factory-admin`");
  });

  test("an expired or absent SSO session is not ready and says to log in", () => {
    const result = unresolved({ kind: "sso_login_required" }, ENV);
    expect(result.status).toBe("not_ready");
    expect(result.nextAction).toBe(
      "Log in with `aws sso login --profile factory-admin`, then rerun `fffactory doctor`.",
    );
    expect(unresolved({ kind: "sso_login_required" }).nextAction).toContain("`aws sso login`,");
  });

  test("expired, rejected and denied credentials are not ready, each with its own action", () => {
    const kinds = ["expired", "rejected", "access_denied", "region_disabled"] as const;
    const actions = new Set<string | null>();
    for (const kind of kinds) {
      const result = unresolved({ kind });
      expect(result.status).toBe("not_ready");
      actions.add(result.nextAction);
    }
    expect(actions.size).toBe(kinds.length);
    expect(unresolved({ kind: "region_disabled" }).summary).toBe(
      "STS is not activated in eu-west-2 for this account",
    );
  });

  test("an unreachable STS is an error: doctor made no observation", () => {
    const result = unresolved({ kind: "unreachable", reason: "timed out after 5 s" });
    expect(result).toMatchObject({
      status: "error",
      summary: "Could not reach AWS STS in eu-west-2: timed out after 5 s",
    });
    expect(result.nextAction).toContain("network connection");
  });

  test("an unrecognized failure is an error that points at the AWS CLI", () => {
    const result = unresolved({ kind: "unusable", reason: "ThrottlingException" }, FLAG);
    expect(result).toMatchObject({
      status: "error",
      summary: "Could not resolve the AWS caller: ThrottlingException",
    });
    expect(result.nextAction).toBe(
      "Run `aws sts get-caller-identity --profile factory-admin --region eu-west-2` to see " +
        "the error, then rerun `fffactory doctor`.",
    );
  });
});
