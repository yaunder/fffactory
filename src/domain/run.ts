/**
 * Runs on the worker's execution backend (`docs/specs/execution-backend.md` §The run contract):
 * what starting one asks, what it answers, a run as the backend reports it in fffactory's states,
 * and the launch identity's equality the duplicate check uses. No backend's flags, labels or
 * statuses: the adapter translates them.
 */
import type { Agent, WorkerAgents } from "./control-plane";

/** The work a run is launched for: a placed repository, by its alias, and the work item (the epic). */
export interface LaunchedWork {
  readonly repository: string;
  readonly workItem: number;
}

/** A launch's identity: its work, and its attempt, the UTC stamp it was launched at. */
export interface LaunchIdentity extends LaunchedWork {
  readonly attempt: string;
}

/** Whether two launches are for the same work, whatever their attempts: the duplicate rule. */
export const sameWork = (a: LaunchedWork, b: LaunchedWork): boolean =>
  a.repository === b.repository && a.workItem === b.workItem;

/** The coding agent a run starts. */
export interface AgentSettings {
  readonly provider: string;
  readonly model: string;
  readonly mode: string;
}

/** What starting a run asks of the backend. */
export interface RunRequest {
  readonly launch: LaunchIdentity;
  /** The placed checkout's absolute path, which the run's fresh workspace is made from. */
  readonly checkout: string;
  /** The ref the run's new branch starts from (`origin/BRANCH`). */
  readonly base: string;
  /** The branch the fresh workspace starts on. */
  readonly branch: string;
  /** The workflow invocation: the agent's prompt. */
  readonly invocation: string;
  readonly agent: AgentSettings;
}

// TODO(re-evaluate when a caller reads a started run's workspace): add its path to RunHandle
/** A started run, by the backend's own ID for it. */
export interface RunHandle {
  readonly id: string;
}

/** How starting a run ended: its handle, or why not in fffactory's words. */
export type RunStart =
  | { readonly kind: "started"; readonly handle: RunHandle }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * A run the backend holds: its agent's ID and fffactory state, whether dispatch launched it, and
 * the work dispatch launched it for when the backend reports it (it always does for the runs
 * asked for by their work).
 */
export interface Run extends Agent {
  readonly work?: LaunchedWork;
}

/** A worker's runs as its backend read them, or why they could not be read. */
export type WorkerRuns =
  | { readonly kind: "listed"; readonly runs: readonly Run[] }
  | { readonly kind: "unknown"; readonly reason: string };

/** The runs dispatch launched for `work`, in any state: an epic is never launched twice. */
export const launchedFor = (runs: readonly Run[], work: LaunchedWork): readonly Run[] =>
  runs.filter((run) => run.dispatched && run.work !== undefined && sameWork(run.work, work));

/** A worker's runs as its agents (`docs/specs/control-plane.md` §Agent states). */
export function workerAgents(runs: WorkerRuns): WorkerAgents {
  if (runs.kind === "unknown") return runs;
  return {
    kind: "listed",
    agents: runs.runs.map(({ id, state, dispatched }) => ({ id, state, dispatched })),
  };
}
