/**
 * Operation records: what a mutating operation, such as `apply`, has done so far, kept in
 * the state bucket beside the factory-wide lock it holds. The record is written when the
 * lock is taken and again as each stage moves on, so an operation that is interrupted or
 * dies leaves both its lock and a record of the stage it reached. Records are history:
 * they are never read back to decide anything, and a rerun always plans from live state.
 */
import type { LockHolder, LockRecord } from "./factory-lock";
import type { FactoryId, HostKey, Release } from "./instance";
import { namespaced } from "./resource-naming";
import type { WorkerOutcome } from "./rollout";
import type { DispatchGate } from "./dispatch-readiness";

export const OPERATION_SCHEMA_VERSION = 1;

/** Apply's first stage: planning and applying the factory's Terraform. */
export const INFRASTRUCTURE_STAGE = "infrastructure";

/** Apply's second stage: installing the release on each worker, one at a time. */
export const WORKERS_STAGE = "workers";
/** Apply's third stage: reconciling placed repositories on each worker. */
export const REPOSITORIES_STAGE = "repositories";
/** Apply's fourth stage: installing and reconciling Paseo without interrupting agents. */
export const CONTROL_PLANE_STAGE = "control-plane";
/** Apply's fifth stage: installing and reconciling gated dispatch. */
export const DISPATCH_STAGE = "dispatch";
/** Apply's sixth stage: observing the requested end state. */
export const VERIFICATION_STAGE = "verification";

/**
 * Upgrade's first stage: moving factory.json's release pin to the running release, written
 * once the plan is approved, before the infrastructure is applied. It goes `pending`, then
 * ends `written`, `refused` (factory.json changed after the plan was made) or `failed`
 * (writing it failed); an operation that ends before the pin is written, declined, refused
 * or failed, ends it the same way (`finishOperation`).
 */
export const PIN_STAGE = "pin";

/**
 * How an operation ended; `running` until it does. An interrupted or killed operation stays
 * `running`, with its lock left in place. `partial`: it succeeded except for workers it
 * skipped, such as offline ones.
 */
export type OperationStatus =
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "declined"
  | "refused";

/**
 * Where a stage is. The infrastructure stage goes `planning`, then `awaiting_approval`,
 * then `applying`, and ends `applied`, `unchanged`, `declined`, `refused` or `failed`. The
 * workers stage goes `installing` and ends `installed`, `partial` (some workers skipped) or
 * `failed`.
 */
export type StageStatus =
  | "pending"
  | "planning"
  | "awaiting_approval"
  | "applying"
  | "applied"
  | "unchanged"
  | "installing"
  | "installed"
  | "synchronizing"
  | "synchronized"
  | "reconciling"
  | "reconciled"
  | "deferred"
  | "active"
  | "verified"
  | "written"
  | "partial"
  | "declined"
  | "refused"
  | "failed";

export interface StageRecord {
  readonly name: string;
  readonly status: StageStatus;
}

/** One worker's result in the workers stage, in fffactory's own words. */
export interface WorkerRecord {
  readonly key: string;
  readonly hostname: string;
  readonly status: WorkerOutcome["kind"];
  /** Why it was skipped or failed; null otherwise. */
  readonly summary: string | null;
}

export interface RepositoryRecord {
  readonly key: string;
  readonly hostname: string;
  readonly status: "synchronized" | "unresolved" | "skipped";
  readonly unmanaged: readonly string[];
  readonly summary: string | null;
}

export interface ControlPlaneRecord {
  readonly key: string;
  readonly hostname: string;
  readonly status: "applied" | "deferred" | "failed";
  readonly summary: string | null;
}

export interface DispatchRecord {
  readonly key: string;
  readonly hostname: string;
  readonly status: "not_requested" | "active" | "pending" | "failed" | "skipped";
  readonly blockers: readonly DispatchGate[];
  readonly summary: string | null;
}

export interface OperationVerification {
  readonly ready: boolean;
  readonly summary: string;
  readonly workers: readonly {
    readonly key: HostKey;
    readonly hostname: string;
    readonly ready: boolean;
    readonly release: "healthy" | "unhealthy" | "skipped" | "absent";
    readonly repositories: "synchronized" | "unresolved" | "skipped" | "unknown";
    readonly controlPlane: "applied" | "deferred" | "failed" | "unknown";
    readonly dispatch: "active" | "pending" | "not_requested" | "failed" | "skipped";
    readonly summary: string;
    readonly details: readonly string[];
  }[];
}

export interface OperationRecord {
  readonly schema_version: typeof OPERATION_SCHEMA_VERSION;
  /** The ID of the lock the operation holds: one lock, one operation. */
  readonly operation_id: string;
  readonly factory_id: FactoryId;
  readonly operation: string;
  readonly holder: LockHolder;
  readonly release: Release;
  /** The saved plan applied, or null when the operation planned for itself. */
  readonly plan_id: string | null;
  readonly status: OperationStatus;
  readonly stages: readonly StageRecord[];
  /** Each worker the workers stage has finished with, in the order it went. */
  readonly workers: readonly WorkerRecord[];
  /** Each worker's completed repository-stage result. */
  readonly repositories: readonly RepositoryRecord[];
  readonly control_plane: readonly ControlPlaneRecord[];
  readonly dispatch: readonly DispatchRecord[];
  readonly verification: OperationVerification | null;
  readonly started_at: string;
  readonly updated_at: string;
  readonly finished_at: string | null;
  /** Why it failed, in fffactory's own words: never an AWS or Terraform message. */
  readonly failure: string | null;
}

