import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../../package.json";
import { isolatedAwsEnvironment } from "../support/aws-isolation";
import { goneWithin, killSurvivors, recordedPids } from "../support/processes";
import { checkStatuses, doctorCheck, MAIN, spawnCli } from "../support/spawn-cli";
import { EXAMPLE_CREDENTIALS, type StubSts, stubSts } from "../support/stub-sts";
import { type StubVpcQuota, stubVpcQuota } from "../support/stub-vpc-quota";

const EXAMPLE = resolve(import.meta.dir, "../../examples/factory.json");
let scratch: string;
/** No AWS credentials and no route to IMDS or AWS; see `support/aws-isolation.ts`. */
let isolatedAws: Record<string, string>;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-cli-"));
  isolatedAws = isolatedAwsEnvironment(scratch);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function fffactory(...args: string[]) {
  return fffactoryIn(scratch, ...args);
}

function fffactoryIn(cwd: string, ...args: string[]) {
  return fffactoryWith(process.env.PATH ?? "", cwd, ...args);
}

function fffactoryWith(path: string, cwd: string, ...args: string[]) {
  const env: Record<string, string> = { PATH: path, HOME: scratch, ...isolatedAws };
  const result = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, env });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("fffactory executable", () => {
  test("validate exits 0 for examples/factory.json", () => {
    const result = fffactory("validate", "--instance", EXAMPLE);
    expect(result.stdout).toContain("Valid factory.json");
    expect(result.code).toBe(0);
  });

  test("validate exits non-zero with a field path for invalid input", async () => {
    const invalid = join(scratch, "invalid.json");
    await writeFile(
      invalid,
      JSON.stringify({ schema_version: 1, hosts: [{ key: "a" }, { key: "a" }] }),
    );
    const result = fffactory("validate", "--instance", invalid);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('hosts[1].key: duplicates host key "a"');
  });

  test("validate exits non-zero with an initialization instruction when nothing is found", () => {
    const result = fffactory("validate");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("fffactory init");
  });

  test("init creates a document that validate accepts, and a rerun changes nothing", async () => {
    const project = join(scratch, "project");
    await mkdir(project);
    const created = fffactoryIn(project, "init");
    expect(created.stdout).toContain("Created ");
    expect(created.code).toBe(0);
    const document = join(project, ".fffactory", "factory.json");
    const first = await readFile(document, "utf8");
    expect(JSON.parse(first).factory_id).toMatch(/^fff-[a-z0-9]{8}$/);

    const validated = fffactoryIn(project, "validate");
    expect(validated.stdout).toContain(`Instance: ${await realpath(document)}`);
    expect(validated.stdout).toContain("Valid factory.json");
    expect(validated.code).toBe(0);

    const rerun = fffactoryIn(project, "init");
    expect(rerun.stdout).toContain("Unchanged ");
    expect(await readFile(document, "utf8")).toBe(first);
  });
});

describe("fffactory executable release and assets", () => {
  test("--version prints the package.json release", () => {
    const result = fffactory("--version");
    expect(result.stdout).toBe(`${manifest.version}\n`);
    expect(result.code).toBe(0);
  });

  test("assets materializes into the cache keyed by release, and a rerun is a no-op", async () => {
    const directory = join(scratch, ".cache", "fffactory", "releases", manifest.version);
    const first = fffactory("assets");
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(`${directory}\n`);
    expect(first.code).toBe(0);
    const metadata = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
    expect(metadata).toEqual({ release: manifest.version });
    const before = await stat(join(directory, ".fffactory-assets.json"));

    const rerun = fffactory("assets");
    expect(rerun.stdout).toBe(first.stdout);
    expect(rerun.code).toBe(0);
    const after = await stat(join(directory, ".fffactory-assets.json"));
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);

    const doctor = fffactory("doctor", "--json", "--instance", EXAMPLE);
    expect(doctorCheck(doctor.stdout, "release_assets")).toMatchObject({
      status: "ready",
      summary: `Release ${manifest.version} assets are materialized at ${directory}`,
    });
  });
});

