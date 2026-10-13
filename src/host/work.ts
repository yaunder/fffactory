/**
 * The worker side of `host work inspect` (`docs/specs/host-protocol.md` §work inspect): the
 * current state of every checkout under the repository root, every Paseo worktree, and every
 * worktree Git lists for their repositories, read fresh as the runtime account. It changes
 * nothing: Git runs with optional locks off, so no index is refreshed and no lock file is
 * taken, never fetches, and no file's content or name reaches the document.
 */
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { HOST_PROTOCOL_VERSION, TOKEN } from "../domain/protocol-fields";
import { RUNTIME_ACCOUNT } from "../domain/readiness";
import {
  type InProgressOperation,
  printableBranch,
  printablePath,
  type RepositoryWork,
  WORK_LIMITS,
  WORK_ROOTS,
  type WorkInspection,
  type WorktreeWork,
} from "../domain/work-inspection";
import type { ApplySystem } from "./apply";

/** Each Git command's bound. */
export const WORK_GIT_TIMEOUT_MS = 20_000;
/**
 * How long the inspection starts Git commands for: past it, it reports what it has, incomplete,
 * well within the CLI's deadline (`INSPECT_WORK_TIMEOUT_MS`).
 */
export const WORK_BUDGET_MS = 75_000;

/** How deep below each root a checkout or worktree is looked for. */
const SEARCH_DEPTH = { repositories: 4, paseoWorktrees: 3 } as const;

/** Git as the runtime account, in a clean environment that takes no lock and never prompts. */
const AS_FACTORY = [
  "/usr/sbin/runuser",
  "-u",
  RUNTIME_ACCOUNT,
  "--",
  "/usr/bin/env",
  "-i",
  `HOME=/home/${RUNTIME_ACCOUNT}`,
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "LANG=C",
  "LC_ALL=C",
  "GIT_OPTIONAL_LOCKS=0",
  "GIT_TERMINAL_PROMPT=0",
  "git",
  "--no-pager",
  // An fsmonitor hook is a program the repository names: never run one.
  "-c",
  "core.fsmonitor=false",
] as const;

/** The marker files of an operation left in progress, in a worktree's own Git directory. */
const IN_PROGRESS: readonly (readonly [string, InProgressOperation])[] = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry_pick"],
  ["REVERT_HEAD", "revert"],
];

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NO_COMMIT = /^0+$/;

export interface HostWork {
  inspectWork(): Promise<WorkInspection>;
}

/** One worktree as `git worktree list --porcelain -z` lists it. */
interface ListedWorktree {
  readonly path: string;
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly bare: boolean;
  readonly prunable: boolean;
}

class Inspection {
  complete = true;
  /** Set once the budget is spent: no more Git commands start. */
  outOfTime = false;
  private readonly started: number;

  constructor(private readonly system: ApplySystem) {
    this.started = system.now().getTime();
  }

  /** Git's standard output, or undefined when it failed, or the budget is spent. */
  async git(directory: string, args: readonly string[]): Promise<string | undefined> {
    if (this.system.now().getTime() - this.started >= WORK_BUDGET_MS) {
      this.outOfTime = true;
      this.complete = false;
      return undefined;
    }
    const outcome = await this.system.run(
      [...AS_FACTORY, "-C", directory, ...args],
      WORK_GIT_TIMEOUT_MS,
      { cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } },
    );
    return outcome.kind === "exited" && outcome.exitCode === 0 ? outcome.stdout : undefined;
  }

  /** A count Git printed, or undefined. */
  async count(directory: string, args: readonly string[]): Promise<number | undefined> {
    const output = await this.git(directory, args);
    const value = output === undefined ? Number.NaN : Number(output.trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  /** The path as the worker knows it: the test root taken off, printable or null. */
  shown(path: string, roots: readonly string[]): string | null {
    for (const root of roots)
      if (root !== "/" && (path === root || path.startsWith(`${root}/`)))
        return printablePath(path.slice(root.length) || "/");
    return printablePath(path);
  }
}

/**
 * Directories below `directory`, at most `depth` levels down, holding a `.git`: a checkout or a
 * worktree, below which nothing is looked for. Symbolic links are never followed. A root that
 * does not exist holds none; any other directory that cannot be read, even one gone since its
 * parent listed it (a name that is not UTF-8 reads back as another), leaves the inspection
 * incomplete.
 */
async function workingTrees(
  directory: string,
  depth: number,
  inspection: Inspection,
  root = true,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (!root || (error as NodeJS.ErrnoException).code !== "ENOENT") inspection.complete = false;
    return [];
  }
  if (entries.some((entry) => entry.name === ".git")) return [directory];
  if (depth === 0) return [];
  const found: string[] = [];
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names)
    found.push(...(await workingTrees(join(directory, name), depth - 1, inspection, false)));
  return found;
}

