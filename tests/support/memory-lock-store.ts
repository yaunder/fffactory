import type { LockCreation, LockStore, StateBucket } from "../../src/application/lock-store";
import type { StateBucketReadiness } from "../../src/domain/backend-bootstrap";
import type { HeldLock, LockBreakEntry, LockRecord } from "../../src/domain/factory-lock";
import { type OperationRecord, operationKey } from "../../src/domain/operation";

/** A state bucket as backend bootstrap leaves it. */
export const READY_BUCKET: StateBucketReadiness = {
  versioning: "Enabled",
  publicAccessBlocked: true,
  encrypted: true,
  tlsOnly: true,
};

/**
 * In-memory LockStore behaving as the versioned state bucket does: `create` is a conditional
 * write that never replaces a lock, each write gets a new version, and `remove` deletes only
 * the version it names. Buckets are keyed by name and record every call; each is ready as
 * backend bootstrap leaves it unless `readiness` says otherwise. Operation records are kept
 * by key, each write replacing the last, with every write in `operationWrites`; the
 * factory's Terraform state revision per bucket is `states`, absent before any apply.
 */
export class MemoryLockStore implements LockStore {
  readonly calls: string[] = [];
  readonly logs = new Map<string, LockBreakEntry>();
  readonly buckets = new Set<string>();
  /** The current lock object per bucket. */
  readonly locks = new Map<string, HeldLock>();
  /** Buckets whose settings are not those backend bootstrap applies. */
  readonly readiness = new Map<string, StateBucketReadiness>();
  private versions = 0;
  /** The latest record per operation key. */
  readonly operations = new Map<string, OperationRecord>();
  /** Every operation record written, in order. */
  readonly operationWrites: OperationRecord[] = [];
  /** The factory's Terraform state revision per bucket; absent while there is no state. */
  readonly states = new Map<string, string>();
  /** Runs once, after `create` is refused and before the held lock is read. */
  beforeRead: (() => void) | undefined;

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

  private requireBucket({ bucket }: StateBucket): void {
    if (!this.buckets.has(bucket)) throw new Error(`S3 answered NoSuchBucket`);
  }

  async bucketExists(bucket: StateBucket): Promise<boolean> {
    this.calls.push(`bucketExists ${bucket.bucket}`);
    return this.buckets.has(bucket.bucket);
  }

  async bucketReadiness(bucket: StateBucket): Promise<StateBucketReadiness> {
    this.calls.push(`bucketReadiness ${bucket.bucket}`);
    this.requireBucket(bucket);
    return this.readiness.get(bucket.bucket) ?? READY_BUCKET;
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
  }

  async writeOperation(bucket: StateBucket, record: OperationRecord): Promise<void> {
    this.calls.push(`writeOperation ${bucket.bucket} ${record.stages.at(-1)?.status}`);
    this.requireBucket(bucket);
    this.operations.set(operationKey(record), record);
    this.operationWrites.push(record);
  }

  async stateRevision(bucket: StateBucket): Promise<string | undefined> {
    this.calls.push(`stateRevision ${bucket.bucket}`);
    this.requireBucket(bucket);
    return this.states.get(bucket.bucket);
  }
}
