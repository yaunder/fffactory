import { afterEach, describe, expect, test } from "bun:test";
import { breakFactoryLock } from "../../src/application/factory-lock";
import type { StateBucket } from "../../src/application/lock-store";
import { tlsOnlyPolicy } from "../../src/domain/backend-bootstrap";
import {
  lockBreakKey,
  newLockBreakEntry,
  newLockRecord,
  serializeLock,
} from "../../src/domain/factory-lock";
import { operationKey, startOperation, withStage } from "../../src/domain/operation";
import { FACTORY_STATE_KEY } from "../../src/domain/plan";
import type { FactoryId, Release } from "../../src/domain/instance";
import {
  S3_TIMEOUT_MS,
  type S3Calls,
  s3LockStore,
  sdkS3Calls,
} from "../../src/infrastructure/aws-s3-lock-store";
import type { AwsSession } from "../../src/infrastructure/aws-session";
import { EXAMPLE_CREDENTIALS } from "../support/stub-sts";
import { type StubS3, type StubS3Options, stubS3 } from "../support/stub-s3";

const FACTORY = "fff-abcd1234" as FactoryId;
const OWNER = "123456789012";
const BUCKET: StateBucket = {
  factoryId: FACTORY,
  bucket: "fff-abcd1234-state",
  accountId: OWNER,
  region: "eu-west-2",
  credentials: { source: "chain" },
};
const KEY = "fff-abcd1234-lock.json";
const RELEASE = "0.3.0" as Release;
const HOLDER = { principal: "arn:aws:sts::123456789012:assumed-role/Admin/op", host: "laptop" };
const RECORD = newLockRecord({
  factoryId: FACTORY,
  operation: "apply",
  holder: HOLDER,
  now: new Date("2026-09-30T10:00:00.000Z"),
  release: RELEASE,
  randomBytes: (count) => new Uint8Array(count),
});

const ALL_BLOCKED = {
  BlockPublicAcls: true,
  IgnorePublicAcls: true,
  BlockPublicPolicy: true,
  RestrictPublicBuckets: true,
};
const READY = { versioning: "Enabled", publicAccessBlocked: true, encrypted: true, tlsOnly: true };

/** An error shaped as the AWS SDK throws it. */
function sdkError(name: string, extra: Record<string, unknown> = { $fault: "client" }) {
  return Object.assign(new Error(`message quoting AWS: ${name}`), { name, ...extra });
}

/** Stubbed calls: each defaults to success; `script` overrides one. Records sessions and closes. */
function stubbed(script: Partial<S3Calls> = {}) {
  const sessions: AwsSession[] = [];
  let closed = 0;
  const open = async (session: AwsSession): Promise<S3Calls> => {
    sessions.push(session);
    return {
      headBucket: async () => {},
      bucketVersioning: async () => "Enabled",
      publicAccessBlock: async () => ALL_BLOCKED,
      bucketEncryption: async () => ["AES256"],
      bucketPolicy: async () => tlsOnlyPolicy(BUCKET.bucket),
      putNewObject: async () => ({ VersionId: "v1" }),
      getObject: async () => ({ VersionId: "v1", body: JSON.stringify(RECORD) }),
      deleteObjectVersion: async () => {},
      putObject: async () => {},
      headObject: async () => ({ VersionId: "v1", ETag: '"etag-1"' }),
      listObjectVersions: async () => ({ IsTruncated: false }),
      deleteObjects: async () => [],
      deleteBucket: async () => {},
      ...script,
      close: () => {
        closed += 1;
      },
    };
  };
  return { open, sessions, closed: () => closed };
}

