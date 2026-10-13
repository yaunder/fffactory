/**
 * The work inspection (`docs/specs/host-protocol.md` §work inspect): the current state of every
 * checkout on a worker and every Git worktree attached to them, read fresh by `fffactory host
 * work inspect` just before terminate destroys the machine, where the repository result
 * (`repository-placement.ts`) is only the last synchronization's. The worker reports counts and
 * names; the CLI judges what is unresolved (`workFindings`). Pure.
 */
import { type RemoteCommand, remoteCommand, WORKER_PATHS } from "./host-protocol";
import {
  array,
  type DocumentParse,
  type Fields,
  HOST_PROTOCOL_VERSION,
  Invalid,
  oneOf,
  parseVersioned,
  record,
  string,
  TOKEN,
} from "./protocol-fields";

/** Where the worker looks for checkouts and worktrees, as the runtime account keeps them. */
export const WORK_ROOTS = {
  /** The placed checkouts (`docs/specs/repositories.md`), and any other clone beside them. */
  repositories: "/workspace/repos",
  /** Paseo's worktrees (`SDLC.md` §Worktree ownership), found even when Git no longer lists them. */
  paseoWorktrees: "/home/factory/.paseo/worktrees",
} as const;

/**
 * What one document reports at most: more repositories or worktrees leave the inspection
 * incomplete; more branches carrying unpushed commits are counted, not named.
 */
export const WORK_LIMITS = { repositories: 100, worktrees: 100, namedBranches: 10 } as const;

export const WORKTREE_STATES = ["inspected", "missing", "unreadable"] as const;
/** `missing`: Git lists the worktree, but its directory is gone (prunable). */
export type WorktreeState = (typeof WORKTREE_STATES)[number];

export const REPOSITORY_STATES = ["inspected", "unreadable"] as const;
export type RepositoryState = (typeof REPOSITORY_STATES)[number];

export const OPERATIONS = ["merge", "rebase", "cherry_pick", "revert"] as const;
/** A Git operation left in progress in a worktree. */
export type InProgressOperation = (typeof OPERATIONS)[number];

/** One working tree: a checkout's own, or a worktree linked to it. */
export interface WorktreeWork {
  /** The worktree's path on the worker, or null when it is not printable (`printablePath`). */
  readonly path: string | null;
  /** The branch checked out there; null when HEAD is detached or its name is not printable. */
  readonly branch: string | null;
  readonly state: WorktreeState;
  /** Tracked files changed, staged or unmerged; 0 unless inspected. */
  readonly tracked_changes: number;
  /** Untracked files Git does not ignore; 0 unless inspected. */
  readonly untracked_files: number;
  /** Commits reachable from its HEAD that no remote-tracking branch holds. */
  readonly unpushed_commits: number;
  readonly operation: InProgressOperation | null;
}

/** One repository: what its worktrees share (branches, stashes) and each worktree. */
export interface RepositoryWork {
  /** The working tree it was found through, or null when that is not printable. */
  readonly path: string | null;
  readonly state: RepositoryState;
  /** Commits reachable from any local branch that no remote-tracking branch holds. */
  readonly unpushed_commits: number;
  /** Local branches carrying such commits, at most `WORK_LIMITS.namedBranches`, printable only. */
  readonly unpushed_branches: readonly string[];
  readonly stashes: number;
  readonly worktrees: readonly WorktreeWork[];
}

/** `host work inspect`'s document. */
export interface WorkInspection {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly hostname: string;
  /** False when the worker ran out of time, or found more than it reports. */
  readonly complete: boolean;
  readonly repositories: readonly RepositoryWork[];
}

/** The work inspection as the CLI observed it: `unknown` when it could not be had. */
export type WorkObservation =
  | { readonly kind: "inspected"; readonly inspection: WorkInspection }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      /** The worker's activator offers no work inspection: it predates it. */
      readonly unsupported: boolean;
    };

