/**
 * Backend bootstrap and the start of every mutating factory operation. The state bucket
 * holds the factory's Terraform state and the factory-wide lock, so it must exist before
 * either. On the first apply it does not: a small plan of the `backend` root module is shown
 * and applied only after its own approval, and then the newly created lock is acquired.
 * Every later operation finds the bucket and goes straight to the lock.
 */
import type { CredentialSelection } from "../domain/aws-account";
import {
  bootstrapPlanVerdict,
  describeBootstrapPlan,
  missingHardening,
  unreadyBucketRefusal,
} from "../domain/backend-bootstrap";
import { resourceChanges } from "../domain/plan";
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
   * bootstrap. `refusal` names what it lacks and how to complete it. Nothing is changed.
   */
  | { readonly kind: "unready"; readonly refusal: readonly string[] }
  /** The plan would do something other than create, or could not be read. Nothing applied. */
  | { readonly kind: "unexpected_plan"; readonly unexpected: readonly string[] }
  | { readonly kind: "declined" }
  | { readonly kind: "created"; readonly bucket: StateBucket }
  /** The bucket does not exist, and the request did not allow bootstrapping it. */
  | { readonly kind: "missing" };

const OTHER_ACCOUNT: Issue = {
  path: "aws.account_id",
  message: "is not the account the account check allowed",
};

function unexpected(...reasons: string[]): {
  readonly kind: "unexpected_plan";
  readonly unexpected: readonly string[];
} {
  return { kind: "unexpected_plan", unexpected: reasons };
}

export type StateBucketState =
  | { readonly kind: "missing" }
  | { readonly kind: "present" }
  /** It exists without every setting backend bootstrap applies: an interrupted bootstrap. */
  | { readonly kind: "unready"; readonly refusal: readonly string[] };

/**
 * Whether the state bucket exists, and if it does, whether it has every setting backend
 * bootstrap applies. HeadBucket alone cannot tell a finished bootstrap from an interrupted one.
 */
export async function stateBucketState(
  lockStore: LockStore,
  bucket: StateBucket,
): Promise<StateBucketState> {
  if (!(await lockStore.bucketExists(bucket))) return { kind: "missing" };
  const readiness = await lockStore.bucketReadiness(bucket);
  if (missingHardening(readiness).length === 0) return { kind: "present" };
  return { kind: "unready", refusal: unreadyBucketRefusal(bucket, readiness) };
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
  | { readonly kind: "unexpected_plan"; readonly unexpected: readonly string[] }
  /** The plan, saved at `saved.planFile`, and the lines an operator approves it from. */
  | {
      readonly kind: "planned";
      readonly plan: readonly string[];
      readonly saved: SavedPlanRequest;
    };

/**
 * Plans creating the state bucket with the backend root module, and reads the saved plan
 * back: it may only create. Applies nothing.
 */
export async function planBackendBootstrap(
  provisioner: Provisioner,
  request: BootstrapPlanRequest,
): Promise<BootstrapPlanning> {
  const { bucket } = request;
  const saved: SavedPlanRequest = {
    configuration: { directory: request.terraformDirectory, root: BACKEND_ROOT },
    credentials: bucket.credentials,
    region: bucket.region,
    backend: {},
    planFile: request.planFile,
  };
  await provisioner.plan({ ...saved, variables: { ...request.variables } });
  const changes = resourceChanges(await provisioner.showPlan(saved));
  if (changes === undefined) return unexpected("Terraform's plan could not be read");
  const verdict = bootstrapPlanVerdict(changes);
  if (!verdict.ok) return unexpected(...verdict.unexpected);
  if (verdict.creates.length === 0)
    return unexpected("the plan creates nothing, though the state bucket does not exist");
  const plan = describeBootstrapPlan(
    {
      instancePath: request.instancePath,
      name: request.instance.name,
      factoryId: bucket.factoryId,
      accountId: bucket.accountId,
      region: bucket.region,
      release: request.release,
      bucket: bucket.bucket,
    },
    verdict.creates,
  );
  return { kind: "planned", plan, saved };
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
  if (!(await approval.approve(planning.plan))) return { kind: "declined" };
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
