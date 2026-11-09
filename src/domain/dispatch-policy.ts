/**
 * Dispatch policy (`docs/specs/dispatch.md` §The dispatcher, §Capacity): the pure rules the
 * worker's dispatcher (`host/dispatcher.ts`) applies to what it observed: which repositories it
 * considers, when an epic is ready, how many slots are taken, what a launch is named, and the
 * summary it prints. Its expressions are the Python dispatcher's it replaces, so readiness is
 * unchanged by the port for the ASCII, LF or CRLF text GitHub's markers are written in.
 */
import { type Agent, workerActivity } from "./control-plane";
import { array, type Fields, Invalid, record } from "./protocol-fields";

/** A worker runs at most this many dispatched epic agents at a time. */
export const DISPATCH_CAPACITY = 1;

/** A tool's output, its surrounding whitespace stripped. */
export const toolText = (raw: string) => raw.trim();

const SLUG =
  /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|git:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;

/** The `owner/name` a GitHub remote names, lowercased; undefined for any other remote. */
export function githubSlug(remote: string): string | undefined {
  return SLUG.exec(remote)?.[1]?.toLowerCase();
}

/** A repository the worker's manifest places on it, by its alias. */
export interface DispatchRepository {
  readonly alias: string;
  readonly remote: string;
  /** Its checkout's path under the repository root. */
  readonly path: string;
  readonly branch: string;
}

export type DispatchRepositories =
  | { readonly ok: true; readonly repositories: readonly DispatchRepository[] }
  | { readonly ok: false; readonly reason: string };

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Invalid(`${path} is missing`);
  return value;
}

function repositoryOf(repositories: Fields, alias: string): DispatchRepository {
  if (!Object.hasOwn(repositories, alias)) throw new Invalid(`${alias} is missing`);
  const fields = record(repositories[alias], alias);
  const path = text(fields.path, `${alias}.path`);
  if (path === "" || path.startsWith("/")) throw new Invalid(`${alias}.path is not relative`);
  return {
    alias,
    remote: text(fields.remote, `${alias}.remote`),
    path,
    branch: text(fields.branch, `${alias}.branch`),
  };
}

/** The repositories every set `hosts[host]` names, sorted by alias. Throws `Invalid`. */
function placedOn(manifest: Fields, hosts: Fields, host: string) {
  const sets = record(manifest.repository_sets, "repository_sets");
  const aliases = new Set<string>();
  for (const set of array(record(hosts[host], host).repository_sets, host)) {
    if (typeof set !== "string" || !Object.hasOwn(sets, set)) throw new Invalid("a set is missing");
    for (const alias of array(sets[set], set)) aliases.add(text(alias, set));
  }
  const repositories = record(manifest.repositories, "repositories");
  return [...aliases].sort().map((alias) => repositoryOf(repositories, alias));
}

/**
 * The repositories the worker's repository manifest (its text) places on `host`, sorted by
 * alias, each with its remote, checkout path and branch; or why not.
 */
export function dispatchRepositories(manifestText: string, host: string): DispatchRepositories {
  let value: unknown;
  try {
    value = JSON.parse(manifestText);
  } catch {
    return { ok: false, reason: "the repository manifest is not JSON" };
  }
  try {
    const manifest = record(value, "the repository manifest");
    const hosts = record(manifest.hosts, "hosts");
    if (!Object.hasOwn(hosts, host))
      return { ok: false, reason: `host ${host} is absent from the deployed manifest` };
    return { ok: true, repositories: placedOn(manifest, hosts, host) };
  } catch (error) {
    if (error instanceof Invalid)
      return { ok: false, reason: "the repository manifest is invalid" };
    throw error;
  }
}

/** One of an epic's captured tasks, as the task list names it. */
export interface EpicTask {
  readonly number: number;
  readonly state: string;
}

/** A task's issue as read: its body, and each comment's body. */
export interface TaskIssue {
  readonly body: string;
  readonly comments: readonly string[];
}

