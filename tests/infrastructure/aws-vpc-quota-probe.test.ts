import { afterEach, describe, expect, test } from "bun:test";
import type { CredentialSelection } from "../../src/domain/aws-account";
import type { FactoryId } from "../../src/domain/instance";
import {
  awsVpcQuotaProbe,
  type QuotaAnswer,
  sdkVpcQuotaCalls,
  VPC_QUOTA_TIMEOUT_MS,
  type VpcPage,
  type VpcQuotaCalls,
  type VpcQuotaSession,
} from "../../src/infrastructure/aws-vpc-quota-probe";
import { EXAMPLE_CREDENTIALS } from "../support/stub-sts";
import { type StubVpcQuota, stubVpcQuota } from "../support/stub-vpc-quota";

const CHAIN: CredentialSelection = { source: "chain" };
const FACTORY = "fff-example" as FactoryId;
const TAG = "fffactory:factory-id";

/** An error shaped as the AWS SDK throws it. */
function sdkError(name: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name, ...extra });
}

interface Script {
  readonly applied?: () => Promise<QuotaAnswer>;
  readonly defaultValue?: () => Promise<QuotaAnswer>;
  readonly pages?: readonly VpcPage[];
  readonly describeVpcs?: (token: string | undefined) => Promise<VpcPage>;
}

const FIVE: QuotaAnswer = { Quota: { Value: 5 } };

/** Stubbed calls following `script`, recording sessions, calls and closes. */
function stubbed(script: Script = {}) {
  const sessions: VpcQuotaSession[] = [];
  const calls: string[] = [];
  let closed = 0;
  const pages = script.pages ?? [{ Vpcs: [] }];
  const open = async (session: VpcQuotaSession): Promise<VpcQuotaCalls> => {
    sessions.push(session);
    return {
      getServiceQuota: (input) => {
        calls.push(`GetServiceQuota ${input.ServiceCode}/${input.QuotaCode}`);
        return script.applied ? script.applied() : Promise.resolve(FIVE);
      },
      getAwsDefaultServiceQuota: (input) => {
        calls.push(`GetAWSDefaultServiceQuota ${input.ServiceCode}/${input.QuotaCode}`);
        return script.defaultValue ? script.defaultValue() : Promise.resolve(FIVE);
      },
      describeVpcs: (token) => {
        calls.push(`DescribeVpcs ${token ?? "-"}`);
        if (script.describeVpcs) return script.describeVpcs(token);
        const index = token === undefined ? 0 : Number(token);
        return Promise.resolve(pages[index] ?? {});
      },
      close: () => {
        closed += 1;
      },
    };
  };
  return { open, sessions, calls, closed: () => closed };
}

function inspect(script: Script = {}, credentials: CredentialSelection = CHAIN) {
  return awsVpcQuotaProbe(stubbed(script).open).inspect(credentials, "eu-west-2", FACTORY);
}

const vpc = (tags: Record<string, string> = {}) => ({
  Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
});

