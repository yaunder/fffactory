/**
 * Operation records: what a mutating operation, such as `apply`, has done so far, kept in
 * the state bucket beside the factory-wide lock it holds. The record is written when the
 * lock is taken and again as each stage moves on, so an operation that is interrupted or
 * dies leaves both its lock and a record of the stage it reached. Records are history, and a
 * rerun always plans from live state; the one exception is teardown's: the host keys it knew as
 * its destroy began (`host_keys`), which a later teardown reads back (`rememberedHostKeys`) to
 * delete those hosts' tailnet devices once the Terraform state no longer names them, until an
 * apply's record shows the factory may have changed since (`docs/specs/teardown.md`
 * §Operation record).
 */
import type { LockHolder, LockRecord } from "./factory-lock";
import { type FactoryId, type HostKey, parseHostKey, type Release } from "./instance";
import { namespaced } from "./resource-naming";
import type { WorkerOutcome } from "./rollout";
import type { DispatchGate } from "./dispatch-readiness";
import { isRecord } from "./validation";

export const OPERATION_SCHEMA_VERSION = 1;

/**
 * The state bucket's creation, which an apply that found no bucket did before it could take
 * the lock. The record only exists once the bucket and the lock do, so this stage is only
 * ever `applied`, and leads the stages of exactly the applies that created the bucket.
 */
export const BACKEND_STAGE = "backend";

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
 * The operation teardown holds the factory lock as, and the name of its record's one stage
 * (`docs/specs/teardown.md` §Operation record).
 */
export const TEARDOWN_OPERATION = "teardown";

/**
 * How an operation ended; `running` until it does. An interrupted or killed operation stays
 * `running`, with its lock left in place. `partial`: apply succeeded except for workers it
 * skipped, such as offline ones; terminate left tailnet devices behind; teardown stopped after
 * removing part of the factory, once its destroy was applied or as it was.
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
 * `failed`. A worker lifecycle operation's one stage, named for its action, goes `locating`,
 * then `inspecting` (stop and terminate), `authorizing` (terminate's Tailscale admin client),
 * `awaiting_approval`, `stopping`, `starting` or `terminating`, then `waiting` (start, for the
 * tailnet) or `removing_devices` (terminate), and ends `stopped`, `started`, `terminated`,
 * `unchanged`, `partial` (terminate left tailnet devices behind), `declined`, `refused` or
 * `failed`. Terminate removing the host goes `planning` after `authorizing`, then
 * `awaiting_approval`, `applying` (Terraform), `writing` (factory.json) and `removing_devices`,
 * and ends `removed` (`docs/specs/worker-lifecycle.md` §Operation record). Teardown's one stage,
 * `teardown` (`TEARDOWN_OPERATION`), goes `authorizing`, `inventorying`, `planning`,
 * `awaiting_approval`, `stopping_dispatch`, `inspecting`, `applying`, `verifying`,
 * `removing_devices`, `removing_secrets`, `removing_plans` and `deleting_bucket`, and ends
 * `refused`, `declined`, `failed` or `partial` (stopped after removing part of the factory);
 * once the bucket is deleted the record goes with it, so a teardown that finished has none
 * (`docs/specs/teardown.md` §Operation record).
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
  | "locating"
  | "inspecting"
  | "stopping"
  | "stopped"
  | "starting"
  | "started"
  | "authorizing"
  | "terminating"
  | "terminated"
  | "removing_devices"
  | "inventorying"
  | "stopping_dispatch"
  | "verifying"
  | "removing_secrets"
  | "removing_plans"
  | "deleting_bucket"
  | "writing"
  | "removed"
  | "waiting"
  | "partial"
  | "declined"
  | "refused"
  | "failed";

export interface StageRecord {
  readonly name: string;
  readonly status: StageStatus;
}

/** One worker's result in the workers stage, in fffactory's own words; `stopped` is no skip. */
export interface WorkerRecord {
  readonly key: string;
  readonly hostname: string;
  readonly status: WorkerOutcome["kind"];
  /** Why it was skipped, failed or stopped; null otherwise. */
  readonly summary: string | null;
}

export interface RepositoryRecord {
  readonly key: string;
  readonly hostname: string;
  readonly status: "synchronized" | "unresolved" | "skipped" | "stopped";
  readonly unmanaged: readonly string[];
  readonly summary: string | null;
}

export interface ControlPlaneRecord {
  readonly key: string;
  readonly hostname: string;
  readonly status: "applied" | "deferred" | "failed" | "stopped";
  readonly summary: string | null;
}

