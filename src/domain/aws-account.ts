import { type CheckResult, failed, notReady, ready, thenRerun } from "./check-result";
import type { FactoryInstance } from "./instance";

/** Who AWS says the selected credentials belong to. */
export interface Caller {
  /** 12-digit AWS account ID. */
  readonly account: string;
  /** Principal ARN, such as `arn:aws:sts::123456789012:assumed-role/Admin/operator`. */
  readonly arn: string;
}

/**
 * How the operator selected AWS credentials. A profile name is operator-local and never
 * desired state, so it comes from `--profile` or `AWS_PROFILE`, never from factory.json.
 */
export type CredentialSelection =
  | { readonly source: "--profile" | "AWS_PROFILE"; readonly profile: string }
  | { readonly source: "chain" };

/** What asking STS for the caller showed. */
export type CallerObservation =
  | { readonly kind: "caller"; readonly caller: Caller }
  /** No provider in the standard AWS credential chain had credentials. */
  | { readonly kind: "no_credentials" }
  /** The selected profile does not exist or configures no credentials. */
  | { readonly kind: "profile_not_configured" }
  /** The SSO session has expired, was revoked, or was never started. */
  | { readonly kind: "sso_login_required" }
  | { readonly kind: "expired" }
  /** STS rejected the credentials as invalid. */
  | { readonly kind: "rejected" }
  | { readonly kind: "access_denied" }
  /** STS is not activated in the Region for the account. */
  | { readonly kind: "region_disabled" }
  /** No answer: a network failure or a timeout. */
  | { readonly kind: "unreachable"; readonly reason: string }
  /** An answer doctor cannot interpret. `reason` never quotes an AWS or SDK message. */
  | { readonly kind: "unusable"; readonly reason: string };

export type UnresolvedCaller = Exclude<CallerObservation, { readonly kind: "caller" }>;

/** The account-match rule's outcome. Only `match` permits an operation. */
export type AccountVerdict =
  | { readonly kind: "match"; readonly caller: Caller }
  | { readonly kind: "mismatch"; readonly caller: Caller; readonly expected: string }
  | { readonly kind: "no_expected_account"; readonly caller: Caller }
  | { readonly kind: "unresolved"; readonly observation: UnresolvedCaller };

/** The account and Region factory.json declares, or `unavailable` without a valid one. */
export type AccountExpectation =
  | { readonly kind: "unavailable" }
  | { readonly kind: "declared"; readonly accountId?: string; readonly region?: string };

/** What a valid instance expects; its account and Region may still be unset. */
export function accountExpectation(instance: FactoryInstance): AccountExpectation {
  return { kind: "declared", accountId: instance.aws?.account_id, region: instance.aws?.region };
}

/**
 * The account-match rule: the caller must be in exactly the expected account. A missing
 * expectation is never a match.
 */
export function compareAccount(
  expected: string | undefined,
  observation: CallerObservation,
): AccountVerdict {
  if (observation.kind !== "caller") return { kind: "unresolved", observation };
  const { caller } = observation;
  if (expected === undefined) return { kind: "no_expected_account", caller };
  if (caller.account === expected) return { kind: "match", caller };
  return { kind: "mismatch", caller, expected };
}

/** STS's own Region, reachable from every commercial account; used only to reach STS. */
export const STS_FALLBACK_REGION = "us-east-1";

function declaredRegion(expectation: AccountExpectation): string | undefined {
  return expectation.kind === "declared" ? expectation.region : undefined;
}

/**
 * The Region fffactory asks STS in: the factory Region from factory.json. The operator's
 * own configured Region is never used.
 */
export function stsRegion(expectation: AccountExpectation): string {
  return declaredRegion(expectation) ?? STS_FALLBACK_REGION;
}

export const AWS_ACCOUNT_CHECK = { id: "aws_account", title: "AWS account" } as const;

export interface AwsCheckContext {
  readonly expectation: AccountExpectation;
  readonly credentials: CredentialSelection;
}

function profileOf(credentials: CredentialSelection): string | undefined {
  return credentials.source === "chain" ? undefined : credentials.profile;
}

function describeCredentials(credentials: CredentialSelection): string {
  return credentials.source === "chain"
    ? "standard AWS credential chain"
    : `profile ${credentials.profile} (${credentials.source})`;
}

function contextDetails({ expectation, credentials }: AwsCheckContext): string[] {
  const region = declaredRegion(expectation);
  return [
    region === undefined
      ? `Region: ${STS_FALLBACK_REGION} (no factory Region available; used for STS)`
      : `Region: ${region} (factory.json)`,
    `Credentials: ${describeCredentials(credentials)}`,
  ];
}

