import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { managedTerraformPaths } from "../../../src/application/managed-terraform";
import {
  diagnosticsFileOf,
  ProvisioningFailed,
  type ProvisioningTarget,
} from "../../../src/application/provisioner";
import { SUPPORTED_TERRAFORM } from "../../../src/domain/managed-terraform";
import {
  DIAGNOSTICS_KEPT_MS,
  STALE_OPERATION_MS,
  terraformProvisioner,
} from "../../../src/infrastructure/terraform/provisioner";
import {
  type TerraformSession,
  terraformRunner,
} from "../../../src/infrastructure/terraform/runner";
import {
  FAKE_OUTPUTS,
  FAKE_PLAN_JSON,
  type FakeTerraform,
  fakeTerraform,
  type Invocation,
} from "../../support/fake-terraform";

let scratch: string;
let cache: string;
let assets: string;
let decoyMarker: string;
let terraform: FakeTerraform;
let installs: string[];

const LOCKFILE = '# This file is maintained automatically by "terraform init".\n';
const MAIN_TF = 'module "network" {\n  source = "../modules/network"\n}\n';

/** The operator's environment: a PATH whose only `terraform` is a decoy that must never run. */
function operator(): { PATH: string; HOME: string } {
  return { PATH: join(scratch, "path"), HOME: join(scratch, "home") };
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "fffactory-provisioner-")));
  assets = join(scratch, "assets", "terraform");
  await mkdir(join(assets, "factory"), { recursive: true });
  await mkdir(join(assets, "modules", "network"), { recursive: true });
  await mkdir(join(assets, "unlocked"), { recursive: true });
  await writeFile(join(assets, "factory", "main.tf"), MAIN_TF);
  await writeFile(join(assets, "factory", ".terraform.lock.hcl"), LOCKFILE);
  await writeFile(join(assets, "modules", "network", "main.tf"), "");
  await writeFile(join(assets, "unlocked", "main.tf"), "");
  await mkdir(join(scratch, "path"));
  decoyMarker = join(scratch, "decoy-ran");
  await writeFile(join(scratch, "path", "terraform"), `#!/bin/sh\ntouch '${decoyMarker}'\n`);
  await chmod(join(scratch, "path", "terraform"), 0o755);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  cache = await mkdtemp(join(scratch, "cache-"));
  const bin = await mkdtemp(join(scratch, "bin-"));
  terraform = await fakeTerraform(bin);
  installs = [];
});

function provisioner() {
  return terraformProvisioner({
    cacheDirectory: cache,
    terraform: {
      install: async (cacheDirectory) => {
        installs.push(cacheDirectory);
        return terraform.executable;
      },
    },
    run: terraformRunner(operator()),
  });
}

/**
 * A provisioner whose runner calls `inspect` before each Terraform command, while the
 * operation directory still exists, then runs the stand-in.
 */
function inspecting(
  inspect: (session: TerraformSession, args: readonly string[]) => Promise<void>,
) {
  const original = terraformRunner(operator());
  return terraformProvisioner({
    cacheDirectory: cache,
    terraform: { install: async () => terraform.executable },
    run: async (session, args, options) => {
      await inspect(session, args);
      return original(session, args, options);
    },
  });
}

/** A file's text and permission bits. */
async function privateFile(path: string) {
  return { text: await readFile(path, "utf8"), mode: (await stat(path)).mode & 0o777 };
}