export interface DispatchRecord {
  readonly key: string;
  readonly hostname: string;
  readonly status: "not_requested" | "active" | "pending" | "failed" | "skipped" | "stopped";
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
    readonly release: "healthy" | "unhealthy" | "skipped" | "absent" | "stopped";
    readonly repositories: "synchronized" | "unresolved" | "skipped" | "unknown" | "stopped";
    readonly controlPlane: "applied" | "deferred" | "failed" | "unknown" | "stopped";
    readonly dispatch: "active" | "pending" | "not_requested" | "failed" | "skipped" | "stopped";
    readonly summary: string;
    readonly details: readonly string[];
  }[];
}

/** The worker a power operation acts on, and its machine's EC2 state as last read. */
export interface MachineRecord {
  readonly key: string;
  readonly hostname: string;
  readonly instance_id: string;
  readonly state: string;
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
  /** A worker power operation's machine, once located; apply's records have none. */
  readonly machine?: MachineRecord;
  /**
   * Teardown's alone: every well-formed host key it knew, those earlier teardowns remembered
   * among them, written with its `applying` step, so `[]` until its destroy may begin
   * (`withHostKeys`, `rememberedHostKeys`). Absent in a record from before teardown remembered
   * any, which remembers none.
   */
  readonly host_keys?: readonly HostKey[];
}

/** Where the factory's operation records are kept in the state bucket: the prefix of their keys. */
export function operationsPrefix(factoryId: FactoryId): string {
  return `${namespaced(factoryId, "operations")}/`;
}

/**
 * The record's key in the state bucket: under the factory ID, then its start time and lock
 * ID, so records list in the order operations started.
 */
export function operationKey(record: OperationRecord): string {
  return `${operationsPrefix(record.factory_id)}${record.started_at}-${record.operation_id}.json`;
}

/** How an operation's record starts, beyond its lock and plan ID. */
export interface OperationStart {
  /** Stages it starts with `pending`, before the infrastructure stage, such as upgrade's pin. */
  readonly pending?: readonly string[];
  /** Whether it created the state bucket first: its record leads with the backend stage. */
  readonly bootstrapped?: boolean;
}

/**
 * The record of an operation that has just taken `lock`: running the infrastructure stage's
 * plan, after the applied backend stage when it bootstrapped, and any `pending` stages.
 */
export function startOperation(
  lock: LockRecord,
  planId: string | undefined,
  { pending = [], bootstrapped = false }: OperationStart = {},
): OperationRecord {
  return openOperation(lock, planId, [
    ...(bootstrapped ? [{ name: BACKEND_STAGE, status: "applied" as const }] : []),
    ...pending.map((name) => ({ name, status: "pending" as const })),
    { name: INFRASTRUCTURE_STAGE, status: "planning" },
  ]);
}

/**
 * The record of an operation that has just taken `lock` and runs one stage, `name`, applying
 * saved plan `planId` when it has one.
 */
export function startStageOperation(
  lock: LockRecord,
  name: string,
  status: StageStatus,
  planId?: string,
): OperationRecord {
  return openOperation(lock, planId, [{ name, status }]);
}

/**
 * The record of a teardown that has just taken `lock`: its one stage authorizing, remembering no
 * host key yet (`withHostKeys`).
 */
export function startTeardownOperation(lock: LockRecord): OperationRecord {
  return {
    ...openOperation(lock, undefined, [{ name: TEARDOWN_OPERATION, status: "authorizing" }]),
    host_keys: [],
  };
}

