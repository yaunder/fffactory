import type { S3ClientConfig } from "@aws-sdk/client-s3";
import {
  type ArchiveBucket,
  type FactoryBucket,
  type LockStore,
  type StateBucket,
  StateBucketUnreachable,
} from "../application/lock-store";
import {
  type ArchiveReadiness,
  deniesInsecureTransport,
  type StateBucketReadiness,
} from "../domain/backend-bootstrap";
import {
  type HeldLock,
  type LockBreakEntry,
  type LockRecord,
  lockKey,
  parseLockRecord,
  serializeLock,
} from "../domain/factory-lock";
import {
  type OperationRecord,
  operationKey,
  operationsPrefix,
  type StoredOperation,
  serializeOperation,
} from "../domain/operation";
import { FACTORY_STATE_KEY } from "../domain/plan";
import {
  type BucketDeletion,
  DELETE_OBJECTS_LIMIT,
  DELETION_INTERRUPTED,
  deletionBatches,
  type ListedVersion,
  type LockAfterDeletion,
  lockBatches,
  type ObjectVersion,
} from "../domain/state-bucket-deletion";
import {
  AdapterRefusal,
  type AwsCalls,
  AwsFailure,
  clientSettings,
  errorName,
  failureReason,
  httpStatus,
  type OpenCalls,
  withAwsSession,
} from "./aws-session";

/**
 * Each port call's deadline, whatever S3 calls it makes. Deleting the bucket gives one to each
 * ListObjectVersions page, each DeleteObjects call and DeleteBucket.
 */
export const S3_TIMEOUT_MS = 30_000;

/** How many operation records are read at once, each GetObject in a session of its own. */
const RECORD_READS = 8;

/** The object calls the lock store makes, each bound to the factory's account. */
export interface S3Calls extends AwsCalls {
  headBucket(bucket: string, owner: string): Promise<void>;
  /** GetBucketVersioning's status, undefined when versioning was never enabled. */
  bucketVersioning(bucket: string, owner: string): Promise<string | undefined>;
  /** GetPublicAccessBlock's settings; rejects with S3's error when the bucket has none. */
  publicAccessBlock(bucket: string, owner: string): Promise<PublicAccessBlockSettings>;
  /** The algorithms of GetBucketEncryption's default encryption rules. */
  bucketEncryption(bucket: string, owner: string): Promise<readonly string[]>;
  /**
   * The object ownership of GetBucketOwnershipControls' rule; rejects with S3's error when the
   * bucket has none.
   */
  ownershipControls(bucket: string, owner: string): Promise<string | undefined>;
  /** GetBucketAbac's status, undefined when S3 names none. */
  bucketAbac(bucket: string, owner: string): Promise<string | undefined>;
  /** GetBucketPolicy's policy document; rejects with S3's error when the bucket has none. */
  bucketPolicy(bucket: string, owner: string): Promise<string | undefined>;
  /** Writes an object only if none exists at `key` (`If-None-Match: *`). */
  putNewObject(
    bucket: string,
    owner: string,
    key: string,
    body: string,
  ): Promise<{ readonly VersionId?: string | undefined }>;
  getObject(
    bucket: string,
    owner: string,
    key: string,
  ): Promise<{ readonly VersionId?: string | undefined; readonly body: string }>;
  /** One page of ListObjectsV2 under `prefix`, from the start or from `token`. */
  listObjects(
    bucket: string,
    owner: string,
    prefix: string,
    token: string | undefined,
  ): Promise<ObjectPage>;
  /** Permanently deletes one version of an object. */
  deleteObjectVersion(bucket: string, owner: string, key: string, version: string): Promise<void>;
  /** Writes an object, replacing any at `key`. */
  putObject(bucket: string, owner: string, key: string, body: string): Promise<void>;
  /** HeadObject's version and entity tag; rejects with S3's 404 when there is no object. */
  headObject(bucket: string, owner: string, key: string): Promise<ObjectRevision>;
  /** One page of ListObjectVersions, from the start or from where the last page ended. */
  listObjectVersions(
    bucket: string,
    owner: string,
    marker: VersionMarker | undefined,
  ): Promise<VersionPage>;
  /**
   * DeleteObjects in quiet mode, each object by its version: the versions S3 reports it could
   * not delete. At most `DELETE_OBJECTS_LIMIT` at once.
   */
  deleteObjects(
    bucket: string,
    owner: string,
    versions: readonly ObjectVersion[],
  ): Promise<readonly DeleteError[]>;
  /** Deletes the bucket; rejects with S3's `BucketNotEmpty` while any version is left. */
  deleteBucket(bucket: string, owner: string): Promise<void>;
}