function parseWorktrees(output: string): ListedWorktree[] {
  const worktrees: ListedWorktree[] = [];
  let current: Record<string, string> | undefined;
  const finish = () => {
    if (current?.worktree !== undefined)
      worktrees.push({
        path: current.worktree,
        head: current.HEAD,
        branch: current.branch,
        bare: "bare" in current,
        prunable: "prunable" in current,
      });
    current = undefined;
  };
  for (const field of output.split("\0")) {
    if (field === "") {
      finish();
      continue;
    }
    const space = field.indexOf(" ");
    const [name, value] = space < 0 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)];
    current ??= {};
    current[name] = value;
  }
  finish();
  return worktrees;
}

/** Changed tracked entries and untracked files in `git status --porcelain=v2 -z` output. */
function statusCounts(output: string): { tracked: number; untracked: number } {
  let tracked = 0;
  let untracked = 0;
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const kind = fields[index]?.slice(0, 2);
    if (kind === "1 " || kind === "u ") tracked += 1;
    else if (kind === "2 ") {
      tracked += 1;
      index += 1; // A rename's original path follows.
    } else if (kind === "? ") untracked += 1;
  }
  return { tracked, untracked };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function operationIn(gitDirectory: string): Promise<InProgressOperation | null> {
  for (const [marker, operation] of IN_PROGRESS)
    if (await exists(join(gitDirectory, marker))) return operation;
  return null;
}

/** Commits reachable from `head` that no remote-tracking branch holds; 0 for no commit yet. */
async function unpushedFrom(
  inspection: Inspection,
  directory: string,
  head: string | undefined,
): Promise<number | undefined> {
  if (head === undefined || !OBJECT_ID.test(head) || NO_COMMIT.test(head)) return 0;
  return inspection.count(directory, ["rev-list", "--count", head, "--not", "--remotes"]);
}

async function worktreeWork(
  inspection: Inspection,
  repository: string,
  listed: ListedWorktree,
  roots: readonly string[],
): Promise<WorktreeWork> {
  const branchName = listed.branch?.startsWith("refs/heads/")
    ? listed.branch.slice("refs/heads/".length)
    : undefined;
  const base = {
    path: inspection.shown(listed.path, roots),
    branch: branchName === undefined ? null : printableBranch(branchName),
  };
  const unpushed = await unpushedFrom(inspection, repository, listed.head);
  const unreadable = (): WorktreeWork => ({
    ...base,
    state: "unreadable",
    tracked_changes: 0,
    untracked_files: 0,
    unpushed_commits: unpushed ?? 0,
    operation: null,
  });
  if (unpushed === undefined) return unreadable();
  if (listed.prunable || !(await exists(listed.path)))
    return {
      ...base,
      state: "missing",
      tracked_changes: 0,
      untracked_files: 0,
      unpushed_commits: unpushed,
      operation: null,
    };
  const status = await inspection.git(listed.path, [
    "status",
    "--porcelain=v2",
    "--untracked-files=normal",
    "--ignore-submodules=none",
    "-z",
  ]);
  const gitDirectory = (
    await inspection.git(listed.path, ["rev-parse", "--absolute-git-dir"])
  )?.trim();
  if (status === undefined || gitDirectory === undefined || gitDirectory === "")
    return unreadable();
  const { tracked, untracked } = statusCounts(status);
  return {
    ...base,
    state: "inspected",
    tracked_changes: tracked,
    untracked_files: untracked,
    unpushed_commits: unpushed,
    operation: await operationIn(gitDirectory),
  };
}

/** Above this many unpushed commits, the branches carrying them are counted, not named. */
const NAMING_LIMIT = 10_000;

/**
 * Local branches whose tip no remote-tracking branch holds, the first few printable ones: the
 * tips among the unpushed commits, in two commands however many branches there are.
 */
async function unpushedBranches(
  inspection: Inspection,
  directory: string,
  unpushed: number,
): Promise<string[] | undefined> {
  if (unpushed === 0 || unpushed > NAMING_LIMIT) return [];
  const commits = await inspection.git(directory, ["rev-list", "--branches", "--not", "--remotes"]);
  const tips = await inspection.git(directory, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads",
  ]);
  if (commits === undefined || tips === undefined) return undefined;
  return namedTips(tips, new Set(commits.split("\n")));
}

