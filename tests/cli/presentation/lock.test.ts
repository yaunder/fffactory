import { describe, expect, test } from "bun:test";
import { describeHeldLock, lockRefusal } from "../../../src/cli/presentation/lock";
import { type HeldLock, type LockRecord, newLockRecord } from "../../../src/domain/factory-lock";
import type { FactoryId, Release } from "../../../src/domain/instance";

const HOLDER = { principal: "arn:aws:sts::123456789012:assumed-role/Admin/op", host: "laptop" };
const ACQUIRED = new Date("2026-09-30T10:00:00.000Z");

function record(): LockRecord {
  return newLockRecord({
    factoryId: "fff-abcd1234" as FactoryId,
    operation: "apply",
    holder: HOLDER,
    now: ACQUIRED,
    release: "0.3.0" as Release,
    randomBytes: (count) => new Uint8Array(count),
  });
}

const minutes = (count: number) => new Date(ACQUIRED.getTime() + count * 60_000);

describe("describeHeldLock", () => {
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

  test("an unreadable lock is named by its version", () => {
    const held: HeldLock = { version: "3HL4kqtJlcpXroDTDmJ", record: undefined };
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
