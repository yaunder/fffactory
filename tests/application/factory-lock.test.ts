import { describe, expect, test } from "bun:test";
import {
  acquireFactoryLock,
  breakFactoryLock,
  type FactoryLockRequest,
  lockHolder,
  releaseFactoryLock,
  stateBucketOf,
  settleFactoryLock,
  withFactoryLock,
} from "../../src/application/factory-lock";
import type { StateBucket } from "../../src/application/lock-store";
import type { AllowedAccount } from "../../src/application/require-expected-account";
import { lockRefusal, newLockRecord } from "../../src/domain/factory-lock";
import type { FactoryId, FactoryInstance, Release } from "../../src/domain/instance";
import { FAKE_CALLER } from "../support/doctor-fakes";
import { MemoryLockStore } from "../support/memory-lock-store";

const FACTORY = "fff-abcd1234" as FactoryId;
const RELEASE = "0.3.0" as Release;
const BUCKET: StateBucket = {
  factoryId: FACTORY,
  bucket: "fff-abcd1234-state",
  accountId: "123456789012",
  region: "eu-west-2",
  credentials: { source: "chain" },
};
const NOW = new Date("2026-09-30T10:00:00.000Z");
const FIRST = { principal: "arn:aws:sts::123456789012:assumed-role/Admin/first", host: "laptop" };
const SECOND = { principal: "arn:aws:sts::123456789012:assumed-role/Admin/second", host: "desk" };

/** Random bytes that give each request its own lock ID: `aaaaaaaa`, `bbbbbbbb`, ... */
function bytesOf(letter: number) {
  return (count: number) => new Uint8Array(count).fill(letter);
}

function request(holder = FIRST, letter = 0): FactoryLockRequest {
  return {
    bucket: BUCKET,
    operation: "apply",
    holder,
    release: RELEASE,
    now: NOW,
    randomBytes: bytesOf(letter),
  };
}

function storeWithBucket() {
  return new MemoryLockStore([BUCKET.bucket]);
}

