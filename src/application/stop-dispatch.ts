/**
 * Stopping dispatch on one running worker outside apply (`docs/specs/dispatch.md` §Stopping
 * dispatch): teardown stops it on every running worker before it destroys anything (epic #56,
 * D3). It reconciles the host's not-requested projection through the `WorkflowQueue`, which
 * removes the factory's Paseo schedule as apply does for a host factory.json requests no
 * dispatch on: a live change that never restarts Paseo or interrupts an agent. Nothing else
 * is asked of the worker, and factory.json is not read: the next `fffactory apply` reconciles
 * dispatch from it again, and so restarts it.
 */
import { type DispatchStop, notRequestedDispatchProjection } from "../domain/dispatch-projection";
import type { WorkerAddress } from "../domain/tailnet";
import type { WorkflowQueue } from "./workflow-queue";

export interface DispatchStopDependencies {
  readonly workflowQueue: WorkflowQueue;
}

/**
 * Stops dispatch on `worker`: `stopped` when the worker reports dispatch not requested after
 * changing something, `already_stopped` when it changed nothing, and `failed` when reconciling
 * did not complete or the worker reported any other state.
 */
export async function stopDispatch(
  deps: DispatchStopDependencies,
  worker: WorkerAddress,
): Promise<DispatchStop> {
  const result = await deps.workflowQueue.reconcileDispatch(
    worker,
    notRequestedDispatchProjection(worker.hostname),
  );
  if (result.kind === "failed") return { kind: "failed", reason: result.reason };
  if (result.inspection.state !== "not_requested")
    return { kind: "failed", reason: "the worker did not report dispatch stopped" };
  return { kind: result.changed ? "stopped" : "already_stopped" };
}
