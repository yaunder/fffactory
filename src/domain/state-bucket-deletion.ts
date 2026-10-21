/**
 * Deleting a factory's state bucket (D6), the last step of removing the factory: every object
 * version and delete marker is deleted, page by page as it is listed, the factory lock's last,
 * its current one alone and last of all, then the bucket. The lock lives in the bucket, so
 * deleting its versions last leaves it held when anything before them fails.
 */
import { lockKey } from "./factory-lock";
import type { FactoryId } from "./instance";

/** The most keys one S3 DeleteObjects call takes. */
export const DELETE_OBJECTS_LIMIT = 1000;

/** One version of an object, or one delete marker, as S3 lists it: deleted by its version ID. */
export interface ObjectVersion {
  readonly key: string;
  /** S3's version ID; `null` for an object stored while versioning was not in effect. */
  readonly version: string;
}

/** A version or delete marker as ListObjectVersions lists it, and where it stands in its key. */
export interface ListedVersion extends ObjectVersion {
  /** S3's `IsLatest`: the key's current version, or delete marker. */
  readonly latest: boolean;
  /** S3's `LastModified`: when the version, or delete marker, was written. */
  readonly modified: Date;
}

/** One listed page of the bucket, as it is deleted. */
export interface PageDeletion {
  /** Every key's versions but the lock's, in the DeleteObjects calls that delete them. */
  readonly others: readonly (readonly ObjectVersion[])[];
  /** The lock object's versions and delete markers, set aside until every other is gone. */
  readonly lock: readonly ListedVersion[];
}

function batches(versions: readonly ObjectVersion[]): ObjectVersion[][] {
  const batched: ObjectVersion[][] = [];
  for (let start = 0; start < versions.length; start += DELETE_OBJECTS_LIMIT)
    batched.push(versions.slice(start, start + DELETE_OBJECTS_LIMIT));
  return batched;
}

/**
 * Splits one listed page: every other key's versions into DeleteObjects batches of at most
 * `DELETE_OBJECTS_LIMIT`, in listing order, and the lock object's (`lockKey`, exactly: the
 * break log's keys start the same way and are not the lock) set aside for `lockBatches`. The
 * lock's versions never share a call with another key, so a version S3 refuses to delete there
 * cannot take the lock with it.
 */
export function deletionBatches(
  factoryId: FactoryId,
  page: readonly ListedVersion[],
): PageDeletion {
  const lock = lockKey(factoryId);
  return {
    others: batches(page.filter(({ key }) => key !== lock)),
    lock: page.filter(({ key }) => key === lock),
  };
}

/**
 * The lock's versions and delete markers, in the DeleteObjects calls that delete them: every
 * one no longer current oldest first, by when it was written (S3 lists a key's versions and its
 * delete markers apart, each newest first; those written in the same instant go in reverse
 * listing order), then the current one in a call of its own. Deleting the current one while an
 * older one is left would make the older current, reviving an earlier holder's lock, and S3
 * promises no order within one call: so the current one goes alone, once every older one is
 * gone. Deleting one no longer current never changes which is current.
 */
export function lockBatches(lock: readonly ListedVersion[]): ObjectVersion[][] {
  const oldestFirst = lock.toReversed().sort((a, b) => a.modified.getTime() - b.modified.getTime());
  return [
    ...batches(oldestFirst.filter(({ latest }) => !latest)),
    ...batches(oldestFirst.filter(({ latest }) => latest)),
  ];
}

/** Why the bucket remains when an interrupt stopped its deletion: no further call was started. */
export const DELETION_INTERRUPTED = "Interrupted: no further S3 call was started";

/**
 * What became of the factory lock when the bucket remains. `held`: its current version was
 * never asked to be deleted (an interrupt may have stopped the deletion after older ones), so a
 * lock in place stays held. `deleted`: every one was, so the factory is unlocked
 * and another operation may lock it. `unknown`: a DeleteObjects call for them failed, or
 * refused one, so the lock may still be held, or gone; never an earlier version of it current,
 * as the current one is deleted alone and only once every older one is gone (`lockBatches`).
 */
export type LockAfterDeletion = "held" | "deleted" | "unknown";

/**
 * How deleting the state bucket ended. `absent` once DeleteBucket succeeded, or S3 answers
 * that the bucket does not exist: the lock went with it. `remains` otherwise, with what is left.
 */
export type BucketDeletion =
  | { readonly kind: "absent" }
  | {
      readonly kind: "remains";
      /**
       * Listed versions and delete markers not deleted, the lock's among them; undefined when
       * unknown: the listing did not reach its last page, or DeleteBucket found versions
       * written since.
       */
      readonly versions: number | undefined;
      /** S3's error code for each version DeleteObjects reported it could not delete, each once. */
      readonly codes: readonly string[];
      /**
       * The call that failed, as the AWS session describes it: an error name, never a message;
       * or `DELETION_INTERRUPTED` when an interrupt stopped the deletion before its next call.
       */
      readonly failure: string | undefined;
      readonly lock: LockAfterDeletion;
    };