describe("acquiring the factory lock", () => {
  test("creates the lock recording holder, operation and time", async () => {
    const store = storeWithBucket();
    const acquisition = await acquireFactoryLock(store, request());
    if (!acquisition.acquired) throw new Error("not acquired");
    expect(acquisition.lock.record).toEqual({
      schema_version: 1,
      lock_id: "aaaaaaaa",
      factory_id: FACTORY,
      operation: "apply",
      holder: FIRST,
      acquired_at: NOW.toISOString(),
      release: RELEASE,
    });
    expect(store.locks.get(BUCKET.bucket)).toEqual({
      version: acquisition.lock.version,
      record: acquisition.lock.record,
    });
  });

  test("a concurrent apply is refused with the holder shown", async () => {
    const store = storeWithBucket();
    const first = await acquireFactoryLock(store, request(FIRST, 0));
    const second = await acquireFactoryLock(store, request(SECOND, 1));
    expect(first.acquired).toBe(true);
    if (second.acquired) throw new Error("second apply acquired a held lock");
    expect(second.held?.record?.holder).toEqual(FIRST);
    expect(lockRefusal(second.held, NOW)).toContain(
      "  Lock aaaaaaaa: apply by arn:aws:sts::123456789012:assumed-role/Admin/first on laptop",
    );
    expect(store.locks.get(BUCKET.bucket)?.record?.holder).toEqual(FIRST);
  });

  test("two racing acquisitions: exactly one wins", async () => {
    const store = storeWithBucket();
    const results = await Promise.all([
      acquireFactoryLock(store, request(FIRST, 0)),
      acquireFactoryLock(store, request(SECOND, 1)),
    ]);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  test("an unreadable lock is held, never treated as absent", async () => {
    const store = storeWithBucket();
    const unreadable = store.hold(BUCKET.bucket, undefined);
    const acquisition = await acquireFactoryLock(store, request());
    expect(acquisition).toEqual({ acquired: false, held: unreadable });
  });

  test("a lock that vanished before it could be read is retried", async () => {
    const store = storeWithBucket();
    const other = newLockRecord({ ...request(SECOND, 1), factoryId: FACTORY });
    store.hold(BUCKET.bucket, other);
    store.beforeRead = () => store.locks.delete(BUCKET.bucket);
    const acquisition = await acquireFactoryLock(store, request());
    expect(acquisition.acquired).toBe(true);
  });

  test("a retried write that finds this operation's own lock has acquired it", async () => {
    // An SDK retry of a PutObject whose first attempt succeeded, but lost its answer, gets 412.
    const store = storeWithBucket();
    const retried: MemoryLockStore = Object.assign(store, {
      create: async (_: StateBucket, record: ReturnType<typeof newLockRecord>) => ({
        created: false as const,
        held: store.hold(BUCKET.bucket, record),
      }),
    });
    const acquisition = await acquireFactoryLock(retried, request());
    if (!acquisition.acquired) throw new Error("its own lock was reported as another's");
    expect(acquisition.lock.version).toBe(store.locks.get(BUCKET.bucket)?.version as string);
    expect(acquisition.lock.record.lock_id).toBe("aaaaaaaa");
  });

  test("a host name outside printable ASCII is recorded so the lock stays readable", async () => {
    const store = storeWithBucket();
    const acquisition = await acquireFactoryLock(
      store,
      request({ ...FIRST, host: "\u00e9t\u00e9\n" }),
    );
    if (!acquisition.acquired) throw new Error("not acquired");
    expect(acquisition.lock.record.holder.host).toBe("?t??");
  });

  test("gives up, holding nothing, when the lock keeps vanishing", async () => {
    const store = storeWithBucket();
    const vanishing: MemoryLockStore = Object.assign(store, {
      create: async () => ({ created: false as const, held: undefined }),
    });
    expect(await acquireFactoryLock(vanishing, request())).toEqual({
      acquired: false,
      held: undefined,
    });
  });

  test("releasing removes only this lock", async () => {
    const store = storeWithBucket();
    const acquisition = await acquireFactoryLock(store, request());
    if (!acquisition.acquired) throw new Error("not acquired");
    await releaseFactoryLock(store, acquisition.lock);
    expect(store.locks.has(BUCKET.bucket)).toBe(false);
    expect((await acquireFactoryLock(store, request(SECOND, 1))).acquired).toBe(true);
  });
});

describe("withFactoryLock", () => {
  test("one lock covers every stage, and is released when the work ends", async () => {
    const store = storeWithBucket();
    const refusedDuring: boolean[] = [];
    const stages = ["infrastructure", "workers", "repositories", "dispatch", "verification"];
    const result = await withFactoryLock(store, request(), async (lock) => {
      for (const stage of stages) {
        const other = await acquireFactoryLock(store, request(SECOND, 1));
        refusedDuring.push(!other.acquired && other.held?.version === lock.version);
        await Promise.resolve(stage);
      }
      return "converged";
    });
    expect(result).toEqual({ acquired: true, value: "converged" });
    expect(refusedDuring).toEqual(stages.map(() => true));
    expect(store.locks.has(BUCKET.bucket)).toBe(false);
  });

  test("a failed stage still releases the lock, and the failure propagates", async () => {
    const store = storeWithBucket();
    const failure = new Error("terraform apply exited with status 1");
    await expect(
      withFactoryLock(store, request(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(store.locks.has(BUCKET.bucket)).toBe(false);
  });

  test("never runs the work without the lock", async () => {
    const store = storeWithBucket();
    const held = store.hold(
      BUCKET.bucket,
      newLockRecord({ ...request(SECOND, 1), factoryId: FACTORY }),
    );
    let ran = false;
    const result = await withFactoryLock(store, request(), async () => {
      ran = true;
    });
    expect(result).toEqual({ acquired: false, held });
    expect(ran).toBe(false);
    expect(store.locks.get(BUCKET.bucket)).toBe(held);
  });
});

describe("breaking the factory lock", () => {
  const breaker = SECOND;

  function heldBy(store: MemoryLockStore) {
    return store.hold(BUCKET.bucket, newLockRecord({ ...request(FIRST, 0), factoryId: FACTORY }));
  }

  test("an unconfirmed break changes nothing and logs nothing", async () => {
    const store = storeWithBucket();
    const held = heldBy(store);
    for (const confirmation of ["", "yes", "y", held.version, "bbbbbbbb"]) {
      const result = await breakFactoryLock(store, {
        bucket: BUCKET,
        held,
        confirmation,
        breaker,
        now: NOW,
        release: RELEASE,
      });
      expect(result).toEqual({ kind: "not_confirmed" });
    }
    expect(store.locks.get(BUCKET.bucket)).toBe(held);
    expect(store.logs.size).toBe(0);
    expect(store.calls.filter((call) => !call.startsWith("read"))).toEqual([]);
  });

  test("a confirmed break is logged in the state bucket, then removes the lock", async () => {
    const store = storeWithBucket();
    const held = heldBy(store);
    const brokenAt = new Date("2026-09-30T14:00:00.000Z");
    const result = await breakFactoryLock(store, {
      bucket: BUCKET,
      held,
      confirmation: "aaaaaaaa",
      breaker,
      now: brokenAt,
      release: RELEASE,
    });
    const key = "fff-abcd1234-lock-log/2026-09-30T14:00:00.000Z-broken-aaaaaaaa.json";
    expect(result).toEqual({ kind: "broken", logKey: key });
    expect(store.logs.get(key)).toEqual({
      schema_version: 1,
      event: "broken",
      lock_version: held.version,
      lock: held.record ?? null,
      broken_by: breaker,
      broken_at: brokenAt.toISOString(),
      release: RELEASE,
    });
    expect(store.locks.has(BUCKET.bucket)).toBe(false);
    expect(store.calls.slice(-2)).toEqual([
      `logBreak ${BUCKET.bucket} ${key}`,
      `remove ${BUCKET.bucket} ${held.version}`,
    ]);
  });

  test("an unreadable lock is broken by confirming its version", async () => {
    const store = storeWithBucket();
    const held = store.hold(BUCKET.bucket, undefined);
    const result = await breakFactoryLock(store, {
      bucket: BUCKET,
      held,
      confirmation: held.version,
      breaker,
      now: NOW,
      release: RELEASE,
    });
    expect(result.kind).toBe("broken");
    expect([...store.logs.values()][0]?.lock).toBeNull();
    expect(store.locks.has(BUCKET.bucket)).toBe(false);
  });

  test("a lock that changed since it was shown is never broken", async () => {
    const store = storeWithBucket();
    const shown = heldBy(store);
    await store.remove(BUCKET, shown.version);
    const replacement = store.hold(
      BUCKET.bucket,
      newLockRecord({ ...request(SECOND, 1), factoryId: FACTORY }),
    );
    const result = await breakFactoryLock(store, {
      bucket: BUCKET,
      held: shown,
      confirmation: "aaaaaaaa",
      breaker,
      now: NOW,
      release: RELEASE,
    });
    expect(result).toEqual({ kind: "changed", current: replacement });
    expect(store.locks.get(BUCKET.bucket)).toBe(replacement);
    expect(store.logs.size).toBe(0);
  });

  test("a lock replaced under the same version, as unversioned locks are, is never broken", async () => {
    const store = storeWithBucket();
    const shown = heldBy(store);
    const replacement = {
      version: shown.version,
      record: newLockRecord({ ...request(SECOND, 1), factoryId: FACTORY }),
    };
    store.locks.set(BUCKET.bucket, replacement);
    const result = await breakFactoryLock(store, {
      bucket: BUCKET,
      held: shown,
      confirmation: "aaaaaaaa",
      breaker,
      now: NOW,
      release: RELEASE,
    });
    expect(result).toEqual({ kind: "changed", current: replacement });
    expect(store.locks.get(BUCKET.bucket)).toBe(replacement);
    expect(store.logs.size).toBe(0);
  });

  test("a failed log write leaves the lock in place", async () => {
    const store = storeWithBucket();
    const held = heldBy(store);
    const failing = Object.assign(store, {
      logBreak: async () => {
        throw new Error("S3 PutObject failed: AccessDenied");
      },
    });
    await expect(
      breakFactoryLock(failing, {
        bucket: BUCKET,
        held,
        confirmation: "aaaaaaaa",
        breaker,
        now: NOW,
        release: RELEASE,
      }),
    ).rejects.toThrow("AccessDenied");
    expect(store.locks.get(BUCKET.bucket)).toBe(held);
  });
});

describe("where the lock lives", () => {
  const instance = (document: Partial<FactoryInstance>): FactoryInstance => ({
    schema_version: 1,
    ...document,
  });

  test("the factory's state bucket, in its account and Region", () => {
    expect(
      stateBucketOf(
        instance({
          factory_id: FACTORY,
          aws: { account_id: "123456789012", region: "eu-west-2" },
          state_backend: { bucket: "fff-abcd1234-state" },
        }),
        { source: "chain" },
      ),
    ).toEqual({ ok: true, bucket: BUCKET });
  });

  test("needs the factory ID, account, Region and bucket", () => {
    expect(stateBucketOf(instance({}), { source: "chain" })).toEqual({
      ok: false,
      issues: [
        { path: "factory_id", message: "is required to reach the state bucket" },
        { path: "aws.account_id", message: "is required to reach the state bucket" },
        { path: "aws.region", message: "is required to reach the state bucket" },
        { path: "state_backend.bucket", message: "is required to reach the state bucket" },
      ],
    });
  });

  test("the holder is the principal the account check allowed, on this machine", () => {
    const account: AllowedAccount = {
      allowed: true,
      verdict: { kind: "match", caller: FAKE_CALLER },
    };
    expect(lockHolder(account, "laptop")).toEqual({ principal: FAKE_CALLER.arn, host: "laptop" });
  });
});

describe("settleFactoryLock", () => {
  test("releases the lock, unless the operation holding it was interrupted", async () => {
    for (const interrupted of [false, true]) {
      const store = storeWithBucket();
      const acquisition = await acquireFactoryLock(store, request());
      if (!acquisition.acquired) throw new Error("not acquired");
      await settleFactoryLock(store, acquisition.lock, () => interrupted);
      expect(store.locks.has(BUCKET.bucket)).toBe(interrupted);
      expect(store.calls.some((call) => call.startsWith("remove"))).toBe(!interrupted);
    }
  });
});
