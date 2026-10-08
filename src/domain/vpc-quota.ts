/**
 * The Region's VPC quota headroom: v2 creates its own VPC, so the first apply needs room for
 * one more unless the factory's VPC already exists.
 */
import type { CredentialSelection } from "./aws-account";
import { type CheckResult, failed, notReady, ready, thenRerun } from "./check-result";
import type { FactoryId, FactoryInstance } from "./instance";

export const VPC_QUOTA_CHECK = { id: "vpc_quota", title: "VPC quota" } as const;

/** Service Quotas' "VPCs per Region" quota, as its API names it. */
export const VPCS_PER_REGION = { ServiceCode: "vpc", QuotaCode: "L-F678F1CE" } as const;

/** What reading the Region's VPC quota and VPCs showed. */
export type VpcQuotaObservation =
  | {
      readonly kind: "observed";
      /** The quota's value as Service Quotas reports it, possibly fractional. */
      readonly limit: number;
      /** VPCs in the Region, in any state. */
      readonly used: number;
      /** Whether one of them carries the factory-ID tag (`FACTORY_ID_TAG`) with this factory's ID. */
      readonly factoryVpc: boolean;
    }
  | { readonly kind: "access_denied" }
  /** No answer: a network failure or the deadline. */
  | { readonly kind: "unreachable"; readonly reason: string }
  /** An answer or failure doctor cannot interpret. `reason` never quotes an AWS or SDK message. */
  | { readonly kind: "unusable"; readonly reason: string };

/** Where to look: the factory Region and ID, or the factory.json fields still missing. */
export type VpcQuotaTarget =
  | { readonly kind: "target"; readonly region: string; readonly factoryId: FactoryId }
  | { readonly kind: "missing"; readonly fields: readonly string[] };

export function vpcQuotaTarget(instance: FactoryInstance): VpcQuotaTarget {
  const factoryId = instance.factory_id;
  const region = instance.aws?.region;
  if (factoryId !== undefined && region !== undefined) return { kind: "target", region, factoryId };
  const fields = [
    ...(factoryId === undefined ? ["factory_id"] : []),
    ...(region === undefined ? ["aws.region"] : []),
  ];
  return { kind: "missing", fields };
}

/** Why doctor did not read the quota: no account match, or no factory ID or Region. */
export type VpcQuotaSkip =
  | { readonly kind: "account" }
  | Extract<VpcQuotaTarget, { readonly kind: "missing" }>;

export function vpcQuotaNotInspected(skip: VpcQuotaSkip): CheckResult {
  if (skip.kind === "account")
    return notReady(
      VPC_QUOTA_CHECK,
      "Not inspected: doctor reads the VPC quota only in the factory's own AWS account",
      thenRerun("Make the aws_account check ready"),
    );
  return notReady(
    VPC_QUOTA_CHECK,
    "Not inspected: factory.json needs factory_id and aws.region",
    thenRerun("Fill in each field listed, check the result with `fffactory validate`"),
    skip.fields,
  );
}

export interface VpcQuotaContext {
  /** The factory Region, from factory.json. */
  readonly region: string;
  readonly credentials: CredentialSelection;
}

function contextDetails({ region, credentials }: VpcQuotaContext): string[] {
  const source =
    credentials.source === "chain"
      ? "standard AWS credential chain"
      : `profile ${credentials.profile} (${credentials.source})`;
  return [`Region: ${region} (factory.json)`, `Credentials: ${source}`];
}

function observedCheck(
  { limit: value, used, factoryVpc }: Extract<VpcQuotaObservation, { kind: "observed" }>,
  context: VpcQuotaContext,
): CheckResult {
  const { region } = context;
  const limit = Math.floor(value);
  const details = contextDetails(context);
  const inUse = `${used} of ${limit} VPCs in use`;
  if (factoryVpc)
    return ready(
      VPC_QUOTA_CHECK,
      `The factory's VPC already exists in ${region}; no VPC quota headroom is needed`,
      [inUse, ...details],
    );
  if (used < limit)
    return ready(VPC_QUOTA_CHECK, `${inUse} in ${region}; the factory's VPC fits`, details);
  return notReady(
    VPC_QUOTA_CHECK,
    `${inUse} in ${region}; no room for the factory's VPC`,
    thenRerun(
      `Request a higher 'VPCs per Region' quota in Service Quotas for ${region}, or delete ` +
        "an unused VPC",
    ),
    details,
  );
}

function reproduce({ region, credentials }: VpcQuotaContext): string {
  const flags = `--region ${region}${credentials.source === "chain" ? "" : ` --profile ${credentials.profile}`}`;
  const { ServiceCode, QuotaCode } = VPCS_PER_REGION;
  return (
    `Run \`aws ec2 describe-vpcs ${flags}\` and \`aws service-quotas get-service-quota ` +
    `--service-code ${ServiceCode} --quota-code ${QuotaCode} ${flags}\` to see the error`
  );
}

/** Doctor's `vpc_quota` check for what the Region's quota and VPCs showed. */
export function vpcQuotaCheck(
  observation: VpcQuotaObservation,
  context: VpcQuotaContext,
): CheckResult {
  const { region } = context;
  const details = contextDetails(context);
  switch (observation.kind) {
    case "observed":
      return observedCheck(observation, context);
    case "access_denied":
      return notReady(
        VPC_QUOTA_CHECK,
        `AWS denied reading the VPC quota or the VPCs in ${region}`,
        thenRerun(
          "Use credentials allowed ec2:DescribeVpcs, servicequotas:GetServiceQuota and " +
            "servicequotas:GetAWSDefaultServiceQuota",
        ),
        details,
      );
    case "unreachable":
      return failed(
        VPC_QUOTA_CHECK,
        `Could not reach EC2 or Service Quotas in ${region}: ${observation.reason}`,
        thenRerun("Check the network connection and any proxy settings"),
        details,
      );
    case "unusable":
      return failed(
        VPC_QUOTA_CHECK,
        `Could not read the VPC quota: ${observation.reason}`,
        thenRerun(reproduce(context)),
        details,
      );
  }
}
