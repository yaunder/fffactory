import { describe, expect, test } from "bun:test";
import { lockBreakKey, lockKey } from "../../src/domain/factory-lock";
import type { FactoryId } from "../../src/domain/instance";
import { FACTORY_STATE_KEY } from "../../src/domain/plan";
import {
  DELETE_OBJECTS_LIMIT,
  deletionBatches,
  type ListedVersion,
  lockBatches,
} from "../../src/domain/state-bucket-deletion";

const FACTORY = "fff-abcd1234" as FactoryId;
const LOCK = lockKey(FACTORY);
const LOG = lockBreakKey(FACTORY, new Date("2026-09-30T12:00:00.000Z"), "k3x9q2ab");

const WRITTEN = Date.parse("2026-09-30T10:00:00.000Z");

/** A listed version, written `second` seconds after the first; `latest` when S3 marks it so. */
const version = (key: string, id: string, second = 0, latest = false): ListedVersion => ({
  key,
  version: id,
  latest,
  modified: new Date(WRITTEN + second * 1000),
});

describe("the order a state bucket is emptied in", () => {
  test("a page's other keys are batched, and the lock's versions set aside", () => {
    const lockVersion = version(LOCK, "l2");
    const lockMarker = version(LOCK, "l1-marker");
    const state = version(FACTORY_STATE_KEY, "s1");
    const stateMarker = version(FACTORY_STATE_KEY, "s2-marker");
    const log = version(LOG, "g1");
    const record = version(`${FACTORY}-operations/2026-09-30T10:00:00.000Z-aaaaaaaa.json`, "o1");
    expect(
      deletionBatches(FACTORY, [lockVersion, state, lockMarker, log, stateMarker, record]),
    ).toEqual({
      others: [[state, log, stateMarker, record]],
      lock: [lockVersion, lockMarker],
    });
  });

  test("the break log, whose key starts like the lock's, is not the lock", () => {
    expect(LOG.startsWith(`${FACTORY}-lock`)).toBe(true);
    const batches = deletionBatches(FACTORY, [version(LOG, "g1"), version(`${LOCK}.bak`, "b1")]);
    expect(batches.lock).toEqual([]);
    expect(batches.others.flat().map(({ key }) => key)).toEqual([LOG, `${LOCK}.bak`]);
  });

  test("another factory's lock is any other key", () => {
    const other = version(lockKey("fff-zzzz9999" as FactoryId), "x1");
    expect(deletionBatches(FACTORY, [other])).toEqual({ others: [[other]], lock: [] });
  });

  test("each batch holds at most the 1000 keys one DeleteObjects call takes", () => {
    expect(DELETE_OBJECTS_LIMIT).toBe(1000);
    const others = Array.from({ length: 2001 }, (_, index) => version(`key-${index}`, "v"));
    const batches = deletionBatches(FACTORY, others);
    expect(batches.others.map((batch) => batch.length)).toEqual([1000, 1000, 1]);
    expect(batches.others.flat()).toEqual(others);
  });

  test("an empty page has nothing to delete", () => {
    expect(deletionBatches(FACTORY, [])).toEqual({ others: [], lock: [] });
    expect(lockBatches([])).toEqual([]);
  });

  test("the lock's older versions go oldest first, then the current one in a call of its own", () => {
    const current = version(LOCK, "l3", 3, true);
    const older = version(LOCK, "l1", 1);
    const marker = version(LOCK, "m2", 2);
    // The SDK lists versions and delete markers apart, each newest first.
    expect(lockBatches([current, older, marker])).toEqual([[older, marker], [current]]);
  });

  test("a current delete marker listed after an older version is still deleted last", () => {
    const older = version(LOCK, "l1", 1);
    const marker = version(LOCK, "m2", 2, true);
    expect(lockBatches([older, marker])).toEqual([[older], [marker]]);
  });

  test("versions written in the same instant go in reverse listing order", () => {
    const first = version(LOCK, "a", 1);
    const second = version(LOCK, "b", 1);
    const third = version(LOCK, "c", 1);
    expect(lockBatches([first, second, third])).toEqual([[third, second, first]]);
  });

  test("the lock's older versions go in batches of at most 1000, the oldest in the first", () => {
    const listed = Array.from({ length: 1002 }, (_, index) =>
      version(LOCK, `l${1001 - index}`, 1001 - index, index === 0),
    );
    const batches = lockBatches(listed);
    expect(batches.map((batch) => batch.length)).toEqual([1000, 1, 1]);
    expect(batches[0]?.[0]).toEqual(version(LOCK, "l0", 0));
    expect(batches[1]).toEqual([version(LOCK, "l1000", 1000)]);
    expect(batches[2]).toEqual([version(LOCK, "l1001", 1001, true)]);
  });
});
