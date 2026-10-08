/**
 * Provisioner over managed Terraform. Every call is one operation in a fresh directory
 * under `<cache>/terraform/operations`, created with `mkdtemp` so no two operations can
 * share it, and removed when the call settles:
 *
 *   configuration/      a copy of the shipped Terraform tree; Terraform runs in its root module
 *   data/               TF_DATA_DIR, created by `terraform init`
 *   terraformrc         TF_CLI_CONFIG_FILE, so no operator CLI configuration applies
 *   inputs.tfvars.json  the plan's input variables
 *   backend.tfbackend   the backend settings, when there are any
 *
 * `terraform init` installs providers from the shared provider cache, checked against the
 * shipped lockfile, which it may not change. An operation directory an interrupted fffactory
 * left behind is removed by a later operation once it is older than any operation runs.
 *
 * A Terraform command that fails keeps its standard error in a private file under
 * `<cache>/terraform/diagnostics`, which the failure names (`ProvisioningFailed`); later
 * operations remove those older than `DIAGNOSTICS_KEPT_MS`.
 */
import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { managedTerraformPaths } from "../../application/managed-terraform";
import {
  type PlanRequest,
  ProvisioningFailed,
  type Provisioner,
  type ProvisioningTarget,
  type SavedPlanRequest,
} from "../../application/provisioner";
import { SUPPORTED_TERRAFORM } from "../../domain/managed-terraform";
import { bundlePathProblem } from "../../domain/release-assets";
import type { ManagedTerraform } from "./installer";
import { TerraformFailed, type TerraformRunner, type TerraformSession } from "./runner";

export const LOCKFILE = ".terraform.lock.hcl";

/** Deadlines per command: provider downloads, planning and applying can each take a while. */
export const TIMEOUTS_MS = {
  init: 10 * 60 * 1000,
  plan: 30 * 60 * 1000,
  apply: 60 * 60 * 1000,
  read: 5 * 60 * 1000,
} as const;

/**
 * Older than any operation runs (init, plan or apply, and a stop's grace period, are well under
 * two hours), so an operation directory this old was left by an fffactory that was killed or
 * interrupted before it could remove it, and is removed by the next operation.
 */
export const STALE_OPERATION_MS = 3 * 60 * 60 * 1000;

const OPERATION_PREFIX = "operation-";

/**
 * How long a failed Terraform command's diagnostics are kept: long enough to read after the
 * failure, and no longer, since they may quote configuration. Each operation removes older ones.
 */
export const DIAGNOSTICS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

const DIAGNOSTICS_SUFFIX = ".log";

/**
 * Replaces the operator's CLI configuration. An explicit `direct` installation method stops
 * Terraform using the implied local mirror directories under HOME; the provider cache
 * (`TF_PLUGIN_CACHE_DIR`) still applies.
 */
export const CLI_CONFIGURATION =
  "# Written by FFFactory: no operator Terraform CLI configuration applies.\n" +
  "provider_installation {\n  direct {}\n}\n";

/** An HCL identifier, as a backend setting name must be. */
const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface TerraformProvisionerOptions {
  /** Absolute path of the FFFactory cache directory. */
  readonly cacheDirectory: string;
  readonly terraform: Pick<ManagedTerraform, "install">;
  readonly run: TerraformRunner;
}

