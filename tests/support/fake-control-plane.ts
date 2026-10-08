/**
 * The ports apply's control-plane and dispatch stages drive (`docs/specs/control-plane.md`,
 * `docs/specs/dispatch.md`), as in-memory fakes that answer as given and record every call, so
 * a test can tell what apply asked a worker's Paseo and dispatch, and what it never asked.
 */
import type { AgentActivity, ControlPlane } from "../../src/application/control-plane";
import type { WorkflowAdoption, WorkflowQueue } from "../../src/application/workflow-queue";
import type { DispatchInspection } from "../../src/domain/dispatch-projection";
import type { HostProjection } from "../../src/domain/host-projection";

/**
 * A control plane answering `health` and `activeAgents` as given. It records every call in
 * `calls`, and in `installed` the projection each `install` received.
 */
export function fakeControlPlane(
  health: "healthy" | "unhealthy" | "unreachable",
  activity: AgentActivity,
) {
  const calls: string[] = [];
  const installed: HostProjection[] = [];
  const controlPlane: ControlPlane = {
    health: async () => {
      calls.push("health");
      return health;
    },
    activeAgents: async () => {
      calls.push("activeAgents");
      return activity;
    },
    install: async (_worker, projection) => {
      calls.push("install");
      installed.push(projection);
      return { kind: "done" };
    },
    reload: async () => {
      calls.push("reload");
      return { kind: "done" };
    },
    restart: async () => {
      calls.push("restart");
      return { kind: "done" };
    },
  };
  return { controlPlane, calls, installed };
}

/** The inspection a worker reports once it reconciled `projection`. */
function dispatchInspection(
  projection: Parameters<WorkflowQueue["reconcileDispatch"]>[1],
  changed: boolean,
): DispatchInspection {
  if (!projection.requested)
    return { protocol_version: 1 as const, state: "not_requested" as const, blockers: [], changed };
  return projection.active
    ? { protocol_version: 1 as const, state: "active" as const, blockers: [], changed }
    : {
        protocol_version: 1 as const,
        state: "pending" as const,
        blockers: projection.blockers,
        changed,
      };
}

/**
 * A workflow queue reporting `adoption` (passed by default) and reconciling every projection it
 * is sent, unless `failure` makes reconciling fail. It counts adoption checks in `adoptions` and
 * records each projection's `active` in `reconcile`: both stay empty for a worker sent nothing.
 */
export function fakeWorkflowQueue(
  options: { adoption?: WorkflowAdoption; changed?: boolean; failure?: string } = {},
) {
  const reconcile: boolean[] = [];
  const adoptions = { count: 0 };
  const queue: WorkflowQueue = {
    adoption: async () => {
      adoptions.count += 1;
      return options.adoption ?? { kind: "passed" };
    },
    reconcileDispatch: async (_worker, projection) => {
      reconcile.push(projection.active);
      if (options.failure !== undefined) return { kind: "failed", reason: options.failure };
      return {
        kind: "reconciled",
        changed: options.changed ?? true,
        inspection: dispatchInspection(projection, options.changed ?? true),
      };
    },
    inspectDispatch: async () => ({ protocol_version: 1, state: "none" }),
  };
  return { queue, reconcile, adoptions };
}
