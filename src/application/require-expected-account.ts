import {
  type AccountExpectation,
  type AccountVerdict,
  compareAccount,
  type CredentialSelection,
  stsRegion,
} from "../domain/aws-account";
import type { CallerIdentity } from "./caller-identity";

export interface AccountRequirementRequest {
  readonly expectation: AccountExpectation;
  readonly credentials: CredentialSelection;
}

type Match = Extract<AccountVerdict, { readonly kind: "match" }>;

/** Only a caller in the expected account is allowed; every other verdict is a refusal. */
export type AccountRequirement =
  | { readonly allowed: true; readonly verdict: Match }
  | { readonly allowed: false; readonly verdict: Exclude<AccountVerdict, Match> };

/** Proof that the account check allowed the caller: what mutating use cases require. */
export type AllowedAccount = Extract<AccountRequirement, { readonly allowed: true }>;

/**
 * The guard every plan and mutating command calls first, and doctor reports: resolves the
 * caller with STS in the factory Region and refuses unless its account is the one
 * factory.json expects. A missing expectation or an unresolved caller is a refusal.
 */
export async function requireExpectedAccount(
  identity: CallerIdentity,
  { expectation, credentials }: AccountRequirementRequest,
): Promise<AccountRequirement> {
  const observation = await identity.resolve(credentials, stsRegion(expectation));
  const expected = expectation.kind === "declared" ? expectation.accountId : undefined;
  const verdict = compareAccount(expected, observation);
  return verdict.kind === "match" ? { allowed: true, verdict } : { allowed: false, verdict };
}
