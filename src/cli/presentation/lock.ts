/**
 * The factory lock as text: who holds it, for how long, and how to recover when it refuses an
 * operation (`docs/specs/provisioning.md` §Lock). The domain keeps the lease rules (`isStale`,
 * `lockAge`, `formatDuration`, `confirmsBreak`); this lays them out.
 */
import { formatDuration, type HeldLock, isStale, lockAge } from "../../domain/factory-lock";

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
