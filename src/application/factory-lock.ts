/**
 * The factory-wide lock's use cases. One lock covers every stage of a mutating operation:
 * the operation acquires it once, before its first stage, and releases it after its last.
 * A process that dies or is interrupted holding it leaves it in place, and only an
 * explicit, confirmed break, logged in the state bucket, removes it.
 */
import type { CredentialSelection } from "../domain/aws-account";
import {
  confirmsBreak,
  type HeldLock,
  type LockHolder,
  type LockRecord,
  lockBreakKey,
  lockToken,
  newLockBreakEntry,
  newLockRecord,
} from "../domain/factory-lock";
import type { RandomBytes } from "../domain/initialization";
import type { FactoryId, FactoryInstance, Issue, Release } from "../domain/instance";
import type { LockStore, StateBucket } from "./lock-store";
import type { AllowedAccount } from "./require-expected-account";

export type StateBucketResolution =
  | { readonly ok: true; readonly bucket: StateBucket }
  | { readonly ok: false; readonly issues: readonly Issue[] };

const STATE_BUCKET_FIELDS: readonly (readonly [string, (instance: FactoryInstance) => unknown])[] =
  [
    ["factory_id", (instance) => instance.factory_id],
    ["aws.account_id", (instance) => instance.aws?.account_id],
    ["aws.region", (instance) => instance.aws?.region],
    ["state_backend.bucket", (instance) => instance.state_backend?.bucket],
  ];

/**
 * The state bucket of a valid instance, reached with `credentials`. Validation has already
 * required the bucket's name to carry the factory ID.
 */
export function stateBucketOf(
  instance: FactoryInstance,
  credentials: CredentialSelection,
): StateBucketResolution {
  const missing = STATE_BUCKET_FIELDS.filter(([, read]) => read(instance) === undefined);
  if (missing.length > 0)
    return {
      ok: false,
      issues: missing.map(([path]) => ({ path, message: "is required to reach the state bucket" })),
    };
  return {
    ok: true,
    bucket: {
      factoryId: instance.factory_id as FactoryId,
      bucket: instance.state_backend?.bucket as string,
      accountId: instance.aws?.account_id as string,
      region: instance.aws?.region as string,
      credentials,
    },
  };
}

/** Who takes or breaks the lock: the principal the account check allowed, on `host`. */
export function lockHolder(account: AllowedAccount, host: string): LockHolder {
  return { principal: account.verdict.caller.arn, host };
}

export interface FactoryLockRequest {
  readonly bucket: StateBucket;
  /** The operation that will hold the lock, such as `apply`. */
  readonly operation: string;
  readonly holder: LockHolder;
  readonly release: Release;
  readonly now: Date;
  readonly randomBytes: RandomBytes;
}

/** A lock this process holds: exactly one version of the lock object. */
export interface FactoryLock {
  readonly bucket: StateBucket;
  readonly record: LockRecord;
  readonly version: string;
}

export type LockAcquisition =
  | { readonly acquired: true; readonly lock: FactoryLock }
  /** `held` shows who holds it; undefined when it kept changing hands. */
  | { readonly acquired: false; readonly held: HeldLock | undefined };

/** A lock released between refusing creation and being read is retried this many times. */
const ATTEMPTS = 3;

/**
 * Takes the factory lock with a conditional write, or reports who holds it. A held lock,
 * readable or not, is never replaced.
 */
export async function acquireFactoryLock(
  store: LockStore,
  request: FactoryLockRequest,
): Promise<LockAcquisition> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const record = newLockRecord({ ...request, factoryId: request.bucket.factoryId });
    const creation = await store.create(request.bucket, record);
    if (creation.created)
      return {
        acquired: true,
        lock: { bucket: request.bucket, record, version: creation.version },
      };
    const { held } = creation;
    // A retried write whose first attempt created the lock, but lost its answer, finds its own.
    if (held?.record?.lock_id === record.lock_id)
      return { acquired: true, lock: { bucket: request.bucket, record, version: held.version } };
    if (held !== undefined) return { acquired: false, held };
  }
  return { acquired: false, held: undefined };
}

/** Releases a lock this process holds; a lock that replaced it after a break is untouched. */
export function releaseFactoryLock(store: LockStore, lock: FactoryLock): Promise<void> {
  return store.remove(lock.bucket, lock.version);
}

export type LockedWork<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false; readonly held: HeldLock | undefined };

/**
 * Whether fffactory has been interrupted (SIGINT, SIGTERM or SIGHUP). From the first
 * interrupt on, `cli/interrupts.ts` stops the running tools and, once they have stopped, waits
 * at most `RETURN_GRACE_MS` for the operation to return before exiting, so an interrupted
 * operation starts nothing more and never releases its lock: whatever it reached, it leaves
 * the lock and its operation record in place, deterministically.
 */
export type Interrupted = () => boolean;

/** Releases `lock` unless the operation holding it was interrupted, which leaves it held. */
export async function settleFactoryLock(
  store: LockStore,
  lock: FactoryLock,
  interrupted: Interrupted,
): Promise<void> {
  if (!interrupted()) await releaseFactoryLock(store, lock);
}

/**
 * Runs every stage of `work` under one factory lock, and releases it when `work` settles,
 * whether it succeeds or fails. Without the lock, `work` never runs. An operation that can be
 * interrupted, such as apply, settles its lock with `settleFactoryLock` instead, so an
 * interrupt leaves the lock held.
 */
export async function withFactoryLock<T>(
  store: LockStore,
  request: FactoryLockRequest,
  work: (lock: FactoryLock) => Promise<T>,
): Promise<LockedWork<T>> {
  const acquisition = await acquireFactoryLock(store, request);
  if (!acquisition.acquired) return acquisition;
  try {
    return { acquired: true, value: await work(acquisition.lock) };
  } finally {
    await releaseFactoryLock(store, acquisition.lock);
  }
}

export interface LockBreakRequest {
  readonly bucket: StateBucket;
  /** The lock as it was shown to the operator. */
  readonly held: HeldLock;
  /** What the operator typed or passed to confirm: must be the lock's token. */
  readonly confirmation: string;
  readonly breaker: LockHolder;
  readonly now: Date;
  readonly release: Release;
}

export type LockBreak =
  | { readonly kind: "not_confirmed" }
  /** The lock was released or replaced after it was shown; nothing was broken. */
  | { readonly kind: "changed"; readonly current: HeldLock | undefined }
  | { readonly kind: "broken"; readonly logKey: string };

/**
 * Breaks the lock the operator was shown, only when `confirmation` is its token and it is
 * still the lock in place, by version and token. The break is logged in the state bucket
 * first, so a lock is never broken without a record; then exactly that version is removed.
 */
export async function breakFactoryLock(
  store: LockStore,
  request: LockBreakRequest,
): Promise<LockBreak> {
  const { bucket, held } = request;
  if (!confirmsBreak(held, request.confirmation)) return { kind: "not_confirmed" };
  const current = await store.read(bucket);
  // Every unversioned lock is the `null` version, so the token must match as well.
  if (current?.version !== held.version || lockToken(current) !== lockToken(held))
    return { kind: "changed", current };
  const logKey = lockBreakKey(bucket.factoryId, request.now, lockToken(held));
  await store.logBreak(
    bucket,
    logKey,
    newLockBreakEntry(held, request.breaker, request.now, request.release),
  );
  await store.remove(bucket, held.version);
  return { kind: "broken", logKey };
}
