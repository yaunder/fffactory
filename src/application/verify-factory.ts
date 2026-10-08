/**
 * Apply's end-to-end verification stage (`docs/specs/dispatch.md` §End-to-end verification): the
 * last stage, after dispatch. It joins every declared worker's outcome across the reconciling
 * stages — the workers stage's install and verification, the repository stage's synchronization,
 * the control-plane stage's reconciliation, and the dispatch stage's activation — into one
 * composite verdict per worker and for the factory as a whole. It is pure: it reads the outcomes
 * the stages already produced and reaches no worker itself.
 *
 * The factory is ready only when every worker's release is healthy, its repositories are
 * synchronized, its control plane was fully applied (not deferred or failed), and its requested
 * dispatch is active. A pending dispatch, a deferred maintenance or a skipped worker is not a
 * failure, but the factory has not reached its requested end state until a later apply completes
 * it. A worker the workers stage skipped keeps whatever release it had: its release is left as
 * it is, never absent, and its verdict names the skip and its next action.
 */
import type { ControlPlaneOutcome } from "./apply-control-plane";
import type { DispatchOutcome } from "./apply-dispatch";
import type { RepositoryOutcome } from "./apply-repositories";
import type { HostKey } from "../domain/instance";
import type { WorkerOutcome } from "../domain/rollout";

export interface VerifyFactoryRequest {
  readonly workers: readonly WorkerOutcome[];
  readonly repositories: readonly RepositoryOutcome[];
  readonly controlPlane: readonly ControlPlaneOutcome[];
  readonly dispatch: readonly DispatchOutcome[];
}

/**
 * `skipped`: the workers stage skipped the worker, leaving its release as it is. `absent`: the
 * rollout stopped before it (`not_attempted`), which no verified apply reaches.
 */
export type ReleaseVerdict = "healthy" | "unhealthy" | "skipped" | "absent";
export type RepositoriesVerdict = "synchronized" | "unresolved" | "skipped" | "unknown";
export type ControlPlaneVerdict = "applied" | "deferred" | "failed" | "unknown";
export type DispatchVerdict = "active" | "pending" | "not_requested" | "failed" | "skipped";

/** One worker's composite end-to-end verdict. */
export interface WorkerVerification {
  readonly key: HostKey;
  readonly hostname: string;
  readonly release: ReleaseVerdict;
  readonly repositories: RepositoriesVerdict;
  readonly controlPlane: ControlPlaneVerdict;
  readonly dispatch: DispatchVerdict;
  /** Whether the worker reached its requested end state. */
  readonly ready: boolean;
  readonly summary: string;
  /** Anything not ready, in fffactory's own words. */
  readonly details: readonly string[];
}

export interface FactoryVerification {
  readonly ready: boolean;
  readonly workers: readonly WorkerVerification[];
  readonly summary: string;
}

function releaseVerdict(outcome: WorkerOutcome): ReleaseVerdict {
  if (outcome.kind === "installed") return "healthy";
  if (outcome.kind === "failed") return "unhealthy";
  return outcome.kind === "skipped" ? "skipped" : "absent";
}

function repositoriesVerdict(outcome: RepositoryOutcome | undefined): RepositoriesVerdict {
  return outcome?.kind ?? "unknown";
}

function controlPlaneVerdict(outcome: ControlPlaneOutcome | undefined): ControlPlaneVerdict {
  return outcome?.kind ?? "unknown";
}

function dispatchVerdict(outcome: DispatchOutcome | undefined): DispatchVerdict {
  return outcome?.kind ?? "not_requested";
}

/** Indexes outcomes by host key, keeping the first for each (one outcome per worker per stage). */
function byKey<T extends { readonly key: HostKey }>(outcomes: readonly T[]): Map<HostKey, T> {
  const map = new Map<HostKey, T>();
  for (const outcome of outcomes) if (!map.has(outcome.key)) map.set(outcome.key, outcome);
  return map;
}

function releaseDetail(outcome: WorkerOutcome): string {
  return outcome.kind === "skipped"
    ? `Release left as is: ${outcome.summary}`
    : `Release is ${releaseVerdict(outcome)}`;
}

/** A skipped dispatch's line: its reason, unless the workers stage's skip already named it. */
function dispatchDetails(outcome: WorkerOutcome, dispatch: DispatchOutcome | undefined): string[] {
  if (dispatch?.kind === "failed") return ["Dispatch reconciliation failed"];
  if (dispatch?.kind === "pending") return [...dispatch.nextActions];
  if (dispatch?.kind !== "skipped") return [];
  return [
    outcome.kind === "skipped" ? "Dispatch left as is" : `Dispatch left as is: ${dispatch.summary}`,
  ];
}

/** The next actions of the skips, each named once: the workers stage's, then dispatch's. */
function skipActions(outcome: WorkerOutcome, dispatch: DispatchOutcome | undefined): string[] {
  const actions = [
    ...(outcome.kind === "skipped" ? [outcome.nextAction] : []),
    ...(dispatch?.kind === "skipped" ? [dispatch.nextAction] : []),
  ];
  return [...new Set(actions)];
}

function verifyWorker(
  outcome: WorkerOutcome,
  repositories: RepositoryOutcome | undefined,
  controlPlane: ControlPlaneOutcome | undefined,
  dispatch: DispatchOutcome | undefined,
): WorkerVerification {
  const release = releaseVerdict(outcome);
  const repos = repositoriesVerdict(repositories);
  const control = controlPlaneVerdict(controlPlane);
  const disp = dispatchVerdict(dispatch);
  const details: string[] = [];
  if (release !== "healthy") details.push(releaseDetail(outcome));
  if (repos !== "synchronized") details.push(`Repositories are ${repos}`);
  if (control !== "applied") details.push(`Control plane is ${control}`);
  details.push(...dispatchDetails(outcome, dispatch), ...skipActions(outcome, dispatch));

  const ready =
    release === "healthy" &&
    repos === "synchronized" &&
    control === "applied" &&
    (disp === "active" || disp === "not_requested");
  return {
    key: outcome.key,
    hostname: outcome.hostname,
    release,
    repositories: repos,
    controlPlane: control,
    dispatch: disp,
    ready,
    summary: ready
      ? `${outcome.hostname} is ready${disp === "active" ? " and dispatching" : ""}`
      : `${outcome.hostname} is not ready: ${details.join("; ")}`,
    details,
  };
}

/** The end-to-end verdict: every declared worker joined across the stages, and the factory total. */
export function verifyFactory(request: VerifyFactoryRequest): FactoryVerification {
  const repositories = byKey(request.repositories);
  const controlPlane = byKey(request.controlPlane);
  const dispatch = byKey(request.dispatch);
  const workers = request.workers.map((outcome) =>
    verifyWorker(
      outcome,
      repositories.get(outcome.key),
      controlPlane.get(outcome.key),
      dispatch.get(outcome.key),
    ),
  );
  const ready = workers.every((worker) => worker.ready);
  const notReady = workers.filter((worker) => !worker.ready).length;
  return {
    ready,
    workers,
    summary: ready
      ? "The factory is ready: every worker is verified end to end"
      : `The factory is not ready: ${notReady} of ${workers.length} workers need attention`,
  };
}
