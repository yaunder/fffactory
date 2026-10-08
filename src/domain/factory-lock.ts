/**
 * The factory-wide lock's lease rules. One lock per factory covers every stage of a
 * mutating operation. It lives in the state bucket as one object, created only when absent,
 * that records who holds it, for which operation and since when. A held lock is never
 * taken over or expired: only an explicit, confirmed break removes a lock its holder did
 * not release, and every break is logged.
 */
import { type RandomBytes, randomAlphanumeric } from "./initialization";
import { type FactoryId, parseFactoryId, parseRelease, type Release } from "./instance";
import { namespaced } from "./resource-naming";
import { isRecord } from "./validation";

export const LOCK_SCHEMA_VERSION = 1;
const LOCK_ID_LENGTH = 8;
const LOCK_ID = /^[a-z0-9]{8}$/;
const OPERATION = /^[a-z][a-z0-9-]{0,31}$/;
/** Printable ASCII only, so a tampered record cannot send terminal control sequences. */
const PRINTABLE = /^[\x20-\x7e]{1,2048}$/;
const HOLDER_FIELD_LENGTH = 2048;
const UNPRINTABLE = /[^\x20-\x7e]/gu;

/**
 * Older than this, a lock has outlived any operation: an infrastructure apply's Terraform
 * deadlines alone (init, plan and apply) add up to 100 minutes. Staleness is only shown;
 * it never lets anyone take the lock without a confirmed break.
 */
export const LOCK_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/** Who holds, or broke, a lock: the AWS principal the account check resolved, and the machine. */
export interface LockHolder {
  readonly principal: string;
  readonly host: string;
}

/** The lock object's contents. */
export interface LockRecord {
  readonly schema_version: typeof LOCK_SCHEMA_VERSION;
  /** Short random ID an operator types to confirm breaking this lock. */
  readonly lock_id: string;
  readonly factory_id: FactoryId;
  /** The operation holding the lock, such as `apply`. */
  readonly operation: string;
  readonly holder: LockHolder;
  /** ISO 8601 UTC time the lock was acquired. */
  readonly acquired_at: string;
  /** The fffactory release that acquired it. */
  readonly release: Release;
}

/**
 * A lock object as the state bucket holds it: its object version, and its record, or
 * undefined when the object cannot be read as one. An unreadable lock is still held.
 */
export interface HeldLock {
  readonly version: string;
  readonly record: LockRecord | undefined;
}

/** One logged break, written to the state bucket before the lock is removed. */
export interface LockBreakEntry {
  readonly schema_version: typeof LOCK_SCHEMA_VERSION;
  readonly event: "broken";
  readonly lock_version: string;
  /** The broken lock's record, or null when it was unreadable. */
  readonly lock: LockRecord | null;
  readonly broken_by: LockHolder;
  readonly broken_at: string;
  readonly release: Release;
}

/** The lock object's key in the state bucket, which carries the factory ID. */
export function lockKey(factoryId: FactoryId): string {
  return namespaced(factoryId, "lock.json");
}

/** The key of a break's log entry: the break time, then the broken lock's token. */
export function lockBreakKey(factoryId: FactoryId, brokenAt: Date, token: string): string {
  return `${namespaced(factoryId, "lock-log")}/${brokenAt.toISOString()}-broken-${token}.json`;
}

export interface LockRequest {
  readonly factoryId: FactoryId;
  readonly operation: string;
  readonly holder: LockHolder;
  readonly now: Date;
  readonly release: Release;
  readonly randomBytes: RandomBytes;
}

/**
 * A holder field as the lock records it: each character outside printable ASCII becomes
 * `?`, and it is cut to the length `parseLockRecord` reads, so a machine's odd host name
 * never makes its own lock unreadable. An empty field is recorded as `unknown`.
 */
function recordable(value: string): string {
  const printable = value.replace(UNPRINTABLE, "?").slice(0, HOLDER_FIELD_LENGTH);
  return printable === "" ? "unknown" : printable;
}

function recordableHolder(holder: LockHolder): LockHolder {
  return { principal: recordable(holder.principal), host: recordable(holder.host) };
}

