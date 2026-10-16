/**
 * Backend bootstrap and the start of every mutating factory operation. The state bucket
 * holds the factory's Terraform state and the factory-wide lock, so it must exist before
 * either. On the first apply it does not: a small plan of the `backend` root module is shown
 * and applied only after its own approval, and then the newly created lock is acquired.
 * Every later operation finds the bucket and goes straight to the lock.
 *
 * A saved bootstrap plan is the unattended alternative (`applySavedBootstrap`): naming its ID
 * approves exactly its `backend.tfplan`, applied only while the plan is fresh, the bucket is
 * still missing and the file is the one saved; then the newly created lock is acquired.
 */
import type { CredentialSelection } from "../domain/aws-account";
import {
  bootstrapPlanVerdict,
  type UnreadyBucket,
  unreadyBucket,
} from "../domain/backend-bootstrap";
import {
  bootstrapStaleness,
  type BootstrapPlanReview,
  changesSomething,
  type PlanCircumstances,
  type ResourceChange,
  resourceChanges,
  sameChanges,
  type SavedBootstrapPlan,
  type StaleReason,
  type UnexpectedPlan,
} from "../domain/plan";
import type { HeldLock } from "../domain/factory-lock";
import type { RandomBytes } from "../domain/initialization";
import type { FactoryInstance, Issue, Release } from "../domain/instance";
import type { Approval } from "./approval";
import {
  acquireFactoryLock,
  type FactoryLock,
  type Interrupted,
  lockHolder,
  stateBucketOf,
} from "./factory-lock";
import type { LockStore, StateBucket } from "./lock-store";
import type { PlanFiles, PlanStore } from "./plan-store";
import { type BackendVariables, projectBackendVariables } from "./project-terraform-inputs";
import type { Provisioner, SavedPlanRequest } from "./provisioner";
import type { AllowedAccount } from "./require-expected-account";

/** The root module, in the release's Terraform tree, that defines the state bucket. */
export const BACKEND_ROOT = "backend";

export interface BackendBootstrapDependencies {
  readonly lockStore: LockStore;
  readonly provisioner: Provisioner;
  readonly approval: Approval;
  /** Whether fffactory was interrupted; an interrupted operation takes no lock. */
  readonly interrupted?: Interrupted;
}

export interface BackendBootstrapRequest {
  /** Proof that the account check allowed the caller, in the instance's account. */
  readonly account: AllowedAccount;
  /** The resolved factory.json path, shown with the plan. */
  readonly instancePath: string;
  readonly instance: FactoryInstance;
  readonly credentials: CredentialSelection;
  readonly release: Release;
  /** The materialized release assets' Terraform tree. */
  readonly terraformDirectory: string;
  /** Absolute path, owned by the caller, for the bootstrap's saved plan. */
  readonly planFile: string;
  /**
   * Whether a missing state bucket may be bootstrapped; true when omitted. A saved factory
   * plan was made against an existing bucket, so applying one never bootstraps.
   */
  readonly mayBootstrap?: boolean;
}

export type BackendBootstrap =
  | { readonly kind: "refused"; readonly issues: readonly Issue[] }
  | { readonly kind: "present"; readonly bucket: StateBucket }
  /**
   * The bucket exists without every setting backend bootstrap applies: an interrupted
   * bootstrap. `bucket` is where it is and what it lacks. Nothing is changed.
   */
  | { readonly kind: "unready"; readonly bucket: UnreadyBucket }
  /** The plan would do something other than create, or could not be read. Nothing applied. */
  | { readonly kind: "unexpected_plan"; readonly unexpected: readonly UnexpectedPlan[] }
  | { readonly kind: "declined" }
  | { readonly kind: "created"; readonly bucket: StateBucket }
  /** The bucket does not exist, and the request did not allow bootstrapping it. */
  | { readonly kind: "missing" };

const OTHER_ACCOUNT: Issue = {
  path: "aws.account_id",
  message: "is not the account the account check allowed",
};

function unexpected(...reasons: UnexpectedPlan[]): {
  readonly kind: "unexpected_plan";
  readonly unexpected: readonly UnexpectedPlan[];
} {
  return { kind: "unexpected_plan", unexpected: reasons };
}

export type StateBucketState =
  | { readonly kind: "missing" }
  | { readonly kind: "present" }
  /** It exists without every setting backend bootstrap applies: an interrupted bootstrap. */
  | { readonly kind: "unready"; readonly bucket: UnreadyBucket };