describe("S3 lock store over stubbed calls", () => {
  test("opens each call's session in the factory Region with the selected profile", async () => {
    const stub = stubbed();
    const store = s3LockStore(stub.open);
    await store.bucketExists(BUCKET);
    await store.read({ ...BUCKET, credentials: { source: "--profile", profile: "factory" } });
    expect(stub.sessions.map(({ region, profile }) => ({ region, profile }))).toEqual([
      { region: "eu-west-2", profile: undefined },
      { region: "eu-west-2", profile: "factory" },
    ]);
    expect(stub.closed()).toBe(2);
  });

  /** HeadBucket's failures, as the SDK reports a bodiless answer: by HTTP status alone. */
  function headFailing(status: number) {
    return s3LockStore(
      stubbed({
        headBucket: async () => {
          throw sdkError(status === 404 ? "NotFound" : "Unknown", {
            $fault: "client",
            $metadata: { httpStatusCode: status },
          });
        },
      }).open,
    );
  }

  test("a bucket answering 404 does not exist", async () => {
    expect(await headFailing(404).bucketExists(BUCKET)).toBe(false);
  });

  test("a bucket owned by another account is refused, never created over", async () => {
    await expect(headFailing(403).bucketExists(BUCKET)).rejects.toThrow(
      "The state bucket fff-abcd1234-state is not accessible in account 123456789012: it " +
        "belongs to another account, or these credentials may not reach it (S3 answered 403)",
    );
  });

  test("a bucket in another Region is refused", async () => {
    await expect(headFailing(301).bucketExists(BUCKET)).rejects.toThrow(
      "The state bucket fff-abcd1234-state exists outside the factory Region eu-west-2 (S3 answered 301)",
    );
  });

  test("any other HeadBucket failure is named", async () => {
    await expect(headFailing(500).bucketExists(BUCKET)).rejects.toThrow(
      "S3 HeadBucket on the state bucket failed: Unknown",
    );
  });

  test("a bucket with every bootstrap setting is ready", async () => {
    expect(await s3LockStore(stubbed().open).bucketReadiness(BUCKET)).toEqual(READY);
  });

  test("settings S3 answers were never made leave the bucket unready", async () => {
    const missing = (name: string) => async () => {
      throw sdkError(name);
    };
    const store = s3LockStore(
      stubbed({
        bucketVersioning: async () => undefined,
        publicAccessBlock: missing("NoSuchPublicAccessBlockConfiguration"),
        bucketEncryption: missing("ServerSideEncryptionConfigurationNotFoundError"),
        bucketPolicy: missing("NoSuchBucketPolicy"),
      }).open,
    );
    expect(await store.bucketReadiness(BUCKET)).toEqual({
      versioning: undefined,
      publicAccessBlocked: false,
      encrypted: false,
      tlsOnly: false,
    });
  });

  test.each<[string, Partial<S3Calls>, Record<string, unknown>]>([
    [
      "suspended versioning",
      { bucketVersioning: async () => "Suspended" },
      { versioning: "Suspended" },
    ],
    [
      "an unknown versioning state, never shown",
      { bucketVersioning: async () => "\u001b[2J" },
      { versioning: undefined },
    ],
    [
      "a public access block with one setting off",
      { publicAccessBlock: async () => ({ ...ALL_BLOCKED, RestrictPublicBuckets: false }) },
      { publicAccessBlocked: false },
    ],
    [
      "a policy that allows plain HTTP",
      { bucketPolicy: async () => '{"Statement":[]}' },
      { tlsOnly: false },
    ],
  ])("reports %s", async (_, script, expected) => {
    const store = s3LockStore(stubbed(script).open);
    expect(await store.bucketReadiness(BUCKET)).toEqual({ ...READY, ...expected });
  });

  test("a bucket setting S3 refuses to show fails the readiness check", async () => {
    const store = s3LockStore(
      stubbed({
        bucketPolicy: async () => {
          throw sdkError("AccessDenied");
        },
      }).open,
    );
    await expect(store.bucketReadiness(BUCKET)).rejects.toThrow(
      "S3 GetBucketVersioning, GetPublicAccessBlock, GetBucketEncryption or GetBucketPolicy " +
        "on the state bucket failed: AccessDenied",
    );
  });

  test("a conflicting concurrent write is refused like an existing lock", async () => {
    const store = s3LockStore(
      stubbed({
        putNewObject: async () => {
          throw sdkError("ConditionalRequestConflict");
        },
        getObject: async () => {
          throw sdkError("NoSuchKey");
        },
      }).open,
    );
    expect(await store.create(BUCKET, RECORD)).toEqual({ created: false, held: undefined });
  });

  test.each([
    ["no version", {}],
    ["the null version of an unversioned bucket", { VersionId: "null" }],
  ])("a write answered with %s is removed again and refused", async (_, answer) => {
    const deleted: string[] = [];
    const store = s3LockStore(
      stubbed({
        putNewObject: async () => answer,
        deleteObjectVersion: async (_bucket, _owner, key, version) => {
          deleted.push(`${key} ${version}`);
        },
      }).open,
    );
    await expect(store.create(BUCKET, RECORD)).rejects.toThrow(
      "Versioning is not in effect yet on the state bucket fff-abcd1234-state, so the lock " +
        "was not taken (fffactory removed the unversioned lock it wrote); retry in a few minutes",
    );
    expect(deleted).toEqual([`${KEY} null`]);
  });

  test("an unversioned lock that cannot be removed again is named for a break", async () => {
    const store = s3LockStore(
      stubbed({
        putNewObject: async () => ({}),
        deleteObjectVersion: async () => {
          throw sdkError("AccessDenied");
        },
      }).open,
    );
    await expect(store.create(BUCKET, RECORD)).rejects.toThrow(
      "Versioning is not in effect yet on the state bucket fff-abcd1234-state, and fffactory " +
        "could not remove the unversioned lock it wrote (AccessDenied): break it with " +
        "`fffactory lock break`, then retry in a few minutes",
    );
  });

  test("an unprintable version is refused", async () => {
    const store = s3LockStore(
      stubbed({ putNewObject: async () => ({ VersionId: "v\u001b[2J" }) }).open,
    );
    await expect(store.create(BUCKET, RECORD)).rejects.toThrow(
      "The state bucket fff-abcd1234-state returned an unreadable object version",
    );
  });

  test.each([
    [sdkError("AccessDenied"), "S3 PutObject on the state bucket failed: AccessDenied"],
    [
      sdkError("CredentialsProviderError", {}),
      "S3 PutObject on the state bucket failed: the credential provider failed (CredentialsProviderError)",
    ],
    [
      sdkError("Error", { code: "ECONNREFUSED" }),
      "S3 PutObject on the state bucket failed: network error (ECONNREFUSED)",
    ],
    [sdkError("TypeError", {}), "S3 PutObject on the state bucket failed: unexpected TypeError"],
    ["not an error", "S3 PutObject on the state bucket failed: unexpected error"],
  ])("a failure is named, never quoted", async (failure, message) => {
    const store = s3LockStore(
      stubbed({
        putNewObject: async () => {
          throw failure;
        },
      }).open,
    );
    const error = await store.create(BUCKET, RECORD).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    expect((error as Error).message).not.toContain("message quoting AWS");
  });

  test("writes an operation record at its key, replacing the one before", async () => {
    const writes: string[][] = [];
    const store = s3LockStore(
      stubbed({
        putObject: async (...call) => {
          writes.push(call);
        },
      }).open,
    );
    const record = startOperation(RECORD, undefined);
    await store.writeOperation(BUCKET, record);
    expect(writes).toEqual([
      [BUCKET.bucket, OWNER, operationKey(record), `${JSON.stringify(record, null, 2)}\n`],
    ]);
  });

  test("the Terraform state's revision is its version and entity tag", async () => {
    const heads: string[][] = [];
    const store = s3LockStore(
      stubbed({
        headObject: async (...call) => {
          heads.push(call);
          return { VersionId: "v7", ETag: '"etag-7"' };
        },
      }).open,
    );
    expect(await store.stateRevision(BUCKET)).toBe('v7 "etag-7"');
    expect(heads).toEqual([[BUCKET.bucket, OWNER, FACTORY_STATE_KEY]]);
    const unversioned = s3LockStore(stubbed({ headObject: async () => ({ ETag: '"e"' }) }).open);
    expect(await unversioned.stateRevision(BUCKET)).toBe('null "e"');
  });

  test("no Terraform state yet has no revision; other failures are named", async () => {
    const missing = s3LockStore(
      stubbed({
        headObject: async () => {
          throw sdkError("NotFound", { $fault: "client", $metadata: { httpStatusCode: 404 } });
        },
      }).open,
    );
    expect(await missing.stateRevision(BUCKET)).toBeUndefined();
    const denied = s3LockStore(
      stubbed({
        headObject: async () => {
          throw sdkError("Forbidden", { $fault: "client", $metadata: { httpStatusCode: 403 } });
        },
      }).open,
    );
    await expect(denied.stateRevision(BUCKET)).rejects.toThrow(
      "S3 HeadObject on the state bucket failed: Forbidden",
    );
    const unprintable = s3LockStore(
      stubbed({ headObject: async () => ({ VersionId: "v\u001b[2J" }) }).open,
    );
    await expect(unprintable.stateRevision(BUCKET)).rejects.toThrow(
      "The state bucket fff-abcd1234-state returned an unreadable object version",
    );
  });

  test("a call past its deadline is aborted and fails", async () => {
    let signal: AbortSignal | undefined;
    const open = async (session: AwsSession): Promise<S3Calls> => {
      signal = session.abortSignal;
      return {
        ...(await stubbed().open(session)),
        // Rejects only once aborted, as the SDK does, after the deadline has failed the call.
        getObject: () =>
          new Promise((_, reject) =>
            session.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      };
    };
    await expect(s3LockStore(open, 50).read(BUCKET)).rejects.toThrow(
      "S3 GetObject on the state bucket failed: timed out after 0.05 s",
    );
    expect(signal?.aborted).toBe(true);
    expect(S3_TIMEOUT_MS).toBe(30_000);
  });
});

describe("S3 lock store with the real SDK against a local stub", () => {
  let stub: StubS3 | undefined;

  afterEach(() => {
    stub?.stop();
    stub = undefined;
  });

  function againstStub(options: StubS3Options, timeoutMs?: number) {
    stub = stubS3(options);
    const config = {
      endpoint: stub.endpoint,
      forcePathStyle: true,
      credentials: EXAMPLE_CREDENTIALS,
    };
    return s3LockStore(sdkS3Calls(config), timeoutMs);
  }

  const withBucket = { buckets: { [BUCKET.bucket]: { owner: OWNER } } };

  test("finds the bucket only in the factory's account", async () => {
    const store = againstStub({ ...withBucket, foreign: ["taken-elsewhere"] });
    expect(await store.bucketExists(BUCKET)).toBe(true);
    expect(await store.bucketExists({ ...BUCKET, bucket: "fff-abcd1234-missing" })).toBe(false);
    await expect(store.bucketExists({ ...BUCKET, bucket: "taken-elsewhere" })).rejects.toThrow(
      "belongs to another account",
    );
    await expect(store.bucketExists({ ...BUCKET, accountId: "210987654321" })).rejects.toThrow(
      "is not accessible in account 210987654321",
    );
    expect(stub?.requests[0]).toBe(`HEAD /${BUCKET.bucket} owner=${OWNER}`);
  });

  test("reads the settings backend bootstrap applies", async () => {
    const store = againstStub(withBucket);
    expect(await store.bucketReadiness(BUCKET)).toEqual(READY);
    expect([...(stub?.requests ?? [])].sort()).toEqual([
      `GET /${BUCKET.bucket}?encryption owner=${OWNER}`,
      `GET /${BUCKET.bucket}?policy owner=${OWNER}`,
      `GET /${BUCKET.bucket}?publicAccessBlock owner=${OWNER}`,
      `GET /${BUCKET.bucket}?versioning owner=${OWNER}`,
    ]);
  });

  test("reads a bucket an interrupted bootstrap left bare as unready", async () => {
    const store = againstStub({
      buckets: {
        [BUCKET.bucket]: {
          owner: OWNER,
          versioned: false,
          lacks: ["publicAccessBlock", "encryption", "policy"],
        },
      },
    });
    expect(await store.bucketReadiness(BUCKET)).toEqual({
      versioning: undefined,
      publicAccessBlocked: false,
      encrypted: false,
      tlsOnly: false,
    });
  });

  test("reads suspended versioning", async () => {
    const store = againstStub({
      buckets: { [BUCKET.bucket]: { owner: OWNER, versioned: "suspended" } },
    });
    expect(await store.bucketReadiness(BUCKET)).toEqual({ ...READY, versioning: "Suspended" });
  });

  test("creates the lock with a conditional write, and a second create is refused", async () => {
    const store = againstStub(withBucket);
    const first = await store.create(BUCKET, RECORD);
    expect(first).toEqual({ created: true, version: "stub-version-1" });
    expect(JSON.parse(stub?.objects.get(`${BUCKET.bucket}/${KEY}`)?.body ?? "")).toEqual(RECORD);
    const second = await store.create(BUCKET, { ...RECORD, lock_id: "bbbbbbbb" });
    expect(second).toEqual({ created: false, held: { version: "stub-version-1", record: RECORD } });
    expect(stub?.requests.filter((request) => request.startsWith("PUT"))).toEqual([
      `PUT /${BUCKET.bucket}/${KEY} if-none-match=* owner=${OWNER}`,
      `PUT /${BUCKET.bucket}/${KEY} if-none-match=* owner=${OWNER}`,
    ]);
  });

  test("a conflicting concurrent write reads the lock that won", async () => {
    const store = againstStub(withBucket);
    await store.create(BUCKET, RECORD);
    stub?.conflictNextPut();
    expect(await store.create(BUCKET, RECORD)).toMatchObject({
      created: false,
      held: { record: RECORD },
    });
  });

  test("reads an absent, readable or unreadable lock", async () => {
    const store = againstStub(withBucket);
    expect(await store.read(BUCKET)).toBeUndefined();
    await store.create(BUCKET, RECORD);
    expect(await store.read(BUCKET)).toEqual({ version: "stub-version-1", record: RECORD });
    stub?.objects.set(`${BUCKET.bucket}/${KEY}`, {
      version: "tampered",
      body: "{not json",
      etag: "e1",
    });
    expect(await store.read(BUCKET)).toEqual({ version: "tampered", record: undefined });
  });

  test("removes exactly the version it names", async () => {
    const store = againstStub(withBucket);
    await store.create(BUCKET, RECORD);
    await store.remove(BUCKET, "stub-version-0");
    expect(await store.read(BUCKET)).toBeDefined();
    await store.remove(BUCKET, "stub-version-1");
    expect(await store.read(BUCKET)).toBeUndefined();
    expect(stub?.requests.at(-2)).toBe(
      `DELETE /${BUCKET.bucket}/${KEY} versionId=stub-version-1 owner=${OWNER}`,
    );
  });

  test("writes operation records, each write replacing the last", async () => {
    const store = againstStub(withBucket);
    const record = startOperation(RECORD, undefined);
    const applying = withStage(record, "infrastructure", "applying", new Date());
    await store.writeOperation(BUCKET, record);
    await store.writeOperation(BUCKET, applying);
    const key = `${BUCKET.bucket}/${operationKey(record)}`;
    expect(JSON.parse(stub?.objects.get(key)?.body ?? "")).toEqual(applying);
    expect(stub?.requests.at(-1)).toBe(`PUT /${key} owner=${OWNER}`);
  });

  test("reads the Terraform state's revision, which every write changes", async () => {
    const store = againstStub(withBucket);
    expect(await store.stateRevision(BUCKET)).toBeUndefined();
    expect(stub?.requests.at(-1)).toBe(
      `HEAD /${BUCKET.bucket}/${FACTORY_STATE_KEY} owner=${OWNER}`,
    );
    const state = `${BUCKET.bucket}/${FACTORY_STATE_KEY}`;
    stub?.objects.set(state, { version: "state-1", body: "{}", etag: "e1" });
    expect(await store.stateRevision(BUCKET)).toBe('state-1 "e1"');
    stub?.objects.set(state, { version: "state-2", body: "{}", etag: "e2" });
    expect(await store.stateRevision(BUCKET)).toBe('state-2 "e2"');
  });

  test("logs a break under its own key, never replacing an entry", async () => {
    const store = againstStub(withBucket);
    const now = new Date("2026-09-30T12:00:00.000Z");
    const key = lockBreakKey(FACTORY, now, RECORD.lock_id);
    const entry = newLockBreakEntry({ version: "v1", record: RECORD }, HOLDER, now, RELEASE);
    await store.logBreak(BUCKET, key, entry);
    expect(JSON.parse(stub?.objects.get(`${BUCKET.bucket}/${key}`)?.body ?? "")).toEqual(entry);
    await expect(store.logBreak(BUCKET, key, entry)).rejects.toThrow(
      `A lock log entry already exists at ${key}`,
    );
  });

  test.each([
    ["a never-versioned", false],
    ["a versioning-suspended", "suspended"],
  ] as const)("%s bucket refuses the lock and keeps nothing", async (_, versioned) => {
    const store = againstStub({ buckets: { [BUCKET.bucket]: { owner: OWNER, versioned } } });
    await expect(store.create(BUCKET, RECORD)).rejects.toThrow(
      "Versioning is not in effect yet on the state bucket fff-abcd1234-state",
    );
    expect([...(stub?.objects.keys() ?? [])]).toEqual([]);
    expect(stub?.requests.at(-1)).toBe(
      `DELETE /${BUCKET.bucket}/${KEY} versionId=null owner=${OWNER}`,
    );
    expect(await store.read(BUCKET)).toBeUndefined();
  });

  test("a retried write that finds its own unversioned lock removes it and refuses", async () => {
    const store = againstStub({ buckets: { [BUCKET.bucket]: { owner: OWNER, versioned: false } } });
    stub?.objects.set(`${BUCKET.bucket}/${KEY}`, {
      version: "null",
      body: serializeLock(RECORD),
      etag: "e1",
    });
    await expect(store.create(BUCKET, RECORD)).rejects.toThrow("Versioning is not in effect yet");
    expect(stub?.objects.size).toBe(0);
  });

  test.each([
    ["a never-versioned", false],
    ["a versioned", true],
  ] as const)(
    "a null-version lock left in %s bucket is held, and can be broken",
    async (_, versioned) => {
      const store = againstStub({ buckets: { [BUCKET.bucket]: { owner: OWNER, versioned } } });
      stub?.objects.set(`${BUCKET.bucket}/${KEY}`, {
        version: "null",
        body: serializeLock(RECORD),
        etag: "e1",
      });
      const held = { version: "null", record: RECORD };
      expect(await store.read(BUCKET)).toEqual(held);
      expect(await store.create(BUCKET, { ...RECORD, lock_id: "bbbbbbbb" })).toEqual({
        created: false,
        held,
      });
      const result = await breakFactoryLock(store, {
        bucket: BUCKET,
        held,
        confirmation: RECORD.lock_id,
        breaker: HOLDER,
        now: new Date("2026-09-30T12:00:00.000Z"),
        release: RELEASE,
      });
      expect(result.kind).toBe("broken");
      expect(await store.read(BUCKET)).toBeUndefined();
      expect(stub?.requests).toContain(
        `DELETE /${BUCKET.bucket}/${KEY} versionId=null owner=${OWNER}`,
      );
    },
  );

  test("an S3 error is reported by its code", async () => {
    const store = againstStub({ error: { status: 403, code: "AccessDenied" } });
    await expect(store.read(BUCKET)).rejects.toThrow(
      "S3 GetObject on the state bucket failed: AccessDenied",
    );
  });

  test("a selected profile comes only from the shared files, which here have none", async () => {
    stub = stubS3(withBucket);
    const store = s3LockStore(sdkS3Calls({ endpoint: stub.endpoint, forcePathStyle: true }));
    await expect(
      store.read({ ...BUCKET, credentials: { source: "--profile", profile: "missing" } }),
    ).rejects.toThrow("the credential provider failed (CredentialsProviderError)");
    expect(stub.requests).toEqual([]);
  });

  test("a stub that never answers times out", async () => {
    const store = againstStub({ hang: true }, 300);
    await expect(store.bucketExists(BUCKET)).rejects.toThrow("timed out after 0.3 s");
  });

  test("a closed port is a network error", async () => {
    const closed = stubS3();
    closed.stop();
    const config = {
      endpoint: closed.endpoint,
      forcePathStyle: true,
      credentials: EXAMPLE_CREDENTIALS,
    };
    await expect(s3LockStore(sdkS3Calls(config)).read(BUCKET)).rejects.toThrow(
      "network error (ECONNREFUSED)",
    );
  });
});

describe("deleting the state bucket over stubbed calls", () => {
  /** When a listed version was written: `second` seconds after the first. */
  const at = (second: number) => new Date(Date.UTC(2026, 8, 30, 10, 0, second));
  const STATE = { Key: FACTORY_STATE_KEY, VersionId: "s1", LastModified: at(1) };
  const RECORDS = {
    Key: `${FACTORY}-operations/2026-09-30T10:00:00.000Z-aaaaaaaa.json`,
    IsLatest: true,
    LastModified: at(0),
  };
  const LOCK_VERSION = { Key: KEY, VersionId: "l2", IsLatest: true, LastModified: at(2) };
  const LOCK_MARKER = { Key: KEY, VersionId: "l1", LastModified: at(1) };

  /** Stubbed calls that record each call as a line, with `script` overriding any of them. */
  function recording(script: Partial<S3Calls> = {}, timeoutMs = S3_TIMEOUT_MS) {
    const calls: string[] = [];
    const stub = stubbed({
      listObjectVersions: async (_, __, marker) => {
        calls.push(`list ${marker ? `${marker.key} ${marker.version}` : "from the start"}`);
        if (marker)
          return { IsTruncated: false, Versions: [LOCK_VERSION], DeleteMarkers: [LOCK_MARKER] };
        return {
          IsTruncated: true,
          NextKeyMarker: "page-2",
          NextVersionIdMarker: "p2",
          Versions: [STATE, RECORDS],
          DeleteMarkers: [
            { Key: FACTORY_STATE_KEY, VersionId: "s2", IsLatest: true, LastModified: at(2) },
          ],
        };
      },
      deleteObjects: async (_, __, versions) => {
        calls.push(`delete ${versions.map(({ key, version }) => `${key}@${version}`).join(" ")}`);
        return [];
      },
      deleteBucket: async () => {
        calls.push("delete bucket");
      },
      ...script,
    });
    return { store: s3LockStore(stub.open, timeoutMs), calls, stub };
  }

  /** Pages of other keys' versions: `sizes[i]` versions on page `i`, the lock on the last. */
  function pages(...sizes: number[]): S3Calls["listObjectVersions"] {
    return async (_, __, marker) => {
      const page = marker ? Number(marker.key) : 0;
      const last = page === sizes.length - 1;
      const versions = Array.from({ length: sizes[page] ?? 0 }, (_, index) => ({
        Key: `p${page}-k${index}`,
        VersionId: "v",
        IsLatest: true,
        LastModified: at(0),
      }));
      return {
        IsTruncated: !last,
        ...(last ? {} : { NextKeyMarker: String(page + 1) }),
        Versions: last ? [...versions, LOCK_VERSION] : versions,
      };
    };
  }

  test("deletes each page as it is listed, then the lock's, the current one alone and last, then the bucket", async () => {
    const { store, calls, stub } = recording();
    expect(await store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
    expect(calls).toEqual([
      "list from the start",
      `delete ${FACTORY_STATE_KEY}@s1 ${RECORDS.Key}@null ${FACTORY_STATE_KEY}@s2`,
      "list page-2 p2",
      `delete ${KEY}@l1`,
      `delete ${KEY}@l2`,
      "delete bucket",
    ]);
    expect(stub.closed()).toBe(6);
  });

  test("a current delete marker on the lock, which S3 lists apart, goes after the version under it", async () => {
    const { store, calls } = recording({
      listObjectVersions: async () => ({
        IsTruncated: false,
        Versions: [STATE, { Key: KEY, VersionId: "l1", LastModified: at(1) }],
        DeleteMarkers: [{ Key: KEY, VersionId: "m2", IsLatest: true, LastModified: at(2) }],
      }),
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
    expect(calls).toEqual([
      `delete ${FACTORY_STATE_KEY}@s1`,
      `delete ${KEY}@l1`,
      `delete ${KEY}@m2`,
      "delete bucket",
    ]);
  });

  test("a version S3 would not delete keeps the lock and the bucket", async () => {
    const { store, calls } = recording({
      deleteObjects: async (_, __, versions) => {
        calls.push(`delete ${versions.length}`);
        return [
          { Key: FACTORY_STATE_KEY, VersionId: "s1", Code: "AccessDenied" },
          { Key: FACTORY_STATE_KEY, VersionId: "s2", Code: "AccessDenied" },
          { Key: RECORDS.Key, Code: "InternalError" },
        ];
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: 5,
      codes: ["AccessDenied", "InternalError"],
      failure: undefined,
      lock: "held",
    });
    expect(calls).toEqual(["list from the start", "delete 3", "list page-2 p2"]);
  });

  test("every page of other keys is listed and deleted before the lock is kept", async () => {
    const { store, calls } = recording({
      listObjectVersions: pages(1000, 500),
      deleteObjects: async (_, __, versions) => {
        calls.push(`delete ${versions.length}`);
        return versions.length === 1000 ? [{ Key: "p0-k0", VersionId: "v", Code: "SlowDown" }] : [];
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: 2,
      codes: ["SlowDown"],
      failure: undefined,
      lock: "held",
    });
    expect(calls).toEqual(["delete 1000", "delete 500"]);
  });

  test("a version of the lock S3 would not delete keeps the current one, and the bucket", async () => {
    const { store, calls } = recording({
      deleteObjects: async (_, __, versions) => {
        calls.push(`delete ${versions.length}`);
        return versions[0]?.key === KEY
          ? [{ Key: KEY, VersionId: "l1", Code: "AccessDenied" }]
          : [];
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: 2,
      codes: ["AccessDenied"],
      failure: undefined,
      lock: "unknown",
    });
    expect(calls).toEqual(["list from the start", "delete 3", "list page-2 p2", "delete 1"]);
  });

  test("the lock's calls stop at the first that reports a refusal", async () => {
    const lock = Array.from({ length: 1001 }, (_, index) => ({
      Key: KEY,
      VersionId: `l${1000 - index}`,
      IsLatest: index === 0,
      LastModified: at(1000 - index),
    }));
    const { store, calls } = recording({
      listObjectVersions: async () => ({ IsTruncated: false, Versions: lock }),
      deleteObjects: async (_, __, versions) => {
        calls.push(`delete ${versions.length} from ${versions[0]?.version}`);
        return [{ Key: KEY, VersionId: "l0", Code: "AccessDenied" }];
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: 2,
      codes: ["AccessDenied"],
      failure: undefined,
      lock: "unknown",
    });
    expect(calls).toEqual(["delete 1000 from l0"]);
  });

  test("an error code that is no plain name is shown as Unknown", async () => {
    const { store } = recording({
      deleteObjects: async () => [{ Key: KEY, Code: "\u001b[31mred" }, { Key: KEY }],
    });
    expect(await store.deleteBucket(BUCKET)).toMatchObject({ codes: ["Unknown"] });
  });

  test("a failed DeleteObjects call stops at once, the rest unlisted and the lock held", async () => {
    const { store, calls } = recording({
      deleteObjects: async () => {
        calls.push("delete");
        throw sdkError("AccessDenied");
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: undefined,
      codes: [],
      failure: "S3 DeleteObjects on the state bucket failed: AccessDenied",
      lock: "held",
    });
    expect(calls).toEqual(["list from the start", "delete"]);
  });

  test("a failed DeleteObjects call on the last page leaves a known count", async () => {
    const { store } = recording({
      listObjectVersions: pages(2),
      deleteObjects: async () => {
        throw sdkError("AccessDenied");
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: 3,
      codes: [],
      failure: "S3 DeleteObjects on the state bucket failed: AccessDenied",
      lock: "held",
    });
  });

  test("a failed call deleting the lock's versions may have left the factory unlocked", async () => {
    const { store } = recording({
      deleteObjects: async (_, __, versions) => {
        if (versions[0]?.key === KEY) throw sdkError("InternalError", { $fault: "server" });
        return [];
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: 2,
      codes: [],
      failure: "S3 DeleteObjects on the state bucket failed: InternalError",
      lock: "unknown",
    });
  });

  test("a listing that fails leaves an unknown count", async () => {
    const { store } = recording({
      listObjectVersions: async () => {
        throw sdkError("AccessDenied", { $fault: "client", $metadata: { httpStatusCode: 403 } });
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: undefined,
      codes: [],
      failure: "S3 ListObjectVersions on the state bucket failed: AccessDenied",
      lock: "held",
    });
  });

  test("a listing that fails on a later page keeps what the earlier pages deleted", async () => {
    const list = pages(1000, 1000, 1);
    const { store, calls } = recording({
      listObjectVersions: async (bucket, owner, marker) => {
        calls.push(`list ${marker?.key ?? 0}`);
        if (marker?.key === "2") throw sdkError("InternalError", { $fault: "server" });
        return list(bucket, owner, marker);
      },
      deleteObjects: async (_, __, versions) => {
        calls.push(`delete ${versions.length}`);
        return [];
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: undefined,
      codes: [],
      failure: "S3 ListObjectVersions on the state bucket failed: InternalError",
      lock: "held",
    });
    expect(calls).toEqual(["list 0", "delete 1000", "list 1", "delete 1000", "list 2"]);
  });

  test("a truncated listing with nothing to go on from is refused, never looped on", async () => {
    const { store } = recording({ listObjectVersions: async () => ({ IsTruncated: true }) });
    expect(await store.deleteBucket(BUCKET)).toMatchObject({
      kind: "remains",
      versions: undefined,
      failure:
        "S3 listed the versions in the state bucket fff-abcd1234-state without saying where " +
        "the next page starts",
    });
  });

  test("a listed version without a key is refused", async () => {
    const { store } = recording({
      listObjectVersions: async () => ({ Versions: [{ VersionId: "v1", LastModified: at(0) }] }),
    });
    expect(await store.deleteBucket(BUCKET)).toMatchObject({
      kind: "remains",
      failure: "S3 listed a version in the state bucket fff-abcd1234-state without its key",
    });
  });

  test("a listed version without when it was written is refused, never guessed", async () => {
    const { store, calls } = recording({
      listObjectVersions: async () => ({
        DeleteMarkers: [{ Key: KEY, VersionId: "m1", IsLatest: true }],
      }),
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: undefined,
      codes: [],
      failure:
        "S3 listed a version of fff-abcd1234-lock.json in the state bucket fff-abcd1234-state " +
        "without when it was written",
      lock: "held",
    });
    expect(calls).toEqual([]);
  });

  test("DeleteBucket refused for versions written since leaves an unknown count", async () => {
    const { store } = recording({
      deleteBucket: async () => {
        throw sdkError("BucketNotEmpty");
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: undefined,
      codes: [],
      failure: "S3 DeleteBucket on the state bucket failed: BucketNotEmpty",
      lock: "deleted",
    });
  });

  test("DeleteBucket refused otherwise leaves the bucket empty and the factory unlocked", async () => {
    const { store } = recording({
      deleteBucket: async () => {
        throw sdkError("AccessDenied");
      },
    });
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: 0,
      codes: [],
      failure: "S3 DeleteBucket on the state bucket failed: AccessDenied",
      lock: "deleted",
    });
  });

  const notFound = () => {
    throw sdkError("NoSuchBucket", { $fault: "client", $metadata: { httpStatusCode: 404 } });
  };

  test.each<[string, Partial<S3Calls>]>([
    ["listing", { listObjectVersions: async () => notFound() }],
    ["deleting versions", { deleteObjects: async () => notFound() }],
    ["deleting the bucket", { deleteBucket: async () => notFound() }],
  ])("a bucket S3 answers 404 for while %s is absent", async (_, script) => {
    expect(await recording(script).store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
  });

  test("a call past its deadline is aborted, and the bucket remains", async () => {
    const open = async (session: AwsSession): Promise<S3Calls> => ({
      ...(await stubbed().open(session)),
      listObjectVersions: async () => ({ Versions: [STATE] }),
      deleteObjects: () =>
        new Promise((_, reject) =>
          session.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    expect(await s3LockStore(open, 50).deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: 1,
      codes: [],
      failure: "S3 DeleteObjects on the state bucket failed: timed out after 0.05 s",
      lock: "held",
    });
  });

  test("each page and each batch has a deadline of its own", async () => {
    const list = pages(1, 1, 1, 1);
    const slowly = <T>(answer: Promise<T>) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(answer), 30));
    const { store } = recording(
      {
        listObjectVersions: (bucket, owner, marker) => slowly(list(bucket, owner, marker)),
        deleteObjects: () => slowly(Promise.resolve([])),
      },
      100,
    );
    expect(await store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
  });
});

describe("deleting the state bucket with the real SDK against a local stub", () => {
  let stub: StubS3 | undefined;

  afterEach(() => {
    stub?.stop();
    stub = undefined;
  });

  function againstStub(options: StubS3Options = {}) {
    stub = stubS3({ buckets: { [BUCKET.bucket]: { owner: OWNER } }, ...options });
    const config = {
      endpoint: stub.endpoint,
      forcePathStyle: true,
      credentials: EXAMPLE_CREDENTIALS,
    };
    return s3LockStore(sdkS3Calls(config));
  }

  /** A bucket as a factory leaves it: state, records, a broken lock's log, and the lock. */
  async function usedBucket(store: ReturnType<typeof againstStub>) {
    const record = startOperation(RECORD, undefined);
    await store.writeOperation(BUCKET, record);
    await store.writeOperation(BUCKET, withStage(record, "infrastructure", "applying", new Date()));
    const now = new Date("2026-09-30T12:00:00.000Z");
    const entry = newLockBreakEntry({ version: "v0", record: RECORD }, HOLDER, now, RELEASE);
    await store.logBreak(BUCKET, lockBreakKey(FACTORY, now, RECORD.lock_id), entry);
    stub?.addVersions(BUCKET.bucket, FACTORY_STATE_KEY, 3);
    stub?.addVersions(BUCKET.bucket, FACTORY_STATE_KEY, 1, true);
    stub?.addVersions(BUCKET.bucket, `${FACTORY_STATE_KEY}.tflock`, 1, true);
    stub?.addVersions(BUCKET.bucket, KEY, 1, true);
    const created = await store.create(BUCKET, RECORD);
    if (!created.created) throw new Error("the lock was not created");
    return created.version;
  }

  test("empties a versioned bucket, the lock last, and deletes it", async () => {
    const store = againstStub();
    const held = await usedBucket(store);
    expect(stub?.stored(BUCKET.bucket)).toBe(10);
    expect(await store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
    expect(stub?.stored(BUCKET.bucket)).toBe(0);
    expect(await store.bucketExists(BUCKET)).toBe(false);
    const [others, older, current, ...more] = stub?.deleteBatches ?? [];
    expect(more).toEqual([]);
    expect(others).toHaveLength(8);
    expect(others?.some((entry) => entry.startsWith(`${KEY} `))).toBe(false);
    expect(older?.map((entry) => entry.split(" ")[0])).toEqual([KEY]);
    expect(current).toEqual([`${KEY} ${held}`]);
    const sent = stub?.requests.slice(
      stub.requests.findIndex((line) => line.includes("?versions")),
    );
    expect(sent?.map((line) => line.split(" ")[0])).toEqual([
      "GET",
      "POST",
      "POST",
      "POST",
      "DELETE",
      "HEAD",
    ]);
    expect(sent?.at(-2)).toBe(`DELETE /${BUCKET.bucket} owner=${OWNER}`);
  });

  test("every request carries the factory's account as the expected owner", async () => {
    const store = againstStub();
    await usedBucket(store);
    await store.deleteBucket(BUCKET);
    expect(stub?.requests.every((line) => line.endsWith(`owner=${OWNER}`))).toBe(true);
  });

  test("a bucket owned by another account is never emptied, and remains", async () => {
    const store = againstStub();
    await usedBucket(store);
    expect(await store.deleteBucket({ ...BUCKET, accountId: "210987654321" })).toEqual({
      kind: "remains",
      versions: undefined,
      codes: [],
      failure: "S3 ListObjectVersions on the state bucket failed: AccessDenied",
      lock: "held",
    });
    expect(stub?.stored(BUCKET.bucket)).toBe(10);
  });

  test("more than 1000 versions are deleted page by page as they are listed", async () => {
    const store = againstStub();
    stub?.addVersions(BUCKET.bucket, FACTORY_STATE_KEY, 1500);
    expect(await store.create(BUCKET, RECORD)).toMatchObject({ created: true });
    expect(await store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
    expect(stub?.deleteBatches.map((batch) => batch.length)).toEqual([1000, 500, 1]);
    const sent = stub?.requests.slice(
      stub.requests.findIndex((line) => line.includes("?versions")),
    );
    expect(sent?.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      `GET /${BUCKET.bucket}?versions`,
      `POST /${BUCKET.bucket}?delete`,
      `GET /${BUCKET.bucket}?versions`,
      `POST /${BUCKET.bucket}?delete`,
      `POST /${BUCKET.bucket}?delete`,
      `DELETE /${BUCKET.bucket}`,
    ]);
  });

  test("the lock's versions are deleted oldest first, the current one alone and last", async () => {
    const store = againstStub();
    const [newer, older] = stub?.addVersions(BUCKET.bucket, KEY, 2) ?? [];
    const created = await store.create(BUCKET, RECORD);
    expect(created).toMatchObject({ created: true });
    expect(await store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
    const current = created.created ? created.version : "";
    expect(stub?.deleteBatches).toEqual([
      [`${KEY} ${older}`, `${KEY} ${newer}`],
      [`${KEY} ${current}`],
    ]);
  });

  test("a delete marker on the lock, newer than a version under it, is deleted after it", async () => {
    const store = againstStub();
    const first = await store.create(BUCKET, RECORD);
    const marker = stub?.markDeleted(BUCKET.bucket, KEY);
    expect(await store.read(BUCKET)).toBeUndefined();
    const second = await store.create(BUCKET, RECORD);
    if (!first.created || !second.created) throw new Error("the lock was not created");
    expect(await store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
    expect(stub?.deleteBatches).toEqual([
      [`${KEY} ${first.version}`, `${KEY} ${marker}`],
      [`${KEY} ${second.version}`],
    ]);
  });

  test("the stub, as S3, makes the version under a current delete marker current once it is deleted", async () => {
    const store = againstStub();
    const first = await store.create(BUCKET, RECORD);
    const marker = stub?.markDeleted(BUCKET.bucket, KEY) as string;
    expect(await store.read(BUCKET)).toBeUndefined();
    await store.remove(BUCKET, marker);
    expect(await store.read(BUCKET)).toEqual({
      version: first.created ? first.version : "",
      record: RECORD,
    });
  });

  test("the stub, as S3, resumes after a version marker once that version is deleted, and refuses one it never gave", async () => {
    againstStub();
    const [newest, middle, oldest] = stub?.addVersions(BUCKET.bucket, KEY, 3) ?? [];
    const calls = await sdkS3Calls({
      endpoint: stub?.endpoint,
      forcePathStyle: true,
      credentials: EXAMPLE_CREDENTIALS,
    })({ region: BUCKET.region, profile: undefined, abortSignal: new AbortController().signal });
    try {
      await calls.deleteObjects(BUCKET.bucket, OWNER, [{ key: KEY, version: newest as string }]);
      const page = await calls.listObjectVersions(BUCKET.bucket, OWNER, {
        key: KEY,
        version: newest,
      });
      expect(page.Versions?.map(({ VersionId, IsLatest }) => [VersionId, IsLatest])).toEqual([
        [middle, true],
        [oldest, false],
      ]);
      await expect(
        calls.listObjectVersions(BUCKET.bucket, OWNER, { key: KEY, version: "never-given" }),
      ).rejects.toMatchObject({ name: "InvalidArgument" });
    } finally {
      calls.close();
    }
  });

  test("a version S3 would not delete leaves the lock held and the bucket in place", async () => {
    const store = againstStub({ undeletable: { [FACTORY_STATE_KEY]: "AccessDenied" } });
    await usedBucket(store);
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: 6,
      codes: ["AccessDenied"],
      failure: undefined,
      lock: "held",
    });
    expect(await store.read(BUCKET)).toEqual({ version: expect.any(String), record: RECORD });
    expect(await store.bucketExists(BUCKET)).toBe(true);
    expect(stub?.stored(BUCKET.bucket)).toBe(6);
  });

  test("DeleteBucket refused for a version written since the listing", async () => {
    const store = againstStub({
      afterListing: () => {
        stub?.addVersions(BUCKET.bucket, "late.json", 1);
      },
    });
    stub?.addVersions(BUCKET.bucket, FACTORY_STATE_KEY, 1);
    expect(await store.deleteBucket(BUCKET)).toEqual({
      kind: "remains",
      versions: undefined,
      codes: [],
      failure: "S3 DeleteBucket on the state bucket failed: BucketNotEmpty",
      lock: "deleted",
    });
    expect(await store.bucketExists(BUCKET)).toBe(true);
  });

  test("a bucket already gone is absent, and nothing else is asked", async () => {
    const store = againstStub({ buckets: {} });
    expect(await store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
    expect(stub?.requests).toEqual([`GET /${BUCKET.bucket}?versions owner=${OWNER}`]);
  });

  test("an empty bucket is deleted at once", async () => {
    const store = againstStub();
    expect(await store.deleteBucket(BUCKET)).toEqual({ kind: "absent" });
    expect(stub?.deleteBatches).toEqual([]);
  });
});