/** One operation's session and directory. */
interface Operation {
  readonly session: TerraformSession;
  readonly directory: string;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

function requireAbsolute(planFile: string): void {
  if (!isAbsolute(planFile)) throw new Error("The plan file must be an absolute path");
}

/** Refuses a backend setting name that is not an HCL identifier, without echoing it. */
function requireSettingNames(backend: Readonly<Record<string, string>>): void {
  if (!Object.keys(backend).every((name) => SETTING_NAME.test(name)))
    throw new Error("A backend setting name is not a valid Terraform attribute name");
}

const HCL_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * A quoted HCL string that is always literal: quotes, backslashes and control characters
 * escaped, and template sequences (`${`, `%{`) doubled so Terraform never interprets them.
 */
function hclString(value: string): string {
  const escaped = value
    .replace(
      /["\\]|\p{Cc}/gu,
      (char) => HCL_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .replace(/([$%])\{/g, "$1$1{");
  return `"${escaped}"`;
}

/** `backend.tfbackend`: one HCL string attribute per setting, in name order. */
function backendFile(backend: Readonly<Record<string, string>>): string {
  return Object.entries(backend)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name} = ${hclString(value)}\n`)
    .join("");
}

async function initArguments(
  directory: string,
  backend: Readonly<Record<string, string>>,
): Promise<string[]> {
  const args = ["init", "-input=false", "-no-color", "-lockfile=readonly"];
  if (Object.keys(backend).length === 0) return args;
  const file = join(directory, "backend.tfbackend");
  await writeFile(file, backendFile(backend), { mode: 0o600 });
  return [...args, `-backend-config=${file}`];
}

function parseJson(text: string, command: string, expected: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`\`${command}\` printed output that is not ${expected}`);
  }
}

/** `terraform output -json` is a map from output name to `{ value, type, sensitive }`. */
function outputValues(stdout: string): Readonly<Record<string, unknown>> {
  const command = "terraform output -json";
  const expected = "a map of outputs";
  const outputs = parseJson(stdout, command, expected);
  if (typeof outputs !== "object" || outputs === null || Array.isArray(outputs))
    throw new Error(`\`${command}\` printed output that is not ${expected}`);
  return Object.fromEntries(
    Object.entries(outputs).map(([name, output]) => {
      if (typeof output !== "object" || output === null || !Object.hasOwn(output, "value"))
        throw new Error(`\`${command}\` printed output that is not ${expected}`);
      return [name, (output as { value: unknown }).value];
    }),
  );
}

/**
 * Removes the entries of `directory` that `matches` and were last changed over `ageMs` ago.
 * A directory that does not exist yet has none.
 */
async function removeOlderThan(
  directory: string,
  matches: (name: string) => boolean,
  ageMs: number,
): Promise<void> {
  const cutoff = Date.now() - ageMs;
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of names.filter(matches)) {
    const path = join(directory, name);
    const info = await lstat(path).catch(() => undefined);
    if (info !== undefined && info.mtimeMs < cutoff)
      await rm(path, { recursive: true, force: true });
  }
}

