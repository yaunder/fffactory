/**
 * `fffactory plan`: the factory's complete plan from factory.json and live state: the
 * infrastructure stage, the factory root module's Terraform plan, then the workers and
 * control-plane stages. Every plan, even one of a factory that declares no worker and has
 * nothing to change, is saved under a short-lived plan ID, bound to factory.json's
 * exact text, the release and its assets, the AWS account and the revision of the factory's
 * Terraform state, so `fffactory apply --plan-id` can apply exactly it. Before the state
 * bucket exists, the plan is backend bootstrap's, saved as a bootstrap plan bound to the
 * same circumstances but the bucket's absence in place of the state revision. Planning changes
 * nothing: it takes no lock, inspects existing workers read-only for their Paseo state, and
 * refuses while another operation holds it. The EC2 inventory says which workers are stopped:
 * the plan skips them, and refuses to change the instance type of one stopped or stopping,
 * which would start it, or of any worker while the inventory cannot be read.
 */
import type { CredentialSelection } from "../domain/aws-account";
import type { HeldLock } from "../domain/factory-lock";
import type { RandomBytes } from "../domain/initialization";
import {
  assessCompleteness,
  type FactoryInstance,
  type Issue,
  type Release,
} from "../domain/instance";
import { poweredDownWorkers, stoppedWorkers } from "../domain/status";
import type { UnreadyBucket } from "../domain/backend-bootstrap";
import {
  type BootstrapPlanReview,
  changesSomething,
  type D11Refusal,
  declaredWorkers,
  createdWorkers,
  type FactoryPlanReview,
  factoryPlanReview,
  hostKeyRemovalRefusal,
  hostMachineRefusal,
  newPlanId,
  newSavedBootstrapPlan,
  newSavedPlan,
  type PlanCircumstances,
  type PlannedWorker,
  type PlanTarget,
  pinRefusal,
  plannedDispatch,
  type ResizeGuard,
  resizeRefusal,
  type ResourceChange,
  resourceChanges,
  type SavedBootstrapPlan,
  type SavedFactoryPlan,
  type UnexpectedPlan,
} from "../domain/plan";
import { checkStableHostKeys, recordedHostKeys } from "../domain/stable-host-keys";
import { planBackendBootstrap, stateBucketState } from "./bootstrap-backend";
import { stateBucketOf } from "./factory-lock";
import type { LockStore, StateBucket } from "./lock-store";
import type { PlanFiles, PlanStore } from "./plan-store";
import { projectBackendVariables, projectFactoryVariables } from "./project-terraform-inputs";
import type { Provisioner, ProvisioningTarget } from "./provisioner";
import type { AllowedAccount } from "./require-expected-account";
import { planControlPlane, type ControlPlanePlanDependencies } from "./plan-control-plane";
import type { MachineInventorySource } from "./machine-inventory";

/** The root module, in the release's Terraform tree, that defines the factory. */
export const FACTORY_ROOT = "factory";

export interface FactoryPlanDependencies extends ControlPlanePlanDependencies {
  readonly lockStore: LockStore;
  readonly provisioner: Provisioner;
  readonly planStore: PlanStore;
  /** The factory's EC2 instances, read for the workers whose machine is stopped. */
  readonly machines: MachineInventorySource;
}

/** Everything a factory plan is made from, and bound to. */
export interface FactoryPlanRequest {
  /** Proof that the account check allowed the caller. */
  readonly account: AllowedAccount;
  /** The resolved factory.json path, shown with the plan. */
  readonly instancePath: string;
  readonly instance: FactoryInstance;
  /** SHA-256 of factory.json's exact text, as `instance` was read from it. */
  readonly configurationSha256: string;
  readonly credentials: CredentialSelection;
  /** The running fffactory's release. */
  readonly release: Release;
  /** SHA-256 of the release assets `terraformDirectory` was materialized from. */
  readonly assetsSha256: string;
  /** The materialized release assets' Terraform tree. */
  readonly terraformDirectory: string;
  readonly now: Date;
  readonly randomBytes: RandomBytes;
}