/**
 * Whether the state bucket exists, and if it does, whether it has every setting backend
 * bootstrap applies. HeadBucket alone cannot tell a finished bootstrap from an interrupted one.
 */
export async function stateBucketState(
  lockStore: LockStore,
  bucket: StateBucket,
): Promise<StateBucketState> {
  if (!(await lockStore.bucketExists(bucket))) return { kind: "missing" };
  const unready = unreadyBucket(bucket, await lockStore.bucketReadiness(bucket));
  return unready === undefined ? { kind: "present" } : { kind: "unready", bucket: unready };
}

export interface BootstrapPlanRequest {
  readonly instancePath: string;
  readonly instance: FactoryInstance;
  readonly bucket: StateBucket;
  readonly variables: BackendVariables;
  readonly release: Release;
  readonly terraformDirectory: string;
  readonly planFile: string;
}

export type BootstrapPlanning =
  /** The plan would do something other than create, or could not be read. */
  | { readonly kind: "unexpected_plan"; readonly unexpected: readonly UnexpectedPlan[] }
  /**
   * The plan, saved at `saved.planFile`, the review an operator approves it from, and what it
   * changes, each only a create.
   */
  | {
      readonly kind: "planned";
      readonly review: BootstrapPlanReview;
      readonly changes: readonly ResourceChange[];
      readonly saved: SavedPlanRequest;
    };

/** Backend bootstrap's saved Terraform plan file `planFile`, for the backend root. */
function backendPlanFile(
  bucket: StateBucket,
  terraformDirectory: string,
  planFile: string,
): SavedPlanRequest {
  return {
    configuration: { directory: terraformDirectory, root: BACKEND_ROOT },
    credentials: bucket.credentials,
    region: bucket.region,
    backend: {},
    planFile,
  };
}

type ReadBack =
  | { readonly kind: "unexpected_plan"; readonly unexpected: readonly UnexpectedPlan[] }
  | {
      readonly kind: "read";
      /** What the plan changes, each only a create. */
      readonly changes: readonly ResourceChange[];
      /** The review an operator approves it from. */
      readonly review: BootstrapPlanReview;
    };

/**
 * Reads a saved backend bootstrap plan back from its file: it may only create, and must
 * create something.
 */
async function readBackBootstrapPlan(
  provisioner: Provisioner,
  saved: SavedPlanRequest,
  request: Pick<BootstrapPlanRequest, "instancePath" | "instance" | "bucket" | "release">,
): Promise<ReadBack> {
  const { bucket } = request;
  const changes = resourceChanges(await provisioner.showPlan(saved));
  if (changes === undefined) return unexpected({ kind: "unreadable_plan" });
  const verdict = bootstrapPlanVerdict(changes);
  if (!verdict.ok)
    return unexpected(
      ...verdict.unexpected.map((change) => ({ kind: "not_create", change }) as const),
    );
  if (verdict.creates.length === 0) return unexpected({ kind: "creates_nothing" });
  const review: BootstrapPlanReview = {
    kind: "backend_bootstrap",
    target: {
      instancePath: request.instancePath,
      name: request.instance.name,
      factoryId: bucket.factoryId,
      accountId: bucket.accountId,
      region: bucket.region,
      release: request.release,
      bucket: bucket.bucket,
    },
    creates: verdict.creates,
  };
  return { kind: "read", changes: changes.filter(changesSomething), review };
}

/**
 * Plans creating the state bucket with the backend root module, and reads the saved plan
 * back: it may only create. Applies nothing.
 */
export async function planBackendBootstrap(
  provisioner: Provisioner,
  request: BootstrapPlanRequest,
): Promise<BootstrapPlanning> {
  const saved = backendPlanFile(request.bucket, request.terraformDirectory, request.planFile);
  await provisioner.plan({ ...saved, variables: { ...request.variables } });
  const read = await readBackBootstrapPlan(provisioner, saved, request);
  if (read.kind !== "read") return read;
  return { kind: "planned", review: read.review, changes: read.changes, saved };
}

/**
 * Creates the state bucket when it does not exist, after the operator approves its plan.
 * An existing, finished bucket is left alone, so bootstrapping is safe to repeat; one an
 * interrupted bootstrap left without all its settings is refused. The backend root keeps no
 * state of its own: the bucket is created once and never destroyed. With `mayBootstrap`
 * false, a missing bucket is only reported.
 */
