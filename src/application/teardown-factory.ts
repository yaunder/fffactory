/**
 * `fffactory teardown` (`docs/specs/teardown.md`, epic #56): removes everything a factory owns,
 * under the factory-wide lock and its operation record, and keeps every persistent source it
 * only refers to. In order (§Order): the checks that need no AWS, the account check and the
 * pin guard, the lock; under it the admin client, the inventory, the guarded destroy plan
 * (D13), what will be removed and kept, the confirmation by factory ID (D2), dispatch stopped
 * on every running worker (D3), one fresh inspection of each by terminate's gates, with no
 * `--force` (D4), the destroy, proof that nothing tagged remains (D12), the tailnet devices
 * (D9), the owned secrets (D7, D8), the local saved plans, and last the state bucket (D6),
 * which deletes the lock and the record with it. factory.json is never written (D11).
 *
 * A refusal, a decline or a failure before the destroy deletes nothing and releases the lock;
 * a refusal after dispatch was stopped leaves it stopped, for `fffactory apply` to restart.
 * Once the destroy started, what stops the run is `partial`: how far it got and what remains
 * of each kind. A rerun inventories again and finishes from what remains, an admin client an
 * earlier teardown already deleted included (§Rerun). An interrupt keeps the lock, and is
 * reported whatever the run returned (§Interruption).
 *
 * Without a state bucket there is no lock to take and no record to write (§No state bucket,
 * D10): once EC2 lists nothing tagged with the factory ID, the same review, confirmation and
 * removal of the devices and owned secrets run without them, and never create a bucket.
 */
import {
  type AccountExpectation,
  accountExpectation,
  type CredentialSelection,
} from "../domain/aws-account";
import type { UnreadyBucket } from "../domain/backend-bootstrap";
import type { HeldLock } from "../domain/factory-lock";
import type { RandomBytes } from "../domain/initialization";
import {
  assessCompleteness,
  type FactoryId,
  type FactoryInstance,
  type Host,
  parseHostKey,
  type Release,
  type SecretReference,
} from "../domain/instance";
import {
  type DispatchRecord,
  finishOperation,
  type OperationRecord,
  type OperationStatus,
  operationKey,
  type StageStatus,
  startStageOperation,
  TEARDOWN_OPERATION,
  withDispatch,
  withStage,
} from "../domain/operation";
import {
  changesSomething,
  newPlanId,
  type PlanTarget,
  pinRefusal,
  type ResourceChange,
  resourceChanges,
} from "../domain/plan";
import { placedRepositories } from "../domain/repository-placement";
import { hostName } from "../domain/resource-naming";
import type { WorkerIdentity } from "../domain/rollout";
import {
  classifySecrets,
  type SecretInventory,
  secretReferences,
  secretRegion,
} from "../domain/secrets";
import { recordedHostKeys } from "../domain/stable-host-keys";
import type { BucketDeletion, LockAfterDeletion } from "../domain/state-bucket-deletion";
import { locateWorker, type Machine } from "../domain/status";
import type { TailnetDevice } from "../domain/tailnet";
import {
  bucketAppeared,
  bucketRemains,
  bucketUnreachable,
  DEVICES_NOT_CHECKED,
  destroyApplyFailed,
  destroyKeysUnreadable,
  destroyPlanMismatch,
  destroyPlanningFailed,
  destroyPlanRefusal,
  destroyProjectionRefusal,
  devicesRemain,
  dispatchNotStopped,
  type FactoryDevices,
  inventoryUnavailable,
  type KeptSecrets,
  keptSecrets,
  type ListedDevices,
  leftoversRemain,
  leftoversUnverified,
  machineInPassing,
  machinesChanged,
  NO_LISTED_DEVICES,
  ranWithoutLock,
  remainingAt,
  secretsRemain,
  selectFactoryDevices,
  shownDevices,
  shownMachines,
  stateStillRecords,
  stoppedPartWay,
  taggedWithoutBucket,
  type TeardownRemaining,
  type TeardownBucket,
  type TeardownInterruption,
  type TeardownReport,
  type TeardownReview,
  type TeardownStep,
  type TeardownStop,
  teardownAdminClientGone,
  teardownAdminClientMissing,
  teardownAdminClientUnusable,
  teardownAdminSecretUnreadable,
  teardownConfirmation,
  teardownConfirmMismatch,
  teardownFailed,
  teardownGateActions,
  teardownQuestion,
  thenRerunTeardown,
  typedIdConfirms,
  underFactoryNames,
} from "../domain/teardown";
import { type Refusal, removalGate } from "../domain/worker-lifecycle";
import type { OperationLocation } from "./apply-factory";
import { stateBucketState } from "./bootstrap-backend";
import type { CallerIdentity } from "./caller-identity";
import type { ControlPlane } from "./control-plane";
import { deleteOwnedSecret } from "./delete-owned-secret";
import {
  acquireFactoryLock,
  type FactoryLock,
  type Interrupted,
  lockHolder,
  settleFactoryLock,
  stateBucketOf,
} from "./factory-lock";
import type { HostTransport } from "./host-transport";
import { type LockStore, type StateBucket, StateBucketUnreachable } from "./lock-store";
import type { MachineInventorySource } from "./machine-inventory";
import type { OperatorPrompt } from "./operator-prompt";
import { factoryTarget } from "./plan-factory";
import type { PlanStore } from "./plan-store";
import { projectFactoryVariables } from "./project-terraform-inputs";
import { diagnosticsFileOf, type Provisioner, type SavedPlanRequest } from "./provisioner";
import { type AccountRequirement, requireExpectedAccount } from "./require-expected-account";
import type { SecretPresence, SecretStore } from "./secret-store";
import { stopDispatch } from "./stop-dispatch";
import type { TailnetAdmin, TailnetAdminSession } from "./tailnet-admin";
import type { TailnetPeers } from "./tailnet-peers";
import { deleteDevices, inspectForRemoval, openTailnetAdmin } from "./worker-removal";
import type { WorkflowQueue } from "./workflow-queue";

export interface TeardownDependencies {
  readonly identity: CallerIdentity;
  readonly lockStore: LockStore;
  /** The factory's tagged instances and VPCs. */
  readonly machines: MachineInventorySource;
  readonly peers: TailnetPeers;
  readonly transport: HostTransport;
  /** Reads each running worker's agent activity; without one, none can be inspected. */
  readonly controlPlane: ControlPlane | undefined;
  /** Stops dispatch on each running worker. */
  readonly workflowQueue: WorkflowQueue;
  readonly prompt: OperatorPrompt;
  /** Lists and deletes the factory's secrets, and reads its admin client. */
  readonly secrets: SecretStore;
  /** Lists and deletes the factory's tailnet devices. */
  readonly tailnetAdmin: TailnetAdmin;
  /** Plans and applies the factory root's guarded destroy with managed Terraform. */
  readonly provisioner: Provisioner;
  /** Keeps the destroy plan's file while the operation runs; its plans are removed at the end. */
  readonly planStore: PlanStore;
  /** This release's materialized Terraform tree. */
  readonly terraformDirectory: () => Promise<string>;
  readonly interrupted: Interrupted;
  /** Waits `ms` while a deleted secret is looked for, or less once interrupted. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly progress: (event: TeardownProgress) => void;
}

export interface TeardownRequest {
  readonly instance: FactoryInstance;
  /** Where factory.json is, shown with what teardown removes; it is never written. */
  readonly instancePath: string;
  readonly credentials: CredentialSelection;
  /** The running fffactory's release, which must be the one factory.json pins. */
  readonly release: Release;
  /**
   * `--confirm`, the factory ID given in advance, for use without a terminal. Any other value
   * refuses, never echoed.
   */
  readonly confirm?: string | undefined;
  /** This machine's name, recorded as the lock holder's host. */
  readonly host: string;
  readonly clock: () => Date;
  readonly randomBytes: RandomBytes;
}

