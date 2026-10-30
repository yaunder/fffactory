/**
 * docs/specs/collector.md §Run: one collection run over a worker laid out in a temporary
 * directory, writing to the in-memory archive (`support/memory-archive.ts`), reassembled by the
 * reader's rules (`support/archive-reassembly.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ArchiveKeys,
  archiveKeys,
  CLAUDE_ROOT,
  type JournalRecord,
} from "../../src/domain/archive-format";
import {
  type Checkpoint,
  checkpointJson,
  parseCheckpoint,
  SMALL_FILE_BYTES,
} from "../../src/domain/collector";
import { COLLECTOR_STATE } from "../../src/domain/collector-installation";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import type { FactoryId } from "../../src/domain/instance";
import {
  type CollectionReport,
  type CollectSystem,
  collectOnce,
  sourceId,
} from "../../src/host/collect";
import { flockExclusive } from "../../src/host/install-lock";
import { journalRecords, reassemble, sha256Hex } from "../support/archive-reassembly";
import { Crash, type MemoryArchive, memoryArchive } from "../support/memory-archive";

const KEYS: ArchiveKeys = archiveKeys("fff-aaaa1111" as FactoryId, {
  role_id: "AROAEXAMPLEROLEID1234",
  instance_id: "i-0123456789abcdef0",
});
const INCARNATION = new TextEncoder().encode('{"format":1}');
const PROJECT = `${CLAUDE_ROOT}/projects/-home-factory--paseo-worktrees-1zu9oxdf-x`;
const SESSION = `${PROJECT}/0b6e1c3a.jsonl`;
const SUBAGENT = `${PROJECT}/0b6e1c3a/subagents/agent-1.jsonl`;
const SIDECAR = `${PROJECT}/0b6e1c3a/subagents/agent-1.meta.json`;
const TOOL_RESULT = `${PROJECT}/0b6e1c3a/tool-results/toolu_01.txt`;
const FILE_HISTORY = `${CLAUDE_ROOT}/file-history/0b6e1c3a/3f2a@v1`;
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const KiB = 1024;

let root: string;
let outside: string;
/** Every content each source has held, by worker path, oldest first. */
let history: Map<string, Uint8Array[]>;
let mtime: number;
/** The worker's clock, running on across a test's runs, 100 ms a reading. */
let time: ReturnType<typeof clock>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-collect-"));
  outside = await mkdtemp(join(tmpdir(), "fffactory-collect-outside-"));
  history = new Map();
  mtime = 1_793_000_000;
  time = clock();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const at = (path: string) => join(root, path);
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** Writes `content` to the worker's `path`, each write a later modification time. */
async function put(path: string, content: Uint8Array | string): Promise<void> {
  const data = typeof content === "string" ? bytes(content) : content;
  await mkdir(dirname(at(path)), { recursive: true });
  await writeFile(at(path), data);
  await touch(path);
  history.set(path, [...(history.get(path) ?? []), data]);
}

async function touch(path: string): Promise<void> {
  mtime += 1;
  await utimes(at(path), mtime, mtime);
}

async function append(path: string, content: string): Promise<void> {
  const current = await readFile(at(path));
  await put(path, new Uint8Array([...current, ...bytes(content)]));
}

/** A transcript of `count` lines, larger than `SMALL_FILE_BYTES` from about 700. */
function transcript(count: number, tag = "a"): string {
  return Array.from(
    { length: count },
    (_, n) => `${`{"type":"assistant","n":${n},"t":"${tag}"}`.padEnd(99)}\n`,
  ).join("");
}

