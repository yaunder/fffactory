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
  isoTime,
  nullable,
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

export const ARCHIVE_STATES = ["not_collected", "collected"] as const;
/**
 * `not_collected`: no collector is configured on the worker (`/etc/fffactory/collector.json`
 * absent); `collected`: one is, and its backlog was counted.
 */
export type ArchiveState = (typeof ARCHIVE_STATES)[number];

/**
 * What the log archive's collector has not yet archived on the worker (§work inspect): counted
 * from its checkpoint against the sources' current stats (`backlog`, `docs/specs/collector.md`
 * §Backlog), never by reading a source. Counts only: no file's name or content.
 */
export type WorkArchive =
  | { readonly state: "not_collected" }
  | {
      readonly state: "collected";
      /** False when the count stopped at its bound: at least these are unarchived. */
      readonly complete: boolean;
      readonly unarchived_files: number;
      readonly unarchived_bytes: number;
      /** When the collector's last successful run ended, by its checkpoint; null for none. */
      readonly last_success_at: string | null;
    };

/** `host work inspect`'s document. */
export interface WorkInspection {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly hostname: string;
  /** False when the worker ran out of time, or found more than it reports. */
  readonly complete: boolean;
  readonly repositories: readonly RepositoryWork[];
  /**
   * The log archive's backlog, never part of `complete`: a removal reports it, never refuses
   * over it. Absent from a worker whose release predates it, and when the worker's section is
   * malformed: either way the backlog reads unknown.
   */
  readonly archive?: WorkArchive;
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

function archiveJson(archive: WorkArchive) {
  if (archive.state === "not_collected") return { state: archive.state };
  return {
    state: archive.state,
    complete: archive.complete,
    unarchived_files: archive.unarchived_files,
    unarchived_bytes: archive.unarchived_bytes,
    last_success_at: archive.last_success_at,
  };
}

/** The document, two-space indented, keys in a stable order; `archive` only when reported. */
export function workInspectionJson(inspection: WorkInspection): string {
  return JSON.stringify(
    {
      protocol_version: inspection.protocol_version,
      hostname: inspection.hostname,
      complete: inspection.complete,
      repositories: inspection.repositories.map(repositoryJson),
      ...(inspection.archive === undefined ? {} : { archive: archiveJson(inspection.archive) }),
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

function flag(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Invalid(`${path} must be true or false`);
  return value;
}

function readArchive(value: unknown): WorkArchive {
  const fields: Fields = record(value, "archive");
  const state = oneOf(fields.state, "archive.state", ARCHIVE_STATES);
  if (state === "not_collected") return { state };
  return {
    state,
    complete: flag(fields.complete, "archive.complete"),
    unarchived_files: count(fields.unarchived_files, "archive.unarchived_files"),
    unarchived_bytes: count(fields.unarchived_bytes, "archive.unarchived_bytes"),
    last_success_at: nullable(fields.last_success_at, (time) =>
      isoTime(time, "archive.last_success_at"),
    ),
  };
}

/**
 * The archive section, or none when absent or malformed: a collector-side fault loses only the
 * backlog, which then reads unknown, never the work inspection, so it never refuses a removal (S2).
 */
function optionalArchive(value: unknown): { readonly archive?: WorkArchive } {
  if (value === undefined) return {};
  try {
    return { archive: readArchive(value) };
  } catch (error) {
    if (error instanceof Invalid) return {};
    throw error;
  }
}

function readInspection(document: Fields): WorkInspection {
  const hostname = string(document.hostname, "hostname", TOKEN);
  const complete = flag(document.complete, "complete");
  const repositories = bounded(document.repositories, "repositories", WORK_LIMITS.repositories);
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname,
    complete,
    repositories: repositories.map((item, index) => readRepository(item, `repositories[${index}]`)),
    ...optionalArchive(document.archive),
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
 * The placed checkouts (`placed`: factory.json's paths, relative to the repository root) that
 * the inspection reports neither as a repository nor as a worktree of one, as worker paths.
 */
function unreported(inspection: WorkInspection, placed: readonly string[]): string[] {
  const reported = new Set(
    inspection.repositories.flatMap((repository) => [
      repository.path,
      ...repository.worktrees.map((worktree) => worktree.path),
    ]),
  );
  return placed
    .map((path) => `${WORK_ROOTS.repositories}/${path}`)
    .filter((path) => !reported.has(path));
}

/**
 * The rule: work is unresolved when a worktree has tracked changes (staged or not, or
 * unmerged), untracked files Git does not ignore, commits no remote-tracking branch holds, or a
 * merge, rebase, cherry-pick or revert in progress, or a repository has such commits on any
 * local branch, or a stash entry. Ignored files are not work. A repository or worktree that
 * could not be read, an inspection that did not finish, or a checkout factory.json places on
 * the worker (`placed`, relative to the repository root) that the inspection does not report,
 * is uninspected: a checkout the worker did not find is never read as clean. "On a remote" means
 * held by any remote-tracking ref, whatever the remote's URL, as of the worker's last fetch or
 * push: Git is never asked to fetch.
 */
export function workFindings(inspection: WorkInspection, placed: readonly string[]): WorkFindings {
  const found = inspection.repositories.map(repositoryFindings);
  const uninspected = found.flatMap((findings) => findings.uninspected);
  if (!inspection.complete)
    uninspected.push(
      "The worker did not inspect every checkout and worktree in time, or found more than it reports",
    );
  for (const path of unreported(inspection, placed))
    uninspected.push(`${path}: placed on this worker, but the work inspection did not report it`);
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
