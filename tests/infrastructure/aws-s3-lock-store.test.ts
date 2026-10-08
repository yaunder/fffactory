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
