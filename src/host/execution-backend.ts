/**
 * The worker's execution backend (CONTEXT.md: the selected mechanism for hosting and supervising
 * runs on a worker), as far as fffactory asks it anything: the worker's one execution-backend
 * interface (`docs/specs/execution-backend.md` §The `ExecutionBackend` contract) and its one
 * selection point. A worker-side seam, not an `application/` port: nothing on the operator side
 * calls it. Its results are in fffactory's states and words, never the backend's own.
 */
import type { ControlPlaneAction } from "../domain/control-plane";
import type { HostProjection } from "../domain/host-projection";
import type { RepositoryRegistration } from "../domain/repository-registration";
import type { LaunchedWork, RunRequest, RunStart, WorkerRuns } from "../domain/run";
import type { SecretMaterial } from "../domain/secrets";
import type { ApplySystem } from "./apply";
import { paseoBackend } from "./paseo-backend";

export interface ExecutionBackend {
  /**
   * Makes each checkout (the absolute path of a placed checkout present on disk) available for
   * supervision. Only adds: never deletes, renames or archives anything the backend holds, and
   * never reloads or restarts it.
   */
  registerRepositories(checkouts: readonly string[]): Promise<RepositoryRegistration>;
  /**
   * Starts a run for `request`'s launch identity, in a fresh workspace made from its checkout, on
   * a new branch from its base: its handle, or why not in fffactory's words.
   */
  startRun(request: RunRequest): Promise<RunStart>;
  /**
   * The runs the backend holds, in fffactory's states, each with whether dispatch launched it;
   * given `work`, only the runs dispatch launched for it, in any state, each with that work.
   * Unknown, with fffactory's reason, when any of it cannot be read.
   */
  runs(work?: LaunchedWork): Promise<WorkerRuns>;
  /**
   * Installs the backend's software for the host `projection` describes, with the password the
   * projection references, read by the caller (none when it references none). Never starts or
   * restarts it.
   */
  install(
    projection: HostProjection,
    password: SecretMaterial | undefined,
  ): Promise<ControlPlaneAction>;
  /** Makes the running backend take its installed configuration; `done` for one with no daemon. */
  reload(): Promise<ControlPlaneAction>;
  /** Restarts the backend; `done` for one with no daemon. */
  restart(): Promise<ControlPlaneAction>;
}

/**
 * Chooses the worker's backend on `system`, every command it runs within `budgetMs` from now.
 * `environment` is the one of the process it acts for, which a backend run as that process runs
 * its commands in; without it, the backend's own.
 */
export type BackendSelection = (
  system: ApplySystem,
  budgetMs: number,
  environment?: Readonly<Record<string, string>>,
) => ExecutionBackend;

/** The worker's execution backend: the one place it is chosen. */
// TODO(re-evaluate when a second execution backend adapter is built): select the backend from factory.json's hosts[].execution_backend
export const executionBackend: BackendSelection = (system, budgetMs, environment) =>
  paseoBackend(system, budgetMs, environment);