export async function bootstrapBackend(
  { lockStore, provisioner, approval }: BackendBootstrapDependencies,
  request: BackendBootstrapRequest,
): Promise<BackendBootstrap> {
  const { instance, account } = request;
  const resolution = stateBucketOf(instance, request.credentials);
  if (!resolution.ok) return { kind: "refused", issues: resolution.issues };
  const projection = projectBackendVariables(instance);
  if (!projection.ok) return { kind: "refused", issues: projection.issues };
  const { bucket } = resolution;
  if (account.verdict.caller.account !== bucket.accountId)
    return { kind: "refused", issues: [OTHER_ACCOUNT] };
  const state = await stateBucketState(lockStore, bucket);
  if (state.kind !== "missing")
    return state.kind === "present" ? { kind: "present", bucket } : state;
  if (request.mayBootstrap === false) return { kind: "missing" };

  const planning = await planBackendBootstrap(provisioner, {
    ...request,
    bucket,
    variables: projection.variables,
  });
  if (planning.kind !== "planned") return planning;
  if (!(await approval.approve(planning.review))) return { kind: "declined" };
  await provisioner.applyPlan(planning.saved);
  return { kind: "created", bucket };
}

export interface FactoryOperationRequest extends BackendBootstrapRequest {
  /** The operation that will hold the lock, such as `apply`. */
  readonly operation: string;
  /** This machine's name, recorded as the lock holder's host. */
  readonly host: string;
  /** The time the lock is taken at, read once bootstrap is done. */
  readonly clock: () => Date;
  readonly randomBytes: RandomBytes;
}

export type FactoryOperationStart =
  | Exclude<BackendBootstrap, { readonly kind: "present" | "created" }>
  | { readonly kind: "locked"; readonly held: HeldLock | undefined }
  /** fffactory was interrupted before the lock was taken: it takes none. */
  | { readonly kind: "interrupted" }
  | { readonly kind: "acquired"; readonly lock: FactoryLock; readonly bootstrapped: boolean };

/**
 * Starts a mutating factory operation after the account check allowed it: bootstraps the
 * backend when it is missing, then acquires the factory-wide lock, which the operation
 * holds through every later stage and releases with `releaseFactoryLock`. A held lock
 * refuses the operation and shows its holder.
 */
export async function beginFactoryOperation(
  deps: BackendBootstrapDependencies,
  request: FactoryOperationRequest,
): Promise<FactoryOperationStart> {
  const bootstrap = await bootstrapBackend(deps, request);
  if (bootstrap.kind !== "present" && bootstrap.kind !== "created") return bootstrap;
  if (deps.interrupted?.()) return { kind: "interrupted" };
  const acquisition = await acquireFactoryLock(deps.lockStore, {
    bucket: bootstrap.bucket,
    operation: request.operation,
    holder: lockHolder(request.account, request.host),
    release: request.release,
    now: request.clock(),
    randomBytes: request.randomBytes,
  });
  if (!acquisition.acquired) return { kind: "locked", held: acquisition.held };
  return {
    kind: "acquired",
    lock: acquisition.lock,
    bootstrapped: bootstrap.kind === "created",
  };
}

export interface SavedBootstrapDependencies extends BackendBootstrapDependencies {
  readonly planStore: PlanStore;
  readonly interrupted: Interrupted;
}

export interface SavedBootstrapRequest
  extends Omit<FactoryOperationRequest, "planFile" | "mayBootstrap"> {
  /** The saved bootstrap plan, loaded, whose ID naming approved it. */
  readonly saved: SavedBootstrapPlan;
  /** Its plan files; it binds `backend`. */
  readonly files: PlanFiles;
  /** The SHA-256 its `backend.tfplan` had when it was loaded. */
  readonly digest: string;
  /** The circumstances it is applied in, which its freshness is checked against. */
  readonly current: PlanCircumstances;
}

export type SavedBootstrapStart =
  | { readonly kind: "refused"; readonly issues: readonly Issue[] }
  /** It is no longer the plan to apply, the state bucket now existing among the reasons. */
  | { readonly kind: "stale"; readonly planId: string; readonly reasons: readonly StaleReason[] }
  /** Its `backend.tfplan` is not the file loaded, or makes other changes than its record. */
  | { readonly kind: "damaged_plan"; readonly planId: string }
  /** Its `backend.tfplan` would do more than create, creates nothing, or cannot be read. */
  | { readonly kind: "unexpected_plan"; readonly unexpected: readonly UnexpectedPlan[] }
  | { readonly kind: "declined" }
  /** fffactory was interrupted before the lock was taken: it takes none. */
  | { readonly kind: "interrupted" }
  /** The bucket was created, and another operation holds the lock. */
  | { readonly kind: "locked"; readonly held: HeldLock | undefined }
  | { readonly kind: "acquired"; readonly lock: FactoryLock };