/** A private PATH holding only the given stand-in commands, so no test runs the host's tools. */
async function toolPath(name: string, tools: Record<string, string>): Promise<string> {
  const directory = join(scratch, "bin", name);
  await mkdir(directory, { recursive: true });
  for (const [tool, script] of Object.entries(tools)) {
    const file = join(directory, tool);
    await writeFile(file, `#!/bin/sh\n${script}\n`);
    await chmod(file, 0o755);
  }
  return directory;
}

const OPENSSH = "echo 'OpenSSH_9.9p1, OpenSSL 3.5.7 9 Jun 2026' >&2";
const TAILSCALE_RUNNING = `echo '{"BackendState": "Running"}'`;

function statuses(stdout: string): Record<string, string> {
  expect(JSON.parse(stdout).schema_version).toBe(1);
  return checkStatuses(stdout);
}

describe("fffactory doctor executable", () => {
  test("exits 2 when neither ssh nor tailscale is on PATH", async () => {
    const path = await toolPath("none", {});
    const result = fffactoryWith(path, scratch, "doctor", "--json", "--instance", EXAMPLE);
    expect(result.stderr).toBe("");
    expect(statuses(result.stdout)).toEqual({
      openssh: "not_ready",
      tailscale: "not_ready",
      instance: "ready",
      aws_account: "not_ready",
      vpc_quota: "not_ready",
      cache_directory: "ready",
      release_assets: "ready",
      terraform: "ready",
    });
    expect(result.code).toBe(2);
  });

  test("exits 1 when tailscale prints output doctor cannot interpret", async () => {
    const path = await toolPath("garbled", { ssh: OPENSSH, tailscale: "echo 'not json'" });
    const result = fffactoryWith(path, scratch, "doctor", "--json", "--instance", EXAMPLE);
    expect(statuses(result.stdout).tailscale).toBe("error");
    expect(result.code).toBe(1);
  });
});

/** Writes `contents` to a file in a fresh directory under scratch and returns its path. */
async function scratchFile(name: string, contents: string): Promise<string> {
  const directory = await mkdtemp(join(scratch, "aws-"));
  const file = join(directory, name);
  await writeFile(file, contents);
  return file;
}

const EXAMPLE_KEYS =
  `aws_access_key_id = ${EXAMPLE_CREDENTIALS.accessKeyId}\n` +
  `aws_secret_access_key = ${EXAMPLE_CREDENTIALS.secretAccessKey}\n`;
