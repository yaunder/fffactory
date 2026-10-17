/**
 * The `credentials` install step (`docs/specs/credential-delivery.md`): for each account the
 * host projection delivers, read its secret by ARN with the instance role and write it into the
 * tool's own store, the material only ever on a command's standard input. GitHub and OpenAI log
 * in as `factory`; Anthropic gets `factory`'s key file and Claude Code's root-owned helper. An
 * account not delivered keeps its tool's store, except fffactory's own: the key file, and Claude
 * Code's managed settings while they name fffactory's helper. Runs only inside locked `host
 * apply`. No tool's output is kept: the step's log and every failure carry fffactory's words only.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostCredentials } from "../domain/host-projection";
import {
  ANTHROPIC_KEY_FILE,
  CLAUDE_MANAGED_SETTINGS,
  CLAUDE_MANAGED_SETTINGS_JSON,
  CREDENTIAL_COMMAND_TIMEOUT_MS,
  CREDENTIAL_LOGIN_TIMEOUT_MS,
  namesKeyHelper,
} from "../domain/installation";
import { CREDENTIAL_SECRET_FIELDS, type SecretReference } from "../domain/instance";
import { ENROLLMENTS, type EnrollmentId, RUNTIME_ACCOUNT } from "../domain/readiness";
import { SecretMaterial } from "../domain/secrets";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { WorkerSystem } from "./inspect";
import { AS_FACTORY } from "./runtime-account";

const FACTORY_HOME = `/home/${RUNTIME_ACCOUNT}`;
const ROOT_ENV = {
  PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
};
/** The AWS CLI as root: the instance role, no pager. */
const AWS_ENV = { ...ROOT_ENV, AWS_PAGER: "" };
const GITHUB = ["--hostname", "github.com"] as const;
/**
 * A GitHub login, as gh lists it: letters, digits, `-` and `_` (an Enterprise Managed User's is
 * `handle_shortcode`), starting with a letter or digit so it never reads as an option. Anything
 * else is never passed to `gh auth logout`.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const AWS_ERROR = /An error occurred \(([A-Za-z][A-Za-z0-9.]{0,63})\)/;
const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

/** Why the step failed, for one account, in fffactory's own words. */
class Refused extends Error {
  constructor(
    readonly account: EnrollmentId,
    readonly reason: string,
  ) {
    super(`${account}: ${reason}`);
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unexpected error";
}

/** How a command that did not succeed ended, as `<what> ...`; undefined when it succeeded. */
function ended(what: string, outcome: ProcessOutcome): string | undefined {
  switch (outcome.kind) {
    case "exited":
      return outcome.exitCode === 0 ? undefined : `${what} exited with status ${outcome.exitCode}`;
    case "timed_out":
      return `${what} timed out`;
    case "not_found":
      return `${what} could not be started (ENOENT)`;
    case "not_started":
      return `${what} could not be started (${ERROR_CODE.test(outcome.code) ? outcome.code : "unexpected error"})`;
  }
}

/** Runs commands within the step's budget, each also within its own deadline. */
function commands(system: WorkerSystem, budgetMs: number) {
  const end = performance.now() + budgetMs;
  const cwd = join(system.root, FACTORY_HOME);
  async function run(
    argv: readonly string[],
    deadlineMs: number,
    options: { asFactory?: boolean; stdin?: SecretMaterial } = {},
  ): Promise<ProcessOutcome> {
    const remaining = Math.min(deadlineMs, Math.floor(end - performance.now()));
    if (remaining <= 0) return { kind: "timed_out" };
    const asFactory = options.asFactory !== false;
    return system.run(asFactory ? [...AS_FACTORY, ...argv] : argv, remaining, {
      ...(asFactory ? { cwd, env: {} } : { env: AWS_ENV }),
      ...(options.stdin === undefined
        ? {}
        : { stdin: new TextEncoder().encode(options.stdin.reveal()) }),
    });
  }
  /** Runs a command as `factory` that must succeed, or fails the step for `account`. */
  async function must(
    account: EnrollmentId,
    what: string,
    argv: readonly string[],
    deadlineMs = CREDENTIAL_COMMAND_TIMEOUT_MS,
    stdin?: SecretMaterial,
  ): Promise<Extract<ProcessOutcome, { kind: "exited" }>> {
    const outcome = await run(argv, deadlineMs, { stdin });
    const failure = ended(what, outcome);
    if (failure !== undefined || outcome.kind !== "exited")
      throw new Refused(account, failure ?? what);
    return outcome;
  }
  return { run, must };
}

type Commands = ReturnType<typeof commands>;

/** Why reading a secret failed: the AWS error's name, an exit status, or its deadline. */
function readFailure(outcome: ProcessOutcome): string {
  switch (outcome.kind) {
    case "exited": {
      const name = AWS_ERROR.exec(outcome.stderr)?.[1];
      return `reading its secret failed (${name ?? `exit status ${outcome.exitCode}`})`;
    }
    case "timed_out":
      return "reading its secret timed out";
    case "not_found":
      return "reading its secret failed (the AWS CLI is not installed)";
    case "not_started":
      return `reading its secret failed (${ERROR_CODE.test(outcome.code) ? outcome.code : "unexpected error"})`;
  }
}

/**
 * The secret `arn` names, read with the instance role in the secret's own Region (the factory
 * Region: factory.json's validation places it there). Refused unless it is a non-empty string
 * without whitespace once trimmed: gh starts its device flow on an empty token.
 */
async function fetchMaterial(
  run: Commands,
  account: EnrollmentId,
  arn: SecretReference,
): Promise<SecretMaterial> {
  const region = arn.split(":")[3] ?? "";
  const outcome = await run.run(
    [
      "/usr/bin/aws",
      "secretsmanager",
      "get-secret-value",
      "--region",
      region,
      "--secret-id",
      arn,
      "--query",
      "SecretString",
      "--output",
      "json",
    ],
    CREDENTIAL_COMMAND_TIMEOUT_MS,
    { asFactory: false },
  );
  if (outcome.kind !== "exited" || outcome.exitCode !== 0)
    throw new Refused(account, readFailure(outcome));
  let value: unknown;
  try {
    value = JSON.parse(outcome.stdout);
  } catch {
    throw new Refused(account, "Secrets Manager's answer could not be read");
  }
  if (value !== null && typeof value !== "string")
    throw new Refused(account, "Secrets Manager's answer could not be read");
  const material = (value ?? "").trim();
  if (material === "") throw new Refused(account, "its secret is empty");
  if (/\s/.test(material)) throw new Refused(account, "its secret contains whitespace");
  return new SecretMaterial(material);
}

/** One account gh lists: its login, if it is one, and whether it is active. */
function listedAccount(entry: unknown): { login: string; active: boolean } | undefined {
  const { login, active } = (entry ?? {}) as { login?: unknown; active?: unknown };
  return typeof login === "string" && GITHUB_LOGIN.test(login) && typeof active === "boolean"
    ? { login, active }
    : undefined;
}

/** The github.com accounts gh keeps that are not active, or undefined when gh cannot tell. */
function inactiveLogins(stdout: string): string[] | undefined {
  let entries: unknown;
  try {
    entries = (JSON.parse(stdout) as { hosts?: Record<string, unknown> }).hosts?.["github.com"];
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries ?? [])) return undefined;
  const listed = ((entries ?? []) as unknown[]).map(listedAccount);
  if (listed.some((account) => account === undefined)) return undefined;
  return listed.flatMap((account) => (account?.active === false ? [account.login] : []));
}