/** The printable names of the branches in `for-each-ref` output whose tip is in `ahead`. */
function namedTips(tips: string, ahead: ReadonlySet<string>): string[] {
  const named: string[] = [];
  for (const line of tips.split("\n")) {
    const space = line.indexOf(" ");
    const ref = line.slice(space + 1);
    if (!ref.startsWith("refs/heads/") || !ahead.has(line.slice(0, space))) continue;
    const name = printableBranch(ref.slice("refs/heads/".length));
    if (name !== null) named.push(name);
    if (named.length === WORK_LIMITS.namedBranches) break;
  }
  return named;
}

/** What the repository's worktrees share: unpushed branches and stash entries. */
async function shared(inspection: Inspection, directory: string) {
  const unpushed = await inspection.count(directory, [
    "rev-list",
    "--count",
    "--branches",
    "--not",
    "--remotes",
  ]);
  if (unpushed === undefined) return undefined;
  const branches = await unpushedBranches(inspection, directory, unpushed);
  const stashes = await inspection.git(directory, ["stash", "list", "--format=%H"]);
  if (branches === undefined || stashes === undefined) return undefined;
  return {
    unpushed_commits: unpushed,
    unpushed_branches: branches,
    stashes: stashes.split("\n").filter((line) => line !== "").length,
  };
}

function unreadableRepository(path: string | null): RepositoryWork {
  return {
    path,
    state: "unreadable",
    unpushed_commits: 0,
    unpushed_branches: [],
    stashes: 0,
    worktrees: [],
  };
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Every checkout under the repository root, then every Paseo worktree, in path order. */
async function discovered(system: ApplySystem, inspection: Inspection): Promise<string[]> {
  return [
    ...(await workingTrees(
      join(system.root, WORK_ROOTS.repositories),
      SEARCH_DEPTH.repositories,
      inspection,
    )),
    ...(await workingTrees(
      join(system.root, WORK_ROOTS.paseoWorktrees),
      SEARCH_DEPTH.paseoWorktrees,
      inspection,
    )),
  ];
}

/** The worktrees the repository at `tree` lists, with their real paths, or undefined. */
async function listing(inspection: Inspection, tree: string) {
  const output = await inspection.git(tree, ["worktree", "list", "--porcelain", "-z"]);
  if (output === undefined) return undefined;
  const listed = parseWorktrees(output);
  const real = await Promise.all(listed.map((worktree) => realOrSelf(worktree.path)));
  // Git looks for a repository in the parent directories of a `.git` it cannot read: an
  // answer that does not list the tree itself is about another repository.
  return real.includes(await realOrSelf(tree)) ? { listed, real } : undefined;
}

/** The repository `tree` belongs to, marking every worktree it lists as `covered`. */
async function repositoryAt(
  inspection: Inspection,
  tree: string,
  roots: readonly string[],
  covered: Set<string>,
): Promise<RepositoryWork> {
  const path = inspection.shown(tree, roots);
  const found = await listing(inspection, tree);
  if (found === undefined) return unreadableRepository(path);
  for (const real of found.real) covered.add(real);
  const common = await shared(inspection, tree);
  if (common === undefined) return unreadableRepository(path);
  const worktrees: WorktreeWork[] = [];
  for (const worktree of found.listed.filter((entry) => !entry.bare)) {
    if (worktrees.length === WORK_LIMITS.worktrees) {
      inspection.complete = false;
      break;
    }
    worktrees.push(await worktreeWork(inspection, tree, worktree, roots));
  }
  return { path, state: "inspected", ...common, worktrees };
}

async function inspectWork(system: ApplySystem): Promise<WorkInspection> {
  const inspection = new Inspection(system);
  const roots = [...new Set([system.root, await realOrSelf(system.root)])];
  const covered = new Set<string>();
  const repositories: RepositoryWork[] = [];
  for (const tree of await discovered(system, inspection)) {
    if (covered.has(await realOrSelf(tree))) continue;
    if (inspection.outOfTime) break;
    if (repositories.length === WORK_LIMITS.repositories) {
      inspection.complete = false;
      break;
    }
    repositories.push(await repositoryAt(inspection, tree, roots, covered));
  }
  const hostname = system.hostname();
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname: TOKEN.test(hostname) ? hostname : "unknown",
    complete: inspection.complete,
    repositories,
  };
}

export function workerWork(system: ApplySystem): HostWork {
  return {
    async inspectWork() {
      if (!system.isRoot()) throw new Error("host work runs only through the activator");
      return inspectWork(system);
    },
  };
}
