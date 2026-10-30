/**
 * `host collect --once` on a worker (`docs/specs/collector.md` §Credentials and publishing): reads
 * the collector's configuration, opens the archive as the instance role (`s3-archive-writer.ts`),
 * runs one collection (`collect.ts`, which creates `incarnation.json` first under its lock) and
 * publishes the run's heartbeat. Without a configuration it does nothing. A failure is reported
 * in the heartbeat when one can be written, and otherwise only to its caller, for the journal.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  archiveKeys,
  CLAUDE_ROOT,
  type Heartbeat,
  heartbeatJson,
  incarnationJson,
  type PutOutcome,
  ARCHIVE_FORMAT,
} from "../domain/archive-format";
import {
  COLLECTION_BUDGET,
  COLLECTOR_CONFIGURATION,
  type CollectorConfiguration,
  parseCollectorConfiguration,
} from "../domain/collector";
import { WORKER_PATHS } from "../domain/host-protocol";
import type { RandomBytes } from "../domain/initialization";
import type { Release } from "../domain/instance";
import { TOKEN } from "../domain/protocol-fields";
import { COLLECTOR_STATE, type CollectionReport, collectOnce } from "./collect";
import { type ExclusiveLock, flockExclusive } from "./install-lock";
import { type ArchiveSession, type ArchiveTarget, openInstanceArchive } from "./s3-archive-writer";

/** Where the kernel lists this process's open files on a worker (Linux, its only platform). */
export const OPEN_FILES = "/proc/self/fd";
/** This boot's ID, which every heartbeat carries. */
export const BOOT_ID = "/proc/sys/kernel/random/boot_id";

export interface CollectionSystem {
  /** `/` on a worker; tests pass a directory laid out as one. */
  readonly root: string;
  /** The running release: the active one, whose executable the timer runs. */
  readonly release: Release;
  readonly now: () => Date;
  readonly randomBytes: RandomBytes;
  readonly lock: ExclusiveLock;
  /** `OPEN_FILES`; null only where there is no `/proc`, in tests. */
  readonly openFiles: string | null;
  readonly openArchive: (target: ArchiveTarget) => Promise<ArchiveSession>;
}

/** What `host collect --once` did. */
export type HostCollection =
  /** No configuration: nothing was read, written or asked. */
  | { readonly kind: "not_configured" }
  /** Another run holds the collector's lock: nothing was collected or written. */
  | { readonly kind: "busy" }
  /** It could not start: nothing was written. The reason is fffactory's words. */
  | { readonly kind: "failed"; readonly reason: string }
  /** It ran: its report, and what writing its heartbeat answered. */
  | {
      readonly kind: "ran";
      readonly report: CollectionReport;
      readonly heartbeat: PutOutcome;
    };

export interface HostCollector {
  collect(): Promise<HostCollection>;
}

/** This worker's collector: under `root`, `/` unless a test lays out another. */
export function localCollectionSystem(release: Release, root = "/"): CollectionSystem {
  return {
    root,
    release,
    now: () => new Date(),
    randomBytes: (count) => crypto.getRandomValues(new Uint8Array(count)),
    lock: flockExclusive,
    openFiles: OPEN_FILES,
    openArchive: (target) => openInstanceArchive(target),
  };
}

type Configuration =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "read"; readonly configuration: CollectorConfiguration };

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "unknown";
}

