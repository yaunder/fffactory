/**
 * Apply's control-plane stage (`docs/specs/control-plane.md`): for one worker, decide what its
 * planned control-plane changes do and drive the `ControlPlane` port accordingly. Live changes
 * take effect without touching the daemon. A reload-safe change reloads it. A maintenance change
 * restarts it only when the worker is idle by the busy rule; while agents are busy, or may be, it
 * is left pending and the worker stays on its complete current release, so apply never
 * interrupts a busy agent. A later apply completes the deferred change once none is. The stage
 * reaches the worker only through the port; the rules it follows are pure
 * (`domain/change-classification.ts`, `domain/control-plane.ts`).
 */
import {
  type ChangeType,
  controlPlaneActions,
  type MaintenanceDecision,
  maintenanceDeferral,
} from "../domain/change-classification";
import type { WorkerIdentity } from "../domain/rollout";
import type { WorkerAddress } from "../domain/tailnet";
import type { HostProjection } from "../domain/host-projection";
import type { ControlPlane } from "./control-plane";
import {
  type BlockingActivity,
  type WorkerActivity,
  workerActivity,
} from "../domain/control-plane";

export interface ControlPlaneStageDependencies {
  readonly controlPlane: ControlPlane;
}

export interface ControlPlaneStageRequest {
  /** The worker whose control plane this stage reconciles. */
  readonly worker: WorkerIdentity;
  /** Its address, resolved by the hostname-match rule exactly as the other stages resolve one. */
  readonly address: WorkerAddress;
  /** The control-plane changes this worker's plan would make. */
  readonly changes: readonly ChangeType[];
  readonly projection: HostProjection;
  /** A pre-activation observation; a new worker has no daemon and is therefore idle. */
  readonly activity?: WorkerActivity;
}

/** One worker's control-plane reconciliation outcome. */
export type ControlPlaneOutcome =
  /** Every change was made: live changes, and a reload or restart when one was called for. */
  | (WorkerIdentity & {
      readonly kind: "applied";
      readonly live: readonly ChangeType[];
      readonly reloaded: boolean;
      /** Whether the daemon was restarted for a maintenance change. */
      readonly restarted: boolean;
    })
  /** A maintenance change was left pending because agents may be busy; the daemon was not restarted. */
  | (WorkerIdentity & {
      readonly kind: "deferred";
      readonly pending: readonly ChangeType[];
      readonly reloaded: boolean;
      readonly summary: string;
      readonly nextAction: string;
    })
  /** A reload or restart the stage attempted did not complete; the daemon may be unchanged. */
  | (WorkerIdentity & {
      readonly kind: "failed";
      readonly summary: string;
      readonly nextAction: string;
    })
  /**
   * Its machine is stopped: apply sends it nothing, so the stage never reaches it
   * (`docs/specs/plan-apply.md` §Stopped workers).
   */
  | (WorkerIdentity & { readonly kind: "stopped" });

function deferred(
  worker: WorkerIdentity,
  pending: readonly ChangeType[],
  activity: BlockingActivity,
  reloaded: boolean,
): ControlPlaneOutcome {
  return {
    ...worker,
    kind: "deferred",
    pending,
    reloaded,
    ...maintenanceDeferral(worker, pending, activity),
  };
}

function failed(worker: WorkerIdentity, summary: string): ControlPlaneOutcome {
  return {
    ...worker,
    kind: "failed",
    summary,
    nextAction: `Check \`systemctl status paseo.service\` on ${worker.hostname}, then rerun \`fffactory apply\``,
  };
}

/**
 * Reconciles one worker's control plane. Reads its agents first — agents it cannot read may be
 * busy, so maintenance is deferred, never risking an interruption — then reloads for a
 * reload-safe change and restarts for a maintenance change only when no agent is busy.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the safety order is intentionally linear and auditable
export async function applyControlPlane(
  deps: ControlPlaneStageDependencies,
  request: ControlPlaneStageRequest,
): Promise<ControlPlaneOutcome> {
  const { worker, address, changes } = request;
  if (changes.length === 0)
    return { ...worker, kind: "applied", live: [], reloaded: false, restarted: false };
  const activity = request.activity ?? workerActivity(await deps.controlPlane.agents(address));
  const actions = controlPlaneActions(changes, activity);

  if (actions.maintenance.kind === "deferred") {
    const { pending, activity: deferring } = actions.maintenance;
    if (actions.reload) {
      const result = await deps.controlPlane.reload(address);
      if (result.kind === "failed") return failed(worker, `Paseo reload failed: ${result.reason}`);
      return deferred(worker, pending, deferring, true);
    }
    return deferred(worker, pending, deferring, false);
  }

  if (changes.length > 0) {
    const installed = await deps.controlPlane.install(address, request.projection);
    if (installed.kind === "failed")
      return failed(worker, `Paseo installation failed: ${installed.reason}`);
  }

  let reloaded = false;
  if (actions.reload) {
    const result = await deps.controlPlane.reload(address);
    if (result.kind === "failed") return failed(worker, `Paseo reload failed: ${result.reason}`);
    reloaded = true;
  }

  const maintenance: MaintenanceDecision = actions.maintenance;
  if (maintenance.kind === "apply") {
    const result = await deps.controlPlane.restart(address);
    if (result.kind === "failed") return failed(worker, `Paseo restart failed: ${result.reason}`);
    return { ...worker, kind: "applied", live: actions.live, reloaded, restarted: true };
  }
  return { ...worker, kind: "applied", live: actions.live, reloaded, restarted: false };
}