describe("VPC quota probe over stubbed calls", () => {
  test("counts every VPC across pages and reads the applied quota", async () => {
    const stub = stubbed({
      pages: [
        { Vpcs: [vpc(), vpc({ Name: "a" })], NextToken: "1" },
        { Vpcs: [vpc()], NextToken: "2" },
        { Vpcs: [vpc()] },
      ],
    });
    const observation = await awsVpcQuotaProbe(stub.open).inspect(CHAIN, "eu-west-2", FACTORY);
    expect(observation).toEqual({ kind: "observed", limit: 5, used: 4, factoryVpc: false });
    expect(stub.calls).toContain("GetServiceQuota vpc/L-F678F1CE");
    expect(stub.calls.filter((call) => call.startsWith("DescribeVpcs"))).toEqual([
      "DescribeVpcs -",
      "DescribeVpcs 1",
      "DescribeVpcs 2",
    ]);
    expect(stub.calls).not.toContain("GetAWSDefaultServiceQuota vpc/L-F678F1CE");
    expect(stub.closed()).toBe(1);
  });

  test("opens one session in the factory Region, with a profile only when selected", async () => {
    const stub = stubbed();
    const probe = awsVpcQuotaProbe(stub.open);
    await probe.inspect(CHAIN, "eu-west-2", FACTORY);
    await probe.inspect({ source: "--profile", profile: "flagged" }, "us-east-1", FACTORY);
    await probe.inspect({ source: "AWS_PROFILE", profile: "environment" }, "us-east-1", FACTORY);
    expect(stub.sessions.map(({ region, profile }) => ({ region, profile }))).toEqual([
      { region: "eu-west-2", profile: undefined },
      { region: "us-east-1", profile: "flagged" },
      { region: "us-east-1", profile: "environment" },
    ]);
  });

  test("falls back to the AWS default quota when no applied quota exists", async () => {
    const stub = stubbed({
      applied: () => Promise.reject(sdkError("NoSuchResourceException", "x", { $fault: "client" })),
      defaultValue: async () => ({ Quota: { Value: 7 } }),
    });
    const observation = await awsVpcQuotaProbe(stub.open).inspect(CHAIN, "eu-west-2", FACTORY);
    expect(observation).toMatchObject({ kind: "observed", limit: 7 });
    expect(stub.calls).toContain("GetAWSDefaultServiceQuota vpc/L-F678F1CE");
  });

  test("finds the factory's VPC by its factory ID tag, and only by an exact match", async () => {
    const found = await inspect({
      pages: [
        { Vpcs: [vpc({ [TAG]: "other" })], NextToken: "1" },
        { Vpcs: [vpc({ [TAG]: FACTORY })] },
      ],
    });
    expect(found).toMatchObject({ kind: "observed", used: 2, factoryVpc: true });
    const lookalikes: Record<string, string>[] = [
      { [TAG]: "fff-example-2" },
      { Name: FACTORY },
      { "fffactory:Factory-Id": FACTORY },
    ];
    for (const tags of lookalikes) {
      expect(await inspect({ pages: [{ Vpcs: [vpc(tags)] }] })).toMatchObject({
        factoryVpc: false,
      });
    }
  });

  test("passes a fractional quota through for the domain rule to floor", async () => {
    expect(await inspect({ applied: async () => ({ Quota: { Value: 5.5 } }) })).toMatchObject({
      limit: 5.5,
    });
  });

  test("an answer without a usable quota value is unusable", async () => {
    for (const answer of [
      {},
      { Quota: {} },
      { Quota: { Value: -1 } },
      { Quota: { Value: Number.NaN } },
    ]) {
      expect(await inspect({ applied: async () => answer })).toEqual({
        kind: "unusable",
        reason: "Service Quotas returned no value for VPCs per Region",
      });
    }
  });

  test.each([
    ["UnauthorizedOperation", "ec2"],
    ["AccessDenied", "ec2"],
    ["AccessDeniedException", "quota"],
  ])("the AWS error %p from %p is access_denied", async (name, service) => {
    const error = () => Promise.reject(sdkError(name, "denied", { $fault: "client" }));
    const script = service === "ec2" ? { describeVpcs: error } : { applied: error };
    expect(await inspect(script)).toEqual({ kind: "access_denied" });
  });

  test("any other AWS error is unusable, named by service and code only", async () => {
    const throttled = sdkError("RequestLimitExceeded", "Rate exceeded for AKIASECRET", {
      $fault: "client",
    });
    const ec2 = await inspect({ describeVpcs: () => Promise.reject(throttled) });
    expect(ec2).toEqual({ kind: "unusable", reason: "EC2 answered RequestLimitExceeded" });
    expect(JSON.stringify(ec2)).not.toContain("AKIASECRET");
    const missing = sdkError("NoSuchResourceException", "x", { $fault: "client" });
    expect(
      await inspect({
        applied: () => Promise.reject(missing),
        defaultValue: () => Promise.reject(missing),
      }),
    ).toEqual({ kind: "unusable", reason: "Service Quotas answered NoSuchResourceException" });
  });

  test("a credential provider failure is unusable, without its message", async () => {
    const error = sdkError("CredentialsProviderError", "credential_process printed AKIASECRET");
    const observation = await inspect({ describeVpcs: () => Promise.reject(error) });
    expect(observation).toEqual({
      kind: "unusable",
      reason: "the credential provider failed (CredentialsProviderError)",
    });
  });

  test("a network failure is unreachable and named by its error code", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "ETIMEDOUT"]) {
      const error = sdkError("Error", `connect ${code} 10.0.0.1:443`, { code, $metadata: {} });
      expect(await inspect({ describeVpcs: () => Promise.reject(error) })).toEqual({
        kind: "unreachable",
        reason: `network error (${code})`,
      });
    }
  });

  test("an SDK timeout is unreachable", async () => {
    expect(
      await inspect({ applied: () => Promise.reject(sdkError("TimeoutError", "socket")) }),
    ).toEqual({ kind: "unreachable", reason: `timed out after ${VPC_QUOTA_TIMEOUT_MS / 1000} s` });
  });

  test("anything else is unusable, never echoing its message", async () => {
    const secret = new Error("aws_secret_access_key=abc");
    expect(await inspect({ describeVpcs: () => Promise.reject(secret) })).toEqual({
      kind: "unusable",
      reason: "unexpected Error",
    });
    expect(await inspect({ describeVpcs: () => Promise.reject("thrown string") })).toEqual({
      kind: "unusable",
      reason: "unexpected error",
    });
    const failing = async () => {
      throw sdkError("TypeError", "cannot load module");
    };
    expect(await awsVpcQuotaProbe(failing).inspect(CHAIN, "eu-west-2", FACTORY)).toEqual({
      kind: "unusable",
      reason: "unexpected TypeError",
    });
  });

  test("stops waiting at the deadline, aborts the calls and stops paging", async () => {
    const stub = stubbed({
      describeVpcs: async () => {
        await Bun.sleep(5);
        return { Vpcs: [vpc()], NextToken: "again" };
      },
    });
    const started = Date.now();
    expect(await awsVpcQuotaProbe(stub.open, 50).inspect(CHAIN, "eu-west-2", FACTORY)).toEqual({
      kind: "unreachable",
      reason: "timed out after 0.05 s",
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(stub.sessions[0]?.abortSignal.aborted).toBe(true);
    const pages = stub.calls.length;
    await Bun.sleep(30);
    expect(stub.calls.length).toBe(pages);
    expect(stub.closed()).toBe(1);
  });

  test("a session that never opens also stops at the deadline", async () => {
    const never = () => new Promise<VpcQuotaCalls>(() => {});
    expect(await awsVpcQuotaProbe(never, 50).inspect(CHAIN, "eu-west-2", FACTORY)).toEqual({
      kind: "unreachable",
      reason: "timed out after 0.05 s",
    });
  });

  test("defaults to a 10 s deadline for the whole inspection", () => {
    expect(VPC_QUOTA_TIMEOUT_MS).toBe(10_000);
  });
});

