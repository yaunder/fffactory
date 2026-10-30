/**
 * Archive format v1 (`docs/specs/collector.md` §Archive format v1): where a worker incarnation
 * writes in the log archive, and the documents it writes there, with their serializers and
 * parsers. Every object is created once with `If-None-Match: *` and never replaced. Keys never
 * carry a source path; the real path appears only inside journal records. Pure.
 */
import {
  type FactoryId,
  type HostKey,
  parseFactoryId,
  parseHostKey,
  type Release,
} from "./instance";
import {
  array,
  type Fields,
  Invalid,
  isoTime,
  nullable,
  oneOf,
  RELEASE_VERSION,
  record,
  sha256,
  string,
  TOKEN,
} from "./protocol-fields";

/**
 * The archive format's version: the `archive/<n>/` key prefix and every document's `format`.
 * Adding a field keeps it, and readers ignore fields they do not know; removing, renaming or
 * redefining one needs a new one.
 */
export const ARCHIVE_FORMAT = 1;

/** Claude Code's root on a worker: the runtime account's default, which nothing relocates. */
export const CLAUDE_ROOT = "/home/factory/.claude";

/** A worker incarnation: `aws:userid` for an instance role, `<role ID>:<instance ID>`. */
export interface WorkerIncarnation {
  readonly role_id: string;
  readonly instance_id: string;
}

const ROLE_ID = /^AROA[A-Z0-9]{1,124}$/;
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

/** The incarnation `sts:GetCallerIdentity`'s `UserId` names, or undefined for any other caller. */
export function callerIncarnation(userId: string): WorkerIncarnation | undefined {
  const [role_id = "", instance_id = "", ...rest] = userId.split(":");
  if (rest.length > 0 || !ROLE_ID.test(role_id) || !INSTANCE_ID.test(instance_id)) return undefined;
  return { role_id, instance_id };
}

const EPOCH = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;

/** `YYYYMMDDTHHMMSSZ-<16 hex>`: when a checkpoint was started, and 8 random bytes. */
export function isEpoch(value: unknown): value is string {
  return typeof value === "string" && EPOCH.test(value);
}

