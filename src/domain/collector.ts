/**
 * The collector's rules (`docs/specs/collector.md`): which files are sources, how each run
 * decides a source's capture from its checkpoint entry, the checkpoint document, the per-run
 * budgets and the backlog rule. Pure: the run that stats, reads, hashes and uploads builds on
 * these.
 */
import {
  ARCHIVE_FORMAT,
  type ArchiveParse,
  type Backlog,
  CLAUDE_ROOT,
  count,
  epoch,
  isSourcePath,
  parseFormatted,
  sequence,
  sourcePath,
} from "./archive-format";
import {
  array,
  type Fields,
  Invalid,
  isoTime,
  nullable,
  record,
  sha256,
  string,
} from "./protocol-fields";

/** The directories under `CLAUDE_ROOT` collected with everything below them (§Sources). */
export const COLLECTED_DIRECTORIES = [
  "projects",
  "file-history",
  "paste-cache",
  "plans",
  "tasks",
  "todos",
] as const;

/**
 * Never collected, whatever the allowlist says. All but the last two are outside it already;
 * they are named so a change to the allowlist cannot reach them silently.
 */
export const NEVER_COLLECTED: readonly string[] = [
  `${CLAUDE_ROOT}/.credentials.json`,
  "/home/factory/.claude.json",
  "/home/factory/.claude.json.backup",
  `${CLAUDE_ROOT}/.session_ingress_token`,
  `${CLAUDE_ROOT}/remote-settings.json`,
  `${CLAUDE_ROOT}/policy-limits.json`,
  `${CLAUDE_ROOT}/session-env`,
  `${CLAUDE_ROOT}/shell-snapshots`,
  `${CLAUDE_ROOT}/sessions`,
  `${CLAUDE_ROOT}/backups`,
  "/home/factory/.config/fffactory",
  "/home/factory/.codex",
];

/** Credential file names refused wherever they sit, also inside a collected directory. */
const NEVER_COLLECTED_NAMES: readonly string[] = [
  ".credentials.json",
  ".claude.json",
  ".claude.json.backup",
  ".session_ingress_token",
];

/** What an entry is, as `lstat` says. */
export type EntryKind = "file" | "directory" | "symlink" | "other";

/** A directory entry discovery found. */
export interface FoundEntry {
  readonly path: string;
  readonly kind: EntryKind;
  /** Whether any directory on the way to it is a symbolic link. */
  readonly viaSymlink: boolean;
}

function neverCollected(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (NEVER_COLLECTED_NAMES.includes(name)) return true;
  return NEVER_COLLECTED.some((never) => path === never || path.startsWith(`${never}/`));
}

/** The segments of `path` below `CLAUDE_ROOT`, or undefined when it is no source path. */
function rootSegments(path: string): readonly string[] | undefined {
  return isSourcePath(path) ? path.slice(CLAUDE_ROOT.length + 1).split("/") : undefined;
}

function inCollectedDirectory(segments: readonly string[]): boolean {
  return (COLLECTED_DIRECTORIES as readonly string[]).includes(segments[0] ?? "");
}

/** Whether `entry` is a source: a regular file in a collected directory, reached directly. */
export function collectable(entry: FoundEntry): boolean {
  if (entry.kind !== "file" || entry.viaSymlink) return false;
  const segments = rootSegments(entry.path);
  if (segments === undefined || segments.length < 2) return false;
  return inCollectedDirectory(segments) && !neverCollected(entry.path);
}

/** Whether discovery descends into the directory `path`: the root or a collected directory. */
export function walkable(path: string): boolean {
  if (path === CLAUDE_ROOT) return true;
  const segments = rootSegments(path);
  return segments !== undefined && inCollectedDirectory(segments) && !neverCollected(path);
}

/** At or below this many bytes, a changed source is uploaded whole, never appended to. */
export const SMALL_FILE_BYTES = 64 * 1024;

/**
 * What one run may upload, and for how long it starts uploads.
 * TODO(re-evaluate when measured on Acceptance): set from the measured run time and peak RSS.
 */
export const COLLECTION_BUDGET = { milliseconds: 40_000, bytes: 64 * 1024 * 1024 } as const;

/** A source as `stat` sees it. */
export interface SourceStat {
  /** Its device and inode, `<dev>:<ino>`: a new one means the file was replaced. */
  readonly identity: string;
  readonly size: number;
  readonly mtime_ms: number;
}

/** What the checkpoint holds for one source. */
export interface SourceCheckpoint {
  readonly source: string;
  readonly path: string;
  readonly identity: string;
  readonly mtime_ms: number;
  readonly generation: number;
  /** The bytes of the generation captured so far. */
  readonly length: number;
  /** The SHA-256 of those bytes. */
  readonly prefix_sha256: string;
}