/** D16: log in with the token, set Git up, and keep the configured account alone (D5). */
async function deliverGithub(run: Commands, token: SecretMaterial): Promise<void> {
  await run.must(
    "github",
    "gh auth login",
    [
      "gh",
      "auth",
      "login",
      "--with-token",
      ...GITHUB,
      "--git-protocol",
      "https",
      "--insecure-storage",
    ],
    CREDENTIAL_LOGIN_TIMEOUT_MS,
    token,
  );
  await run.must("github", "gh auth setup-git", ["gh", "auth", "setup-git", ...GITHUB]);
  const listed = await run.must("github", "gh auth status", [
    "gh",
    "auth",
    "status",
    ...GITHUB,
    "--json",
    "hosts",
  ]);
  const inactive = inactiveLogins(listed.stdout);
  if (inactive === undefined) throw new Refused("github", "gh auth status gave no account list");
  for (const login of inactive)
    await run.must("github", "gh auth logout", [
      "gh",
      "auth",
      "logout",
      ...GITHUB,
      "--user",
      login,
    ]);
}

async function deliverOpenai(run: Commands, key: SecretMaterial): Promise<void> {
  await run.must(
    "openai",
    "codex login",
    ["codex", "login", "--with-api-key"],
    CREDENTIAL_LOGIN_TIMEOUT_MS,
    key,
  );
}