/** What the operator is told while teardown runs. */
export type TeardownProgress =
  /** What will be removed and kept, shown before the confirmation. */
  | { readonly kind: "review"; readonly review: TeardownReview }
  | { readonly kind: "stopping_dispatch"; readonly hostname: string }
  /** A stopped worker passes the gates uninspected. */
  | { readonly kind: "uninspected_stopped"; readonly hostname: string }
  | { readonly kind: "destroying" }
  | { readonly kind: "removing_devices" }
  | { readonly kind: "removing_secrets" }
  | { readonly kind: "deleting_bucket"; readonly bucket: string };

export type FactoryTeardown =
  /** No terminal to confirm at, and no `--confirm`. */
  | { readonly kind: "unconfirmable" }
  | { readonly kind: "incomplete"; readonly missing: readonly string[] }
  | {
      readonly kind: "account_refused";
      readonly requirement: Extract<AccountRequirement, { readonly allowed: false }>;
      readonly expectation: AccountExpectation;
    }
  /** The CLI/pin match guard: this fffactory is not the release factory.json pins. */
  | { readonly kind: "release_mismatch"; readonly message: string }
  /** The state bucket exists without every setting backend bootstrap applies. */
  | { readonly kind: "unready_bucket"; readonly bucket: UnreadyBucket }
  | { readonly kind: "locked"; readonly held: HeldLock | undefined }
  /**
   * Interrupted holding no lock: before the lock was taken, or without a state bucket, which
   * takes none (`withoutLock`: how far it got, `removing` once it reached the devices step, and
   * the devices listed but kept, with no record, no dispatch stopped and the lock `none`), as
   * `interruptedTeardown` words it.
   */
  | {
      readonly kind: "interrupted";
      readonly locked: false;
      readonly withoutLock?: TeardownInterruption & {
        readonly record: false;
        readonly lock: "none";
      };
    }
  /**
   * Interrupted holding the lock, which it never released: it stays with the record as far as
   * it was written, unless the state bucket's deletion reached it (`lock`). `record` is
   * undefined once the bucket's deletion started: the record may be gone with it.
   * `interruptedTeardown` (`src/domain/teardown.ts`) words it.
   */
  | {
      readonly kind: "interrupted";
      readonly locked: true;
      readonly record: OperationLocation | undefined;
      /** The last step it started. */
      readonly reached: TeardownStep;
      /** Whether it had reached the destroy step: from there on the factory may be partly removed. */
      readonly removing: boolean;
      /** The workers dispatch was stopped on, which `fffactory apply` restarts. */
      readonly dispatchStopped: readonly string[];
      /** The devices the devices step listed but kept, the operator's to check. */
      readonly listedDevices: ListedDevices;
      readonly lock: LockAfterDeletion;
    }
  /**
   * Refused, deleting nothing: before the lock or without one (`operation` undefined), or under
   * it. `dispatchStopped` names the workers dispatch was stopped on before the refusal, which
   * `fffactory apply` restarts.
   */
  | {
      readonly kind: "refused";
      readonly refusals: readonly Refusal[];
      readonly operation: OperationLocation | undefined;
      readonly dispatchStopped: readonly string[];
      readonly recordFailure?: string | undefined;
    }
  /** Not confirmed: nothing changed. `operation` is undefined without a lock. */
  | {
      readonly kind: "declined";
      readonly operation: OperationLocation | undefined;
      readonly recordFailure: string | undefined;
    }
  /**
   * Failed before the destroy: nothing was deleted. `dispatchStopped` names the workers
   * dispatch was stopped on first, which `fffactory apply` restarts.
   */
  | {
      readonly kind: "failed";
      readonly refusal: Refusal;
      readonly operation: OperationLocation | undefined;
      readonly dispatchStopped: readonly string[];
      readonly recordFailure: string | undefined;
      /** The private local file keeping a failed Terraform command's diagnostics, if any. */
      readonly diagnosticsFile?: string | undefined;
    }
  /**
   * Stopped once the destroy was applied, or as it was: some of the factory is removed. How far
   * it got (`stoppedAt`), what remains of each kind (`remaining`), and `refusal`: what failed,
   * then what remains, and the next action, a rerun or a step by hand before it
   * (§Partial failure). Without a lock, `operation` is undefined and no bucket remains.
   */
  | {
      readonly kind: "partial";
      readonly stoppedAt: TeardownStop;
      readonly remaining: TeardownRemaining;
      readonly refusal: Refusal;
      readonly operation: OperationLocation | undefined;
      readonly recordFailure: string | undefined;
      readonly diagnosticsFile?: string | undefined;
    }
  /**
   * Everything the factory owns is removed, the state bucket last: the lock and the operation
   * record went with it, so there is no record to name. Without a state bucket, there was none
   * (`report.withoutLock`).
   */
  | { readonly kind: "done"; readonly report: TeardownReport };

/** Everything teardown works with once the checks before AWS passed. */
interface Teardown {
  readonly request: TeardownRequest;
  readonly factoryId: FactoryId;
  readonly region: string;
  readonly tag: string;
  readonly bucket: StateBucket;
  readonly adminClient: SecretReference;
  /** Whether the confirmation is asked at the terminal: no `--confirm` was given. */
  readonly asks: boolean;
}

type Checked = { readonly kind: "checked"; readonly teardown: Teardown } | FactoryTeardown;

function refusedBefore(refusal: Refusal): FactoryTeardown {
  return { kind: "refused", refusals: [refusal], operation: undefined, dispatchStopped: [] };
}

/** The fields teardown cannot do without, or undefined when one is missing. */
function located(request: TeardownRequest) {
  const { instance } = request;
  const factoryId = instance.factory_id;
  const region = instance.aws?.region;
  const tag = instance.tailscale?.tag;
  const location = stateBucketOf(instance, request.credentials);
  if (!factoryId || !region || !tag || !location.ok) return undefined;
  return { factoryId, region, tag, bucket: location.bucket };
}

/**
 * The checks that need no AWS: a confirmation possible, factory.json complete with its admin
 * client, and `--confirm`, when given, naming the factory ID.
 */
function localChecks(deps: TeardownDependencies, request: TeardownRequest): Checked {
  if (request.confirm === undefined && !deps.prompt.interactive) return { kind: "unconfirmable" };
  const { missing } = assessCompleteness(request.instance);
  const fields = located(request);
  if (missing.length > 0 || fields === undefined) return { kind: "incomplete", missing };
  const adminClient = request.instance.tailscale?.admin_client_secret;
  if (adminClient === undefined) return refusedBefore(teardownAdminClientMissing());
  const confirmation = teardownConfirmation(
    request.confirm,
    deps.prompt.interactive,
    fields.factoryId,
  );
  // The factory ID is valid: a `--confirm` that differs is never echoed, it could be a secret.
  if (confirmation === "mismatch") return refusedBefore(teardownConfirmMismatch(fields.factoryId));
  return {
    kind: "checked",
    teardown: { request, ...fields, adminClient, asks: confirmation === "ask" },
  };
}

