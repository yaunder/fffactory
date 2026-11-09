/**
 * The worker's dispatcher (`docs/specs/dispatch.md` §The dispatcher): `fffactory host dispatch
 * run`, which the dispatch skill runs as `factory` on the trigger's cadence. It pulls ready FFFlow
 * epics into runs the execution backend hosts, one at a time, judged by `domain/dispatch-policy.ts`
 * over what it reads here: GitHub through `gh`, the checkouts through `git` and the release's
 * repository programs, and the agents through `ExecutionBackend.agents`. It never merges,
 * force-pushes, deletes branches, closes issues, deploys infrastructure or converges hosts.
 *
 * It is the Python `factory-dispatch` it replaces, ported faithfully: the same commands in the
 * environment and directory it was started with, the same rules, summary and exit codes. Its
 * launch and duplicate check still name Paseo here, through the adapter's `CallerPaseoCommand`,
 * until task 5 moves them behind the seam.
 */
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type AdoptionReport,
  busyDispatched,
  capacityReached,
  type ConsideredEpic,
  DISPATCH_CAPACITY,
  type DispatchRepository,
  type DispatchSummary,
  dispatchBranch,
  dispatchRepositories,
  dispatchStamp,
  epicBranch,
  externalDependencies,
  githubSlug,
  isClosed,
  isOpen,
  type PullRequest,
  pullRequestFor,
  SKIPS,
  type Skipped,
  type Started,
  type TaskIssue,
  toolText,
} from "../domain/dispatch-policy";
import { DISPATCH_PROJECTION_PATH, parseDispatchProjection } from "../domain/dispatch-projection";
import {
  ADOPTION_CHECK,
  REPOSITORY_MANIFEST_PATH,
  SYNC_SCRIPT,
} from "../domain/repository-placement";
import { WORK_ROOTS } from "../domain/work-inspection";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { ApplySystem } from "./apply";
import { type BackendSelection, executionBackend } from "./execution-backend";
import { ended } from "./failures";
import type { HeldLock } from "./install-lock";
import { type CallerPaseoCommand, callerPaseo, RETIRED_DISPATCH_LOCK } from "./paseo-backend";
import { FACTORY_HOME } from "./runtime-account";

/** Each command's timeout. The Python dispatcher waited on its commands without one. */
const COMMAND_TIMEOUT_MS = 15 * 60_000;
/** The backend's agents, every call of it together, as `host agents` bounded them. */
const AGENTS_BUDGET_MS = 90_000;
/** The whole adoption from root, as the activator's adoption ran the Python program. */
const ADOPTION_TIMEOUT_MS = 15 * 60_000;
/**
 * The lock a tick holds from before it reads the agents to its end, so overlapping ticks never
 * both run: in the `factory` account's own state directory, whatever the backend.
 */
export const DISPATCH_LOCK = `${FACTORY_HOME}/.local/state/fffactory/dispatch.lock`;
/** Root's environment for `runuser`, and `factory`'s clean one for the adoption checks. */
const ROOT_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" };
const FACTORY_ENV = [
  `HOME=${FACTORY_HOME}`,
  "PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "LANG=C.UTF-8",
] as const;

/** The process the dispatcher runs in: the environment and directory it was started with. */
export interface DispatchCaller {
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: () => string;
}

/** How one run of the dispatcher ended. */
export type DispatchTick =
  | { readonly kind: "dispatched"; readonly summary: DispatchSummary }
  | { readonly kind: "adoption"; readonly report: AdoptionReport }
  | { readonly kind: "failed"; readonly reason: string };

export interface HostDispatcher {
  /** One tick as `factory`, or with `adoptionOnly` the placed repositories' adoption alone. */
  runDispatch(adoptionOnly: boolean): Promise<DispatchTick>;
}

/**
 * A failure the Python dispatcher caught where it could skip (its `DispatchError`): a command
 * that exited non-zero, a remote it could not read, a checkout it would not use. Anything else
 * fails the tick.
 */
class DispatchError extends Error {}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Runs a command to its stripped standard output; a non-zero exit is a `DispatchError`. */
type Run = (argv: readonly string[], options?: RunOptions) => Promise<string>;