async function readConfiguration(root: string): Promise<Configuration> {
  let text: string;
  try {
    text = await readFile(join(root, COLLECTOR_CONFIGURATION), "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: `collector.json could not be read (${code})` };
  }
  const parsed = parseCollectorConfiguration(text);
  if (parsed.ok) return { kind: "read", configuration: parsed.document };
  const problem =
    parsed.kind === "invalid" ? parsed.problem : `format ${parsed.format} is not supported`;
  return { kind: "unreadable", reason: `collector.json is malformed: ${problem}` };
}

const BOOT_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function bootId(root: string): Promise<string | undefined> {
  const text = await readFile(join(root, BOOT_ID), "utf8").catch(() => "");
  const id = text.trim();
  return BOOT_ID_FORMAT.test(id) ? id : undefined;
}

/**
 * Claude Code's version, as the running release pins it (`steps/versions.env`) and `host apply`
 * installed and verified it; null when it cannot be read.
 */
async function claudeCodeVersion(root: string, release: Release): Promise<string | null> {
  const path = join(root, WORKER_PATHS.releases, release, "steps", "versions.env");
  const text = await readFile(path, "utf8").catch(() => "");
  const line = text.split("\n").find((entry) => entry.startsWith("CLAUDE_CODE_VERSION="));
  const version = line
    ?.slice("CLAUDE_CODE_VERSION=".length)
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  return version !== undefined && TOKEN.test(version) ? version : null;
}

const encode = (text: string) => new TextEncoder().encode(text);

interface Identity {
  readonly configuration: CollectorConfiguration;
  readonly bootId: string;
  readonly claudeCodeVersion: string | null;
}

function heartbeatOf(report: CollectionReport, identity: Identity, release: Release): Heartbeat {
  return {
    format: ARCHIVE_FORMAT,
    at: report.ended_at,
    epoch: report.epoch,
    boot_id: identity.bootId,
    release,
    claude_code_version: identity.claudeCodeVersion,
    outcome: report.outcome,
    failure: report.failure,
    budget_hit: report.budget_hit,
    uploaded_bytes: report.uploaded_bytes,
    journal_seq: report.journal_seq,
    last_success_at: report.last_success_at,
    backlog: report.backlog,
  };
}

/** One run with the archive open, then its heartbeat. */
async function collectInto(
  system: CollectionSystem,
  archive: Extract<ArchiveSession, { kind: "opened" }>,
  identity: Identity,
): Promise<HostCollection> {
  const { configuration } = identity;
  const keys = archiveKeys(configuration.factory_id, archive.incarnation);
  const incarnation = incarnationJson({
    format: ARCHIVE_FORMAT,
    factory_id: configuration.factory_id,
    host_key: configuration.host_key,
    ...archive.incarnation,
    created_at: system.now().toISOString(),
    release: system.release,
    claude_code_version: identity.claudeCodeVersion,
    claude_root: CLAUDE_ROOT,
  });
  const run = await collectOnce({
    root: system.root,
    stateDirectory: join(system.root, COLLECTOR_STATE),
    writer: archive.writer,
    keys,
    now: system.now,
    randomBytes: system.randomBytes,
    lock: system.lock,
    budget: COLLECTION_BUDGET,
    openFiles: system.openFiles,
    incarnation: encode(incarnation),
  });
  if (run.kind === "busy") return run;
  const heartbeat = heartbeatJson(heartbeatOf(run.report, identity, system.release));
  const written = await archive.writer.put(keys.heartbeat(run.report.ended_at), encode(heartbeat));
  return { kind: "ran", report: run.report, heartbeat: written };
}

export function workerCollection(system: CollectionSystem): HostCollector {
  return {
    async collect() {
      const read = await readConfiguration(system.root);
      if (read.kind === "absent") return { kind: "not_configured" };
      if (read.kind === "unreadable") return { kind: "failed", reason: read.reason };
      const boot = await bootId(system.root);
      if (boot === undefined) return { kind: "failed", reason: "the boot ID could not be read" };
      const { bucket, region } = read.configuration;
      const archive = await system.openArchive({ bucket, region });
      if (archive.kind === "failed")
        return { kind: "failed", reason: `the archive could not be opened (${archive.failure})` };
      try {
        return await collectInto(system, archive, {
          configuration: read.configuration,
          bootId: boot,
          claudeCodeVersion: await claudeCodeVersion(system.root, system.release),
        });
      } finally {
        archive.close();
      }
    },
  };
}