/** Where the next page of a listing starts. */
export interface VersionMarker {
  readonly key: string;
  readonly version: string | undefined;
}

/** The fields of one ListObjectsV2 page the adapter reads. */
export interface ObjectPage {
  readonly Contents?: readonly { readonly Key?: string | undefined }[] | undefined;
  readonly IsTruncated?: boolean | undefined;
  readonly NextContinuationToken?: string | undefined;
}

/** One version, or delete marker, of a ListObjectVersions page. */
interface VersionEntry {
  readonly Key?: string | undefined;
  readonly VersionId?: string | undefined;
  readonly IsLatest?: boolean | undefined;
  readonly LastModified?: Date | undefined;
}

/** The fields of one ListObjectVersions page the adapter reads. */
export interface VersionPage {
  readonly Versions?: readonly VersionEntry[] | undefined;
  readonly DeleteMarkers?: readonly VersionEntry[] | undefined;
  readonly IsTruncated?: boolean | undefined;
  readonly NextKeyMarker?: string | undefined;
  readonly NextVersionIdMarker?: string | undefined;
}

/** One version DeleteObjects could not delete. */
export interface DeleteError {
  readonly Key?: string | undefined;
  readonly VersionId?: string | undefined;
  readonly Code?: string | undefined;
}

export interface ObjectRevision {
  readonly VersionId?: string | undefined;
  readonly ETag?: string | undefined;
}

export interface PublicAccessBlockSettings {
  readonly BlockPublicAcls?: boolean | undefined;
  readonly IgnorePublicAcls?: boolean | undefined;
  readonly BlockPublicPolicy?: boolean | undefined;
  readonly RestrictPublicBuckets?: boolean | undefined;
}

/**
 * The calls over AWS SDK for JavaScript v3, imported on first use so commands that never
 * call AWS never load it. `config` adds client configuration, such as a test endpoint.
 */