describe("VPC quota probe over the AWS SDK and a local stub", () => {
  let stub: StubVpcQuota | undefined;
  afterEach(() => stub?.stop());

  /** The real SDK clients, pointed at the stub with example credentials: never at AWS. */
  function againstStub(answers: Parameters<typeof stubVpcQuota>[0], timeoutMs?: number) {
    stub = stubVpcQuota(answers);
    const client = { endpoint: stub.endpoint, credentials: EXAMPLE_CREDENTIALS };
    return awsVpcQuotaProbe(sdkVpcQuotaCalls({ ec2: client, serviceQuotas: client }), timeoutMs);
  }

  test("pages DescribeVpcs, finds the factory's tag and reads the applied quota", async () => {
    const probe = againstStub({
      vpcPages: [[{ Name: "default" }, {}], [{ [TAG]: FACTORY, Name: "factory" }]],
      applied: 5,
    });
    expect(await probe.inspect(CHAIN, "eu-west-2", FACTORY)).toEqual({
      kind: "observed",
      limit: 5,
      used: 3,
      factoryVpc: true,
    });
    const requests = stub?.requests ?? [];
    expect(requests.filter((body) => body.includes("Action=DescribeVpcs"))).toHaveLength(2);
    expect(requests.some((body) => body.includes("NextToken=page-1"))).toBe(true);
    expect(requests).toContainEqual(expect.stringMatching(/^GetServiceQuota .*"L-F678F1CE"/));
  });

  test("falls back to the default quota on NoSuchResourceException", async () => {
    const probe = againstStub({ vpcPages: [[{}]], defaultValue: 5 });
    expect(await probe.inspect(CHAIN, "eu-west-2", FACTORY)).toEqual({
      kind: "observed",
      limit: 5,
      used: 1,
      factoryVpc: false,
    });
    expect(stub?.requests).toContainEqual(expect.stringMatching(/^GetAWSDefaultServiceQuota /));
  });

  test("maps EC2's UnauthorizedOperation to access_denied", async () => {
    const probe = againstStub({ ec2Error: "UnauthorizedOperation", applied: 5 });
    expect(await probe.inspect(CHAIN, "eu-west-2", FACTORY)).toEqual({ kind: "access_denied" });
  });

  test("a selected profile comes only from the shared files, which here have none", async () => {
    stub = stubVpcQuota({ applied: 5 });
    const client = { endpoint: stub.endpoint };
    const probe = awsVpcQuotaProbe(sdkVpcQuotaCalls({ ec2: client, serviceQuotas: client }));
    expect(
      await probe.inspect({ source: "--profile", profile: "missing" }, "eu-west-2", FACTORY),
    ).toEqual({
      kind: "unusable",
      reason: "the credential provider failed (CredentialsProviderError)",
    });
    expect(stub.requests).toEqual([]);
  });

  test("a stub that never answers times out", async () => {
    const probe = againstStub({ hang: true }, 300);
    expect(await probe.inspect(CHAIN, "eu-west-2", FACTORY)).toEqual({
      kind: "unreachable",
      reason: "timed out after 0.3 s",
    });
  });

  test("a closed port is a network error", async () => {
    const closed = stubVpcQuota();
    closed.stop();
    const client = { endpoint: closed.endpoint, credentials: EXAMPLE_CREDENTIALS };
    const probe = awsVpcQuotaProbe(sdkVpcQuotaCalls({ ec2: client, serviceQuotas: client }));
    expect(await probe.inspect(CHAIN, "eu-west-2", FACTORY)).toEqual({
      kind: "unreachable",
      reason: "network error (ECONNREFUSED)",
    });
  });
});
