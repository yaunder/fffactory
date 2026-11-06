import {
  type ArchiveBucket,
  type FactoryBucket,
  type LockCreation,
  type LockStore,
  type StateBucket,
  StateBucketUnreachable,
} from "../../src/application/lock-store";
import type { ArchiveReadiness, StateBucketReadiness } from "../../src/domain/backend-bootstrap";
import type { HeldLock, LockBreakEntry, LockRecord } from "../../src/domain/factory-lock";
import {
  type OperationRecord,
  operationKey,
  operationsPrefix,
  type StoredOperation,
  serializeOperation,
} from "../../src/domain/operation";
import { type BucketDeletion, DELETION_INTERRUPTED } from "../../src/domain/state-bucket-deletion";

/** A state bucket as backend bootstrap leaves it. */
export const READY_BUCKET: StateBucketReadiness = {
  versioning: "Enabled",
  publicAccessBlocked: true,
  encrypted: true,
  tlsOnly: true,
};

/** A log archive as the archive root leaves it. */
export const READY_ARCHIVE: ArchiveReadiness = {
  ...READY_BUCKET,
  ownership: "BucketOwnerEnforced",
  sseS3: true,
  abac: "Enabled",
};

/**
 * In-memory LockStore behaving as the versioned state bucket does: `create` is a conditional
 * write that never replaces a lock, each write gets a new version, and `remove` deletes only
 * the version it names. Buckets are keyed by name and record every call; each is ready as
 * backend bootstrap leaves it unless `readiness` says otherwise. Operation records are kept
 * by key, each write replacing the last, with every write in `operationWrites`, and read back
 * as their text by `readOperations`, with any text `store` put under their prefix; the
 * factory's Terraform state revision per bucket is `states`, absent before any apply. Break
 * logs and operation records are kept by key, each remembering its bucket: deleting a bucket
 * removes its own, then its lock, then the bucket, and an interrupt by then (`beforeLock` can
 * set one) leaves the lock and the bucket. A bucket in `unreachable` answers `bucketExists` as
 * S3's 403 does: another account's name, or one these credentials may not reach. A log archive
 * is a bucket like any other, ready as the archive root leaves it unless `archiveReadiness`
 * says otherwise.
 */
export class MemoryLockStore implements LockStore {
  readonly calls: string[] = [];
  readonly logs = new Map<string, LockBreakEntry>();
  readonly buckets = new Set<string>();
  /** The current lock object per bucket. */
  readonly locks = new Map<string, HeldLock>();
  /** Buckets whose settings are not those backend bootstrap applies. */
  readonly readiness = new Map<string, StateBucketReadiness>();
  /** Log archives whose settings are not those the archive root applies. */
  readonly archives = new Map<string, ArchiveReadiness>();
  private versions = 0;
  /** The latest record per operation key. */
  readonly operations = new Map<string, OperationRecord>();
  /** Every operation record written, in order. */
  readonly operationWrites: OperationRecord[] = [];
  /** Objects `store` put in a bucket by key, such as a damaged record, read back as they are. */
  readonly texts = new Map<string, string>();
  /** The factory's Terraform state revision per bucket; absent while there is no state. */
  readonly states = new Map<string, string>();
  /** The bucket each break log entry and operation record was written to, by key. */
  private readonly written = new Map<string, string>();
  /** Runs once, after `create` is refused and before the held lock is read. */
  beforeRead: (() => void) | undefined;
  /**
   * What `deleteBucket` answers once it has deleted everything but the lock, as a failure
   * partway does; the bucket stays, and the lock with it unless the answer's `lock` is
   * `deleted`, as when DeleteBucket fails after the lock's versions are gone. Undefined
   * deletes the bucket.
   */
  deletionLeaves: Extract<BucketDeletion, { kind: "remains" }> | undefined;
  /** Runs once `deleteBucket` has deleted every other key, before the lock's versions. */
  beforeLock: (() => void) | undefined;
  /** Buckets whose HeadBucket S3 answers with 403. */
  readonly unreachable = new Set<string>();

  constructor(existing: readonly string[] = []) {
    for (const bucket of existing) this.buckets.add(bucket);
  }

  /** Puts a lock in place as another operation, or a tampered object, would. */
  hold(bucket: string, record: LockRecord | undefined): HeldLock {
    const held = { version: this.nextVersion(), record };
    this.locks.set(bucket, held);
    return held;
  }

  private nextVersion(): string {
    this.versions += 1;
    return `version-${this.versions}`;
  }

  private requireBucket({ bucket }: FactoryBucket): void {
    if (!this.buckets.has(bucket)) throw new Error(`S3 answered NoSuchBucket`);
  }

