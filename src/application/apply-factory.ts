/**
 * `fffactory apply`: one plan, one approval tied to exactly that plan, then the change, all
 * under the one factory-wide lock. Apply is staged: the infrastructure stage (the factory
 * root's Terraform), the workers stage (`applyWorkers`), then repository reconciliation.
 * Every stage is in the approved plan and the same lock and operation record. Workers first wait
 * for any worker whose machine the infrastructure stage created to finish its first boot. On
 * a first apply, backend bootstrap comes first with its own approval.
 *
 * Without a plan ID, apply plans afresh under the lock and asks for approval. With one, it
 * applies that saved plan only while it is fresh: the same factory.json text, release and
 * assets, and account, within its lifetime (checked before the lock), and the same Terraform
 * state revision (checked under the lock). Naming the plan ID is the approval of exactly
 * that plan, which `fffactory plan` showed.
 *
 * An operation record in the state bucket follows each step. An interrupted apply changes
 * nothing more and leaves its lock and record; after `fffactory lock break`, a rerun plans
 * again from what exists and converges.
 *
 * `fffactory upgrade` runs the same operation with a `PinMove`: its plan is made for the
 * running release, shown after the pin move and approved with it, and the new pin is written
 * under the lock once approved, before anything is applied.
 */
import type { FactoryId, FactoryInstance, Host, HostKey } from "../domain/instance";
import {
  finishOperation,
  INFRASTRUCTURE_STAGE,
  type OperationRecord,
  PIN_STAGE,
  REPOSITORIES_STAGE,
  type OperationStatus,
  operationKey,
  type StageStatus,
  startOperation,
  WORKERS_STAGE,
  withStage,
  withRepositories,
  withWorkers,
  withControlPlane,
  CONTROL_PLANE_STAGE,
  DISPATCH_STAGE,
  VERIFICATION_STAGE,
  withDispatch,
  withVerification,
} from "../domain/operation";
import {
  changesSomething,
  createdWorkers,
  declaredWorkers,
  describePlan,
  hostMachineRefusal,
  newPlanId,
  type PlannedWorker,
  type PlannedControlPlane,
  type PlannedDispatch,
  type PlanTarget,
  planStaleness,
  type ResourceChange,
  resourceChanges,
  type SavedPlan,
  stateStaleness,
  plannedDispatch,
} from "../domain/plan";
import { rolloutResult, skipped, type WorkerIdentity, type WorkerOutcome } from "../domain/rollout";
import {
  type ChangeType,
  classifyChange,
  maintenanceDeferral,
  preActivationDeferral,
} from "../domain/change-classification";
import { githubCredential, type PaseoHealth } from "../domain/dispatch-readiness";
import { locateWorker, type TailnetLocation, thenRerunApply } from "../domain/status";
import type { PeerView } from "../domain/tailnet";
import { projectHost, projectHosts } from "../domain/host-projection";
import { applyWorkers, type WorkersStageDependencies } from "./apply-workers";
import { applyRepositories, type RepositoryOutcome } from "./apply-repositories";
import { applyControlPlane, type ControlPlaneOutcome } from "./apply-control-plane";
import { applyDispatch, type DispatchOutcome, type DispatchWorker } from "./apply-dispatch";
import { verifyFactory, type FactoryVerification } from "./verify-factory";
import type { ControlPlane, ControlPlaneHealth } from "./control-plane";
import type { WorkflowQueue } from "./workflow-queue";
import type { Approval } from "./approval";
import { beginFactoryOperation } from "./bootstrap-backend";
import { type FactoryLock, type Interrupted, settleFactoryLock } from "./factory-lock";
import {
  checkPlannable,
  circumstances,
  type FactoryPlanDependencies,
  type FactoryPlanRequest,
  factoryTarget,
  type InfrastructurePlan,
  type PlanRefusal,
  planInfrastructure,
} from "./plan-factory";
import type { PlanFiles, StoredPlan } from "./plan-store";
import { diagnosticsFileOf } from "./provisioner";
import { planControlPlane } from "./plan-control-plane";

export interface FactoryApplyDependencies
  extends FactoryPlanDependencies,
    /** The workers stage's clock is the request's. */
    Omit<WorkersStageDependencies, "clock"> {
  /** Asks the operator to approve each plan it is shown: bootstrap's, then the factory's. */
  readonly approval: Approval;
  readonly interrupted: Interrupted;
  /**
   * Paseo's control plane drives its own recorded stage after repositories. The optional
   * FFFlow/GitHub queue adds dispatch and end-to-end verification after that stage.
   */
  readonly controlPlane?: ControlPlane;
  readonly workflowQueue?: WorkflowQueue;
}

/**
 * `fffactory upgrade`'s move of factory.json's release pin to the running release, approved
 * with the plan and written under the lock once approved, before anything is applied.
 */
export interface PinMove {
  /** What the plan shows first. */
  readonly preview: readonly string[];
  /**
   * Writes the new pin. False, writing nothing, when factory.json is no longer the text the
   * plan was made from.
   */
  readonly write: () => Promise<boolean>;
}

export interface FactoryApplyRequest extends Omit<FactoryPlanRequest, "now"> {
  /** A saved plan to apply exactly. Without one, apply plans afresh under the lock. */
  readonly planId?: string;
  /** The operation the lock and its record name; `apply` unless given. */
  readonly operation?: string;
  /** Upgrade's pin move. Never with a saved plan: an upgrade always plans afresh. */
  readonly pinMove?: PinMove;
  /** This machine's name, recorded as the lock holder's host. */
  readonly host: string;
  readonly clock: () => Date;
}

/** Where the operation's record is in the state bucket. */
export interface OperationLocation {
  readonly bucket: string;
  readonly key: string;
}