const ACCOUNT = "123456789012";
const ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/FactoryAdmin/operator`;

describe("fffactory doctor executable, AWS account", () => {
  let sts: StubSts | undefined;
  let quota: StubVpcQuota | undefined;
  afterEach(() => {
    sts?.stop();
    quota?.stop();
  });

  interface AwsScenario {
    /** Variables set on top of the isolated AWS environment. */
    readonly aws?: Record<string, string>;
    readonly args?: readonly string[];
    /** What the stub STS answers. */
    readonly caller?: { readonly account: string; readonly arn: string };
    readonly home?: string;
    /** Leaves instance metadata enabled, for a test serving its own stand-in IMDS. */
    readonly metadata?: boolean;
  }

  /**
   * Spawns doctor with ready stand-in tools and the isolated AWS environment, with STS,
   * EC2 and Service Quotas pointed at local stubs. The Region has room for one more VPC.
   */
  async function doctorWithAws({
    aws = {},
    args = [],
    caller = { account: ACCOUNT, arn: ARN },
    home = scratch,
    metadata = false,
  }: AwsScenario = {}) {
    sts = stubSts({ kind: "caller", ...caller });
    quota = stubVpcQuota({ vpcPages: [[{ Name: "default" }]], applied: 5 });
    const path = await toolPath("aws-ready", { ssh: OPENSSH, tailscale: TAILSCALE_RUNNING });
    const { AWS_EC2_METADATA_DISABLED: _, ...withMetadata } = isolatedAws;
    const isolated = metadata ? withMetadata : isolatedAws;
    const env = {
      PATH: path,
      HOME: home,
      ...isolated,
      AWS_ENDPOINT_URL_STS: sts.endpoint,
      AWS_ENDPOINT_URL_EC2: quota.endpoint,
      AWS_ENDPOINT_URL_SERVICE_QUOTAS: quota.endpoint,
      ...aws,
    };
    const result = await spawnCli(["doctor", "--instance", EXAMPLE, ...args], {
      cwd: scratch,
      env,
    });
    return { ...result, requests: sts.requests, quotaRequests: quota.requests };
  }

  test("exits 0 when every check is ready, reporting the caller from STS", async () => {
    const credentials = await scratchFile("credentials", `[default]\n${EXAMPLE_KEYS}`);
    const result = await doctorWithAws({ aws: { AWS_SHARED_CREDENTIALS_FILE: credentials } });
    expect(result.stdout).toContain("OpenSSH client: OpenSSH_9.9p1");
    expect(result.stdout).toContain(`AWS account: Account ${ACCOUNT} matches factory.json`);
    expect(result.stdout).toContain(`Principal: ${ARN}`);
    expect(result.stdout).toContain(
      "VPC quota: 1 of 5 VPCs in use in us-east-1; the factory's VPC fits",
    );
    expect(result.stdout).toContain("Ready: all 8 checks are ready.");
    expect(result.stdout).not.toContain(EXAMPLE_CREDENTIALS.secretAccessKey);
    expect(result.stdout).not.toContain(EXAMPLE_CREDENTIALS.accessKeyId);
    expect(result.requests).toHaveLength(1);
    expect(result.code).toBe(0);
  });

  test("refuses a caller in another account, showing both account IDs", async () => {
    const credentials = await scratchFile("credentials", `[default]\n${EXAMPLE_KEYS}`);
    const other = { account: "210987654321", arn: "arn:aws:iam::210987654321:user/someone" };
    const result = await doctorWithAws({
      aws: { AWS_SHARED_CREDENTIALS_FILE: credentials },
      args: ["--json"],
      caller: other,
    });
    expect(doctorCheck(result.stdout, "aws_account")).toMatchObject({
      status: "not_ready",
      summary: `Account 210987654321 is not the factory's account ${ACCOUNT}`,
    });
    expect(doctorCheck(result.stdout, "vpc_quota").status).toBe("not_ready");
    expect(result.quotaRequests).toEqual([]);
    expect(result.code).toBe(2);
  });

  test("uses the --profile it is given", async () => {
    const credentials = await scratchFile("credentials", `[factory-admin]\n${EXAMPLE_KEYS}`);
    const result = await doctorWithAws({
      aws: { AWS_SHARED_CREDENTIALS_FILE: credentials },
      args: ["--json", "--profile", "factory-admin"],
    });
    expect(doctorCheck(result.stdout, "aws_account")).toMatchObject({ status: "ready" });
    expect(doctorCheck(result.stdout, "vpc_quota")).toMatchObject({
      status: "ready",
      details: [
        "Region: us-east-1 (factory.json)",
        "Credentials: profile factory-admin (--profile)",
      ],
    });
    expect(result.code).toBe(0);
  });

  test("a --profile that does not exist is not ready, and nothing reaches STS", async () => {
    const credentials = await scratchFile("credentials", `[default]\n${EXAMPLE_KEYS}`);
    const result = await doctorWithAws({
      aws: { AWS_SHARED_CREDENTIALS_FILE: credentials },
      args: ["--json", "--profile", "missing"],
    });
    const check = doctorCheck(result.stdout, "aws_account");
    expect(check).toMatchObject({
      status: "not_ready",
      summary: "Profile missing has no credentials configured, or does not exist",
    });
    expect(check.next_action).toContain("`aws configure sso --profile missing`");
    expect(result.stderr).toBe("");
    expect(result.requests).toEqual([]);
    expect(result.code).toBe(2);
  });

  test("an AWS_PROFILE that does not exist never falls back to instance metadata", async () => {
    // A stand-in IMDS that hands out credentials: the SDK's default chain would fall
    // through to it and succeed, so a ready result here would mean a silent fallback.
    const imds = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/latest/api/token") return new Response("example-imds-token");
        if (pathname.endsWith("/security-credentials/")) return new Response("FactoryHost");
        return Response.json({
          Code: "Success",
          AccessKeyId: EXAMPLE_CREDENTIALS.accessKeyId,
          SecretAccessKey: EXAMPLE_CREDENTIALS.secretAccessKey,
          Token: "example-session-token",
          Expiration: new Date(Date.now() + 3_600_000).toISOString(),
        });
      },
    });
    try {
      const result = await doctorWithAws({
        aws: {
          AWS_EC2_METADATA_SERVICE_ENDPOINT: `http://127.0.0.1:${imds.port}`,
          AWS_PROFILE: "missing",
        },
        args: ["--json"],
        metadata: true,
      });
      expect(doctorCheck(result.stdout, "aws_account")).toMatchObject({
        status: "not_ready",
        summary: "Profile missing has no credentials configured, or does not exist",
        details: ["Region: us-east-1 (factory.json)", "Credentials: profile missing (AWS_PROFILE)"],
      });
      expect(result.requests).toEqual([]);
    } finally {
      imds.stop(true);
    }
  });

  test("an expired SSO session says to log in, and nothing reaches AWS", async () => {
    const startUrl = "https://example.awsapps.com/start";
    const config = await scratchFile(
      "config",
      "[profile sso-admin]\n" +
        `sso_start_url = ${startUrl}\nsso_region = us-east-1\n` +
        `sso_account_id = ${ACCOUNT}\nsso_role_name = FactoryAdmin\n`,
    );
    const home = await mkdtemp(join(scratch, "home-"));
    const cache = join(home, ".aws", "sso", "cache");
    await mkdir(cache, { recursive: true });
    const key = new Bun.CryptoHasher("sha1").update(startUrl).digest("hex");
    await writeFile(
      join(cache, `${key}.json`),
      JSON.stringify({
        startUrl,
        region: "us-east-1",
        accessToken: "expired-example-token",
        expiresAt: "2020-01-01T00:00:00Z",
      }),
    );
    const result = await doctorWithAws({
      aws: { AWS_CONFIG_FILE: config },
      args: ["--json", "--profile", "sso-admin"],
      home,
    });
    const check = doctorCheck(result.stdout, "aws_account");
    expect(check.status).toBe("not_ready");
    expect(check.next_action).toBe(
      "Log in with `aws sso login --profile sso-admin`, then rerun `fffactory doctor`.",
    );
    expect(result.stdout).not.toContain("expired-example-token");
    expect(result.requests).toEqual([]);
  });

  test("missing credentials exit 2 with a next action on standard output only", async () => {
    const result = await doctorWithAws();
    expect(result.stdout).toContain("AWS account: No AWS credentials found");
    expect(result.stdout).toContain("Next: Configure AWS credentials");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(2);
  });
});