  async bucketExists(bucket: FactoryBucket): Promise<boolean> {
    this.calls.push(`bucketExists ${bucket.bucket}`);
    if (this.unreachable.has(bucket.bucket))
      throw new StateBucketUnreachable(bucket.bucket, bucket.accountId);
    return this.buckets.has(bucket.bucket);
  }

  async bucketReadiness(bucket: StateBucket): Promise<StateBucketReadiness> {
    this.calls.push(`bucketReadiness ${bucket.bucket}`);
    this.requireBucket(bucket);
    return this.readiness.get(bucket.bucket) ?? READY_BUCKET;
  }

  async archiveReadiness(bucket: ArchiveBucket): Promise<ArchiveReadiness> {
    this.calls.push(`archiveReadiness ${bucket.bucket}`);
    this.requireBucket(bucket);
    return this.archives.get(bucket.bucket) ?? READY_ARCHIVE;
  }

  async create(bucket: StateBucket, record: LockRecord): Promise<LockCreation> {
    this.calls.push(`create ${bucket.bucket} ${record.lock_id}`);
    this.requireBucket(bucket);
    if (this.locks.has(bucket.bucket)) {
      const run = this.beforeRead;
      this.beforeRead = undefined;
      run?.();
      return { created: false, held: this.locks.get(bucket.bucket) };
    }
    return { created: true, version: this.hold(bucket.bucket, record).version };
  }

  async read(bucket: StateBucket): Promise<HeldLock | undefined> {
    this.calls.push(`read ${bucket.bucket}`);
    this.requireBucket(bucket);
    return this.locks.get(bucket.bucket);
  }

  async remove(bucket: StateBucket, version: string): Promise<void> {
    this.calls.push(`remove ${bucket.bucket} ${version}`);
    this.requireBucket(bucket);
    if (this.locks.get(bucket.bucket)?.version === version) this.locks.delete(bucket.bucket);
  }

  async logBreak(bucket: StateBucket, key: string, entry: LockBreakEntry): Promise<void> {
    this.calls.push(`logBreak ${bucket.bucket} ${key}`);
    this.requireBucket(bucket);
    if (this.logs.has(key)) throw new Error("S3 answered PreconditionFailed");
    this.logs.set(key, entry);
    this.written.set(key, bucket.bucket);
  }

  async writeOperation(bucket: StateBucket, record: OperationRecord): Promise<void> {
    this.calls.push(`writeOperation ${bucket.bucket} ${record.stages.at(-1)?.status}`);
    this.requireBucket(bucket);
    this.operations.set(operationKey(record), record);
    this.texts.delete(operationKey(record));
    this.written.set(operationKey(record), bucket.bucket);
    this.operationWrites.push(record);
  }

  /** Puts `text` at `key` in `bucket`, as a record damaged or written by hand would be. */
  store(bucket: string, key: string, text: string): void {
    this.operations.delete(key);
    this.texts.set(key, text);
    this.written.set(key, bucket);
  }

  async readOperations(bucket: StateBucket): Promise<readonly StoredOperation[]> {
    this.calls.push(`readOperations ${bucket.bucket}`);
    this.requireBucket(bucket);
    const prefix = operationsPrefix(bucket.factoryId);
    return [...this.written]
      .filter(([key, written]) => written === bucket.bucket && key.startsWith(prefix))
      .flatMap(([key]) => {
        const record = this.operations.get(key);
        const text = record === undefined ? this.texts.get(key) : serializeOperation(record);
        return text === undefined ? [] : [{ key, text }];
      })
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  async stateRevision(bucket: StateBucket): Promise<string | undefined> {
    this.calls.push(`stateRevision ${bucket.bucket}`);
    this.requireBucket(bucket);
    return this.states.get(bucket.bucket);
  }

  async deleteBucket(bucket: StateBucket, interrupted: () => boolean): Promise<BucketDeletion> {
    this.calls.push(`deleteBucket ${bucket.bucket}`);
    if (!this.buckets.has(bucket.bucket)) return { kind: "absent" };
    for (const [key, written] of this.written)
      if (written === bucket.bucket) {
        this.logs.delete(key);
        this.operations.delete(key);
        this.texts.delete(key);
        this.written.delete(key);
      }
    this.states.delete(bucket.bucket);
    this.beforeLock?.();
    if (interrupted())
      return {
        kind: "remains",
        versions: undefined,
        codes: [],
        failure: DELETION_INTERRUPTED,
        lock: "held",
      };
    const left = this.deletionLeaves;
    if (left === undefined || left.lock === "deleted") this.locks.delete(bucket.bucket);
    if (left) return left;
    this.readiness.delete(bucket.bucket);
    this.buckets.delete(bucket.bucket);
    return { kind: "absent" };
  }
}