function resolvedCheck(
  verdict: Exclude<AccountVerdict, { readonly kind: "unresolved" }>,
  context: AwsCheckContext,
): CheckResult {
  const { caller } = verdict;
  const details = [`Principal: ${caller.arn}`, ...contextDetails(context)];
  switch (verdict.kind) {
    case "match":
      return ready(AWS_ACCOUNT_CHECK, `Account ${caller.account} matches factory.json`, details);
    case "mismatch":
      return notReady(
        AWS_ACCOUNT_CHECK,
        `Account ${caller.account} is not the factory's account ${verdict.expected}`,
        thenRerun(
          `Select credentials for account ${verdict.expected} with --profile NAME or ` +
            "AWS_PROFILE, or correct aws.account_id in factory.json",
        ),
        details,
      );
    case "no_expected_account":
      return context.expectation.kind === "unavailable"
        ? notReady(
            AWS_ACCOUNT_CHECK,
            `Caller is in account ${caller.account}; there is no valid factory.json to compare it with`,
            thenRerun("Make the factory.json check ready so doctor can compare the account"),
            details,
          )
        : notReady(
            AWS_ACCOUNT_CHECK,
            `Caller is in account ${caller.account}; factory.json sets no aws.account_id to compare it with`,
            thenRerun(
              "Set aws.account_id in factory.json to the factory's 12-digit AWS account ID, " +
                "check the result with `fffactory validate`",
            ),
            details,
          );
  }
}

interface Explanation {
  readonly summary: string;
  readonly action: string;
}

/** Summary and next action, before `thenRerun`, for each observation that is not ready. */
function notReadyExplanation(
  kind: Exclude<UnresolvedCaller["kind"], "unreachable" | "unusable">,
  region: string,
  profile: string | undefined,
): Explanation {
  const profileFlag = profile === undefined ? "" : ` --profile ${profile}`;
  const explanations: Readonly<Record<typeof kind, Explanation>> = {
    no_credentials: {
      summary: "No AWS credentials found",
      action:
        "Configure AWS credentials, for example with `aws configure sso`, and select them " +
        "with --profile NAME or AWS_PROFILE",
    },
    profile_not_configured: {
      summary: `Profile ${profile ?? "default"} has no credentials configured, or does not exist`,
      action:
        `Configure it, for example with \`aws configure sso --profile ${profile ?? "default"}\`, ` +
        "or select another profile with --profile NAME or AWS_PROFILE",
    },
    sso_login_required: {
      summary: "The AWS SSO session has expired or is not logged in",
      action: `Log in with \`aws sso login${profileFlag}\``,
    },
    expired: {
      summary: "The AWS credentials have expired",
      action: "Renew the credentials, or select current ones with --profile NAME or AWS_PROFILE",
    },
    rejected: {
      summary: "AWS rejected the credentials as invalid",
      action: `Replace the credentials; if ${region} is an opt-in Region, enable it for the account`,
    },
    access_denied: {
      summary: "AWS denied sts:GetCallerIdentity to these credentials",
      action: "Use credentials whose policies do not deny sts:GetCallerIdentity",
    },
    region_disabled: {
      summary: `STS is not activated in ${region} for this account`,
      action: `Activate STS for ${region} in the IAM console's account settings`,
    },
  };
  return explanations[kind];
}

function unresolvedCheck(observation: UnresolvedCaller, context: AwsCheckContext): CheckResult {
  const region = stsRegion(context.expectation);
  const profile = profileOf(context.credentials);
  const details = contextDetails(context);
  switch (observation.kind) {
    case "unreachable":
      return failed(
        AWS_ACCOUNT_CHECK,
        `Could not reach AWS STS in ${region}: ${observation.reason}`,
        thenRerun("Check the network connection and any proxy settings"),
        details,
      );
    case "unusable": {
      const profileFlag = profile === undefined ? "" : ` --profile ${profile}`;
      return failed(
        AWS_ACCOUNT_CHECK,
        `Could not resolve the AWS caller: ${observation.reason}`,
        thenRerun(
          `Run \`aws sts get-caller-identity${profileFlag} --region ${region}\` to see the error`,
        ),
        details,
      );
    }
    default: {
      const { summary, action } = notReadyExplanation(observation.kind, region, profile);
      return notReady(AWS_ACCOUNT_CHECK, summary, thenRerun(action), details);
    }
  }
}

/** Doctor's `aws_account` check for a verdict of the account-match rule. */
export function awsAccountCheck(verdict: AccountVerdict, context: AwsCheckContext): CheckResult {
  return verdict.kind === "unresolved"
    ? unresolvedCheck(verdict.observation, context)
    : resolvedCheck(verdict, context);
}