export function newLockRecord(request: LockRequest): LockRecord {
  return {
    schema_version: LOCK_SCHEMA_VERSION,
    lock_id: randomAlphanumeric(request.randomBytes, LOCK_ID_LENGTH),
    factory_id: request.factoryId,
    operation: request.operation,
    holder: recordableHolder(request.holder),
    acquired_at: request.now.toISOString(),
    release: request.release,
  };
}

/** The lock object's or a log entry's text. */
export function serializeLock(value: LockRecord | LockBreakEntry): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function printable(value: unknown): value is string {
  return typeof value === "string" && PRINTABLE.test(value);
}

function isoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function readHolder(value: unknown): LockHolder | undefined {
  if (!isRecord(value) || !printable(value.principal) || !printable(value.host)) return undefined;
  return { principal: value.principal, host: value.host };
}

/**
 * Reads a lock object's text as this factory's lock record, or undefined when it is not
 * one. Unknown fields are ignored; every field shown to an operator is printable.
 */
export function parseLockRecord(text: string, factoryId: FactoryId): LockRecord | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(document) || document.schema_version !== LOCK_SCHEMA_VERSION) return undefined;
  const { lock_id, factory_id, operation, acquired_at, release } = document;
  const holder = readHolder(document.holder);
  const valid =
    typeof lock_id === "string" &&
    LOCK_ID.test(lock_id) &&
    typeof factory_id === "string" &&
    parseFactoryId(factory_id).ok &&
    factory_id === factoryId &&
    typeof operation === "string" &&
    OPERATION.test(operation) &&
    holder !== undefined &&
    isoTime(acquired_at) &&
    typeof release === "string" &&
    parseRelease(release).ok;
  if (!valid) return undefined;
  return {
    schema_version: LOCK_SCHEMA_VERSION,
    lock_id,
    factory_id: factoryId,
    operation,
    holder,
    acquired_at,
    release: release as Release,
  };
}

/** What confirms breaking a lock: its lock ID, or its object version when it is unreadable. */
export function lockToken(held: HeldLock): string {
  return held.record?.lock_id ?? held.version;
}

/** Only the held lock's own token confirms breaking it. */
export function confirmsBreak(held: HeldLock, confirmation: string): boolean {
  return confirmation.trim() === lockToken(held);
}

export function lockAge(record: LockRecord, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(record.acquired_at));
}

export function isStale(record: LockRecord, now: Date): boolean {
  return lockAge(record, now) > LOCK_STALE_AFTER_MS;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A rough, human-readable duration: `45 s`, `12 min`, `3 h 5 min`, `2 d 4 h`. */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)} s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ${Math.floor((ms % HOUR) / MINUTE)} min`;
  return `${Math.floor(ms / DAY)} d ${Math.floor((ms % DAY) / HOUR)} h`;
}

/** The lines that show an operator who holds a lock, for how long, and its token. */
export function describeHeldLock(held: HeldLock, now: Date): string[] {
  const { record } = held;
  if (record === undefined)
    return [`Lock ${held.version}: unreadable, so its holder and operation are unknown`];
  const stale = isStale(record, now)
    ? ": older than any operation runs, so it is probably stale"
    : "";
  return [
    `Lock ${record.lock_id}: ${record.operation} by ${record.holder.principal} on ${record.holder.host}`,
    `Acquired ${record.acquired_at} (${formatDuration(lockAge(record, now))} ago) by fffactory ${record.release}${stale}`,
  ];
}

/** Why an operation could not take the lock, showing who holds it and how to recover. */
export function lockRefusal(held: HeldLock | undefined, now: Date): string[] {
  if (held === undefined)
    return ["The factory lock kept changing hands while fffactory tried to take it; try again."];
  return [
    "The factory is locked by another operation:",
    ...describeHeldLock(held, now).map((line) => `  ${line}`),
    "Wait for it to finish. If its holder is no longer running, break the lock with " +
      "`fffactory lock break`.",
  ];
}

export function newLockBreakEntry(
  held: HeldLock,
  breaker: LockHolder,
  now: Date,
  release: Release,
): LockBreakEntry {
  return {
    schema_version: LOCK_SCHEMA_VERSION,
    event: "broken",
    lock_version: held.version,
    lock: held.record ?? null,
    broken_by: recordableHolder(breaker),
    broken_at: now.toISOString(),
    release,
  };
}