/** Removes the whole factory (`docs/specs/teardown.md`). */
export async function teardownFactory(
  deps: TeardownDependencies,
  request: TeardownRequest,
): Promise<FactoryTeardown> {
  const checked = localChecks(deps, request);
  if (checked.kind !== "checked") return checked;
  const { teardown } = checked;
  const { instance, credentials } = request;
  const expectation = accountExpectation(instance);
  const account = await requireExpectedAccount(deps.identity, { expectation, credentials });
  if (!account.allowed) return { kind: "account_refused", requirement: account, expectation };
  const mismatch = pinRefusal(instance.release, request.release);
  if (mismatch !== undefined) return { kind: "release_mismatch", message: mismatch };
  const bucket = await bucketChecked(deps, teardown);
  if (typeof bucket !== "string") return bucket;
  if (deps.interrupted()) return { kind: "interrupted", locked: false };
  if (bucket === "missing") return withoutBucket(deps, teardown);
  const acquisition = await acquireFactoryLock(deps.lockStore, {
    bucket: teardown.bucket,
    operation: TEARDOWN_OPERATION,
    holder: lockHolder(account, request.host),
    release: request.release,
    now: request.clock(),
    randomBytes: request.randomBytes,
  });
  if (!acquisition.acquired) return { kind: "locked", held: acquisition.held };
  return underLock(deps, teardown, acquisition.lock);
}

/**
 * The state bucket before any lock: `ready`, `missing` (§No state bucket: S3 no longer finds
 * it, never created), or how it ends the teardown: unready, or answering 403, which may be
 * another account's bucket by now (§Rerun), never taken for the factory's.
 */
async function bucketChecked(
  deps: TeardownDependencies,
  teardown: Teardown,
): Promise<"ready" | "missing" | FactoryTeardown> {
  try {
    const bucket = await stateBucketState(deps.lockStore, teardown.bucket);
    if (bucket.kind === "unready") return { kind: "unready_bucket", bucket: bucket.bucket };
    return bucket.kind === "missing" ? "missing" : "ready";
  } catch (error) {
    return refusedBefore(unreachable(error, teardown));
  }
}