export type NewGenerationReason = "first" | "replaced" | "shrunk" | "changed" | "rewritten";

/** A capture to upload: an append to the generation, or a new generation whole. */
export type Captured =
  | {
      readonly kind: "append";
      readonly generation: number;
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly kind: "new_generation";
      readonly reason: NewGenerationReason;
      readonly generation: number;
      readonly length: number;
    };

export type CaptureDecision =
  | { readonly kind: "unchanged" }
  /** Hash the source's first `length` bytes, and decide again with that hash. */
  | { readonly kind: "verify"; readonly length: number }
  | Captured;

function newGeneration(
  entry: SourceCheckpoint | undefined,
  reason: NewGenerationReason,
  stat: SourceStat,
): Captured {
  return {
    kind: "new_generation",
    reason,
    generation: (entry?.generation ?? 0) + 1,
    length: stat.size,
  };
}

/** Whether stat finds the source as the checkpoint captured it: same identity, size and time. */
function asCaptured(entry: SourceCheckpoint | undefined, stat: SourceStat): boolean {
  return (
    entry !== undefined &&
    stat.identity === entry.identity &&
    stat.size === entry.length &&
    stat.mtime_ms === entry.mtime_ms
  );
}

/** The decision stat alone gives, or undefined when the captured prefix must be hashed. */
function byStat(entry: SourceCheckpoint, stat: SourceStat): CaptureDecision | undefined {
  if (stat.identity !== entry.identity) return newGeneration(entry, "replaced", stat);
  if (stat.size < entry.length) return newGeneration(entry, "shrunk", stat);
  if (asCaptured(entry, stat)) return { kind: "unchanged" };
  if (stat.size <= SMALL_FILE_BYTES) return newGeneration(entry, "changed", stat);
  return undefined;
}

/**
 * How to capture a source (§Capture), from its checkpoint entry and a fresh stat. Without
 * `prefixSha256` it may answer `verify`; given the SHA-256 of the source's first `length`
 * bytes, it decides.
 */
export function captureDecision(
  entry: SourceCheckpoint | undefined,
  stat: SourceStat,
  prefixSha256?: string,
): CaptureDecision {
  if (entry === undefined) return newGeneration(entry, "first", stat);
  const decided = byStat(entry, stat);
  if (decided !== undefined) return decided;
  if (prefixSha256 === undefined) return { kind: "verify", length: entry.length };
  if (prefixSha256 !== entry.prefix_sha256) return newGeneration(entry, "rewritten", stat);
  if (stat.size === entry.length) return { kind: "unchanged" };
  return {
    kind: "append",
    generation: entry.generation,
    offset: entry.length,
    length: stat.size - entry.length,
  };
}

/**
 * The checkpoint entry once `captured` is stored: `prefixSha256` is the SHA-256 of the
 * generation's bytes up to the capture's end.
 */
export function capturedEntry(
  source: Pick<SourceCheckpoint, "source" | "path">,
  stat: SourceStat,
  captured: Captured,
  prefixSha256: string,
): SourceCheckpoint {
  const offset = captured.kind === "append" ? captured.offset : 0;
  return {
    source: source.source,
    path: source.path,
    identity: stat.identity,
    mtime_ms: stat.mtime_ms,
    generation: captured.generation,
    length: offset + captured.length,
    prefix_sha256: prefixSha256,
  };
}

/**
 * The checkpoint entry once a verify found the source unchanged (§Capture): only its
 * modification time is new. Refuses a stat of another identity or size, which is no touch.
 */
export function touchedEntry(entry: SourceCheckpoint, stat: SourceStat): SourceCheckpoint {
  if (stat.identity !== entry.identity || stat.size !== entry.length)
    throw new Error("only a source of the same identity and size is touched");
  return { ...sourceJson(entry), mtime_ms: stat.mtime_ms };
}

/** The collector's local checkpoint (§Checkpoint). */
export interface Checkpoint {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly epoch: string;
  readonly next_seq: number;
  readonly saved_at: string;
  readonly last_success_at: string | null;
  readonly sources: readonly SourceCheckpoint[];
}

/** The checkpoint a run starts from when it has none: a new epoch, from sequence 1. */
export function newCheckpoint(epochId: string, now: string): Checkpoint {
  return {
    format: ARCHIVE_FORMAT,
    epoch: epochId,
    next_seq: 1,
    saved_at: now,
    last_success_at: null,
    sources: [],
  };
}

const bySource = (a: { source: string }, b: { source: string }) =>
  a.source < b.source ? -1 : a.source > b.source ? 1 : 0;

function sourceJson(entry: SourceCheckpoint) {
  return {
    source: entry.source,
    path: entry.path,
    identity: entry.identity,
    mtime_ms: entry.mtime_ms,
    generation: entry.generation,
    length: entry.length,
    prefix_sha256: entry.prefix_sha256,
  };
}

