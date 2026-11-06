/**
 * The worker side of `host work inspect` (`docs/specs/host-protocol.md` §work inspect): the
 * current state of every checkout under the repository root, every Paseo worktree, and every
 * worktree Git lists for their repositories, read fresh as the runtime account. It changes
 * nothing: Git runs with optional locks off, so no index is refreshed and no lock file is
 * taken, with no fsmonitor hook and no LFS filter (which would clean a stat-stale file into
 * `.git/lfs/objects`), never fetches, and no file's content or name reaches the document. A
 * clean filter a repository defines under another name still runs, as the runtime account, the
 * account whose repository defines it. A populated submodule is inspected as a repository of its
 * own. What it cannot search to the end, it reports incomplete; what Git cannot fully report on
 * (a file it is told to assume unchanged, a directory it warns it cannot open), unreadable.
 */
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  backlog,
  COLLECTOR_CONFIGURATION,
  type Checkpoint,
  parseCheckpoint,
} from "../domain/collector";
import { COLLECTOR_STATE } from "../domain/collector-installation";
import { HOST_PROTOCOL_VERSION, TOKEN } from "../domain/protocol-fields";
import { RUNTIME_ACCOUNT } from "../domain/readiness";
import {
  type InProgressOperation,
  printableBranch,
  printablePath,
  type RepositoryWork,
  type WorkArchive,
  WORK_LIMITS,
  WORK_ROOTS,
  type WorkInspection,
  type WorktreeWork,
} from "../domain/work-inspection";
import type { ApplySystem } from "./apply";
import { CHECKPOINT, discoverSources } from "./collect";

/** Each Git command's bound. */
export const WORK_GIT_TIMEOUT_MS = 20_000;
/**
 * How long after it starts the inspection starts Git commands for, the archive's count and the
 * checkpoint's read included: past it, it reports what it has, incomplete. The last command
 * started may run `WORK_GIT_TIMEOUT_MS` more, so it ends within 95 s, 25 s inside the CLI's
 * 120 s deadline (`INSPECT_WORK_TIMEOUT_MS`) for SSH and the activator.
 */
export const WORK_BUDGET_MS = 75_000;

/**
 * How long, the checkpoint's read included, and over how many entries, the archive's backlog is
 * counted (§work inspect): past either it reports what it counted, `complete: false`. Counted
 * before Git runs, out of `WORK_BUDGET_MS`, so it never lengthens the inspection.
 * TODO(re-evaluate when measured on Acceptance): set from a real worker's Claude root.
 */
export const ARCHIVE_BUDGET_MS = 10_000;
export const ARCHIVE_ENTRY_LIMIT = 200_000;
/** The largest checkpoint read; a larger one is read as none, which overstates the backlog. */
const CHECKPOINT_LIMIT_BYTES = 64 * 1024 * 1024;