function openOperation(
  lock: LockRecord,
  planId: string | undefined,
  stages: readonly StageRecord[],
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
    stages,
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
    readonly kind: ControlPlaneRecord["status"];
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
    readonly kind: RepositoryRecord["status"];
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

/** The record with the worker power operation's machine as last read. */
export function withMachine(
  record: OperationRecord,
  machine: MachineRecord,
  now: Date,
): OperationRecord {
  return { ...record, machine, updated_at: now.toISOString() };
}

/**
 * The teardown record remembering `keys` besides those it already does: each well-formed host
 * key once, in the order first known. Any other is dropped, as it names no device teardown deletes.
 */
export function withHostKeys(
  record: OperationRecord,
  keys: readonly string[],
  now: Date,
): OperationRecord {
  const wellFormed = keys.flatMap((key) => {
    const parsed = parseHostKey(key);
    return parsed.ok ? [parsed.value] : [];
  });
  const host_keys = [...new Set([...(record.host_keys ?? []), ...wellFormed])];
  return { ...record, host_keys, updated_at: now.toISOString() };
}

/** An object read back from under the factory's operation records' prefix, and its text. */
export interface StoredOperation {
  readonly key: string;
  readonly text: string;
}

/**
 * What earlier teardowns remembered: every host key their records hold, or the keys of the
 * records that cannot be read, which may hide one.
 */
export type RememberedHostKeys =
  | { readonly kind: "remembered"; readonly keys: readonly HostKey[] }
  | { readonly kind: "unreadable"; readonly records: readonly string[] };

/** How `operationKey` names a record: its start time, then its lock ID. */
const RECORD_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[a-z0-9]{8}\.json$/;

/** The length of the start time `operationKey` names a record by, an ISO timestamp. */
const STARTED_AT_LENGTH = "2026-09-30T12:00:00.000Z".length;

/**
 * The infrastructure stage's statuses once Terraform may have applied, so the factory's hosts
 * may have changed: `failed` among them, as the record cannot tell a failed plan from a failed
 * apply.
 */
const HOSTS_MAY_HAVE_CHANGED: ReadonlySet<unknown> = new Set<StageStatus>([
  "applying",
  "applied",
  "failed",
]);

/**
 * What a record tells about remembered host keys: a teardown's, and the keys it remembers (none
 * without `host_keys`, as before teardown remembered any); one whose infrastructure stage may
 * have applied (`HOSTS_MAY_HAVE_CHANGED`, apply's or upgrade's); or another.
 */
type Judged =
  | { readonly kind: "teardown"; readonly keys: readonly HostKey[] }
  | { readonly kind: "changed" }
  | { readonly kind: "other" };

function isStage(value: unknown): value is StageRecord {
  return isRecord(value) && typeof value.name === "string" && typeof value.status === "string";
}

/** A teardown's remembered keys: none without `host_keys`; undefined unless all well-formed. */
function teardownKeys(hostKeys: unknown): Judged | undefined {
  const keys = hostKeys ?? [];
  if (!Array.isArray(keys)) return undefined;
  const parsed = keys.map((key) => parseHostKey(typeof key === "string" ? key : ""));
  if (!parsed.every((key) => key.ok)) return undefined;
  return { kind: "teardown", keys: parsed.flatMap((key) => (key.ok ? [key.value] : [])) };
}

/** Another operation's stages judged: `changed` once its infrastructure stage may have applied. */
function stagesJudged(stages: unknown): Judged | undefined {
  if (!Array.isArray(stages) || !stages.every(isStage)) return undefined;
  const infrastructure = stages.find(({ name }) => name === INFRASTRUCTURE_STAGE);
  return HOSTS_MAY_HAVE_CHANGED.has(infrastructure?.status)
    ? { kind: "changed" }
    : { kind: "other" };
}

/**
 * How a record is judged (`Judged`), or undefined when it cannot be read: not this factory's
 * JSON record naming its operation, a teardown's whose `host_keys` is present but not a list of
 * well-formed host keys, or another's whose stages are not a list of stages.
 */
function judged(factoryId: FactoryId, text: string): Judged | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(document) || document.factory_id !== factoryId) return undefined;
  if (typeof document.operation !== "string") return undefined;
  return document.operation === TEARDOWN_OPERATION
    ? teardownKeys(document.host_keys)
    : stagesJudged(document.stages);
}

/**
 * The host keys earlier teardowns remembered (`docs/specs/teardown.md` §Devices), from the
 * objects under the factory's operation records' prefix: each once, in the order their records
 * started. A teardown remembers keys only once its destroy may begin (`withHostKeys`), and only
 * until an apply or upgrade whose infrastructure stage may have applied starts after it, at
 * the same millisecond included: from then on the factory's hosts are that apply's, and the
 * teardown's record is passed over. An object `operationKey` never names, which fffactory never
 * wrote, is no record and is passed over; a record that cannot be read could be a teardown's
 * hiding a key, or an apply's bounding one, so it is never taken for either: `unreadable`, by key.
 */
export function rememberedHostKeys(
  factoryId: FactoryId,
  stored: readonly StoredOperation[],
): RememberedHostKeys {
  const prefix = operationsPrefix(factoryId);
  const records: { readonly startedAt: string; readonly judged: Judged }[] = [];
  const unreadable: string[] = [];
  const byKey = [...stored].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { key, text } of byKey) {
    const name = key.startsWith(prefix) ? key.slice(prefix.length) : "";
    if (!RECORD_NAME.test(name)) continue;
    const found = judged(factoryId, text);
    if (found === undefined) unreadable.push(key);
    else records.push({ startedAt: name.slice(0, STARTED_AT_LENGTH), judged: found });
  }
  if (unreadable.length > 0) return { kind: "unreadable", records: unreadable };
  // Records are in the order they started: the last change is the latest.
  const lastChange = records.filter(({ judged }) => judged.kind === "changed").at(-1)?.startedAt;
  const keys = records.flatMap(({ startedAt, judged }) =>
    judged.kind === "teardown" && (lastChange === undefined || startedAt > lastChange)
      ? judged.keys
      : [],
  );
  return { kind: "remembered", keys: [...new Set(keys)] };
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
    summary: "summary" in outcome ? outcome.summary : null,
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