export type FactoryApply =
  | PlanRefusal
  | { readonly kind: "no_plan"; readonly planId: string }
  /** The saved plan's record cannot be read, or its Terraform plan changed after saving. */
  | { readonly kind: "damaged_plan"; readonly planId: string }
  | { readonly kind: "stale"; readonly planId: string; readonly reasons: readonly string[] }
  | { readonly kind: "declined"; readonly stage: "backend" | "infrastructure" }
  /** factory.json changed after the upgrade's plan was made: the pin was not moved. */
  | { readonly kind: "configuration_changed" }
  /**
   * An upgrade found no state bucket: an upgrade never bootstraps it, so nothing was created,
   * locked or applied.
   */
  | { readonly kind: "no_state_bucket" }
  /** fffactory was interrupted before the lock was taken: it takes none. */
  | { readonly kind: "interrupted"; readonly locked: false }
  /**
   * fffactory was interrupted holding the lock: the lock and the operation record stay as
   * they were. `record` is where the record is, once a write of it finished; `installing` the
   * worker whose `host apply` was running, which may still be installing; `waiting` the new
   * worker whose first boot apply was waiting for, on which no install step ran.
   */
  | {
      readonly kind: "interrupted";
      readonly locked: true;
      readonly record: OperationLocation | undefined;
      readonly installing?: WorkerIdentity | undefined;
      readonly waiting?: WorkerIdentity;
    }
  | {
      readonly kind: "applied";
      readonly bootstrapped: boolean;
      /** Whether Terraform applied changes, or the plan had none for it. */
      readonly infrastructure: "applied" | "unchanged";
      /** Each declared worker's outcome, in the order they were updated. */
      readonly workers: readonly WorkerOutcome[];
      /**
       * The phase-3 stages' outcomes, present when they ran (the control-plane and workflow-queue
       * ports were wired and the workers rollout did not fail): each worker's repository
       * synchronization, control-plane reconciliation and dispatch state, then the end-to-end
       * verdict.
       */
      readonly repositories?: readonly RepositoryOutcome[];
      readonly controlPlane?: readonly ControlPlaneOutcome[];
      readonly dispatch?: readonly DispatchOutcome[];
      readonly verification?: FactoryVerification;
      readonly operation: OperationLocation;
      /** Why the operation's final record could not be written, when it could not. */
      readonly recordFailure: string | undefined;
    }
  | {
      readonly kind: "failed";
      /**
       * Planning changes nothing; pinning (upgrade's) applies nothing, though the pin may
       * have been written; pinned (upgrade's) applies nothing, and the pin was written;
       * applying may have changed some infrastructure; installing may have changed the worker
       * it was installing.
       */
      readonly step: Progress["step"];
      readonly reason: string;
      /** The private local file keeping the failed Terraform command's diagnostics, if any. */
      readonly diagnosticsFile: string | undefined;
      readonly operation: OperationLocation;
      /** Why the operation's final record could not be written, when it could not. */
      readonly recordFailure: string | undefined;
    };

type SavedPlanChoice =
  | { readonly kind: "none" }
  | Extract<StoredPlan, { readonly kind: "found" }>
  | Extract<FactoryApply, { readonly kind: "no_plan" | "damaged_plan" | "stale" }>;

/** The saved plan the request names, only if it is fresh as far as can be told locally. */
async function savedPlan(
  deps: FactoryApplyDependencies,
  request: FactoryApplyRequest,
  target: PlanTarget,
  now: Date,
): Promise<SavedPlanChoice> {
  const { planId } = request;
  if (planId === undefined) return { kind: "none" };
  const stored = await deps.planStore.load(target.factoryId, planId);
  if (stored.kind === "missing") return { kind: "no_plan", planId };
  if (stored.kind === "damaged") return { kind: "damaged_plan", planId };
  const reasons = planStaleness(stored.plan, circumstances({ ...request, now }, target));
  if (reasons.length > 0) return { kind: "stale", planId, reasons };
  return stored;
}

/**
 * What the lock is held for: one apply's plan files, and its saved plan, if any, with the
 * SHA-256 its Terraform plan file had when it was loaded.
 */
interface LockedApply {
  readonly lock: FactoryLock;
  readonly target: PlanTarget;
  readonly files: PlanFiles;
  readonly saved: SavedPlan | undefined;
  readonly savedDigest: string | undefined;
  readonly bootstrapped: boolean;
  readonly planId: string;
}

type InfrastructureChanges =
  | Exclude<InfrastructurePlan, { readonly kind: "planned" }>
  | Extract<FactoryApply, { readonly kind: "stale" | "damaged_plan" }>
  | { readonly kind: "ready"; readonly changes: readonly ResourceChange[] };

/** Whether two plans make the same changes to the same resources. */
function sameChanges(a: readonly ResourceChange[], b: readonly ResourceChange[]): boolean {
  const key = (changes: readonly ResourceChange[]) =>
    JSON.stringify(changes.map(({ address, actions }) => [address, actions]));
  return key(a) === key(b);
}

/**
 * A saved plan is damaged once its Terraform plan file is not the one loaded before the lock,
 * whose changes are shown, checked and applied. Undefined while it is, or without one.
 */
async function swappedPlanFile(
  deps: FactoryApplyDependencies,
  { saved, savedDigest }: LockedApply,
): Promise<Extract<FactoryApply, { readonly kind: "damaged_plan" }> | undefined> {
  if (saved === undefined) return undefined;
  const digest = await deps.planStore.digest(saved.factory_id, saved.plan_id);
  return digest === savedDigest ? undefined : { kind: "damaged_plan", planId: saved.plan_id };
}

/**
 * The saved plan's changes, read from the Terraform plan file that will be applied, only
 * while the state is the revision it was planned against and the file is still the one
 * loaded before the lock, making the changes its record shows.
 */