export function sdkS3Calls(config: Partial<S3ClientConfig> = {}): OpenCalls<S3Calls> {
  return async (session) => {
    const s3 = await import("@aws-sdk/client-s3");
    const client = new s3.S3Client({ ...(await clientSettings(session)), ...config });
    const options = { abortSignal: session.abortSignal };
    return {
      headBucket: async (Bucket, ExpectedBucketOwner) => {
        await client.send(new s3.HeadBucketCommand({ Bucket, ExpectedBucketOwner }), options);
      },
      bucketVersioning: async (Bucket, ExpectedBucketOwner) =>
        (
          await client.send(
            new s3.GetBucketVersioningCommand({ Bucket, ExpectedBucketOwner }),
            options,
          )
        ).Status,
      publicAccessBlock: async (Bucket, ExpectedBucketOwner) =>
        (
          await client.send(
            new s3.GetPublicAccessBlockCommand({ Bucket, ExpectedBucketOwner }),
            options,
          )
        ).PublicAccessBlockConfiguration ?? {},
      bucketEncryption: async (Bucket, ExpectedBucketOwner) => {
        const answer = await client.send(
          new s3.GetBucketEncryptionCommand({ Bucket, ExpectedBucketOwner }),
          options,
        );
        return (answer.ServerSideEncryptionConfiguration?.Rules ?? []).flatMap(
          (rule) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? [],
        );
      },
      ownershipControls: async (Bucket, ExpectedBucketOwner) =>
        (
          await client.send(
            new s3.GetBucketOwnershipControlsCommand({ Bucket, ExpectedBucketOwner }),
            options,
          )
        ).OwnershipControls?.Rules?.[0]?.ObjectOwnership,
      bucketAbac: async (Bucket, ExpectedBucketOwner) =>
        (await client.send(new s3.GetBucketAbacCommand({ Bucket, ExpectedBucketOwner }), options))
          .AbacStatus?.Status,
      bucketPolicy: async (Bucket, ExpectedBucketOwner) =>
        (await client.send(new s3.GetBucketPolicyCommand({ Bucket, ExpectedBucketOwner }), options))
          .Policy,
      putNewObject: (Bucket, ExpectedBucketOwner, Key, Body) =>
        client.send(
          new s3.PutObjectCommand({
            Bucket,
            ExpectedBucketOwner,
            Key,
            Body,
            ContentType: "application/json",
            IfNoneMatch: "*",
          }),
          options,
        ),
      getObject: async (Bucket, ExpectedBucketOwner, Key) => {
        const answer = await client.send(
          new s3.GetObjectCommand({ Bucket, ExpectedBucketOwner, Key }),
          options,
        );
        return {
          VersionId: answer.VersionId,
          body: (await answer.Body?.transformToString()) ?? "",
        };
      },
      listObjects: (Bucket, ExpectedBucketOwner, Prefix, ContinuationToken) =>
        client.send(
          new s3.ListObjectsV2Command({ Bucket, ExpectedBucketOwner, Prefix, ContinuationToken }),
          options,
        ),
      deleteObjectVersion: async (Bucket, ExpectedBucketOwner, Key, VersionId) => {
        await client.send(
          new s3.DeleteObjectCommand({ Bucket, ExpectedBucketOwner, Key, VersionId }),
          options,
        );
      },
      putObject: async (Bucket, ExpectedBucketOwner, Key, Body) => {
        await client.send(
          new s3.PutObjectCommand({
            Bucket,
            ExpectedBucketOwner,
            Key,
            Body,
            ContentType: "application/json",
          }),
          options,
        );
      },
      headObject: async (Bucket, ExpectedBucketOwner, Key) => {
        const answer = await client.send(
          new s3.HeadObjectCommand({ Bucket, ExpectedBucketOwner, Key }),
          options,
        );
        return { VersionId: answer.VersionId, ETag: answer.ETag };
      },
      listObjectVersions: (Bucket, ExpectedBucketOwner, marker) =>
        client.send(
          new s3.ListObjectVersionsCommand({
            Bucket,
            ExpectedBucketOwner,
            MaxKeys: DELETE_OBJECTS_LIMIT,
            KeyMarker: marker?.key,
            VersionIdMarker: marker?.version,
          }),
          options,
        ),
      deleteObjects: async (Bucket, ExpectedBucketOwner, versions) => {
        const answer = await client.send(
          new s3.DeleteObjectsCommand({
            Bucket,
            ExpectedBucketOwner,
            Delete: {
              Objects: versions.map(({ key, version }) => ({ Key: key, VersionId: version })),
              Quiet: true,
            },
          }),
          options,
        );
        return answer.Errors ?? [];
      },
      deleteBucket: async (Bucket, ExpectedBucketOwner) => {
        await client.send(new s3.DeleteBucketCommand({ Bucket, ExpectedBucketOwner }), options);
      },
      close: () => client.destroy(),
    };
  };
}

/** Object versions S3 hands out: printable, so an unreadable lock can be shown by its version. */
const VERSION = /^[\x21-\x7e]{1,1024}$/;
/** A version and an entity tag, each printable. */
const REVISION = /^[\x21-\x7e]{1,1024}( [\x21-\x7e]{1,1024})?$/;

/**
 * The version of an object written or stored while the bucket's versioning was not in effect:
 * never versioned (S3 names no version) or suspended (S3 names the `null` version). Deleting
 * this version removes such an object, in either state, and leaves no delete marker.
 */
const NULL_VERSION = "null";

/** The object version S3 answered with; a missing one is the `null` version. */
function versionOf(answer: { readonly VersionId?: string | undefined }, bucket: string): string {
  const version = answer.VersionId ?? NULL_VERSION;
  if (!VERSION.test(version))
    throw new AdapterRefusal(`The state bucket ${bucket} returned an unreadable object version`);
  return version;
}

/**
 * The Terraform state object's revision: its version and entity tag, so a write changes it
 * even while the bucket's versioning is not yet in effect.
 */
function revisionOf(answer: ObjectRevision, bucket: string): string {
  const revision = `${answer.VersionId ?? NULL_VERSION} ${answer.ETag ?? ""}`.trimEnd();
  if (!REVISION.test(revision))
    throw new AdapterRefusal(`The state bucket ${bucket} returned an unreadable object version`);
  return revision;
}

/** S3's answers for a bucket setting that was never made. */
const NO_PUBLIC_ACCESS_BLOCK = "NoSuchPublicAccessBlockConfiguration";
const NO_ENCRYPTION = "ServerSideEncryptionConfigurationNotFoundError";
const NO_POLICY = "NoSuchBucketPolicy";
const NO_OWNERSHIP_CONTROLS = "OwnershipControlsNotFoundError";

