/**
 * `fffactory worker stop|start|terminate --keep` (`docs/specs/worker-lifecycle.md`): power one
 * declared worker's EC2 instance off or on, or terminate it, under the factory-wide lock and an
 * operation record. EC2's state is the truth: factory.json keeps no power field. Stop and start
 * keep the instance, its volume, its Terraform state and its tailnet device; terminate destroys
 * the instance and its volume and deletes its tailnet devices, and with `--keep` the host stays
 * in factory.json, so the next apply creates it afresh. Terraform is never run.
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
  type FactoryId,
  type FactoryInstance,
  type Host,
  type HostKey,
  parseRelease,
  type Release,
  type SecretReference,
} from "../domain/instance";
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
import { pinRefusal } from "../domain/plan";
import type { SecretMaterial } from "../domain/secrets";
import { hostName } from "../domain/resource-naming";
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
  powerTimedOut,
  type Refusal,
  requestFailed,
  requestUnanswered,
  selectMachine,
  type StopInspection,
  stopGate,
  TARGET_STATE,
  type TerminateInspection,
  terminateGate,
  thenRerunWorker,
  typedKeyConfirms,
  waitStep,
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
import { inspectRepositories } from "./inspect-repositories";
import { inspectWorker } from "./inspect-worker";
import type { LockStore, StateBucket } from "./lock-store";
import type { MachineControl, MachineRequest, MachineTarget } from "./machine-control";
import type { MachineInventorySource } from "./machine-inventory";
import type { OperatorPrompt } from "./operator-prompt";
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
  /** This machine's name, recorded as the lock holder's host. */
  readonly host: string;
  readonly clock: () => Date;
  readonly randomBytes: RandomBytes;
}

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
  | { readonly kind: "forced"; readonly action: PowerAction }
  /** Terminate: the machine is stopped, so the worker is not inspected. */
  | { readonly kind: "uninspected_stopped" }
  /** EC2 was asked to change the machine; the command now waits for the target state. */
  | { readonly kind: "requested"; readonly action: PowerAction; readonly instanceId: string }
  /** The change was already under way; the command only waits for the target state. */
  | { readonly kind: "awaiting"; readonly action: PowerAction; readonly instanceId: string }
  /** Start waits for the worker's tailnet device to come online. */
  | { readonly kind: "waiting_online"; readonly hostname: string }
  /** Terminate deletes the terminated worker's tailnet devices. */
  | { readonly kind: "removing_devices"; readonly hostname: string };

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
   * the machine, which then goes on changing.
   */
  | {
      readonly kind: "interrupted";
      readonly locked: true;
      readonly record: OperationLocation | undefined;
      readonly requested: boolean;
    }
  /** Refused, changing nothing: before the lock (`operation` undefined), or under it. */
  | {
      readonly kind: "refused";
      readonly refusal: Refusal;
      readonly operation: OperationLocation | undefined;
      readonly recordFailure?: string | undefined;
    }
  | {
      readonly kind: "declined";
      readonly operation: OperationLocation;
      readonly recordFailure: string | undefined;
    }
  | {
      readonly kind: "failed";
      readonly refusal: Refusal;
      readonly operation: OperationLocation;
      readonly recordFailure: string | undefined;
    }
  /**
   * The machine is in the target state: `changed` when this command asked EC2 for it, `awaited`
   * when it was already on its way and this command only waited for it. Start adds the worker's
   * `verdict`, as status words it; a worker not ready is not start's failure. Terminate adds how
   * deleting the worker's tailnet devices went, and `leftover`, what it left behind, when it did:
   * the terminate stands, and is partial.
   */
  | {
      readonly kind: "done";
      readonly action: PowerAction;
      readonly worker: WorkerIdentity;
      readonly instanceId: string;
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
 * Terminates a declared worker's machine and deletes its tailnet devices, keeping the host in
 * factory.json (§Terminate (keep)).
 */
export function terminateWorker(
  deps: WorkerLifecycleDependencies,
  request: Omit<WorkerLifecycleRequest, "action">,
): Promise<WorkerPower> {
  return powerWorker(deps, { ...request, action: "terminate" });
}

/** Everything a power operation works with once the checks before the lock passed. */
interface Power {
  readonly request: WorkerLifecycleRequest;
  readonly bucket: StateBucket;
  readonly action: PowerAction;
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
    return { kind: "refused", refusal: adminClientMissing(host.key), operation: undefined };
  return {
    kind: "checked",
    power: {
      request,
      bucket: location.bucket,
      action: request.action,
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

/** How far the operation got: whether EC2 may have been asked to change the machine. */
interface Progress {
  requested: boolean;
}

function interruptedUnder(log: PowerLog, progress: Progress): WorkerPower {
  return {
    kind: "interrupted",
    locked: true,
    record: log.written() ? log.location : undefined,
    requested: progress.requested,
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
    const refusal = {
      summary: reason,
      details: [],
      nextAction: thenRerunWorker(
        power.action,
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

async function failedUnder(log: PowerLog, refusal: Refusal): Promise<WorkerPower> {
  const recordFailure = await log.finish("failed", "failed", refusal.summary);
  return { kind: "failed", refusal, operation: log.location, recordFailure };
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
  const selection = selectMachine(inventory, power.worker.key, power.action);
  if (selection.kind === "refused") return refusedUnder(log, selection.refusal);
  const { machine } = selection;
  await log.machine(machine.instanceId, machine.state);
  deps.progress({
    kind: "located",
    ...power.worker,
    instanceId: machine.instanceId,
    state: machine.state,
  });
  const step = powerStep(power.action, machine, power.worker.key);
  switch (step.kind) {
    case "refused":
      return refusedUnder(log, step.refusal);
    case "done":
      return reached(deps, power, log, progress, { machine, changed: false, awaited: false });
    case "await": {
      const admin = await adminFor(deps, power, log);
      if (deps.interrupted()) return interruptedUnder(log, progress);
      if (admin.kind === "refused") return refusedUnder(log, admin.refusal);
      deps.progress({ kind: "awaiting", action: power.action, instanceId: machine.instanceId });
      return awaitTarget(deps, power, log, progress, {
        machine,
        changed: false,
        awaited: true,
        admin: admin.session,
      });
    }
    case "act":
      return act(deps, power, log, progress, machine);
  }
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
    return { kind: "refused", refusal: adminSecretUnreadable(key, reasonOf(error)) };
  }
  if (deps.interrupted()) return { kind: "open", session: undefined };
  const opening = await deps.tailnetAdmin.open(secret);
  if (opening.kind === "failed")
    return { kind: "refused", refusal: adminClientUnusable(key, opening.reason) };
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
 * wait for its outcome.
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
  const confirmed = await confirmation(deps, power, log, machine);
  if (deps.interrupted()) return interruptedUnder(log, progress);
  if (!confirmed) {
    const recordFailure = await log.finish("declined", "declined");
    return { kind: "declined", operation: log.location, recordFailure };
  }
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
      return failedUnder(log, requestFailed(action, worker, machine.instanceId, requested.reason));
    case "unanswered":
      return failedUnder(
        log,
        requestUnanswered(action, worker, machine.instanceId, requested.reason),
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
  // an agent between the check and the stop, which then ends it (accepted race, D5).
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
 * passes uninspected; a running worker is located in the tailnet, and its agent activity and
 * last repository result read, unless `--force` skips them. Undefined when terminate may go on.
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
    return terminateGate({ kind: "stopped" }, power.worker);
  }
  if (power.request.force) {
    deps.progress({ kind: "forced", action: "terminate" });
    return terminateGate({ kind: "forced" }, power.worker);
  }
  await log.stage("inspecting");
  // TODO(re-evaluate when dispatch gains a pause): pause dispatch on the worker before this
  // inspection, as for stop: until then an agent dispatch starts between the check and the
  // terminate ends with the machine (accepted race, D5).
  return terminateGate(await terminateInspection(deps, power), power.worker);
}

async function terminateInspection(
  deps: WorkerLifecycleDependencies,
  power: Power,
): Promise<TerminateInspection> {
  const then = thenRerunWorker("terminate", power.worker.key);
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
  return { kind: "inspected", activity, repositories };
}

/**
 * Confirmed in advance (`--yes`, or terminate's matching `--confirm`), or asked at the terminal:
 * y/N, or for terminate the host key typed. The rule already refused anything else.
 */
async function confirmation(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  machine: Machine,
): Promise<boolean> {
  const { request } = power;
  if (confirmationRule(confirmedInAdvance(request), deps.prompt.interactive) === "confirmed")
    return true;
  await log.stage("awaiting_approval");
  const question = confirmationQuestion(power.action, power.worker, machine.instanceId);
  const answer = await deps.prompt.ask(question);
  return power.action === "terminate"
    ? typedKeyConfirms(answer, power.worker.key)
    : confirms(answer);
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
  const gone = machineGone(power.action, power.worker, target.instanceId, observed);
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
  return reached(deps, power, log, progress, reaching);
}

/** The deadline passed: recorded with the last state a read found, when one did. */
async function timedOut(
  power: Power,
  log: PowerLog,
  machine: Machine,
  lastSeen: ObservedMachineState | undefined,
): Promise<WorkerPower> {
  if (lastSeen !== undefined) await log.machine(machine.instanceId, lastSeen);
  return failedUnder(log, powerTimedOut(power.action, power.worker, machine.instanceId, lastSeen));
}

/** The stage status each action ends with once it changed the machine. */
const ENDED: Readonly<Record<PowerAction, StageStatus>> = {
  stop: "stopped",
  start: "started",
  terminate: "terminated",
};

/**
 * The machine is in the target state: stop is done; start goes on to the worker's readiness,
 * terminate to deleting its tailnet devices, which, left incomplete, make it partial.
 */
async function reached(
  deps: WorkerLifecycleDependencies,
  power: Power,
  log: PowerLog,
  progress: Progress,
  { machine, changed, awaited, admin }: Reaching,
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
    instanceId: machine.instanceId,
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
  return { devices, leftover: deviceRemovalRefusal(devices, power.worker) };
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
      projectHost(power.factoryId, power.pinned, power.host),
      deps.sha256,
    ),
  }).verdict;
}