/** Writes `text` to the root-owned `path` whole or not at all, in a root 0755 directory. */
async function writeRootFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await chmod(dirname(path), 0o755);
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(staging, "wx", 0o644);
    try {
      await handle.chmod(0o644);
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

/**
 * D12: the key into `factory`'s 0600 file, written as `factory` (never root in a directory
 * `factory` owns) and renamed into place, then Claude Code's managed settings naming the helper.
 */
async function deliverAnthropic(
  system: WorkerSystem,
  run: Commands,
  key: SecretMaterial,
): Promise<void> {
  const file = join(system.root, ANTHROPIC_KEY_FILE);
  const staging = `${file}.new`;
  const what = "writing its key file";
  await run.must("anthropic", what, ["/usr/bin/install", "-d", "-m", "0700", dirname(file)]);
  // `dd` reads its own standard input: reopening a root-made pipe as /dev/stdin is refused.
  await run.must("anthropic", what, ["/usr/bin/install", "-m", "0600", "/dev/null", staging]);
  await run.must(
    "anthropic",
    what,
    ["/usr/bin/dd", `of=${staging}`, "status=none"],
    CREDENTIAL_COMMAND_TIMEOUT_MS,
    key,
  );
  await run.must("anthropic", what, ["/usr/bin/mv", "-fT", "--", staging, file]);
  try {
    await writeRootFile(join(system.root, CLAUDE_MANAGED_SETTINGS), CLAUDE_MANAGED_SETTINGS_JSON);
  } catch (error) {
    throw new Refused(
      "anthropic",
      `writing Claude Code's managed settings failed (${errorCode(error)})`,
    );
  }
}

/** What Claude Code's managed settings hold: nothing, fffactory's helper, another's, or unreadable. */
async function managedSettings(
  path: string,
): Promise<"none" | "fffactory's" | "another's" | { unreadable: string }> {
  try {
    return namesKeyHelper(await readFile(path, "utf8")) ? "fffactory's" : "another's";
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "none"
      : { unreadable: errorCode(error) };
  }
}

/**
 * D14: Claude Code's helper, only while its managed settings name fffactory's (`namesKeyHelper`):
 * settings that do not, or cannot be read, are someone else's policy and stay. Then the key the
 * helper reads, so the helper never names a missing file. Returns what it did, for the log.
 */
async function removeAnthropic(system: WorkerSystem, run: Commands): Promise<string> {
  const path = join(system.root, CLAUDE_MANAGED_SETTINGS);
  const settings = await managedSettings(path);
  let done: string;
  if (settings === "fffactory's") {
    try {
      await rm(path, { force: true });
    } catch (error) {
      throw new Refused(
        "anthropic",
        `removing Claude Code's managed settings failed (${errorCode(error)})`,
      );
    }
    done = "Claude Code's API key helper removed";
  } else if (settings === "none") done = "no API key helper of fffactory's to remove";
  else if (settings === "another's")
    done = "Claude Code's managed settings kept: they do not name fffactory's helper";
  else
    done = `Claude Code's managed settings kept: they could not be read (${settings.unreadable})`;
  await run.must("anthropic", "removing its key file", [
    "/usr/bin/rm",
    "-f",
    "--",
    join(system.root, ANTHROPIC_KEY_FILE),
  ]);
  return `anthropic: not delivered; ${done}`;
}

/** Every delivered account's material, read and checked before any tool runs. */
async function fetchAll(
  run: Commands,
  credentials: HostCredentials | undefined,
): Promise<[EnrollmentId, SecretMaterial][]> {
  const delivered: [EnrollmentId, SecretMaterial][] = [];
  for (const { id } of ENROLLMENTS) {
    const arn = credentials?.[CREDENTIAL_SECRET_FIELDS[id]];
    if (arn !== undefined) delivered.push([id, await fetchMaterial(run, id, arn)]);
  }
  return delivered;
}

async function deliver(
  system: WorkerSystem,
  run: Commands,
  id: EnrollmentId,
  material: SecretMaterial,
): Promise<void> {
  if (id === "github") await deliverGithub(run, material);
  else if (id === "openai") await deliverOpenai(run, material);
  else await deliverAnthropic(system, run, material);
}

/**
 * Delivers the accounts `credentials` references, within `budgetMs`, telling `note` what it did
 * in its own words. Every secret is read and checked before any tool runs. Returns why the step
 * failed, naming the account and the AWS error name, exit status or deadline, or undefined.
 */
export async function workerCredentials(
  system: WorkerSystem,
  credentials: HostCredentials | undefined,
  budgetMs: number,
  note: (line: string) => Promise<void>,
): Promise<string | undefined> {
  const run = commands(system, budgetMs);
  try {
    const delivered = await fetchAll(run, credentials);
    for (const [id, material] of delivered) {
      await deliver(system, run, id, material);
      await note(`${id}: delivered`);
    }
    if (!delivered.some(([id]) => id === "anthropic"))
      await note(await removeAnthropic(system, run));
    return undefined;
  } catch (error) {
    if (error instanceof Refused) return error.message;
    throw error;
  }
}
