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
import { classifySecrets, type SecretInventory, secretReferences } from "../domain/secrets";
import { recordedHostKeys } from "../domain/stable-host-keys";
import type { BucketDeletion } from "../domain/state-bucket-deletion";
import { locateWorker, type Machine } from "../domain/status";
import type { TailnetDevice } from "../domain/tailnet";
import {
  bucketRemains,
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
  keptSecrets,
  leftoversRemain,
  leftoversUnverified,
  machineInPassing,
  machinesChanged,
  secretsRemain,
  selectFactoryDevices,
  shownDevices,
  shownMachines,
  type TeardownReport,
  type TeardownReview,
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
import type { LockStore, StateBucket } from "./lock-store";
import type { MachineInventorySource } from "./machine-inventory";
import type { OperatorPrompt } from "./operator-prompt";
import { factoryTarget } from "./plan-factory";
import type { PlanStore } from "./plan-store";
import { projectFactoryVariables } from "./project-terraform-inputs";
import { diagnosticsFileOf, type Provisioner, type SavedPlanRequest } from "./provisioner";
import { type AccountRequirement, requireExpectedAccount } from "./require-expected-account";
import type { SecretStore } from "./secret-store";
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
  /**
   * The state bucket does not exist.
   *
   * TODO(re-evaluate when #87 lands): clean up the devices and owned secrets without the lock
   * when EC2 lists nothing tagged, and refuse naming each tagged resource otherwise (D10).
   */
  | { readonly kind: "no_bucket" }
  /** The state bucket exists without every setting backend bootstrap applies. */
  | { readonly kind: "unready_bucket"; readonly bucket: UnreadyBucket }
  | { readonly kind: "locked"; readonly held: HeldLock | undefined }
  | { readonly kind: "interrupted"; readonly locked: false }
  /** Interrupted holding the lock, which stays with the record as far as it was written. */
  | {
      readonly kind: "interrupted";
      readonly locked: true;
      readonly record: OperationLocation | undefined;
    }
  /**
   * Refused, deleting nothing: before the lock (`operation` undefined), or under it.
   * `dispatchStopped` names the workers dispatch was stopped on before the refusal, which
   * `fffactory apply` restarts.
   */
  | {
      readonly kind: "refused";
      readonly refusals: readonly Refusal[];
      readonly operation: OperationLocation | undefined;
      readonly dispatchStopped: readonly string[];
      readonly recordFailure?: string | undefined;
    }
  /** Not confirmed: nothing changed. */
  | {
      readonly kind: "declined";
      readonly operation: OperationLocation;
      readonly recordFailure: string | undefined;
    }
  /** Failed before the destroy: nothing was deleted. */
  | {
      readonly kind: "failed";
      readonly refusal: Refusal;
      readonly operation: OperationLocation;
      readonly recordFailure: string | undefined;
      /** The private local file keeping a failed Terraform command's diagnostics, if any. */
      readonly diagnosticsFile?: string | undefined;
    }
  /**
   * Stopped once the destroy was applied, or as it was: some of the factory is removed, and
   * `refusal` says what was kept.
   *
   * TODO(re-evaluate when #86 lands): report what remains of each kind and how far teardown
   * got, and finish from every partial state on a rerun.
   */
  | {
      readonly kind: "partial";
      readonly refusal: Refusal;
      readonly operation: OperationLocation;
      readonly recordFailure: string | undefined;
      readonly diagnosticsFile?: string | undefined;
    }
  /**
   * Everything the factory owns is removed, the state bucket last: the lock and the operation
   * record went with it, so there is no record to name.
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
  const bucket = await stateBucketState(deps.lockStore, teardown.bucket);
  if (bucket.kind === "missing") return { kind: "no_bucket" };
  if (bucket.kind === "unready") return { kind: "unready_bucket", bucket: bucket.bucket };
  if (deps.interrupted()) return { kind: "interrupted", locked: false };
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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Records each step of the teardown in the state bucket as it happens. From an interrupt on it
 * writes nothing more. Once the bucket is deleted the record is gone with it (`gone`): nothing
 * is written into the bucket, and the lock, gone too, is never released. A bucket left without
 * the lock held is `sealed`: nothing more is written into it, since that would write anew into
 * a bucket being emptied, but releasing the lock by its version stays harmless.
 */
function teardownLog(deps: TeardownDependencies, teardown: Teardown, lock: FactoryLock) {
  const { clock } = teardown.request;
  let record: OperationRecord = startStageOperation(lock.record, TEARDOWN_OPERATION, "authorizing");
  let written = false;
  let state: "open" | "sealed" | "gone" = "open";
  const write = async (next: OperationRecord) => {
    if (deps.interrupted() || state !== "open") return;
    record = next;
    await deps.lockStore.writeOperation(lock.bucket, next);
    written = true;
  };
  return {
    location: { bucket: lock.bucket.bucket, key: operationKey(record) },
    written: () => written,
    gone: () => state === "gone",
    /** The bucket, and the lock and record in it, are deleted. */
    deleted: () => {
      state = "gone";
    },
    seal: () => {
      if (state === "open") state = "sealed";
    },
    start: () => write(record),
    stage: (status: StageStatus) => write(withStage(record, TEARDOWN_OPERATION, status, clock())),
    dispatch: (
      outcomes: readonly (WorkerIdentity & {
        readonly kind: DispatchRecord["status"];
        readonly summary?: string;
      })[],
    ) => write(withDispatch(record, outcomes, clock())),
    /** Ends the record; resolves to why its write failed, if it did. */
    finish: (status: StageStatus, outcome: Exclude<OperationStatus, "running">, failure?: string) =>
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

type TeardownLog = ReturnType<typeof teardownLog>;

/** How far the teardown got: whether Terraform was asked to destroy anything. */
interface Progress {
  destroying: boolean;
}

function interruptedUnder(log: TeardownLog): FactoryTeardown {
  // TODO(re-evaluate when #86 lands): say how far teardown got, and once the bucket's deletion
  // started, that the lock may already be gone.
  return { kind: "interrupted", locked: true, record: log.written() ? log.location : undefined };
}

async function refusedUnder(
  log: TeardownLog,
  refusals: readonly Refusal[],
  dispatchStopped: readonly string[] = [],
): Promise<FactoryTeardown> {
  const recordFailure = await log.finish("refused", "refused", refusals[0]?.summary);
  return { kind: "refused", refusals, operation: log.location, dispatchStopped, recordFailure };
}

async function failedUnder(
  log: TeardownLog,
  refusal: Refusal,
  diagnosticsFile?: string,
): Promise<FactoryTeardown> {
  const recordFailure = await log.finish("failed", "failed", refusal.summary);
  return {
    kind: "failed",
    refusal,
    operation: log.location,
    recordFailure,
    ...(diagnosticsFile === undefined ? {} : { diagnosticsFile }),
  };
}

async function partialUnder(
  log: TeardownLog,
  refusal: Refusal,
  diagnosticsFile?: string,
): Promise<FactoryTeardown> {
  const recordFailure = await log.finish("partial", "partial", refusal.summary);
  return {
    kind: "partial",
    refusal,
    operation: log.location,
    recordFailure,
    ...(diagnosticsFile === undefined ? {} : { diagnosticsFile }),
  };
}

/**
 * Every step under the lock, which it settles at the end: released unless interrupted, and
 * never once the bucket, and the lock with it, is deleted. An interrupt keeps the lock, so the
 * outcome is then reported as interrupted, unless the bucket is already gone.
 */
async function underLock(
  deps: TeardownDependencies,
  teardown: Teardown,
  lock: FactoryLock,
): Promise<FactoryTeardown> {
  const log = teardownLog(deps, teardown, lock);
  const progress: Progress = { destroying: false };
  try {
    const result = await operateOrFail(deps, teardown, log, progress);
    return deps.interrupted() && !log.gone() ? interruptedUnder(log) : result;
  } finally {
    if (!log.gone()) await settleFactoryLock(deps.lockStore, lock, deps.interrupted);
  }
}

/** The teardown, with an error under the lock recorded as its failure, or partial once it destroys. */
async function operateOrFail(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  progress: Progress,
): Promise<FactoryTeardown> {
  try {
    if (deps.interrupted()) return interruptedUnder(log);
    return await operate(deps, teardown, log, progress);
  } catch (error) {
    if (deps.interrupted()) return interruptedUnder(log);
    const refusal = teardownFailed(reasonOf(error));
    return progress.destroying ? partialUnder(log, refusal) : failedUnder(log, refusal);
  }
}

/** What teardown found before it removes anything. */
interface Inventory {
  readonly machines: readonly Machine[];
  readonly vpcIds: readonly string[];
  readonly devices: readonly TailnetDevice[];
  readonly secrets: SecretInventory;
}

/** The admin session, then the inventory, then the destroy plan in a plan directory of its own. */
async function operate(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  progress: Progress,
): Promise<FactoryTeardown> {
  await log.start();
  const admin = await authorize(deps, teardown);
  if (deps.interrupted()) return interruptedUnder(log);
  if (admin.kind === "refused") return refusedUnder(log, [admin.refusal]);
  await log.stage("inventorying");
  const listing = await listInventory(deps, teardown, admin.session);
  if (deps.interrupted()) return interruptedUnder(log);
  if (listing.kind === "refused") return refusedUnder(log, listing.refusals);
  const { factoryId } = teardown;
  const planId = newPlanId(teardown.request.randomBytes);
  const files = await deps.planStore.create(factoryId, planId);
  try {
    const run = { inventory: listing.inventory, admin: admin.session, progress };
    return await planned(deps, teardown, log, run, files.factory);
  } finally {
    // Once the bucket is gone the plans went before it (`removeAll`): nothing after the
    // bucket's deletion may turn a finished teardown into a failure.
    if (!log.gone()) await deps.planStore.remove(factoryId, planId);
  }
}

/**
 * The factory's tailnet admin session, opened before anything is listed, so a client that
 * cannot delete its devices refuses the teardown instead of leaving them behind.
 */
async function authorize(
  deps: TeardownDependencies,
  teardown: Teardown,
): Promise<
  | { readonly kind: "open"; readonly session: TailnetAdminSession }
  | { readonly kind: "refused"; readonly refusal: Refusal }
> {
  const opening = await openTailnetAdmin(deps, {
    reference: teardown.adminClient,
    region: teardown.region,
    credentials: teardown.request.credentials,
  });
  switch (opening.kind) {
    case "unreadable":
      return { kind: "refused", refusal: teardownAdminSecretUnreadable(opening.reason) };
    case "unusable":
      return { kind: "refused", refusal: teardownAdminClientUnusable(opening.reason) };
    case "open":
      // Undefined only once interrupted, which the caller checks first.
      return { kind: "open", session: opening.session as TailnetAdminSession };
  }
}

type Listing =
  | { readonly kind: "listed"; readonly inventory: Inventory }
  | { readonly kind: "refused"; readonly refusals: readonly Refusal[] };

/**
 * The factory's tagged instances and VPCs, its secrets and the tailnet's devices. A listing
 * that fails refuses: it is never taken for one that found nothing. A worker's machine on its
 * way to running or stopped refuses too, before anything is asked.
 */
async function listInventory(
  deps: TeardownDependencies,
  teardown: Teardown,
  admin: TailnetAdminSession,
): Promise<Listing> {
  const { credentials } = teardown.request;
  const { region, factoryId } = teardown;
  const [machines, vpcs, secrets, devices] = await Promise.all([
    deps.machines.list(credentials, region, factoryId),
    deps.machines.listVpcs(credentials, region, factoryId),
    deps.secrets.list({ factoryId, region, credentials }),
    admin.devices(),
  ]);
  const refused = (refusal: Refusal): Listing => ({ kind: "refused", refusals: [refusal] });
  if (machines.kind === "unavailable")
    return refused(inventoryUnavailable("instances", machines.reason));
  if (vpcs.kind === "unavailable") return refused(inventoryUnavailable("vpcs", vpcs.reason));
  if (secrets.kind === "failed") return refused(inventoryUnavailable("secrets", secrets.reason));
  if (devices.kind === "failed") return refused(inventoryUnavailable("devices", devices.reason));
  const passing = machines.machines.flatMap((machine) => inPassing(teardown, machine));
  if (passing.length > 0) return { kind: "refused", refusals: passing };
  return {
    kind: "listed",
    inventory: {
      machines: machines.machines,
      vpcIds: vpcs.vpcIds,
      devices: devices.devices,
      secrets: classifySecrets(
        factoryId,
        secrets.secrets,
        secretReferences(teardown.request.instance),
      ),
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
    };

/**
 * The guarded destroy plan (`docs/specs/provisioning.md` §Destroy plan): `plan -destroy` of the
 * factory root, under Terraform's state lock, with factory.json projected with the host keys
 * the state records, judged by `destroyPlanRefusal` over the instances EC2 lists, and refused
 * when Terraform's exit code and its JSON plan disagree.
 */
async function planDestroy(
  deps: TeardownDependencies,
  teardown: Teardown,
  planFile: string,
  machines: readonly Machine[],
): Promise<DestroyPlanning> {
  try {
    const target = factoryTarget(teardown.bucket, await deps.terraformDirectory());
    const recorded = recordedHostKeys(await deps.provisioner.output(target));
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
  readonly admin: TailnetAdminSession;
  readonly progress: Progress;
}

interface Planned extends Run {
  readonly planning: Extract<DestroyPlanning, { readonly kind: "planned" }>;
  /** Every host key the factory knows: declared, recorded in its state, tagged in EC2. */
  readonly keys: readonly string[];
  /** The IDs of the devices the review showed deleted: no other is deleted unseen. */
  readonly shownDeleted: readonly string[];
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
  if (deps.interrupted()) return interruptedUnder(log);
  const planning = await planDestroy(deps, teardown, planFile, run.inventory.machines);
  if (deps.interrupted()) return interruptedUnder(log);
  if (planning.kind === "refused") return refusedUnder(log, [planning.refusal]);
  if (planning.kind === "failed")
    return failedUnder(log, planning.refusal, planning.diagnosticsFile);
  const keys = [
    ...(teardown.request.instance.hosts ?? []).map(({ key }) => key),
    ...planning.recorded,
    ...run.inventory.machines.flatMap(({ hostKey }) => (hostKey === undefined ? [] : [hostKey])),
  ];
  const devices = selectFactoryDevices(
    run.inventory.devices,
    teardown.factoryId,
    keys,
    teardown.tag,
  );
  const next: Planned = {
    ...run,
    planning,
    keys,
    shownDeleted: devices.deleted.map(({ id }) => id),
  };
  deps.progress({ kind: "review", review: reviewOf(teardown, next, devices) });
  const ended = await unconfirmed(deps, teardown, log);
  if (ended !== undefined) return ended;
  return gated(deps, teardown, log, next);
}

/** What will be removed and kept, as shown before the confirmation. */
function reviewOf(teardown: Teardown, run: Planned, devices: FactoryDevices): TeardownReview {
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
    changes: run.planning.changes,
    machines: shownMachines(inventory.machines),
    vpcIds: inventory.vpcIds,
    devices: shownDevices(teardown.factoryId, devices),
    secrets: {
      owned: inventory.secrets.owned.map(({ name, arn }) => ({ name, arn })),
      kept: keptSecrets(teardown.factoryId, inventory.secrets),
    },
    bucket: teardown.bucket.bucket,
  };
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
): Promise<FactoryTeardown | undefined> {
  if (!teardown.asks) return undefined;
  await log.stage("awaiting_approval");
  const answer = await deps.prompt.ask(teardownQuestion(teardown.factoryId));
  if (deps.interrupted()) return interruptedUnder(log);
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
  await log.stage("stopping_dispatch");
  if (deps.interrupted()) return interruptedUnder(log);
  const running = runningWorkers(teardown, run.inventory.machines);
  const stopping = await stopDispatchEverywhere(deps, teardown, log, running);
  if (deps.interrupted()) return interruptedUnder(log);
  if (stopping.refusals.length > 0) return refusedUnder(log, stopping.refusals, stopping.stopped);
  await log.stage("inspecting");
  if (deps.interrupted()) return interruptedUnder(log);
  const changed = await machinesRechecked(deps, teardown, run.inventory.machines);
  if (deps.interrupted()) return interruptedUnder(log);
  if (changed !== undefined) return refusedUnder(log, [changed], stopping.stopped);
  const refusals = await gateRefusals(deps, teardown, run.inventory.machines, running);
  if (refusals === undefined || deps.interrupted()) return interruptedUnder(log);
  if (refusals.length > 0) return refusedUnder(log, refusals, stopping.stopped);
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
 * outcome; one it does not locate is left to the gates, which refuse it. A stop that failed
 * refuses the teardown, naming the worker.
 */
async function stopDispatchEverywhere(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  running: readonly RunningWorker[],
): Promise<{ readonly stopped: readonly string[]; readonly refusals: readonly Refusal[] }> {
  const view = await deps.peers.view();
  const stopped: string[] = [];
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
      stopped.push(worker.hostname);
      outcomes.push({ ...worker, kind: "not_requested" });
    }
  }
  if (outcomes.length > 0) await log.dispatch(outcomes);
  return { stopped, refusals };
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
  await log.stage("applying");
  if (deps.interrupted()) return interruptedUnder(log);
  deps.progress({ kind: "destroying" });
  run.progress.destroying = true;
  if (run.planning.applies) {
    try {
      await deps.provisioner.applyPlan(run.planning.saved);
    } catch (error) {
      if (deps.interrupted()) return interruptedUnder(log);
      return partialUnder(log, destroyApplyFailed(reasonOf(error)), diagnosticsFileOf(error));
    }
  }
  await log.stage("verifying");
  if (deps.interrupted()) return interruptedUnder(log);
  const leftover = await leftovers(deps, teardown);
  if (deps.interrupted()) return interruptedUnder(log);
  if (leftover !== undefined) return partialUnder(log, leftover);
  return removeDevices(deps, teardown, log, run);
}

/**
 * Why the factory cannot be taken for destroyed: EC2 still lists instances or VPCs tagged with
 * its ID, outside its Terraform state, or cannot list them. Undefined when it lists none.
 */
async function leftovers(
  deps: TeardownDependencies,
  teardown: Teardown,
): Promise<Refusal | undefined> {
  const { credentials } = teardown.request;
  const { region, factoryId } = teardown;
  const [machines, vpcs] = await Promise.all([
    deps.machines.list(credentials, region, factoryId),
    deps.machines.listVpcs(credentials, region, factoryId),
  ]);
  if (machines.kind === "unavailable") return leftoversUnverified("instances", machines.reason);
  if (vpcs.kind === "unavailable") return leftoversUnverified("vpcs", vpcs.reason);
  if (machines.machines.length === 0 && vpcs.vpcIds.length === 0) return undefined;
  return leftoversRemain(machines.machines, vpcs.vpcIds);
}

/**
 * Deletes the factory's tailnet devices (D9), listed afresh; any left behind stops the run with
 * the secrets kept, the admin client among them, so a rerun can delete them.
 */
async function removeDevices(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  run: Planned,
): Promise<FactoryTeardown> {
  await log.stage("removing_devices");
  if (deps.interrupted()) return interruptedUnder(log);
  deps.progress({ kind: "removing_devices" });
  const listing = await run.admin.devices();
  if (listing.kind === "failed") return partialUnder(log, devicesRemain([], listing.reason));
  const selection = selectFactoryDevices(
    listing.devices,
    teardown.factoryId,
    run.keys,
    teardown.tag,
    run.shownDeleted,
  );
  const { removed, failed } = await deleteDevices(run.admin, selection.deleted, deps.interrupted);
  if (deps.interrupted()) return interruptedUnder(log);
  if (failed.length > 0) return partialUnder(log, devicesRemain(failed, undefined));
  const { possible, untagged } = shownDevices(teardown.factoryId, selection);
  return removeSecrets(deps, teardown, log, run, { removed, possible, untagged });
}

type DevicesRemoved = TeardownReport["devices"];

/** Deletes every owned secret permanently and confirms it gone (D7, D8). */
async function removeSecrets(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  run: Planned,
  devices: DevicesRemoved,
): Promise<FactoryTeardown> {
  await log.stage("removing_secrets");
  if (deps.interrupted()) return interruptedUnder(log);
  deps.progress({ kind: "removing_secrets" });
  const { clock } = teardown.request;
  const remaining: { readonly name: string; readonly reason: string }[] = [];
  for (const secret of run.inventory.secrets.owned) {
    if (deps.interrupted()) return interruptedUnder(log);
    const deletion = await deleteOwnedSecret(
      { secrets: deps.secrets, clock, sleep: deps.sleep, interrupted: deps.interrupted },
      { secret, credentials: teardown.request.credentials },
    );
    if (deletion.kind === "remains") remaining.push({ name: secret.name, reason: deletion.reason });
  }
  if (deps.interrupted()) return interruptedUnder(log);
  if (remaining.length > 0) return partialUnder(log, secretsRemain(remaining));
  const report: TeardownReport = {
    infrastructure: run.planning.applies ? "destroyed" : "absent",
    changes: run.planning.changes,
    machines: shownMachines(run.inventory.machines),
    devices,
    secrets: {
      removed: run.inventory.secrets.owned.map(({ name }) => name),
      kept: keptSecrets(teardown.factoryId, run.inventory.secrets),
    },
    bucket: teardown.bucket.bucket,
  };
  return removeLast(deps, teardown, log, report);
}

/**
 * The local saved plans, then the state bucket (D6). On `absent` the lock and the record went
 * with it: nothing more is written, and the lock is not released. A bucket that remains with
 * the lock held ends recorded, and the lock is released; once its lock's versions were being
 * deleted, nothing more is written into it.
 */
async function removeLast(
  deps: TeardownDependencies,
  teardown: Teardown,
  log: TeardownLog,
  report: TeardownReport,
): Promise<FactoryTeardown> {
  await log.stage("removing_plans");
  if (deps.interrupted()) return interruptedUnder(log);
  await deps.planStore.removeAll(teardown.factoryId);
  await log.stage("deleting_bucket");
  if (deps.interrupted()) return interruptedUnder(log);
  deps.progress({ kind: "deleting_bucket", bucket: teardown.bucket.bucket });
  // TODO(re-evaluate when #86 lands): pass `interrupted`, so no DeleteObjects call starts once set.
  const deletion: BucketDeletion = await deps.lockStore.deleteBucket(teardown.bucket);
  if (deletion.kind === "absent") {
    log.deleted();
    return { kind: "done", report };
  }
  if (deletion.lock !== "held") log.seal();
  return partialUnder(log, bucketRemains(teardown.bucket.bucket, deletion));
}
