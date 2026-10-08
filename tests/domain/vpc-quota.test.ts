import { describe, expect, test } from "bun:test";
import type { CredentialSelection } from "../../src/domain/aws-account";
import type { FactoryId, FactoryInstance } from "../../src/domain/instance";
import {
  VPC_QUOTA_CHECK,
  VPCS_PER_REGION,
  type VpcQuotaContext,
  vpcQuotaCheck,
  vpcQuotaNotInspected,
  vpcQuotaTarget,
} from "../../src/domain/vpc-quota";

const CHAIN: CredentialSelection = { source: "chain" };
const CONTEXT: VpcQuotaContext = { region: "eu-west-2", credentials: CHAIN };
const DETAILS = ["Region: eu-west-2 (factory.json)", "Credentials: standard AWS credential chain"];

function observed(limit: number, used: number, factoryVpc = false) {
  return vpcQuotaCheck({ kind: "observed", limit, used, factoryVpc }, CONTEXT);
}

describe("VPC quota constants", () => {
  test("the check is vpc_quota, titled VPC quota", () => {
    expect(VPC_QUOTA_CHECK).toEqual({ id: "vpc_quota", title: "VPC quota" });
  });

  test("the quota is Service Quotas' VPCs per Region", () => {
    expect(VPCS_PER_REGION).toEqual({ ServiceCode: "vpc", QuotaCode: "L-F678F1CE" });
  });
});

describe("vpcQuotaTarget", () => {
  const instance = (aws?: FactoryInstance["aws"], factoryId?: string): FactoryInstance =>
    ({ schema_version: 1, aws, factory_id: factoryId }) as FactoryInstance;

  test("is the factory Region and ID when both are set", () => {
    expect(vpcQuotaTarget(instance({ region: "eu-west-2" }, "fff-example"))).toEqual({
      kind: "target",
      region: "eu-west-2",
      factoryId: "fff-example" as FactoryId,
    });
  });

  test("lists the missing field paths otherwise, in completeness order", () => {
    expect(vpcQuotaTarget(instance(undefined, undefined))).toEqual({
      kind: "missing",
      fields: ["factory_id", "aws.region"],
    });
    expect(vpcQuotaTarget(instance({ account_id: "123456789012" }, "fff-example"))).toEqual({
      kind: "missing",
      fields: ["aws.region"],
    });
  });
});

describe("vpcQuotaNotInspected", () => {
  test("without an account match it waits for the aws_account check", () => {
    expect(vpcQuotaNotInspected({ kind: "account" })).toEqual({
      ...VPC_QUOTA_CHECK,
      status: "not_ready",
      summary: "Not inspected: doctor reads the VPC quota only in the factory's own AWS account",
      details: [],
      nextAction: "Make the aws_account check ready, then rerun `fffactory doctor`.",
    });
  });

  test("without a factory ID or Region it lists the missing fields", () => {
    expect(vpcQuotaNotInspected({ kind: "missing", fields: ["aws.region"] })).toEqual({
      ...VPC_QUOTA_CHECK,
      status: "not_ready",
      summary: "Not inspected: factory.json needs factory_id and aws.region",
      details: ["aws.region"],
      nextAction:
        "Fill in each field listed, check the result with `fffactory validate`, " +
        "then rerun `fffactory doctor`.",
    });
  });
});

describe("vpcQuotaCheck", () => {
  test("room for one more VPC is ready", () => {
    expect(observed(5, 4)).toEqual({
      ...VPC_QUOTA_CHECK,
      status: "ready",
      summary: "4 of 5 VPCs in use in eu-west-2; the factory's VPC fits",
      details: DETAILS,
      nextAction: null,
    });
  });

  test("a full Region without the factory's VPC is not ready", () => {
    const result = observed(5, 5);
    expect(result).toMatchObject({
      status: "not_ready",
      summary: "5 of 5 VPCs in use in eu-west-2; no room for the factory's VPC",
      details: DETAILS,
    });
    expect(result.nextAction).toBe(
      "Request a higher 'VPCs per Region' quota in Service Quotas for eu-west-2, or delete " +
        "an unused VPC, then rerun `fffactory doctor`.",
    );
    expect(observed(5, 7).status).toBe("not_ready");
  });

  test("an existing factory VPC needs no headroom, even in a full Region", () => {
    expect(observed(5, 5, true)).toMatchObject({
      status: "ready",
      summary: "The factory's VPC already exists in eu-west-2; no VPC quota headroom is needed",
      details: ["5 of 5 VPCs in use", ...DETAILS],
    });
  });

  test("a fractional quota value is floored", () => {
    expect(observed(5.9, 5).status).toBe("not_ready");
    expect(observed(6.2, 5).summary).toBe(
      "5 of 6 VPCs in use in eu-west-2; the factory's VPC fits",
    );
  });

  test("a selected profile is named in the details", () => {
    const credentials = { source: "--profile", profile: "factory-admin" } as const;
    const result = vpcQuotaCheck(
      { kind: "observed", limit: 5, used: 1, factoryVpc: false },
      { ...CONTEXT, credentials },
    );
    expect(result.details).toContain("Credentials: profile factory-admin (--profile)");
  });

  test("denied access is not ready and names the permissions needed", () => {
    const result = vpcQuotaCheck({ kind: "access_denied" }, CONTEXT);
    expect(result).toMatchObject({
      status: "not_ready",
      summary: "AWS denied reading the VPC quota or the VPCs in eu-west-2",
      details: DETAILS,
    });
    expect(result.nextAction).toBe(
      "Use credentials allowed ec2:DescribeVpcs, servicequotas:GetServiceQuota and " +
        "servicequotas:GetAWSDefaultServiceQuota, then rerun `fffactory doctor`.",
    );
  });

  test("an unreachable EC2 or Service Quotas is an error", () => {
    const result = vpcQuotaCheck(
      { kind: "unreachable", reason: "network error (ECONNREFUSED)" },
      CONTEXT,
    );
    expect(result).toMatchObject({
      status: "error",
      summary: "Could not reach EC2 or Service Quotas in eu-west-2: network error (ECONNREFUSED)",
      nextAction:
        "Check the network connection and any proxy settings, then rerun `fffactory doctor`.",
    });
  });

  test("an unusable answer is an error naming the AWS CLI commands to reproduce it", () => {
    const reason = "EC2 answered RequestLimitExceeded";
    const chain = vpcQuotaCheck({ kind: "unusable", reason }, CONTEXT);
    expect(chain).toMatchObject({
      status: "error",
      summary: `Could not read the VPC quota: ${reason}`,
    });
    expect(chain.nextAction).toBe(
      "Run `aws ec2 describe-vpcs --region eu-west-2` and `aws service-quotas " +
        "get-service-quota --service-code vpc --quota-code L-F678F1CE --region eu-west-2` " +
        "to see the error, then rerun `fffactory doctor`.",
    );
    const profiled = vpcQuotaCheck(
      { kind: "unusable", reason },
      { ...CONTEXT, credentials: { source: "AWS_PROFILE", profile: "admin" } },
    );
    expect(profiled.nextAction).toContain(
      "`aws ec2 describe-vpcs --region eu-west-2 --profile admin`",
    );
    expect(profiled.nextAction).toContain("--region eu-west-2 --profile admin` to see the error");
  });
});
