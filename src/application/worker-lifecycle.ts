/**
 * `fffactory worker stop|start|terminate` (`docs/specs/worker-lifecycle.md`): power one declared
 * worker's EC2 instance off or on, or terminate it, under the factory-wide lock and an operation
 * record. EC2's state is the truth: factory.json keeps no power field. Stop and start keep the
 * instance, its volume, its Terraform state and its tailnet device; terminate destroys the
 * instance and its volume and deletes its tailnet devices. With `--keep` the host stays in
 * factory.json, so the next apply creates it afresh, and Terraform is not run. Without it,
 * terminate removes the host: Terraform's scoped removal plan of factory.json without the host,
 * approved with the host key, destroys the machine and stops recording the key, then
 * factory.json is written without the host (§Terminate (remove)).
 *
 * Before anything reaches AWS: a confirmation must be possible, the key must be declared, and
 * factory.json complete (for terminate, with its Tailscale admin client). Then the account
 * check, the CLI/pin match guard and the lock; under it, the one instance carrying the factory
 * ID and host key tags, the gates, for terminate the admin client's token, the operator's
 * confirmation, the request, and a bounded wait for the target state. Start then waits for the
 * worker's tailnet device and reports its readiness as status would; terminate deletes the
 * worker's tailnet devices. Every wait goes through the injected `sleep` and checks
 * `interrupted` after it: an interrupted operation starts nothing more, writes no more of its
 * record and keeps the lock.
 */