/** How the CLI asks for it: the activator's fixed operation, which drops to the runtime account. */
export const INSPECT_WORK_COMMAND: RemoteCommand = remoteCommand([
  "sudo",
  "-n",
  WORKER_PATHS.activator,
  "work",
  "inspect",
]);

/** An absolute path of printable ASCII, bounded: what may reach the operator's terminal. */
const PATH = /^\/[\x20-\x7e]{0,255}$/;
/** A branch name of printable ASCII without blanks, bounded. */
const BRANCH = /^[\x21-\x7e]{1,200}$/;

/** `path` when it is safe to print, else null. */
export function printablePath(path: string): string | null {
  return PATH.test(path) ? path : null;
}

/** `branch` when it is safe to print, else null. */
export function printableBranch(branch: string): string | null {
  return BRANCH.test(branch) ? branch : null;
}

function worktreeJson(worktree: WorktreeWork) {
  return {
    path: worktree.path,
    branch: worktree.branch,
    state: worktree.state,
    tracked_changes: worktree.tracked_changes,
    untracked_files: worktree.untracked_files,
    unpushed_commits: worktree.unpushed_commits,
    operation: worktree.operation,
  };
}

function repositoryJson(repository: RepositoryWork) {
  return {
    path: repository.path,
    state: repository.state,
    unpushed_commits: repository.unpushed_commits,
    unpushed_branches: [...repository.unpushed_branches],
    stashes: repository.stashes,
    worktrees: repository.worktrees.map(worktreeJson),
  };
}

/** The document, two-space indented, keys in a stable order. */
export function workInspectionJson(inspection: WorkInspection): string {
  return JSON.stringify(
    {
      protocol_version: inspection.protocol_version,
      hostname: inspection.hostname,
      complete: inspection.complete,
      repositories: inspection.repositories.map(repositoryJson),
    },
    null,
    2,
  );
}

function count(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Invalid(`${path} must be a count`);
  return value as number;
}

function bounded(value: unknown, path: string, limit: number): readonly unknown[] {
  const items = array(value, path);
  if (items.length > limit) throw new Invalid(`${path} has too many entries`);
  return items;
}

function nullableText(value: unknown, path: string, rule: RegExp): string | null {
  return value === null ? null : string(value, path, rule);
}

function readWorktree(value: unknown, path: string): WorktreeWork {
  const fields: Fields = record(value, path);
  return {
    path: nullableText(fields.path, `${path}.path`, PATH),
    branch: nullableText(fields.branch, `${path}.branch`, BRANCH),
    state: oneOf(fields.state, `${path}.state`, WORKTREE_STATES),
    tracked_changes: count(fields.tracked_changes, `${path}.tracked_changes`),
    untracked_files: count(fields.untracked_files, `${path}.untracked_files`),
    unpushed_commits: count(fields.unpushed_commits, `${path}.unpushed_commits`),
    operation:
      fields.operation === null ? null : oneOf(fields.operation, `${path}.operation`, OPERATIONS),
  };
}

function readRepository(value: unknown, path: string): RepositoryWork {
  const fields: Fields = record(value, path);
  const branches = `${path}.unpushed_branches`;
  const worktrees = `${path}.worktrees`;
  return {
    path: nullableText(fields.path, `${path}.path`, PATH),
    state: oneOf(fields.state, `${path}.state`, REPOSITORY_STATES),
    unpushed_commits: count(fields.unpushed_commits, `${path}.unpushed_commits`),
    unpushed_branches: bounded(fields.unpushed_branches, branches, WORK_LIMITS.namedBranches).map(
      (branch, index) => string(branch, `${branches}[${index}]`, BRANCH),
    ),
    stashes: count(fields.stashes, `${path}.stashes`),
    worktrees: bounded(fields.worktrees, worktrees, WORK_LIMITS.worktrees).map((item, index) =>
      readWorktree(item, `${worktrees}[${index}]`),
    ),
  };
}