/** A finished command's stripped standard output, as the Python dispatcher's `run` read it. */
function output(label: readonly string[], outcome: ProcessOutcome): string {
  if (outcome.kind !== "exited")
    throw new Error(ended(label[0] ?? "a command", outcome) ?? "a command failed");
  if (outcome.exitCode === 0) return toolText(outcome.stdout);
  const said = toolText(outcome.stderr) || toolText(outcome.stdout);
  throw new DispatchError(`${label.slice(0, 3).join(" ")}: ${said}`);
}

/** Commands run as the caller: its environment unless given another, its directory by default. */
function asCaller(system: ApplySystem, caller: DispatchCaller): Run {
  return async (argv, options = {}) =>
    output(
      argv,
      await system.run(argv, COMMAND_TIMEOUT_MS, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env ?? caller.environment,
      }),
    );
}

/** Commands run from root as `factory`, in its clean environment, all before `deadline`. */
function asFactoryFromRoot(system: ApplySystem, deadline: number): Run {
  return async (argv) => {
    const left = deadline - system.now().getTime();
    if (left <= 0) return output(argv, { kind: "timed_out" });
    const command = ["/usr/sbin/runuser", "-u", "factory", "--", "/usr/bin/env", "-i"];
    const outcome = await system.run([...command, ...FACTORY_ENV, ...argv], left, {
      cwd: "/",
      env: ROOT_ENV,
    });
    return output(argv, outcome);
  };
}

async function json(run: Run, argv: readonly string[], options?: RunOptions): Promise<unknown> {
  const text = await run(argv, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DispatchError(`invalid JSON from ${argv[0]}: ${(error as Error).message}`);
  }
}

function fieldsOf(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${what} is not an object`);
  return value as Readonly<Record<string, unknown>>;
}

function listOf(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`);
  return value;
}