/** A saved bootstrap plan's refusals, before anything is applied. */
type SavedBootstrapRefusal = Exclude<
  SavedBootstrapStart,
  { readonly kind: "interrupted" | "locked" | "acquired" }
>;

/**
 * Why the saved bootstrap plan may not be applied now: stale, the state bucket now existing
 * among the reasons, or damaged, its `backend.tfplan` no longer the file loaded. Undefined
 * while it may.
 */
async function savedBootstrapChanged(
  deps: SavedBootstrapDependencies,
  request: SavedBootstrapRequest,
  bucket: StateBucket,
): Promise<SavedBootstrapRefusal | undefined> {
  const { saved } = request;
  const state = await stateBucketState(deps.lockStore, bucket);
  const reasons = bootstrapStaleness(saved, request.current, state.kind !== "missing");
  if (reasons.length > 0) return { kind: "stale", planId: saved.plan_id, reasons };
  if ((await deps.planStore.digest(saved)) !== request.digest)
    return { kind: "damaged_plan", planId: saved.plan_id };
  return undefined;
}

/**
 * Everything checked before the saved bootstrap plan's file is applied: its freshness, the
 * bucket still missing and the file still the one loaded, then its read-back (its record's
 * changes, only creates) and its approval by ID, then the bucket and the file again, right
 * before the apply. Undefined when it may be applied.
 */
async function checkSavedBootstrap(
  deps: SavedBootstrapDependencies,
  request: SavedBootstrapRequest,
  bucket: StateBucket,
  file: SavedPlanRequest,
): Promise<SavedBootstrapRefusal | undefined> {
  const before = await savedBootstrapChanged(deps, request, bucket);
  if (before !== undefined) return before;
  const read = await readBackBootstrapPlan(deps.provisioner, file, { ...request, bucket });
  if (read.kind !== "read") return read;
  if (!sameChanges(read.changes, request.saved.changes))
    return { kind: "damaged_plan", planId: request.saved.plan_id };
  if (!(await deps.approval.approve(read.review))) return { kind: "declined" };
  return savedBootstrapChanged(deps, request, bucket);
}

/**
 * Applies exactly the saved bootstrap plan's file, and spends the plan once its apply starts,
 * whatever comes of it. False when fffactory was interrupted, before the apply or during it.
 */
async function applySpending(
  deps: SavedBootstrapDependencies,
  saved: SavedBootstrapPlan,
  file: SavedPlanRequest,
): Promise<boolean> {
  if (deps.interrupted()) return false;
  try {
    await deps.provisioner.applyPlan(file);
  } catch (error) {
    if (deps.interrupted()) return false;
    throw error;
  } finally {
    await deps.planStore.remove(saved.factory_id, saved.plan_id);
  }
  return !deps.interrupted();
}

/**
 * Applies exactly a saved bootstrap plan, which naming its ID approved, after the account
 * check allowed the caller, then acquires the newly created lock. Nothing is planned. The plan
 * must be fresh and the state bucket missing, checked before its `backend.tfplan` is read back
 * and again right before it is applied; the file must be the one loaded, checked before the
 * read-back and immediately before the apply, and its changes must be its record's and only
 * create. Otherwise nothing is applied. Once its Terraform apply starts, the plan is spent:
 * removed, whatever comes of it. A failed apply rejects, taking no lock.
 */
export async function applySavedBootstrap(
  deps: SavedBootstrapDependencies,
  request: SavedBootstrapRequest,
): Promise<SavedBootstrapStart> {
  const { account } = request;
  const resolution = stateBucketOf(request.instance, request.credentials);
  if (!resolution.ok) return { kind: "refused", issues: resolution.issues };
  const { bucket } = resolution;
  if (account.verdict.caller.account !== bucket.accountId)
    return { kind: "refused", issues: [OTHER_ACCOUNT] };
  const file = backendPlanFile(bucket, request.terraformDirectory, request.files.backend);
  const refusal = await checkSavedBootstrap(deps, request, bucket, file);
  if (refusal !== undefined) return refusal;
  if (!(await applySpending(deps, request.saved, file))) return { kind: "interrupted" };
  const acquisition = await acquireFactoryLock(deps.lockStore, {
    bucket,
    operation: request.operation,
    holder: lockHolder(account, request.host),
    release: request.release,
    now: request.clock(),
    randomBytes: request.randomBytes,
  });
  if (!acquisition.acquired) return { kind: "locked", held: acquisition.held };
  return { kind: "acquired", lock: acquisition.lock };
}
