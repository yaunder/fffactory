import { describe, expect, test } from "bun:test";
import { render } from "../../../src/cli/presentation/blocks";
import {
  describeHeldLock,
  lockRefusal,
  lockRefusalReport,
} from "../../../src/cli/presentation/lock";
import { ansiStyle, plainStyle } from "../../../src/cli/presentation/style";
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

describe("lockRefusalReport (provisioning §Acquiring and releasing)", () => {
  const NEXT = `── Next ${"─".repeat(45)}`;
  const shown = (held: HeldLock | undefined, now: Date, selection = {}) => {
    const report = lockRefusalReport(held, now, selection);
    return render(plainStyle, report.blocks, report.next);
  };

  test("an error status line, the holder, and how to recover", () => {
    expect(shown({ version: "v1", record: record() }, minutes(2), { profile: "o'brien" })).toEqual([
      "✖ The factory is locked by another operation:",
      "  Lock aaaaaaaa: apply by arn:aws:sts::123456789012:assumed-role/Admin/op on laptop",
      "  Acquired 2026-09-30T10:00:00.000Z (2 min ago) by fffactory 0.3.0",
      "",
      NEXT,
      "  Wait for it to finish. If its holder is no longer running, break the lock:",
      "    $ fffactory lock break --profile 'o'\\''brien'",
    ]);
  });

  test("an unreadable lock is shown by its version", () => {
    expect(shown({ version: "3HL4kqtJ", record: undefined }, minutes(1))[1]).toBe(
      "  Lock 3HL4kqtJ: unreadable, so its holder and operation are unknown",
    );
  });

  test("the holder is data: shown verbatim, its backticks kept in color", () => {
    const odd = {
      ...record(),
      holder: { principal: "arn:aws:iam::123456789012:user/`x`", host: "`desk`" },
    };
    const report = lockRefusalReport({ version: "v1", record: odd }, minutes(2), {});
    expect(render(ansiStyle, report.blocks)[1]).toBe(
      "  Lock aaaaaaaa: apply by arn:aws:iam::123456789012:user/`x` on `desk`",
    );
  });

  test("a lock that kept vanishing asks for a retry", () => {
    expect(shown(undefined, minutes(0))).toEqual([
      "✖ The factory lock kept changing hands while fffactory tried to take it",
      "",
      NEXT,
      "  Try again.",
    ]);
  });
});

// TODO(re-evaluate when epic #18 restyles the worker commands): `worker stop|start|terminate`
// still print the unstyled lock refusal.
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