function readInspection(document: Fields): WorkInspection {
  const hostname = string(document.hostname, "hostname", TOKEN);
  if (typeof document.complete !== "boolean") throw new Invalid("complete must be true or false");
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname,
    complete: document.complete,
    repositories: bounded(document.repositories, "repositories", WORK_LIMITS.repositories).map(
      (item, index) => readRepository(item, `repositories[${index}]`),
    ),
  };
}

/** Reads the document without trusting it; a problem names the field, never its value. */
export function parseWorkInspection(text: string): DocumentParse<WorkInspection> {
  return parseVersioned(text, readInspection);
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const OPERATION_WORDS: Readonly<Record<InProgressOperation, string>> = {
  merge: "a merge in progress",
  rebase: "a rebase in progress",
  cherry_pick: "a cherry-pick in progress",
  revert: "a revert in progress",
};

function worktreeName(worktree: WorktreeWork): string {
  const where = worktree.path ?? "A worktree whose path cannot be printed";
  const head = worktree.branch === null ? "detached HEAD" : `branch ${worktree.branch}`;
  return `${where} (${head}${worktree.state === "missing" ? ", its directory is gone" : ""})`;
}

function worktreeWork(worktree: WorktreeWork): string[] {
  return [
    ...(worktree.tracked_changes > 0
      ? [counted(worktree.tracked_changes, "changed file", "changed files")]
      : []),
    ...(worktree.untracked_files > 0
      ? [counted(worktree.untracked_files, "untracked file", "untracked files")]
      : []),
    ...(worktree.unpushed_commits > 0
      ? [
          counted(
            worktree.unpushed_commits,
            "commit not on any remote",
            "commits not on any remote",
          ),
        ]
      : []),
    ...(worktree.operation === null ? [] : [OPERATION_WORDS[worktree.operation]]),
  ];
}

function repositoryWork(repository: RepositoryWork, where: string): string[] {
  const branches =
    repository.unpushed_branches.length > 0 ? ` (${repository.unpushed_branches.join(", ")})` : "";
  return [
    ...(repository.unpushed_commits > 0
      ? [
          `${where}: ${counted(repository.unpushed_commits, "commit", "commits")} on local branches not on any remote${branches}`,
        ]
      : []),
    ...(repository.stashes > 0
      ? [`${where}: ${counted(repository.stashes, "stash entry", "stash entries")}`]
      : []),
  ];
}

/** What terminating the worker would lose, and what could not be inspected, one line each. */
export interface WorkFindings {
  readonly unresolved: readonly string[];
  readonly uninspected: readonly string[];
}

/**
 * The rule: work is unresolved when a worktree has tracked changes (staged or not, or
 * unmerged), untracked files Git does not ignore, commits no remote-tracking branch holds, or a
 * merge, rebase, cherry-pick or revert in progress, or a repository has such commits on any
 * local branch, or a stash entry. Ignored files are not work. A repository or worktree that
 * could not be read, or an inspection that did not finish, is uninspected. Git is never asked
 * to fetch, so "on a remote" means as of the worker's last fetch or push.
 */
export function workFindings(inspection: WorkInspection): WorkFindings {
  const found = inspection.repositories.map(repositoryFindings);
  const uninspected = found.flatMap((findings) => findings.uninspected);
  if (!inspection.complete)
    uninspected.push(
      "The worker did not inspect every checkout and worktree in time, or found more than it reports",
    );
  return { unresolved: found.flatMap((findings) => findings.unresolved), uninspected };
}

function repositoryFindings(repository: RepositoryWork): WorkFindings {
  const where = repository.path ?? "A repository whose path cannot be printed";
  if (repository.state === "unreadable")
    return { unresolved: [], uninspected: [`${where}: could not be read`] };
  const unresolved = repositoryWork(repository, where);
  const uninspected: string[] = [];
  for (const worktree of repository.worktrees) {
    if (worktree.state === "unreadable") {
      uninspected.push(`${worktreeName(worktree)}: could not be read`);
      continue;
    }
    const work = worktreeWork(worktree);
    if (work.length > 0) unresolved.push(`${worktreeName(worktree)}: ${work.join(", ")}`);
  }
  return { unresolved, uninspected };
}
