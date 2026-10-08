import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import schema from "../../schemas/doctor-report.schema.json";
import { run } from "../../src/cli/run";
import type { FactoryId } from "../../src/domain/instance";
import { harness } from "../support/cli-harness";
import {
  FAKE_CALLER,
  fakeCacheDirectory,
  fakeCallerIdentity,
  fakeToolProbe,
  fakeVpcQuotaProbe,
} from "../support/doctor-fakes";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import expected from "./fixtures/doctor-report.json";

const NEAREST = "/work/repo/.fffactory/factory.json";
const EXAMPLE = await Bun.file("examples/factory.json").text();
const schemaAccepts = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function complete() {
  return new MemoryInstanceStore({ [NEAREST]: EXAMPLE });
}

/** Logged-out Tailscale, a partial instance and no cache yet: the fixture's scenario. */
function notReadyScenario() {
  return harness(
    new MemoryInstanceStore({ [NEAREST]: '{"schema_version": 1}' }),
    {},
    { tools: fakeToolProbe({ tailscale: { kind: "backend", backendState: "NeedsLogin" } }) },
  );
}

describe("fffactory doctor exit codes", () => {
  test("exits 0 when every check is ready", async () => {
    const { context, out, err } = harness(complete());
    expect(await run(["doctor"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out.at(-1)).toBe("Ready: all 8 checks are ready.");
  });

  test("exits 2 when something is missing", async () => {
    const { context, out } = harness(
      complete(),
      {},
      { tools: fakeToolProbe({ openSsh: { kind: "not_found" } }) },
    );
    expect(await run(["doctor"], context)).toBe(2);
    expect(out.at(-1)).toBe("Not ready: 1 of 8 checks needs attention.");
  });

  test("exits 1 when a check could not be inspected, and still prints the full report", async () => {
    const tools = fakeToolProbe({ tailscale: { kind: "unusable", reason: "timed out" } });
    const { context, out } = harness(complete(), {}, { tools });
    expect(await run(["doctor"], context)).toBe(1);
    expect(out).toContain("Cache: ready");
    expect(out.at(-1)).toBe("Error: 1 of 8 checks needs attention.");
  });

  test("interrupted, prints no report: what it saw was cut short (plan-apply §Interruption)", async () => {
    const { context, out } = harness(complete(), {}, { interrupted: () => true });
    expect(await run(["doctor"], context)).toBe(1);
    expect(await run(["doctor", "--json"], context)).toBe(1);
    expect(out).toEqual([]);
  });

  test("error outranks not ready", async () => {
    const tools = fakeToolProbe({ openSsh: { kind: "not_found" }, tailscale: new Error("boom") });
    const { context, out } = harness(complete(), {}, { tools });
    expect(await run(["doctor"], context)).toBe(1);
    expect(out.at(-1)).toBe("Error: 2 of 8 checks need attention.");
  });

  test("exits 1 for unexpected arguments, printing only the reason", async () => {
    const { context, out, err } = harness(complete());
    expect(await run(["doctor", "--bogus"], context)).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("--bogus");
    expect(await run(["doctor", "extra"], context)).toBe(1);
  });
});

describe("fffactory doctor human output", () => {
  test("groups checks by capability with statuses, details and next actions", async () => {
    const { context, out } = notReadyScenario();
    expect(await run(["doctor"], context)).toBe(2);
    expect(out.join("\n")).toBe(
      [
        "fffactory doctor, release 0.3.0",
        "",
        "Local tooling: not ready",
        "  ready      OpenSSH client: OpenSSH_9.9p1",
        "  not ready  Tailscale client: Logged out",
        "             Next: Log in with `tailscale login`, then rerun `fffactory doctor`.",
        "",
        "Configuration: not ready",
        `  not ready  factory.json: ${NEAREST} (nearest .fffactory/factory.json) is missing 12 fields`,
        "               release",
        "               factory_id",
        "               name",
        "               aws.account_id",
        "               aws.region",
        "               state_backend.bucket",
        "               network.vpc_cidr",
        "               network.public_subnet_cidr",
        "               network.availability_zone",
        "               tailscale.tag",
        "               tailscale.auth_key_secret",
        "               hosts",
        "             Next: Fill in each field listed, check the result with `fffactory validate`, then rerun `fffactory doctor`.",
        "",
        "AWS: not ready",
        "  not ready  AWS account: Caller is in account 123456789012; factory.json sets no aws.account_id to compare it with",
        "               Principal: arn:aws:sts::123456789012:assumed-role/FactoryAdmin/operator",
        "               Region: us-east-1 (no factory Region available; used for STS)",
        "               Credentials: standard AWS credential chain",
        "             Next: Set aws.account_id in factory.json to the factory's 12-digit AWS account ID, check the result with `fffactory validate`, then rerun `fffactory doctor`.",
        "  not ready  VPC quota: Not inspected: doctor reads the VPC quota only in the factory's own AWS account",
        "             Next: Make the aws_account check ready, then rerun `fffactory doctor`.",
        "",
        "Cache: ready",
        "  ready      FFFactory cache directory: /home/operator/.cache/fffactory does not exist yet; FFFactory creates it when first needed",
        "  ready      Release assets: Release 0.3.0 assets are not materialized yet; FFFactory materializes them into /home/operator/.cache/fffactory/releases/0.3.0 when first needed",
        "  ready      Managed Terraform: Terraform 1.16.4 is not downloaded yet; FFFactory downloads it into /home/operator/.cache/fffactory/terraform/1.16.4/terraform from releases.hashicorp.com when first needed",
        "",
        "Not ready: 4 of 8 checks need attention.",
      ].join("\n"),
    );
  });

  test("missing OpenSSH, missing Tailscale and logged-out Tailscale each print a distinct next action", async () => {
    const scenarios = [
      fakeToolProbe({ openSsh: { kind: "not_found" } }),
      fakeToolProbe({ tailscale: { kind: "not_found" } }),
      fakeToolProbe({ tailscale: { kind: "backend", backendState: "NeedsLogin" } }),
    ];
    const actions = new Set<string>();
    for (const tools of scenarios) {
      const { context, out } = harness(complete(), {}, { tools });
      expect(await run(["doctor"], context)).toBe(2);
      const next = out.filter((line) => line.trimStart().startsWith("Next:"));
      expect(next).toHaveLength(1);
      actions.add(next[0] ?? "");
    }
    expect(actions.size).toBe(3);
  });

  test("honours --instance and FFFACTORY_INSTANCE", async () => {
    const store = new MemoryInstanceStore({ "/x/factory.json": EXAMPLE });
    const flagged = harness(store);
    expect(await run(["doctor", "--instance", "/x/factory.json"], flagged.context)).toBe(0);
    expect(flagged.out.join("\n")).toContain("/x/factory.json (--instance) is valid and complete");
    const environment = harness(store, { FFFACTORY_INSTANCE: "/x/factory.json" });
    expect(await run(["doctor"], environment.context)).toBe(0);
  });

  test("inspects the XDG cache directory when XDG_CACHE_HOME is set", async () => {
    const cache = fakeCacheDirectory("writable");
    const { context } = harness(complete(), { XDG_CACHE_HOME: "/xdg" }, { cache: cache.probe });
    expect(await run(["doctor"], context)).toBe(0);
    expect(cache.inspected).toEqual(["/xdg/fffactory"]);
  });

  test("never prints configuration values, even a pasted secret", async () => {
    const document = JSON.stringify({
      schema_version: 1,
      name: "tskey-auth-in-name",
      tailscale: { auth_key_secret: "tskey-auth-pasted" },
    });
    for (const args of [["doctor"], ["doctor", "--json"]]) {
      const { context, out, err } = harness(new MemoryInstanceStore({ [NEAREST]: document }));
      expect(await run(args, context)).toBe(2);
      expect([...out, ...err].join("\n")).not.toContain("tskey");
    }
  });
});

describe("fffactory doctor AWS account", () => {
  test("selects credentials with --profile, over AWS_PROFILE", async () => {
    const caller = fakeCallerIdentity();
    const { context, out } = harness(
      complete(),
      { AWS_PROFILE: "from-environment" },
      { identity: caller.identity },
    );
    expect(await run(["doctor", "--profile", "factory-admin"], context)).toBe(0);
    expect(caller.requests).toEqual([
      { credentials: { source: "--profile", profile: "factory-admin" }, region: "us-east-1" },
    ]);
    expect(out).toContain("               Credentials: profile factory-admin (--profile)");
  });

  test("selects credentials with AWS_PROFILE, else the standard chain", async () => {
    const fromEnvironment = fakeCallerIdentity();
    const withProfile = harness(
      complete(),
      { AWS_PROFILE: "from-environment" },
      { identity: fromEnvironment.identity },
    );
    expect(await run(["doctor"], withProfile.context)).toBe(0);
    expect(fromEnvironment.requests[0]?.credentials).toEqual({
      source: "AWS_PROFILE",
      profile: "from-environment",
    });
    const chain = fakeCallerIdentity();
    const plain = harness(complete(), {}, { identity: chain.identity });
    expect(await run(["doctor"], plain.context)).toBe(0);
    expect(chain.requests[0]?.credentials).toEqual({ source: "chain" });
  });

  test("commands that never call AWS reject --profile", async () => {
    for (const command of ["init", "validate"]) {
      const { context, err } = harness(complete());
      expect(await run([command, "--profile", "factory-admin"], context)).toBe(1);
      expect(err[0]).toContain("--profile");
    }
  });

  test("an empty --profile is an invalid argument", async () => {
    const { context, out, err } = harness(complete());
    expect(await run(["doctor", "--profile", ""], context)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["fffactory doctor: --profile needs a profile name"]);
  });

  test("a caller in another account exits 2 and shows both account IDs", async () => {
    const other = { account: "210987654321", arn: "arn:aws:iam::210987654321:user/someone" };
    const { identity } = fakeCallerIdentity({ kind: "caller", caller: other });
    const { context, out } = harness(complete(), {}, { identity });
    expect(await run(["doctor"], context)).toBe(2);
    expect(out).toContain(
      `  not ready  AWS account: Account 210987654321 is not the factory's account ${FAKE_CALLER.account}`,
    );
  });

  test("missing credentials exit 2 with a next action and no stack trace", async () => {
    const { identity } = fakeCallerIdentity({ kind: "no_credentials" });
    const { context, out, err } = harness(complete(), {}, { identity });
    expect(await run(["doctor"], context)).toBe(2);
    expect(err).toEqual([]);
    expect(out).toContain("  not ready  AWS account: No AWS credentials found");
    expect(out.join("\n")).not.toMatch(/\bat .+:\d+:\d+/);
  });

  test("an unreachable STS exits 1", async () => {
    const { identity } = fakeCallerIdentity({ kind: "unreachable", reason: "timed out after 5 s" });
    const { context } = harness(complete(), {}, { identity });
    expect(await run(["doctor"], context)).toBe(1);
  });
});

describe("fffactory doctor VPC quota", () => {
  test("reads the quota with the selected credentials in the factory Region", async () => {
    const quota = fakeVpcQuotaProbe();
    const { context, out } = harness(complete(), {}, { vpcQuota: quota.probe });
    expect(await run(["doctor", "--profile", "factory-admin"], context)).toBe(0);
    expect(quota.requests).toEqual([
      {
        credentials: { source: "--profile", profile: "factory-admin" },
        region: "us-east-1",
        factoryId: "example" as FactoryId,
      },
    ]);
    expect(out).toContain(
      "  ready      VPC quota: 1 of 5 VPCs in use in us-east-1; the factory's VPC fits",
    );
  });

  test("a full Region exits 2 with the quota next action", async () => {
    const quota = fakeVpcQuotaProbe({ kind: "observed", limit: 5, used: 5, factoryVpc: false });
    const { context, out } = harness(complete(), {}, { vpcQuota: quota.probe });
    expect(await run(["doctor"], context)).toBe(2);
    expect(out).toContain(
      "             Next: Request a higher 'VPCs per Region' quota in Service Quotas for " +
        "us-east-1, or delete an unused VPC, then rerun `fffactory doctor`.",
    );
  });

  test("an unreachable EC2 or Service Quotas exits 1", async () => {
    const quota = fakeVpcQuotaProbe({ kind: "unreachable", reason: "network error (ENOTFOUND)" });
    const { context } = harness(complete(), {}, { vpcQuota: quota.probe });
    expect(await run(["doctor"], context)).toBe(1);
  });
});

describe("fffactory doctor --json", () => {
  test("matches the checked-in report, byte for byte", async () => {
    const { context, out, err } = notReadyScenario();
    expect(await run(["doctor", "--json"], context)).toBe(2);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "")).toEqual(expected);
    expect(out[0]).toBe(JSON.stringify(expected, null, 2));
  });

  test("carries schema version 1 and the running release", () => {
    expect(expected.schema_version).toBe(1);
    expect(expected.release).toBe("0.3.0");
  });

  test("the checked-in report conforms to the published schema", () => {
    expect(schemaAccepts(expected)).toBe(true);
  });

  test("ready and error reports conform too, with the same exit codes", async () => {
    const ready = harness(complete());
    expect(await run(["doctor", "--json"], ready.context)).toBe(0);
    const readyReport = JSON.parse(ready.out[0] ?? "");
    expect(readyReport.status).toBe("ready");
    expect(schemaAccepts(readyReport)).toBe(true);

    const tools = fakeToolProbe({ openSsh: new Error("boom") });
    const failing = harness(complete(), {}, { tools });
    expect(await run(["doctor", "--json"], failing.context)).toBe(1);
    const failingReport = JSON.parse(failing.out[0] ?? "");
    expect(failingReport.status).toBe("error");
    expect(schemaAccepts(failingReport)).toBe(true);
  });

  test("the schema rejects a non-ready check without a next action", () => {
    const broken = structuredClone(expected);
    const tailscale = broken.capabilities[0]?.checks[1] as { next_action: string | null };
    tailscale.next_action = null;
    expect(schemaAccepts(broken)).toBe(false);
  });

  test("the schema rejects a ready check with a next action, and an unknown status", () => {
    const withAction = structuredClone(expected);
    const openssh = withAction.capabilities[0]?.checks[0] as { next_action: string | null };
    openssh.next_action = "Do something.";
    expect(schemaAccepts(withAction)).toBe(false);
    expect(schemaAccepts({ ...expected, status: "degraded" })).toBe(false);
    expect(schemaAccepts({ ...expected, schema_version: 2 })).toBe(false);
  });
});

describe("fffactory doctor help", () => {
  test("is listed in the command usage and prints its own usage", async () => {
    const { context, out } = harness(complete());
    expect(await run(["--help"], context)).toBe(0);
    expect(out.join("\n")).toContain("doctor");
    out.length = 0;
    expect(await run(["doctor", "--help"], context)).toBe(0);
    expect(out[0]).toBe("Usage: fffactory doctor [--instance PATH] [--profile NAME] [--json]");
  });
});