/** Why planning, or applying, refused before changing anything. */
export type PlanRefusal =
  /** factory.json cannot be planned: incomplete, or for another account. */
  | { readonly kind: "refused"; readonly issues: readonly Issue[] }
  /** The CLI/pin match guard: this fffactory is not the release factory.json pins. */
  | { readonly kind: "release_mismatch"; readonly message: string }
  | { readonly kind: "d11"; readonly refusal: D11Refusal }
  /**
   * The plan changes the instance type of these workers, stopped or stopping, which would
   * start them, or that the EC2 inventory could not be read to check are not stopped.
   */
  | ({ readonly kind: "stopped_resize" } & ResizeGuard)
  /** The state bucket exists without every setting backend bootstrap applies. */
  | { readonly kind: "unready"; readonly bucket: UnreadyBucket }
  /** Terraform's plan or outputs could not be read, or a bootstrap plan did more than create. */
  | { readonly kind: "unexpected_plan"; readonly unexpected: readonly UnexpectedPlan[] }
  | { readonly kind: "locked"; readonly held: HeldLock | undefined };

export type FactoryPlanning =
  | PlanRefusal
  /**
   * The state bucket does not exist yet: `review` is backend bootstrap's plan, saved as the
   * bootstrap plan `saved`. The factory is planned once the bucket exists.
   */
  | {
      readonly kind: "bootstrap_planned";
      readonly review: BootstrapPlanReview;
      readonly saved: SavedBootstrapPlan;
    }
  /** `review` is what an operator reviews, saved as `saved`. */
  | {
      readonly kind: "planned";
      readonly review: FactoryPlanReview;
      readonly saved: SavedFactoryPlan;
    };

const OTHER_ACCOUNT: Issue = {
  path: "aws.account_id",
  message: "is not the account the account check allowed",
};

export type Plannable =
  | { readonly ok: true; readonly bucket: StateBucket; readonly target: PlanTarget }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/**
 * What every plan and apply checks before reaching AWS: the CLI/pin match guard, a complete
 * factory.json, and an allowed caller in its account.
 */
export function checkPlannable(
  request: Omit<FactoryPlanRequest, "now" | "randomBytes">,
): Plannable {
  const { instance } = request;
  const mismatch = pinRefusal(instance.release, request.release);
  if (mismatch !== undefined)
    return { ok: false, refusal: { kind: "release_mismatch", message: mismatch } };
  const { missing } = assessCompleteness(instance);
  if (missing.length > 0)
    return {
      ok: false,
      refusal: {
        kind: "refused",
        issues: missing.map((path) => ({ path, message: "is required to plan" })),
      },
    };
  const resolution = stateBucketOf(instance, request.credentials);
  if (!resolution.ok) return { ok: false, refusal: { kind: "refused", issues: resolution.issues } };
  const { bucket } = resolution;
  if (request.account.verdict.caller.account !== bucket.accountId)
    return { ok: false, refusal: { kind: "refused", issues: [OTHER_ACCOUNT] } };
  const target: PlanTarget = {
    instancePath: request.instancePath,
    name: instance.name,
    factoryId: bucket.factoryId,
    accountId: bucket.accountId,
    region: bucket.region,
    release: request.release,
  };
  return { ok: true, bucket, target };
}

/** The factory root module, with its state in the state bucket. */
export function factoryTarget(bucket: StateBucket, terraformDirectory: string): ProvisioningTarget {
  return {
    configuration: { directory: terraformDirectory, root: FACTORY_ROOT },
    credentials: bucket.credentials,
    region: bucket.region,
    backend: { bucket: bucket.bucket },
  };
}

export interface InfrastructurePlanRequest {
  readonly instance: FactoryInstance;
  readonly bucket: StateBucket;
  readonly terraformDirectory: string;
  /** Absolute path, owned by the caller, for the factory's saved Terraform plan. */
  readonly planFile: string;
  /**
   * Whether the plan is made under the factory-wide lock. Only then does Terraform take its
   * own state lock: `plan` takes none, so a killed plan leaves no lock behind.
   */
  readonly underFactoryLock: boolean;
  /** The workers whose instance type may not change now. */
  readonly resizeGuard: ResizeGuard;
}

export type InfrastructurePlan =
  | Extract<
      PlanRefusal,
      { readonly kind: "refused" | "d11" | "stopped_resize" | "unexpected_plan" }
    >
  | {
      readonly kind: "planned";
      readonly changes: readonly ResourceChange[];
      /** The state revision read before planning; undefined when there was no state yet. */
      readonly stateRevision: string | undefined;
    };

