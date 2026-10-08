/**
 * Apply's dispatch stage (`docs/specs/dispatch.md`): the last reconciling stage before the
 * end-to-end verification. For each declared worker, it gathers the dispatch gate inputs the
 * earlier stages produced — the worker's release health and GitHub credential (the workers
 * stage), its repository synchronization (the repository stage), Paseo health (the control-plane
 * stage) — reads FFFlow adoption from the `WorkflowQueue`, and lets the pure gates
 * (`domain/dispatch-readiness.ts`) decide. It activates dispatch only when every gate passes and
 * keeps it inactive otherwise, so a later apply activates it automatically once the gates pass.
 *
 * Activating dispatch reconciles the Paseo schedule, a live change: the stage holds no
 * control-plane port and never restarts the daemon, so rerunning it over an active agent
 * disturbs nothing. One worker's failure never stops the others.
 *
 * A worker an earlier stage skipped (its maintenance deferred, the workers stage skipping it,
 * the tailnet no longer locating it) is skipped here too, before any gate: it is sent nothing,
 * so its existing schedule stays as it is until a later apply reconciles it. Its gates would
 * read its unverified release as failing and turn off a schedule that was dispatching fine.
 */
import {
  type AdoptionState,
  type DispatchGateResult,
  dispatchNextActions,
  dispatchState,
  describeDispatch,
  type PaseoHealth,
} from "../domain/dispatch-readiness";
import type { EnrollmentState } from "../domain/readiness";
import type { RepositoryReadiness } from "../domain/repository-placement";
import type { WorkerIdentity } from "../domain/rollout";
import type { WorkerAddress } from "../domain/tailnet";
import { dispatchProjection } from "../domain/dispatch-projection";
import type { DispatchSettings } from "../domain/instance";
import type { WorkflowAdoption, WorkflowQueue } from "./workflow-queue";

export interface DispatchStageDependencies {
  readonly workflowQueue: WorkflowQueue;
}

/**
 * One worker's dispatch inputs, gathered by apply from the earlier stages: either its gate inputs
 * and the address to reconcile it at, or why an earlier stage left it as it is. A worker with an
 * address is never skipped, and a skipped one has no address.
 */
export type DispatchWorker = GatedDispatchWorker | SkippedDispatchWorker;

/** Why the dispatch stage leaves a worker as it is, and the next action that completes it. */
export interface DispatchSkip {
  /**
   * `deferred`: the workers stage deferred its Paseo maintenance while agents may be active.
   * `worker_skipped`: the workers stage skipped it for another reason (offline, an install still
   * running, ...). `unreachable`: it was installed, but the tailnet no longer locates it.
   */
  readonly reason: "deferred" | "worker_skipped" | "unreachable";
  readonly summary: string;
  readonly nextAction: string;
}

export interface SkippedDispatchWorker {
  readonly worker: WorkerIdentity;
  readonly skip: DispatchSkip;
}

export interface GatedDispatchWorker {
  readonly worker: WorkerIdentity;
  /** The worker's address, located by the hostname-match rule. */
  readonly address: WorkerAddress;
  /** factory.json's complete `hosts[].dispatch` declaration for this host. */
  readonly settings: DispatchSettings | undefined;
  /** The workers stage installed and verified the release on it. */
  readonly releaseHealthy: boolean;
  /** The GitHub credential's state from the worker's verification. */
  readonly githubCredential: EnrollmentState;
  /** The repository stage's readiness for the worker. */
  readonly repositorySync: RepositoryReadiness;
  /** Paseo's health from the control-plane stage. */
  readonly paseoHealth: PaseoHealth;
}

export interface DispatchStageRequest {
  readonly workers: readonly DispatchWorker[];
}

/** One worker's dispatch reconciliation outcome. */
export type DispatchOutcome =
  /** factory.json does not request dispatch here; any existing schedule was removed. */
  | (WorkerIdentity & { readonly kind: "not_requested" })
  /** Every gate passes: dispatch is active. `changed` is false when it already was. */
  | (WorkerIdentity & {
      readonly kind: "active";
      readonly changed: boolean;
      readonly gates: readonly DispatchGateResult[];
    })
  /** A gate blocks dispatch: it is kept inactive, with the blocking gates and their next actions. */
  | (WorkerIdentity & {
      readonly kind: "pending";
      readonly gates: readonly DispatchGateResult[];
      readonly blocking: readonly DispatchGateResult[];
      readonly summary: string;
      readonly nextActions: readonly string[];
    })
  /** Reconciling the schedule did not complete; the schedule may be unchanged. */
  | (WorkerIdentity & {
      readonly kind: "failed";
      readonly summary: string;
      readonly nextAction: string;
    })
  /** An earlier stage skipped the worker: it was sent nothing, its schedule left as it is. */
  | (WorkerIdentity & { readonly kind: "skipped" } & DispatchSkip);

