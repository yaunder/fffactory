/**
 * The worker's `ExecutionBackend` (`docs/specs/execution-backend.md` §The `ExecutionBackend`
 * contract) as an in-memory fake, and a stand-in for its selection point, so the worker's
 * endpoints are tested without any backend's commands: it answers as given, records every call
 * and every budget it was selected with.
 */
import type { ControlPlaneAction, WorkerAgents } from "../../src/domain/control-plane";
import type { HostProjection } from "../../src/domain/host-projection";
import { repositoryRegistration } from "../../src/domain/repository-registration";
import type { SecretMaterial } from "../../src/domain/secrets";
import type { BackendSelection, ExecutionBackend } from "../../src/host/execution-backend";

export type BackendCall =
  | { readonly method: "registerRepositories"; readonly checkouts: readonly string[] }
  | { readonly method: "agents" }
  | {
      readonly method: "install";
      readonly projection: HostProjection;
      readonly password: SecretMaterial | undefined;
    }
  | { readonly method: "reload" }
  | { readonly method: "restart" };

export interface BackendAnswers {
  readonly agents?: WorkerAgents;
  readonly install?: ControlPlaneAction;
  readonly reload?: ControlPlaneAction;
  readonly restart?: ControlPlaneAction;
}

const DONE: ControlPlaneAction = { kind: "done" };

/** A backend answering `answers` (by default no agents, nothing registered, every action done). */
export function fakeExecutionBackend(answers: BackendAnswers = {}) {
  const calls: BackendCall[] = [];
  const budgets: number[] = [];
  const backend: ExecutionBackend = {
    async registerRepositories(checkouts) {
      calls.push({ method: "registerRepositories", checkouts: [...checkouts] });
      return repositoryRegistration("paseo", []);
    },
    async agents() {
      calls.push({ method: "agents" });
      return answers.agents ?? { kind: "listed", agents: [] };
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
  const select: BackendSelection = (_system, budgetMs) => {
    budgets.push(budgetMs);
    return backend;
  };
  return { backend, select, calls, budgets };
}