/**
 * The infrastructure stage's plan: reads the state's revision first, so any later write is
 * seen, then the host keys the state records (`Provisioner.output`; none before the first
 * apply), refuses removing one (D11), plans the factory root with factory.json's projection,
 * and refuses a plan that does more to a host machine than create or update it (D11), or that
 * changes the instance type of a worker `resizeGuard` guards.
 */
export async function planInfrastructure(
  { lockStore, provisioner }: Pick<FactoryPlanDependencies, "lockStore" | "provisioner">,
  request: InfrastructurePlanRequest,
): Promise<InfrastructurePlan> {
  const { instance, bucket } = request;
  const stateRevision = await lockStore.stateRevision(bucket);
  const target = factoryTarget(bucket, request.terraformDirectory);
  const recorded = recordedHostKeys(await provisioner.output(target));
  if (recorded === undefined)
    return { kind: "unexpected_plan", unexpected: [{ kind: "unreadable_host_keys" }] };
  const removal = hostKeyRemovalRefusal(checkStableHostKeys(recorded, instance));
  if (removal !== undefined) return { kind: "d11", refusal: removal };
  const projection = projectFactoryVariables(instance, recorded);
  if (!projection.ok) return { kind: "refused", issues: projection.issues };
  const saved = { ...target, planFile: request.planFile };
  await provisioner.plan({
    ...saved,
    variables: { ...projection.variables },
    stateLock: request.underFactoryLock,
  });
  const shown = await provisioner.showPlan(saved);
  const changes = resourceChanges(shown);
  if (changes === undefined)
    return { kind: "unexpected_plan", unexpected: [{ kind: "unreadable_plan" }] };
  const lost = hostMachineRefusal(changes);
  if (lost !== undefined) return { kind: "d11", refusal: lost };
  const resized = resizeRefusal(shown, request.resizeGuard);
  if (resized !== undefined) return { kind: "stopped_resize", ...resized };
  return { kind: "planned", changes: changes.filter(changesSomething), stateRevision };
}

/** What one read of the EC2 inventory says of the declared workers' machines. */
export interface DeclaredMachines {
  /**
   * The declared workers whose one machine is stopped, or undefined when the inventory cannot
   * be listed: then no worker is planned as stopped, and the tailnet judges every one, as
   * before.
   */
  readonly stopped: PlannedWorker[] | undefined;
  /**
   * The workers whose instance type may not change: those stopped or stopping, or every
   * declared one when the inventory cannot be listed, failing closed.
   */
  readonly resizeGuard: ResizeGuard;
}

export async function declaredMachines(
  machines: MachineInventorySource,
  request: Pick<FactoryPlanRequest, "instance" | "credentials">,
  target: PlanTarget,
): Promise<DeclaredMachines> {
  const workers = declaredWorkers(request.instance, target.factoryId);
  const inventory = await machines.list(request.credentials, target.region, target.factoryId);
  if (inventory.kind === "unavailable")
    return { stopped: undefined, resizeGuard: { inventory: "unreadable", workers } };
  const keys = workers.map(({ key }) => key);
  const stopped = stoppedWorkers(inventory, keys);
  const down = poweredDownWorkers(inventory, keys);
  return {
    stopped: workers.filter(({ key }) => stopped.includes(key)),
    resizeGuard: {
      inventory: "read",
      workers: workers.flatMap((worker) =>
        down.filter(({ key }) => key === worker.key).map(({ machine }) => ({ ...worker, machine })),
      ),
    },
  };
}

/** The circumstances a plan is bound to. */
export function circumstances(
  request: Omit<FactoryPlanRequest, "randomBytes">,
  target: PlanTarget,
): PlanCircumstances {
  return {
    factoryId: target.factoryId,
    instancePath: request.instancePath,
    configurationSha256: request.configurationSha256,
    release: request.release,
    assetsSha256: request.assetsSha256,
    accountId: target.accountId,
    now: request.now,
  };
}

/** A new plan's ID and the files of its plan directory, which a saved plan keeps. */
interface PlanDirectory {
  readonly planId: string;
  readonly files: PlanFiles;
}

/**
 * Backend bootstrap's plan, into the plan directory's `backend.tfplan`, saved there as a
 * bootstrap plan.
 */