export interface DispatchStage {
  readonly outcomes: readonly DispatchOutcome[];
}

function adoptionState(adoption: WorkflowAdoption): AdoptionState {
  return adoption.kind;
}

/** The pending outcome for one worker, with its blocking gates and their next actions. */
function pending(
  worker: WorkerIdentity,
  state: Extract<ReturnType<typeof dispatchState>, { readonly kind: "pending" }>,
): DispatchOutcome {
  return {
    ...worker,
    kind: "pending",
    gates: state.gates,
    blocking: state.blocking,
    summary: describeDispatch(state),
    nextActions: dispatchNextActions(state),
  };
}

type DesiredDispatchState = ReturnType<typeof dispatchState>;
type ReconciledDispatch = Awaited<ReturnType<WorkflowQueue["reconcileDispatch"]>>;

function reconciledOutcome(
  worker: WorkerIdentity,
  state: DesiredDispatchState,
  result: ReconciledDispatch,
): DispatchOutcome {
  if (result.kind === "failed")
    return {
      ...worker,
      kind: "failed",
      summary: `Reconciling dispatch on ${worker.hostname} failed: ${result.reason}`,
      nextAction: `Check \`systemctl status paseo.service\` on ${worker.hostname}, then rerun \`fffactory apply\``,
    };
  if (state.kind === "not_requested" && result.inspection.state === "not_requested")
    return { ...worker, kind: "not_requested" };
  if (state.kind === "active" && result.inspection.state === "active")
    return { ...worker, kind: "active", changed: result.changed, gates: state.gates };
  if (state.kind === "pending" && result.inspection.state === "pending")
    return pending(worker, state);
  return {
    ...worker,
    kind: "failed",
    summary:
      state.kind === "not_requested"
        ? `Dispatch on ${worker.hostname} was not deactivated`
        : `Dispatch on ${worker.hostname} did not reach its gated state`,
    nextAction: `Check Paseo on ${worker.hostname}, then rerun \`fffactory apply\``,
  };
}

/**
 * One worker: skipped, sent nothing, when an earlier stage skipped it; otherwise its gates, then
 * activation when they pass or deactivation when they do not.
 */
async function reconcile(
  deps: DispatchStageDependencies,
  entry: DispatchWorker,
): Promise<DispatchOutcome> {
  const { worker } = entry;
  if ("skip" in entry) {
    const { reason, summary, nextAction } = entry.skip;
    return { ...worker, kind: "skipped", reason, summary, nextAction };
  }
  const requested = entry.settings?.enabled === true;

  const adoption = requested
    ? await deps.workflowQueue.adoption(entry.address)
    : ({ kind: "passed" } as const);
  const state = dispatchState(
    requested,
    {
      releaseHealthy: entry.releaseHealthy,
      githubCredential: entry.githubCredential,
      repositorySync: entry.repositorySync,
      ffflowAdoption: adoptionState(adoption),
      paseoHealth: entry.paseoHealth,
    },
    worker.hostname,
  );
  const active = state.kind === "active";
  const blockers = state.kind === "pending" ? state.blocking.map(({ gate }) => gate) : [];
  const desired = dispatchProjection(worker.hostname, entry.settings, active, blockers);
  const result = await deps.workflowQueue.reconcileDispatch(entry.address, desired);
  return reconciledOutcome(worker, state, result);
}

/** The dispatch stage: every declared worker, each reconciled, one failure not stopping another. */
export async function applyDispatch(
  deps: DispatchStageDependencies,
  request: DispatchStageRequest,
): Promise<DispatchStage> {
  const outcomes: DispatchOutcome[] = [];
  for (const entry of request.workers) outcomes.push(await reconcile(deps, entry));
  return { outcomes };
}
