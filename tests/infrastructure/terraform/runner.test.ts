import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialSelection } from "../../../src/domain/aws-account";
import type { ProcessOptions, ProcessRunner } from "../../../src/infrastructure/local-tool-probe";
import {
  TERRAFORM_STOP_GRACE_MS,
  type TerraformSession,
  terraformEnvironment,
  terraformRunner,
} from "../../../src/infrastructure/terraform/runner";
import { type FakeTerraform, fakeTerraform } from "../../support/fake-terraform";

let scratch: string;
let terraform: FakeTerraform;
let session: TerraformSession;

/** The operator's environment as fffactory received it, with AWS's documentation keys. */
const OPERATOR = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/operator",
  LANG: "en_US.UTF-8",
  HTTPS_PROXY: "http://proxy.internal:3128",
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_SESSION_TOKEN: "session-token-example",
  AWS_CONFIG_FILE: "/home/operator/.aws/config",
  AWS_SHARED_CREDENTIALS_FILE: "/home/operator/.aws/credentials",
  AWS_PROFILE: "operator-default",
  AWS_DEFAULT_PROFILE: "legacy-default",
  AWS_REGION: "eu-west-1",
  AWS_DEFAULT_REGION: "eu-west-1",
  AWS_CA_BUNDLE: "/etc/ssl/corporate.pem",
  TF_LOG: "TRACE",
  TF_CLI_CONFIG_FILE: "/home/operator/.terraformrc",
  TF_PLUGIN_CACHE_DIR: "/home/operator/.terraform.d/plugin-cache",
  TF_VAR_secret: "should-not-pass",
  SECRET_TOKEN: "unrelated-secret",
};

const PROFILE: CredentialSelection = { source: "--profile", profile: "factory-admin" };
const CHAIN: CredentialSelection = { source: "chain" };

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "fffactory-terraform-runner-")));
  await mkdir(join(scratch, "bin"));
  await mkdir(join(scratch, "work"));
  terraform = await fakeTerraform(join(scratch, "bin"));
  session = {
    executable: terraform.executable,
    workingDirectory: join(scratch, "work"),
    dataDirectory: join(scratch, "data"),
    pluginCache: join(scratch, "plugins"),
    cliConfigFile: join(scratch, "terraformrc"),
    credentials: PROFILE,
    region: "us-west-2",
  };
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("terraformEnvironment", () => {
  const TERRAFORM = {
    TF_DATA_DIR: "/cache/terraform/operations/op-1/data",
    TF_PLUGIN_CACHE_DIR: "/cache/terraform/plugins",
    TF_CLI_CONFIG_FILE: "/cache/terraform/operations/op-1/terraformrc",
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    CHECKPOINT_DISABLE: "1",
  };
  const paths = {
    dataDirectory: TERRAFORM.TF_DATA_DIR,
    pluginCache: TERRAFORM.TF_PLUGIN_CACHE_DIR,
    cliConfigFile: TERRAFORM.TF_CLI_CONFIG_FILE,
    region: "us-west-2",
  };

  test("a selected profile is passed alone: no environment keys and no instance metadata", () => {
    expect(terraformEnvironment(OPERATOR, { ...paths, credentials: PROFILE })).toEqual({
      PATH: OPERATOR.PATH,
      HOME: OPERATOR.HOME,
      LANG: OPERATOR.LANG,
      HTTPS_PROXY: OPERATOR.HTTPS_PROXY,
      AWS_CONFIG_FILE: OPERATOR.AWS_CONFIG_FILE,
      AWS_SHARED_CREDENTIALS_FILE: OPERATOR.AWS_SHARED_CREDENTIALS_FILE,
      AWS_CA_BUNDLE: OPERATOR.AWS_CA_BUNDLE,
      AWS_PROFILE: "factory-admin",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_REGION: "us-west-2",
      AWS_DEFAULT_REGION: "us-west-2",
      ...TERRAFORM,
    });
  });

  test("the standard chain passes the operator's AWS environment, but no profile", () => {
    const chain = { ...OPERATOR, AWS_PROFILE: "" };
    expect(terraformEnvironment(chain, { ...paths, credentials: CHAIN })).toEqual({
      PATH: OPERATOR.PATH,
      HOME: OPERATOR.HOME,
      LANG: OPERATOR.LANG,
      HTTPS_PROXY: OPERATOR.HTTPS_PROXY,
      AWS_ACCESS_KEY_ID: OPERATOR.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: OPERATOR.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: OPERATOR.AWS_SESSION_TOKEN,
      AWS_CONFIG_FILE: OPERATOR.AWS_CONFIG_FILE,
      AWS_SHARED_CREDENTIALS_FILE: OPERATOR.AWS_SHARED_CREDENTIALS_FILE,
      AWS_CA_BUNDLE: OPERATOR.AWS_CA_BUNDLE,
      AWS_REGION: "us-west-2",
      AWS_DEFAULT_REGION: "us-west-2",
      ...TERRAFORM,
    });
  });

  test("variables the operator did not set stay unset", () => {
    const environment = terraformEnvironment({}, { ...paths, credentials: CHAIN });
    expect(Object.keys(environment).sort()).toEqual(
      [...Object.keys(TERRAFORM), "AWS_REGION", "AWS_DEFAULT_REGION"].sort(),
    );
  });
});

