import { describe, expect, test } from "bun:test";
import {
  confirmsBreak,
  describeHeldLock,
  formatDuration,
  type HeldLock,
  isStale,
  LOCK_STALE_AFTER_MS,
  type LockRecord,
  lockAge,
  lockBreakKey,
  lockKey,
  lockRefusal,
  lockToken,
  newLockBreakEntry,
  newLockRecord,
  parseLockRecord,
  serializeLock,
} from "../../src/domain/factory-lock";
import type { FactoryId, Release } from "../../src/domain/instance";

const FACTORY = "fff-abcd1234" as FactoryId;
const RELEASE = "0.3.0" as Release;
const HOLDER = { principal: "arn:aws:sts::123456789012:assumed-role/Admin/op", host: "laptop" };
const ACQUIRED = new Date("2026-09-30T10:00:00.000Z");
const zero = (count: number) => new Uint8Array(count);

function record(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    ...newLockRecord({
      factoryId: FACTORY,
      operation: "apply",
      holder: HOLDER,
      now: ACQUIRED,
      release: RELEASE,
      randomBytes: zero,
    }),
    ...overrides,
  };
}

const minutes = (count: number) => new Date(ACQUIRED.getTime() + count * 60_000);

describe("lock location", () => {
  test("the lock object and its break log carry the factory ID", () => {
    expect(lockKey(FACTORY)).toBe("fff-abcd1234-lock.json");
    expect(lockBreakKey(FACTORY, new Date("2026-09-30T12:00:00.000Z"), "k3x9q2ab")).toBe(
      "fff-abcd1234-lock-log/2026-09-30T12:00:00.000Z-broken-k3x9q2ab.json",
    );
  });
});

describe("newLockRecord", () => {
  test("records holder, operation, time, release and a random lock ID", () => {
    expect(record()).toEqual({
      schema_version: 1,
      lock_id: "aaaaaaaa",
      factory_id: FACTORY,
      operation: "apply",
      holder: HOLDER,
      acquired_at: "2026-09-30T10:00:00.000Z",
      release: RELEASE,
    });
  });

  test.each([
    [
      "a non-ASCII host name",
      { ...HOLDER, host: "caf\u00e9-mac" },
      { ...HOLDER, host: "caf?-mac" },
    ],
    [
      "control characters",
      { principal: "arn:aws:iam::123456789012:user/op\n", host: "a\u001b[2Jb" },
      { principal: "arn:aws:iam::123456789012:user/op?", host: "a?[2Jb" },
    ],
    ["an empty host name", { ...HOLDER, host: "" }, { ...HOLDER, host: "unknown" }],
    [
      "an overlong host name",
      { ...HOLDER, host: "h".repeat(3000) },
      { ...HOLDER, host: "h".repeat(2048) },
    ],
  ])("records a holder with %s as the lock parser reads it back", (_, holder, recorded) => {
    const written = newLockRecord({
      factoryId: FACTORY,
      operation: "apply",
      holder,
      now: ACQUIRED,
      release: RELEASE,
      randomBytes: zero,
    });
    expect(written.holder).toEqual(recorded);
    expect(parseLockRecord(serializeLock(written), FACTORY)).toEqual(written);
  });
});

describe("parseLockRecord", () => {
  test("reads back what serializeLock wrote", () => {
    expect(parseLockRecord(serializeLock(record()), FACTORY)).toEqual(record());
  });

  test.each([
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["another schema version", JSON.stringify({ ...record(), schema_version: 2 })],
    ["a malformed lock ID", JSON.stringify({ ...record(), lock_id: "ABC" })],
    ["another factory", JSON.stringify({ ...record(), factory_id: "fff-other111" })],
    ["a malformed operation", JSON.stringify({ ...record(), operation: "Apply now" })],
    ["no holder", JSON.stringify({ ...record(), holder: null })],
    [
      "a control character in the host",
      JSON.stringify({ ...record(), holder: { ...HOLDER, host: "a\u001b[2Jb" } }),
    ],
    ["an empty principal", JSON.stringify({ ...record(), holder: { ...HOLDER, principal: "" } })],
    ["a time that is not ISO 8601", JSON.stringify({ ...record(), acquired_at: "yesterday" })],
    ["a malformed release", JSON.stringify({ ...record(), release: "v1" })],
  ])("refuses %s as unreadable", (_, text) => {
    expect(parseLockRecord(text, FACTORY)).toBeUndefined();
  });
});