async function planAndSaveBootstrap(
  { provisioner, planStore }: Pick<FactoryPlanDependencies, "provisioner" | "planStore">,
  request: FactoryPlanRequest,
  { bucket, target }: { readonly bucket: StateBucket; readonly target: PlanTarget },
  { planId, files }: PlanDirectory,
): Promise<FactoryPlanning> {
  const projection = projectBackendVariables(request.instance);
  if (!projection.ok) return { kind: "refused", issues: projection.issues };
  const planning = await planBackendBootstrap(provisioner, {
    ...request,
    bucket,
    variables: projection.variables,
    planFile: files.backend,
  });
  if (planning.kind !== "planned") return planning;
  const saved = newSavedBootstrapPlan({
    ...circumstances(request, target),
    planId,
    changes: planning.changes,
  });
  await planStore.save(saved);
  return { kind: "bootstrap_planned", review: planning.review, saved };
}

/**
 * The factory's plan, its infrastructure into the plan directory's `factory.tfplan`, saved
 * there as a factory plan. A held lock refuses it.
 */
async function planAndSaveFactory(
  deps: FactoryPlanDependencies,
  request: FactoryPlanRequest,
  { bucket, target }: { readonly bucket: StateBucket; readonly target: PlanTarget },
  { planId, files }: PlanDirectory,
): Promise<FactoryPlanning> {
  const held = await deps.lockStore.read(bucket);
  if (held !== undefined) return { kind: "locked", held };
  const machines = await declaredMachines(deps.machines, request, target);
  const stopped = machines.stopped ?? [];
  const infrastructure = await planInfrastructure(deps, {
    ...request,
    bucket,
    planFile: files.factory,
    underFactoryLock: false,
    resizeGuard: machines.resizeGuard,
  });
  if (infrastructure.kind !== "planned") return infrastructure;
  const tag = request.instance.tailscale?.tag;
  if (tag === undefined) throw new Error("complete factory.json has no tailscale.tag");
  const controlPlane = await planControlPlane(
    deps,
    target,
    tag,
    request.instance.hosts ?? [],
    request.assetsSha256,
    new Set(
      createdWorkers(infrastructure.changes, declaredWorkers(request.instance, target.factoryId)),
    ),
    new Set(stopped.map(({ key }) => key)),
  );
  const dispatch = plannedDispatch(request.instance, target.factoryId);
  const stoppedKeys = stopped.map(({ key }) => key);
  const review = factoryPlanReview({
    target,
    changes: infrastructure.changes,
    instance: request.instance,
    controlPlane,
    dispatch,
    stopped: stoppedKeys,
  });
  const saved = newSavedPlan({
    ...circumstances(request, target),
    planId,
    stateRevision: infrastructure.stateRevision,
    changes: infrastructure.changes,
    controlPlane,
    dispatch,
    stopped: stoppedKeys,
  });
  await deps.planStore.save(saved);
  return { kind: "planned", review, saved };
}

/** Whether planning saved its plan, which keeps its plan directory. */
function savedAPlan(planning: FactoryPlanning | undefined): boolean {
  return planning?.kind === "planned" || planning?.kind === "bootstrap_planned";
}

/**
 * Plans the factory, after the account check allowed the caller. Changes nothing: a missing
 * state bucket is planned and saved as backend bootstrap's plan, and a held lock refuses
 * planning. A plan refused, or that fails, saves nothing and leaves no plan directory.
 */
export async function planFactory(
  deps: FactoryPlanDependencies,
  request: FactoryPlanRequest,
): Promise<FactoryPlanning> {
  const plannable = checkPlannable(request);
  if (!plannable.ok) return plannable.refusal;
  const { bucket } = plannable;
  await deps.planStore.prune(bucket.factoryId, request.now);
  const state = await stateBucketState(deps.lockStore, bucket);
  if (state.kind === "unready") return state;
  const planId = newPlanId(request.randomBytes);
  const directory = { planId, files: await deps.planStore.create(bucket.factoryId, planId) };
  let planning: FactoryPlanning | undefined;
  try {
    planning =
      state.kind === "missing"
        ? await planAndSaveBootstrap(deps, request, plannable, directory)
        : await planAndSaveFactory(deps, request, plannable, directory);
    return planning;
  } finally {
    if (!savedAPlan(planning)) await deps.planStore.remove(bucket.factoryId, planId);
  }
}