import {
  type AccountExpectation,
  accountExpectation,
  type CredentialSelection,
} from "../domain/aws-account";
import type { HeldLock } from "../domain/factory-lock";
import { hostProjectionSha256, projectHost, type Sha256 } from "../domain/host-projection";
import type { RandomBytes } from "../domain/initialization";
import {
  assessCompleteness,
  deliveredAccounts,
  type FactoryId,
  type FactoryInstance,
  type Host,
  type HostKey,
  parseRelease,
  type Release,
  type SecretReference,
  serializeInstance,
} from "../domain/instance";
import {
  failedAfterRemoval,
  recordedKeysUnreadable,
  removalApplyFailed,
  removalConfigurationChanged,
  removalPlanningFailed,
  removalPlanRefusal,
  removalProjectionRefusal,
  removalStillRecorded,
  removalUnwritten,
  withoutHost,
} from "../domain/host-removal";
import {
  finishOperation,
  type OperationRecord,
  type OperationStatus,
  operationKey,
  type StageStatus,
  startStageOperation,
  withMachine,
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
import type { SecretMaterial } from "../domain/secrets";
import { placedRepositories } from "../domain/repository-placement";
import { hostName } from "../domain/resource-naming";
import { recordedHostKeys } from "../domain/stable-host-keys";
import { joiningTailnet, type WorkerIdentity } from "../domain/rollout";
import { inspectionVerdict, locateWorker, type Machine, type Verdict } from "../domain/status";
import { selectWorkerDevices } from "../domain/tailnet";
import {
  adminClientMissing,
  adminClientUnusable,
  adminSecretUnreadable,
  confirmationQuestion,
  confirmationRule,
  confirmMismatch,
  confirms,
  type DeviceRemoval,
  deviceRemovalRefusal,
  hostKeyRefusal,
  machineGone,
  type ObservedMachineState,
  ONLINE_DEADLINE_MS,
  ONLINE_POLL_MS,
  POWER_DEADLINE_MS,
  POWER_POLL_MS,
  type PowerAction,
  powerStep,
  removesHost,
  powerTimedOut,
  type Refusal,
  requestFailed,
  requestUnanswered,
  selectMachine,
  type StopInspection,
  stopGate,
  type TerminateCommand,
  TARGET_STATE,
  type TerminateInspection,
  terminateGate,
  thenRerunWorker,
  typedKeyConfirms,
  waitStep,
  type WorkerCommand,
  WORKER_OPERATIONS,
} from "../domain/worker-lifecycle";
import type { OperationLocation } from "./apply-factory";
import type { CallerIdentity } from "./caller-identity";
import type { ControlPlane } from "./control-plane";
import {
  acquireFactoryLock,
  type FactoryLock,
  type Interrupted,
  lockHolder,
  settleFactoryLock,
  stateBucketOf,
} from "./factory-lock";
import type { HostTransport } from "./host-transport";
import type { InstanceStore } from "./instance-store";
import { inspectRepositories } from "./inspect-repositories";
import { inspectWork } from "./inspect-work";
import { inspectWorker } from "./inspect-worker";
import type { LockStore, StateBucket } from "./lock-store";
import type { MachineControl, MachineRequest, MachineTarget } from "./machine-control";
import type { MachineInventorySource } from "./machine-inventory";
import type { OperatorPrompt } from "./operator-prompt";
import { factoryTarget } from "./plan-factory";
import type { PlanStore } from "./plan-store";
import { projectFactoryVariables } from "./project-terraform-inputs";
import { diagnosticsFileOf, type Provisioner, type ProvisioningTarget } from "./provisioner";
import { type AccountRequirement, requireExpectedAccount } from "./require-expected-account";
import type { SecretStore } from "./secret-store";
import type { TailnetAdmin, TailnetAdminSession } from "./tailnet-admin";
import type { TailnetPeers } from "./tailnet-peers";

export interface WorkerLifecycleDependencies {
  readonly identity: CallerIdentity;
  readonly lockStore: LockStore;
  readonly machines: MachineInventorySource;
  readonly control: MachineControl;
  readonly peers: TailnetPeers;
  readonly transport: HostTransport;
  /** Reads stop's agent activity; without one, a running worker cannot be inspected. */
  readonly controlPlane: ControlPlane | undefined;
  readonly prompt: OperatorPrompt;
  /** Reads terminate's Tailscale admin client secret. */
  readonly secrets: SecretStore;
  /** Deletes a terminated worker's tailnet devices. */
  readonly tailnetAdmin: TailnetAdmin;
  /** Terminate removing the host: plans and applies its scoped removal with managed Terraform. */
  readonly provisioner: Provisioner;
  /** Where the removal's Terraform plan file is kept while the operation runs. */
  readonly planStore: PlanStore;
  /** Where factory.json is, to write it without the removed host. */
  readonly store: InstanceStore;
  /** This release's materialized Terraform tree, materialized only when a removal needs it. */
  readonly terraformDirectory: () => Promise<string>;
  readonly interrupted: Interrupted;
  /** Waits `ms`, or less once interrupted: the use case checks `interrupted` after it. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Digests the host projection the started worker should hold. */
  readonly sha256: Sha256;
  readonly progress: (event: PowerProgress) => void;
}

export interface WorkerLifecycleRequest {
  readonly action: PowerAction;
  readonly instance: FactoryInstance;
  /** The KEY argument as given: checked against factory.json's hosts first. */
  readonly key: string;
  readonly credentials: CredentialSelection;
  /** The running fffactory's release, which must be the one factory.json pins. */
  readonly release: Release;
  /** Stop and terminate: skip the gates. Never the account check, pin guard, lock or confirmation. */
  readonly force: boolean;
  /** Stop and start: confirmed in advance, for use without a terminal. */
  readonly yes: boolean;
  /**
   * Terminate: `--confirm`, the host key typed in advance, for use without a terminal. Any
   * other value refuses; `yes` never confirms a terminate.
   */
  readonly confirm?: string | undefined;
  /** Terminate: keep the host in factory.json (`--keep`). Without it terminate removes the host. */
  readonly keep?: boolean;
  /** Terminate removing the host: factory.json's path and its exact text, as `instance` was read. */
  readonly configuration?: Configuration;
  /** This machine's name, recorded as the lock holder's host. */
  readonly host: string;
  readonly clock: () => Date;
  readonly randomBytes: RandomBytes;
}

/** Where factory.json is, and its exact text as the command read it. */
export interface Configuration {
  readonly path: string;
  readonly text: string;
}

/** Terminate's request: keeping the host (`--keep`), or removing it from `configuration`. */
export type TerminateRequest = Omit<WorkerLifecycleRequest, "action" | "keep" | "configuration"> &
  ({ readonly keep: true } | { readonly keep?: false; readonly configuration: Configuration });

/** What the operator is told while the command runs. */
export type PowerProgress =
  | {
      readonly kind: "located";
      readonly key: HostKey;
      readonly hostname: string;
      readonly instanceId: string;
      readonly state: Machine["state"];
    }
  /** `--force`: the gates were skipped. */
  | { readonly kind: "forced"; readonly action: Exclude<PowerAction, "start"> }
  /** Terminate: the machine is stopped, so the worker is not inspected. */
  | { readonly kind: "uninspected_stopped" }
  /** EC2 was asked to change the machine; the command now waits for the target state. */
  | { readonly kind: "requested"; readonly action: PowerAction; readonly instanceId: string }
  /** The change was already under way; the command only waits for the target state. */
  | { readonly kind: "awaiting"; readonly action: PowerAction; readonly instanceId: string }
  /** Start waits for the worker's tailnet device to come online. */
  | { readonly kind: "waiting_online"; readonly hostname: string }
  /** Terminate deletes the terminated worker's tailnet devices. */
  | { readonly kind: "removing_devices"; readonly hostname: string }
  /** Terminate: no EC2 instance carries the host key, so its machine is already gone. */
  | { readonly kind: "absent"; readonly key: HostKey; readonly hostname: string }
  /** Terminate removing the host: Terraform plans its removal. */
  | { readonly kind: "planning_removal"; readonly key: HostKey }
  /**
   * The removal plan, shown before the host key is asked for: what it targets, Terraform's
   * changes, and the worker it removes from factory.json and the tailnet.
   */
  | {
      readonly kind: "removal_plan";
      readonly target: PlanTarget;
      readonly changes: readonly ResourceChange[];
      readonly worker: WorkerIdentity;
    }
  /** Terraform applies the removal plan. */
  | { readonly kind: "applying_removal" }
  /** factory.json no longer declares the host. */
  | { readonly kind: "configuration_written"; readonly key: HostKey; readonly path: string };

export type WorkerPower =
  /** No terminal to confirm at, and no `--yes`. */
  | { readonly kind: "unconfirmable" }
  | { readonly kind: "incomplete"; readonly missing: readonly string[] }
  | {
      readonly kind: "account_refused";
      readonly requirement: Extract<AccountRequirement, { readonly allowed: false }>;
      readonly expectation: AccountExpectation;
    }
  /** The CLI/pin match guard: this fffactory is not the release factory.json pins. */
  | { readonly kind: "release_mismatch"; readonly message: string }
  | { readonly kind: "locked"; readonly held: HeldLock | undefined }
  | { readonly kind: "interrupted"; readonly locked: false }
  /**
   * Interrupted holding the lock, which stays with the record as far as it was written:
   * `record` once a write of it finished. `requested` when EC2 may have been asked to change
   * the machine, which then goes on changing. A removal says how far it got: Terraform was
   * `applying` it, so may have destroyed the machine, or factory.json was `written` without
   * the host.
   */
  | {
      readonly kind: "interrupted";
      readonly locked: true;
      readonly record: OperationLocation | undefined;
      readonly requested: boolean;
      readonly removal?: Removal | undefined;
    }
  /** Refused, changing nothing: before the lock (`operation` undefined), or under it. */
  | {
      readonly kind: "refused";
      readonly refusal: Refusal;
      readonly operation: OperationLocation | undefined;
      readonly recordFailure?: string | undefined;
    }
  /**
   * Not confirmed: nothing changed. `terminating` is the instance EC2 was already terminating
   * when located, which this command neither asked for nor stopped.
   */
  | {
      readonly kind: "declined";
      readonly operation: OperationLocation;
      readonly recordFailure: string | undefined;
      readonly terminating?: string | undefined;
    }
  | {
      readonly kind: "failed";
      readonly refusal: Refusal;
      readonly operation: OperationLocation;
      readonly recordFailure: string | undefined;
      /** The private local file keeping a failed Terraform command's diagnostics, if any. */
      readonly diagnosticsFile?: string | undefined;
    }
  /**
   * The machine is in the target state: `changed` when this command asked EC2 for it, `awaited`
   * when it was already on its way and this command only waited for it. Start adds the worker's
   * `verdict`, as status words it; a worker not ready is not start's failure. Terminate adds how
   * deleting the worker's tailnet devices went, and `leftover`, what it left behind, when it did:
   * the terminate stands, and is partial. A terminate that `removed` the host also destroyed its
   * machine with Terraform and wrote factory.json without it. `instanceId` is undefined when no
   * EC2 instance carried the key: the machine was already gone.
   */
  | {
      readonly kind: "done";
      readonly action: PowerAction;
      readonly worker: WorkerIdentity;
      readonly instanceId: string | undefined;
      readonly removed?: boolean;
      readonly changed: boolean;
      readonly awaited: boolean;
      readonly verdict?: Verdict;
      readonly devices?: DeviceRemoval;
      readonly leftover?: Refusal | undefined;
      readonly operation: OperationLocation;
      readonly recordFailure: string | undefined;
    };

/** Stops a declared worker's machine (`docs/specs/worker-lifecycle.md` §Stop). */
export function stopWorker(
  deps: WorkerLifecycleDependencies,
  request: Omit<WorkerLifecycleRequest, "action">,
): Promise<WorkerPower> {
  return powerWorker(deps, { ...request, action: "stop" });
}

/** Starts a declared worker's machine and reports its readiness (§Start). */
export function startWorker(
  deps: WorkerLifecycleDependencies,
  request: Omit<WorkerLifecycleRequest, "action">,
): Promise<WorkerPower> {
  return powerWorker(deps, { ...request, action: "start" });
}

/**
 * Terminates a declared worker's machine and deletes its tailnet devices, removing the host from
 * Terraform and factory.json (§Terminate (remove)), or with `keep` keeping it in factory.json
 * (§Terminate (keep)).
 */
export function terminateWorker(
  deps: WorkerLifecycleDependencies,
  request: TerminateRequest,
): Promise<WorkerPower> {
  return powerWorker(deps, { ...request, action: "terminate" });
}

/** Everything a power operation works with once the checks before the lock passed. */
interface Power {
  readonly request: WorkerLifecycleRequest;
  readonly bucket: StateBucket;
  readonly action: PowerAction;
  /** The command as run, which next actions rerun. */
  readonly command: WorkerCommand;
  readonly worker: WorkerIdentity;
  /** The worker's host as factory.json declares it, for the projection status compares. */
  readonly host: Host;
  readonly factoryId: FactoryId;
  readonly region: string;
  readonly tag: string;
  /** The release factory.json pins. */
  readonly pinned: Release;
  /** Terminate's Tailscale admin client (`tailscale.admin_client_secret`). */
  readonly adminClient: SecretReference | undefined;
  /** Terminate removing the host: factory.json as read, and as it is to be without the host. */
  readonly removal: HostRemovalPlan | undefined;
}

interface HostRemovalPlan {
  readonly configuration: Configuration;
  readonly remaining: FactoryInstance;
}

/** The command a request runs: terminate removes the host unless it keeps it. */
function commandOf(request: WorkerLifecycleRequest): WorkerCommand {
  if (request.action !== "terminate") return request.action;
  return request.keep === true ? "terminate-keep" : "terminate";
}

type Checked = { readonly kind: "checked"; readonly power: Power } | WorkerPower;

/** Whether the operator confirmed in advance: `--confirm` for terminate, `--yes` otherwise. */
function confirmedInAdvance(request: WorkerLifecycleRequest): boolean {
  return request.action === "terminate" ? request.confirm !== undefined : request.yes;
}

/**
 * The checks that need no AWS: confirmation possible, the key declared, terminate's
 * `--confirm` naming it, factory.json complete, and terminate's admin client declared.
 */
function localChecks(deps: WorkerLifecycleDependencies, request: WorkerLifecycleRequest): Checked {
  if (confirmationRule(confirmedInAdvance(request), deps.prompt.interactive) === "unavailable")
    return { kind: "unconfirmable" };
  const { instance } = request;
  const unknown = hostKeyRefusal(request.key, instance);
  if (unknown !== undefined) return { kind: "refused", refusal: unknown, operation: undefined };
  const terminating = request.action === "terminate";
  const command = commandOf(request);
  // The key is declared: a `--confirm` that differs is never echoed, it could be a secret.
  if (terminating && request.confirm !== undefined && request.confirm !== request.key)
    return {
      kind: "refused",
      refusal: confirmMismatch(request.key as HostKey),
      operation: undefined,
    };
  const { missing } = assessCompleteness(instance);
  const factoryId = instance.factory_id;
  const region = instance.aws?.region;
  const tag = instance.tailscale?.tag;
  const pinned = parseRelease(instance.release ?? "");
  const host = instance.hosts?.find((declared) => declared.key === request.key);
  // A complete factory.json always locates its state bucket.
  const location = stateBucketOf(instance, request.credentials);
  if (missing.length > 0 || !factoryId || !region || !tag || !pinned.ok || !host || !location.ok)
    return { kind: "incomplete", missing };
  const adminClient = instance.tailscale?.admin_client_secret;
  if (terminating && adminClient === undefined)
    return {
      kind: "refused",
      refusal: adminClientMissing(command as TerminateCommand, host.key),
      operation: undefined,
    };
  const removal = removalCheck(request, command, host.key);
  return {
    kind: "checked",
    power: {
      request,
      bucket: location.bucket,
      action: request.action,
      command,
      removal,
      worker: { key: host.key, hostname: hostName(factoryId, host.key) },
      host,
      factoryId,
      region,
      tag,
      pinned: pinned.value,
      adminClient,
    },
  };
}

/**
 * What terminate removing the host works from: factory.json as read and without the host, which
 * may leave it declaring none.
 */
function removalCheck(
  request: WorkerLifecycleRequest,
  command: WorkerCommand,
  key: HostKey,
): HostRemovalPlan | undefined {
  if (!removesHost(command)) return undefined;
  const { configuration } = request;
  if (configuration === undefined)
    throw new Error("terminate without --keep needs factory.json's path and text");
  return { configuration, remaining: withoutHost(request.instance, key) };
}

async function powerWorker(
  deps: WorkerLifecycleDependencies,
  request: WorkerLifecycleRequest,
): Promise<WorkerPower> {
  const checked = localChecks(deps, request);
  if (checked.kind !== "checked") return checked;
  const { power } = checked;
  const { instance, credentials } = request;
  const expectation = accountExpectation(instance);
  const account = await requireExpectedAccount(deps.identity, { expectation, credentials });
  if (!account.allowed) return { kind: "account_refused", requirement: account, expectation };
  const mismatch = pinRefusal(instance.release, request.release);
  if (mismatch !== undefined) return { kind: "release_mismatch", message: mismatch };
  if (deps.interrupted()) return { kind: "interrupted", locked: false };
  const acquisition = await acquireFactoryLock(deps.lockStore, {
    bucket: power.bucket,
    operation: WORKER_OPERATIONS[power.action],
    holder: lockHolder(account, request.host),
    release: request.release,
    now: request.clock(),
    randomBytes: request.randomBytes,
  });
  if (!acquisition.acquired) return { kind: "locked", held: acquisition.held };
  return underLock(deps, power, acquisition.lock);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Records each step of the operation in the state bucket as it happens. From an interrupt on
 * it writes nothing more, so the record stays at the step the interrupt found.
 */
function powerLog(deps: WorkerLifecycleDependencies, power: Power, lock: FactoryLock) {
  const { clock } = power.request;
  const stage = power.action;
  let record: OperationRecord = startStageOperation(lock.record, stage, "locating");
  let written = false;
  const write = async (next: OperationRecord) => {
    if (deps.interrupted()) return;
    record = next;
    await deps.lockStore.writeOperation(lock.bucket, next);
    written = true;
  };
  return {
    location: { bucket: lock.bucket.bucket, key: operationKey(record) },
    written: () => written,
    start: () => write(record),
    stage: (status: StageStatus) => write(withStage(record, stage, status, clock())),
    machine: (instanceId: string, state: ObservedMachineState) =>
      write(withMachine(record, { ...power.worker, instance_id: instanceId, state }, clock())),
    /** Ends the record; resolves to why its write failed, if it did. */
    finish: (status: StageStatus, outcome: Exclude<OperationStatus, "running">, failure?: string) =>
      write(
        finishOperation(withStage(record, stage, status, clock()), outcome, clock(), failure),
      ).then(() => undefined, reasonOf),
  };
}

type PowerLog = ReturnType<typeof powerLog>;

/**
 * How far a removal got: Terraform was asked to apply it, so may have destroyed the machine, or
 * factory.json was written without the host.
 */
export type Removal = "applying" | "written";

/** How far the operation got: whether EC2 may have been asked to change the machine. */
interface Progress {
  requested: boolean;
  removal?: Removal;
}

function interruptedUnder(log: PowerLog, progress: Progress): WorkerPower {
  return {
    kind: "interrupted",
    locked: true,
    record: log.written() ? log.location : undefined,
    requested: progress.requested,
    ...(progress.removal === undefined ? {} : { removal: progress.removal }),
  };
}

/**
 * Every step under the lock, which it settles at the end: released unless interrupted. An
 * interrupt during the last record write keeps the lock too, so the outcome is then reported
 * as interrupted, whatever the operation reached.
 */
async function underLock(
  deps: WorkerLifecycleDependencies,
  power: Power,
  lock: FactoryLock,
): Promise<WorkerPower> {
  const log = powerLog(deps, power, lock);
  const progress: Progress = { requested: false };
  try {
    const result = await operateOrFail(deps, power, log, progress);
    return deps.interrupted() ? interruptedUnder(log, progress) : result;
  } finally {
    await settleFactoryLock(deps.lockStore, lock, deps.interrupted);
  }
}

/** The operation, with an error under the lock recorded as its failure. */
async function operateOrFail(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
): Promise<WorkerPower> {
  try {
    if (deps.interrupted()) return interruptedUnder(log, progress);
    return await operate(deps, power, log, progress);
  } catch (error) {
    if (deps.interrupted()) return interruptedUnder(log, progress);
    const reason = reasonOf(error);
    const recordFailure = await log.finish("failed", "failed", reason);
    // Once factory.json no longer declares the host, a rerun is refused: only its devices remain.
    const refusal =
      progress.removal === "written"
        ? failedAfterRemoval(power.worker, reason)
        : {
            summary: reason,
            details: [],
            nextAction: thenRerunWorker(
              power.command,
              power.worker.key,
            )("Check the worker with `fffactory status`"),
          };
    return { kind: "failed", refusal, operation: log.location, recordFailure };
  }
}

async function refusedUnder(log: PowerLog, refusal: Refusal): Promise<WorkerPower> {
  const recordFailure = await log.finish("refused", "refused", refusal.summary);
  return { kind: "refused", refusal, operation: log.location, recordFailure };
}

async function failedUnder(
  log: PowerLog,
  refusal: Refusal,
  diagnosticsFile?: string,
): Promise<WorkerPower> {
  const recordFailure = await log.finish("failed", "failed", refusal.summary);
  return {
    kind: "failed",
    refusal,
    operation: log.location,
    recordFailure,
    ...(diagnosticsFile === undefined ? {} : { diagnosticsFile }),
  };
}

function targetOf(power: Power, machine: Machine): MachineTarget {
  return {
    credentials: power.request.credentials,
    region: power.region,
    factoryId: power.factoryId,
    instanceId: machine.instanceId,
  };
}

/** Locates the machine, then acts on it, waits for it, or finds nothing to do. */
async function operate(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
): Promise<WorkerPower> {
  await log.start();
  const inventory = await deps.machines.list(
    power.request.credentials,
    power.region,
    power.factoryId,
  );
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const selection = selectMachine(inventory, power.worker.key, power.command);
  if (selection.kind === "refused") return refusedUnder(log, selection.refusal);
  if (selection.kind === "absent") return terminateAbsent(deps, power, log, progress);
  const { machine } = selection;
  await log.machine(machine.instanceId, machine.state);
  deps.progress({
    kind: "located",
    ...power.worker,
    instanceId: machine.instanceId,
    state: machine.state,
  });
  const step = powerStep(power.command, machine, power.worker.key);
  switch (step.kind) {
    case "refused":
      return refusedUnder(log, step.refusal);
    case "done":
      return reached(deps, power, log, progress, {
        instanceId: machine.instanceId,
        changed: false,
        awaited: false,
      });
    case "await":
      return awaitUnderWay(deps, power, log, progress, machine);
    case "act":
      return act(deps, power, log, progress, machine);
  }
}

/**
 * A machine already on its way to the action's target state: waited for. Stop and start are
 * not asked. Terminate first opens its admin session and, with `--keep`, asks for the typed key
 * before the wait, so the operator is not kept waiting for the question; a removal asks after
 * its plan instead.
 */
async function awaitUnderWay(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  machine: Machine,
): Promise<WorkerPower> {
  const admin = await adminFor(deps, power, log);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (admin.kind === "refused") return refusedUnder(log, admin.refusal);
  if (power.action === "terminate") {
    if (!removesHost(power.command)) {
      const ended = await unconfirmed(deps, power, log, progress, machine);
      if (ended !== undefined) return ended;
    }
    // The wait is recorded as terminate's, as after its request, not as the question's.
    await log.stage("terminating");
    if (deps.interrupted()) return interruptedUnder(log, progress);
  }
  deps.progress({ kind: "awaiting", action: power.action, instanceId: machine.instanceId });
  return awaitTarget(deps, power, log, progress, {
    machine,
    changed: false,
    awaited: true,
    admin: admin.session,
  });
}

/**
 * Terminate's tailnet admin session, opened before EC2 is asked anything so a client that
 * cannot delete the worker's devices refuses the terminate instead of leaving them behind.
 * The client secret is read here, given to the admin client, and kept nowhere.
 */
async function adminFor(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
): Promise<
  | { readonly kind: "open"; readonly session: TailnetAdminSession | undefined }
  | { readonly kind: "refused"; readonly refusal: Refusal }
> {
  if (power.action !== "terminate" || power.adminClient === undefined)
    return { kind: "open", session: undefined };
  await log.stage("authorizing");
  const { key } = power.worker;
  let secret: SecretMaterial;
  try {
    secret = await deps.secrets.read({
      reference: power.adminClient,
      region: power.region,
      credentials: power.request.credentials,
    });
  } catch (error) {
    return {
      kind: "refused",
      refusal: adminSecretUnreadable(power.command as TerminateCommand, key, reasonOf(error)),
    };
  }
  if (deps.interrupted()) return { kind: "open", session: undefined };
  const opening = await deps.tailnetAdmin.open(secret);
  if (opening.kind === "failed")
    return {
      kind: "refused",
      refusal: adminClientUnusable(power.command as TerminateCommand, key, opening.reason),
    };
  return { kind: "open", session: opening.session };
}

/** The gates of stop and terminate, for a machine `act` found in `state`. */
function gates(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  machine: Machine,
): Promise<Refusal | undefined> {
  switch (power.action) {
    case "stop":
      return stopGates(deps, power, log);
    case "terminate":
      return terminateGates(deps, power, log, machine);
    case "start":
      return Promise.resolve(undefined);
  }
}

/**
 * The gates, terminate's admin session, the confirmation, then the request to EC2 and the
 * wait for its outcome. Terminate removing the host goes on to its removal instead.
 */
async function act(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  machine: Machine,
): Promise<WorkerPower> {
  const refusal = await gates(deps, power, log, machine);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (refusal !== undefined) return refusedUnder(log, refusal);
  const admin = await adminFor(deps, power, log);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (admin.kind === "refused") return refusedUnder(log, admin.refusal);
  if (removesHost(power.command))
    return removeHost(deps, power, log, progress, {
      machine,
      destroys: true,
      awaited: false,
      admin: admin.session,
    });
  const ended = await unconfirmed(deps, power, log, progress, machine);
  if (ended !== undefined) return ended;
  return requestTarget(deps, power, log, progress, machine, admin.session);
}

/** The stage each action's request and wait are recorded as, and the call that asks EC2. */
const REQUESTS: Readonly<
  Record<
    PowerAction,
    {
      readonly stage: StageStatus;
      readonly call: (control: MachineControl, target: MachineTarget) => Promise<MachineRequest>;
    }
  >
> = {
  stop: { stage: "stopping", call: (control, target) => control.stop(target) },
  start: { stage: "starting", call: (control, target) => control.start(target) },
  terminate: { stage: "terminating", call: (control, target) => control.terminate(target) },
};

/** Asks EC2 for the action's target state, then waits for it. */
async function requestTarget(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  machine: Machine,
  admin: TailnetAdminSession | undefined,
): Promise<WorkerPower> {
  const { stage, call } = REQUESTS[power.action];
  await log.stage(stage);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const target = targetOf(power, machine);
  progress.requested = true;
  const requested = await call(deps.control, target);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const { action, worker } = power;
  switch (requested.kind) {
    case "failed":
      return failedUnder(
        log,
        requestFailed(power.command, worker, machine.instanceId, requested.reason),
      );
    case "unanswered":
      return failedUnder(
        log,
        requestUnanswered(power.command, worker, machine.instanceId, requested.reason),
      );
    case "requested":
      deps.progress({ kind: "requested", action, instanceId: machine.instanceId });
      return awaitTarget(deps, power, log, progress, {
        machine,
        changed: true,
        awaited: false,
        admin,
      });
  }
}

/**
 * Stop's gates (`docs/specs/worker-lifecycle.md` §Gates): the worker located in the tailnet and
 * its agent activity read, unless `--force` skips them. Undefined when stop may go on.
 */
async function stopGates(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
): Promise<Refusal | undefined> {
  if (power.request.force) {
    deps.progress({ kind: "forced", action: "stop" });
    return stopGate({ kind: "forced" }, power.worker);
  }
  await log.stage("inspecting");
  // TODO(re-evaluate when dispatch gains a pause): pause dispatch on the worker before this
  // activity check, and resume it if the stop does not go ahead. Until then dispatch may start
  // an agent between the check and the stop, which then ends it (an accepted race, epic #5).
  return stopGate(await stopInspection(deps, power), power.worker);
}

async function stopInspection(
  deps: WorkerLifecycleDependencies,
  power: Power,
): Promise<StopInspection> {
  const then = thenRerunWorker("stop", power.worker.key);
  const location = locateWorker(await deps.peers.view(), power.worker, power.tag, then);
  if (location.kind === "blocked")
    return { kind: "unlocated", tailnet: location.tailnet, verdict: location.verdict };
  if (deps.controlPlane === undefined)
    return {
      kind: "activity",
      activity: {
        kind: "unknown",
        reason: "this fffactory cannot reach the worker's control plane",
      },
    };
  return { kind: "activity", activity: await deps.controlPlane.activeAgents(location.worker) };
}

/**
 * Terminate's gates (`docs/specs/worker-lifecycle.md` §Gates (terminate)): a stopped machine
 * passes uninspected; a running worker is located in the tailnet, and its agent activity, last
 * repository result and current work read, unless `--force` skips them. Undefined when
 * terminate may go on, or once interrupted.
 */
async function terminateGates(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  machine: Machine,
): Promise<Refusal | undefined> {
  if (machine.state === "stopped") {
    // Accepted risk: unpushed work on a stopped worker's disk goes unreported.
    deps.progress({ kind: "uninspected_stopped" });
    return terminateGate({ kind: "stopped" }, power.worker, power.command as TerminateCommand);
  }
  if (power.request.force) {
    deps.progress({ kind: "forced", action: "terminate" });
    return terminateGate({ kind: "forced" }, power.worker, power.command as TerminateCommand);
  }
  await log.stage("inspecting");
  // TODO(re-evaluate when dispatch gains a pause): pause dispatch on the worker before this
  // inspection, as for stop: until then an agent dispatch starts between the check and the
  // terminate ends with the machine (an accepted race, epic #5).
  const inspection = await terminateInspection(deps, power);
  if (inspection === undefined) return undefined;
  return terminateGate(inspection, power.worker, power.command as TerminateCommand);
}

/**
 * The running worker's agent activity and last repository result, then its current work: only
 * once the activity is read, since both go through the activator, which runs one operation at a
 * time, and only when the activity does not already refuse, which would leave the activator
 * held for nothing (`INSPECT_WORK_TIMEOUT_MS`). Undefined once interrupted, which asks the
 * worker nothing more.
 */
async function terminateInspection(
  deps: WorkerLifecycleDependencies,
  power: Power,
): Promise<TerminateInspection | undefined> {
  const then = thenRerunWorker(power.command, power.worker.key);
  const location = locateWorker(await deps.peers.view(), power.worker, power.tag, then);
  if (location.kind === "blocked") return { kind: "unlocated", verdict: location.verdict };
  const [activity, repositories] = await Promise.all([
    deps.controlPlane === undefined
      ? {
          kind: "unknown" as const,
          reason: "this fffactory cannot reach the worker's control plane",
        }
      : deps.controlPlane.activeAgents(location.worker),
    inspectRepositories(deps.transport, location.worker),
  ]);
  if (deps.interrupted()) return undefined;
  if (activity.kind !== "idle") return { kind: "activity", activity };
  const work = await inspectWork(deps.transport, location.worker);
  const placed = placedRepositories(power.request.instance.repositories ?? [], power.host);
  return { kind: "inspected", repositories, work, placed: placed.map(({ path }) => path) };
}

/**
 * Confirmed in advance (`--yes`, or terminate's matching `--confirm`), or asked at the terminal:
 * y/N, or for terminate the host key typed. The rule already refused anything else.
 */
async function confirmation(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  machine: Machine | undefined,
): Promise<boolean> {
  const { request } = power;
  if (confirmationRule(confirmedInAdvance(request), deps.prompt.interactive) === "confirmed")
    return true;
  await log.stage("awaiting_approval");
  const question = confirmationQuestion(power.command, power.worker, machine);
  const answer = await deps.prompt.ask(question);
  return power.action === "terminate"
    ? typedKeyConfirms(answer, power.worker.key)
    : confirms(answer);
}

/**
 * The confirmation about `machine` (undefined: already gone), or how the command ends without
 * it: interrupted, or declined, recorded `declined` with the lock released. Undefined once
 * confirmed.
 */
async function unconfirmed(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  machine: Machine | undefined,
): Promise<WorkerPower | undefined> {
  const confirmed = await confirmation(deps, power, log, machine);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (confirmed) return undefined;
  const recordFailure = await log.finish("declined", "declined");
  return {
    kind: "declined",
    operation: log.location,
    recordFailure,
    ...(machine?.state === "shutting-down" ? { terminating: machine.instanceId } : {}),
  };
}

interface Reaching {
  readonly machine: Machine;
  /** Whether this command asked EC2 for the change. */
  readonly changed: boolean;
  /** Whether the change was already under way, and this command only waited for it. */
  readonly awaited: boolean;
  /** Terminate's tailnet admin session, opened before EC2 was asked. */
  readonly admin?: TailnetAdminSession | undefined;
}

/**
 * How long a wait that started at `start` has waited after `polls` polls of `pollMs`: every read
 * after the first sleeps a poll, so a stalled clock cannot stretch the wait.
 */
function waited(power: Power, start: number, polls: number, pollMs: number): number {
  return Math.max(power.request.clock().getTime() - start, polls * pollMs);
}

/** Sleeps `ms`; false once interrupted. */
async function pause(deps: WorkerLifecycleDependencies, ms: number): Promise<boolean> {
  await deps.sleep(ms);
  return !deps.interrupted();
}

/** One read of the machine while waiting: reached, still on its way, or an end of the operation. */
type TargetRead =
  | { readonly kind: "reached" }
  | { readonly kind: "waiting"; readonly observed: ObservedMachineState | undefined }
  | { readonly kind: "ended"; readonly result: WorkerPower };

async function readTarget(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  target: MachineTarget,
): Promise<TargetRead> {
  const read = await deps.control.state(target);
  if (deps.interrupted()) return { kind: "ended", result: interruptedUnder(log, progress) };
  const observed = read.kind === "state" ? read.state : undefined;
  const step = waitStep(power.action, observed);
  if (step === "reached") return { kind: "reached" };
  if (step === "waiting" || observed === undefined) return { kind: "waiting", observed };
  await log.machine(target.instanceId, observed);
  const gone = machineGone(power.command, power.worker, target.instanceId, observed);
  return { kind: "ended", result: await failedUnder(log, gone) };
}

/**
 * Reads the machine's state every `POWER_POLL_MS` until it reaches the action's target state,
 * within `POWER_DEADLINE_MS`. A machine being terminated or gone fails at once. The record's
 * machine ends at the state that ended the wait: the target, the one gone, or the last seen.
 */
async function awaitTarget(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  reaching: Reaching,
): Promise<WorkerPower> {
  const { machine } = reaching;
  const target = targetOf(power, machine);
  const start = power.request.clock().getTime();
  // The last state a read found: a read that failed does not forget it.
  let lastSeen: ObservedMachineState | undefined;
  for (let polls = 0; ; polls += 1) {
    const read = await readTarget(deps, power, log, progress, target);
    if (read.kind === "reached") break;
    if (read.kind === "ended") return read.result;
    lastSeen = read.observed ?? lastSeen;
    if (waited(power, start, polls, POWER_POLL_MS) >= POWER_DEADLINE_MS)
      return timedOut(power, log, machine, lastSeen);
    if (!(await pause(deps, POWER_POLL_MS))) return interruptedUnder(log, progress);
  }
  await log.machine(machine.instanceId, TARGET_STATE[power.action]);
  return onwards(deps, power, log, progress, reaching);
}

/**
 * What follows the target state: terminate removing the host waited for a machine already being
 * terminated, so its removal follows; every other command has reached its end.
 */
function onwards(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  reaching: Reaching,
): Promise<WorkerPower> {
  const { machine, changed, awaited, admin } = reaching;
  if (!removesHost(power.command))
    return reached(deps, power, log, progress, {
      instanceId: machine.instanceId,
      changed,
      awaited,
      admin,
    });
  return removeHost(deps, power, log, progress, { machine, destroys: false, awaited, admin });
}

/** The deadline passed: recorded with the last state a read found, when one did. */
async function timedOut(
  power: Power,
  log: PowerLog,
  machine: Machine,
  lastSeen: ObservedMachineState | undefined,
): Promise<WorkerPower> {
  if (lastSeen !== undefined) await log.machine(machine.instanceId, lastSeen);
  return failedUnder(log, powerTimedOut(power.command, power.worker, machine.instanceId, lastSeen));
}

/** The stage status each action ends with once it changed the machine. */
const ENDED: Readonly<Record<PowerAction, StageStatus>> = {
  stop: "stopped",
  start: "started",
  terminate: "terminated",
};

/** The machine in the target state: its instance, undefined for terminate's machine already gone. */
type Reached = Omit<Reaching, "machine"> & { readonly instanceId: string | undefined };

/**
 * The machine is in the target state: stop is done; start goes on to the worker's readiness,
 * terminate to deleting its tailnet devices, which, left incomplete, make it partial.
 */
async function reached(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  { instanceId, changed, awaited, admin }: Reached,
): Promise<WorkerPower> {
  let verdict: Verdict | undefined;
  if (power.action === "start") {
    await log.stage("waiting");
    verdict = await awaitOnline(deps, power);
    if (verdict === undefined) return interruptedUnder(log, progress);
  }
  const removal = admin === undefined ? undefined : await tailnetCleanup(deps, power, log, admin);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const leftover = removal?.leftover;
  const recordFailure =
    leftover === undefined
      ? await log.finish(changed ? ENDED[power.action] : "unchanged", "succeeded")
      : await log.finish("partial", "partial", leftover.summary);
  return {
    kind: "done",
    action: power.action,
    worker: power.worker,
    instanceId,
    changed,
    awaited,
    ...(verdict === undefined ? {} : { verdict }),
    ...(removal ?? {}),
    operation: log.location,
    recordFailure,
  };
}

/** Terminate's last step: deleting the worker's tailnet devices, and what that left behind. */
async function tailnetCleanup(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  admin: TailnetAdminSession,
): Promise<{ readonly devices: DeviceRemoval; readonly leftover: Refusal | undefined }> {
  await log.stage("removing_devices");
  deps.progress({ kind: "removing_devices", hostname: power.worker.hostname });
  const devices = await removeDevices(deps, power, admin);
  return {
    devices,
    leftover: deviceRemovalRefusal(devices, power.worker, power.command as TerminateCommand),
  };
}

/**
 * Deletes, one at a time, every tailnet device carrying the worker's hostname and the factory's
 * tag (`selectWorkerDevices`); one without the tag is only reported. Stops at an interrupt.
 */
async function removeDevices(
  deps: WorkerLifecycleDependencies,
  power: Power,
  admin: TailnetAdminSession,
): Promise<DeviceRemoval> {
  const listing = await admin.devices();
  if (listing.kind === "failed") return { kind: "unlisted", reason: listing.reason };
  const { tagged, untagged } = selectWorkerDevices(
    listing.devices,
    power.worker.hostname,
    power.tag,
  );
  const removed: string[] = [];
  const failed: { readonly id: string; readonly reason: string }[] = [];
  for (const device of tagged) {
    if (deps.interrupted()) break;
    const deletion = await admin.remove(device.id);
    if (deletion.kind === "removed") removed.push(device.id);
    else failed.push({ id: device.id, reason: deletion.reason });
  }
  return { kind: "listed", removed, failed, untagged: untagged.map((device) => device.id) };
}

/**
 * Waits, within `ONLINE_DEADLINE_MS`, for the started worker's tailnet device to come online,
 * then inspects it and judges it as status does (`readinessVerdict`). A device still joining at
 * the deadline is reported with status's tailnet verdict; a duplicate name, an untagged device
 * or an unavailable view at once. Undefined once interrupted.
 */
async function awaitOnline(
  deps: WorkerLifecycleDependencies,
  power: Power,
): Promise<Verdict | undefined> {
  const start = power.request.clock().getTime();
  for (let polls = 0; ; polls += 1) {
    const look = await lookOnline(deps, power);
    if (
      look.kind === "verdict" ||
      waited(power, start, polls, ONLINE_POLL_MS) >= ONLINE_DEADLINE_MS
    )
      return look.verdict;
    if (polls === 0) deps.progress({ kind: "waiting_online", hostname: power.worker.hostname });
    if (!(await pause(deps, ONLINE_POLL_MS))) return undefined;
  }
}

/**
 * One look at the tailnet for the started worker: its verdict (undefined once interrupted), or
 * the tailnet's verdict while its device is still joining.
 */
async function lookOnline(
  deps: WorkerLifecycleDependencies,
  power: Power,
): Promise<{ readonly kind: "verdict" | "joining"; readonly verdict: Verdict | undefined }> {
  const view = await deps.peers.view();
  if (deps.interrupted()) return { kind: "verdict", verdict: undefined };
  const location = locateWorker(view, power.worker, power.tag);
  if (location.kind === "found")
    return { kind: "verdict", verdict: await readiness(deps, power, location.worker) };
  return { kind: joiningTailnet(location) ? "joining" : "verdict", verdict: location.verdict };
}

/** The worker's own inspection, judged against factory.json as status judges it. */
async function readiness(
  deps: WorkerLifecycleDependencies,
  power: Power,
  address: Parameters<typeof inspectWorker>[1],
): Promise<Verdict | undefined> {
  const inspection = await inspectWorker(deps.transport, address);
  if (deps.interrupted()) return undefined;
  return inspectionVerdict(inspection, {
    hostname: power.worker.hostname,
    release: power.pinned,
    configurationSha256: hostProjectionSha256(
      projectHost(power.request.instance, power.factoryId, power.pinned, power.host),
      deps.sha256,
    ),
    delivered: deliveredAccounts(power.request.instance, power.host.key).map(({ id }) => id),
  }).verdict;
}

/** What terminate removing the host found of its machine, and its admin session. */
interface Removing {
  /** The instance EC2 listed for the host; undefined when it listed none. */
  readonly machine: Machine | undefined;
  /** Whether Terraform must destroy the machine: false once it is gone. */
  readonly destroys: boolean;
  /** Whether a machine already being terminated was waited for first. */
  readonly awaited: boolean;
  readonly admin: TailnetAdminSession | undefined;
}

/**
 * Terminate for a host whose machine EC2 no longer lists, as an interrupted or timed-out
 * terminate leaves it: no gates, nothing to inspect. With `--keep`, once confirmed, only its
 * tailnet devices are deleted; otherwise the host is removed.
 */
async function terminateAbsent(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
): Promise<WorkerPower> {
  deps.progress({ kind: "absent", ...power.worker });
  const admin = await adminFor(deps, power, log);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (admin.kind === "refused") return refusedUnder(log, admin.refusal);
  if (!removesHost(power.command)) {
    // No machine is destroyed, but fffactory cannot tell what took it away: the operator
    // confirms the devices' deletion, as for a removal whose machine is gone.
    // TODO(re-evaluate when a live worker is found with its EC2 tags stripped): refuse while a
    // tagged device with the worker's hostname is connected, since the tags alone decide the
    // machine is gone here, with no Terraform state check as removal has.
    const ended = await unconfirmed(deps, power, log, progress, undefined);
    if (ended !== undefined) return ended;
    return reached(deps, power, log, progress, {
      instanceId: undefined,
      changed: false,
      awaited: false,
      admin: admin.session,
    });
  }
  return removeHost(deps, power, log, progress, {
    machine: undefined,
    destroys: false,
    awaited: false,
    admin: admin.session,
  });
}

/**
 * Removes the host (§Terminate (remove)): plans the removal into a plan file of its own, kept
 * only while the operation runs, then applies exactly that plan once approved.
 */
async function removeHost(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  removing: Removing,
): Promise<WorkerPower> {
  const planId = newPlanId(power.request.randomBytes);
  const files = await deps.planStore.create(power.factoryId, planId);
  try {
    return await planAndRemove(deps, power, log, progress, removing, files.factory);
  } finally {
    await deps.planStore.remove(power.factoryId, planId);
  }
}

/** The removal's own state: factory.json as read and without the host. */
function removalOf(power: Power): HostRemovalPlan {
  if (power.removal === undefined) throw new Error("a removal needs factory.json as read");
  return power.removal;
}

/** The scoped removal plan, shown and approved with the host key, then applied. */
async function planAndRemove(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  removing: Removing,
  planFile: string,
): Promise<WorkerPower> {
  await log.stage("planning");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  deps.progress({ kind: "planning_removal", key: power.worker.key });
  const destroying = removing.destroys ? removing.machine?.instanceId : undefined;
  const planning = await planRemoval(deps, power, planFile, destroying);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (planning.kind === "refused") return refusedUnder(log, planning.refusal);
  if (planning.kind === "failed")
    return failedUnder(log, planning.refusal, planning.diagnosticsFile);
  const target = removalTarget(power);
  deps.progress({
    kind: "removal_plan",
    target,
    changes: planning.changes,
    worker: power.worker,
  });
  const ended = await unconfirmed(deps, power, log, progress, removing.machine);
  if (ended !== undefined) return ended;
  return applyRemoval(deps, power, log, progress, removing, { ...planning, planFile });
}

/** What the removal plan shows first: the factory.json, factory, account, Region and release. */
function removalTarget(power: Power): PlanTarget {
  const { instance, release } = power.request;
  return {
    instancePath: removalOf(power).configuration.path,
    ...(instance.name === undefined ? {} : { name: instance.name }),
    factoryId: power.factoryId,
    accountId: power.bucket.accountId,
    region: power.region,
    release,
  };
}

type RemovalPlanning =
  | {
      readonly kind: "planned";
      /** The resource changes the plan makes, as shown for approval. */
      readonly changes: readonly ResourceChange[];
      /**
       * Whether to apply it: it changes resources or outputs, or the state still records the
       * removed key.
       */
      readonly applies: boolean;
      readonly target: ProvisioningTarget;
    }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | {
      readonly kind: "failed";
      readonly refusal: Refusal;
      readonly diagnosticsFile: string | undefined;
    };

/**
 * Plans factory.json without the host with the factory root's Terraform, its state lock taken,
 * the host keys the state records read as for any plan, the removed one no longer expected, and
 * checks the plan with the scoped removal rule (`removalPlanRefusal`): it must destroy exactly
 * `instanceId`, the instance EC2 lists, the gates inspected and the question names, or none
 * when that is undefined.
 */
async function planRemoval(
  deps: WorkerLifecycleDependencies,
  power: Power,
  planFile: string,
  instanceId: string | undefined,
): Promise<RemovalPlanning> {
  const { key } = power.worker;
  try {
    const target = factoryTarget(power.bucket, await deps.terraformDirectory());
    const recorded = recordedHostKeys(await deps.provisioner.output(target));
    if (recorded === undefined) return { kind: "refused", refusal: recordedKeysUnreadable(key) };
    const kept = recorded.filter((recordedKey) => recordedKey !== key);
    const projection = projectFactoryVariables(removalOf(power).remaining, kept);
    if (!projection.ok)
      return { kind: "refused", refusal: removalProjectionRefusal(key, projection.issues) };
    const saved = { ...target, planFile };
    const { changes } = await deps.provisioner.plan({
      ...saved,
      variables: { ...projection.variables },
      stateLock: true,
    });
    const shown = await deps.provisioner.showPlan(saved);
    const secret = power.host.paseo_password_secret;
    const refusal = removalPlanRefusal(shown, { key, instanceId, secret });
    if (refusal !== undefined) return { kind: "refused", refusal };
    const changing = (resourceChanges(shown) ?? []).filter(changesSomething);
    // A state still recording the key is applied too, whatever Terraform reports, so the key
    // stops being recorded: every later plan would refuse it once factory.json drops the host.
    const applies = changes || recorded.includes(key);
    return { kind: "planned", changes: changing, applies, target };
  } catch (error) {
    return {
      kind: "failed",
      refusal: removalPlanningFailed(key, reasonOf(error)),
      diagnosticsFile: diagnosticsFileOf(error),
    };
  }
}

/** Why factory.json is no longer the text read, or undefined while it is. */
async function configurationChange(configuration: Configuration, store: InstanceStore) {
  try {
    const now = await store.read(configuration.path);
    return now === configuration.text ? undefined : "changed after fffactory read it";
  } catch (error) {
    return `could not be read again (${reasonOf(error)})`;
  }
}

/**
 * Applies exactly the approved plan, once factory.json is still the text it was made from; a
 * plan that changes nothing, not even the recorded host keys, is not applied.
 */
async function applyRemoval(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  removing: Removing,
  planned: Extract<RemovalPlanning, { readonly kind: "planned" }> & { readonly planFile: string },
): Promise<WorkerPower> {
  const { key } = power.worker;
  const changed = await configurationChange(removalOf(power).configuration, deps.store);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (changed !== undefined) return refusedUnder(log, removalConfigurationChanged(key, changed));
  if (planned.applies) {
    const ended = await terraformApply(deps, power, log, progress, planned);
    if (ended !== undefined) return ended;
  }
  if (removing.destroys && removing.machine !== undefined)
    await log.machine(removing.machine.instanceId, "terminated");
  return writeAndClean(deps, power, log, progress, removing);
}

/**
 * Terraform's apply of exactly the approved plan file, then a read of the host keys its state
 * records, which must no longer hold the removed one; undefined once both succeeded.
 */
async function terraformApply(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  planned: { readonly target: ProvisioningTarget; readonly planFile: string },
): Promise<WorkerPower | undefined> {
  await log.stage("applying");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  progress.removal = "applying";
  deps.progress({ kind: "applying_removal" });
  const { key } = power.worker;
  let recorded: readonly string[] | undefined;
  try {
    await deps.provisioner.applyPlan({ ...planned.target, planFile: planned.planFile });
    if (deps.interrupted()) return interruptedUnder(log, progress);
    recorded = recordedHostKeys(await deps.provisioner.output(planned.target));
  } catch (error) {
    if (deps.interrupted()) return interruptedUnder(log, progress);
    return failedUnder(log, removalApplyFailed(key, reasonOf(error)), diagnosticsFileOf(error));
  }
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (recorded === undefined || recorded.includes(key))
    return failedUnder(log, removalStillRecorded(key));
  return undefined;
}

/**
 * Writes factory.json without the host, provided it is still the text read: otherwise, or when
 * the write fails, why, and factory.json is left as it is.
 */
async function writeWithoutHost(
  deps: WorkerLifecycleDependencies,
  power: Power,
): Promise<string | undefined> {
  const { configuration, remaining } = removalOf(power);
  const changed = await configurationChange(configuration, deps.store);
  if (changed !== undefined) return changed;
  try {
    await deps.store.write(configuration.path, serializeInstance(remaining));
    return undefined;
  } catch (error) {
    return reasonOf(error);
  }
}

/** Once Terraform removed the host: factory.json without it, then its tailnet devices. */
async function writeAndClean(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  removing: Removing,
): Promise<WorkerPower> {
  const { worker } = power;
  const { path } = removalOf(power).configuration;
  await log.stage("writing");
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const unwritten = await writeWithoutHost(deps, power);
  if (unwritten === undefined) {
    progress.removal = "written";
    deps.progress({ kind: "configuration_written", key: worker.key, path });
  }
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (unwritten !== undefined) return failedUnder(log, removalUnwritten(worker, path, unwritten));
  const { admin } = removing;
  const removal = admin === undefined ? undefined : await tailnetCleanup(deps, power, log, admin);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  const leftover = removal?.leftover;
  const recordFailure =
    leftover === undefined
      ? await log.finish("removed", "succeeded")
      : await log.finish("partial", "partial", leftover.summary);
  return {
    kind: "done",
    action: power.action,
    worker,
    instanceId: removing.machine?.instanceId,
    changed: true,
    awaited: removing.awaited,
    removed: true,
    ...(removal ?? {}),
    operation: log.location,
    recordFailure,
  };
}