describe("lease", () => {
  test("age counts from acquisition and never goes negative", () => {
    expect(lockAge(record(), minutes(5))).toBe(5 * 60_000);
    expect(lockAge(record(), minutes(-5))).toBe(0);
  });

  test("a lock is stale only once it is older than any operation runs", () => {
    const threshold = LOCK_STALE_AFTER_MS / 60_000;
    expect(isStale(record(), minutes(threshold))).toBe(false);
    expect(isStale(record(), minutes(threshold + 1))).toBe(true);
  });

  test.each([
    [0, "0 s"],
    [59_000, "59 s"],
    [60_000, "1 min"],
    [59 * 60_000, "59 min"],
    [3 * 3_600_000 + 5 * 60_000, "3 h 5 min"],
    [2 * 86_400_000 + 4 * 3_600_000, "2 d 4 h"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("holder presentation", () => {
  test("shows the lock ID, operation, holder and age", () => {
    const held: HeldLock = { version: "v1", record: record() };
    expect(describeHeldLock(held, minutes(12))).toEqual([
      "Lock aaaaaaaa: apply by arn:aws:sts::123456789012:assumed-role/Admin/op on laptop",
      "Acquired 2026-09-30T10:00:00.000Z (12 min ago) by fffactory 0.3.0",
    ]);
  });

  test("says when a lock has outlived any operation", () => {
    const held: HeldLock = { version: "v1", record: record() };
    expect(describeHeldLock(held, minutes(24 * 60))[1]).toBe(
      "Acquired 2026-09-30T10:00:00.000Z (1 d 0 h ago) by fffactory 0.3.0: older than any operation runs, so it is probably stale",
    );
  });

  test("an unreadable lock is still a lock, named by its version", () => {
    const held: HeldLock = { version: "3HL4kqtJlcpXroDTDmJ", record: undefined };
    expect(lockToken(held)).toBe("3HL4kqtJlcpXroDTDmJ");
    expect(describeHeldLock(held, minutes(1))).toEqual([
      "Lock 3HL4kqtJlcpXroDTDmJ: unreadable, so its holder and operation are unknown",
    ]);
  });
});

describe("lockRefusal", () => {
  test("shows the holder and how to recover", () => {
    expect(lockRefusal({ version: "v1", record: record() }, minutes(2))).toEqual([
      "The factory is locked by another operation:",
      "  Lock aaaaaaaa: apply by arn:aws:sts::123456789012:assumed-role/Admin/op on laptop",
      "  Acquired 2026-09-30T10:00:00.000Z (2 min ago) by fffactory 0.3.0",
      "Wait for it to finish. If its holder is no longer running, break the lock with `fffactory lock break`.",
    ]);
  });

  test("a lock that kept vanishing asks for a retry", () => {
    expect(lockRefusal(undefined, minutes(0))).toEqual([
      "The factory lock kept changing hands while fffactory tried to take it; try again.",
    ]);
  });
});

describe("break confirmation", () => {
  const held: HeldLock = { version: "v1", record: record() };

  test("only the exact lock ID confirms, ignoring surrounding space", () => {
    expect(confirmsBreak(held, "aaaaaaaa")).toBe(true);
    expect(confirmsBreak(held, "  aaaaaaaa\n")).toBe(true);
    expect(confirmsBreak(held, "yes")).toBe(false);
    expect(confirmsBreak(held, "")).toBe(false);
    expect(confirmsBreak(held, "v1")).toBe(false);
  });

  test("the break entry records the broken lock, who broke it and when", () => {
    const breaker = { principal: "arn:aws:iam::123456789012:user/other", host: "desk" };
    expect(newLockBreakEntry(held, breaker, minutes(30), RELEASE)).toEqual({
      schema_version: 1,
      event: "broken",
      lock_version: "v1",
      lock: record(),
      broken_by: breaker,
      broken_at: "2026-09-30T10:30:00.000Z",
      release: RELEASE,
    });
    const unreadable = newLockBreakEntry(
      { version: "v2", record: undefined },
      breaker,
      minutes(1),
      RELEASE,
    );
    expect(unreadable.lock).toBeNull();
    expect(JSON.parse(serializeLock(unreadable))).toEqual(unreadable);
  });

  test("the breaker is recorded in printable ASCII too", () => {
    const breaker = { principal: "arn:aws:iam::123456789012:user/other", host: "b\u00fcro\u0007" };
    expect(newLockBreakEntry(held, breaker, minutes(1), RELEASE).broken_by).toEqual({
      principal: breaker.principal,
      host: "b?ro?",
    });
  });
});