/** The file an argument such as `-var-file=<file>` names, if `args` has it. */
function argumentFile(args: readonly string[], prefix: string): string | undefined {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const paths = () => managedTerraformPaths(cache, SUPPORTED_TERRAFORM.version);

function target(overrides: Partial<ProvisioningTarget> = {}): ProvisioningTarget {
  return {
    configuration: { directory: assets, root: "factory" },
    credentials: { source: "--profile", profile: "factory-admin" },
    region: "us-west-2",
    backend: {},
    ...overrides,
  };
}

function planRequest(overrides: Partial<ProvisioningTarget> = {}) {
  return {
    ...target(overrides),
    variables: { factory_id: "fff-abcd1234", hosts: { alpha: { size: "t3.large" } } },
    planFile: join(cache, "plan.tfplan"),
  };
}

/** The operation directory an invocation ran in: `<operations>/<name>`. */
function operationOf(invocation: Invocation | undefined): string {
  const data = invocation?.env.TF_DATA_DIR ?? "";
  expect(data.startsWith(`${paths().operations}/`)).toBe(true);
  return data.slice(0, data.lastIndexOf("/"));
}

describe("terraformProvisioner plan", () => {
  test("initializes a private copy with the shipped lockfile, then saves a plan", async () => {
    const request = planRequest();
    expect(await provisioner().plan(request)).toEqual({ changes: true });
    expect(installs).toEqual([cache]);
    const [init, plan] = await terraform.invocations();
    const operation = operationOf(init);
    const workingDirectory = join(operation, "configuration", "factory");
    expect(init).toMatchObject({
      args: ["init", "-input=false", "-no-color", "-lockfile=readonly"],
      cwd: workingDirectory,
      dataDirectoryBefore: null,
      lockfile: true,
    });
    expect(plan).toMatchObject({
      args: [
        "plan",
        "-input=false",
        "-no-color",
        "-detailed-exitcode",
        `-var-file=${join(operation, "inputs.tfvars.json")}`,
        `-out=${request.planFile}`,
      ],
      cwd: workingDirectory,
      dataDirectoryBefore: ["initialized"],
    });
    expect(await readFile(request.planFile, "utf8")).toBe("saved plan\n");
  });

  test("a plan made outside the factory lock takes no Terraform state lock", async () => {
    await provisioner().plan({ ...planRequest(), stateLock: false });
    const [, plan] = await terraform.invocations();
    expect(plan?.args.slice(0, 5)).toEqual([
      "plan",
      "-input=false",
      "-no-color",
      "-detailed-exitcode",
      "-lock=false",
    ]);
    await provisioner().plan({ ...planRequest(), stateLock: true });
    const [, , , locking] = await terraform.invocations();
    expect(locking?.args[0]).toBe("plan");
    expect(locking?.args.some((arg) => arg.startsWith("-lock"))).toBe(false);
  });

  test("passes the credential selection, factory Region and operation settings to Terraform", async () => {
    await provisioner().plan(planRequest());
    const [init] = await terraform.invocations();
    const operation = operationOf(init);
    expect(init?.env).toEqual({
      PATH: operator().PATH,
      HOME: operator().HOME,
      AWS_PROFILE: "factory-admin",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_REGION: "us-west-2",
      AWS_DEFAULT_REGION: "us-west-2",
      TF_DATA_DIR: join(operation, "data"),
      TF_PLUGIN_CACHE_DIR: paths().pluginCache,
      TF_CLI_CONFIG_FILE: join(operation, "terraformrc"),
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      CHECKPOINT_DISABLE: "1",
    });
  });

  test("never runs a Terraform found on PATH", async () => {
    await provisioner().plan(planRequest());
    expect(await Bun.file(decoyMarker).exists()).toBe(false);
  });

  test("a plan without changes says so", async () => {
    await terraform.behave({ plan: { exitCode: 0 } });
    expect(await provisioner().plan(planRequest())).toEqual({ changes: false });
  });

  test("the input variables reach Terraform only through the operation's private file", async () => {
    const request = planRequest();
    const seen: { text: string; mode: number }[] = [];
    await inspecting(async (_, args) => {
      const file = argumentFile(args, "-var-file=");
      if (file) seen.push(await privateFile(file));
    }).plan(request);
    expect(seen.map(({ text, mode }) => ({ variables: JSON.parse(text), mode }))).toEqual([
      { variables: request.variables, mode: 0o600 },
    ]);
  });

  test("Terraform's CLI configuration is private and installs providers only directly", async () => {
    const seen: { text: string; mode: number }[] = [];
    await inspecting(async (session) => {
      seen.push(await privateFile(session.cliConfigFile));
    }).plan(planRequest());
    const expected = {
      text:
        "# Written by FFFactory: no operator Terraform CLI configuration applies.\n" +
        "provider_installation {\n  direct {}\n}\n",
      mode: 0o600,
    };
    expect(seen).toEqual([expected, expected]);
  });

  test("leaves the shipped configuration unchanged and removes the operation directory", async () => {
    await provisioner().plan(planRequest());
    expect((await readdir(assets, { recursive: true })).sort()).toEqual([
      "factory",
      "factory/.terraform.lock.hcl",
      "factory/main.tf",
      "modules",
      "modules/network",
      "modules/network/main.tf",
      "unlocked",
      "unlocked/main.tf",
    ]);
    expect(await readdir(paths().operations)).toEqual([]);
  });

  test("copies sibling modules, so relative module sources resolve", async () => {
    await terraform.behave({ plan: { exitCode: 2 } });
    let copied: string[] = [];
    await inspecting(async (session) => {
      copied = await readdir(join(session.workingDirectory, ".."), { recursive: true });
    }).plan(planRequest());
    expect(copied).toContain("modules/network/main.tf");
  });

  test("passes backend settings in a private file, not as arguments", async () => {
    const seen: { text: string; mode: number }[] = [];
    const provisioning = inspecting(async (_, args) => {
      const file = argumentFile(args, "-backend-config=");
      if (file) seen.push(await privateFile(file));
    });
    await provisioning.plan(
      planRequest({ backend: { region: "us-west-2", bucket: "fff-abcd1234-state" } }),
    );
    const [init] = await terraform.invocations();
    const file = join(operationOf(init), "backend.tfbackend");
    expect(init?.args).toEqual([
      "init",
      "-input=false",
      "-no-color",
      "-lockfile=readonly",
      `-backend-config=${file}`,
    ]);
    expect(init?.args.join(" ")).not.toContain("fff-abcd1234-state");
    expect(seen).toEqual([
      { text: 'bucket = "fff-abcd1234-state"\nregion = "us-west-2"\n', mode: 0o600 },
    ]);
  });

  test("backend values are written as literal HCL strings, never templates", async () => {
    const seen: string[] = [];
    const provisioning = inspecting(async (_, args) => {
      const file = argumentFile(args, "-backend-config=");
      if (file) seen.push(await readFile(file, "utf8"));
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL template sequences, deliberately
    const key = 'a"b\\c ${var.x} %{if y}$${z}\n\t\b';
    await provisioning.plan(planRequest({ backend: { key } }));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: escaped HCL template sequences
    expect(seen).toEqual(['key = "a\\"b\\\\c $${var.x} %%{if y}$$${z}\\n\\t\\u0008"\n']);
  });

  test.each(["", "1bucket", "bad name", "a=b", 'x = "y"\nbucket', "dynamodb.table"])(
    "a backend setting name that is not an HCL identifier (%p) is refused before Terraform runs",
    async (name) => {
      const request = planRequest({ backend: { bucket: "fff-abcd1234-state", [name]: "v" } });
      const refused = provisioner().plan(request);
      await expect(refused).rejects.toThrow(
        "A backend setting name is not a valid Terraform attribute name",
      );
      await refused.catch((error: Error) => expect(error.message).not.toContain(name || "\0"));
      expect(await terraform.invocations()).toEqual([]);
    },
  );

  test("a root module without the shipped lockfile is refused before Terraform runs", async () => {
    const request = planRequest({ configuration: { directory: assets, root: "unlocked" } });
    await expect(provisioner().plan(request)).rejects.toThrow(
      "The Terraform root module unlocked has no provider lockfile (.terraform.lock.hcl)",
    );
    expect(await terraform.invocations()).toEqual([]);
    expect(await readdir(paths().operations)).toEqual([]);
  });

  test.each(["../outside", "/etc", ""])(
    "a root module outside the configuration (%p) is refused",
    async (root) => {
      const request = planRequest({ configuration: { directory: assets, root } });
      await expect(provisioner().plan(request)).rejects.toThrow("The Terraform root module path");
      expect(await terraform.invocations()).toEqual([]);
    },
  );

  test("a relative plan file is refused", async () => {
    const request = { ...planRequest(), planFile: "plan.tfplan" };
    await expect(provisioner().plan(request)).rejects.toThrow(
      "The plan file must be an absolute path",
    );
  });

  test("a Terraform failure rejects and still removes the operation directory", async () => {
    await terraform.behave({ plan: { exitCode: 1, stderr: "Error: Invalid provider\n" } });
    await expect(provisioner().plan(planRequest())).rejects.toMatchObject({
      name: "ProvisioningFailed",
      message: "`terraform plan` exited with status 1",
    });
    expect(await readdir(paths().operations)).toEqual([]);
  });

  test.each([
    ["plan", "plan"],
    ["init", "init"],
  ])(
    "a failing `terraform %s` keeps its standard error in a private file it names, never in the message",
    async (subcommand, expected) => {
      const stderr = "Error: Invalid provider\n  on main.tf line 1: secret-looking-value\n";
      await terraform.behave({ [subcommand]: { exitCode: 1, stderr } });
      const error = await provisioner()
        .plan(planRequest())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProvisioningFailed);
      const { message } = error as ProvisioningFailed;
      expect(message).toBe(`\`terraform ${expected}\` exited with status 1`);
      const file = diagnosticsFileOf(error);
      expect(file).toBeDefined();
      expect(dirname(file ?? "")).toBe(paths().diagnostics);
      expect(basename(file ?? "")).toMatch(new RegExp(`^\\d{8}T\\d{6}Z-${expected}-.+\\.log$`));
      expect(await privateFile(file ?? "")).toEqual({ text: stderr, mode: 0o600 });
      expect((await stat(paths().diagnostics)).mode & 0o777).toBe(0o700);
      expect(message).not.toContain("secret-looking-value");
    },
  );

  test("diagnostics that cannot be kept never block an operation or hide its failure", async () => {
    await mkdir(paths().root, { recursive: true });
    await writeFile(paths().diagnostics, "not a directory");
    expect(await provisioner().plan(planRequest())).toEqual({ changes: true });
    await terraform.behave({ plan: { exitCode: 1, stderr: "Error: Invalid provider\n" } });
    const error = await provisioner()
      .plan(planRequest())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "TerraformFailed",
      message: "`terraform plan` exited with status 1",
    });
    expect(diagnosticsFileOf(error)).toBeUndefined();
  });

  test("a failure that is not Terraform's exit status keeps no diagnostics", async () => {
    const request = { ...planRequest(), configuration: { directory: assets, root: "unlocked" } };
    const error = await provisioner()
      .plan(request)
      .catch((caught: unknown) => caught);
    expect(diagnosticsFileOf(error)).toBeUndefined();
    expect(await readdir(paths().diagnostics).catch(() => [])).toEqual([]);
  });
});