describe("terraformRunner", () => {
  test("runs the managed executable in the working directory with its own environment", async () => {
    const run = terraformRunner(OPERATOR);
    const result = await run(session, ["validate", "-no-color"], { timeoutMs: 10_000 });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const [invocation] = await terraform.invocations();
    expect(invocation?.args).toEqual(["validate", "-no-color"]);
    expect(invocation?.cwd).toBe(session.workingDirectory);
    expect(invocation?.env).toEqual(
      terraformEnvironment(OPERATOR, {
        dataDirectory: session.dataDirectory,
        pluginCache: session.pluginCache,
        cliConfigFile: session.cliConfigFile,
        credentials: PROFILE,
        region: "us-west-2",
      }),
    );
    expect(invocation?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(invocation?.env.TF_LOG).toBeUndefined();
  });

  test("accepts the exit codes it is told to", async () => {
    await terraform.behave({ plan: { exitCode: 2, stdout: "changes" } });
    const run = terraformRunner(OPERATOR);
    const result = await run(session, ["plan"], { timeoutMs: 10_000, exitCodes: [0, 2] });
    expect(result).toEqual({ exitCode: 2, stdout: "changes", stderr: "" });
  });

  test("any other exit rejects with the exit code, keeping diagnostics out of the message", async () => {
    await terraform.behave({ apply: { exitCode: 1, stderr: "Error: AccessDenied\n" } });
    const run = terraformRunner(OPERATOR);
    const failed = run(session, ["apply", "-input=false", "plan.tfplan"], { timeoutMs: 10_000 });
    await expect(failed).rejects.toMatchObject({
      name: "TerraformFailed",
      message: "`terraform apply` exited with status 1",
      subcommand: "apply",
      exitCode: 1,
      diagnostics: "Error: AccessDenied\n",
    });
  });

  test("at its deadline Terraform is interrupted first, so it can save state and release its lock", async () => {
    await terraform.behave({ apply: { sleepMs: 30_000 } });
    const run = terraformRunner(OPERATOR);
    const started = Date.now();
    await expect(run(session, ["apply"], { timeoutMs: 1000 })).rejects.toThrow(
      "`terraform apply` did not finish within 1 s",
    );
    // It stopped on SIGINT, well within the grace period.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await terraform.signals()).toEqual([{ subcommand: "apply", signal: "SIGINT" }]);
  });

  test("Terraform is stopped with SIGINT and a grace period before it is killed", async () => {
    const seen: (ProcessOptions | undefined)[] = [];
    const spy: ProcessRunner = async (_argv, _timeoutMs, options) => {
      seen.push(options);
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    await terraformRunner(OPERATOR, spy)(session, ["apply"], { timeoutMs: 1000 });
    expect(seen.map((options) => options?.stop)).toEqual([
      { signal: "SIGINT", graceMs: TERRAFORM_STOP_GRACE_MS },
    ]);
    expect(TERRAFORM_STOP_GRACE_MS).toBe(2 * 60 * 1000);
  });

  test("a missing executable rejects without looking on PATH", async () => {
    const run = terraformRunner(OPERATOR);
    const missing = { ...session, executable: join(scratch, "missing", "terraform") };
    await expect(run(missing, ["version"], { timeoutMs: 1000 })).rejects.toThrow(
      `The managed Terraform ${missing.executable} is missing`,
    );
  });

  test("an executable that cannot be started rejects with its error code", async () => {
    const answer: ProcessRunner = async () => ({ kind: "not_started", code: "EACCES" });
    const run = terraformRunner(OPERATOR, answer);
    await expect(run(session, ["init"], { timeoutMs: 1000 })).rejects.toThrow(
      `The managed Terraform ${session.executable} could not be started (EACCES)`,
    );
  });
});