/** An open pull request: its number, title and body. */
export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

/** A state GitHub reports, regardless of case. */
export const isOpen = (state: string) => state.toUpperCase() === "OPEN";
export const isClosed = (state: string) => state.toUpperCase() === "CLOSED";

/** `Depends on: #N` at a line's start. */
const DEPENDS = /^\s*(?:[-*]\s*)?Depends on:?\s*#(\d+)\b/gim;

/**
 * The issues a task's body and comments say it depends on that are not tasks of its own epic,
 * in ascending order: each must be closed for the epic to be ready.
 */
export function externalDependencies(
  issue: TaskIssue,
  epicTasks: ReadonlySet<number>,
): readonly number[] {
  const text = [issue.body, ...issue.comments].join("\n");
  const numbers = new Set([...text.matchAll(DEPENDS)].map((match) => Number(match[1])));
  return [...numbers].filter((number) => !epicTasks.has(number)).sort((a, b) => a - b);
}

/** The first open pull request whose title or body names `#task`, its exact number. */
export function pullRequestFor(task: number, prs: readonly PullRequest[]): PullRequest | undefined {
  const marker = new RegExp(`(?<!\\d)#${task}(?!\\d)`);
  return prs.find((pr) => marker.test(`${pr.title}\n${pr.body}`));
}

/** The branch FFFlow's `work-epic` works an epic on; its existence on the remote holds the epic. */
export const epicBranch = (epic: number) => `epic/${epic}`;

const pad = (value: number) => String(value).padStart(2, "0");

/** A launch's attempt stamp: `now` in UTC, `YYYYMMDDTHHMMSSZ`. */
export function dispatchStamp(now: Date): string {
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  return `${date}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

/** The branch a launch's fresh workspace starts on. */
export const dispatchBranch = (epic: number, stamp: string) => `dispatch/epic-${epic}-${stamp}`;

/** The slots dispatch's agents hold: the dispatched ones the busy rule counts. */
export function busyDispatched(agents: readonly Agent[]): number {
  const activity = workerActivity({
    kind: "listed",
    agents: agents.filter((agent) => agent.dispatched),
  });
  return activity.kind === "busy" ? activity.working + activity.needsInput : 0;
}

/** Whether `running` dispatched agents leave no slot. */
export const capacityReached = (running: number) => running >= DISPATCH_CAPACITY;

/** Why an epic, or a repository's epics, were not launched. */
export const SKIPS = {
  noTasks: "no captured tasks",
  taskNotOpen: (task: number) => `task #${task} is not open`,
  openDependency: (task: number, dependency: number) =>
    `task #${task} has open external dependency #${dependency}`,
  openPullRequest: (task: number, pr: number) => `task #${task} has open PR #${pr}`,
  branchExists: (epic: number) => `remote branch ${epicBranch(epic)} already exists`,
  capReached: "host cap reached",
  dispatched: "existing dispatched agent",
  adoption: (error: string) => `FFFlow adoption check failed: ${error}`,
} as const;

export interface ConsideredEpic {
  readonly repository: string;
  readonly epic: number;
}

export type Skipped =
  | { readonly repository: string; readonly reason: string }
  | { readonly repository: string; readonly epic: number; readonly reason: string };

export interface Started {
  readonly repository: string;
  readonly epic: number;
  readonly agent_id: unknown;
}

/** What one tick considered, skipped and started, as it prints it. */
export interface DispatchSummary {
  readonly host: string;
  readonly cap: number;
  readonly running: number;
  readonly considered: readonly ConsideredEpic[];
  readonly skipped: readonly Skipped[];
  readonly started: readonly Started[];
  readonly running_after: number;
}

/** The adoption-only run's report. */
export interface AdoptionReport {
  readonly adoption: "passed" | "failed";
  readonly failed_repositories: readonly string[];
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const dispatchSummaryJson = (summary: DispatchSummary) => json(summary);
export const adoptionReportJson = (report: AdoptionReport) => json(report);