/** The checkpoint, sources in source ID order. */
export function checkpointJson(checkpoint: Checkpoint): string {
  return JSON.stringify(
    {
      format: ARCHIVE_FORMAT,
      epoch: checkpoint.epoch,
      next_seq: checkpoint.next_seq,
      saved_at: checkpoint.saved_at,
      last_success_at: checkpoint.last_success_at,
      sources: [...checkpoint.sources].sort(bySource).map(sourceJson),
    },
    null,
    2,
  );
}

const IDENTITY = /^\d{1,20}:\d{1,20}$/;

function readSource(value: unknown, path: string): SourceCheckpoint {
  const fields = record(value, path);
  return {
    source: sha256(fields.source, `${path}.source`),
    path: sourcePath(fields.path, `${path}.path`),
    identity: string(fields.identity, `${path}.identity`, IDENTITY),
    mtime_ms: count(fields.mtime_ms, `${path}.mtime_ms`),
    generation: sequence(fields.generation, `${path}.generation`),
    length: count(fields.length, `${path}.length`),
    prefix_sha256: sha256(fields.prefix_sha256, `${path}.prefix_sha256`),
  };
}

function readCheckpoint(document: Fields): Checkpoint {
  const sources = array(document.sources, "sources").map((item, index) =>
    readSource(item, `sources[${index}]`),
  );
  if (new Set(sources.map((entry) => entry.source)).size !== sources.length)
    throw new Invalid("sources names a source twice");
  return {
    format: ARCHIVE_FORMAT,
    epoch: epoch(document.epoch, "epoch"),
    next_seq: sequence(document.next_seq, "next_seq"),
    saved_at: isoTime(document.saved_at, "saved_at"),
    last_success_at: nullable(document.last_success_at, (value) =>
      isoTime(value, "last_success_at"),
    ),
    sources,
  };
}

/** Reads a checkpoint; one that cannot be read is lost, and the run starts a new epoch. */
export function parseCheckpoint(text: string): ArchiveParse<Checkpoint> {
  return parseFormatted(text, readCheckpoint);
}

/** A capture waiting for upload, as the budget orders it. */
export interface PendingCapture {
  readonly source: string;
  readonly mtime_ms: number;
  /** What it would upload: `length` bytes. */
  readonly captured: Captured;
}

/** The budget's order (§Budgets): most recently modified first, ties by source ID. */
export const newestFirst = (
  a: { readonly source: string; readonly mtime_ms: number },
  b: { readonly source: string; readonly mtime_ms: number },
) => b.mtime_ms - a.mtime_ms || bySource(a, b);

/**
 * The captures one run uploads (§Budgets): most recently modified first, ties by source ID,
 * admitted while the bytes stay within `budgetBytes`, stopping at the first that would exceed
 * it. A first capture over the budget is admitted cut to `budgetBytes`, so a source larger than
 * the budget progresses by at most the budget per run.
 */
export function budgetedCaptures<T extends PendingCapture>(
  pending: readonly T[],
  budgetBytes: number,
): { readonly admitted: readonly T[]; readonly budget_hit: boolean } {
  const ordered = [...pending].sort(newestFirst);
  const admitted: T[] = [];
  let bytes = 0;
  for (const capture of ordered) {
    const length = capture.captured.length;
    if (bytes + length <= budgetBytes) {
      admitted.push(capture);
      bytes += length;
    } else {
      if (admitted.length === 0)
        admitted.push({ ...capture, captured: { ...capture.captured, length: budgetBytes } });
      return { admitted, budget_hit: true };
    }
  }
  return { admitted, budget_hit: false };
}

/** A collectable source found on disk, by its source ID. */
export interface ObservedSource {
  readonly source: string;
  readonly stat: SourceStat;
}

/** The bytes of a source not as captured that are unarchived. */
function unarchivedBytes(entry: SourceCheckpoint | undefined, stat: SourceStat): number {
  if (entry === undefined || stat.identity !== entry.identity || stat.size <= entry.length)
    return stat.size;
  return stat.size - entry.length;
}

/**
 * What is unarchived (§Backlog), from the checkpoint and current stats alone. A file counts
 * whenever stat does not find it as captured, as the next run would capture or verify it,
 * empty or not.
 */
export function backlog(
  checkpoint: Checkpoint | null,
  observed: readonly ObservedSource[],
): Backlog {
  const entries = new Map((checkpoint?.sources ?? []).map((entry) => [entry.source, entry]));
  let files = 0;
  let bytes = 0;
  for (const { source, stat } of observed) {
    const entry = entries.get(source);
    if (asCaptured(entry, stat)) continue;
    files += 1;
    bytes += unarchivedBytes(entry, stat);
  }
  return { files, bytes };
}
