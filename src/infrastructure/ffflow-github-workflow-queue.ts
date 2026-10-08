/** The workflow queue over the fixed worker dispatch host protocol. */
import type { HostCommandOutcome, HostTransport } from "../application/host-transport";
import type {
  WorkflowAdoption,
  WorkflowQueue,
  WorkflowReconcile,
} from "../application/workflow-queue";
import {
  type DispatchInspection,
  dispatchAdoptionExitCode,
  dispatchInspectionExitCode,
  dispatchProjectionJson,
  INSPECT_DISPATCH_COMMAND,
  parseDispatchAdoption,
  parseDispatchInspection,
  type DispatchProjection,
} from "../domain/dispatch-projection";
import { remoteCommand, WORKER_PATHS } from "../domain/host-protocol";
import type { WorkerAddress } from "../domain/tailnet";

export const WORKFLOW_TIMEOUT_MS = 15 * 60_000;

const action = (name: "adoption" | "reconcile" | "inspect") =>
  remoteCommand(["sudo", "-n", WORKER_PATHS.activator, "dispatch", name]);

const ADOPTION = action("adoption");
const RECONCILE = action("reconcile");

function adoptionResult(outcome: HostCommandOutcome): WorkflowAdoption {
  if (outcome.kind !== "completed") return { kind: "unknown", reason: outcome.kind };
  const result = parseDispatchAdoption(outcome.stdout);
  if (result === undefined) return { kind: "unknown", reason: "invalid adoption result" };
  if (outcome.exitCode !== dispatchAdoptionExitCode(result))
    return { kind: "unknown", reason: "adoption result disagrees with its exit status" };
  return result.state === "passed"
    ? { kind: "passed" }
    : { kind: "failed", reason: "a placed repository is not FFFlow-adopted" };
}

function reconcileResult(outcome: HostCommandOutcome): WorkflowReconcile {
  if (outcome.kind !== "completed")
    return { kind: "failed", reason: `dispatch schedule reconcile ${outcome.kind}` };
  const inspection = parseDispatchInspection(outcome.stdout);
  if (inspection === undefined)
    return { kind: "failed", reason: "dispatch schedule reconcile returned invalid data" };
  if (
    inspection.state === "failed" ||
    inspection.state === "unreadable" ||
    inspection.state === "none"
  )
    return { kind: "failed", reason: "dispatch schedule did not reconcile" };
  if (
    inspection.state !== "active" &&
    inspection.state !== "pending" &&
    inspection.state !== "not_requested"
  )
    return { kind: "failed", reason: "dispatch schedule reconcile returned no state" };
  if (outcome.exitCode !== dispatchInspectionExitCode(inspection))
    return { kind: "failed", reason: `dispatch schedule reconcile exited ${outcome.exitCode}` };
  return { kind: "reconciled", changed: inspection.changed, inspection };
}

export function ffflowGithubWorkflowQueue(transport: HostTransport): WorkflowQueue {
  const run = (worker: WorkerAddress, command: ReturnType<typeof action>, stdin?: Uint8Array) =>
    transport.run(worker, command, {
      timeoutMs: WORKFLOW_TIMEOUT_MS,
      ...(stdin === undefined ? {} : { stdin }),
    });
  return {
    async adoption(worker) {
      return adoptionResult(await run(worker, ADOPTION));
    },
    async reconcileDispatch(worker, projection: DispatchProjection) {
      return reconcileResult(
        await run(worker, RECONCILE, new TextEncoder().encode(dispatchProjectionJson(projection))),
      );
    },
    async inspectDispatch(worker): Promise<DispatchInspection> {
      const outcome = await run(worker, INSPECT_DISPATCH_COMMAND);
      if (outcome.kind !== "completed") return { protocol_version: 1, state: "unreadable" };
      const inspection = parseDispatchInspection(outcome.stdout);
      return inspection !== undefined && outcome.exitCode === dispatchInspectionExitCode(inspection)
        ? inspection
        : { protocol_version: 1, state: "unreadable" };
    },
  };
}