describe("terraformProvisioner operations", () => {
  test("removes operation directories an interrupted fffactory left, older than any operation", async () => {
    const operations = paths().operations;
    await mkdir(operations, { recursive: true });
    const old = new Date(Date.now() - STALE_OPERATION_MS - 60_000);
    for (const name of ["operation-left1", "operation-left2", "not-an-operation"]) {
      await mkdir(join(operations, name, "data"), { recursive: true });
      await utimes(join(operations, name), old, old);
    }
    await mkdir(join(operations, "operation-recent"));
    await provisioner().output(target());
    expect((await readdir(operations)).sort()).toEqual(["not-an-operation", "operation-recent"]);
    expect(STALE_OPERATION_MS).toBe(3 * 60 * 60 * 1000);
  });

  test("removes diagnostics files kept longer than DIAGNOSTICS_KEPT_MS", async () => {
    const diagnostics = paths().diagnostics;
    await mkdir(diagnostics, { recursive: true });
    const old = new Date(Date.now() - DIAGNOSTICS_KEPT_MS - 60_000);
    for (const name of ["20260901T000000Z-apply-old.log", "not-a-log"]) {
      await writeFile(join(diagnostics, name), "old\n");
      await utimes(join(diagnostics, name), old, old);
    }
    await writeFile(join(diagnostics, "20260930T000000Z-plan-recent.log"), "recent\n");
    await provisioner().output(target());
    expect((await readdir(diagnostics)).sort()).toEqual([
      "20260930T000000Z-plan-recent.log",
      "not-a-log",
    ]);
    expect(DIAGNOSTICS_KEPT_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("two operations never share a Terraform data directory", async () => {
    const provisioning = provisioner();
    await Promise.all([
      provisioning.plan(planRequest()),
      provisioning.plan({ ...planRequest(), planFile: join(cache, "other.tfplan") }),
    ]);
    const inits = (await terraform.invocations()).filter((run) => run.args[0] === "init");
    expect(inits).toHaveLength(2);
    const dataDirectories = inits.map((run) => run.env.TF_DATA_DIR);
    expect(new Set(dataDirectories).size).toBe(2);
    // Each started from nothing: no operation saw another's data directory.
    expect(inits.map((run) => run.dataDirectoryBefore)).toEqual([null, null]);
    expect(new Set(inits.map((run) => run.cwd)).size).toBe(2);
    expect(await readdir(paths().operations)).toEqual([]);
  });

  test("showPlan prints the saved plan as JSON in its own operation", async () => {
    const request = { ...target(), planFile: join(cache, "saved.tfplan") };
    expect(await provisioner().showPlan(request)).toEqual(FAKE_PLAN_JSON);
    const [init, show] = await terraform.invocations();
    expect(init?.args[0]).toBe("init");
    expect(show?.args).toEqual(["show", "-json", "-no-color", request.planFile]);
  });

  test("showPlan rejects output that is not JSON", async () => {
    await terraform.behave({ show: { stdout: "not json" } });
    const request = { ...target(), planFile: join(cache, "saved.tfplan") };
    await expect(provisioner().showPlan(request)).rejects.toThrow(
      "`terraform show -json` printed output that is not JSON",
    );
  });

  test("applyPlan applies exactly the saved plan, with no variables", async () => {
    const request = { ...target(), planFile: join(cache, "saved.tfplan") };
    await provisioner().applyPlan(request);
    const [init, apply] = await terraform.invocations();
    expect(init?.args[0]).toBe("init");
    expect(apply?.args).toEqual(["apply", "-input=false", "-no-color", request.planFile]);
  });

  test("output returns each output's value by name", async () => {
    expect(await provisioner().output(target())).toEqual({ vpc_id: FAKE_OUTPUTS.vpc_id.value });
    const [, output] = await terraform.invocations();
    expect(output?.args).toEqual(["output", "-json", "-no-color"]);
  });

  test.each(["not json", "[]", '{"vpc_id": "no value field"}'])(
    "output rejects output it cannot read: %p",
    async (stdout) => {
      await terraform.behave({ output: { stdout } });
      await expect(provisioner().output(target())).rejects.toThrow(
        "`terraform output -json` printed output that is not a map of outputs",
      );
    },
  );
});