/** S3's 403 for the state bucket (`StateBucketUnreachable`) as a refusal; other errors are rethrown. */
function unreachable(error: unknown, teardown: Teardown): Refusal {
  if (!(error instanceof StateBucketUnreachable)) throw error;
  return bucketUnreachable(teardown.bucket.bucket, teardown.bucket.accountId);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DispatchOutcome = WorkerIdentity & {
  readonly kind: DispatchRecord["status"];
  readonly summary?: string;
};

/** Where the teardown records each step, and how far it got. */
interface TeardownLog {
  /** Whether it holds the lock and writes its record: not without a state bucket. */
  readonly locked: boolean;
  /** Where its record is; undefined without one. */
  readonly location: OperationLocation | undefined;
  readonly written: () => boolean;
  /** The last step started, whether or not its record was written; never one after the interrupt. */
  readonly reached: () => TeardownStep;
  readonly gone: () => boolean;
  /** The bucket, and the lock and record in it, are deleted. */
  readonly deleted: () => void;
  readonly seal: () => void;
  readonly start: () => Promise<void>;
  readonly stage: (status: TeardownStep) => Promise<void>;
  readonly dispatch: (outcomes: readonly DispatchOutcome[]) => Promise<void>;
  /** Ends the record; resolves to why its write failed, if it did. */
  readonly finish: (
    status: StageStatus,
    outcome: Exclude<OperationStatus, "running">,
    failure?: string,
  ) => Promise<string | undefined>;
}

/**
 * Records each step of the teardown in the state bucket as it happens. From an interrupt on it
 * writes nothing more. Once the bucket is deleted the record is gone with it (`gone`): nothing
 * is written into the bucket, and the lock, gone too, is never released. A bucket left without
 * the lock held is `sealed`: nothing more is written into it, since that would write anew into
 * a bucket being emptied, but releasing the lock by its version stays harmless.
 */
function teardownLog(
  deps: TeardownDependencies,
  teardown: Teardown,
  lock: FactoryLock,
): TeardownLog {
  const { clock } = teardown.request;
  let record: OperationRecord = startStageOperation(lock.record, TEARDOWN_OPERATION, "authorizing");
  let written = false;
  let reached: TeardownStep = "authorizing";
  let state: "open" | "sealed" | "gone" = "open";
  const write = async (next: OperationRecord) => {
    if (deps.interrupted() || state !== "open") return;
    record = next;
    await deps.lockStore.writeOperation(lock.bucket, next);
    written = true;
  };
  return {
    locked: true,
    location: { bucket: lock.bucket.bucket, key: operationKey(record) },
    written: () => written,
    reached: () => reached,
    gone: () => state === "gone",
    deleted: () => {
      state = "gone";
    },
    seal: () => {
      if (state === "open") state = "sealed";
    },
    start: () => write(record),
    stage: async (status: TeardownStep) => {
      // Interrupted, the step is never started: the caller checks the interrupt next.
      if (deps.interrupted()) return;
      reached = status;
      await write(withStage(record, TEARDOWN_OPERATION, status, clock()));
    },
    dispatch: (outcomes) => write(withDispatch(record, outcomes, clock())),
    finish: (status, outcome, failure) =>
      write(
        finishOperation(
          withStage(record, TEARDOWN_OPERATION, status, clock()),
          outcome,
          clock(),
          failure,
        ),
      ).then(() => undefined, reasonOf),
  };
}

/**
 * Without a state bucket there is no lock and no record (§No state bucket): this log writes
 * nothing, and only follows the step reached, for an interruption to report.
 */
function locklessLog(deps: TeardownDependencies): TeardownLog {
  let reached: TeardownStep = "authorizing";
  return {
    locked: false,
    location: undefined,
    written: () => false,
    reached: () => reached,
    gone: () => false,
    deleted: () => undefined,
    seal: () => undefined,
    start: async () => undefined,
    stage: async (status) => {
      if (!deps.interrupted()) reached = status;
    },
    dispatch: async () => undefined,
    finish: async () => undefined,
  };
}

/** How far the teardown got, and what it knows is left, for whatever ends it. */
interface Progress {
  /** The state bucket, which remains until the very end; undefined when S3 found none. */
  readonly bucket: string | undefined;
  /** Where it is once it reached the destroy step; undefined before. */
  stop: TeardownStop | undefined;
  /** The workers dispatch was stopped on, as each stop completes. */
  readonly dispatchStopped: string[];
  /** The devices left by ID: the review's to delete, then those not deleted. */
  devices: readonly string[] | "unchecked";
  /**
   * The devices the devices step listed but kept: carried to whatever ends the run, since no
   * rerun lists them again once the admin client is deleted.
   */
  listedDevices: ListedDevices;
  /** The owned secrets left by name: every one, then those not confirmed gone. */
  secrets: readonly string[];
  /** What became of the lock once the bucket's deletion started; undefined before. */
  lock: LockAfterDeletion | undefined;
}

/** How far a teardown got, and what it knows is left, before anything is removed. */
function progressFrom(bucket: string | undefined): Progress {
  return {
    bucket,
    stop: undefined,
    dispatchStopped: [],
    devices: [],
    listedDevices: NO_LISTED_DEVICES,
    secrets: [],
    lock: undefined,
  };
}

/**
 * Interrupted: the lock is kept (`settleFactoryLock`), and the record named only while it is
 * not being deleted with the bucket. Without a state bucket, there is no lock to keep.
 */
function interruptedUnder(log: TeardownLog, progress: Progress): FactoryTeardown {
  if (!log.locked)
    return {
      kind: "interrupted",
      locked: false,
      withoutLock: {
        reached: log.reached(),
        removing: progress.stop !== undefined,
        record: false,
        dispatchStopped: [],
        listedDevices: progress.listedDevices,
        lock: "none",
      },
    };
  return {
    kind: "interrupted",
    locked: true,
    record: log.written() && progress.lock === undefined ? log.location : undefined,
    reached: log.reached(),
    removing: progress.stop !== undefined,
    dispatchStopped: [...progress.dispatchStopped],
    listedDevices: progress.listedDevices,
    lock: progress.lock ?? "held",
  };
}

async function refusedUnder(
  log: TeardownLog,
  progress: Progress,
  refusals: readonly Refusal[],
): Promise<FactoryTeardown> {
  const recordFailure = await log.finish("refused", "refused", refusals[0]?.summary);
  const dispatchStopped = [...progress.dispatchStopped];
  return { kind: "refused", refusals, operation: log.location, dispatchStopped, recordFailure };
}

async function failedUnder(
  log: TeardownLog,
  progress: Progress,
  refusal: Refusal,
  diagnosticsFile?: string,
): Promise<FactoryTeardown> {
  const recordFailure = await log.finish("failed", "failed", refusal.summary);
  return {
    kind: "failed",
    refusal,
    operation: log.location,
    dispatchStopped: [...progress.dispatchStopped],
    recordFailure,
    ...(diagnosticsFile === undefined ? {} : { diagnosticsFile }),
  };
}

/** Stopped part way, at `progress.stop`: what failed, then what remains of each kind. */
async function partialUnder(
  log: TeardownLog,
  progress: Progress,
  refusal: Refusal,
  diagnosticsFile?: string,
): Promise<FactoryTeardown> {
  const stoppedAt = progress.stop ?? "destroy";
  const remaining = remainingAt(stoppedAt, progress);
  const recordFailure = await log.finish("partial", "partial", refusal.summary);
  return {
    kind: "partial",
    stoppedAt,
    remaining,
    refusal: stoppedPartWay(refusal, remaining),
    operation: log.location,
    recordFailure,
    ...(diagnosticsFile === undefined ? {} : { diagnosticsFile }),
  };
}

/**
 * Every step under the lock, which it settles at the end: released unless interrupted, and
 * never once the bucket, and the lock with it, is deleted. An interrupt keeps the lock, so the
 * outcome is then reported as interrupted, whatever the run returned, even one that landed
 * during its last record write, unless the bucket is already gone.
 */
async function underLock(
  deps: TeardownDependencies,
  teardown: Teardown,
  lock: FactoryLock,
): Promise<FactoryTeardown> {
  const log = teardownLog(deps, teardown, lock);
  const progress = progressFrom(teardown.bucket.bucket);
  try {
    const result = await operateOrFail(deps, teardown, log, progress, operate);
    return deps.interrupted() && !log.gone() ? interruptedUnder(log, progress) : result;
  } finally {
    if (!log.gone()) await settleFactoryLock(deps.lockStore, lock, deps.interrupted);
  }
}

/**
 * Without a state bucket (§No state bucket, D10): no lock to take, no record to write, and no
 * bucket ever created. An interrupt is reported whatever the run returned, unless it finished.
 */
async function withoutBucket(
  deps: TeardownDependencies,
  teardown: Teardown,
): Promise<FactoryTeardown> {
  const log = locklessLog(deps);
  const progress = progressFrom(undefined);
  const result = await operateOrFail(deps, teardown, log, progress, cleanUp);
  return deps.interrupted() && result.kind !== "done" ? interruptedUnder(log, progress) : result;
}

type Operation = (
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  progress: Progress,
) => Promise<FactoryTeardown>;

/**
 * The teardown, with an error recorded as its failure, or partial once it removes; once the
 * bucket's deletion may have reached the lock, nothing more is written.
 */
async function operateOrFail(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  progress: Progress,
  operation: Operation,
): Promise<FactoryTeardown> {
  try {
    if (deps.interrupted()) return interruptedUnder(log, progress);
    return await operation(deps, teardown, log, progress);
  } catch (error) {
    if (deps.interrupted()) return interruptedUnder(log, progress);
    if (progress.lock !== undefined && progress.lock !== "held") log.seal();
    const refusal = teardownFailed(reasonOf(error));
    return progress.stop === undefined
      ? failedUnder(log, progress, refusal)
      : partialUnder(log, progress, refusal);
  }
}

/** What teardown found before it removes anything. */
interface Inventory {
  readonly machines: readonly Machine[];
  readonly vpcIds: readonly string[];
  /** The tailnet's devices; undefined when the admin client is already gone: not checked. */
  readonly devices: readonly TailnetDevice[] | undefined;
  readonly secrets: SecretInventory;
  /** The secrets kept (`keptSecrets`), `unlisted` without those already absent. */
  readonly kept: KeptSecrets;
  /** References under `<id>/` the listing did not find and DescribeSecret no longer finds. */
  readonly absent: readonly SecretReference[];
}

/**
 * The admin session, then the inventory, its EC2 instances and VPCs judged by `judged`; how it
 * ended otherwise.
 */
async function inventoried(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  progress: Progress,
  judged: Judged,
): Promise<{ readonly kind: "run"; readonly run: Run } | FactoryTeardown> {
  await log.start();
  const admin = await authorize(deps, teardown);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (admin.kind === "refused") return refusedUnder(log, progress, [admin.refusal]);
  await log.stage("inventorying");
  const session = admin.kind === "open" ? admin.session : undefined;
  const listing = await listInventory(deps, teardown, session, judged);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (listing.kind === "refused") return refusedUnder(log, progress, listing.refusals);
  progress.secrets = listing.inventory.secrets.owned.map(({ name }) => name);
  return { kind: "run", run: { inventory: listing.inventory, admin: session, progress } };
}

/** The admin session, then the inventory, then the destroy plan in a plan directory of its own. */
async function operate(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  progress: Progress,
): Promise<FactoryTeardown> {
  const passing: Judged = (machines) => machines.flatMap((machine) => inPassing(teardown, machine));
  const begun = await inventoried(deps, teardown, log, progress, passing);
  if (begun.kind !== "run") return begun;
  const { factoryId } = teardown;
  const planId = newPlanId(teardown.request.randomBytes);
  const files = await deps.planStore.create(factoryId, planId);
  try {
    return await planned(deps, teardown, log, begun.run, files.factory);
  } finally {
    // Once the bucket is gone the plans went before it (`removeAll`): nothing after the
    // bucket's deletion may turn a finished teardown into a failure. Nor may this plan's
    // directory, which no record names and the next teardown's `removeAll` removes: a removal
    // that fails is left at that, never overwriting how the run ended.
    if (!log.gone()) await deps.planStore.remove(factoryId, planId).catch(() => undefined);
  }
}

/**
 * The factory's tailnet admin session, opened before anything is listed, so a client that
 * cannot delete its devices refuses the teardown instead of leaving them behind; or `gone`, the
 * admin client's secret deleted as an earlier teardown leaves it (`adminClientGone`), which
 * `planned` accepts only once nothing else of the factory but what follows the devices is left.
 */
async function authorize(
  deps: TeardownDependencies,
  teardown: Teardown,
): Promise<
  | { readonly kind: "open"; readonly session: TailnetAdminSession }
  | { readonly kind: "gone" }
  | { readonly kind: "refused"; readonly refusal: Refusal }
> {
  const opening = await openTailnetAdmin(deps, {
    reference: teardown.adminClient,
    region: teardown.region,
    credentials: teardown.request.credentials,
  });
  switch (opening.kind) {
    case "unreadable": {
      const presence = await adminClientPresence(deps, teardown);
      if (presence === "absent") return { kind: "gone" };
      const found = presence === "present";
      return { kind: "refused", refusal: teardownAdminSecretUnreadable(opening.reason, found) };
    }
    case "unusable":
      return { kind: "refused", refusal: teardownAdminClientUnusable(opening.reason) };
    case "open":
      // Undefined only once interrupted, which the caller checks first.
      return { kind: "open", session: opening.session as TailnetAdminSession };
  }
}

/**
 * Whether the admin client's secret, unreadable, is gone as only teardown deletes it: `absent`
 * when named under the factory's names (`<id>/`) and no longer found by DescribeSecret in the
 * Region its ARN names (`secretRegion`; asked anywhere else, its absence would prove nothing).
 * A look that fails (`failed`), or finds it (`present`, perhaps pending deletion), is no proof:
 * the read's failure stands. Undefined when it is not under the factory's names: not looked for.
 */
async function adminClientPresence(
  deps: TeardownDependencies,
  teardown: Teardown,
): Promise<SecretPresence["kind"] | undefined> {
  const reference = teardown.adminClient;
  if (!underFactoryNames(teardown.factoryId, reference)) return undefined;
  const presence = await deps.secrets.exists({
    reference,
    region: secretRegion(reference),
    credentials: teardown.request.credentials,
  });
  return presence.kind;
}

/**
 * The secrets teardown keeps, and the references under `<id>/` the listing did not find that
 * DescribeSecret no longer finds either: already absent, as a rerun finds them. One still
 * found, or whose look failed, stays `unlisted`.
 */
async function sortedSecrets(
  deps: TeardownDependencies,
  teardown: Teardown,
  secrets: SecretInventory,
): Promise<Pick<Inventory, "kept" | "absent">> {
  const kept = keptSecrets(teardown.factoryId, secrets);
  const { credentials } = teardown.request;
  const looks = await Promise.all(
    kept.unlisted.map((reference) =>
      deps.secrets.exists({ reference, region: secretRegion(reference), credentials }),
    ),
  );
  const gone = (index: number) => looks[index]?.kind === "absent";
  return {
    kept: { ...kept, unlisted: kept.unlisted.filter((_, index) => !gone(index)) },
    absent: kept.unlisted.filter((_, index) => gone(index)),
  };
}

type Listing =
  | { readonly kind: "listed"; readonly inventory: Inventory }
  | { readonly kind: "refused"; readonly refusals: readonly Refusal[] };

/** Why the factory's tagged instances and VPCs, as EC2 lists them, refuse the teardown. */
type Judged = (machines: readonly Machine[], vpcIds: readonly string[]) => readonly Refusal[];

/**
 * The factory's tagged instances and VPCs, its secrets and the tailnet's devices (none
 * without an admin session: not checked). A listing that fails refuses: it is never taken for
 * one that found nothing. What `judged` finds in EC2's listings refuses too, before anything
 * is asked: under the lock, a worker's machine on its way to running or stopped; without a
 * state bucket, anything tagged.
 */
async function listInventory(
  deps: TeardownDependencies,
  teardown: Teardown,
  admin: TailnetAdminSession | undefined,
  judged: Judged,
): Promise<Listing> {
  const { credentials } = teardown.request;
  const { region, factoryId } = teardown;
  const [machines, vpcs, secrets, devices] = await Promise.all([
    deps.machines.list(credentials, region, factoryId),
    deps.machines.listVpcs(credentials, region, factoryId),
    deps.secrets.list({ factoryId, region, credentials }),
    admin === undefined ? ({ kind: "unchecked" } as const) : admin.devices(),
  ]);
  const refused = (refusal: Refusal): Listing => ({ kind: "refused", refusals: [refusal] });
  if (machines.kind === "unavailable")
    return refused(inventoryUnavailable("instances", machines.reason));
  if (vpcs.kind === "unavailable") return refused(inventoryUnavailable("vpcs", vpcs.reason));
  if (secrets.kind === "failed") return refused(inventoryUnavailable("secrets", secrets.reason));
  if (devices.kind === "failed") return refused(inventoryUnavailable("devices", devices.reason));
  const refusals = judged(machines.machines, vpcs.vpcIds);
  if (refusals.length > 0) return { kind: "refused", refusals };
  const classified = classifySecrets(
    factoryId,
    secrets.secrets,
    secretReferences(teardown.request.instance),
  );
  return {
    kind: "listed",
    inventory: {
      machines: machines.machines,
      vpcIds: vpcs.vpcIds,
      devices: devices.kind === "unchecked" ? undefined : devices.devices,
      secrets: classified,
      ...(await sortedSecrets(deps, teardown, classified)),
    },
  };
}

/** The worker a machine's host key tag names, when it is a well-formed key. */
function workerOf(teardown: Teardown, machine: Machine): WorkerIdentity | undefined {
  const key = parseHostKey(machine.hostKey ?? "");
  return key.ok ? { key: key.value, hostname: hostName(teardown.factoryId, key.value) } : undefined;
}

function inPassing(teardown: Teardown, machine: Machine): Refusal[] {
  const worker = workerOf(teardown, machine);
  if (worker === undefined || (machine.state !== "pending" && machine.state !== "stopping"))
    return [];
  return [machineInPassing(worker, machine)];
}

type DestroyPlanning =
  | {
      readonly kind: "planned";
      /** The resource changes the plan makes, as shown for approval. */
      readonly changes: readonly ResourceChange[];
      /** Whether to apply it: Terraform reports changes. */
      readonly applies: boolean;
      readonly saved: SavedPlanRequest;
      /** The host keys the state records. */
      readonly recorded: readonly string[];
    }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | {
      readonly kind: "failed";
      readonly refusal: Refusal;
      readonly diagnosticsFile: string | undefined;
    }
  /** Interrupted between its Terraform commands: no further one was started. */
  | { readonly kind: "interrupted" };

/**
 * The guarded destroy plan (`docs/specs/provisioning.md` §Destroy plan): `plan -destroy` of the
 * factory root, under Terraform's state lock, with factory.json projected with the host keys
 * the state records, judged by `destroyPlanRefusal` over the instances EC2 lists, and refused
 * when Terraform's exit code and its JSON plan disagree. Once interrupted, it starts no further
 * Terraform command.
 */
async function planDestroy(
  deps: TeardownDependencies,
  teardown: Teardown,
  planFile: string,
  machines: readonly Machine[],
): Promise<DestroyPlanning> {
  const interrupted = { kind: "interrupted" } as const;
  try {
    const target = factoryTarget(teardown.bucket, await deps.terraformDirectory());
    if (deps.interrupted()) return interrupted;
    const recorded = recordedHostKeys(await deps.provisioner.output(target));
    if (deps.interrupted()) return interrupted;
    if (recorded === undefined) return { kind: "refused", refusal: destroyKeysUnreadable() };
    const projection = projectFactoryVariables(teardown.request.instance, recorded);
    if (!projection.ok)
      return { kind: "refused", refusal: destroyProjectionRefusal(projection.issues) };
    const saved = { ...target, planFile };
    const { changes: applies } = await deps.provisioner.plan({
      ...saved,
      variables: { ...projection.variables },
      stateLock: true,
      destroy: true,
    });
    if (deps.interrupted()) return interrupted;
    const shown = await deps.provisioner.showPlan(saved);
    const changes = resourceChanges(shown) ?? [];
    const refusal = destroyPlanRefusal(shown, machines) ?? destroyPlanMismatch(applies, changes);
    if (refusal !== undefined) return { kind: "refused", refusal };
    return { kind: "planned", changes: changes.filter(changesSomething), applies, saved, recorded };
  } catch (error) {
    return {
      kind: "failed",
      refusal: destroyPlanningFailed(reasonOf(error)),
      diagnosticsFile: diagnosticsFileOf(error),
    };
  }
}

/** One teardown's findings as it goes on. */
interface Run {
  readonly inventory: Inventory;
  /** Undefined when the admin client is already gone: the devices are not checked. */
  readonly admin: TailnetAdminSession | undefined;
  readonly progress: Progress;
}

/** What teardown removes from the devices on, once reviewed and confirmed. */
interface Removal extends Run {
  /** Every host key the factory knows: declared, recorded in its state, tagged in EC2. */
  readonly keys: readonly string[];
  /** The IDs of the devices the review showed deleted: no other is deleted unseen. */
  readonly shownDeleted: readonly string[];
  /** The destroy plan's changes: none without a state bucket. */
  readonly changes: readonly ResourceChange[];
  /** Whether the destroy plan changes anything, the `factory` root not already gone. */
  readonly destroys: boolean;
  /** Why it runs without the lock, the state bucket missing (`ranWithoutLock`); undefined under it. */
  readonly withoutLock: string | undefined;
}

interface Planned extends Removal {
  readonly planning: Extract<DestroyPlanning, { readonly kind: "planned" }>;
}

/** The plan, then what will be removed and kept, shown, then the confirmation. */
async function planned(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  run: Run,
  planFile: string,
): Promise<FactoryTeardown> {
  await log.stage("planning");
  if (deps.interrupted()) return interruptedUnder(log, run.progress);
  const planning = await planDestroy(deps, teardown, planFile, run.inventory.machines);
  if (planning.kind !== "planned") return unplanned(deps, log, run.progress, planning);
  if (deps.interrupted()) return interruptedUnder(log, run.progress);
  if (run.admin === undefined && remainsBeforeDevices(run.inventory, planning))
    return refusedUnder(log, run.progress, [teardownAdminClientGone()]);
  const keys = [
    ...declaredKeys(teardown),
    ...planning.recorded,
    ...run.inventory.machines.flatMap(({ hostKey }) => (hostKey === undefined ? [] : [hostKey])),
  ];
  const removal = reviewed(deps, teardown, run, {
    keys,
    changes: planning.changes,
    destroys: planning.applies,
    withoutLock: undefined,
  });
  const ended = await unconfirmed(deps, teardown, log, run.progress);
  if (ended !== undefined) return ended;
  return gated(deps, teardown, log, { ...removal, planning });
}

function declaredKeys(teardown: Teardown): string[] {
  return (teardown.request.instance.hosts ?? []).map(({ key }) => key);
}

/**
 * What will be removed and kept, shown before the confirmation (the `review` progress event):
 * the devices selected over every known key, whose IDs bound what the devices step deletes.
 */
function reviewed(
  deps: TeardownDependencies,
  teardown: Teardown,
  run: Run,
  removing: Omit<Removal, keyof Run | "shownDeleted">,
): Removal {
  const devices = selectFactoryDevices(
    run.inventory.devices ?? [],
    teardown.factoryId,
    removing.keys,
    teardown.tag,
  );
  const removal: Removal = {
    ...run,
    ...removing,
    shownDeleted: devices.deleted.map(({ id }) => id),
  };
  run.progress.devices = run.admin === undefined ? "unchecked" : removal.shownDeleted;
  deps.progress({ kind: "review", review: reviewOf(teardown, removal, devices) });
  return removal;
}

/**
 * Without a state bucket (§No state bucket, D10): refused when EC2 lists any instance (in any
 * state but `terminated`) or VPC tagged with the factory ID, its Terraform state lost with the
 * bucket.
 */
function taggedRefusals(
  teardown: Teardown,
  machines: readonly Machine[],
  vpcIds: readonly string[],
): Refusal[] {
  if (machines.length === 0 && vpcIds.length === 0) return [];
  return [taggedWithoutBucket(teardown.bucket.bucket, machines, vpcIds)];
}

/**
 * Without a state bucket: the admin session and the inventory, refused when anything tagged with
 * the factory ID is listed; the review and the confirmation; then, once the bucket is still
 * missing and nothing tagged has appeared, the devices, the owned secrets and the local saved
 * plans, as under the lock. Dispatch, gates and the destroy have nothing to act on.
 */
async function cleanUp(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  progress: Progress,
): Promise<FactoryTeardown> {
  const tagged: Judged = (machines, vpcIds) => taggedRefusals(teardown, machines, vpcIds);
  const begun = await inventoried(deps, teardown, log, progress, tagged);
  if (begun.kind !== "run") return begun;
  const removal = reviewed(deps, teardown, begun.run, {
    keys: declaredKeys(teardown),
    changes: [],
    destroys: false,
    withoutLock: ranWithoutLock(teardown.bucket.bucket),
  });
  const ended = await unconfirmed(deps, teardown, log, progress);
  if (ended !== undefined) return ended;
  await log.stage("verifying");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const changed = await stillWithoutBucket(deps, teardown);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (changed !== undefined) return refusedUnder(log, progress, [changed]);
  return removeDevices(deps, teardown, log, removal);
}

/**
 * Once confirmed without a lock, the factory as it was reviewed: still no state bucket, and EC2
 * still listing nothing tagged with the factory ID. Changed live state invalidates the review,
 * and a listing that fails is never taken for one that found nothing. Why it no longer holds,
 * or undefined. The interrupt is checked after every call (§Interruption): once it lands, no
 * further call starts and it answers undefined, the caller checking the interrupt first.
 */
async function stillWithoutBucket(
  deps: TeardownDependencies,
  teardown: Teardown,
): Promise<Refusal | undefined> {
  try {
    const exists = await deps.lockStore.bucketExists(teardown.bucket);
    if (deps.interrupted()) return undefined;
    if (exists) return bucketAppeared(teardown.bucket.bucket);
  } catch (error) {
    return unreachable(error, teardown);
  }
  const { credentials } = teardown.request;
  const { region, factoryId } = teardown;
  const machines = await deps.machines.list(credentials, region, factoryId);
  if (deps.interrupted()) return undefined;
  if (machines.kind === "unavailable") return inventoryUnavailable("instances", machines.reason);
  const vpcs = await deps.machines.listVpcs(credentials, region, factoryId);
  if (deps.interrupted()) return undefined;
  if (vpcs.kind === "unavailable") return inventoryUnavailable("vpcs", vpcs.reason);
  return taggedRefusals(teardown, machines.machines, vpcs.vpcIds)[0];
}

/** How a destroy plan that was not made ends the teardown: interrupted, refused or failed. */
async function unplanned(
  deps: TeardownDependencies,
  log: TeardownLog,
  progress: Progress,
  planning: Exclude<DestroyPlanning, { readonly kind: "planned" }>,
): Promise<FactoryTeardown> {
  if (planning.kind === "interrupted" || deps.interrupted()) return interruptedUnder(log, progress);
  if (planning.kind === "refused") return refusedUnder(log, progress, [planning.refusal]);
  return failedUnder(log, progress, planning.refusal, planning.diagnosticsFile);
}

/**
 * Whether anything teardown removes before its devices remains: instances or VPCs tagged with
 * the factory ID, or resources its state holds. An earlier teardown deletes the admin client
 * only once none does; with the admin client gone while one does, the devices could not be
 * deleted after it, so the teardown is refused.
 */
function remainsBeforeDevices(
  inventory: Inventory,
  planning: Extract<DestroyPlanning, { readonly kind: "planned" }>,
): boolean {
  return inventory.machines.length > 0 || inventory.vpcIds.length > 0 || planning.applies;
}

/** What will be removed and kept, as shown before the confirmation. */
function reviewOf(teardown: Teardown, run: Removal, devices: FactoryDevices): TeardownReview {
  const { instance, release, instancePath } = teardown.request;
  const target: PlanTarget = {
    instancePath,
    ...(instance.name === undefined ? {} : { name: instance.name }),
    factoryId: teardown.factoryId,
    accountId: teardown.bucket.accountId,
    region: teardown.region,
    release,
  };
  const { inventory } = run;
  return {
    target,
    changes: run.changes,
    machines: shownMachines(inventory.machines),
    vpcIds: inventory.vpcIds,
    devices: shownDevices(teardown.factoryId, devices),
    devicesUnchecked: run.admin === undefined ? DEVICES_NOT_CHECKED : undefined,
    secrets: {
      owned: inventory.secrets.owned.map(({ name, arn }) => ({ name, arn })),
      absent: inventory.absent,
      kept: inventory.kept,
    },
    bucket: bucketOf(teardown, run),
    withoutLock: run.withoutLock,
  };
}

/** The state bucket, and whether teardown deletes it: not one S3 did not find (§No state bucket). */
function bucketOf(teardown: Teardown, run: Removal): TeardownBucket {
  const outcome = run.progress.bucket === undefined ? "not_found" : "deleted";
  return { name: teardown.bucket.bucket, outcome };
}

/**
 * Confirmed in advance by `--confirm`, or the factory ID typed at the terminal; otherwise how
 * teardown ends: interrupted, or declined, recorded `declined` with the lock released.
 * Undefined once confirmed.
 */
async function unconfirmed(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  progress: Progress,
): Promise<FactoryTeardown | undefined> {
  if (!teardown.asks) return undefined;
  await log.stage("awaiting_approval");
  const answer = await deps.prompt.ask(teardownQuestion(teardown.factoryId, !log.locked));
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (typedIdConfirms(answer, teardown.factoryId)) return undefined;
  const recordFailure = await log.finish("declined", "declined");
  return { kind: "declined", operation: log.location, recordFailure };
}

/** A running worker EC2 lists, and its host in factory.json, when it declares one. */
interface RunningWorker {
  readonly worker: WorkerIdentity;
  readonly machine: Machine;
  readonly host: Host | undefined;
}

function runningWorkers(teardown: Teardown, machines: readonly Machine[]): RunningWorker[] {
  return machines.flatMap((machine) => {
    const worker = workerOf(teardown, machine);
    if (worker === undefined || machine.state !== "running") return [];
    const host = teardown.request.instance.hosts?.find(({ key }) => key === worker.key);
    return [{ worker, machine, host }];
  });
}

/**
 * Teardown's next actions for a worker: `worker terminate --force` for one factory.json
 * declares, the EC2 console for one it does not.
 */
function actionsFor({ worker, machine, host }: RunningWorker) {
  return teardownGateActions(worker, host === undefined ? machine.instanceId : undefined);
}

/**
 * Dispatch stopped on every running worker (D3), then one fresh inspection of each, judged by
 * terminate's gates without `--force` (D4); every refusal is reported, and leaves dispatch
 * stopped where it was.
 */
async function gated(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  run: Planned,
): Promise<FactoryTeardown> {
  const { progress } = run;
  await log.stage("stopping_dispatch");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const running = runningWorkers(teardown, run.inventory.machines);
  const refused = await stopDispatchEverywhere(deps, teardown, log, running, progress);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (refused.length > 0) return refusedUnder(log, progress, refused);
  await log.stage("inspecting");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const changed = await machinesRechecked(deps, teardown, run.inventory.machines);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (changed !== undefined) return refusedUnder(log, progress, [changed]);
  const refusals = await gateRefusals(deps, teardown, run.inventory.machines, running);
  if (refusals === undefined || deps.interrupted()) return interruptedUnder(log, progress);
  if (refusals.length > 0) return refusedUnder(log, progress, refusals);
  return destroy(deps, teardown, log, run);
}

/**
 * The factory's EC2 instances listed again once dispatch is stopped, before the inspection:
 * why the review no longer holds (`machinesChanged`), or why they could not be listed, which is
 * never taken for none. Undefined when they are as reviewed.
 */
async function machinesRechecked(
  deps: TeardownDependencies,
  teardown: Teardown,
  reviewed: readonly Machine[],
): Promise<Refusal | undefined> {
  const { credentials } = teardown.request;
  const listed = await deps.machines.list(credentials, teardown.region, teardown.factoryId);
  if (listed.kind === "unavailable") return inventoryUnavailable("instances", listed.reason);
  return machinesChanged(teardown.factoryId, reviewed, listed.machines);
}

/**
 * Stops dispatch on every running worker the tailnet locates (`stopDispatch`), recording each
 * outcome, and each worker stopped in `progress` as it is, so whatever ends the run names it;
 * one it does not locate is left to the gates, which refuse it. A stop that failed refuses the
 * teardown, naming the worker: its refusals.
 */
async function stopDispatchEverywhere(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  running: readonly RunningWorker[],
  progress: Progress,
): Promise<readonly Refusal[]> {
  const view = await deps.peers.view();
  const refusals: Refusal[] = [];
  const outcomes: Parameters<TeardownLog["dispatch"]>[0][number][] = [];
  for (const each of running) {
    if (deps.interrupted()) break;
    const { worker } = each;
    const location = locateWorker(view, worker, teardown.tag);
    if (location.kind !== "found") continue;
    deps.progress({ kind: "stopping_dispatch", hostname: worker.hostname });
    const stop = await stopDispatch(deps, location.worker);
    if (stop.kind === "failed") {
      refusals.push(dispatchNotStopped(worker, stop.reason, actionsFor(each)));
      outcomes.push({ ...worker, kind: "failed", summary: stop.reason });
    } else {
      progress.dispatchStopped.push(worker.hostname);
      outcomes.push({ ...worker, kind: "not_requested" });
    }
  }
  if (outcomes.length > 0) await log.dispatch(outcomes);
  return refusals;
}

/** Says that each stopped worker passes the gates uninspected, as it does for terminate. */
function passStopped(deps: TeardownDependencies, teardown: Teardown, machines: readonly Machine[]) {
  for (const machine of machines) {
    const worker = workerOf(teardown, machine);
    // Accepted risk, as for terminate: unpushed work on a stopped worker's disk goes unreported.
    if (worker !== undefined && machine.state === "stopped")
      deps.progress({ kind: "uninspected_stopped", hostname: worker.hostname });
  }
}

/** One running worker's fresh inspection, judged by `removalGate`; undefined once interrupted. */
async function gateOf(
  deps: TeardownDependencies,
  teardown: Teardown,
  each: RunningWorker,
): Promise<{ readonly refusal: Refusal | undefined } | undefined> {
  const repositories = teardown.request.instance.repositories ?? [];
  const placed = each.host === undefined ? [] : placedRepositories(repositories, each.host);
  const inspection = await inspectForRemoval(
    deps,
    { worker: each.worker, tag: teardown.tag, placed: placed.map(({ path }) => path) },
    thenRerunTeardown,
  );
  if (inspection === undefined) return undefined;
  return { refusal: removalGate(inspection, each.worker, actionsFor(each)) };
}

/**
 * Each running worker's fresh inspection (`inspectForRemoval`), judged by `removalGate`; a
 * stopped one passes uninspected. Undefined once interrupted.
 */
async function gateRefusals(
  deps: TeardownDependencies,
  teardown: Teardown,
  machines: readonly Machine[],
  running: readonly RunningWorker[],
): Promise<Refusal[] | undefined> {
  passStopped(deps, teardown, machines);
  const refusals: Refusal[] = [];
  for (const each of running) {
    const gate = await gateOf(deps, teardown, each);
    if (gate === undefined) return undefined;
    if (gate.refusal !== undefined) refusals.push(gate.refusal);
  }
  return refusals;
}

/** Applies exactly the approved destroy plan, then proves that nothing tagged remains (D12). */
async function destroy(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  run: Planned,
): Promise<FactoryTeardown> {
  const { progress } = run;
  await log.stage("applying");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  deps.progress({ kind: "destroying" });
  progress.stop = "destroy";
  if (run.planning.applies) {
    try {
      await deps.provisioner.applyPlan(run.planning.saved);
    } catch (error) {
      if (deps.interrupted()) return interruptedUnder(log, progress);
      const failed = destroyApplyFailed(reasonOf(error));
      return partialUnder(log, progress, failed, diagnosticsFileOf(error));
    }
  }
  progress.stop = "leftovers";
  await log.stage("verifying");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const leftover = await leftovers(deps, teardown, run.planning);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (leftover !== undefined) return partialUnder(log, progress, leftover);
  return removeDevices(deps, teardown, log, run);
}

/**
 * Why the factory cannot be taken for destroyed (D12): EC2 still lists instances or VPCs tagged
 * with its ID, outside its Terraform state, or cannot list them; or, once the destroy applied,
 * the state still records host keys, or cannot be read. Undefined when nothing is left, and
 * once interrupted, which the caller checks first: no Terraform command starts after it.
 */
async function leftovers(
  deps: TeardownDependencies,
  teardown: Teardown,
  planning: Extract<DestroyPlanning, { readonly kind: "planned" }>,
): Promise<Refusal | undefined> {
  const { credentials } = teardown.request;
  const { region, factoryId } = teardown;
  const [machines, vpcs] = await Promise.all([
    deps.machines.list(credentials, region, factoryId),
    deps.machines.listVpcs(credentials, region, factoryId),
  ]);
  if (machines.kind === "unavailable") return leftoversUnverified("instances", machines.reason);
  if (vpcs.kind === "unavailable") return leftoversUnverified("vpcs", vpcs.reason);
  if (machines.machines.length > 0 || vpcs.vpcIds.length > 0)
    return leftoversRemain(machines.machines, vpcs.vpcIds);
  if (!planning.applies || deps.interrupted()) return undefined;
  const recorded = recordedHostKeys(await deps.provisioner.output(planning.saved));
  if (recorded === undefined) return destroyKeysUnreadable();
  return recorded.length > 0 ? stateStillRecords(recorded) : undefined;
}

/**
 * Deletes the factory's tailnet devices (D9), listed afresh; any left behind stops the run with
 * the secrets kept, the admin client among them, so a rerun can delete them. With the admin
 * client already gone, they are not checked (`DEVICES_NOT_CHECKED`), and the run goes on.
 */
async function removeDevices(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  run: Removal,
): Promise<FactoryTeardown> {
  const { progress, admin } = run;
  progress.stop = "devices";
  if (admin === undefined)
    return removeSecrets(deps, teardown, log, run, { removed: [], possible: [], untagged: [] });
  await log.stage("removing_devices");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  deps.progress({ kind: "removing_devices" });
  const listing = await admin.devices();
  if (listing.kind === "failed")
    return partialUnder(log, progress, devicesRemain([], listing.reason));
  const selection = selectFactoryDevices(
    listing.devices,
    teardown.factoryId,
    run.keys,
    teardown.tag,
    run.shownDeleted,
  );
  const { possible, untagged } = shownDevices(teardown.factoryId, selection);
  progress.listedDevices = { possible, untagged };
  const { removed, failed } = await deleteDevices(admin, selection.deleted, deps.interrupted);
  progress.devices = selection.deleted.map(({ id }) => id).filter((id) => !removed.includes(id));
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (failed.length > 0) return partialUnder(log, progress, devicesRemain(failed, undefined));
  return removeSecrets(deps, teardown, log, run, { removed, possible, untagged });
}

type DevicesRemoved = TeardownReport["devices"];

/**
 * Deletes each owned secret in turn (`deleteOwnedSecret`), keeping `progress.secrets` to those
 * not yet confirmed gone, until an interrupt: those that remain, and why.
 */
async function deleteSecrets(
  deps: TeardownDependencies,
  teardown: Teardown,
  run: Removal,
): Promise<{ readonly name: string; readonly reason: string }[]> {
  const { clock, credentials } = teardown.request;
  const remaining: { readonly name: string; readonly reason: string }[] = [];
  const left = new Set(run.inventory.secrets.owned.map(({ name }) => name));
  for (const secret of run.inventory.secrets.owned) {
    if (deps.interrupted()) break;
    const deletion = await deleteOwnedSecret(
      { secrets: deps.secrets, clock, sleep: deps.sleep, interrupted: deps.interrupted },
      { secret, credentials },
    );
    if (deletion.kind === "remains") remaining.push({ name: secret.name, reason: deletion.reason });
    else left.delete(secret.name);
    run.progress.secrets = [...left];
  }
  return remaining;
}

/** Deletes every owned secret permanently and confirms it gone (D7, D8). */
async function removeSecrets(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  run: Removal,
  devices: DevicesRemoved,
): Promise<FactoryTeardown> {
  const { progress, inventory } = run;
  progress.stop = "secrets";
  await log.stage("removing_secrets");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  deps.progress({ kind: "removing_secrets" });
  const remaining = await deleteSecrets(deps, teardown, run);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (remaining.length > 0) return partialUnder(log, progress, secretsRemain(remaining));
  const report: TeardownReport = {
    // Without a state bucket no destroy plan was made: EC2 alone found nothing tagged.
    infrastructure:
      run.withoutLock !== undefined ? "not_found_by_ec2" : run.destroys ? "destroyed" : "absent",
    changes: run.changes,
    machines: shownMachines(inventory.machines),
    devices,
    devicesUnchecked: run.admin === undefined ? DEVICES_NOT_CHECKED : undefined,
    secrets: {
      removed: inventory.secrets.owned.map(({ name }) => name),
      absent: inventory.absent,
      kept: inventory.kept,
    },
    bucket: bucketOf(teardown, run),
    withoutLock: run.withoutLock,
  };
  return removeLast(deps, teardown, log, progress, report);
}

/**
 * The local saved plans, then the state bucket (D6); without one, the plans end it. On `absent`
 * the lock and the record went with it: nothing more is written, and the lock is not released. A bucket that remains with
 * the lock held ends recorded, and the lock is released; once its lock's versions were being
 * deleted, nothing more is written into it. From the deletion's start, `progress.lock` says
 * what became of the lock: `unknown` while S3 is asked, then the deletion's answer.
 */
async function removeLast(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  progress: Progress,
  report: TeardownReport,
): Promise<FactoryTeardown> {
  progress.stop = "plans";
  await log.stage("removing_plans");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  await deps.planStore.removeAll(teardown.factoryId);
  if (progress.bucket === undefined) return { kind: "done", report };
  progress.stop = "bucket";
  await log.stage("deleting_bucket");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  deps.progress({ kind: "deleting_bucket", bucket: teardown.bucket.bucket });
  progress.lock = "unknown";
  const deletion: BucketDeletion = await deps.lockStore.deleteBucket(
    teardown.bucket,
    deps.interrupted,
  );
  if (deletion.kind === "absent") {
    log.deleted();
    return { kind: "done", report };
  }
  progress.lock = deletion.lock;
  if (deletion.lock !== "held") log.seal();
  if (deps.interrupted()) return interruptedUnder(log, progress);
  return partialUnder(log, progress, bucketRemains(teardown.bucket.bucket, deletion));
}
