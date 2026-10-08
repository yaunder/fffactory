import { describe, expect, test } from "bun:test";
import { type DoctorDependencies, doctor } from "../../src/application/doctor";
import type { InstanceStore } from "../../src/application/instance-store";
import type { CredentialSelection } from "../../src/domain/aws-account";
import type { CheckResult, DoctorReport } from "../../src/domain/check-result";
import type { FactoryId, Release } from "../../src/domain/instance";
import { SUPPORTED_TERRAFORM } from "../../src/domain/managed-terraform";
import {
  FAKE_CALLER,
  fakeAssetBundle,
  fakeCacheDirectory,
  fakeCallerIdentity,
  fakeManagedTerraform,
  fakeToolProbe,
  fakeVpcQuotaProbe,
} from "../support/doctor-fakes";
import { MemoryInstanceStore } from "../support/memory-instance-store";

const CWD = "/work/repo";
const NEAREST = "/work/repo/.fffactory/factory.json";
const CACHE = "/home/operator/.cache/fffactory";
const RELEASE = "0.3.0" as Release;
const EXAMPLE = await Bun.file("examples/factory.json").text();

function dependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    store: new MemoryInstanceStore({ [NEAREST]: EXAMPLE }),
    tools: fakeToolProbe(),
    cache: fakeCacheDirectory().probe,
    assets: fakeAssetBundle().bundle,
    identity: fakeCallerIdentity().identity,
    terraform: fakeManagedTerraform().probe,
    vpcQuota: fakeVpcQuotaProbe().probe,
    ...overrides,
  };
}

function inspect(
  overrides: Partial<DoctorDependencies> = {},
  flag?: string,
  credentials: CredentialSelection = { source: "chain" },
) {
  return doctor(dependencies(overrides), {
    selection: { flag, cwd: CWD, home: "/home/operator" },
    cacheDirectory: CACHE,
    release: RELEASE,
    credentials,
  });
}