/** How deep below each root a checkout or worktree is looked for. */
const SEARCH_DEPTH = { repositories: 4, paseoWorktrees: 3 } as const;
/** How deep below a Git directory's `modules/` a submodule's Git directory is looked for. */
const MODULES_DEPTH = 4;
/** A submodule's mode in the index (a gitlink). */
const GITLINK = "160000";

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
  // Workers install Git LFS system-wide. Its filter, run on a file whose stat no longer matches
  // the index, writes the file into `.git/lfs/objects`; without it, Git compares the file as it
  // is, so such a file reads as changed (the safe side), and every other LFS file as it is.
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.required=false",
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
  /** Repositories reported so far, submodules among them. */
  private reported = 0;

  constructor(private readonly system: ApplySystem) {
    this.started = system.now().getTime();
  }

  /** Whether the budget is spent, which leaves the inspection incomplete. */
  spent(): boolean {
    if (this.system.now().getTime() - this.started >= WORK_BUDGET_MS) {
      this.outOfTime = true;
      this.complete = false;
    }
    return this.outOfTime;
  }

  /** Whether one more repository may be reported: past `WORK_LIMITS`, it is incomplete. */
  admit(): boolean {
    if (this.reported === WORK_LIMITS.repositories) {
      this.complete = false;
      return false;
    }
    this.reported += 1;
    return true;
  }

  /**
   * Git's standard output, or undefined when it failed, or the budget is spent; with `quiet`,
   * also when it wrote anything on standard error, as `git status` does, exiting 0, about a
   * directory it could not open.
   */
  async git(
    directory: string,
    args: readonly string[],
    quiet = false,
  ): Promise<string | undefined> {
    if (this.spent()) return undefined;
    const outcome = await this.system.run(
      [...AS_FACTORY, "-C", directory, ...args],
      WORK_GIT_TIMEOUT_MS,
      { cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } },
    );
    if (outcome.kind !== "exited" || outcome.exitCode !== 0) return undefined;
    return quiet && outcome.stderr !== "" ? undefined : outcome.stdout;
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
 * parent listed it (a name that is not UTF-8 reads back as another), or one at the depth limit
 * that is no working tree but holds directories, which could hold one, or a bare repository,
 * leaves the inspection incomplete.
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
  if (bare(entries)) {
    inspection.complete = false;
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (depth === 0) {
    if (names.length > 0) inspection.complete = false;
    return [];
  }
  const found: string[] = [];
  for (const name of names)
    found.push(...(await workingTrees(join(directory, name), depth - 1, inspection, false)));
  return found;
}

/**
 * Whether a directory's entries look like a bare repository's (`HEAD`, `objects/`, `refs/`). It
 * is not inspected: a clone whose remote it is would count commits pushed only there as safe.
 */