/** A new epoch, for a checkpoint started at `now`. */
export function newEpoch(now: Date, randomBytes: (count: number) => Uint8Array): string {
  const hex = Array.from(randomBytes(8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${compactTime(now.toISOString()).replace(/\.\d{3}/, "")}-${hex}`;
}

/** `2026-10-30T10:16:02.345Z` as `20261030T101602.345Z`. */
function compactTime(iso: string): string {
  return iso.replace(/[-:]/g, "");
}

/** What a key may hold: S3's safe characters, and the `:` `aws:userid` puts in the prefix. */
const KEY = /^[A-Za-z0-9!_.*'()/:-]{1,1024}$/;

/** A key S3 needs no special handling for: safe characters, no empty, `.` or `..` segment. */
export function isS3SafeKey(key: string): boolean {
  return (
    KEY.test(key) &&
    key.split("/").every((segment, index, all) => plainSegment(segment, index === all.length - 1))
  );
}

function plainSegment(segment: string, last: boolean): boolean {
  if (segment === "") return last;
  return segment !== "." && segment !== "..";
}

/** The keys of one incarnation's prefix. Each builder refuses what would make a bad key. */
export interface ArchiveKeys {
  /** `archive/1/<factory-id>/workers/<role-id>:<instance-id>/`. */
  readonly prefix: string;
  readonly incarnation: string;
  blob(sha256: string): string;
  journal(epoch: string, seq: number): string;
  /** The heartbeat key for a run that ended at `at`, a UTC ISO time. */
  heartbeat(at: string): string;
}

export function archiveKeys(factoryId: FactoryId, incarnation: WorkerIncarnation): ArchiveKeys {
  if (callerIncarnation(`${incarnation.role_id}:${incarnation.instance_id}`) === undefined)
    throw new Error("not a worker incarnation");
  const prefix = `archive/${ARCHIVE_FORMAT}/${factoryId}/workers/${incarnation.role_id}:${incarnation.instance_id}/`;
  return {
    prefix,
    incarnation: `${prefix}incarnation.json`,
    blob: (digest) => `${prefix}blobs/sha256/${sha256(digest, "blob")}`,
    journal: (epoch, seq) => {
      if (!isEpoch(epoch)) throw new Error("not an epoch");
      return `${prefix}journal/${epoch}/${String(sequence(seq, "seq")).padStart(10, "0")}.json`;
    },
    heartbeat: (at) => {
      const time = isoTime(at, "at");
      return `${prefix}heartbeat/${time.slice(0, 10)}/${compactTime(time)}.json`;
    },
  };
}

/**
 * What creating one archive object answered: `exists` is S3's 412 to `If-None-Match: *`, the
 * key already holding an object; `failed` names an AWS error name or a network error code,
 * never a message.
 */
export type PutOutcome =
  | { readonly kind: "created" }
  | { readonly kind: "exists" }
  | { readonly kind: "failed"; readonly failure: string };

/**
 * Creates archive objects, each once (`docs/specs/collector.md` §Run): a put never replaces an
 * object. The collection run writes through it; an adapter writes to S3.
 */
export interface ArchiveWriter {
  put(key: string, bytes: Uint8Array): Promise<PutOutcome>;
}

const MAX_PATH = 4096;

/**
 * A source's real path as the archive records it: absolute, under `CLAUDE_ROOT`, bounded, with
 * no empty, `.` or `..` segment and no NUL. Refused rather than normalized.
 */
export function isSourcePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > MAX_PATH || path.includes("\0")) return false;
  if (!path.startsWith(`${CLAUDE_ROOT}/`)) return false;
  return path
    .slice(CLAUDE_ROOT.length + 1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Why an archive document could not be read. Never quotes the document. */
export type ArchiveParse<T> =
  | { readonly ok: true; readonly document: T }
  | { readonly ok: false; readonly kind: "unsupported_format"; readonly format: number }
  | { readonly ok: false; readonly kind: "invalid"; readonly problem: string };

/**
 * Reads a document of the archive format. One of another format is rejected before anything
 * else is read; fields this format does not know are ignored by `read`.
 */
export function parseFormatted<T>(text: string, read: (document: Fields) => T): ArchiveParse<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, kind: "invalid", problem: "the document is not JSON" };
  }
  try {
    const document = record(parsed, "the document");
    const format = document.format;
    if (!Number.isSafeInteger(format)) throw new Invalid("format must be an integer");
    if (format !== ARCHIVE_FORMAT)
      return { ok: false, kind: "unsupported_format", format: format as number };
    return { ok: true, document: read(document) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, kind: "invalid", problem: error.message };
    throw error;
  }
}

/** A non-negative safe integer: a size, an offset or a count. */
export function count(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Invalid(`${path} must be a count`);
  return value as number;
}

/** A positive safe integer: a sequence or generation number. */
export function sequence(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Invalid(`${path} must be a positive integer`);
  return value as number;
}

export function epoch(value: unknown, path: string): string {
  if (!isEpoch(value)) throw new Invalid(`${path} must be an epoch`);
  return value;
}

export function sourcePath(value: unknown, path: string): string {
  if (!isSourcePath(value)) throw new Invalid(`${path} must be a source path`);
  return value;
}

/** A boot ID, as `/proc/sys/kernel/random/boot_id` gives it. */
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `incarnation.json`: who wrote this prefix, written once. */
export interface Incarnation {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly factory_id: FactoryId;
  readonly host_key: HostKey;
  readonly role_id: string;
  readonly instance_id: string;
  readonly created_at: string;
  readonly release: Release;
  readonly claude_code_version: string | null;
  readonly claude_root: string;
}

export function incarnationJson(document: Incarnation): string {
  return JSON.stringify(
    {
      format: ARCHIVE_FORMAT,
      factory_id: document.factory_id,
      host_key: document.host_key,
      role_id: document.role_id,
      instance_id: document.instance_id,
      created_at: document.created_at,
      release: document.release,
      claude_code_version: document.claude_code_version,
      claude_root: document.claude_root,
    },
    null,
    2,
  );
}

/** A field read by one of `instance.ts`'s parsers, named and never quoted when malformed. */
export function valid<T>(
  value: unknown,
  path: string,
  parse: (value: string) => { ok: true; value: T } | { ok: false },
): T {
  const parsed = typeof value === "string" ? parse(value) : undefined;
  if (parsed === undefined || !parsed.ok) throw new Invalid(`${path} is missing or malformed`);
  return parsed.value;
}

function readIncarnation(document: Fields): Incarnation {
  const incarnation = callerIncarnation(`${document.role_id}:${document.instance_id}`);
  if (incarnation === undefined) throw new Invalid("role_id or instance_id is malformed");
  if (document.claude_root !== CLAUDE_ROOT) throw new Invalid("claude_root is not Claude's root");
  return {
    format: ARCHIVE_FORMAT,
    factory_id: valid(document.factory_id, "factory_id", parseFactoryId),
    host_key: valid(document.host_key, "host_key", parseHostKey),
    ...incarnation,
    created_at: isoTime(document.created_at, "created_at"),
    release: string(document.release, "release", RELEASE_VERSION) as Release,
    claude_code_version: nullable(document.claude_code_version, (value) =>
      string(value, "claude_code_version", TOKEN),
    ),
    claude_root: CLAUDE_ROOT,
  };
}

export function parseIncarnation(text: string): ArchiveParse<Incarnation> {
  return parseFormatted(text, readIncarnation);
}

/** One capture: bytes `[offset, offset + length)` of a source's generation, in `blob`. */
export interface Capture {
  /** The source ID: the SHA-256 of `path`'s UTF-8 bytes. */
  readonly source: string;
  readonly path: string;
  readonly generation: number;
  readonly offset: number;
  readonly length: number;
  /** The SHA-256 of exactly the captured bytes: its blob's name. */
  readonly blob: string;
  /**
   * The SHA-256 of the generation's bytes `[0, offset)`: the `prefix_sha256` of the capture it
   * follows. `null` exactly when `offset` is 0, a generation's first capture.
   */
  readonly base_sha256: string | null;
  /** The SHA-256 of the generation's bytes `[0, offset + length)`. */
  readonly prefix_sha256: string;
  readonly mtime_ms: number;
}

/** A journal record: one run's captures, written after their blobs. */
export interface JournalRecord {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly epoch: string;
  readonly seq: number;
  readonly run_started_at: string;
  readonly captures: readonly Capture[];
}

function captureJson(capture: Capture) {
  return {
    source: capture.source,
    path: capture.path,
    generation: capture.generation,
    offset: capture.offset,
    length: capture.length,
    blob: capture.blob,
    base_sha256: capture.base_sha256,
    prefix_sha256: capture.prefix_sha256,
    mtime_ms: capture.mtime_ms,
  };
}

export function journalJson(document: JournalRecord): string {
  return JSON.stringify(
    {
      format: ARCHIVE_FORMAT,
      epoch: document.epoch,
      seq: document.seq,
      run_started_at: document.run_started_at,
      captures: document.captures.map(captureJson),
    },
    null,
    2,
  );
}

function readCapture(value: unknown, path: string): Capture {
  const fields = record(value, path);
  const offset = count(fields.offset, `${path}.offset`);
  if (fields.base_sha256 === undefined) throw new Invalid(`${path}.base_sha256 is missing`);
  const base_sha256 = nullable(fields.base_sha256, (base) => sha256(base, `${path}.base_sha256`));
  if ((offset === 0) !== (base_sha256 === null))
    throw new Invalid(`${path}.base_sha256 must be null exactly when offset is 0`);
  return {
    source: sha256(fields.source, `${path}.source`),
    path: sourcePath(fields.path, `${path}.path`),
    generation: sequence(fields.generation, `${path}.generation`),
    offset,
    length: count(fields.length, `${path}.length`),
    blob: sha256(fields.blob, `${path}.blob`),
    base_sha256,
    prefix_sha256: sha256(fields.prefix_sha256, `${path}.prefix_sha256`),
    mtime_ms: count(fields.mtime_ms, `${path}.mtime_ms`),
  };
}

function readJournal(document: Fields): JournalRecord {
  const captures = array(document.captures, "captures");
  if (captures.length === 0) throw new Invalid("captures must not be empty");
  return {
    format: ARCHIVE_FORMAT,
    epoch: epoch(document.epoch, "epoch"),
    seq: sequence(document.seq, "seq"),
    run_started_at: isoTime(document.run_started_at, "run_started_at"),
    captures: captures.map((item, index) => readCapture(item, `captures[${index}]`)),
  };
}

export function parseJournal(text: string): ArchiveParse<JournalRecord> {
  return parseFormatted(text, readJournal);
}

export const RUN_OUTCOMES = ["succeeded", "failed"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
/**
 * The budget a run stopped at: `bytes`, or `time`, which also covers discovery stopped at its
 * entries (`docs/specs/collector.md` §Budgets).
 */
export const BUDGETS_HIT = ["bytes", "time"] as const;
export type BudgetHit = (typeof BUDGETS_HIT)[number];

/** What is still unarchived (§Backlog). */
export interface Backlog {
  readonly files: number;
  readonly bytes: number;
}

/** A heartbeat: written by every run, whatever its outcome. */
export interface Heartbeat {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly at: string;
  readonly epoch: string;
  readonly boot_id: string;
  readonly release: Release;
  readonly claude_code_version: string | null;
  readonly outcome: RunOutcome;
  /** An AWS error name or a network error code, never a message. */
  readonly failure: string | null;
  readonly budget_hit: BudgetHit | null;
  readonly uploaded_bytes: number;
  readonly journal_seq: number | null;
  readonly last_success_at: string | null;
  readonly backlog: Backlog;
}

export function heartbeatJson(document: Heartbeat): string {
  return JSON.stringify(
    {
      format: ARCHIVE_FORMAT,
      at: document.at,
      epoch: document.epoch,
      boot_id: document.boot_id,
      release: document.release,
      claude_code_version: document.claude_code_version,
      outcome: document.outcome,
      failure: document.failure,
      budget_hit: document.budget_hit,
      uploaded_bytes: document.uploaded_bytes,
      journal_seq: document.journal_seq,
      last_success_at: document.last_success_at,
      backlog: { files: document.backlog.files, bytes: document.backlog.bytes },
    },
    null,
    2,
  );
}

function readBacklog(value: unknown): Backlog {
  const fields = record(value, "backlog");
  return {
    files: count(fields.files, "backlog.files"),
    bytes: count(fields.bytes, "backlog.bytes"),
  };
}

function readHeartbeat(document: Fields): Heartbeat {
  const outcome = oneOf(document.outcome, "outcome", RUN_OUTCOMES);
  const failure = nullable(document.failure, (value) => string(value, "failure", FAILURE_CLASS));
  if (outcome === "succeeded" && failure !== null)
    throw new Invalid("a succeeded run's failure must be null");
  return {
    format: ARCHIVE_FORMAT,
    at: isoTime(document.at, "at"),
    epoch: epoch(document.epoch, "epoch"),
    boot_id: string(document.boot_id, "boot_id", BOOT_ID),
    release: string(document.release, "release", RELEASE_VERSION) as Release,
    claude_code_version: nullable(document.claude_code_version, (value) =>
      string(value, "claude_code_version", TOKEN),
    ),
    outcome,
    failure,
    budget_hit: nullable(document.budget_hit, (value) => oneOf(value, "budget_hit", BUDGETS_HIT)),
    uploaded_bytes: count(document.uploaded_bytes, "uploaded_bytes"),
    journal_seq: nullable(document.journal_seq, (value) => sequence(value, "journal_seq")),
    last_success_at: nullable(document.last_success_at, (value) =>
      isoTime(value, "last_success_at"),
    ),
    backlog: readBacklog(document.backlog),
  };
}

/** An AWS error name or a network error code: `AccessDenied`, `ECONNREFUSED`. */
const FAILURE_CLASS = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

export function parseHeartbeat(text: string): ArchiveParse<Heartbeat> {
  return parseFormatted(text, readHeartbeat);
}