/** `call`'s answer, or `absent` when S3 answers that the setting does not exist. */
async function orAbsent<T, A>(call: Promise<T>, missing: string, absent: A): Promise<T | A> {
  try {
    return await call;
  } catch (error) {
    if (errorName(error) === missing) return absent;
    throw error;
  }
}

const BLOCKS: readonly (keyof PublicAccessBlockSettings)[] = [
  "BlockPublicAcls",
  "IgnorePublicAcls",
  "BlockPublicPolicy",
  "RestrictPublicBuckets",
];

/** Versioning states S3 reports; anything else is shown as never enabled. */
const VERSIONING_STATES = new Set(["Enabled", "Suspended"]);

/** SSE-S3's algorithm, as GetBucketEncryption names it. */
const SSE_S3 = "AES256";

/**
 * How a bucket's settings compare with those backend bootstrap applies, and its default
 * encryption rules' algorithms.
 */
async function bucketSettings(
  calls: S3Calls,
  bucket: FactoryBucket,
): Promise<{ readonly readiness: StateBucketReadiness; readonly algorithms: readonly string[] }> {
  const { bucket: name, accountId } = bucket;
  const [versioning, block, algorithms, policy] = await Promise.all([
    calls.bucketVersioning(name, accountId),
    orAbsent(calls.publicAccessBlock(name, accountId), NO_PUBLIC_ACCESS_BLOCK, undefined),
    orAbsent(calls.bucketEncryption(name, accountId), NO_ENCRYPTION, []),
    orAbsent(calls.bucketPolicy(name, accountId), NO_POLICY, undefined),
  ]);
  const readiness = {
    versioning:
      versioning !== undefined && VERSIONING_STATES.has(versioning) ? versioning : undefined,
    publicAccessBlocked: block !== undefined && BLOCKS.every((setting) => block[setting] === true),
    encrypted: algorithms.length > 0,
    tlsOnly: deniesInsecureTransport(policy, name),
  };
  return { readiness, algorithms };
}

/** How the state bucket's settings compare with those backend bootstrap applies. */
async function readiness(calls: S3Calls, bucket: StateBucket): Promise<StateBucketReadiness> {
  return (await bucketSettings(calls, bucket)).readiness;
}

/** How the log archive's settings compare with those the archive root applies. */
async function archiveReadiness(calls: S3Calls, bucket: ArchiveBucket): Promise<ArchiveReadiness> {
  const { bucket: name, accountId } = bucket;
  const [settings, ownership, abac] = await Promise.all([
    bucketSettings(calls, bucket),
    orAbsent(calls.ownershipControls(name, accountId), NO_OWNERSHIP_CONTROLS, undefined),
    calls.bucketAbac(name, accountId),
  ]);
  const { readiness, algorithms } = settings;
  return {
    ...readiness,
    ownership,
    sseS3: algorithms.length > 0 && algorithms.every((algorithm) => algorithm === SSE_S3),
    abac,
  };
}

/** How a bucket is named in what the adapter says of it. */
function bucketLabel(bucket: FactoryBucket): string {
  return bucket.kind === "archive" ? "the log archive" : "the state bucket";
}

/** `bucketLabel`, opening a sentence. */
function capitalized(label: string): string {
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

/** A conditional write refused because the object exists, or another write to it is in flight. */
const REFUSED_WRITES = new Set(["PreconditionFailed", "ConditionalRequestConflict"]);

/** HeadBucket's 403, told apart from every other failure outside the AWS session. */
const UNREACHABLE = "unreachable";

/**
 * A failed HeadBucket: false when the bucket does not exist, `UNREACHABLE` when it exists out
 * of the factory's reach (403), a refusal otherwise. Its answers have no body, so the SDK can
 * name only a 404: the HTTP status tells them apart.
 */
function headBucketFailure(error: unknown, bucket: FactoryBucket): false | typeof UNREACHABLE {
  const status = httpStatus(error);
  if (status === 404) return false;
  if (status === 403) return UNREACHABLE;
  if (status === 301)
    throw new AdapterRefusal(
      `${capitalized(bucketLabel(bucket))} ${bucket.bucket} exists outside the factory Region ` +
        `${bucket.region} (S3 answered 301)`,
    );
  throw error;
}

/** One step of deleting the bucket: its answer, the bucket gone (S3 answered 404), or failed. */
type Step<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "gone" }
  | { readonly kind: "failed"; readonly reason: string };

/** S3's answer that the bucket does not exist, to any call. */
const isGone = (error: unknown) => httpStatus(error) === 404 || errorName(error) === "NoSuchBucket";

