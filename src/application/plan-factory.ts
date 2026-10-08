/**
 * `fffactory plan`: the factory's complete plan from factory.json and live state: the
 * infrastructure stage, the factory root module's Terraform plan, then the workers and
 * control-plane stages. A complete factory.json declares a worker,
 * so every plan has changes, and is saved under a short-lived plan ID, bound to factory.json's
 * exact text, the release and its assets, the AWS account and the revision of the factory's
 * Terraform state, so `fffactory apply --plan-id` can apply exactly it. Planning changes
 * nothing: it takes no lock, inspects existing workers read-only for their Paseo state, and
 * refuses while another operation holds it.
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
import {
  changesSomething,
  type D11Refusal,
  declaredWorkers,
  createdWorkers,
  describePlan,
  hostKeyRemovalRefusal,
  hostMachineRefusal,
  newPlanId,
  newSavedPlan,
  type PlanCircumstances,
  type PlanTarget,
  pinRefusal,
  plannedDispatch,
  type ResourceChange,
  resourceChanges,
  type SavedPlan,
} from "../domain/plan";
import { checkStableHostKeys, recordedHostKeys } from "../domain/stable-host-keys";
import { planBackendBootstrap, stateBucketState } from "./bootstrap-backend";
import { stateBucketOf } from "./factory-lock";
import type { LockStore, StateBucket } from "./lock-store";
import type { PlanStore } from "./plan-store";
import { projectBackendVariables, projectFactoryVariables } from "./project-terraform-inputs";
import type { Provisioner, ProvisioningTarget } from "./provisioner";
import type { AllowedAccount } from "./require-expected-account";
import { planControlPlane, type ControlPlanePlanDependencies } from "./plan-control-plane";

/** The root module, in the release's Terraform tree, that defines the factory. */
export const FACTORY_ROOT = "factory";

export interface FactoryPlanDependencies extends ControlPlanePlanDependencies {
  readonly lockStore: LockStore;
  readonly provisioner: Provisioner;
  readonly planStore: PlanStore;
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
  /** The state bucket exists without every setting backend bootstrap applies. */
  | { readonly kind: "unready"; readonly refusal: readonly string[] }
  /** Terraform's plan or outputs could not be read, or a bootstrap plan did more than create. */
  | { readonly kind: "unexpected_plan"; readonly unexpected: readonly string[] }
  | { readonly kind: "locked"; readonly held: HeldLock | undefined };

export type FactoryPlanning =
  | PlanRefusal
  /**
   * The state bucket does not exist yet: `plan` is backend bootstrap's plan. The factory is
   * planned by `fffactory apply` once the bucket exists, under the lock.
   */
  | { readonly kind: "bootstrap_first"; readonly plan: readonly string[] }
  /** `plan` is what an operator reviews, saved as `saved`. */
  | {
      readonly kind: "planned";
      readonly plan: readonly string[];
      readonly saved: SavedPlan;
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
}

export type InfrastructurePlan =
  | Extract<PlanRefusal, { readonly kind: "refused" | "d11" | "unexpected_plan" }>
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
 * and refuses a plan that does more to a host machine than create or update it (D11).
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
    return {
      kind: "unexpected_plan",
      unexpected: ["the factory's Terraform state records host keys that cannot be read"],
    };
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
  const changes = resourceChanges(await provisioner.showPlan(saved));
  if (changes === undefined)
    return { kind: "unexpected_plan", unexpected: ["Terraform's plan could not be read"] };
  const lost = hostMachineRefusal(changes);
  if (lost !== undefined) return { kind: "d11", refusal: lost };
  return { kind: "planned", changes: changes.filter(changesSomething), stateRevision };
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

async function planBootstrap(
  provisioner: Provisioner,
  request: FactoryPlanRequest,
  bucket: StateBucket,
  planFile: string,
): Promise<FactoryPlanning> {
  const projection = projectBackendVariables(request.instance);
  if (!projection.ok) return { kind: "refused", issues: projection.issues };
  const planning = await planBackendBootstrap(provisioner, {
    ...request,
    bucket,
    variables: projection.variables,
    planFile,
  });
  if (planning.kind !== "planned") return planning;
  return { kind: "bootstrap_first", plan: planning.plan };
}

/**
 * Plans the factory, after the account check allowed the caller. Changes nothing: a missing
 * state bucket is shown as backend bootstrap's plan, and a held lock refuses planning.
 */
export async function planFactory(
  deps: FactoryPlanDependencies,
  request: FactoryPlanRequest,
): Promise<FactoryPlanning> {
  const plannable = checkPlannable(request);
  if (!plannable.ok) return plannable.refusal;
  const { bucket, target } = plannable;
  await deps.planStore.prune(bucket.factoryId, request.now);
  const state = await stateBucketState(deps.lockStore, bucket);
  if (state.kind === "unready") return state;
  const planId = newPlanId(request.randomBytes);
  const files = await deps.planStore.create(bucket.factoryId, planId);
  let saved: SavedPlan | undefined;
  try {
    if (state.kind === "missing")
      return await planBootstrap(deps.provisioner, request, bucket, files.backend);
    const held = await deps.lockStore.read(bucket);
    if (held !== undefined) return { kind: "locked", held };
    const infrastructure = await planInfrastructure(deps, {
      ...request,
      bucket,
      planFile: files.factory,
      underFactoryLock: false,
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
    );
    const dispatch = plannedDispatch(request.instance, target.factoryId);
    const plan = describePlan(
      target,
      infrastructure.changes,
      declaredWorkers(request.instance, target.factoryId),
      request.instance,
      controlPlane,
      dispatch,
    );
    const record = newSavedPlan({
      ...circumstances(request, target),
      planId,
      stateRevision: infrastructure.stateRevision,
      changes: infrastructure.changes,
      controlPlane,
      dispatch,
    });
    await deps.planStore.save(record);
    saved = record;
    return { kind: "planned", plan, saved };
  } finally {
    if (saved === undefined) await deps.planStore.remove(bucket.factoryId, planId);
  }
}