function bare(entries: readonly Dirent[]): boolean {
  const named = (name: string) => entries.find((entry) => entry.name === name);
  const head = named("HEAD");
  return (
    head !== undefined &&
    !head.isDirectory() &&
    named("objects")?.isDirectory() === true &&
    named("refs")?.isDirectory() === true
  );
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

/** An inspected worktree's Git directory (real) and the submodule paths its index holds. */
interface Gitlinks {
  readonly gitDirectory: string;
  readonly paths: readonly string[];
}

/** One worktree's work, whether its Git directory is the repository's own, and its submodules. */
interface Examined {
  readonly work: WorktreeWork;
  readonly owned: boolean;
  readonly gitlinks?: Gitlinks;
}

/** One index entry as `git ls-files -v --stage -z` lists it. */
interface IndexEntry {
  readonly tag: string;
  readonly mode: string;
  readonly path: string;
}

function indexEntries(output: string): IndexEntry[] {
  return output
    .split("\0")
    .filter((field) => field !== "")
    .map((field) => {
      const tab = field.indexOf("\t");
      const [tag = "", mode = ""] = field.slice(0, Math.max(tab, 0)).split(" ");
      return { tag, mode, path: field.slice(tab + 1) };
    });
}

/**
 * Whether an index entry hides a change from `git status`: one Git is told to assume unchanged
 * (a lowercase tag), or one marked skip-worktree (`S`) whose file is on disk. A sparse
 * checkout's skipped files are not on disk: nothing there to lose.
 */
async function hides(inspection: Inspection, worktree: string, entry: IndexEntry) {
  if (entry.tag !== entry.tag.toUpperCase()) return true;
  return entry.tag === "S" && (inspection.spent() || (await exists(join(worktree, entry.path))));
}

/** The worktree's submodule paths, or undefined when an entry hides a change, or Git failed. */
async function gitlinksOf(inspection: Inspection, worktree: string) {
  const output = await inspection.git(worktree, ["ls-files", "-v", "--stage", "-z"]);
  if (output === undefined) return undefined;
  const paths = new Set<string>();
  for (const entry of indexEntries(output)) {
    if (await hides(inspection, worktree, entry)) return undefined;
    if (entry.mode === GITLINK) paths.add(entry.path);
  }
  return [...paths];
}

/**
 * Whether `gitDirectory` (real) is the repository's: its common directory `common` (real), or a
 * linked worktree's directory in its `worktrees/`. A path Git still lists after the worktree was
 * removed without `git worktree prune`, where another repository has since been made, is not.
 */
function ownedBy(common: string, gitDirectory: string): boolean {
  return gitDirectory === common || dirname(gitDirectory) === join(common, "worktrees");
}

async function worktreeWork(
  inspection: Inspection,
  repository: string,
  common: string,
  listed: ListedWorktree,
  roots: readonly string[],
): Promise<Examined> {
  const branchName = listed.branch?.startsWith("refs/heads/")
    ? listed.branch.slice("refs/heads/".length)
    : undefined;
  const base = {
    path: inspection.shown(listed.path, roots),
    branch: branchName === undefined ? null : printableBranch(branchName),
  };
  const unpushed = await unpushedFrom(inspection, repository, listed.head);
  const unreadable = (): Examined => ({
    work: {
      ...base,
      state: "unreadable",
      tracked_changes: 0,
      untracked_files: 0,
      unpushed_commits: unpushed ?? 0,
      operation: null,
    },
    owned: false,
  });
  if (unpushed === undefined) return unreadable();
  // TODO(re-evaluate when a worker's agents initialise submodules in Paseo worktrees): a missing
  // worktree's own `.git/worktrees/<id>/modules/` can still hold submodule commits pushed
  // nowhere; report each Git directory there as unreadable, as `unusedModules` does.
  if (listed.prunable || !(await exists(listed.path)))
    return {
      work: {
        ...base,
        state: "missing",
        tracked_changes: 0,
        untracked_files: 0,
        unpushed_commits: unpushed,
        operation: null,
      },
      owned: false,
    };
  const gitDirectory = (
    await inspection.git(listed.path, ["rev-parse", "--absolute-git-dir"])
  )?.trim();
  if (gitDirectory === undefined || gitDirectory === "") return unreadable();
  // Another repository at a path this one still lists: what is there is not this worktree.
  if (!ownedBy(common, await realOrSelf(gitDirectory))) return unreadable();
  const found = await changes(inspection, listed.path);
  if (found === undefined) return { ...unreadable(), owned: true };
  return {
    work: {
      ...base,
      state: "inspected",
      tracked_changes: found.tracked,
      untracked_files: found.untracked,
      unpushed_commits: unpushed,
      operation: await operationIn(gitDirectory),
    },
    owned: true,
    gitlinks: { gitDirectory: await realOrSelf(gitDirectory), paths: found.paths },
  };
}

/**
 * A worktree's changes and submodule paths, or undefined when Git cannot fully report them: it
 * failed, warned (about a directory it could not open), or an index entry hides a change.
 */
async function changes(inspection: Inspection, worktree: string) {
  const status = await inspection.git(
    worktree,
    ["status", "--porcelain=v2", "--untracked-files=normal", "--ignore-submodules=none", "-z"],
    true,
  );
  const paths = status === undefined ? undefined : await gitlinksOf(inspection, worktree);
  if (status === undefined || paths === undefined) return undefined;
  return { ...statusCounts(status), paths };
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

/**
 * Whether `root` (a path on the worker) is reached through no symbolic link: `readdir`, as root,
 * would follow one wherever it points. Absent (from its first missing component on) is fine.
 * Anything else, a link or a component that cannot be read, is not.
 */
async function unlinked(system: ApplySystem, root: string): Promise<boolean> {
  let path = system.root;
  for (const component of root.split("/").filter((part) => part !== "")) {
    path = join(path, component);
    try {
      if ((await lstat(path)).isSymbolicLink()) return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return true;
}

/** The working trees under one search root; one reached through a link leaves it incomplete. */
async function searched(
  system: ApplySystem,
  inspection: Inspection,
  root: string,
  depth: number,
): Promise<string[]> {
  if (await unlinked(system, root)) return workingTrees(join(system.root, root), depth, inspection);
  inspection.complete = false;
  return [];
}

/** Every checkout under the repository root, then every Paseo worktree, in path order. */
async function discovered(system: ApplySystem, inspection: Inspection): Promise<string[]> {
  return [
    ...(await searched(system, inspection, WORK_ROOTS.repositories, SEARCH_DEPTH.repositories)),
    ...(await searched(system, inspection, WORK_ROOTS.paseoWorktrees, SEARCH_DEPTH.paseoWorktrees)),
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

/** The repository's common Git directory, real, as Git finds it from `tree`, or undefined. */
async function commonDirectory(inspection: Inspection, tree: string): Promise<string | undefined> {
  const output = (await inspection.git(tree, ["rev-parse", "--git-common-dir"]))?.trim();
  return output === undefined || output === "" ? undefined : realOrSelf(resolve(tree, output));
}

/** The worktrees a repository lists, with their real paths. */
interface Listing {
  readonly listed: readonly ListedWorktree[];
  readonly real: readonly string[];
}

/**
 * The repository `tree` belongs to, then its submodules', marking as `covered` the tree and
 * every worktree it lists whose Git directory is its own: any other path it lists is left to
 * be found, and inspected, as the repository it is.
 */
async function repositoryAt(
  inspection: Inspection,
  tree: string,
  roots: readonly string[],
  covered: Set<string>,
): Promise<RepositoryWork[]> {
  const path = inspection.shown(tree, roots);
  covered.add(await realOrSelf(tree));
  const found = await listing(inspection, tree);
  const common = found === undefined ? undefined : await commonDirectory(inspection, tree);
  if (found === undefined || common === undefined) return [unreadableRepository(path)];
  return repositoryWork(inspection, { tree, path, common, found }, roots, covered);
}

/** A repository found through `tree`: its common Git directory and the worktrees it lists. */
interface Found {
  readonly tree: string;
  readonly path: string | null;
  readonly common: string;
  readonly found: Listing;
}

/** The repository's work, then that of the submodules of its worktrees. */
async function repositoryWork(
  inspection: Inspection,
  repository: Found,
  roots: readonly string[],
  covered: Set<string>,
): Promise<RepositoryWork[]> {
  const sharedWork = await shared(inspection, repository.tree);
  if (sharedWork === undefined) return [unreadableRepository(repository.path)];
  const { worktrees, submodules } = await listedWork(inspection, repository, roots, covered);
  return [{ path: repository.path, state: "inspected", ...sharedWork, worktrees }, ...submodules];
}

/**
 * Each worktree listed but a bare entry, marking those it owns as `covered`, and the
 * submodules of each inspected one.
 */
async function listedWork(
  inspection: Inspection,
  { tree, common, found }: Found,
  roots: readonly string[],
  covered: Set<string>,
): Promise<{ worktrees: WorktreeWork[]; submodules: RepositoryWork[] }> {
  const worktrees: WorktreeWork[] = [];
  const submodules: RepositoryWork[] = [];
  for (const [index, worktree] of found.listed.entries()) {
    if (worktree.bare) continue;
    if (worktrees.length === WORK_LIMITS.worktrees) {
      inspection.complete = false;
      break;
    }
    const { work, owned, gitlinks } = await worktreeWork(inspection, tree, common, worktree, roots);
    if (owned) covered.add(found.real[index] ?? worktree.path);
    worktrees.push(work);
    if (gitlinks !== undefined)
      submodules.push(...(await submodulesOf(inspection, worktree.path, gitlinks, roots, covered)));
  }
  return { worktrees, submodules };
}

/**
 * What a submodule's directory holds: a repository (`.git`), nothing to lose (no directory, or
 * an empty one, never initialized), or files Git does not see, which `git status` of the
 * worktree holding it never reports.
 */
async function submoduleKind(directory: string): Promise<"populated" | "absent" | "unmanaged"> {
  let names: string[];
  try {
    if (!(await lstat(directory)).isDirectory()) return "absent";
    names = await readdir(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unmanaged";
  }
  if (names.includes(".git")) return "populated";
  return names.length === 0 ? "absent" : "unmanaged";
}

/**
 * The submodules of an inspected worktree, each a repository of its own, counted against the
 * repositories reported: one populated is inspected; a directory holding files but no
 * repository is unreadable, as is a submodule Git directory in the worktree's `modules/` that
 * no populated submodule uses (de-initialized, or removed from the branch), whose commits
 * would be lost with the worker.
 */
async function submodulesOf(
  inspection: Inspection,
  worktree: string,
  gitlinks: Gitlinks,
  roots: readonly string[],
  covered: Set<string>,
): Promise<RepositoryWork[]> {
  const repositories: RepositoryWork[] = [];
  const used = new Set<string>();
  for (const path of gitlinks.paths) {
    const directory = join(worktree, path);
    const kind = await submoduleKind(directory);
    if (kind === "absent") continue;
    if (inspection.outOfTime || !inspection.admit()) return repositories;
    repositories.push(
      ...(kind === "unmanaged"
        ? [unreadableRepository(inspection.shown(directory, roots))]
        : await submoduleAt(inspection, directory, gitlinks.gitDirectory, roots, covered, used)),
    );
  }
  return [...repositories, ...(await unusedModules(inspection, gitlinks, used, roots))];
}

/** The submodule Git directories in the worktree's `modules/` not among `used`, unreadable. */
async function unusedModules(
  inspection: Inspection,
  { gitDirectory }: Gitlinks,
  used: ReadonlySet<string>,
  roots: readonly string[],
): Promise<RepositoryWork[]> {
  const modules = await gitDirectories(join(gitDirectory, "modules"), MODULES_DEPTH, inspection);
  const unused: RepositoryWork[] = [];
  for (const module of modules.filter((found) => !used.has(found))) {
    if (!inspection.admit()) break;
    unused.push(unreadableRepository(inspection.shown(module, roots)));
  }
  return unused;
}

/**
 * Directories below `directory` (`modules/`), at most `depth` levels down, that look like a Git
 * directory (`bare`), below which nothing is looked for: a submodule's name may hold slashes.
 * As for `workingTrees`, what cannot be searched to the end leaves the inspection incomplete.
 */
async function gitDirectories(
  directory: string,
  depth: number,
  inspection: Inspection,
  top = true,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (!top || (error as NodeJS.ErrnoException).code !== "ENOENT") inspection.complete = false;
    return [];
  }
  if (!top && bare(entries)) return [directory];
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (depth === 0) {
    if (names.length > 0) inspection.complete = false;
    return [];
  }
  const found: string[] = [];
  for (const name of names.sort())
    found.push(...(await gitDirectories(join(directory, name), depth - 1, inspection, false)));
  return found;
}

/**
 * The populated submodule at `directory` of a worktree whose Git directory is `parent`, as a
 * repository whose first worktree is `directory` itself (Git lists a submodule's Git directory
 * there instead), then its own submodules. It is its own only when Git, from there, finds that
 * directory its top level and a common Git directory in `parent`'s `modules/` (absorbed), or
 * its own `.git` directory; anything else, Git found from a `.git` it cannot read, or one that
 * leads elsewhere, is unreadable.
 */
async function submoduleAt(
  inspection: Inspection,
  directory: string,
  parent: string,
  roots: readonly string[],
  covered: Set<string>,
  used: Set<string>,
): Promise<RepositoryWork[]> {
  const path = inspection.shown(directory, roots);
  const real = await realOrSelf(directory);
  covered.add(real);
  const common = await submoduleCommon(inspection, directory, real, parent);
  const output =
    common === undefined
      ? undefined
      : await inspection.git(directory, ["worktree", "list", "--porcelain", "-z"]);
  const [first, ...others] = output === undefined ? [] : parseWorktrees(output);
  if (common === undefined || first === undefined) return [unreadableRepository(path)];
  used.add(common);
  const found = {
    listed: [{ ...first, path: directory, bare: false }, ...others],
    real: [real, ...(await Promise.all(others.map((worktree) => realOrSelf(worktree.path))))],
  };
  return repositoryWork(inspection, { tree: directory, path, common, found }, roots, covered);
}

/** The submodule's common Git directory (real), when it is the submodule's own. */
async function submoduleCommon(
  inspection: Inspection,
  directory: string,
  real: string,
  parent: string,
): Promise<string | undefined> {
  const output = await inspection.git(directory, [
    "rev-parse",
    "--show-toplevel",
    "--git-common-dir",
  ]);
  const [top, common] = output?.split("\n") ?? [];
  if (!top || !common || (await realOrSelf(top)) !== real) return undefined;
  const resolved = await realOrSelf(resolve(directory, common));
  return resolved.startsWith(`${parent}/modules/`) || resolved === join(real, ".git")
    ? resolved
    : undefined;
}

/** Whether a path is absent: a lookup that fails otherwise finds something there. */
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/**
 * The collector's checkpoint, read as root: never through a symbolic link, never anything but
 * a regular file of at most `CHECKPOINT_LIMIT_BYTES`. One that cannot be read is none, as it is
 * to the collector, whose next run captures every source whole.
 */
async function savedCheckpoint(root: string): Promise<Checkpoint | null> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    const handle = await open(join(root, COLLECTOR_STATE, CHECKPOINT), flags);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > CHECKPOINT_LIMIT_BYTES) return null;
      const parsed = parseCheckpoint(await handle.readFile("utf8"));
      return parsed.ok ? parsed.document : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * The log archive's backlog (§work inspect): not collected without the collector's
 * configuration; otherwise its checkpoint against the sources' current stats, found by the
 * collector's own discovery, within `ARCHIVE_BUDGET_MS` and `ARCHIVE_ENTRY_LIMIT`.
 */
async function archiveBacklog(system: ApplySystem): Promise<WorkArchive> {
  const root = await realOrSelf(system.root);
  if (await absent(join(root, COLLECTOR_CONFIGURATION))) return { state: "not_collected" };
  const deadline = system.now().getTime() + ARCHIVE_BUDGET_MS;
  const checkpoint = await savedCheckpoint(root);
  let entries = 0;
  const more = () => {
    entries += 1;
    return entries <= ARCHIVE_ENTRY_LIMIT && system.now().getTime() < deadline;
  };
  const discovery = await discoverSources(root, more);
  const unarchived = backlog(checkpoint, discovery.observed);
  return {
    state: "collected",
    complete: discovery.complete,
    unarchived_files: unarchived.files,
    unarchived_bytes: unarchived.bytes,
    last_success_at: checkpoint?.last_success_at ?? null,
  };
}

async function inspectWork(system: ApplySystem): Promise<WorkInspection> {
  // The budget starts before the archive's count, so its time comes out of the same total.
  const inspection = new Inspection(system);
  const archive = await archiveBacklog(system);
  const roots = [...new Set([system.root, await realOrSelf(system.root)])];
  const covered = new Set<string>();
  const repositories: RepositoryWork[] = [];
  for (const tree of await discovered(system, inspection)) {
    if (covered.has(await realOrSelf(tree))) continue;
    if (inspection.outOfTime || !inspection.admit()) break;
    repositories.push(...(await repositoryAt(inspection, tree, roots, covered)));
  }
  const hostname = system.hostname();
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname: TOKEN.test(hostname) ? hostname : "unknown",
    complete: inspection.complete,
    repositories,
    archive,
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
