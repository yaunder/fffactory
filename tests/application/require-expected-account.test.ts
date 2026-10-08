import { describe, expect, test } from "bun:test";
import { requireExpectedAccount } from "../../src/application/require-expected-account";
import type { AccountExpectation, CredentialSelection } from "../../src/domain/aws-account";
import { FAKE_CALLER, fakeCallerIdentity } from "../support/doctor-fakes";

const CHAIN: CredentialSelection = { source: "chain" };
const PROFILE: CredentialSelection = { source: "--profile", profile: "factory-admin" };
const DECLARED: AccountExpectation = {
  kind: "declared",
  accountId: FAKE_CALLER.account,
  region: "eu-west-2",
};

describe("requireExpectedAccount", () => {
  test("allows a caller in the expected account", async () => {
    const { identity } = fakeCallerIdentity();
    expect(
      await requireExpectedAccount(identity, { expectation: DECLARED, credentials: CHAIN }),
    ).toEqual({ allowed: true, verdict: { kind: "match", caller: FAKE_CALLER } });
  });

  test("refuses a caller in another account, keeping both account IDs", async () => {
    const other = { account: "210987654321", arn: "arn:aws:iam::210987654321:user/someone" };
    const { identity } = fakeCallerIdentity({ kind: "caller", caller: other });
    const requirement = await requireExpectedAccount(identity, {
      expectation: DECLARED,
      credentials: CHAIN,
    });
    expect(requirement).toEqual({
      allowed: false,
      verdict: { kind: "mismatch", caller: other, expected: FAKE_CALLER.account },
    });
  });

  test("refuses when there is no expected account to compare with", async () => {
    const { identity } = fakeCallerIdentity();
    for (const expectation of [
      { kind: "unavailable" },
      { kind: "declared", region: "eu-west-2" },
    ] as const) {
      const requirement = await requireExpectedAccount(identity, {
        expectation,
        credentials: CHAIN,
      });
      expect(requirement).toMatchObject({
        allowed: false,
        verdict: { kind: "no_expected_account" },
      });
    }
  });

  test("refuses when the caller cannot be resolved", async () => {
    const { identity } = fakeCallerIdentity({ kind: "no_credentials" });
    const requirement = await requireExpectedAccount(identity, {
      expectation: DECLARED,
      credentials: CHAIN,
    });
    expect(requirement).toEqual({
      allowed: false,
      verdict: { kind: "unresolved", observation: { kind: "no_credentials" } },
    });
  });

  test("asks STS in the factory Region with the operator's credential selection", async () => {
    const { identity, requests } = fakeCallerIdentity();
    await requireExpectedAccount(identity, { expectation: DECLARED, credentials: PROFILE });
    await requireExpectedAccount(identity, {
      expectation: { kind: "unavailable" },
      credentials: CHAIN,
    });
    expect(requests).toEqual([
      { credentials: PROFILE, region: "eu-west-2" },
      { credentials: CHAIN, region: "us-east-1" },
    ]);
  });
});