function check(report: DoctorReport, id: string): CheckResult {
  const found = report.capabilities.flatMap((group) => group.checks).find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe("doctor", () => {
  test("reports every capability in order, ready when everything is ready", async () => {
    const report = await inspect();
    expect(report.status).toBe("ready");
    expect(report.capabilities.map((group) => [group.id, group.checks.map((c) => c.id)])).toEqual([
      ["local_tooling", ["openssh", "tailscale"]],
      ["configuration", ["instance"]],
      ["aws", ["aws_account", "vpc_quota"]],
      ["cache", ["cache_directory", "release_assets", "terraform"]],
    ]);
  });

  test("is read-only: it never writes the instance store", async () => {
    const store = new MemoryInstanceStore({ [NEAREST]: '{"schema_version": 1}' });
    await inspect({ store });
    expect(store.writes).toEqual([]);
  });

  test("is read-only: it never materializes release assets", async () => {
    const assets = fakeAssetBundle();
    await inspect({ assets: assets.bundle });
    expect(assets.materialized).toEqual([]);
  });

  test("a probe that rejects becomes an error check, and the other checks still run", async () => {
    const report = await inspect({ tools: fakeToolProbe({ openSsh: new Error("boom") }) });
    expect(check(report, "openssh")).toMatchObject({
      status: "error",
      summary: "Could not inspect: boom",
    });
    expect(check(report, "tailscale").status).toBe("ready");
    expect(check(report, "instance").status).toBe("ready");
    expect(report.status).toBe("error");
  });

  test("a logged-out Tailscale makes the report not ready", async () => {
    const tools = fakeToolProbe({ tailscale: { kind: "backend", backendState: "NeedsLogin" } });
    const report = await inspect({ tools });
    expect(check(report, "tailscale").nextAction).toContain("`tailscale login`");
    expect(report.status).toBe("not_ready");
  });
});

describe("doctor configuration check", () => {
  test("a valid, complete instance is ready and names its path and source", async () => {
    expect(check(await inspect(), "instance")).toMatchObject({
      status: "ready",
      summary: `${NEAREST} (nearest .fffactory/factory.json) is valid and complete`,
    });
  });

  test("no instance is not ready and says to run fffactory init", async () => {
    const result = check(await inspect({ store: new MemoryInstanceStore() }), "instance");
    expect(result).toMatchObject({ status: "not_ready", summary: "No factory instance found" });
    expect(result.nextAction).toContain("Run `fffactory init`");
  });

  test("an explicit path that is not a file is not ready and offers to create it", async () => {
    const result = check(await inspect({}, "/x/missing.json"), "instance");
    expect(result).toMatchObject({
      status: "not_ready",
      summary: "--instance names /x/missing.json, which is not a file",
    });
    expect(result.nextAction).toContain("`fffactory init /x/missing.json`");
  });

  test("an invalid instance is not ready and lists every issue by field path", async () => {
    const store = new MemoryInstanceStore({
      [NEAREST]:
        '{"schema_version": 1, "factory_id": "X", "tailscale": {"auth_key_secret": "tskey-x"}}',
    });
    const result = check(await inspect({ store }), "instance");
    expect(result.status).toBe("not_ready");
    expect(result.summary).toBe(`${NEAREST} (nearest .fffactory/factory.json) is invalid`);
    expect(result.details).toEqual([
      expect.stringMatching(/^factory_id: must be/),
      expect.stringMatching(/^tailscale\.auth_key_secret: must be a Secrets Manager secret ARN/),
    ]);
    expect(JSON.stringify(result)).not.toContain("tskey");
    expect(result.nextAction).toContain("`fffactory validate`");
  });

  test("an incomplete instance is not ready and lists the missing fields in order", async () => {
    const store = new MemoryInstanceStore({ [NEAREST]: '{"schema_version": 1}' });
    const result = check(await inspect({ store }), "instance");
    expect(result.status).toBe("not_ready");
    expect(result.summary).toBe(
      `${NEAREST} (nearest .fffactory/factory.json) is missing 12 fields`,
    );
    expect(result.details[0]).toBe("release");
    expect(result.details.at(-1)).toBe("hosts");
  });

  test("a single missing field is reported in the singular", async () => {
    const example = JSON.parse(EXAMPLE);
    delete example.name;
    const store = new MemoryInstanceStore({ [NEAREST]: JSON.stringify(example) });
    const result = check(await inspect({ store }), "instance");
    expect(result.summary).toEndWith("is missing 1 field");
    expect(result.details).toEqual(["name"]);
  });

  test("an instance that cannot be read is an error", async () => {
    const store: InstanceStore = {
      isFile: async () => true,
      read: async () => {
        throw new Error("EACCES: permission denied");
      },
      write: async () => {
        throw new Error("doctor must not write");
      },
    };
    const result = check(await inspect({ store }), "instance");
    expect(result).toMatchObject({
      status: "error",
      summary: "Could not inspect: EACCES: permission denied",
    });
    expect(result.nextAction).toContain("can be read");
  });
});

describe("doctor cache check", () => {
  test("inspects the requested cache directory", async () => {
    const cache = fakeCacheDirectory("writable");
    const result = check(await inspect({ cache: cache.probe }), "cache_directory");
    expect(cache.inspected).toEqual([CACHE]);
    expect(result.status).toBe("ready");
  });

  test("a directory that cannot be written is not ready", async () => {
    const cache = fakeCacheDirectory("not_writable");
    expect(check(await inspect({ cache: cache.probe }), "cache_directory").status).toBe(
      "not_ready",
    );
  });

  test("an inspection failure is an error", async () => {
    const cache = fakeCacheDirectory(new Error("EIO"));
    const result = check(await inspect({ cache: cache.probe }), "cache_directory");
    expect(result).toMatchObject({ status: "error", summary: "Could not inspect: EIO" });
    expect(result.nextAction).toContain(CACHE);
  });
});

describe("doctor release assets check", () => {
  test("inspects this release's directory in the cache, keyed by release version", async () => {
    const assets = fakeAssetBundle("materialized");
    const result = check(await inspect({ assets: assets.bundle }), "release_assets");
    expect(assets.inspected).toEqual([`${CACHE}/releases/0.3.0`]);
    expect(result).toMatchObject({
      status: "ready",
      summary: `Release 0.3.0 assets are materialized at ${CACHE}/releases/0.3.0`,
    });
  });

  test("a tampered embedded bundle is not ready", async () => {
    const assets = fakeAssetBundle("tampered");
    const report = await inspect({ assets: assets.bundle });
    expect(check(report, "release_assets").status).toBe("not_ready");
    expect(report.status).toBe("not_ready");
  });

  test("an inspection failure is an error", async () => {
    const assets = fakeAssetBundle(new Error("EACCES: permission denied"));
    const result = check(await inspect({ assets: assets.bundle }), "release_assets");
    expect(result).toMatchObject({
      status: "error",
      summary: "Could not inspect: EACCES: permission denied",
    });
    expect(result.nextAction).toContain(`${CACHE}/releases/0.3.0`);
  });
});

describe("doctor managed Terraform check", () => {
  const { version } = SUPPORTED_TERRAFORM;
  const EXECUTABLE = `${CACHE}/terraform/${version}/terraform`;

  test("inspects the requested cache directory and names the pinned executable", async () => {
    const terraform = fakeManagedTerraform("installed");
    const result = check(await inspect({ terraform: terraform.probe }), "terraform");
    expect(terraform.inspected).toEqual([CACHE]);
    expect(result).toMatchObject({
      status: "ready",
      summary: `Terraform ${version} is installed at ${EXECUTABLE}`,
    });
  });

  test("an unsupported platform is not ready", async () => {
    const terraform = fakeManagedTerraform("unsupported_platform");
    const report = await inspect({ terraform: terraform.probe });
    expect(check(report, "terraform").status).toBe("not_ready");
    expect(report.status).toBe("not_ready");
  });

  test("an inspection failure is an error", async () => {
    const terraform = fakeManagedTerraform(new Error("EACCES: permission denied"));
    const result = check(await inspect({ terraform: terraform.probe }), "terraform");
    expect(result).toMatchObject({
      status: "error",
      summary: "Could not inspect: EACCES: permission denied",
    });
    expect(result.nextAction).toContain(`${CACHE}/terraform`);
  });
});

function withExample(edit: (example: Record<string, unknown>) => void) {
  const example = JSON.parse(EXAMPLE);
  edit(example);
  return new MemoryInstanceStore({ [NEAREST]: JSON.stringify(example) });
}

/** The example in another account or Region, without its secrets, which live in its own. */
function elsewhere(aws: Record<string, string>) {
  return withExample((example) => {
    example.aws = aws;
    delete example.tailscale;
    delete example.hosts;
  });
}

describe("doctor AWS account check", () => {
  test("a caller in factory.json's account is ready, asked in the factory Region", async () => {
    const caller = fakeCallerIdentity();
    const profile = { source: "--profile", profile: "factory-admin" } as const;
    const result = check(
      await inspect({ identity: caller.identity }, undefined, profile),
      "aws_account",
    );
    expect(result).toMatchObject({
      status: "ready",
      summary: `Account ${FAKE_CALLER.account} matches factory.json`,
    });
    expect(result.details).toContain("Credentials: profile factory-admin (--profile)");
    expect(caller.requests).toEqual([{ credentials: profile, region: "us-east-1" }]);
  });

  test("a caller in another account is refused with both account IDs", async () => {
    const store = elsewhere({ account_id: "210987654321", region: "eu-west-2" });
    const caller = fakeCallerIdentity();
    const report = await inspect({ store, identity: caller.identity });
    const result = check(report, "aws_account");
    expect(result.status).toBe("not_ready");
    expect(result.summary).toBe(
      `Account ${FAKE_CALLER.account} is not the factory's account 210987654321`,
    );
    expect(caller.requests[0]?.region).toBe("eu-west-2");
    expect(report.status).toBe("not_ready");
  });

  test("without an instance it still reports the caller but cannot compare", async () => {
    const caller = fakeCallerIdentity();
    const store = new MemoryInstanceStore();
    const result = check(await inspect({ store, identity: caller.identity }), "aws_account");
    expect(result.status).toBe("not_ready");
    expect(result.summary).toContain("there is no valid factory.json to compare it with");
    expect(result.details[0]).toBe(`Principal: ${FAKE_CALLER.arn}`);
    expect(caller.requests[0]?.region).toBe("us-east-1");
  });

  test("an invalid or unreadable instance cannot be compared either", async () => {
    const invalid = new MemoryInstanceStore({ [NEAREST]: '{"schema_version": 2}' });
    expect(check(await inspect({ store: invalid }), "aws_account").summary).toContain(
      "no valid factory.json",
    );
    const unreadable: InstanceStore = {
      isFile: async () => true,
      read: async () => {
        throw new Error("EACCES: permission denied");
      },
      write: async () => {
        throw new Error("doctor must not write");
      },
    };
    const report = await inspect({ store: unreadable });
    expect(check(report, "instance").status).toBe("error");
    expect(check(report, "aws_account").summary).toContain("no valid factory.json");
  });

  test("a valid instance without aws.account_id asks for it", async () => {
    const store = elsewhere({ region: "eu-west-2" });
    const caller = fakeCallerIdentity();
    const result = check(await inspect({ store, identity: caller.identity }), "aws_account");
    expect(result.summary).toContain("factory.json sets no aws.account_id");
    expect(caller.requests[0]?.region).toBe("eu-west-2");
  });

  test("missing credentials are not ready with a next action", async () => {
    const { identity } = fakeCallerIdentity({ kind: "no_credentials" });
    const result = check(await inspect({ identity }), "aws_account");
    expect(result).toMatchObject({ status: "not_ready", summary: "No AWS credentials found" });
    expect(result.nextAction).toContain("aws configure sso");
  });

  test("a port that rejects becomes an error check, and the other checks still run", async () => {
    const { identity } = fakeCallerIdentity(new Error("defect"));
    const report = await inspect({ identity });
    expect(check(report, "aws_account")).toMatchObject({
      status: "error",
      summary: "Could not inspect: defect",
    });
    expect(check(report, "instance").status).toBe("ready");
    expect(report.status).toBe("error");
  });

  test("reads the instance once for both the configuration and AWS checks", async () => {
    const store = new MemoryInstanceStore({ [NEAREST]: EXAMPLE });
    await inspect({ store });
    expect(store.reads).toEqual([NEAREST]);
  });
});

describe("doctor VPC quota check", () => {
  test("after an account match, asks for the factory Region and ID with the same credentials", async () => {
    const quota = fakeVpcQuotaProbe();
    const profile = { source: "--profile", profile: "factory-admin" } as const;
    const report = await inspect({ vpcQuota: quota.probe }, undefined, profile);
    expect(check(report, "vpc_quota")).toMatchObject({
      status: "ready",
      summary: "1 of 5 VPCs in use in us-east-1; the factory's VPC fits",
    });
    expect(quota.requests).toEqual([
      { credentials: profile, region: "us-east-1", factoryId: "example" as FactoryId },
    ]);
  });

  test("a full Region is not ready, and so is the report", async () => {
    const quota = fakeVpcQuotaProbe({ kind: "observed", limit: 5, used: 5, factoryVpc: false });
    const report = await inspect({ vpcQuota: quota.probe });
    expect(check(report, "vpc_quota").status).toBe("not_ready");
    expect(check(report, "vpc_quota").nextAction).toContain("'VPCs per Region'");
    expect(report.status).toBe("not_ready");
  });

  test("never asks AWS about an account that is not the factory's", async () => {
    const store = elsewhere({ account_id: "210987654321", region: "eu-west-2" });
    const quota = fakeVpcQuotaProbe();
    const result = check(await inspect({ store, vpcQuota: quota.probe }), "vpc_quota");
    expect(result).toMatchObject({
      status: "not_ready",
      nextAction: "Make the aws_account check ready, then rerun `fffactory doctor`.",
    });
    expect(quota.requests).toEqual([]);
  });

  test("an unresolved caller or a failed account check makes no quota call either", async () => {
    for (const observation of [{ kind: "no_credentials" } as const, new Error("defect")]) {
      const quota = fakeVpcQuotaProbe();
      const { identity } = fakeCallerIdentity(observation);
      const result = check(await inspect({ identity, vpcQuota: quota.probe }), "vpc_quota");
      expect(result.status).toBe("not_ready");
      expect(result.summary).toStartWith("Not inspected:");
      expect(quota.requests).toEqual([]);
    }
  });

  test("without an instance, no quota call is made", async () => {
    const quota = fakeVpcQuotaProbe();
    const store = new MemoryInstanceStore();
    const result = check(await inspect({ store, vpcQuota: quota.probe }), "vpc_quota");
    expect(result.status).toBe("not_ready");
    expect(quota.requests).toEqual([]);
  });

  test("a matching account without aws.region lists the missing field and makes no call", async () => {
    const store = withExample((example) => {
      example.aws = { account_id: "123456789012" };
    });
    const quota = fakeVpcQuotaProbe();
    const report = await inspect({ store, vpcQuota: quota.probe });
    expect(check(report, "aws_account").status).toBe("ready");
    expect(check(report, "vpc_quota")).toMatchObject({
      status: "not_ready",
      details: ["aws.region"],
    });
    expect(quota.requests).toEqual([]);
  });

  test("a port that rejects becomes an error check", async () => {
    const quota = fakeVpcQuotaProbe(new Error("defect"));
    const report = await inspect({ vpcQuota: quota.probe });
    expect(check(report, "vpc_quota")).toMatchObject({
      status: "error",
      summary: "Could not inspect: defect",
    });
    expect(check(report, "aws_account").status).toBe("ready");
    expect(report.status).toBe("error");
  });

  test("an unreachable EC2 or Service Quotas is an error", async () => {
    const quota = fakeVpcQuotaProbe({ kind: "unreachable", reason: "timed out after 10 s" });
    expect(check(await inspect({ vpcQuota: quota.probe }), "vpc_quota").status).toBe("error");
  });
});
