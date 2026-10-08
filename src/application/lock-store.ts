import type { CredentialSelection } from "../domain/aws-account";
import type { StateBucketReadiness } from "../domain/backend-bootstrap";
import type { HeldLock, LockBreakEntry, LockRecord } from "../domain/factory-lock";
import type { FactoryId } from "../domain/instance";
import type { OperationRecord } from "../domain/operation";

/** The factory's state bucket, reached with the credentials the account check allowed. */
export interface StateBucket {
  readonly factoryId: FactoryId;
  readonly bucket: string;
  /** The factory's account: every request requires the bucket to be owned by it. */
  readonly accountId: string;
  readonly region: string;
  readonly credentials: CredentialSelection;
}

export type LockCreation =
  | { readonly created: true; readonly version: string }
  /** `held` is undefined when the lock that refused creation was gone before it could be read. */
  | { readonly created: false; readonly held: HeldLock | undefined };

/**
 * Port: the state bucket, as the factory's operations use it: its readiness, the
 * factory-wide lock (one object, `lockKey`) and its break log, the records of operations
 * that held the lock, and the revision of the factory's Terraform state. Every call
 * rejects, naming the AWS error but never quoting it, when it cannot complete.
 */
export interface LockStore {
  /**
   * Whether the state bucket exists in the factory's account. Rejects when it cannot tell,
   * including when the name belongs to another account.
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
}
