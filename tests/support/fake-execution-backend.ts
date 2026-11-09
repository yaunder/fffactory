/**
 * The worker's `ExecutionBackend` (`docs/specs/execution-backend.md` §The `ExecutionBackend`
 * contract) as an in-memory fake, and a stand-in for its selection point, so the worker's
 * endpoints and the dispatcher are tested without any backend's commands: it answers as given,
 * keeps to the run contract (asked for some work's runs, only the dispatched runs launched for
 * it, by `launchedFor`), and records every call and every budget and environment it was
 * selected with. Its layout is Paseo's unless given, so what a worker reads and writes by it
 * stays byte for byte what the Paseo backend's gives.
 */
import type { ControlPlaneAction } from "../../src/domain/control-plane";
import type { HostProjection } from "../../src/domain/host-projection";
import { repositoryRegistration } from "../../src/domain/repository-registration";
import {
  type LaunchedWork,
  launchedFor,
  type RunRequest,
  type RunStart,
  type WorkerRuns,
} from "../../src/domain/run";
import type { SecretMaterial } from "../../src/domain/secrets";
import type {
  BackendLayout,
  BackendSelection,
  ExecutionBackend,
} from "../../src/host/execution-backend";

export type BackendCall =
  | { readonly method: "registerRepositories"; readonly checkouts: readonly string[] }
  | { readonly method: "runs"; readonly work?: LaunchedWork }
  | { readonly method: "startRun"; readonly request: RunRequest }
  | {
      readonly method: "install";
      readonly projection: HostProjection;
      readonly password: SecretMaterial | undefined;
    }
  | { readonly method: "layout" }
  | { readonly method: "reload" }
  | { readonly method: "restart" };

export interface BackendAnswers {
  /** Every run the backend holds, or how to read them afresh at each call. */
  readonly runs?: WorkerRuns | (() => Promise<WorkerRuns>);
  /** How a start ends, or how to start the run (by default, started as `run-1`). */
  readonly startRun?: RunStart | ((request: RunRequest) => Promise<RunStart>);
  readonly layout?: BackendLayout;
  readonly install?: ControlPlaneAction;
  readonly reload?: ControlPlaneAction;
  readonly restart?: ControlPlaneAction;
}

/**
 * The Paseo backend's layout (`src/host/paseo-backend.ts`), as `tests/host/paseo-backend.test.ts`
 * pins it.
 */
export const PASEO_LAYOUT: BackendLayout = {
  workspaceRoots: [{ path: "/home/factory/.paseo/worktrees", depth: 3 }],
  privateFiles: ["/home/factory/.paseo/config.json"],
};

const DONE: ControlPlaneAction = { kind: "done" };
const STARTED: RunStart = { kind: "started", handle: { id: "run-1" } };

/**
 * A backend answering `answers` (by default no runs, nothing registered, every action done, and
 * Paseo's layout).
 */
export function fakeExecutionBackend(answers: BackendAnswers = {}) {
  const calls: BackendCall[] = [];
  const budgets: number[] = [];
  const environments: (Readonly<Record<string, string>> | undefined)[] = [];
  const backend: ExecutionBackend = {
    async registerRepositories(checkouts) {
      calls.push({ method: "registerRepositories", checkouts: [...checkouts] });
      return repositoryRegistration("paseo", []);
    },
    async startRun(request) {
      calls.push({ method: "startRun", request });
      const start = answers.startRun ?? STARTED;
      return typeof start === "function" ? start(request) : start;
    },
    async runs(work) {
      calls.push(work === undefined ? { method: "runs" } : { method: "runs", work });
      const answer = answers.runs ?? { kind: "listed", runs: [] };
      const runs = typeof answer === "function" ? await answer() : answer;
      if (work === undefined || runs.kind !== "listed") return runs;
      return { kind: "listed", runs: launchedFor(runs.runs, work) };
    },
    layout() {
      calls.push({ method: "layout" });
      return answers.layout ?? PASEO_LAYOUT;
    },
    async install(projection, password) {
      calls.push({ method: "install", projection, password });
      return answers.install ?? DONE;
    },
    async reload() {
      calls.push({ method: "reload" });
      return answers.reload ?? DONE;
    },
    async restart() {
      calls.push({ method: "restart" });
      return answers.restart ?? DONE;
    },
  };
  const select: BackendSelection = (_system, budgetMs, environment) => {
    budgets.push(budgetMs);
    environments.push(environment);
    return backend;
  };
  return { backend, select, calls, budgets, environments };
}