function numberOf(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${what} has no number`);
  return value as number;
}

function stateOf(value: unknown, what: string): string {
  const { state } = fieldsOf(value, what);
  if (typeof state !== "string") throw new Error(`${what} has no state`);
  return state;
}

/** A text field as Python's `value or ""` read it. */
const textOf = (value: unknown) => (typeof value === "string" ? value : "");

function slug(remote: string): string {
  const named = githubSlug(remote);
  if (named === undefined) throw new DispatchError(`unsupported GitHub remote: ${remote}`);
  return named;
}

/** A path as Python's `Path.resolve` resolves it: its real path, or as written when missing. */
async function resolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `path` exists, following links, as Python's `Path.exists` answers. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (["ENOENT", "ENOTDIR", "ELOOP", "EBADF"].includes(code)) return false;
    throw error;
  }
}

/** Whether `path` is a symbolic link; false when it cannot be read. */
async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether `path` is a directory, following links; false when it cannot be read. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Refuses a checkout that is not the clean primary clone the manifest declares. */
async function primaryCheckout(run: Run, path: string, repository: DispatchRepository) {
  if ((await isLink(path)) || !(await isDirectory(join(path, ".git"))))
    throw new DispatchError(`${path}: not a primary checkout`);
  const git = (...args: string[]) => run(["git", ...args], { cwd: path });
  const top = await git("rev-parse", "--show-toplevel");
  if ((await resolved(top)) !== (await resolved(path)))
    throw new DispatchError(`${path}: checkout root differs from declared path`);
  if (slug(await git("config", "--get", "remote.origin.url")) !== slug(repository.remote))
    throw new DispatchError(`${path}: wrong origin remote`);
  if ((await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== repository.branch)
    throw new DispatchError(`${path}: wrong branch; expected ${repository.branch}`);
  if (await git("status", "--porcelain=v1", "--untracked-files=all"))
    throw new DispatchError(`${path}: checkout is dirty`);
}

/** The DispatchError's message, or undefined when `check` passed; anything else is thrown. */
async function refusal(check: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await check();
    return undefined;
  } catch (error) {
    if (error instanceof DispatchError) return error.message;
    throw error;
  }
}

/** Why `repository` failed the release's FFFlow adoption check, or undefined when it passed. */
function adoptionRefusal(system: ApplySystem, run: Run, repository: DispatchRepository) {
  return refusal(() =>
    run([join(system.root, ADOPTION_CHECK), repository.remote, repository.branch]),
  );
}

async function adoptionReport(
  system: ApplySystem,
  run: Run,
  repositories: readonly DispatchRepository[],
): Promise<AdoptionReport> {
  const failed: string[] = [];
  for (const repository of repositories)
    if ((await adoptionRefusal(system, run, repository)) !== undefined)
      failed.push(repository.alias);
  return { adoption: failed.length === 0 ? "passed" : "failed", failed_repositories: failed };
}

/** The repositories the worker's manifest places on `host`, or a failure. */
async function placedOn(system: ApplySystem, host: string): Promise<readonly DispatchRepository[]> {
  const placed = dispatchRepositories(
    await readFile(join(system.root, REPOSITORY_MANIFEST_PATH), "utf8"),
    host,
  );
  if (!placed.ok) throw new Error(placed.reason);
  return placed.repositories;
}

/**
 * Every placed repository's FFFlow adoption, for the activator's `dispatch adoption`, as root:
 * each check run as `factory` in its clean environment, all within the adoption's timeout.
 * Whether all passed; anything that fails the check itself is not passed.
 */
export async function rootAdoption(system: ApplySystem): Promise<boolean> {
  try {
    const run = asFactoryFromRoot(system, system.now().getTime() + ADOPTION_TIMEOUT_MS);
    const repositories = await placedOn(system, system.hostname());
    return (await adoptionReport(system, run, repositories)).adoption === "passed";
  } catch {
    return false;
  }
}

/** What one tick reads and records as it goes. */
interface Tick {
  readonly system: ApplySystem;
  readonly caller: DispatchCaller;
  readonly run: Run;
  readonly paseo: CallerPaseoCommand;
  readonly host: string;
  readonly schedule: { readonly provider: string; readonly model: string; readonly mode: string };
  readonly considered: ConsideredEpic[];
  readonly skipped: Skipped[];
  readonly started: Started[];
  running: number;
}

/**
 * Paseo's JSON answer to `args`, through the adapter's command, in the caller's environment
 * unless given another; its failures read as the dispatcher's other commands'.
 */
function paseoJson(tick: Tick, args: readonly string[], options: RunOptions = {}) {
  const run: Run = async (argv, given = {}) =>
    output(
      argv,
      await tick.paseo(argv.slice(1), { ...given, env: given.env ?? tick.caller.environment }),
    );
  return json(run, ["paseo", ...args], options);
}

// TODO(re-evaluate when task 5 lands): through startRun/runs
/** Whether the backend lists any run dispatch launched for the epic, finished or not. */
async function previouslyDispatched(tick: Tick, alias: string, epic: number): Promise<boolean> {
  const rows = await paseoJson(tick, [
    "ls",
    "--global",
    "--background",
    "--label",
    "factory-dispatch=true",
    "--label",
    `factory-repository=${alias}`,
    "--label",
    `factory-epic=${epic}`,
    "--json",
  ]);
  if (!Array.isArray(rows)) throw new DispatchError("Paseo returned an invalid agent list");
  return rows.length > 0;
}

/** The caller's environment without the scheduled agent's own Paseo identity. */
function launchEnvironment(environment: Readonly<Record<string, string>>) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => name !== "PASEO_AGENT_ID" && name !== "PASEO_WORKSPACE_ID",
    ),
  );
}

// TODO(re-evaluate when task 5 lands): through startRun/runs
/** Launches the epic's agent, top-level, in a fresh workspace branched off `remoteRef`. */
async function launch(
  tick: Tick,
  alias: string,
  epic: number,
  checkout: string,
  remoteRef: string,
) {
  const stamp = dispatchStamp(tick.system.now());
  // work-epic defaults to main; use the repository's declared remote branch.
  const prompt =
    `/fff:work-epic ${epic}\n\n` +
    "This fresh Paseo worktree starts on a dispatch branch; create " +
    `${epicBranch(epic)} from ${remoteRef} here as work-epic requires.`;
  const response = await paseoJson(
    tick,
    [
      "run",
      "--no-wait",
      "--json",
      "--provider",
      `${tick.schedule.provider}/${tick.schedule.model}`,
      "--mode",
      tick.schedule.mode,
      "--new-workspace",
      "worktree",
      "--worktree-mode",
      "branch-off",
      "--new-branch",
      dispatchBranch(epic, stamp),
      "--base",
      remoteRef,
      "--cwd",
      checkout,
      "--label",
      "factory-dispatch=true",
      "--label",
      `factory-repository=${alias}`,
      "--label",
      `factory-epic=${epic}`,
      "--label",
      `factory-dispatched-at=${stamp}`,
      prompt,
    ],
    { cwd: checkout, env: launchEnvironment(tick.caller.environment) },
  );
  const fields = fieldsOf(response, "the launch's answer");
  if (!Object.hasOwn(fields, "agentId")) throw new Error("the launch's answer has no agentId");
  return fields.agentId;
}

/** The repository's GitHub reads for one tick. */
interface RepositoryReads {
  readonly repository: DispatchRepository;
  readonly repo: string;
  readonly checkout: string;
  readonly prs: readonly PullRequest[];
  /** Each external dependency's state, read once a tick per repository. */
  readonly dependencies: Map<number, string>;
}

function issueOf(value: unknown): TaskIssue {
  const fields = fieldsOf(value, "a task's issue");
  const comments = Array.isArray(fields.comments) ? fields.comments : [];
  return {
    body: textOf(fields.body),
    comments: comments.map((comment) => textOf(fieldsOf(comment, "a comment").body)),
  };
}

/** Whether `dependency` is closed, read once per repository. */
async function dependencyClosed(tick: Tick, reads: RepositoryReads, dependency: number) {
  let state = reads.dependencies.get(dependency);
  if (state === undefined) {
    const view = ["gh", "issue", "view", String(dependency), "--repo", reads.repo];
    state = stateOf(await json(tick.run, [...view, "--json", "number,state"]), "an issue");
    reads.dependencies.set(dependency, state);
  }
  return isClosed(state);
}

/** Why the open task holds its epic, or undefined. */
async function taskBlocker(tick: Tick, reads: RepositoryReads, task: number, tasks: Set<number>) {
  const view = ["gh", "issue", "view", String(task), "--repo", reads.repo];
  const issue = issueOf(await json(tick.run, [...view, "--json", "number,state,body,comments"]));
  for (const dependency of externalDependencies(issue, tasks))
    if (!(await dependencyClosed(tick, reads, dependency)))
      return SKIPS.openDependency(task, dependency);
  const pr = pullRequestFor(task, reads.prs);
  return pr === undefined ? undefined : SKIPS.openPullRequest(task, pr.number);
}

/** Why the epic is not ready, or undefined when it is. */
async function readiness(tick: Tick, reads: RepositoryReads, epic: number) {
  const list = ["gh", "issue", "list", "--repo", reads.repo, "--state", "all"];
  const labels = ["--label", "ffflow-task", "--label", `epic-${epic}`, "--limit", "1000"];
  const tasks = listOf(
    await json(tick.run, [...list, ...labels, "--json", "number,title,state,body"]),
    "the task list",
  ).map((task) => ({ number: numberOf(fieldsOf(task, "a task").number, "a task"), task }));
  if (tasks.length === 0) return SKIPS.noTasks;
  const numbers = new Set(tasks.map(({ number }) => number));
  for (const { number, task } of tasks) {
    if (!isOpen(stateOf(task, "a task"))) return SKIPS.taskNotOpen(number);
    const blocker = await taskBlocker(tick, reads, number, numbers);
    if (blocker !== undefined) return blocker;
  }
  const branch = `refs/heads/${epicBranch(epic)}`;
  const remote = reads.repository.remote;
  if (await tick.run(["git", "ls-remote", "--heads", remote, branch]))
    return SKIPS.branchExists(epic);
  return undefined;
}

/**
 * Brings the checkout to its declared remote branch with the release's repository program,
 * which refuses dirty, diverged, wrong-branch and wrong-remote checkouts; why not, or undefined.
 */
function prepared(tick: Tick, reads: RepositoryReads, remoteRef: string) {
  const { system, caller, run, host } = tick;
  const { repository, checkout } = reads;
  const sync = join(system.root, SYNC_SCRIPT);
  const manifest = join(system.root, REPOSITORY_MANIFEST_PATH);
  const env = {
    ...caller.environment,
    FACTORY_REPOSITORY_ROOT: join(system.root, WORK_ROOTS.repositories),
  };
  return refusal(async () => {
    await run([sync, "--plan", "--host", host, "--manifest", manifest], { env });
    // The program reports every placed checkout: an unrelated error must not change this one.
    await run([sync, "--apply", "--host", host, "--manifest", manifest], { env });
    await primaryCheckout(run, checkout, repository);
    await run(["git", "fetch", "--no-tags", "origin", repository.branch], { cwd: checkout });
    const head = await run(["git", "rev-parse", "HEAD"], { cwd: checkout });
    if (head !== (await run(["git", "rev-parse", remoteRef], { cwd: checkout })))
      throw new DispatchError(`checkout is not at ${remoteRef}`);
  });
}

/** Why the ready epic was not launched, or undefined once it is. */
async function launched(tick: Tick, reads: RepositoryReads, epic: number) {
  const alias = reads.repository.alias;
  if (capacityReached(tick.running)) return SKIPS.capReached;
  if (await previouslyDispatched(tick, alias, epic)) return SKIPS.dispatched;
  const remoteRef = `origin/${reads.repository.branch}`;
  const refused = await prepared(tick, reads, remoteRef);
  if (refused !== undefined) return refused;
  const agentId = await launch(tick, alias, epic, reads.checkout, remoteRef);
  tick.started.push({ repository: alias, epic, agent_id: agentId });
  tick.running += 1;
  return undefined;
}

async function epicTick(tick: Tick, reads: RepositoryReads, epic: number) {
  const repository = reads.repository.alias;
  tick.considered.push({ repository, epic });
  const reason = (await readiness(tick, reads, epic)) ?? (await launched(tick, reads, epic));
  if (reason !== undefined) tick.skipped.push({ repository, epic, reason });
}

function epicNumbers(value: unknown): readonly number[] {
  return listOf(value, "the epic list").map((epic) =>
    numberOf(fieldsOf(epic, "an epic").number, "an epic"),
  );
}

function pullRequests(value: unknown): readonly PullRequest[] {
  return listOf(value, "the pull request list").map((pr) => {
    const fields = fieldsOf(pr, "a pull request");
    return {
      number: numberOf(fields.number, "a pull request"),
      title: textOf(fields.title),
      body: textOf(fields.body),
    };
  });
}

/** Why an existing checkout cannot be used, or undefined when it can or is not there yet. */
async function checkoutRefusal(run: Run, checkout: string, repository: DispatchRepository) {
  if (!(await exists(checkout))) return undefined;
  return refusal(() => primaryCheckout(run, checkout, repository));
}

async function repositoryTick(tick: Tick, repository: DispatchRepository) {
  const { system, run } = tick;
  const alias = repository.alias;
  const failedAdoption = await adoptionRefusal(system, run, repository);
  if (failedAdoption !== undefined) {
    tick.skipped.push({ repository: alias, reason: SKIPS.adoption(failedAdoption) });
    return;
  }
  const checkout = join(system.root, WORK_ROOTS.repositories, repository.path);
  const repo = slug(repository.remote);
  const list = ["gh", "issue", "list", "--repo", repo, "--state", "open"];
  const labels = ["--label", "ready", "--label", "ffflow-epic", "--limit", "1000"];
  const epics = epicNumbers(await json(run, [...list, ...labels, "--json", "number,title,state"]));
  if (epics.length === 0) return;
  const refused = await checkoutRefusal(run, checkout, repository);
  if (refused !== undefined) {
    for (const epic of epics) tick.considered.push({ repository: alias, epic });
    for (const epic of epics) tick.skipped.push({ repository: alias, epic, reason: refused });
    return;
  }
  const prList = ["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", "1000"];
  const prs = pullRequests(await json(run, [...prList, "--json", "number,title,body,headRefName"]));
  const reads = { repository, repo, checkout, prs, dependencies: new Map<number, string>() };
  for (const epic of [...epics].sort((a, b) => a - b)) await epicTick(tick, reads, epic);
}

/** The tick under its lock: the agents first, then every placed repository's ready epics. */
async function locked(tick: Tick, select: BackendSelection, placed: readonly DispatchRepository[]) {
  const agents = await select(tick.system, AGENTS_BUDGET_MS).agents();
  if (agents.kind !== "listed")
    throw new Error(`the worker's agents could not be read: ${agents.reason}`);
  tick.running = busyDispatched(agents.agents);
  const running = tick.running;
  for (const repository of placed) await repositoryTick(tick, repository);
  return {
    host: tick.host,
    cap: DISPATCH_CAPACITY,
    running,
    considered: tick.considered,
    skipped: tick.skipped,
    started: tick.started,
    running_after: tick.running,
  };
}