/**
 * The record's key in the state bucket: under the factory ID, then its start time and lock
 * ID, so records list in the order operations started.
 */
export function operationKey(record: OperationRecord): string {
  return `${namespaced(record.factory_id, "operations")}/${record.started_at}-${record.operation_id}.json`;
}

/**
 * The record of an operation that has just taken `lock`: running the infrastructure stage's
 * plan, after any `pending` stages it starts with, such as upgrade's pin.
 */
export function startOperation(
  lock: LockRecord,
  planId: string | undefined,
  pending: readonly string[] = [],
): OperationRecord {
  return {
    schema_version: OPERATION_SCHEMA_VERSION,
    operation_id: lock.lock_id,
    factory_id: lock.factory_id,
    operation: lock.operation,
    holder: lock.holder,
    release: lock.release,
    plan_id: planId ?? null,
    status: "running",
    stages: [
      ...pending.map((name) => ({ name, status: "pending" as const })),
      { name: INFRASTRUCTURE_STAGE, status: "planning" },
    ],
    workers: [],
    repositories: [],
    control_plane: [],
    dispatch: [],
    verification: null,
    started_at: lock.acquired_at,
    updated_at: lock.acquired_at,
    finished_at: null,
    failure: null,
  };
}

export function withDispatch(
  record: OperationRecord,
  outcomes: readonly {
    readonly key: string;
    readonly hostname: string;
    readonly kind: DispatchRecord["status"];
    readonly blocking?: readonly { readonly gate: DispatchGate }[];
    readonly summary?: string;
  }[],
  now: Date,
): OperationRecord {
  return {
    ...record,
    dispatch: outcomes.map((outcome) => ({
      key: outcome.key,
      hostname: outcome.hostname,
      status: outcome.kind,
      blockers: outcome.blocking?.map(({ gate }) => gate) ?? [],
      summary: "summary" in outcome ? (outcome.summary ?? null) : null,
    })),
    updated_at: now.toISOString(),
  };
}

export function withVerification(
  record: OperationRecord,
  verification: OperationVerification,
  now: Date,
): OperationRecord {
  return { ...record, verification, updated_at: now.toISOString() };
}

export function withControlPlane(
  record: OperationRecord,
  outcomes: readonly {
    readonly key: string;
    readonly hostname: string;
    readonly kind: "applied" | "deferred" | "failed";
    readonly summary?: string;
  }[],
  now: Date,
): OperationRecord {
  return {
    ...record,
    control_plane: outcomes.map(({ key, hostname, kind, summary }) => ({
      key,
      hostname,
      status: kind,
      summary: summary ?? null,
    })),
    updated_at: now.toISOString(),
  };
}

/** The record with the repository stage's outcomes so far. */
export function withRepositories(
  record: OperationRecord,
  outcomes: readonly {
    readonly key: string;
    readonly hostname: string;
    readonly kind: "synchronized" | "unresolved" | "skipped";
    readonly unmanaged?: readonly string[];
    readonly summary?: string;
  }[],
  now: Date,
): OperationRecord {
  return {
    ...record,
    repositories: outcomes.map((outcome) => ({
      key: outcome.key,
      hostname: outcome.hostname,
      status: outcome.kind,
      unmanaged: [...(outcome.unmanaged ?? [])],
      summary: outcome.summary ?? null,
    })),
    updated_at: now.toISOString(),
  };
}

/** The record with stage `name` at `status`, added after the others when it is new. */
export function withStage(
  record: OperationRecord,
  name: string,
  status: StageStatus,
  now: Date,
): OperationRecord {
  const known = record.stages.some((stage) => stage.name === name);
  const stages = known
    ? record.stages.map((stage) => (stage.name === name ? { name, status } : stage))
    : [...record.stages, { name, status }];
  return { ...record, stages, updated_at: now.toISOString() };
}

/** The record with the workers stage's outcomes so far. */
export function withWorkers(
  record: OperationRecord,
  outcomes: readonly WorkerOutcome[],
  now: Date,
): OperationRecord {
  const workers = outcomes.map((outcome) => ({
    key: outcome.key,
    hostname: outcome.hostname,
    status: outcome.kind,
    summary: outcome.kind === "skipped" || outcome.kind === "failed" ? outcome.summary : null,
  }));
  return { ...record, workers, updated_at: now.toISOString() };
}

/**
 * The record of an operation that ended with `status`, and why when it failed. A stage still
 * `pending` when the operation ends declined, refused or failed never started: it ends the
 * same way.
 */
export function finishOperation(
  record: OperationRecord,
  status: Exclude<OperationStatus, "running">,
  now: Date,
  failure?: string,
): OperationRecord {
  const at = now.toISOString();
  const unsuccessful = status === "declined" || status === "refused" || status === "failed";
  const stages = unsuccessful
    ? record.stages.map((stage) => (stage.status === "pending" ? { ...stage, status } : stage))
    : record.stages;
  return { ...record, status, stages, updated_at: at, finished_at: at, failure: failure ?? null };
}

export function serializeOperation(record: OperationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
