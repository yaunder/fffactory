/**
 * One collection run (`docs/specs/collector.md` §Run): discovers the allowlisted sources under
 * Claude's root, decides each capture from the checkpoint, uploads the admitted captures' blobs,
 * then the run's journal record, then saves the checkpoint, so the checkpoint never names data
 * that was not stored. It holds its own lock in its state directory, never the install lock, and
 * only reads sources: never through a symbolic link, never one the allowlist refuses. Under the
 * lock it first creates the incarnation's `incarnation.json`. The rules are
 * `domain/collector.ts`'s; the archive is reached only through an `ArchiveWriter`.
 */
import { createHash, type Hash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ARCHIVE_FORMAT,
  type ArchiveKeys,
  type ArchiveWriter,
  type Backlog,
  type BudgetHit,
  CLAUDE_ROOT,
  type Capture,
  journalJson,
  newEpoch,
  type RunOutcome,
} from "../domain/archive-format";
import {
  backlog,
  budgetedCaptures,
  type Captured,
  type Checkpoint,
  captureDecision,
  capturedEntry,
  checkpointJson,
  collectable,
  newCheckpoint,
  newestFirst,
  type PendingCapture,
  parseCheckpoint,
  type SourceCheckpoint,
  type SourceStat,
  touchedEntry,
  walkable,
} from "../domain/collector";
import type { RandomBytes } from "../domain/initialization";
import type { ExclusiveLock } from "./install-lock";

/** The checkpoint's file in the collector's state directory (§Checkpoint). */
export const CHECKPOINT = "checkpoint.json";
const LOCK = "collect.lock";
/** How many taken journal keys one run steps past before it gives up for this run. */
const JOURNAL_ATTEMPTS = 1000;
/** How much of a source a verify reads at a time. */
const READ_CHUNK = 1024 * 1024;
/** The share of the time budget decisions may take, leaving the rest to the uploads. */
const DECISION_SHARE = 0.5;

export interface CollectSystem {
  /** `/` on a worker; tests pass a directory laid out as one. Prefixes every source path. */
  readonly root: string;
  /** Where the checkpoint and the lock live, as a path on this machine. */
  readonly stateDirectory: string;
  readonly writer: ArchiveWriter;
  /** This incarnation's keys. */
  readonly keys: ArchiveKeys;
  readonly now: () => Date;
  readonly randomBytes: RandomBytes;
  readonly lock: ExclusiveLock;
  readonly budget: { readonly milliseconds: number; readonly bytes: number };
  /**
   * Where the kernel lists this process's open files, `/proc/self/fd` on a worker (Linux, the
   * collector's only platform); null leaves where a source was opened unchecked, for tests
   * elsewhere.
   */
  readonly openFiles: string | null;
  /**
   * This incarnation's `incarnation.json`, created first under the lock every run: one already
   * there (`exists`) is written. Null writes none, for tests of the run alone; a worker's run
   * always gives it (`host/collection.ts`).
   */
  readonly incarnation: Uint8Array | null;
}

/** What a run did, in the heartbeat's terms (§Heartbeats), for its caller to publish. */
export interface CollectionReport {
  readonly epoch: string;
  readonly run_started_at: string;
  readonly ended_at: string;
  readonly outcome: RunOutcome;
  readonly failure: string | null;
  readonly budget_hit: BudgetHit | null;
  /** The bytes of the blobs this run created. */
  readonly uploaded_bytes: number;
  readonly journal_seq: number | null;
  readonly last_success_at: string | null;
  readonly backlog: Backlog;
}

/** A run, or none because another holds the collector's lock. */
export type CollectionRun =
  | { readonly kind: "busy" }
  | { readonly kind: "ran"; readonly report: CollectionReport };