/** The active projection's schedule for `host`, from the declared directory; or a failure. */
async function activeSchedule(system: ApplySystem, caller: DispatchCaller, host: string) {
  const parsed = parseDispatchProjection(
    await readFile(join(system.root, DISPATCH_PROJECTION_PATH), "utf8"),
  );
  if (!parsed.ok) throw new Error("invalid dispatch projection");
  const { hostname, requested, active, schedule } = parsed.projection;
  if (hostname !== host || !requested || !active)
    throw new Error("dispatch is not active for this host");
  if (schedule === null) throw new Error("dispatch schedule settings are missing");
  if ((await resolved(caller.cwd())) !== (await resolved(join(system.root, schedule.cwd))))
    throw new Error(`run from the declared dispatch directory: ${schedule.cwd}`);
  return schedule;
}

/**
 * Takes the dispatch lock, created if missing, and the Python dispatcher's while Paseo's home is
 * there; another tick holding either fails this one, with neither held.
 */
async function dispatchLocks(system: ApplySystem): Promise<readonly HeldLock[]> {
  const path = join(system.root, DISPATCH_LOCK);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const held = await system.lock(path);
  if (held === undefined) throw new Error("another dispatch tick holds its lock");
  try {
    // TODO(re-evaluate when no worker runs a release from before #142): take only DISPATCH_LOCK
    const retired = join(system.root, RETIRED_DISPATCH_LOCK);
    if (!(await isDirectory(dirname(retired)))) return [held];
    const retiredHeld = await system.lock(retired);
    if (retiredHeld === undefined) throw new Error("another dispatch tick holds its lock");
    return [held, retiredHeld];
  } catch (error) {
    held.release();
    throw error;
  }
}