/** S3 error codes as shown: a plain name, never anything that could carry a message. */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;

function codeOf(error: DeleteError): string {
  return error.Code !== undefined && ERROR_CODE.test(error.Code) ? error.Code : "Unknown";
}

/**
 * One page's versions and delete markers, which the SDK lists apart; a missing version ID is
 * the `null` version, and one never marked latest is not current.
 */
function versionsOf(page: VersionPage, bucket: string): ListedVersion[] {
  const entries = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
  return entries.map(({ Key, VersionId, IsLatest, LastModified }) => {
    if (!Key)
      throw new AdapterRefusal(`S3 listed a version in the state bucket ${bucket} without its key`);
    if (!(LastModified instanceof Date) || Number.isNaN(LastModified.getTime()))
      throw new AdapterRefusal(
        `S3 listed a version of ${Key} in the state bucket ${bucket} without when it was written`,
      );
    return {
      key: Key,
      version: VersionId ?? NULL_VERSION,
      latest: IsLatest === true,
      modified: LastModified,
    };
  });
}

/** Where a truncated page says the next one starts. */
function nextMarker(page: VersionPage, bucket: string): VersionMarker {
  if (!page.NextKeyMarker)
    throw new AdapterRefusal(
      `S3 listed the versions in the state bucket ${bucket} without saying where the next page ` +
        "starts",
    );
  return { key: page.NextKeyMarker, version: page.NextVersionIdMarker || undefined };
}

/** One page of the listing: its versions and delete markers, and where the next page starts. */
interface ListedPage {
  readonly versions: readonly ListedVersion[];
  /** Undefined on the last page. */
  readonly next: VersionMarker | undefined;
}

async function listPage(
  calls: S3Calls,
  bucket: StateBucket,
  marker: VersionMarker | undefined,
): Promise<ListedPage> {
  const page = await calls.listObjectVersions(bucket.bucket, bucket.accountId, marker);
  return {
    versions: versionsOf(page, bucket.bucket),
    next: page.IsTruncated ? nextMarker(page, bucket.bucket) : undefined,
  };
}

/** Listed versions not yet deleted, and the codes S3 gave for those it would not delete. */
interface Tally {
  left: number;
  /** Whether the listing reached its last page, so that `left` counts every version left. */
  complete: boolean;
  readonly codes: Set<string>;
}

/** A batch's answer counted: each version S3 did not refuse is gone. */
function count(tally: Tally, batch: readonly ObjectVersion[], errors: readonly DeleteError[]) {
  tally.left -= batch.length - errors.length;
  for (const error of errors) tally.codes.add(codeOf(error));
}

/** What is left, as counted: the count unknown until the listing reached its last page. */
const remains = (
  tally: Tally,
  failure: string | undefined,
  lock: LockAfterDeletion,
): BucketDeletion => ({
  kind: "remains",
  versions: tally.complete ? tally.left : undefined,
  codes: [...tally.codes],
  failure,
  lock,
});

/** One ListObjectsV2 page's keys, each one S3 named. */
function pageKeys(page: ObjectPage, bucket: string): string[] {
  return (page.Contents ?? []).map(({ Key }) => {
    if (!Key)
      throw new AdapterRefusal(
        `S3 listed an operation record in the state bucket ${bucket} without its key`,
      );
    return Key;
  });
}

/** Where a truncated ListObjectsV2 page says the next one starts; undefined on the last page. */
function nextToken(page: ObjectPage, bucket: string): string | undefined {
  if (!page.IsTruncated) return undefined;
  if (!page.NextContinuationToken)
    throw new AdapterRefusal(
      `S3 listed the operation records in the state bucket ${bucket} without saying where the ` +
        "next page starts",
    );
  return page.NextContinuationToken;
}

/** Every key ListObjectsV2 lists under `prefix`, page by page. */
async function listKeys(calls: S3Calls, bucket: StateBucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await calls.listObjects(bucket.bucket, bucket.accountId, prefix, token);
    keys.push(...pageKeys(page, bucket.bucket));
    token = nextToken(page, bucket.bucket);
  } while (token !== undefined);
  return keys;
}