/** A source's ID: the SHA-256 of its absolute path's UTF-8 bytes. */
export function sourceId(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

/** Runs once under the collector's own lock; held elsewhere, does nothing and says `busy`. */
export async function collectOnce(system: CollectSystem): Promise<CollectionRun> {
  await mkdir(system.stateDirectory, { recursive: true, mode: 0o700 });
  const held = await system.lock(join(system.stateDirectory, LOCK));
  if (held === undefined) return { kind: "busy" };
  try {
    return { kind: "ran", report: await run(system) };
  } finally {
    held.release();
  }
}

/** The first failure a run met, by its class. */
interface Failures {
  first: string | null;
}

const FAILURE_CLASS = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/** A file-system error's code; anything else is no failure of the worker's, and is thrown. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== "string" || !FAILURE_CLASS.test(code)) throw error;
  return code;
}

/** Records a source's error by its code; a source that vanished or became a link is none. */
function note(failures: Failures, error: unknown): void {
  const code = errorCode(error);
  if (code !== "ENOENT" && code !== "ELOOP") failures.first ??= code;
}

/** Where the kernel found a source open, when that is not its own path (§Run). */
const PATH_MISMATCH = "SourcePathMismatch";
/** Where the kernel found a source open could not be read (§Run). */
const PATH_UNVERIFIED = "OpenPathUnverified";

/** A collectable source as discovery found it. */
export interface Observed {
  readonly source: string;
  readonly path: string;
  readonly stat: SourceStat;
}

function sourceStat(stats: BigIntStats): SourceStat {
  return {
    identity: `${stats.dev}:${stats.ino}`,
    size: Number(stats.size),
    mtime_ms: Number(stats.mtimeMs),
  };
}

async function lstatOf(root: string, path: string, failures: Failures) {
  try {
    return await lstat(join(root, path), { bigint: true });
  } catch (error) {
    note(failures, error);
    return undefined;
  }
}

/** One discovery: where it looks, what it found, and whether it may go on. */
interface Walk {
  readonly root: string;
  readonly found: Observed[];
  readonly failures: Failures;
  /** Asked before each entry is looked at; false stops discovery there (`cut`). */
  readonly more: () => boolean;
  cut: boolean;
}

/**
 * Every source, by `lstat`: a symbolic link is neither descended into nor collected. Stops,
 * `cut`, once `more` says no; a run never stops it.
 */
async function discover(
  root: string,
  failures: Failures,
  more: () => boolean = () => true,
): Promise<Walk> {
  const walking: Walk = { root, found: [], failures, more, cut: false };
  if ((await lstatOf(root, CLAUDE_ROOT, failures))?.isDirectory()) await walk(walking, CLAUDE_ROOT);
  return walking;
}

/** What discovery found under `root`, and whether it found everything. */
export interface Discovery {
  readonly observed: readonly Observed[];
  /** False when `more` stopped it, or a directory or entry could not be read. */
  readonly complete: boolean;
}

/**
 * The collector's discovery for a reader other than the run (`host work inspect`'s backlog):
 * the same allowlist, never through a symbolic link, stopped once `more` says no.
 */
export async function discoverSources(root: string, more: () => boolean): Promise<Discovery> {
  const failures: Failures = { first: null };
  const walking = await discover(root, failures, more);
  return { observed: walking.found, complete: !walking.cut && failures.first === null };
}

const asFile = (path: string) => collectable({ path, kind: "file", viaSymlink: false });

async function walk(walking: Walk, directory: string) {
  let names: string[];
  try {
    names = (await readdir(join(walking.root, directory))).sort();
  } catch (error) {
    note(walking.failures, error);
    return;
  }
  for (const name of names) {
    if (walking.cut || !walking.more()) {
      walking.cut = true;
      return;
    }
    await visit(walking, `${directory}/${name}`);
  }
}

/** Descends into a collected directory, or finds a source; `lstat`s nothing else. */
async function visit(walking: Walk, path: string) {
  const descend = walkable(path);
  const source = asFile(path);
  if (!descend && !source) return;
  const stats = await lstatOf(walking.root, path, walking.failures);
  if (descend && stats?.isDirectory()) await walk(walking, path);
  else if (source && stats?.isFile())
    walking.found.push({ source: sourceId(path), path, stat: sourceStat(stats) });
}

/**
 * Where a run opens sources and where the kernel must find them open: `root` prefixes every
 * source path; `claude` is the Claude root's real path, its parent resolved once per run and its
 * own name kept, so a link above it is followed but the Claude root, if it became one, is not.
 */
interface Reach {
  readonly root: string;
  readonly claude: string;
  readonly openFiles: string | null;
}

/** Where the kernel finds an open file; undefined when that cannot be read. */
async function openedAt(handle: FileHandle, openFiles: string): Promise<string | undefined> {
  try {
    return await readlink(join(openFiles, String(handle.fd)));
  } catch {
    return undefined;
  }
}

/**
 * Opens a source for reading, never through a symbolic link at its end, and only while it is
 * still the file discovery found (same device and inode) and the kernel finds it open at its
 * own path under the Claude root's real path, so a directory on the way swapped for a link
 * reaches nothing. The same file found open elsewhere, or where it is open unknown, is a
 * failure, never a vanished source: it is left for the next run.
 */
async function openSource(reach: Reach, observed: Observed, failures: Failures) {
  const handle = await open(
    join(reach.root, observed.path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat({ bigint: true });
    if (stats.isFile() && sourceStat(stats).identity === observed.stat.identity) {
      if (reach.openFiles === null) return { handle, size: Number(stats.size) };
      const opened = await openedAt(handle, reach.openFiles);
      if (opened === join(reach.claude, observed.path.slice(CLAUDE_ROOT.length)))
        return { handle, size: Number(stats.size) };
      failures.first ??= opened === undefined ? PATH_UNVERIFIED : PATH_MISMATCH;
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return undefined;
}

/** Reads `[offset, offset + length)` of an open source, or undefined when it ends before. */
async function readExactly(handle: FileHandle, offset: number, length: number) {
  const bytes = new Uint8Array(length);
  for (let done = 0; done < length; ) {
    const { bytesRead } = await handle.read(bytes, done, length - done, offset + done);
    if (bytesRead === 0) return undefined;
    done += bytesRead;
  }
  return bytes;
}

/** A verify the decision deadline cut short. */
const TIMED_OUT = Symbol("timed out");
type TimedOut = typeof TIMED_OUT;

/** Whether the decisions' deadline has passed, read from the run's clock until it has. */
type Past = () => boolean;

/**
 * Hashes an open source's first `length` bytes a chunk at a time, giving up between chunks
 * once the deadline has passed.
 */
async function hashHead(
  handle: FileHandle,
  length: number,
  past: Past,
): Promise<Hash | TimedOut | undefined> {
  const hash = createHash("sha256");
  const chunk = new Uint8Array(Math.min(READ_CHUNK, Math.max(length, 1)));
  for (let done = 0; done < length; ) {
    if (done > 0 && past()) return TIMED_OUT;
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, length - done), done);
    if (bytesRead === 0) return undefined;
    hash.update(chunk.subarray(0, bytesRead));
    done += bytesRead;
  }
  return hash;
}

/** Runs `read` over the source opened, closing it; undefined when it is gone or unreadable. */
async function reading<T>(
  reach: Reach,
  observed: Observed,
  failures: Failures,
  read: (handle: FileHandle, size: number) => Promise<T | undefined>,
): Promise<T | undefined> {
  try {
    const opened = await openSource(reach, observed, failures);
    if (opened === undefined) return undefined;
    try {
      return await read(opened.handle, opened.size);
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    note(failures, error);
    return undefined;
  }
}

/** A capture to upload, with what it needs to become a journal capture and checkpoint entry. */
interface Pending extends PendingCapture, Observed {
  readonly entry: SourceCheckpoint | undefined;
}

/**
 * Hashes a source's first `length` bytes (§Capture's verify), unless the deadline has passed
 * before or while it hashes; undefined when it is gone or unreadable.
 */
async function verify(
  reach: Reach,
  observed: Observed,
  length: number,
  past: Past,
  failures: Failures,
): Promise<Hash | TimedOut | undefined> {
  if (past()) return TIMED_OUT;
  return reading(reach, observed, failures, (handle) => hashHead(handle, length, past));
}

/**
 * Decides one source (§Capture), verifying it when stat cannot decide. A source a verify finds
 * unchanged has its modification time touched in `entries`.
 */
async function decide(
  reach: Reach,
  observed: Observed,
  entries: Map<string, SourceCheckpoint>,
  past: Past,
  failures: Failures,
): Promise<Pending | TimedOut | undefined> {
  const entry = entries.get(observed.source);
  let decision = captureDecision(entry, observed.stat);
  if (decision.kind === "verify") {
    const hashed = await verify(reach, observed, decision.length, past, failures);
    if (hashed === undefined || hashed === TIMED_OUT) return hashed;
    decision = captureDecision(entry, observed.stat, hashed.digest("hex"));
    if (decision.kind === "unchanged" && entry !== undefined)
      entries.set(observed.source, touchedEntry(entry, observed.stat));
  }
  if (decision.kind === "unchanged" || decision.kind === "verify") return undefined;
  return { ...observed, mtime_ms: observed.stat.mtime_ms, captured: decision, entry };
}

const offsetOf = (captured: Captured) => (captured.kind === "append" ? captured.offset : 0);

/** A pending capture's bytes as read, and for an append the hash of its prefix, to extend. */
interface Read {
  readonly bytes: Uint8Array;
  readonly base: Hash | undefined;
}

/** The journal capture of what was read for `pending`. */
function captureOf(pending: Pending, read: Read): Capture {
  const offset = offsetOf(pending.captured);
  const blob = createHash("sha256").update(read.bytes).digest("hex");
  return {
    source: pending.source,
    path: pending.path,
    generation: pending.captured.generation,
    offset,
    length: read.bytes.length,
    blob,
    base_sha256: offset === 0 ? null : (pending.entry?.prefix_sha256 ?? null),
    prefix_sha256: read.base?.update(read.bytes).digest("hex") ?? blob,
    mtime_ms: pending.mtime_ms,
  };
}

/**
 * An append's tail, already read, kept only while the open source's first `offset` bytes still
 * hash to `captured`, the prefix the tail extends.
 */
async function withPrefix(
  handle: FileHandle,
  offset: number,
  bytes: Uint8Array,
  captured: string | undefined,
  past: Past,
): Promise<Read | TimedOut | undefined> {
  const base = await hashHead(handle, offset, past);
  if (base === undefined || base === TIMED_OUT) return base;
  return base.copy().digest("hex") === captured ? { bytes, base } : undefined;
}

/**
 * Reads a pending capture's bytes, unless the time budget has passed; undefined once the source
 * is no longer what was decided. An append's tail is read first, then its prefix hashed again on
 * the same open file: the tail is kept only while that prefix is still the one captured, so a
 * prefix rewritten at any time before the hash is never spliced to the tail (§Capture). The hash
 * gives up between chunks once the time budget has passed.
 */
async function readPending(
  reach: Reach,
  pending: Pending,
  past: Past,
  failures: Failures,
): Promise<Read | TimedOut | undefined> {
  if (past()) return TIMED_OUT;
  const offset = offsetOf(pending.captured);
  const { length } = pending.captured;
  return reading(reach, pending, failures, async (handle, size) => {
    if (size < offset + length) return undefined;
    const bytes = await readExactly(handle, offset, length);
    if (bytes === undefined || offset === 0) return bytes && { bytes, base: undefined };
    return withPrefix(handle, offset, bytes, pending.entry?.prefix_sha256, past);
  });
}

interface Stored {
  readonly pending: Pending;
  readonly capture: Capture;
}

interface Upload {
  readonly stored: readonly Stored[];
  readonly uploaded: number;
  readonly timeHit: boolean;
}

/**
 * Uploads the admitted captures' blobs in order, starting none once the time budget has passed,
 * and stopping at the first that fails. A blob that already exists is stored: its key is its
 * content.
 */
async function upload(
  system: CollectSystem,
  reach: Reach,
  admitted: readonly Pending[],
  startedMs: number,
  failures: Failures,
): Promise<Upload> {
  const stored: Stored[] = [];
  let uploaded = 0;
  const past = () => system.now().getTime() - startedMs >= system.budget.milliseconds;
  for (const pending of admitted) {
    const read = await readPending(reach, pending, past, failures);
    if (read === TIMED_OUT) return { stored, uploaded, timeHit: true };
    if (read === undefined) continue;
    const { bytes } = read;
    const capture = captureOf(pending, read);
    const outcome = await system.writer.put(system.keys.blob(capture.blob), bytes);
    if (outcome.kind === "failed") {
      failures.first ??= outcome.failure;
      break;
    }
    if (outcome.kind === "created") uploaded += bytes.length;
    stored.push({ pending, capture });
  }
  return { stored, uploaded, timeHit: false };
}

interface Journal {
  /** The sequence of the record this run wrote, or null. */
  readonly seq: number | null;
  readonly next_seq: number;
}

/**
 * Writes the run's journal record, if it stored anything, at the checkpoint's next sequence;
 * a key already taken (an orphan's) advances the sequence and the record is written again there.
 */
async function writeJournal(
  system: CollectSystem,
  checkpoint: Checkpoint,
  stored: readonly Stored[],
  runStartedAt: string,
  failures: Failures,
): Promise<Journal> {
  const first = checkpoint.next_seq;
  if (stored.length === 0) return { seq: null, next_seq: first };
  const captures = stored.map(({ capture }) => capture);
  for (let seq = first; seq < first + JOURNAL_ATTEMPTS; seq += 1) {
    const record = journalJson({
      format: ARCHIVE_FORMAT,
      epoch: checkpoint.epoch,
      seq,
      run_started_at: runStartedAt,
      captures,
    });
    const key = system.keys.journal(checkpoint.epoch, seq);
    const outcome = await system.writer.put(key, new TextEncoder().encode(record));
    if (outcome.kind === "created") return { seq, next_seq: seq + 1 };
    if (outcome.kind === "failed") {
      failures.first ??= outcome.failure;
      return { seq: null, next_seq: seq };
    }
  }
  failures.first ??= "JournalKeysTaken";
  return { seq: null, next_seq: first + JOURNAL_ATTEMPTS };
}

/** The checkpoint saved last; one missing or unreadable is lost (§Checkpoint). */
async function loadCheckpoint(directory: string): Promise<Checkpoint | undefined> {
  let text: string;
  try {
    text = await readFile(join(directory, CHECKPOINT), "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseCheckpoint(text);
  return parsed.ok ? parsed.document : undefined;
}

/** Saves the checkpoint whole or not at all: a flushed private copy renamed over it. */
async function saveCheckpoint(directory: string, checkpoint: Checkpoint): Promise<void> {
  const path = join(directory, CHECKPOINT);
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(`${checkpointJson(checkpoint)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

/** Saves the next checkpoint; the one in force after the run, the old one if saving failed. */
async function settle(
  system: CollectSystem,
  loaded: Checkpoint,
  next: Checkpoint,
  failures: Failures,
): Promise<Checkpoint> {
  try {
    await saveCheckpoint(system.stateDirectory, next);
    return next;
  } catch (error) {
    failures.first ??= errorCode(error);
    return loaded;
  }
}

interface Decisions {
  readonly pending: readonly Pending[];
  readonly timeHit: boolean;
}

/**
 * The sources' decisions, most recently modified first, as the budget orders captures: the
 * captures they need. Once the deadline has passed it starts no verify, and a verify it was
 * hashing is abandoned: those sources are left to the next run. What stat alone decides is still
 * decided, so no verify ever holds back a new or replaced source.
 */
async function decideAll(
  reach: Reach,
  observed: readonly Observed[],
  entries: Map<string, SourceCheckpoint>,
  past: Past,
  failures: Failures,
): Promise<Decisions> {
  const pending: Pending[] = [];
  let timeHit = false;
  const ordered = observed.toSorted((a, b) =>
    newestFirst(
      { source: a.source, mtime_ms: a.stat.mtime_ms },
      { source: b.source, mtime_ms: b.stat.mtime_ms },
    ),
  );
  for (const source of ordered) {
    const decided = await decide(reach, source, entries, past, failures);
    if (decided === TIMED_OUT) timeHit = true;
    else if (decided !== undefined) pending.push(decided);
  }
  return { pending, timeHit };
}

/** Records in `entries` the captures a stored journal record names, and only those. */
function recordStored(
  entries: Map<string, SourceCheckpoint>,
  journal: Journal,
  stored: readonly Stored[],
): void {
  if (journal.seq === null) return;
  for (const { pending, capture } of stored)
    entries.set(
      capture.source,
      capturedEntry(pending, pending.stat, pending.captured, capture.prefix_sha256),
    );
}

function budgetHit(timeHit: boolean, bytesHit: boolean): BudgetHit | null {
  if (timeHit) return "time";
  return bytesHit ? "bytes" : null;
}

/**
 * The Claude root's real path: its parent resolved, its own name kept. Only asked once
 * discovery found sources; a parent that cannot be resolved fails the run by its code, and the
 * unresolved path then matches no open source.
 */
async function claudeRealPath(
  root: string,
  observed: readonly Observed[],
  failures: Failures,
): Promise<string> {
  const unresolved = join(root, CLAUDE_ROOT);
  if (observed.length === 0) return unresolved;
  try {
    return join(await realpath(dirname(unresolved)), basename(unresolved));
  } catch (error) {
    note(failures, error);
    return unresolved;
  }
}

/** Creates `incarnation.json`, once: a later run finds it there. A failure fails the run. */
async function writeIncarnation(system: CollectSystem, failures: Failures): Promise<void> {
  if (system.incarnation === null) return;
  const outcome = await system.writer.put(system.keys.incarnation, system.incarnation);
  if (outcome.kind === "failed") failures.first ??= outcome.failure;
}

async function run(system: CollectSystem): Promise<CollectionReport> {
  const root = await realpath(system.root);
  const started = system.now();
  const run_started_at = started.toISOString();
  const failures: Failures = { first: null };
  await writeIncarnation(system, failures);
  const loaded =
    (await loadCheckpoint(system.stateDirectory)) ??
    newCheckpoint(newEpoch(started, system.randomBytes), run_started_at);
  const entries = new Map(loaded.sources.map((entry) => [entry.source, entry]));
  const observed = (await discover(root, failures)).found;
  const decisionEnd = started.getTime() + system.budget.milliseconds * DECISION_SHARE;
  let passed = false;
  const past = () => {
    passed ||= system.now().getTime() >= decisionEnd;
    return passed;
  };
  const reach: Reach = {
    root,
    claude: await claudeRealPath(root, observed, failures),
    openFiles: system.openFiles,
  };
  const decisions = await decideAll(reach, observed, entries, past, failures);
  const budgeted = budgetedCaptures(decisions.pending, system.budget.bytes);
  const uploads = await upload(system, reach, budgeted.admitted, started.getTime(), failures);
  const journal = await writeJournal(system, loaded, uploads.stored, run_started_at, failures);
  recordStored(entries, journal, uploads.stored);
  const ended_at = system.now().toISOString();
  const next: Checkpoint = {
    format: ARCHIVE_FORMAT,
    epoch: loaded.epoch,
    next_seq: journal.next_seq,
    saved_at: ended_at,
    last_success_at: failures.first === null ? ended_at : loaded.last_success_at,
    sources: [...entries.values()],
  };
  const kept = await settle(system, loaded, next, failures);
  return {
    epoch: loaded.epoch,
    run_started_at,
    ended_at,
    outcome: failures.first === null ? "succeeded" : "failed",
    failure: failures.first,
    budget_hit: budgetHit(decisions.timeHit || uploads.timeHit, budgeted.budget_hit),
    uploaded_bytes: uploads.uploaded,
    journal_seq: journal.seq,
    last_success_at: kept.last_success_at,
    backlog: backlog(kept, observed),
  };
}