async function savedChanges(
  deps: FactoryApplyDependencies,
  saved: SavedPlan,
  terraformDirectory: string,
  locked: LockedApply,
): Promise<InfrastructureChanges> {
  const { lock } = locked;
  const stale = stateStaleness(saved, await deps.lockStore.stateRevision(lock.bucket));
  if (stale !== undefined) return { kind: "stale", planId: saved.plan_id, reasons: [stale] };
  const swapped = await swappedPlanFile(deps, locked);
  if (swapped !== undefined) return swapped;
  const shown = resourceChanges(
    await deps.provisioner.showPlan({
      ...factoryTarget(lock.bucket, terraformDirectory),
      planFile: locked.files.factory,
    }),
  );
  if (shown === undefined)
    return { kind: "unexpected_plan", unexpected: ["Terraform's plan could not be read"] };
  const changes = shown.filter(changesSomething);
  if (!sameChanges(changes, saved.changes)) return { kind: "damaged_plan", planId: saved.plan_id };
  const lost = hostMachineRefusal(changes);
  if (lost !== undefined) return { kind: "d11", refusal: lost };
  return { kind: "ready", changes };
}

/** The infrastructure stage's changes: the saved plan's while it is fresh, or a fresh plan's. */
async function infrastructureChanges(
  deps: FactoryApplyDependencies,
  instance: FactoryInstance,
  terraformDirectory: string,
  locked: LockedApply,
): Promise<InfrastructureChanges> {
  const { saved, lock } = locked;
  if (saved !== undefined) return savedChanges(deps, saved, terraformDirectory, locked);
  const planned = await planInfrastructure(deps, {
    instance,
    bucket: lock.bucket,
    terraformDirectory,
    planFile: locked.files.factory,
    underFactoryLock: true,
  });
  if (planned.kind !== "planned") return planned;
  return { kind: "ready", changes: planned.changes };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Records each step of the operation in the state bucket, as it happens. From an interrupt
 * on it writes nothing more, so the record stays at the step the interrupt found.
 */
function operationLog(
  deps: FactoryApplyDependencies,
  locked: LockedApply,
  request: FactoryApplyRequest,
) {
  const { clock } = request;
  let record = startOperation(
    locked.lock.record,
    locked.saved?.plan_id,
    request.pinMove === undefined ? [] : [PIN_STAGE],
  );
  let written = false;
  const write = async (next: OperationRecord) => {
    if (deps.interrupted()) return;
    record = next;
    await deps.lockStore.writeOperation(locked.lock.bucket, next);
    written = true;
  };
  return {
    location: { bucket: locked.lock.bucket.bucket, key: operationKey(record) },
    /** Whether a write of the record has finished. */
    written: () => written,
    start: () => write(record),
    stage: (status: StageStatus, stage = INFRASTRUCTURE_STAGE) =>
      write(withStage(record, stage, status, clock())),
    workers: (outcomes: readonly WorkerOutcome[]) => write(withWorkers(record, outcomes, clock())),
    repositories: (outcomes: readonly RepositoryOutcome[]) =>
      write(withRepositories(record, outcomes, clock())),
    controlPlane: (outcomes: readonly ControlPlaneOutcome[]) =>
      write(withControlPlane(record, outcomes, clock())),
    dispatch: (outcomes: readonly DispatchOutcome[]) =>
      write(withDispatch(record, outcomes, clock())),
    verification: (verification: FactoryVerification) =>
      write(withVerification(record, verification, clock())),
    finish: (
      status: StageStatus,
      outcome: Exclude<OperationStatus, "running">,
      reason?: string,
      stage = INFRASTRUCTURE_STAGE,
    ) =>
      write(finishOperation(withStage(record, stage, status, clock()), outcome, clock(), reason)),
  };
}

/**
 * Ends the time under the lock: releases it unless interrupted, then removes a saved plan,
 * which is spent once apply held the lock for it, whether applied, failed or stale.
 */
async function settle(deps: FactoryApplyDependencies, locked: LockedApply): Promise<void> {
  await settleFactoryLock(deps.lockStore, locked.lock, deps.interrupted);
  if (locked.saved !== undefined && !deps.interrupted())
    await deps.planStore.remove(locked.target.factoryId, locked.saved.plan_id);
}

type OperationLog = ReturnType<typeof operationLog>;

/**
 * How far the operation got: planning changes nothing; pinning (upgrade's) may have moved
 * the pin; pinned (upgrade's) moved it, and nothing is applied yet; applying may have changed
 * some infrastructure; installing may have changed a worker.
 */
interface Progress {
  step:
    | "planning"
    | "pinning"
    | "pinned"
    | "applying"
    | "installing"
    | "repositories"
    | "control-plane"
    | "dispatch"
    | "verification";
}

/** The stage of the record each step belongs to. */
const STAGE_OF: Readonly<Record<Progress["step"], string>> = {
  planning: INFRASTRUCTURE_STAGE,
  pinning: PIN_STAGE,
  pinned: INFRASTRUCTURE_STAGE,
  applying: INFRASTRUCTURE_STAGE,
  installing: WORKERS_STAGE,
  repositories: REPOSITORIES_STAGE,
  "control-plane": CONTROL_PLANE_STAGE,
  dispatch: DISPATCH_STAGE,
  verification: VERIFICATION_STAGE,
};

/** The operation's record, and how far it got. */
interface Tracking {
  readonly log: OperationLog;
  readonly progress: Progress;
}

/** Interrupted under the lock: the lock stays, with the record if a write of it finished. */
function interruptedUnder(
  log: OperationLog,
  installing?: WorkerIdentity,
  waiting?: WorkerIdentity,
): FactoryApply {
  return {
    kind: "interrupted",
    locked: true,
    record: log.written() ? log.location : undefined,
    installing,
    ...(waiting === undefined ? {} : { waiting }),
  };
}

/** The infrastructure stage's changes and the workers the approved plan installs. */
interface ApprovedChanges {
  readonly changes: readonly ResourceChange[];
  readonly workers: readonly PlannedWorker[];
  readonly controlPlane: readonly PlannedControlPlane[];
  readonly dispatch: readonly PlannedDispatch[];
}

/**
 * Upgrade's pin, once its plan is approved: written unless factory.json changed after the
 * plan was made. Undefined when the operation may go on.
 */
async function movePin(
  deps: FactoryApplyDependencies,
  pinMove: PinMove,
  { log, progress }: Tracking,
): Promise<FactoryApply | undefined> {
  progress.step = "pinning";
  const written = await pinMove.write();
  // Past pinning once the pin is written: a later failure is not the pin's.
  if (written) progress.step = "pinned";
  if (deps.interrupted()) return interruptedUnder(log);
  if (!written) {
    await log.finish("refused", "refused", undefined, PIN_STAGE);
    return { kind: "configuration_changed" };
  }
  await log.stage("written", PIN_STAGE);
  return undefined;
}

/**
 * From the approval question on: asks, moves an upgrade's pin, checks a saved plan's file is
 * still the one loaded, applies exactly the plan file when it changes anything, then runs the
 * workers stage.
 */
async function approveAndApply(
  deps: FactoryApplyDependencies,
  request: FactoryApplyRequest,
  locked: LockedApply,
  tracking: Tracking,
  {
    plan,
    changes,
    workers,
    controlPlane,
    dispatch,
  }: ApprovedChanges & { readonly plan: readonly string[] },
): Promise<FactoryApply> {
  const { log, progress } = tracking;
  await log.stage("awaiting_approval");
  const approved = await deps.approval.approve(plan);
  if (deps.interrupted()) return interruptedUnder(log);
  if (!approved) {
    await log.finish("declined", "declined");
    return { kind: "declined", stage: "infrastructure" };
  }
  if (request.pinMove !== undefined) {
    const stopped = await movePin(deps, request.pinMove, tracking);
    if (stopped !== undefined) return stopped;
  }
  const swapped = await swappedPlanFile(deps, locked);
  if (swapped !== undefined) {
    await log.finish("refused", "refused");
    return swapped;
  }
  if (changes.length > 0) {
    await log.stage("applying");
    progress.step = "applying";
    await deps.provisioner.applyPlan({
      ...factoryTarget(locked.lock.bucket, request.terraformDirectory),
      planFile: locked.files.factory,
    });
    if (deps.interrupted()) return interruptedUnder(log);
  }
  const infrastructure = changes.length > 0 ? "applied" : "unchanged";
  // Only the machines this apply just created are still booting; their first boot is waited for.
  const created = createdWorkers(changes, workers);
  return workersStage(deps, request, locked, tracking, {
    infrastructure,
    created,
    controlPlane,
    dispatch,
  });
}

/**
 * The workers stage under the lock, after the infrastructure stage: installs the release on
 * each worker the plan names, recording each worker's outcome, and ends the operation.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the single ordered pre-activation safety boundary
async function workersStage(
  deps: FactoryApplyDependencies,
  request: FactoryApplyRequest,
  locked: LockedApply,
  { log, progress }: Tracking,
  applied: {
    readonly infrastructure: "applied" | "unchanged";
    readonly created: readonly HostKey[];
    readonly controlPlane: readonly PlannedControlPlane[];
    readonly dispatch: readonly PlannedDispatch[];
  },
): Promise<FactoryApply> {
  const { infrastructure, created, controlPlane } = applied;
  const { bootstrapped } = locked;
  const finished = (
    outcomes: readonly WorkerOutcome[],
    recordFailure: string | undefined,
    post?: PostWorkers,
  ) =>
    ({
      kind: "applied",
      bootstrapped,
      infrastructure,
      workers: outcomes,
      ...(post ?? {}),
      operation: log.location,
      recordFailure,
    }) as const;
  await log.stage(infrastructure);
  await log.stage("installing", WORKERS_STAGE);
  progress.step = "installing";
  const tag = requireTag(request.instance);
  const currentControlPlane = await planControlPlane(
    deps,
    locked.target,
    tag,
    request.instance.hosts ?? [],
    request.assetsSha256,
    new Set(created),
  );
  for (const approved of controlPlane) {
    if (created.includes(approved.key)) continue;
    const current = currentControlPlane.find((item) => item.key === approved.key);
    if (current === undefined || current.observation !== approved.observation) {
      await log.finish("refused", "refused", undefined, WORKERS_STAGE);
      return {
        kind: "stale",
        planId: locked.planId,
        reasons: [`Paseo state on ${approved.hostname} changed after it was planned`],
      };
    }
  }
  let activityView: PeerView | undefined;
  const deferred = new Set<HostKey>();
  const deferredControl: ControlPlaneOutcome[] = [];
  for (const plan of controlPlane) {
    if (
      created.includes(plan.key) ||
      !plan.observation.startsWith("{") ||
      !plan.changes.some((change) => classifyChange(change) === "maintenance")
    )
      continue;
    activityView ??= await deps.peers.view();
    const location = locateWorker(activityView, plan.hostname, tag);
    const activity =
      location.kind === "found" && deps.controlPlane !== undefined
        ? await deps.controlPlane.activeAgents(location.worker)
        : { kind: "unknown" as const, reason: "worker activity could not be read" };
    if (activity.kind !== "idle") {
      deferred.add(plan.key);
      const pending = plan.changes.filter((change) => classifyChange(change) === "maintenance");
      deferredControl.push({
        key: plan.key,
        hostname: plan.hostname,
        kind: "deferred",
        pending,
        reloaded: false,
        ...maintenanceDeferral(plan.hostname, pending),
      });
    }
  }
  const stage = await applyWorkers(
    { ...deps, clock: request.clock },
    {
      tag,
      release: locked.target.release,
      projections: projectHosts(request.instance, locked.target.factoryId, locked.target.release),
      created,
      deferred,
    },
    (outcomes) => log.workers(outcomes),
  );
  if (stage.kind === "interrupted") return interruptedUnder(log, stage.installing, stage.waiting);
  if (deps.interrupted()) return interruptedUnder(log);
  const result = rolloutResult(stage.outcomes);
  const status = result === "installed" ? "succeeded" : result;
  const failure = stage.outcomes.find((outcome) => outcome.kind === "failed");
  const reason =
    failure?.kind === "failed" ? `worker ${failure.key}: ${failure.summary}` : undefined;
  const finishWorkers = () =>
    log.finish(result, status, reason, WORKERS_STAGE).then(() => undefined, reasonOf);

  // A failed worker rollout stops before repository mutation.
  if (result === "failed") return finished(stage.outcomes, await finishWorkers());
  return repositoriesStage(
    deps,
    request,
    locked,
    { log, progress },
    stage.outcomes,
    result,
    controlPlane,
    deferredControl,
    finished,
  );
}

/** Repository reconciliation under the same approved plan, lock and operation record. */
async function repositoriesStage(
  deps: FactoryApplyDependencies,
  request: FactoryApplyRequest,
  locked: LockedApply,
  { log, progress }: Tracking,
  workerOutcomes: readonly WorkerOutcome[],
  workerResult: "installed" | "partial",
  controlPlanePlan: readonly PlannedControlPlane[],
  deferredControl: readonly ControlPlaneOutcome[],
  finished: (
    outcomes: readonly WorkerOutcome[],
    recordFailure: string | undefined,
    post?: PostWorkers,
  ) => Extract<FactoryApply, { readonly kind: "applied" }>,
): Promise<FactoryApply> {
  const tag = requireTag(request.instance);
  await log.stage(workerResult, WORKERS_STAGE);
  await log.stage("synchronizing", REPOSITORIES_STAGE);
  progress.step = "repositories";
  const repositoryStage = await applyRepositories(
    { peers: deps.peers, transport: deps.transport },
    {
      factoryId: locked.target.factoryId,
      tag,
      hosts: request.instance.hosts ?? [],
      repositories: request.instance.repositories ?? [],
    },
  );
  if (deps.interrupted()) return interruptedUnder(log);
  await log.repositories(repositoryStage.outcomes);
  const repositoryStatus = repositoryStage.outcomes.every(
    (outcome) => outcome.kind === "synchronized",
  )
    ? "synchronized"
    : "partial";
  await log.stage(repositoryStatus, REPOSITORIES_STAGE);
  const operationStatus =
    workerResult === "partial" || repositoryStatus === "partial" ? "partial" : "succeeded";
  const finishRepositories = () =>
    log
      .finish(repositoryStatus, operationStatus, undefined, REPOSITORIES_STAGE)
      .then(() => undefined, reasonOf);
  const { controlPlane, workflowQueue } = deps;
  if (controlPlane === undefined)
    return finished(workerOutcomes, await finishRepositories(), {
      repositories: repositoryStage.outcomes,
    });
  return phaseThree(
    { deps, controlPlane, workflowQueue, request, locked, log, progress },
    {
      tag,
      result: workerResult,
      outcomes: workerOutcomes,
      repositories: repositoryStage.outcomes,
      controlPlanePlan,
      deferredControl,
    },
    async (post, recordFailure) => finished(workerOutcomes, recordFailure, post),
  );
}

/** factory.json's `tailscale.tag`; missing is an error, never a default (`checkPlannable` has it). */
function requireTag(instance: FactoryInstance): string {
  const tag = instance.tailscale?.tag;
  if (tag === undefined)
    throw new Error("factory.json has no tailscale.tag, which every worker's device must carry");
  return tag;
}

function controlPlaneStageStatus(outcomes: readonly ControlPlaneOutcome[]) {
  if (outcomes.some((outcome) => outcome.kind === "failed")) return "failed";
  return outcomes.some((outcome) => outcome.kind === "deferred") ? "deferred" : "reconciled";
}

/** A skipped worker, like a pending one, leaves the stage pending: a later apply completes it. */
function dispatchStageStatus(outcomes: readonly DispatchOutcome[]) {
  if (outcomes.some((outcome) => outcome.kind === "failed")) return "failed";
  return outcomes.some((outcome) => outcome.kind === "pending" || outcome.kind === "skipped")
    ? "pending"
    : "active";
}

function phaseThreeCallbacks(log: OperationLog, progress: Progress) {
  return {
    onControlPlane: async (outcomes: readonly ControlPlaneOutcome[]) => {
      await log.controlPlane(outcomes);
      await log.stage(controlPlaneStageStatus(outcomes), CONTROL_PLANE_STAGE);
    },
    beforeDispatch: async () => {
      progress.step = "dispatch";
      await log.stage("reconciling", DISPATCH_STAGE);
    },
    onDispatch: async (outcomes: readonly DispatchOutcome[]) => {
      await log.dispatch(outcomes);
      await log.stage(dispatchStageStatus(outcomes), DISPATCH_STAGE);
    },
    beforeVerification: async () => {
      progress.step = "verification";
      await log.stage("reconciling", VERIFICATION_STAGE);
    },
  };
}

/** Runs the phase-3 stages under the lock, recording the workers stage done first. */
async function phaseThree(
  ctx: {
    readonly deps: FactoryApplyDependencies;
    readonly controlPlane: ControlPlane;
    readonly workflowQueue?: WorkflowQueue;
    readonly request: FactoryApplyRequest;
    readonly locked: LockedApply;
    readonly log: OperationLog;
    readonly progress: Progress;
  },
  about: {
    readonly tag: string;
    readonly result: "installed" | "partial";
    readonly outcomes: readonly WorkerOutcome[];
    readonly repositories: readonly RepositoryOutcome[];
    readonly controlPlanePlan: readonly PlannedControlPlane[];
    readonly deferredControl: readonly ControlPlaneOutcome[];
  },
  applied: (post: PostWorkers, recordFailure: string | undefined) => Promise<FactoryApply>,
): Promise<FactoryApply> {
  const { deps, controlPlane, workflowQueue, request, locked, log, progress } = ctx;
  if (deps.interrupted()) return interruptedUnder(log);
  progress.step = "control-plane";
  await log.stage("reconciling", CONTROL_PLANE_STAGE);
  const post = await postWorkersStages(deps, controlPlane, workflowQueue, request, {
    factoryId: locked.target.factoryId,
    tag: about.tag,
    workers: about.outcomes,
    repositories: about.repositories,
    controlPlanePlan: about.controlPlanePlan,
    deferredControl: about.deferredControl,
    ...phaseThreeCallbacks(log, progress),
  });
  if ("interrupted" in post) return interruptedUnder(log);
  return finishPhaseThree(log, about, post, applied);
}

/** The phase-3 stages' outcomes, carried in the applied result. */
interface PostWorkers {
  readonly repositories: readonly RepositoryOutcome[];
  readonly controlPlane?: readonly ControlPlaneOutcome[];
  readonly dispatch?: readonly DispatchOutcome[];
  readonly verification?: FactoryVerification;
}

function phaseThreePartial(
  about: {
    readonly result: "installed" | "partial";
    readonly repositories: readonly RepositoryOutcome[];
  },
  post: PostWorkers & { readonly verification: FactoryVerification },
): boolean {
  return (
    about.result === "partial" ||
    about.repositories.some((outcome) => outcome.kind !== "synchronized") ||
    post.controlPlane?.some((outcome) => outcome.kind === "deferred") === true ||
    !post.verification.ready
  );
}

function reconciliationFailure(
  post: PostWorkers,
): DispatchOutcome | ControlPlaneOutcome | undefined {
  return (
    post.dispatch?.find((outcome) => outcome.kind === "failed") ??
    post.controlPlane?.find((outcome) => outcome.kind === "failed")
  );
}

function reconciliationFailureReason(
  failure: DispatchOutcome | ControlPlaneOutcome | undefined,
): string | undefined {
  if (failure === undefined) return undefined;
  const key = "key" in failure ? `${failure.key}: ` : "";
  return `${key}${"summary" in failure ? failure.summary : "phase-three reconciliation failed"}`;
}

async function finishPhaseThree(
  log: OperationLog,
  about: {
    readonly result: "installed" | "partial";
    readonly repositories: readonly RepositoryOutcome[];
  },
  post: PostWorkers,
  applied: (post: PostWorkers, recordFailure: string | undefined) => Promise<FactoryApply>,
): Promise<FactoryApply> {
  if (post.verification === undefined) return finishUnverified(log, about, post, applied);
  const verified = { ...post, verification: post.verification };
  return finishVerified(log, about, verified, applied);
}

async function finishUnverified(
  log: OperationLog,
  about: {
    readonly result: "installed" | "partial";
    readonly repositories: readonly RepositoryOutcome[];
  },
  post: PostWorkers,
  applied: (post: PostWorkers, recordFailure: string | undefined) => Promise<FactoryApply>,
): Promise<FactoryApply> {
  const incomplete =
    about.result === "partial" ||
    about.repositories.some((outcome) => outcome.kind !== "synchronized");
  const recordFailure = await finishControlPlane(
    log,
    incomplete ? "partial" : "succeeded",
    post.controlPlane ?? [],
  );
  return applied(post, recordFailure);
}

async function finishVerified(
  log: OperationLog,
  about: {
    readonly result: "installed" | "partial";
    readonly repositories: readonly RepositoryOutcome[];
  },
  verified: PostWorkers & { readonly verification: FactoryVerification },
  applied: (post: PostWorkers, recordFailure: string | undefined) => Promise<FactoryApply>,
): Promise<FactoryApply> {
  await log.verification(verified.verification);
  const failure = reconciliationFailure(verified);
  const outcome =
    failure === undefined
      ? phaseThreePartial(about, verified)
        ? "partial"
        : "succeeded"
      : "failed";
  const stageStatus =
    failure === undefined ? (verified.verification.ready ? "verified" : "pending") : "failed";
  const recordFailure = await log
    .finish(stageStatus, outcome, reconciliationFailureReason(failure), VERIFICATION_STAGE)
    .then(() => undefined, reasonOf);
  return applied(verified, recordFailure);
}

async function finishControlPlane(
  log: OperationLog,
  baseStatus: "succeeded" | "partial",
  outcomes: readonly ControlPlaneOutcome[],
): Promise<string | undefined> {
  const failure = outcomes.find((outcome) => outcome.kind === "failed");
  const deferred = outcomes.some((outcome) => outcome.kind === "deferred");
  const operationStatus =
    failure !== undefined
      ? "failed"
      : baseStatus === "partial" || deferred
        ? "partial"
        : "succeeded";
  const stageStatus = failure !== undefined ? "failed" : deferred ? "deferred" : "reconciled";
  const reason =
    failure?.kind === "failed" ? `control-plane ${failure.key}: ${failure.summary}` : undefined;
  return log
    .finish(stageStatus, operationStatus, reason, CONTROL_PLANE_STAGE)
    .then(() => undefined, reasonOf);
}

function paseoHealthOf(health: ControlPlaneHealth): PaseoHealth {
  if (health === "healthy") return "healthy";
  return health === "unhealthy" ? "unhealthy" : "unknown";
}

/**
 * One worker's control-plane reconciliation and Paseo health, or unknown when it was not
 * reconciled, and where the tailnet locates it, or why it does not.
 */
interface WorkerControlPlane {
  readonly control: ControlPlaneOutcome | undefined;
  readonly location: TailnetLocation;
  readonly paseoHealth: PaseoHealth;
}

async function reconcileWorkerControlPlane(
  controlPlane: ControlPlane,
  view: PeerView,
  tag: string,
  worker: WorkerOutcome,
  factoryId: FactoryId,
  release: FactoryApplyRequest["release"],
  host: Host,
  changes: readonly ChangeType[],
  observation: string | undefined,
): Promise<WorkerControlPlane> {
  const identity: WorkerIdentity = { key: worker.key, hostname: worker.hostname };
  const location = locateWorker(view, worker.hostname, tag, thenRerunApply);
  if (location.kind !== "found") return { control: undefined, location, paseoHealth: "unknown" };
  const control = await applyControlPlane(
    { controlPlane },
    {
      worker: identity,
      address: location.worker,
      changes,
      projection: projectHost(factoryId, release, host),
      ...(observation === "no-release" ? { activity: { kind: "idle" as const } } : {}),
    },
  );
  if (control.kind === "failed") return { control, location, paseoHealth: "unknown" };
  const health = await controlPlane.health(location.worker);
  const paseoHealth = paseoHealthOf(health);
  if (health === "healthy") return { control, location, paseoHealth };
  return {
    control: {
      ...identity,
      kind: "failed",
      summary: `Paseo health verification was ${health}`,
      nextAction: `Check \`systemctl status paseo.service\` on ${worker.hostname}, then rerun \`fffactory apply\``,
    },
    location,
    paseoHealth,
  };
}

/**
 * The dispatch inputs for one worker the workers stage did not defer, from the earlier stages'
 * outcomes and factory.json: the workers stage's skip, carried as it is; the tailnet's reason
 * when it no longer locates an installed worker; otherwise its gate inputs and address.
 */
function dispatchInputFor(
  worker: WorkerOutcome,
  host: Host,
  repo: RepositoryOutcome | undefined,
  cp: WorkerControlPlane,
): DispatchWorker {
  const identity: WorkerIdentity = { key: worker.key, hostname: worker.hostname };
  if (worker.kind === "skipped")
    return { worker: identity, skip: { reason: "worker_skipped", ...outcomeWords(worker) } };
  // A failed rollout returns before the phase-3 stages, so only installed workers remain.
  if (worker.kind !== "installed")
    throw new Error(`worker ${worker.key} reached the dispatch stage after a failed rollout`);
  if (cp.location.kind !== "found")
    return {
      worker: identity,
      skip: { reason: "unreachable", ...outcomeWords(skipped(identity, cp.location.verdict)) },
    };
  return {
    worker: identity,
    address: cp.location.worker,
    settings: host.dispatch,
    releaseHealthy: true,
    githubCredential: githubCredential(worker.verification),
    repositorySync: repo?.kind === "synchronized" ? "ready" : "pending",
    paseoHealth: cp.paseoHealth,
  };
}

/** A skip's own words: its summary and next action. */
function outcomeWords(outcome: { readonly summary: string; readonly nextAction: string }) {
  return { summary: outcome.summary, nextAction: outcome.nextAction };
}

/**
 * Apply's phase-3 stages under the lock, after the workers stage: the repository stage, then for
 * each worker the control-plane stage and its Paseo health, then the dispatch stage over the gate
 * inputs the earlier stages produced, and finally the end-to-end verification. Each stage keeps
 * the skip-not-stopping discipline; an interrupt between stages ends them at once.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stage ordering and interrupt checks remain explicit
async function postWorkersStages(
  deps: FactoryApplyDependencies,
  controlPlane: ControlPlane,
  workflowQueue: WorkflowQueue | undefined,
  request: FactoryApplyRequest,
  about: {
    readonly factoryId: FactoryId;
    readonly tag: string;
    readonly workers: readonly WorkerOutcome[];
    readonly repositories: readonly RepositoryOutcome[];
    readonly controlPlanePlan: readonly PlannedControlPlane[];
    readonly deferredControl: readonly ControlPlaneOutcome[];
    readonly onControlPlane: (outcomes: readonly ControlPlaneOutcome[]) => Promise<void>;
    readonly beforeDispatch: () => Promise<void>;
    readonly onDispatch: (outcomes: readonly DispatchOutcome[]) => Promise<void>;
    readonly beforeVerification: () => Promise<void>;
  },
): Promise<PostWorkers | { readonly interrupted: true }> {
  const { tag, workers, repositories, controlPlanePlan, deferredControl } = about;
  const hosts = request.instance.hosts ?? [];

  const view = await deps.peers.view();
  if (deps.interrupted()) return { interrupted: true };
  const hostByKey = new Map(hosts.map((host) => [host.key, host]));
  const repoByKey = new Map(repositories.map((outcome) => [outcome.key, outcome]));
  const controlOutcomes: ControlPlaneOutcome[] = [...deferredControl];
  const dispatchWorkers: DispatchWorker[] = [];
  for (const worker of workers) {
    const host = hostByKey.get(worker.key);
    // The workers stage projected exactly factory.json's hosts, so each worker has its host.
    if (host === undefined)
      throw new Error(`worker ${worker.key} is not one of factory.json's hosts`);
    // A deferred worker bypasses the control-plane stage, its outcome already the deferral, and
    // dispatch sends it nothing, naming the deferral even if the workers stage skipped it for
    // another reason first. Any other skipped worker the tailnet locates is still reconciled.
    // TODO(re-evaluate when a worker the workers stage skipped for a reason other than deferral
    // fails an apply in the control-plane stage): skip the control-plane stage for every
    // workers-stage skip, as dispatch does, not only a deferral.
    if (deferredControl.some((item) => item.key === worker.key)) {
      if (workflowQueue !== undefined)
        dispatchWorkers.push({
          worker: { key: worker.key, hostname: worker.hostname },
          skip: { reason: "deferred", ...preActivationDeferral(worker.hostname) },
        });
      continue;
    }
    const cp = await reconcileWorkerControlPlane(
      controlPlane,
      view,
      tag,
      worker,
      about.factoryId,
      request.release,
      host,
      controlPlanePlan.find((item) => item.key === worker.key)?.changes ?? [],
      controlPlanePlan.find((item) => item.key === worker.key)?.observation,
    );
    if (deps.interrupted()) return { interrupted: true };
    if (cp.control !== undefined) controlOutcomes.push(cp.control);
    if (workflowQueue !== undefined)
      dispatchWorkers.push(dispatchInputFor(worker, host, repoByKey.get(worker.key), cp));
  }
  await about.onControlPlane(controlOutcomes);
  if (workflowQueue === undefined) return { repositories, controlPlane: controlOutcomes };
  await about.beforeDispatch();
  const dispatch = await applyDispatch({ workflowQueue }, { workers: dispatchWorkers });
  if (deps.interrupted()) return { interrupted: true };
  await about.onDispatch(dispatch.outcomes);
  await about.beforeVerification();
  const verification = verifyFactory({
    workers,
    repositories,
    controlPlane: controlOutcomes,
    dispatch: dispatch.outcomes,
  });
  return {
    repositories,
    controlPlane: controlOutcomes,
    dispatch: dispatch.outcomes,
    verification,
  };
}

/** The infrastructure stage under the lock: its changes, then their approval and application. */
async function infrastructureStage(
  deps: FactoryApplyDependencies,
  request: FactoryApplyRequest,
  locked: LockedApply,
  tracking: Tracking,
): Promise<FactoryApply> {
  const { log } = tracking;
  await log.start();
  if (deps.interrupted()) return interruptedUnder(log);
  const ready = await infrastructureChanges(
    deps,
    request.instance,
    request.terraformDirectory,
    locked,
  );
  if (deps.interrupted()) return interruptedUnder(log);
  if (ready.kind !== "ready") {
    await log.finish("refused", "refused");
    return ready;
  }
  // A complete factory.json declares a worker, so every plan has the workers stage's changes.
  const workers = declaredWorkers(request.instance, locked.target.factoryId);
  const controlPlane =
    locked.saved?.control_plane ??
    (await planControlPlane(
      deps,
      locked.target,
      requireTag(request.instance),
      request.instance.hosts ?? [],
      request.assetsSha256,
      new Set(createdWorkers(ready.changes, workers)),
    ));
  const dispatch =
    locked.saved?.dispatch ?? plannedDispatch(request.instance, locked.target.factoryId);
  const plan = [
    ...(request.pinMove?.preview ?? []),
    ...describePlan(
      locked.target,
      ready.changes,
      workers,
      request.instance,
      controlPlane,
      dispatch,
    ),
  ];
  return approveAndApply(deps, request, locked, tracking, {
    plan,
    changes: ready.changes,
    workers,
    controlPlane,
    dispatch,
  });
}

/** Every step of the operation that runs under the lock, which it settles at the end. */
async function underLock(
  deps: FactoryApplyDependencies,
  request: FactoryApplyRequest,
  locked: LockedApply,
): Promise<FactoryApply> {
  const log = operationLog(deps, locked, request);
  const progress: Progress = { step: "planning" };
  try {
    return await infrastructureStage(deps, request, locked, { log, progress });
  } catch (error) {
    if (deps.interrupted()) return interruptedUnder(log);
    // TODO(re-evaluate when an apply ends with Terraform's state lock left behind): a Terraform
    // killed at its deadline's grace period can leave its S3 state lock held, which fails later
    // plans; offer a guided unlock instead of leaving it to Terraform's error.
    const reason = reasonOf(error);
    // The failure, and what Terraform may have changed, are reported even when its record is not.
    const recordFailure = await log
      .finish("failed", "failed", reason, STAGE_OF[progress.step])
      .then(() => undefined, reasonOf);
    return {
      kind: "failed",
      step: progress.step,
      reason,
      diagnosticsFile: diagnosticsFileOf(error),
      operation: log.location,
      recordFailure,
    };
  } finally {
    await settle(deps, locked);
  }
}

/**
 * Takes the lock, bootstrapping the backend first when allowed, then runs under it. Neither a
 * saved plan, made against an existing bucket, nor an upgrade, whose approval is its pin
 * move's and plan's, ever bootstraps.
 */
async function lockAndApply(
  deps: FactoryApplyDependencies,
  request: FactoryApplyRequest,
  prepared: Omit<LockedApply, "lock" | "bootstrapped"> & { readonly planId: string },
): Promise<FactoryApply> {
  const { files, saved, planId } = prepared;
  const start = await beginFactoryOperation(deps, {
    ...request,
    planFile: files.backend,
    operation: request.operation ?? "apply",
    mayBootstrap: saved === undefined && request.pinMove === undefined,
  });
  switch (start.kind) {
    case "acquired":
      if (deps.interrupted()) return { kind: "interrupted", locked: true, record: undefined };
      return underLock(deps, request, {
        ...prepared,
        lock: start.lock,
        bootstrapped: start.bootstrapped,
      });
    case "missing":
      if (request.pinMove !== undefined) return { kind: "no_state_bucket" };
      return { kind: "stale", planId, reasons: ["the state bucket no longer exists"] };
    case "declined":
      return { kind: "declined", stage: "backend" };
    case "interrupted":
      return { kind: "interrupted", locked: false };
    default:
      return start;
  }
}

/**
 * Applies the factory after the account check allowed the caller: the CLI/pin match guard
 * and factory.json's completeness first, then a named saved plan's local freshness, then
 * backend bootstrap if needed and the lock, then under the lock the infrastructure stage and
 * the workers stage.
 */
export async function applyFactory(
  deps: FactoryApplyDependencies,
  request: FactoryApplyRequest,
): Promise<FactoryApply> {
  const plannable = checkPlannable(request);
  if (!plannable.ok) return plannable.refusal;
  const { bucket, target } = plannable;
  const now = request.clock();
  await deps.planStore.prune(bucket.factoryId, now);
  const choice = await savedPlan(deps, request, target, now);
  if (choice.kind !== "none" && choice.kind !== "found") return choice;
  const saved = choice.kind === "found" ? choice : undefined;
  const planId = saved?.plan.plan_id ?? newPlanId(request.randomBytes);
  const files = saved?.files ?? (await deps.planStore.create(bucket.factoryId, planId));
  try {
    return await lockAndApply(deps, request, {
      target,
      files,
      saved: saved?.plan,
      savedDigest: saved?.digest,
      planId,
    });
  } finally {
    if (saved === undefined) await deps.planStore.remove(bucket.factoryId, planId);
  }
}
