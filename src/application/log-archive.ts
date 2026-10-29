/**
 * The log archive in the infrastructure stage (D5). For a factory.json enabling it, plan and
 * apply check whether the archive exists and is ready, with the same S3 checks as the state
 * bucket (D7). A missing one is planned with the state-less `archive` root, create-only, into
 * the plan's `archive.tfplan`, which apply applies once the plan is approved, under the factory
 * lock, before the factory root. A present, ready one plans nothing: an apply after teardown
 * adopts the archive teardown kept. One without every setting the archive root applies is
 * refused, as an unready state bucket is: the root keeps no state, so it cannot finish it.
 * fffactory writes nothing in the archive.
 */
import { createOnlyRefusal, type UnreadyBucket, unreadyArchive } from "../domain/backend-bootstrap";
import type { FactoryInstance, Issue } from "../domain/instance";
import { type PlannedArchive, resourceChanges, type UnexpectedPlan } from "../domain/plan";
import { archiveBucketName } from "../domain/resource-naming";
import type { ArchiveBucket, LockStore, StateBucket } from "./lock-store";
import { projectArchiveVariables } from "./project-terraform-inputs";
import type { Provisioner, SavedPlanRequest } from "./provisioner";

/** The root module, in the release's Terraform tree, that defines the log archive. */
export const ARCHIVE_ROOT = "archive";

/**
 * The factory's log archive, in the state bucket's account and Region, reached with its
 * credentials; undefined when factory.json does not enable it.
 */
export function archiveOf(
  instance: FactoryInstance,
  bucket: StateBucket,
): ArchiveBucket | undefined {
  const name = archiveBucketName(instance);
  if (name === undefined) return undefined;
  const { accountId, region, credentials } = bucket;
  return { kind: "archive", bucket: name, accountId, region, credentials };
}

export type ArchiveState =
  | { readonly kind: "missing" }
  | { readonly kind: "present" }
  /** It exists without every setting the archive root applies. */
  | { readonly kind: "unready"; readonly bucket: UnreadyBucket };

/**
 * Whether the log archive exists (HeadBucket, the factory's account its expected owner), and
 * if it does, whether it has every setting the archive root applies.
 */
export async function archiveState(
  lockStore: LockStore,
  archive: ArchiveBucket,
): Promise<ArchiveState> {
  if (!(await lockStore.bucketExists(archive))) return { kind: "missing" };
  const unready = unreadyArchive(archive, await lockStore.archiveReadiness(archive));
  return unready === undefined ? { kind: "present" } : { kind: "unready", bucket: unready };
}

/** The archive root's saved Terraform plan file `planFile`. It keeps no state. */
export function archivePlanFile(
  archive: ArchiveBucket,
  terraformDirectory: string,
  planFile: string,
): SavedPlanRequest {
  return {
    configuration: { directory: terraformDirectory, root: ARCHIVE_ROOT },
    credentials: archive.credentials,
    region: archive.region,
    backend: {},
    planFile,
  };
}

/**
 * Reads a saved archive plan back from its file: why it may not be applied (it cannot be read,
 * does more than create, or creates nothing), or undefined when it may.
 */
export async function readBackArchivePlan(
  provisioner: Provisioner,
  file: SavedPlanRequest,
): Promise<UnexpectedPlan[] | undefined> {
  return createOnlyRefusal(resourceChanges(await provisioner.showPlan(file)));
}

export interface ArchivePlanRequest {
  readonly instance: FactoryInstance;
  readonly bucket: StateBucket;
  readonly terraformDirectory: string;
  /** Absolute path, owned by the caller, for the archive's saved Terraform plan. */
  readonly planFile: string;
}

export type ArchivePlanning =
  | { readonly kind: "refused"; readonly issues: readonly Issue[] }
  /** The archive exists without every setting the archive root applies. Nothing is planned. */
  | { readonly kind: "unready_archive"; readonly bucket: UnreadyBucket }
  /** Its plan would do something other than create, creates nothing, or could not be read. */
  | { readonly kind: "unexpected_plan"; readonly unexpected: readonly UnexpectedPlan[] }
  /** The archive as planned; undefined when factory.json does not enable it. */
  | { readonly kind: "planned"; readonly archive: PlannedArchive | undefined };

/**
 * The log archive's part of the infrastructure stage's plan: nothing without one; for a missing
 * archive, the archive root planned into `planFile` and read back, create-only; for a present,
 * ready one, nothing to plan; and a refusal of one that is not ready. Applies nothing.
 */
export async function planArchive(
  { lockStore, provisioner }: { readonly lockStore: LockStore; readonly provisioner: Provisioner },
  request: ArchivePlanRequest,
): Promise<ArchivePlanning> {
  const archive = archiveOf(request.instance, request.bucket);
  if (archive === undefined) return { kind: "planned", archive: undefined };
  const state = await archiveState(lockStore, archive);
  if (state.kind === "unready") return { kind: "unready_archive", bucket: state.bucket };
  if (state.kind === "present")
    return { kind: "planned", archive: { bucket: archive.bucket, creates: false } };
  const projection = projectArchiveVariables(request.instance);
  if (!projection.ok) return { kind: "refused", issues: projection.issues };
  const file = archivePlanFile(archive, request.terraformDirectory, request.planFile);
  await provisioner.plan({ ...file, variables: { ...projection.variables } });
  const unexpected = await readBackArchivePlan(provisioner, file);
  if (unexpected !== undefined) return { kind: "unexpected_plan", unexpected };
  return { kind: "planned", archive: { bucket: archive.bucket, creates: true } };
}