describe("fffactory doctor executable, interrupted", () => {
  const survivors: number[] = [];

  afterEach(() => killSurvivors(survivors));

  // A non-exec `ssh` wrapper: the shell starts a long sleep, records its own pid and
  // the sleeper's, and waits, so the sleeper is a grandchild of doctor in the tool's
  // process group.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    test(`says so, kills the running tool and exits ${code} on ${signal}`, async () => {
      const pidFile = join(scratch, `interrupted-${signal}.pid`);
      const sleep = Bun.which("sleep");
      if (!sleep) throw new Error("sleep is not on PATH");
      const path = await toolPath(`interrupted-${signal}`, {
        ssh: `${sleep} 33 &\necho "$$ $!" > '${pidFile}'\nwait`,
      });
      const doctor = Bun.spawn([process.execPath, MAIN, "doctor", "--instance", EXAMPLE], {
        cwd: scratch,
        env: { PATH: path, HOME: scratch, ...isolatedAws },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      survivors.push(doctor.pid);
      const tool = await recordedPids(pidFile, 2, 4000);
      survivors.push(...(tool ?? []));
      expect(tool).toBeDefined();

      doctor.kill(signal);
      expect(await doctor.exited).toBe(code);
      // Bun reports a death by signal as 128 + n too; doctor must exit on its own.
      expect(doctor.signalCode).toBeNull();
      // Tools' output is captured, so the operator is told at once what is happening. Doctor's
      // tools are killed at once, so there is no second interrupt to offer.
      expect(await new Response(doctor.stderr).text()).toBe(
        "Interrupted: stopping running tools.\n",
      );
      for (const pid of tool ?? []) expect(await goneWithin(pid, 2000)).toBe(true);
    });
  }
});