/** `20260930T120000Z`: a UTC time for a file name, so names sort by time. */
function fileTime(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * A failure to report: a failed Terraform command's standard error goes to a new private file
 * in `diagnostics` (directory 0700, file 0600), named for when, the subcommand and the
 * operation, and the failure names the file. Any other failure, or one whose diagnostics
 * cannot be written, is reported as it is.
 */
async function keepDiagnostics(
  error: unknown,
  diagnostics: string,
  operation: string,
): Promise<unknown> {
  if (!(error instanceof TerraformFailed)) return error;
  const suffix = basename(operation).slice(OPERATION_PREFIX.length);
  const file = join(
    diagnostics,
    `${fileTime(new Date())}-${error.subcommand}-${suffix}${DIAGNOSTICS_SUFFIX}`,
  );
  try {
    await mkdir(diagnostics, { recursive: true, mode: 0o700 });
    await writeFile(file, error.diagnostics, { mode: 0o600, flag: "wx" });
  } catch {
    return error;
  }
  return new ProvisioningFailed(error.message, file);
}

/** Provisioner that runs the managed Terraform, installing it on first use. */
export function terraformProvisioner({
  cacheDirectory,
  terraform,
  run,
}: TerraformProvisionerOptions): Provisioner {
  const paths = managedTerraformPaths(cacheDirectory, SUPPORTED_TERRAFORM.version);

  async function prepare(target: ProvisioningTarget, directory: string): Promise<Operation> {
    const { configuration } = target;
    const executable = await terraform.install(cacheDirectory);
    const copy = join(directory, "configuration");
    await cp(configuration.directory, copy, { recursive: true, errorOnExist: true });
    const workingDirectory = join(copy, configuration.root);
    if (!(await isFile(join(workingDirectory, LOCKFILE))))
      throw new Error(
        `The Terraform root module ${configuration.root} has no provider lockfile (${LOCKFILE})`,
      );
    const cliConfigFile = join(directory, "terraformrc");
    await writeFile(cliConfigFile, CLI_CONFIGURATION, { mode: 0o600 });
    const session: TerraformSession = {
      executable,
      workingDirectory,
      dataDirectory: join(directory, "data"),
      pluginCache: paths.pluginCache,
      cliConfigFile,
      credentials: target.credentials,
      region: target.region,
    };
    await run(session, await initArguments(directory, target.backend), {
      timeoutMs: TIMEOUTS_MS.init,
    });
    return { session, directory };
  }

  // TODO(re-evaluate when two operations can run at once on one workstation, such as
  // two factories): Terraform does not promise a concurrency-safe provider cache.
  /** Runs `work` in a fresh, initialized operation, and removes the operation after. */
  async function operation<T>(
    target: ProvisioningTarget,
    work: (operation: Operation) => Promise<T>,
  ): Promise<T> {
    const problem = bundlePathProblem(target.configuration.root);
    if (problem)
      throw new Error(`The Terraform root module path "${target.configuration.root}" ${problem}`);
    requireSettingNames(target.backend);
    await mkdir(paths.pluginCache, { recursive: true, mode: 0o700 });
    await mkdir(paths.operations, { recursive: true, mode: 0o700 });
    // An interrupted or killed fffactory leaves its operation directory; a running
    // operation's is recent and stays.
    const isOperation = (name: string) => name.startsWith(OPERATION_PREFIX);
    await removeOlderThan(paths.operations, isOperation, STALE_OPERATION_MS);
    // Housekeeping of diagnostics never blocks an operation.
    const isDiagnostics = (name: string) => name.endsWith(DIAGNOSTICS_SUFFIX);
    await removeOlderThan(paths.diagnostics, isDiagnostics, DIAGNOSTICS_KEPT_MS).catch(
      () => undefined,
    );
    const directory = await mkdtemp(join(paths.operations, OPERATION_PREFIX));
    try {
      return await work(await prepare(target, directory));
    } catch (error) {
      throw await keepDiagnostics(error, paths.diagnostics, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return {
    async plan(request: PlanRequest) {
      requireAbsolute(request.planFile);
      return operation(request, async ({ session, directory }) => {
        const inputs = join(directory, "inputs.tfvars.json");
        await writeFile(inputs, JSON.stringify(request.variables), { mode: 0o600 });
        const args = ["plan", "-input=false", "-no-color", "-detailed-exitcode"];
        if (request.stateLock === false) args.push("-lock=false");
        const { exitCode } = await run(
          session,
          [...args, `-var-file=${inputs}`, `-out=${request.planFile}`],
          { timeoutMs: TIMEOUTS_MS.plan, exitCodes: [0, 2] },
        );
        return { changes: exitCode === 2 };
      });
    },

    async showPlan(request: SavedPlanRequest) {
      requireAbsolute(request.planFile);
      return operation(request, async ({ session }) => {
        const { stdout } = await run(session, ["show", "-json", "-no-color", request.planFile], {
          timeoutMs: TIMEOUTS_MS.read,
        });
        return parseJson(stdout, "terraform show -json", "JSON");
      });
    },

    async applyPlan(request: SavedPlanRequest) {
      requireAbsolute(request.planFile);
      await operation(request, async ({ session }) => {
        await run(session, ["apply", "-input=false", "-no-color", request.planFile], {
          timeoutMs: TIMEOUTS_MS.apply,
        });
      });
    },

    async output(request: ProvisioningTarget) {
      return operation(request, async ({ session }) => {
        const { stdout } = await run(session, ["output", "-json", "-no-color"], {
          timeoutMs: TIMEOUTS_MS.read,
        });
        return outputValues(stdout);
      });
    },
  };
}
