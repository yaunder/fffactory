import type { WorkerAddress } from "../domain/tailnet";
import type { DispatchInspection, DispatchProjection } from "../domain/dispatch-projection";

/**
 * Port: the FFFlow/GitHub workflow queue on a worker. FFFactory owns FFFlow/GitHub readiness for
 * now, isolated behind this connector (`infrastructure/ffflow-github-workflow-queue.ts`,
 * `docs/specs/dispatch.md`). The dispatch stage reads FFFlow adoption through it and reconciles
 * dispatch activation through it. Reconciling the schedule is a live change: it never restarts
 * Paseo or interrupts an active agent, and the adapter never prints Paseo's output or a password.
 */
export interface WorkflowQueue {
  /** Whether FFFlow adoption passes for the worker's placed repositories. */
  adoption(worker: WorkerAddress): Promise<WorkflowAdoption>;
  /**
   * Reconcile dispatch on the worker to `active`: ensure its Paseo schedule exists when active
   * and is absent otherwise. Idempotent and live; `changed` is false when the schedule was
   * already in the requested state, so a rerun over an active agent restarts nothing.
   */
  reconcileDispatch(
    worker: WorkerAddress,
    projection: DispatchProjection,
  ): Promise<WorkflowReconcile>;
  /** Observe the persisted state and verify that the actual schedule still matches it. */
  inspectDispatch(worker: WorkerAddress): Promise<DispatchInspection>;
}

/** FFFlow adoption for the placed repositories; a failure or unknown carries a short reason. */
export type WorkflowAdoption =
  | { readonly kind: "passed" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** How reconciling dispatch ended; a failure carries a short reason, never daemon output. */
export type WorkflowReconcile =
  | {
      readonly kind: "reconciled";
      readonly changed: boolean;
      readonly inspection: DispatchInspection;
    }
  | { readonly kind: "failed"; readonly reason: string };