function clock(start = Date.parse("2026-10-30T10:15:00.000Z"), step = 100) {
  let now = start;
  return {
    now: () => {
      now += step;
      return new Date(now);
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const randomBytes = (count: number) => new Uint8Array(cryptoRandomBytes(count));

function system(archive: MemoryArchive, overrides: Partial<CollectSystem> = {}): CollectSystem {
  return {
    root,
    stateDirectory: at(COLLECTOR_STATE),
    writer: archive,
    keys: KEYS,
    now: time.now,
    randomBytes,
    lock: flockExclusive,
    budget: { milliseconds: 40_000, bytes: 64 * 1024 * 1024 },
    openFiles: platform() === "linux" ? "/proc/self/fd" : null,
    incarnation: null,
    ...overrides,
  };
}

async function run(archive: MemoryArchive, overrides: Partial<CollectSystem> = {}) {
  const result = await collectOnce(system(archive, overrides));
  if (result.kind !== "ran") throw new Error(`the run was ${result.kind}`);
  return result.report;
}

async function checkpoint(): Promise<Checkpoint | undefined> {
  const textRead = await readFile(at(`${COLLECTOR_STATE}/checkpoint.json`), "utf8").catch(
    () => undefined,
  );
  if (textRead === undefined) return undefined;
  const parsed = parseCheckpoint(textRead);
  if (!parsed.ok) throw new Error("the checkpoint does not parse");
  return parsed.document;
}

const records = (archive: MemoryArchive) => journalRecords(archive.objects, KEYS.prefix);
const lastRecord = (archive: MemoryArchive): JournalRecord | undefined => records(archive).at(-1);
const captureOf = (record: JournalRecord | undefined, path: string) =>
  record?.captures.find((capture) => capture.path === path);

/** The checkpoint names only stored data: each entry's prefix ends a stored capture. */
async function expectCheckpointBacked(archive: MemoryArchive): Promise<void> {
  const saved = await checkpoint();
  if (saved === undefined) return;
  const stored = records(archive).filter((record) => record.epoch === saved.epoch);
  for (const entry of saved.sources) {
    expect(entry.source).toBe(sourceId(entry.path));
    const backing = stored
      .flatMap((record) => record.captures)
      .find(
        (capture) =>
          capture.source === entry.source &&
          capture.generation === entry.generation &&
          capture.offset + capture.length === entry.length &&
          capture.prefix_sha256 === entry.prefix_sha256,
      );
    expect(backing).toBeDefined();
    expect(archive.objects.has(KEYS.blob(backing?.blob ?? ""))).toBe(true);
  }
}

/** Every reassembled state is a prefix of content the file held; the last equals the file. */
async function expectReassembles(archive: MemoryArchive, paths = [...history.keys()]) {
  const sources = reassemble(archive.objects, KEYS.prefix);
  for (const path of paths) {
    const source = sources.get(path);
    expect(source).toBeDefined();
    expect(source?.broken).toBe(false);
    const versions = history.get(path) ?? [];
    for (const state of source?.states ?? [])
      expect(versions.some((version) => text(version).startsWith(text(state)))).toBe(true);
    expect(text(source?.current ?? new Uint8Array())).toBe(await readFile(at(path), "utf8"));
  }
}

describe("a fresh worker's history", () => {
  test("is backfilled whole: one blob per source, one journal record, then the checkpoint", async () => {
    await put(SESSION, transcript(800));
    await put(SUBAGENT, transcript(3, "sub"));
    await put(SIDECAR, '{"agentType":"general-purpose"}');
    await put(TOOL_RESULT, "tool output");
    await put(FILE_HISTORY, "backup");
    const archive = memoryArchive();

    const report = await run(archive);

    const record = lastRecord(archive);
    expect(record?.seq).toBe(1);
    expect(record?.captures.map((capture) => capture.path).sort()).toEqual(
      [SESSION, SUBAGENT, SIDECAR, TOOL_RESULT, FILE_HISTORY].sort(),
    );
    for (const capture of record?.captures ?? []) {
      expect(capture).toMatchObject({ generation: 1, offset: 0, base_sha256: null });
      expect(capture.source).toBe(sha256Hex(capture.path));
    }
    const journalKey = KEYS.journal(record?.epoch ?? "", 1);
    expect(archive.puts.at(-1)).toBe(journalKey);
    expect(archive.puts.slice(0, -1).every((key) => key.startsWith(`${KEYS.prefix}blobs/`))).toBe(
      true,
    );
    expect(report).toMatchObject({
      outcome: "succeeded",
      failure: null,
      budget_hit: null,
      journal_seq: 1,
      backlog: { files: 0, bytes: 0 },
    });
    expect(report.uploaded_bytes).toBe(
      (record?.captures ?? []).reduce((sum, capture) => sum + capture.length, 0),
    );
    expect(report.last_success_at).toBe(report.ended_at);
    expect((await checkpoint())?.next_seq).toBe(2);
    await expectCheckpointBacked(archive);
    await expectReassembles(archive);
  });

  test("a run with nothing new writes no journal record and saves the checkpoint", async () => {
    await put(SESSION, transcript(3));
    const archive = memoryArchive();
    await run(archive);
    const puts = archive.puts.length;

    const report = await run(archive);

    expect(archive.puts.length).toBe(puts);
    expect(report).toMatchObject({ outcome: "succeeded", journal_seq: null, uploaded_bytes: 0 });
    expect((await checkpoint())?.saved_at).toBe(report.ended_at);
  });

  test("an empty or absent Claude root is a successful run with nothing to collect", async () => {
    const archive = memoryArchive();
    expect(await run(archive)).toMatchObject({ outcome: "succeeded", journal_seq: null });
    expect(archive.puts).toEqual([]);
  });

  test("never reads a never-collected path, a path outside the allowlist, or through a symbolic link", async () => {
    await put(SESSION, "{}\n");
    const secrets = [
      `${CLAUDE_ROOT}/.credentials.json`,
      `${CLAUDE_ROOT}/.session_ingress_token`,
      `${CLAUDE_ROOT}/remote-settings.json`,
      `${CLAUDE_ROOT}/sessions/1.json`,
      `${CLAUDE_ROOT}/backups/.claude.json.backup`,
      `${CLAUDE_ROOT}/shell-snapshots/snapshot.sh`,
      `${CLAUDE_ROOT}/history.jsonl`,
      `${PROJECT}/.credentials.json`,
      "/home/factory/.claude.json",
      "/home/factory/.config/fffactory/token",
    ];
    for (const path of secrets) await put(path, SECRET);
    await writeFile(join(outside, "secret.jsonl"), SECRET);
    await mkdir(join(outside, "dir"));
    await writeFile(join(outside, "dir", "inner.jsonl"), SECRET);
    await symlink(join(outside, "secret.jsonl"), at(`${PROJECT}/linked.jsonl`));
    await symlink(join(outside, "dir"), at(`${PROJECT}/linked-dir`));
    await symlink(at(`${CLAUDE_ROOT}/.credentials.json`), at(`${CLAUDE_ROOT}/plans`));
    const archive = memoryArchive();

    await run(archive);

    expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([SESSION]);
    for (const data of archive.objects.values()) expect(text(data)).not.toContain(SECRET);
    expect(JSON.stringify(await checkpoint())).not.toContain("linked");
  });

  test("a Claude root that is a symbolic link is never followed", async () => {
    await mkdir(join(outside, "projects", "p"), { recursive: true });
    await writeFile(join(outside, "projects", "p", "s.jsonl"), SECRET);
    await mkdir(at("/home/factory"), { recursive: true });
    await symlink(outside, at(CLAUDE_ROOT));
    const archive = memoryArchive();

    expect(await run(archive)).toMatchObject({ outcome: "succeeded", journal_seq: null });
    expect(archive.puts).toEqual([]);
  });

  test("never modifies or deletes a source", async () => {
    await put(SESSION, transcript(800));
    await put(TOOL_RESULT, "tool output");
    const before = await Promise.all(
      [SESSION, TOOL_RESULT].map(async (path) => ({
        data: await readFile(at(path)),
        stat: await stat(at(path)),
      })),
    );

    await run(memoryArchive());

    const after = await Promise.all(
      [SESSION, TOOL_RESULT].map(async (path) => ({
        data: await readFile(at(path)),
        stat: await stat(at(path)),
      })),
    );
    for (const [index, { data, stat: was }] of before.entries()) {
      expect(after[index]?.data.equals(data)).toBe(true);
      expect(after[index]?.stat).toMatchObject({
        ino: was.ino,
        mode: was.mode,
        mtimeMs: was.mtimeMs,
        size: was.size,
      });
    }
  });
});

describe("incarnation.json (§Credentials and publishing)", () => {
  test("is created first, under the lock, and found already written by every later run", async () => {
    await put(SESSION, "{}\n");
    const archive = memoryArchive();

    const first = await run(archive, { incarnation: INCARNATION });
    const second = await run(archive, { incarnation: INCARNATION });

    expect(archive.puts[0]).toBe(KEYS.incarnation);
    expect(archive.objects.get(KEYS.incarnation)).toEqual(INCARNATION);
    expect(archive.puts.filter((key) => key === KEYS.incarnation)).toHaveLength(2);
    expect(first).toMatchObject({ outcome: "succeeded", journal_seq: 1 });
    expect(second).toMatchObject({ outcome: "succeeded", journal_seq: null });
  });

  test("one that cannot be created fails the run, which still collects, and is retried", async () => {
    await put(SESSION, "{}\n");
    const archive = memoryArchive();
    archive.fault = (key) =>
      key === KEYS.incarnation ? { kind: "failed", failure: "AccessDenied" } : undefined;

    const failed = await run(archive, { incarnation: INCARNATION });

    expect(failed).toMatchObject({ outcome: "failed", failure: "AccessDenied", journal_seq: 1 });
    expect(failed.last_success_at).toBeNull();
    expect((await checkpoint())?.last_success_at).toBeNull();
    archive.fault = () => undefined;
    const retried = await run(archive, { incarnation: INCARNATION });
    expect(retried).toMatchObject({ outcome: "succeeded", failure: null });
    expect(archive.objects.get(KEYS.incarnation)).toEqual(INCARNATION);
  });
});

describe("live sessions between runs", () => {
  test("an append to a large transcript uploads only the new bytes, chained to the last capture", async () => {
    await put(SESSION, transcript(800));
    const archive = memoryArchive();
    await run(archive);
    const first = captureOf(lastRecord(archive), SESSION);
    await append(SESSION, transcript(5, "b"));

    const report = await run(archive);

    const second = captureOf(lastRecord(archive), SESSION);
    expect(second).toMatchObject({
      generation: 1,
      offset: first?.length,
      length: 500,
      base_sha256: first?.prefix_sha256,
    });
    expect(report.uploaded_bytes).toBe(500);
    await expectCheckpointBacked(archive);
    await expectReassembles(archive);
  });

  test("a partial last line is captured raw and completed by the next append", async () => {
    await put(SESSION, `${transcript(800)}{"type":"assi`);
    const archive = memoryArchive();
    await run(archive);
    await append(SESSION, 'stant","n":800}\n');

    await run(archive);

    expect(captureOf(lastRecord(archive), SESSION)).toMatchObject({ length: 16 });
    await expectReassembles(archive);
  });

  test("a changed small file is uploaded whole as a new generation", async () => {
    await put(SIDECAR, '{"agentType":"a"}');
    const archive = memoryArchive();
    await run(archive);
    await put(SIDECAR, '{"agentType":"b"}');

    await run(archive);

    expect(captureOf(lastRecord(archive), SIDECAR)).toMatchObject({ generation: 2, offset: 0 });
    await expectReassembles(archive);
  });

  test("a large transcript only touched is verified, not uploaded, and no longer backlog", async () => {
    await put(SESSION, transcript(800));
    const archive = memoryArchive();
    await run(archive);
    const puts = archive.puts.length;
    await touch(SESSION);

    const report = await run(archive);

    expect(archive.puts.length).toBe(puts);
    expect(report.backlog).toEqual({ files: 0, bytes: 0 });
    expect((await checkpoint())?.sources[0]?.mtime_ms).toBe(mtime * 1000);
  });

  test("a same-length rewrite anywhere in the prefix is a new generation; the earlier one stays", async () => {
    await put(SESSION, transcript(800));
    const archive = memoryArchive();
    await run(archive);
    const first = captureOf(lastRecord(archive), SESSION);
    await put(SESSION, transcript(800).replace('"n":3,', '"n":9,'));

    await run(archive);

    expect(captureOf(lastRecord(archive), SESSION)).toMatchObject({
      generation: 2,
      offset: 0,
      base_sha256: null,
    });
    expect(archive.objects.has(KEYS.blob(first?.blob ?? ""))).toBe(true);
    await expectReassembles(archive);
  });

  test("a file replaced by another is a new generation", async () => {
    await put(SESSION, transcript(800));
    const archive = memoryArchive();
    await run(archive);
    const staged = `${PROJECT}/staged.tmp`;
    await mkdir(dirname(at(staged)), { recursive: true });
    await writeFile(at(staged), `${transcript(800)}{}\n`);
    await rename(at(staged), at(SESSION));
    await touch(SESSION);
    history.set(SESSION, [...(history.get(SESSION) ?? []), await readFile(at(SESSION))]);

    await run(archive);

    expect(captureOf(lastRecord(archive), SESSION)).toMatchObject({ generation: 2, offset: 0 });
    await expectReassembles(archive);
  });

  test("a removed file keeps its earlier capture, and its checkpoint entry", async () => {
    await put(SESSION, transcript(3));
    await put(TOOL_RESULT, "tool output");
    const archive = memoryArchive();
    await run(archive);
    await rm(at(TOOL_RESULT));

    const report = await run(archive);

    expect(report).toMatchObject({ journal_seq: null, backlog: { files: 0, bytes: 0 } });
    expect(reassemble(archive.objects, KEYS.prefix).get(TOOL_RESULT)?.current).toEqual(
      bytes("tool output"),
    );
    expect((await checkpoint())?.sources.map((entry) => entry.path)).toContain(TOOL_RESULT);
    await put(TOOL_RESULT, "again");
    await run(archive);
    expect(captureOf(lastRecord(archive), TOOL_RESULT)).toMatchObject({ generation: 2 });
  });

  test("a source replaced while the run reads it is left for the next run", async () => {
    await put(SESSION, transcript(3));
    await put(TOOL_RESULT, "tool output");
    const archive = memoryArchive();
    archive.beforePut = async (_key, index) => {
      if (index !== 0) return;
      const staged = `${PROJECT}/staged.tmp`;
      await writeFile(at(staged), transcript(4, "replaced"));
      await rename(at(staged), at(SESSION));
      await touch(SESSION);
      history.set(SESSION, [...(history.get(SESSION) ?? []), await readFile(at(SESSION))]);
    };

    const report = await run(archive);

    expect(lastRecord(archive)?.captures.length).toBe(1);
    expect(report.backlog.files).toBe(1);
    await expectCheckpointBacked(archive);
    archive.beforePut = () => {};
    await run(archive);
    await expectReassembles(archive);
  });

  test("an append's tail is never spliced onto a prefix rewritten after the decision", async () => {
    await put(SESSION, "a".repeat(80_000));
    const archive = memoryArchive();
    await run(archive);
    await append(SESSION, "old-tail");
    await put(TOOL_RESULT, "newer evidence");
    const first = archive.puts.length;
    archive.beforePut = async (_key, index) => {
      if (index === first) await put(SESSION, `${"b".repeat(80_000)}new-tail`);
    };

    const report = await run(archive);

    expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([TOOL_RESULT]);
    expect(report).toMatchObject({ outcome: "succeeded", backlog: { files: 1 } });
    await expectCheckpointBacked(archive);
    archive.beforePut = () => {};
    await run(archive);
    expect(captureOf(lastRecord(archive), SESSION)).toMatchObject({
      generation: 2,
      offset: 0,
      base_sha256: null,
    });
    await expectReassembles(archive);
  });

  test("a source still growing after its append was decided is appended up to the length decided", async () => {
    await put(SESSION, transcript(800));
    const archive = memoryArchive();
    await run(archive);
    await append(SESSION, transcript(5, "b"));
    await put(TOOL_RESULT, "newer evidence");
    const first = archive.puts.length;
    archive.beforePut = async (_key, index) => {
      if (index === first) await append(SESSION, transcript(3, "c"));
    };

    await run(archive);

    expect(captureOf(lastRecord(archive), SESSION)).toMatchObject({
      generation: 1,
      offset: 800 * 100,
      length: 500,
    });
    archive.beforePut = () => {};
    await run(archive);
    expect(captureOf(lastRecord(archive), SESSION)).toMatchObject({
      generation: 1,
      offset: 805 * 100,
      length: 300,
    });
    await expectCheckpointBacked(archive);
    await expectReassembles(archive);
  });

  test("an append whose prefix is still hashing when the time budget passes is left", async () => {
    await put(SESSION, transcript(30_000));
    const archive = memoryArchive();
    await run(archive);
    await append(SESSION, transcript(5, "b"));
    await put(TOOL_RESULT, "newer evidence");
    const readings: number[] = [];
    const now = () => {
      const reading = time.now();
      readings.push(reading.getTime());
      return reading;
    };
    const first = archive.puts.length;
    archive.beforePut = (_key, index) => {
      const started = readings[0] ?? 0;
      const last = readings.at(-1) ?? 0;
      if (index === first) time.advance(started + 40_000 - 150 - last);
    };

    const report = await run(archive, { now });

    expect(report).toMatchObject({ budget_hit: "time", backlog: { files: 1 } });
    expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([TOOL_RESULT]);
    await expectCheckpointBacked(archive);
    archive.beforePut = () => {};
    await run(archive);
    expect(captureOf(lastRecord(archive), SESSION)).toMatchObject({ generation: 1, length: 500 });
    await expectReassembles(archive);
  });
});

describe("a source turned into a symbolic link while the run reads", () => {
  test("is never read through it, even to the very file it was", async () => {
    await put(TOOL_RESULT, SECRET);
    await put(SESSION, "{}\n");
    const archive = memoryArchive();
    archive.beforePut = async (_key, index) => {
      if (index !== 0) return;
      await rename(at(TOOL_RESULT), join(outside, "moved"));
      await symlink(join(outside, "moved"), at(TOOL_RESULT));
    };

    const report = await run(archive);

    expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([SESSION]);
    expect(report.outcome).toBe("succeeded");
    for (const data of archive.objects.values()) expect(text(data)).not.toContain(SECRET);
  });
});

describe("a source's directory turned into a symbolic link while the run reads", () => {
  test.skipIf(platform() !== "linux")(
    "is never read through it, even to the very file it was",
    async () => {
      await put(TOOL_RESULT, SECRET);
      await put(SESSION, "{}\n");
      const archive = memoryArchive();
      archive.beforePut = async (_key, index) => {
        if (index !== 0) return;
        await rename(at(dirname(TOOL_RESULT)), join(outside, "moved"));
        await symlink(join(outside, "moved"), at(dirname(TOOL_RESULT)));
      };

      const report = await run(archive);

      expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([SESSION]);
      expect(report).toMatchObject({ outcome: "failed", failure: "SourcePathMismatch" });
      for (const data of archive.objects.values()) expect(text(data)).not.toContain(SECRET);
    },
  );
});

describe("where the kernel finds a source open", () => {
  test.skipIf(platform() !== "linux")(
    "a home reached through a symbolic link above the Claude root is collected",
    async () => {
      await mkdir(at("/data/home"), { recursive: true });
      await symlink("data/home", at("/home"));
      await put(SESSION, transcript(3));
      await put(TOOL_RESULT, "tool output");
      const archive = memoryArchive();

      const report = await run(archive);

      expect(report).toMatchObject({ outcome: "succeeded", failure: null, journal_seq: 1 });
      expect(report.uploaded_bytes).toBeGreaterThan(0);
      await expectReassembles(archive);
    },
  );

  test("unreadable, it fails the run and leaves the sources for the next run", async () => {
    await put(SESSION, "{}\n");
    const archive = memoryArchive();

    const report = await run(archive, { openFiles: join(outside, "no-fd") });

    expect(report).toMatchObject({ outcome: "failed", failure: "OpenPathUnverified" });
    expect(report.journal_seq).toBeNull();
    expect(archive.puts).toEqual([]);
    expect((await checkpoint())?.sources).toEqual([]);
    expect(await run(archive)).toMatchObject({ outcome: "succeeded", journal_seq: 1 });
  });
});

describe("a saved checkpoint", () => {
  test("is resumed as the shared fixture holds it: its epoch, its next sequence, its entries", async () => {
    const fixture = await readFile(
      join(import.meta.dir, "../domain/fixtures/archive/checkpoint.json"),
      "utf8",
    );
    await mkdir(at(COLLECTOR_STATE), { recursive: true });
    await writeFile(at(`${COLLECTOR_STATE}/checkpoint.json`), fixture);
    const saved = parseCheckpoint(fixture);
    if (!saved.ok) throw new Error("the fixture does not parse");
    await put(SESSION, "{}\n");
    const archive = memoryArchive();

    const report = await run(archive);

    expect(report).toMatchObject({ epoch: saved.document.epoch, journal_seq: 3 });
    const after = await checkpoint();
    expect(after?.next_seq).toBe(4);
    for (const entry of saved.document.sources) expect(after?.sources).toContainEqual(entry);
  });
});

describe("a lost checkpoint", () => {
  test("one that does not parse starts a new epoch from sequence 1, every source new", async () => {
    await put(SESSION, transcript(3));
    const archive = memoryArchive();
    await run(archive);
    const epoch = (await checkpoint())?.epoch;
    await writeFile(at(`${COLLECTOR_STATE}/checkpoint.json`), "{");

    await run(archive);

    const now = (await checkpoint())?.epoch;
    expect(now).not.toBe(epoch);
    const record = records(archive).find((each) => each.epoch === now);
    expect(record?.seq).toBe(1);
    expect(captureOf(record, SESSION)).toMatchObject({ generation: 1, offset: 0 });
  });
});

describe("writing the archive", () => {
  test("a blob already stored is success: its key is its content", async () => {
    await put(SESSION, "{}\n");
    const archive = memoryArchive(new Map([[KEYS.blob(sha256Hex("{}\n")), bytes("{}\n")]]));

    const report = await run(archive);

    expect(report).toMatchObject({ outcome: "succeeded", journal_seq: 1 });
    await expectCheckpointBacked(archive);
  });

  test("a journal key already taken advances the sequence until one is free", async () => {
    await put(SESSION, transcript(3));
    const archive = memoryArchive();
    await run(archive);
    const epoch = (await checkpoint())?.epoch ?? "";
    archive.objects.set(KEYS.journal(epoch, 2), bytes("taken"));
    archive.objects.set(KEYS.journal(epoch, 3), bytes("taken"));
    await append(SESSION, transcript(1, "b"));

    const report = await collectOnce(system(archive));

    expect(report).toMatchObject({ kind: "ran", report: { journal_seq: 4 } });
    expect(archive.puts.filter((key) => key.includes("/journal/")).slice(-3)).toEqual([
      KEYS.journal(epoch, 2),
      KEYS.journal(epoch, 3),
      KEYS.journal(epoch, 4),
    ]);
    expect((await checkpoint())?.next_seq).toBe(5);
  });

  test("a blob that fails fails the run; what was stored before it is still recorded", async () => {
    await put(TOOL_RESULT, "tool output");
    await put(SESSION, "{}\n");
    const archive = memoryArchive();
    archive.fault = (key) =>
      key === KEYS.blob(sha256Hex("tool output"))
        ? { kind: "failed", failure: "AccessDenied" }
        : undefined;

    const report = await run(archive);

    expect(report).toMatchObject({ outcome: "failed", failure: "AccessDenied", journal_seq: 1 });
    expect(report.last_success_at).toBeNull();
    expect(report.backlog.files).toBe(1);
    await expectCheckpointBacked(archive);
  });

  test("a journal record that fails leaves the checkpoint's sources as they were", async () => {
    await put(SESSION, "{}\n");
    const archive = memoryArchive();
    archive.fault = (key) =>
      key.includes("/journal/") ? { kind: "failed", failure: "ECONNREFUSED" } : undefined;

    const report = await run(archive);

    expect(report).toMatchObject({ outcome: "failed", failure: "ECONNREFUSED", journal_seq: null });
    expect((await checkpoint())?.sources).toEqual([]);
    expect(report.backlog).toEqual({ files: 1, bytes: 3 });
  });

  test("a run that succeeds after a failure records when it succeeded", async () => {
    await put(SESSION, "{}\n");
    const archive = memoryArchive();
    archive.fault = () => ({ kind: "failed", failure: "SlowDown" });
    await run(archive);
    archive.fault = () => undefined;

    const report = await run(archive);

    expect(report.last_success_at).toBe(report.ended_at);
    expect((await checkpoint())?.last_success_at).toBe(report.ended_at);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a source it cannot read fails the run by its error code, and the rest are collected",
    async () => {
      await put(SESSION, "{}\n");
      await put(TOOL_RESULT, "tool output");
      await chmod(at(TOOL_RESULT), 0o000);
      const archive = memoryArchive();

      const report = await run(archive);

      expect(report).toMatchObject({ outcome: "failed", failure: "EACCES", journal_seq: 1 });
      expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([SESSION]);
    },
  );
});

describe("failures it cannot write past", () => {
  const unprivileged = process.getuid?.() !== 0;

  test.skipIf(!unprivileged)("a directory it cannot list fails the run by its code", async () => {
    await put(SESSION, "{}\n");
    await put(`${PROJECT}/locked/a.jsonl`, "{}\n");
    await chmod(at(`${PROJECT}/locked`), 0o000);

    const report = await run(memoryArchive());
    await chmod(at(`${PROJECT}/locked`), 0o755);

    expect(report).toMatchObject({ outcome: "failed", failure: "EACCES", journal_seq: 1 });
  });

  test("journal keys taken run after run give up for this run and leave the sources", async () => {
    await put(SESSION, "{}\n");
    const archive = memoryArchive();
    const writer = {
      put: (key: string, data: Uint8Array) =>
        key.includes("/journal/")
          ? Promise.resolve({ kind: "exists" as const })
          : archive.put(key, data),
    };

    const report = await run(archive, { writer });

    expect(report).toMatchObject({ outcome: "failed", failure: "JournalKeysTaken" });
    expect(await checkpoint()).toMatchObject({ next_seq: 1001, sources: [] });
  });

  test.skipIf(!unprivileged)(
    "a checkpoint it cannot save fails the run and keeps the one before",
    async () => {
      await put(SESSION, "{}\n");
      const archive = memoryArchive();
      await run(archive);
      const before = await checkpoint();
      await append(SESSION, "{}\n");
      archive.beforePut = () => chmod(at(COLLECTOR_STATE), 0o500);

      const report = await run(archive);
      await chmod(at(COLLECTOR_STATE), 0o700);

      expect(report).toMatchObject({ outcome: "failed", failure: "EACCES", journal_seq: 2 });
      expect(report.last_success_at).toBe(before?.last_success_at ?? "");
      expect(await checkpoint()).toEqual(before);
    },
  );
});

describe("a crash at any put", () => {
  for (const kind of ["crash_before", "crash_after"] as const)
    test(`${kind.replace("_", "es ")} each put, then a restart, leaves the archive whole`, async () => {
      for (let crashAt = 0; crashAt < 4; crashAt += 1) {
        await rm(root, { recursive: true, force: true });
        await mkdir(root);
        history = new Map();
        await put(SESSION, transcript(800));
        await put(SUBAGENT, "{}\n");
        const archive = memoryArchive();
        await run(archive);
        await append(SESSION, transcript(2, "b"));
        await put(SUBAGENT, "{}\n{}\n");
        await put(TOOL_RESULT, "tool output");
        const saved = await readFile(at(`${COLLECTOR_STATE}/checkpoint.json`), "utf8");
        const crashIndex = archive.puts.length + crashAt;
        archive.fault = (_key, index) => (index === crashIndex ? { kind } : undefined);

        await expect(collectOnce(system(archive))).rejects.toBeInstanceOf(Crash);

        expect(await readFile(at(`${COLLECTOR_STATE}/checkpoint.json`), "utf8")).toBe(saved);
        archive.fault = () => undefined;
        await append(SESSION, transcript(1, "c"));
        const report = await run(archive);
        expect(report.outcome).toBe("succeeded");
        await expectCheckpointBacked(archive);
        await expectReassembles(archive);
      }
    });
});

describe("the lock", () => {
  test("a run held elsewhere ends quietly: nothing read, written or saved", async () => {
    await put(SESSION, "{}\n");
    await mkdir(at(COLLECTOR_STATE), { recursive: true });
    const held = await flockExclusive(at(`${COLLECTOR_STATE}/collect.lock`));
    const archive = memoryArchive();

    const result = await collectOnce(system(archive, { incarnation: INCARNATION }));
    held?.release();

    expect(result).toEqual({ kind: "busy" });
    expect(archive.puts).toEqual([]);
    expect(await checkpoint()).toBeUndefined();
  });

  test("is its own: it runs while the install lock is held, and never touches its path", async () => {
    await put(SESSION, "{}\n");
    const archive = memoryArchive();
    expect((await run(archive)).outcome).toBe("succeeded");
    expect(await stat(at(WORKER_PATHS.applyLock)).catch(() => "absent")).toBe("absent");

    await mkdir(dirname(at(WORKER_PATHS.applyLock)), { recursive: true });
    const install = await flockExclusive(at(WORKER_PATHS.applyLock));
    await append(SESSION, "{}\n");
    const report = await run(archive);
    install?.release();
    expect(report.journal_seq).toBe(2);
  });

  test("is released when the run crashes", async () => {
    await put(SESSION, "{}\n");
    const archive = memoryArchive();
    archive.fault = () => ({ kind: "crash_before" });
    await expect(collectOnce(system(archive))).rejects.toBeInstanceOf(Crash);
    archive.fault = () => undefined;
    expect((await collectOnce(system(archive))).kind).toBe("ran");
  });
});

describe("budgets", () => {
  const budget = { milliseconds: 40_000, bytes: 100 * KiB };

  test("the byte budget admits the most recently modified first and leaves the rest", async () => {
    await put(SUBAGENT, transcript(600, "old"));
    await put(TOOL_RESULT, transcript(600, "mid"));
    await put(SESSION, transcript(600, "new"));
    const archive = memoryArchive();

    const first = await run(archive, { budget });

    expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([SESSION]);
    expect(first).toMatchObject({ budget_hit: "bytes", backlog: { files: 2, bytes: 120_000 } });
    await run(archive, { budget });
    expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([TOOL_RESULT]);
    const third = await run(archive, { budget });
    expect(third).toMatchObject({ budget_hit: null, backlog: { files: 0, bytes: 0 } });
    await expectReassembles(archive);
  });

  test("a source larger than the budget progresses by the budget each run", async () => {
    await put(SESSION, transcript(2500));
    const archive = memoryArchive();
    const reports: CollectionReport[] = [];
    for (let n = 0; n < 3; n += 1) reports.push(await run(archive, { budget }));

    expect(reports.map((report) => report.budget_hit)).toEqual(["bytes", "bytes", null]);
    expect(records(archive).map((record) => captureOf(record, SESSION)?.offset ?? -1)).toEqual([
      0,
      100 * KiB,
      200 * KiB,
    ]);
    expect(SMALL_FILE_BYTES).toBeLessThan(budget.bytes);
    await expectReassembles(archive);
  });

  test("the time budget stops starting uploads, and the next run goes on", async () => {
    await put(TOOL_RESULT, "tool output");
    await put(SESSION, transcript(3, "new"));
    const archive = memoryArchive();
    archive.beforePut = () => time.advance(41_000);

    const report = await run(archive);

    expect(report).toMatchObject({ budget_hit: "time", journal_seq: 1 });
    expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([SESSION]);
    expect(report.backlog.files).toBe(1);
    archive.beforePut = () => {};
    expect(await run(archive)).toMatchObject({ budget_hit: null, backlog: { files: 0 } });
  });

  test("the time budget bounds decisions, newest first; what was decided is still stored", async () => {
    const sessions = Array.from({ length: 10 }, (_, n) => `${PROJECT}/s${n}.jsonl`);
    for (const path of sessions) await put(path, transcript(800, path));
    const archive = memoryArchive();
    await run(archive);
    for (const path of sessions.slice(0, -1)) await touch(path);
    const newest = sessions.at(-1) ?? "";
    await append(newest, transcript(2, "more"));
    const slow = clock(Date.parse("2026-10-30T11:00:00.000Z"), 1_000);
    const timed = { budget: { milliseconds: 10_000, bytes: 64 * 1024 * 1024 }, now: slow.now };

    const report = await run(archive, timed);

    expect(report).toMatchObject({ budget_hit: "time", journal_seq: 2 });
    expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([newest]);
    expect(report.backlog.files).toBeGreaterThan(0);
    expect(report.backlog.files).toBeLessThan(sessions.length - 1);
    await expectCheckpointBacked(archive);
    let backlog = report.backlog.files;
    for (let n = 0; n < sessions.length && backlog > 0; n += 1)
      backlog = (await run(archive, timed)).backlog.files;
    expect(backlog).toBe(0);
    await expectReassembles(archive);
  });

  test("a verify still hashing when the time budget passes is left; a new source is not", async () => {
    await put(SESSION, transcript(30_000));
    const archive = memoryArchive();
    await run(archive);
    const captured = (await checkpoint())?.sources[0]?.mtime_ms;
    await put(TOOL_RESULT, "tool output");
    await touch(SESSION);
    const slow = clock(Date.parse("2026-10-30T11:00:00.000Z"), 3_000);

    const report = await run(archive, {
      budget: { milliseconds: 10_000, bytes: 64 * 1024 * 1024 },
      now: slow.now,
    });

    expect(report).toMatchObject({ budget_hit: "time", journal_seq: 2, backlog: { files: 1 } });
    expect(lastRecord(archive)?.captures.map((capture) => capture.path)).toEqual([TOOL_RESULT]);
    const entry = (await checkpoint())?.sources.find((source) => source.path === SESSION);
    expect(entry?.mtime_ms).toBe(captured);
    expect(await run(archive)).toMatchObject({ budget_hit: null, backlog: { files: 0 } });
  });
});

describe("random appends, rewrites and crashes", () => {
  test("reassemble, per source, only real prefix states, the last equal to the file", async () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const paths = [SESSION, SUBAGENT, TOOL_RESULT];
    for (const path of paths) await put(path, transcript(random(900)));
    const archive = memoryArchive();
    const budget = { milliseconds: 40_000, bytes: 96 * KiB };
    for (let round = 0; round < 40; round += 1) {
      for (const path of paths) await mutate(path, random);
      const crashAt = random(6);
      const base = archive.puts.length;
      archive.fault = (_key, index) =>
        crashAt < 2 && index === base + crashAt
          ? { kind: random(2) === 0 ? "crash_before" : "crash_after" }
          : undefined;
      await collectOnce(system(archive, { budget })).catch((error) => {
        if (!(error instanceof Crash)) throw error;
      });
      archive.fault = () => undefined;
      await expectCheckpointBacked(archive);
    }
    for (let n = 0; n < 5; n += 1) await run(archive, { budget });
    await expectReassembles(archive, paths);
  });

  async function mutate(path: string, random: (n: number) => number): Promise<void> {
    const current = await readFile(at(path), "utf8");
    switch (random(6)) {
      case 0:
      case 1:
        return append(path, transcript(random(30), `r${random(100)}`));
      case 2:
        return append(path, `{"partial":${random(100)}`);
      case 3:
        return put(path, current.replace(/"n":\d+/, `"n":${random(1000)}`));
      case 4:
        return put(path, transcript(random(900), `w${random(100)}`));
      default:
    }
  }
});

describe("the checkpoint file", () => {
  test("is written whole, private to the collector, beside its lock", async () => {
    await put(SESSION, "{}\n");
    await run(memoryArchive());

    const saved = await checkpoint();
    expect(saved).toBeDefined();
    expect(await readFile(at(`${COLLECTOR_STATE}/checkpoint.json`), "utf8")).toBe(
      `${checkpointJson(saved as Checkpoint)}\n`,
    );
    expect((await stat(at(`${COLLECTOR_STATE}/checkpoint.json`))).mode & 0o777).toBe(0o600);
  });
});