async function dispatchTick(
  system: ApplySystem,
  caller: DispatchCaller,
  select: BackendSelection,
  paseo: CallerPaseoCommand,
): Promise<DispatchSummary> {
  const host = system.hostname().split(".")[0] ?? "";
  const placed = await placedOn(system, host);
  const schedule = await activeSchedule(system, caller, host);
  const held = await dispatchLocks(system);
  try {
    const run = asCaller(system, caller);
    const tick: Tick = {
      ...{ system, caller, run, paseo, host, schedule },
      ...{ considered: [], skipped: [], started: [], running: 0 },
    };
    return await locked(tick, select, placed);
  } finally {
    for (const lock of held) lock.release();
  }
}

async function adoptionOnly(system: ApplySystem, caller: DispatchCaller) {
  const host = system.hostname().split(".")[0] ?? "";
  return adoptionReport(system, asCaller(system, caller), await placedOn(system, host));
}

/**
 * The dispatcher on `system`, run by `caller` as `factory`. `select` is the worker's backend
 * selection point and `paseoFor` the Paseo CLI's; tests give fakes.
 */
export function workerDispatcher(
  system: ApplySystem,
  caller: DispatchCaller,
  select: BackendSelection = executionBackend,
  paseoFor: (system: ApplySystem, timeoutMs: number) => CallerPaseoCommand = callerPaseo,
): HostDispatcher {
  return {
    async runDispatch(adoption) {
      // As `host agents`: the CLI refuses root for its words, this for the files a tick creates
      // in factory's state and checkouts, which as root would become root's.
      if (system.isRoot()) return { kind: "failed", reason: "run as root" };
      try {
        if (adoption) return { kind: "adoption", report: await adoptionOnly(system, caller) };
        const paseo = paseoFor(system, COMMAND_TIMEOUT_MS);
        return { kind: "dispatched", summary: await dispatchTick(system, caller, select, paseo) };
      } catch (error) {
        return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