/**
 * The factory lock, operation records and state revision in the state bucket over S3, and the
 * log archive's existence and settings (D7), never an object in it. Every request requires the
 * bucket to be owned by the factory's account (`ExpectedBucketOwner`).
 * Operation records are read back by listing their prefix (ListObjectsV2), then GetObject of
 * each, a few at a time, each read with its own deadline.
 * The lock is created with a conditional write, and removed by object version, so a lock that
 * replaced it is never touched; the bucket must be versioned, as backend bootstrap creates it.
 * A lock left from before versioning was in effect is its `null` version: held, and removed by
 * that version. Deleting the bucket lists its versions and delete markers page by page,
 * deleting each page by version before listing the next, the lock's last, its current one
 * alone and last of all, then deletes the bucket; S3's 404 to any of those calls is the bucket
 * already gone.
 */
export function s3LockStore(
  open: OpenCalls<S3Calls> = sdkS3Calls(),
  timeoutMs: number = S3_TIMEOUT_MS,
): LockStore {
  const session = <T>(bucket: FactoryBucket, what: string, work: (calls: S3Calls) => Promise<T>) =>
    withAwsSession(open, bucket, timeoutMs, `S3 ${what} on ${bucketLabel(bucket)}`, work);

  /** One step of deleting the bucket in its own session, every failure resolved by name. */
  async function step<T>(
    bucket: StateBucket,
    what: string,
    work: (calls: S3Calls) => Promise<T>,
  ): Promise<Step<T>> {
    try {
      return await session(bucket, what, async (calls): Promise<Step<T>> => {
        try {
          return { kind: "done", value: await work(calls) };
        } catch (error) {
          if (isGone(error)) return { kind: "gone" };
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof AwsFailure || error instanceof AdapterRefusal)
        return { kind: "failed", reason: error.message };
      throw error;
    }
  }

  /**
   * One DeleteObjects call, its answer counted in `tally`: what is left once it fails or finds
   * the bucket gone, undefined otherwise.
   */
  async function deleteBatch(
    bucket: StateBucket,
    batch: readonly ObjectVersion[],
    tally: Tally,
    lock: LockAfterDeletion,
  ): Promise<BucketDeletion | undefined> {
    const answer = await step(bucket, "DeleteObjects", (calls) =>
      calls.deleteObjects(bucket.bucket, bucket.accountId, batch),
    );
    if (answer.kind === "gone") return { kind: "absent" };
    if (answer.kind === "failed") return remains(tally, answer.reason, lock);
    count(tally, batch, answer.value);
    return undefined;
  }

  /**
   * Deletes a group's batches in turn, each even after S3 refused a version in another, and
   * counts what is left in `tally`; what is left once a call fails or finds the bucket gone, or
   * once interrupted before a call: then the lock is `held`, since the lock's current version
   * goes alone in the last call of all.
   */
  async function deleteGroup(
    bucket: StateBucket,
    group: readonly (readonly ObjectVersion[])[],
    tally: Tally,
    lock: LockAfterDeletion,
    interrupted: () => boolean,
  ): Promise<BucketDeletion | undefined> {
    for (const batch of group) {
      if (interrupted()) return remains(tally, DELETION_INTERRUPTED, "held");
      const stopped = await deleteBatch(bucket, batch, tally, lock);
      if (stopped) return stopped;
    }
    return undefined;
  }

  /**
   * Lists one page and deletes its other keys, even after S3 refused a version on an earlier
   * page, and sets the lock's versions aside in `lock`: where the next page starts, or what is
   * left once a call fails or finds the bucket gone, or once interrupted.
   */
  async function deletePage(
    bucket: StateBucket,
    from: VersionMarker | undefined,
    tally: Tally,
    lock: ListedVersion[],
    interrupted: () => boolean,
  ): Promise<BucketDeletion | { readonly next: VersionMarker | undefined }> {
    if (interrupted()) return remains(tally, DELETION_INTERRUPTED, "held");
    const page = await step(bucket, "ListObjectVersions", (calls) => listPage(calls, bucket, from));
    if (page.kind === "gone") return { kind: "absent" };
    if (page.kind === "failed") return remains(tally, page.reason, "held");
    const { versions, next } = page.value;
    tally.left += versions.length;
    tally.complete = next === undefined;
    const batches = deletionBatches(bucket.factoryId, versions);
    lock.push(...batches.lock);
    return (await deleteGroup(bucket, batches.others, tally, "held", interrupted)) ?? { next };
  }

  /**
   * Lists the bucket page by page, each page's other keys deleted before the next is listed:
   * the lock's versions, set aside, once the last page is done, or what is left once a call
   * fails or finds the bucket gone.
   */
  async function deletePages(
    bucket: StateBucket,
    tally: Tally,
    interrupted: () => boolean,
  ): Promise<BucketDeletion | { readonly lock: readonly ListedVersion[] }> {
    const lock: ListedVersion[] = [];
    let marker: VersionMarker | undefined;
    do {
      const deleted = await deletePage(bucket, marker, tally, lock, interrupted);
      if ("kind" in deleted) return deleted;
      marker = deleted.next;
    } while (marker !== undefined);
    return { lock };
  }

  /**
   * Deletes the lock's versions, every other key's gone, in `lockBatches`' calls, stopping at
   * the first that S3 refuses a version in, or that fails: a later call, which may hold the
   * current version, would make the refused one current. What is left then, or undefined once
   * every one is gone.
   */
  async function deleteLock(
    bucket: StateBucket,
    lock: readonly ListedVersion[],
    tally: Tally,
    interrupted: () => boolean,
  ): Promise<BucketDeletion | undefined> {
    for (const batch of lockBatches(lock)) {
      const stopped = await deleteGroup(bucket, [batch], tally, "unknown", interrupted);
      if (stopped) return stopped;
      if (tally.codes.size > 0) return remains(tally, undefined, "unknown");
    }
    return undefined;
  }

  /**
   * DeleteBucket on the emptied bucket, the lock's versions deleted, unless interrupted. A
   * refusal for versions written since is no count.
   */
  async function deleteEmptied(
    bucket: StateBucket,
    interrupted: () => boolean,
  ): Promise<BucketDeletion> {
    if (interrupted())
      return {
        kind: "remains",
        versions: 0,
        codes: [],
        failure: DELETION_INTERRUPTED,
        lock: "deleted",
      };
    const notEmpty = "BucketNotEmpty";
    const answer = await step(bucket, "DeleteBucket", async (calls) => {
      try {
        await calls.deleteBucket(bucket.bucket, bucket.accountId);
        return "deleted";
      } catch (error) {
        if (errorName(error) === notEmpty) return notEmpty;
        throw error;
      }
    });
    const left = (versions: number | undefined, failure: string): BucketDeletion => ({
      kind: "remains",
      versions,
      codes: [],
      failure,
      lock: "deleted",
    });
    if (answer.kind === "failed") return left(0, answer.reason);
    if (answer.kind === "done" && answer.value === notEmpty)
      return left(undefined, `S3 DeleteBucket on the state bucket failed: ${notEmpty}`);
    return { kind: "absent" };
  }

  async function read(calls: S3Calls, bucket: StateBucket): Promise<HeldLock | undefined> {
    try {
      const answer = await calls.getObject(
        bucket.bucket,
        bucket.accountId,
        lockKey(bucket.factoryId),
      );
      return {
        version: versionOf(answer, bucket.bucket),
        record: parseLockRecord(answer.body, bucket.factoryId),
      };
    } catch (error) {
      if (errorName(error) === "NoSuchKey") return undefined;
      throw error;
    }
  }

  /** Writes the lock if none exists: the version it was written as, or the lock in place. */
  async function write(
    calls: S3Calls,
    bucket: StateBucket,
    record: LockRecord,
  ): Promise<{ readonly version: string } | { readonly held: HeldLock | undefined }> {
    try {
      const answer = await calls.putNewObject(
        bucket.bucket,
        bucket.accountId,
        lockKey(bucket.factoryId),
        serializeLock(record),
      );
      return { version: versionOf(answer, bucket.bucket) };
    } catch (error) {
      if (!REFUSED_WRITES.has(errorName(error) ?? "")) throw error;
      const held = await read(calls, bucket);
      // A retried write whose first attempt stored this very lock unversioned.
      const own = held?.version === NULL_VERSION && held.record?.lock_id === record.lock_id;
      return own ? { version: NULL_VERSION } : { held };
    }
  }

  /**
   * A lock written while the bucket's versioning was not in effect cannot be released by its
   * own version, so it is removed again at once and the acquisition refused. Versioning takes
   * a while to come into effect after it is enabled, so a retry succeeds.
   */
  async function removeUnversioned(calls: S3Calls, bucket: StateBucket): Promise<never> {
    const notInEffect = `Versioning is not in effect yet on the state bucket ${bucket.bucket}`;
    try {
      await calls.deleteObjectVersion(
        bucket.bucket,
        bucket.accountId,
        lockKey(bucket.factoryId),
        NULL_VERSION,
      );
    } catch (error) {
      throw new AdapterRefusal(
        `${notInEffect}, and fffactory could not remove the unversioned lock it wrote ` +
          `(${failureReason(error, timeoutMs)}): break it with \`fffactory lock break\`, then ` +
          "retry in a few minutes",
      );
    }
    throw new AdapterRefusal(
      `${notInEffect}, so the lock was not taken (fffactory removed the unversioned lock it ` +
        "wrote); retry in a few minutes",
    );
  }

  return {
    async bucketExists(bucket) {
      const exists = await session(bucket, "HeadBucket", async (calls) => {
        try {
          await calls.headBucket(bucket.bucket, bucket.accountId);
          return true;
        } catch (error) {
          return headBucketFailure(error, bucket);
        }
      });
      if (exists !== UNREACHABLE) return exists;
      if (bucket.kind !== "archive")
        throw new StateBucketUnreachable(bucket.bucket, bucket.accountId);
      // Its name is in S3's account-regional namespace: no other account can hold it.
      throw new AdapterRefusal(
        `The log archive ${bucket.bucket} is not accessible in account ${bucket.accountId}: ` +
          "these credentials may not reach it (S3 answered 403)",
      );
    },

    create: (bucket, record: LockRecord) =>
      session(bucket, "PutObject", async (calls) => {
        const written = await write(calls, bucket, record);
        if (!("version" in written)) return { created: false, held: written.held };
        if (written.version === NULL_VERSION) return removeUnversioned(calls, bucket);
        return { created: true, version: written.version };
      }),

    bucketReadiness: (bucket) =>
      session(
        bucket,
        "GetBucketVersioning, GetPublicAccessBlock, GetBucketEncryption or GetBucketPolicy",
        (calls) => readiness(calls, bucket),
      ),

    archiveReadiness: (bucket) =>
      session(
        bucket,
        "GetBucketVersioning, GetPublicAccessBlock, GetBucketOwnershipControls, " +
          "GetBucketEncryption, GetBucketAbac or GetBucketPolicy",
        (calls) => archiveReadiness(calls, bucket),
      ),

    read: (bucket) => session(bucket, "GetObject", (calls) => read(calls, bucket)),

    remove: (bucket, version) =>
      session(bucket, "DeleteObject", (calls) =>
        calls.deleteObjectVersion(
          bucket.bucket,
          bucket.accountId,
          lockKey(bucket.factoryId),
          version,
        ),
      ),

    writeOperation: (bucket, record: OperationRecord) =>
      session(bucket, "PutObject", (calls) =>
        calls.putObject(
          bucket.bucket,
          bucket.accountId,
          operationKey(record),
          serializeOperation(record),
        ),
      ),

    async readOperations(bucket) {
      const keys = await session(bucket, "ListObjectsV2", (calls) =>
        listKeys(calls, bucket, operationsPrefix(bucket.factoryId)),
      );
      const read = (key: string) =>
        session(bucket, "GetObject", async (calls): Promise<StoredOperation> => {
          const { body } = await calls.getObject(bucket.bucket, bucket.accountId, key);
          return { key, text: body };
        });
      const stored: StoredOperation[] = [];
      for (let start = 0; start < keys.length; start += RECORD_READS)
        stored.push(...(await Promise.all(keys.slice(start, start + RECORD_READS).map(read))));
      return stored;
    },

    stateRevision: (bucket) =>
      session(bucket, "HeadObject", async (calls) => {
        try {
          return revisionOf(
            await calls.headObject(bucket.bucket, bucket.accountId, FACTORY_STATE_KEY),
            bucket.bucket,
          );
        } catch (error) {
          if (httpStatus(error) === 404) return undefined;
          throw error;
        }
      }),

    async deleteBucket(bucket, interrupted) {
      const tally: Tally = { left: 0, complete: false, codes: new Set() };
      const listed = await deletePages(bucket, tally, interrupted);
      if ("kind" in listed) return listed;
      if (tally.codes.size > 0) return remains(tally, undefined, "held");
      return (
        (await deleteLock(bucket, listed.lock, tally, interrupted)) ??
        deleteEmptied(bucket, interrupted)
      );
    },

    logBreak: (bucket, key, entry: LockBreakEntry) =>
      session(bucket, "PutObject", async (calls) => {
        try {
          await calls.putNewObject(bucket.bucket, bucket.accountId, key, serializeLock(entry));
        } catch (error) {
          if (!REFUSED_WRITES.has(errorName(error) ?? "")) throw error;
          throw new AdapterRefusal(`A lock log entry already exists at ${key}`);
        }
      }),
  };
}
