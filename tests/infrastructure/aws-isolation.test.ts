import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stsCallerIdentity } from "../../src/infrastructure/aws-sts-caller-identity";
import { CLOSED_ENDPOINT, isolatedAwsEnvironment } from "../support/aws-isolation";
import { doctorCheck, spawnCli } from "../support/spawn-cli";
import { type StubSts, stubSts } from "../support/stub-sts";

const EXAMPLE = resolve(import.meta.dir, "../../examples/factory.json");
const CREDENTIAL_VARIABLES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
];
let scratch: string;
let trap: StubSts | undefined;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-aws-isolation-test-"));
});
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => trap?.stop());

/** A local server that records anything sent to it: a stand-in for IMDS and AWS. */
function startTrap(): StubSts {
  trap = stubSts({ kind: "error", status: 404, code: "Trapped" });
  return trap;
}

describe("tests cannot reach a real AWS account", () => {
  test("the test process holds no AWS credentials or profile and no route to IMDS or AWS", () => {
    for (const name of CREDENTIAL_VARIABLES)
      expect({ name, value: process.env[name] }).toEqual({ name, value: undefined });
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe("true");
    expect(process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT).toBe(CLOSED_ENDPOINT);
    expect(process.env.AWS_ENDPOINT_URL).toBe(CLOSED_ENDPOINT);
    expect(process.env.AWS_CONFIG_FILE).toStartWith(tmpdir());
    expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toStartWith(tmpdir());
  });

  test("the real SDK credential chain in the test process finds no credentials", async () => {
    expect(await stsCallerIdentity().resolve({ source: "chain" }, "us-east-1")).toEqual({
      kind: "no_credentials",
    });
  });

  test("a spawned doctor in the isolated environment sends nothing to IMDS or AWS", async () => {
    const { endpoint, requests } = startTrap();
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      ...isolatedAwsEnvironment(scratch),
      AWS_EC2_METADATA_SERVICE_ENDPOINT: endpoint,
      AWS_ENDPOINT_URL: endpoint,
    };
    const result = await spawnCli(["doctor", "--json", "--instance", EXAMPLE], {
      cwd: scratch,
      env,
    });
    expect(doctorCheck(result.stdout, "aws_account")).toMatchObject({
      status: "not_ready",
      summary: "No AWS credentials found",
    });
    expect(requests).toEqual([]);
  });

  test("the metadata endpoint override catches IMDS traffic even without the disable switch", async () => {
    const { endpoint, requests } = startTrap();
    const { AWS_EC2_METADATA_DISABLED: _, ...enabled } = isolatedAwsEnvironment(scratch);
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      ...enabled,
      AWS_EC2_METADATA_SERVICE_ENDPOINT: endpoint,
    };
    const result = await spawnCli(["doctor", "--json", "--instance", EXAMPLE], {
      cwd: scratch,
      env,
    });
    expect(doctorCheck(result.stdout, "aws_account").status).not.toBe("ready");
    expect(requests.length).toBeGreaterThan(0);
  });
});
