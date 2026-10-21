import type { CredentialSelection } from "../domain/aws-account";
import type { StateBucketReadiness } from "../domain/backend-bootstrap";
import type { HeldLock, LockBreakEntry, LockRecord } from "../domain/factory-lock";
import type { FactoryId } from "../domain/instance";
import type { OperationRecord } from "../domain/operation";
import type { BucketDeletion } from "../domain/state-bucket-deletion";

/** The factory's state bucket, reached with the credentials the account check allowed. */
export interface StateBucket {
  readonly factoryId: FactoryId;
  readonly bucket: string;
  /** The factory's account: every request requires the bucket to be owned by it. */
  readonly accountId: string;
  readonly region: string;
  readonly credentials: CredentialSelection;
}

/**
 * `bucketExists` was refused with S3's 403 for a request that requires the factory's account to
 * own the bucket: another account owns the name, as it may once the factory's bucket was
 * deleted, or these credentials may not reach it. S3 does not say which.
 */
export class StateBucketUnreachable extends Error {
  override readonly name = "StateBucketUnreachable";

  constructor(
    readonly bucket: string,
    readonly accountId: string,
  ) {
    super(
      `The state bucket ${bucket} is not accessible in account ${accountId}: it belongs to ` +
        "another account, or these credentials may not reach it (S3 answered 403)",
    );
  }
}

export type LockCreation =
  | { readonly created: true; readonly version: string }
  /** `held` is undefined when the lock that refused creation was gone before it could be read. */
  | { readonly created: false; readonly held: HeldLock | undefined };

/**
 * Port: the state bucket, as the factory's operations use it: its readiness, the
 * factory-wide lock (one object, `lockKey`) and its break log, the records of operations
 * that held the lock, the revision of the factory's Terraform state, and, last of all, its
 * deletion. Every call but `deleteBucket` rejects, naming the AWS error but never quoting it,
 * when it cannot complete; `deleteBucket` resolves every failure the same way, as `remains`.
 */
export interface LockStore {
  /**
   * Whether the state bucket exists in the factory's account. Rejects when it cannot tell,
   * with `StateBucketUnreachable` when S3 answers 403: the name belongs to another account, or
   * these credentials may not reach it.
   */
  bucketExists(bucket: StateBucket): Promise<boolean>;
  /** The settings backend bootstrap applies to an existing state bucket, as S3 reports them. */
  bucketReadiness(bucket: StateBucket): Promise<StateBucketReadiness>;
  /** Creates the lock object only if none exists: a conditional write that never replaces one. */
  create(bucket: StateBucket, record: LockRecord): Promise<LockCreation>;
  /** The lock object, or undefined when there is none. */
  read(bucket: StateBucket): Promise<HeldLock | undefined>;
  /** Removes exactly this version of the lock object; a later lock is never touched. */
  remove(bucket: StateBucket, version: string): Promise<void>;
  /** Writes a break's log entry at `key`, refusing to replace an existing entry. */
  logBreak(bucket: StateBucket, key: string, entry: LockBreakEntry): Promise<void>;
  /** Writes an operation's record at `operationKey(record)`, replacing its earlier one. */
  writeOperation(bucket: StateBucket, record: OperationRecord): Promise<void>;
  /**
   * An opaque revision of the factory's Terraform state object (`FACTORY_STATE_KEY`) that
   * changes whenever the state is written; undefined when there is no state yet.
   */
  stateRevision(bucket: StateBucket): Promise<string | undefined>;
  /**
   * Deletes every object version and delete marker in the bucket, page by page as it is listed,
   * the lock's last, only once every other is gone, oldest first and the current one alone and
   * last of all (`deletionBatches`, `lockBatches`), then the bucket itself
   * (`docs/specs/provisioning.md` §Deleting the state bucket). A bucket already gone is
   * `absent`. Nothing else in the factory may run meanwhile: its caller holds the lock, and
   * this deletes it. On `absent` the lock is gone with the bucket: the caller must neither
   * release it nor write an operation record into the bucket. On `remains`, `lock` says
   * whether it is still held: once its versions are being deleted the factory may be
   * unlocked. Releasing it by its version while the bucket exists is harmless either way.
   * Once `interrupted` answers true it starts no further S3 call, neither a listing, a
   * DeleteObjects nor DeleteBucket: the bucket `remains` (`DELETION_INTERRUPTED`), the lock
   * `held` until the call for its current version was made, `deleted` once every one is gone.
   */
  deleteBucket(bucket: StateBucket, interrupted: () => boolean): Promise<BucketDeletion>;
}
