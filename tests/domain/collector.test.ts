/**
 * docs/specs/collector.md §Sources, §Capture, §Checkpoint, §Budgets, §Backlog.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CLAUDE_ROOT } from "../../src/domain/archive-format";
import {
  backlog,
  budgetedCaptures,
  COLLECTED_DIRECTORIES,
  COLLECTION_BUDGET,
  type Checkpoint,
  captureDecision,
  capturedEntry,
  checkpointJson,
  COLLECTOR_CONFIGURATION,
  type CollectorConfiguration,
  collectable,
  collectorConfigurationJson,
  type EntryKind,
  NEVER_COLLECTED,
  newCheckpoint,
  parseCheckpoint,
  parseCollectorConfiguration,
  SMALL_FILE_BYTES,
  type SourceCheckpoint,
  type SourceStat,
  touchedEntry,
  walkable,
} from "../../src/domain/collector";

const FIXTURES = join(import.meta.dir, "fixtures", "archive");
const HOME = "/home/factory";
const R = CLAUDE_ROOT;
const PROJECT = `${R}/projects/-home-factory--paseo-worktrees-1zu9oxdf-x`;
const EPOCH = "20261030T101500Z-0123456789abcdef";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const MiB = 1024 * 1024;

const file = (path: string, kind: EntryKind = "file", viaSymlink = false) => ({
  path,
  kind,
  viaSymlink,
});

describe("sources", () => {
  const collected: [string, string][] = [
    ["main transcript", `${PROJECT}/0b6e1c3a.jsonl`],
    ["subagent transcript", `${PROJECT}/0b6e1c3a/subagents/agent-a1.jsonl`],
    ["subagent sidecar", `${PROJECT}/0b6e1c3a/subagents/agent-a1.meta.json`],
    ["saved tool result", `${PROJECT}/0b6e1c3a/tool-results/toolu_01.txt`],
    ["project memory file", `${PROJECT}/memory/MEMORY.md`],
    ["file-history backup", `${R}/file-history/0b6e1c3a/3f2a@v2`],
    ["paste cache", `${R}/paste-cache/1.txt`],
    ["plan", `${R}/plans/plan-1.md`],
    ["task", `${R}/tasks/0b6e1c3a/1.json`],
    ["todo", `${R}/todos/0b6e1c3a-agent.json`],
    ["awkward project directory", `${R}/projects/-tmp-a b-ü%#?/x.jsonl`],
  ];
  for (const [what, path] of collected)
    test(`collects a ${what}`, () => expect(collectable(file(path))).toBe(true));

  const refused: [string, ReturnType<typeof file>][] = [
    ["Claude's credentials", file(`${R}/.credentials.json`)],
    ["~/.claude.json", file(`${HOME}/.claude.json`)],
    ["~/.claude.json's backup", file(`${HOME}/.claude.json.backup`)],
    ["the session ingress token", file(`${R}/.session_ingress_token`)],
    ["remote settings", file(`${R}/remote-settings.json`)],
    ["policy limits", file(`${R}/policy-limits.json`)],
    ["session-env", file(`${R}/session-env/0b6e1c3a/env`)],
    ["shell snapshots", file(`${R}/shell-snapshots/snapshot-bash-1.sh`)],
    ["sessions", file(`${R}/sessions/1.json`)],
    ["backups", file(`${R}/backups/.claude.json.backup.1`)],
    ["fffactory's configuration", file(`${HOME}/.config/fffactory/collector.json`)],
    ["Codex's home", file(`${HOME}/.codex/auth.json`)],
    ["settings at the root", file(`${R}/settings.json`)],
    ["plugins", file(`${R}/plugins/x/plugin.json`)],
    ["a dot-dot escape", file(`${R}/projects/../.credentials.json`)],
    ["a dot-dot escape further down", file(`${PROJECT}/../../.credentials.json`)],
    ["a dot segment", file(`${R}/projects/./x.jsonl`)],
    ["an empty segment", file(`${R}//projects/x.jsonl`)],
    ["a trailing slash", file(`${R}/projects/x/`)],
    ["a relative path", file("projects/x.jsonl")],
    ["a look-alike root", file(`${R}-backup/projects/x.jsonl`)],
    ["a look-alike directory", file(`${R}/projectsx/x.jsonl`)],
    ["a collected directory itself", file(`${R}/projects`)],
    ["a credentials file copied into projects", file(`${PROJECT}/.credentials.json`)],
    ["a session token copied into file-history", file(`${R}/file-history/.session_ingress_token`)],
    ["a symbolic link", file(`${PROJECT}/x.jsonl`, "symlink")],
    ["a file through a symbolic link", file(`${PROJECT}/x.jsonl`, "file", true)],
    ["a directory", file(`${PROJECT}/0b6e1c3a`, "directory")],
    ["a socket or device", file(`${PROJECT}/x`, "other")],
    ["a NUL in a name", file(`${PROJECT}/x\0.jsonl`)],
  ];
  for (const [what, entry] of refused)
    test(`never collects ${what}`, () => expect(collectable(entry)).toBe(false));

  test("every never-collected path is refused, and as a directory prefix too", () => {
    for (const path of NEVER_COLLECTED) {
      expect(collectable(file(path))).toBe(false);
      expect(collectable(file(`${path}/x`))).toBe(false);
    }
  });

  test("discovery walks only the root and the collected directories", () => {
    expect(walkable(R)).toBe(true);
    for (const directory of COLLECTED_DIRECTORIES) {
      expect(walkable(`${R}/${directory}`)).toBe(true);
      expect(walkable(`${R}/${directory}/sub/dir`)).toBe(true);
    }
    for (const path of [
      `${R}/session-env`,
      `${R}/shell-snapshots`,
      `${R}/projects/..`,
      `${R}/projects/../sessions`,
      `${HOME}/.codex`,
      HOME,
      `${R}/`,
    ])
      expect(walkable(path)).toBe(false);
  });
});

const ENTRY: SourceCheckpoint = {
  source: A,
  path: `${PROJECT}/0b6e1c3a.jsonl`,
  identity: "66306:1234",
  mtime_ms: 1_000,
  generation: 2,
  length: 1 * MiB,
  prefix_sha256: B,
};
const stat = (overrides: Partial<SourceStat> = {}): SourceStat => ({
  identity: ENTRY.identity,
  size: ENTRY.length,
  mtime_ms: ENTRY.mtime_ms,
  ...overrides,
});

describe("capture decision", () => {
  test("first sight: a new generation, whole", () => {
    expect(captureDecision(undefined, stat({ size: 300 }))).toEqual({
      kind: "new_generation",
      reason: "first",
      generation: 1,
      length: 300,
    });
  });

  test("unchanged: same size and modification time, never read", () => {
    expect(captureDecision(ENTRY, stat())).toEqual({ kind: "unchanged" });
  });

  test("grown: verify the captured prefix first", () => {
    expect(captureDecision(ENTRY, stat({ size: 2 * MiB, mtime_ms: 2_000 }))).toEqual({
      kind: "verify",
      length: ENTRY.length,
    });
  });

  test("append: the prefix matches and the file grew", () => {
    expect(captureDecision(ENTRY, stat({ size: 2 * MiB, mtime_ms: 2_000 }), B)).toEqual({
      kind: "append",
      generation: 2,
      offset: ENTRY.length,
      length: MiB,
    });
  });

  test("same length, touched only: unchanged", () => {
    expect(captureDecision(ENTRY, stat({ mtime_ms: 2_000 }))).toEqual({
      kind: "verify",
      length: ENTRY.length,
    });
    expect(captureDecision(ENTRY, stat({ mtime_ms: 2_000 }), B)).toEqual({ kind: "unchanged" });
  });

  test("same-length early edit: a new generation", () => {
    expect(captureDecision(ENTRY, stat({ mtime_ms: 2_000 }), C)).toEqual({
      kind: "new_generation",
      reason: "rewritten",
      generation: 3,
      length: ENTRY.length,
    });
  });

  test("grown after an early edit: a new generation, whole", () => {
    expect(captureDecision(ENTRY, stat({ size: 2 * MiB, mtime_ms: 2_000 }), C)).toEqual({
      kind: "new_generation",
      reason: "rewritten",
      generation: 3,
      length: 2 * MiB,
    });
  });

  test("shrunk: a new generation, without reading the prefix", () => {
    expect(captureDecision(ENTRY, stat({ size: 10, mtime_ms: 2_000 }))).toEqual({
      kind: "new_generation",
      reason: "shrunk",
      generation: 3,
      length: 10,
    });
  });

  test("replaced (a new identity): a new generation, even at the same size and time", () => {
    expect(captureDecision(ENTRY, stat({ identity: "66306:9999" }))).toEqual({
      kind: "new_generation",
      reason: "replaced",
      generation: 3,
      length: ENTRY.length,
    });
  });

  test("small files are uploaded whole on any change", () => {
    const small = { ...ENTRY, length: 100 };
    expect(captureDecision(small, stat({ size: 200, mtime_ms: 2_000 }))).toEqual({
      kind: "new_generation",
      reason: "changed",
      generation: 3,
      length: 200,
    });
    expect(captureDecision(small, stat({ size: SMALL_FILE_BYTES, mtime_ms: 2_000 }))).toEqual({
      kind: "new_generation",
      reason: "changed",
      generation: 3,
      length: SMALL_FILE_BYTES,
    });
    expect(captureDecision(small, stat({ size: 100 }))).toEqual({ kind: "unchanged" });
    expect(captureDecision(small, stat({ size: SMALL_FILE_BYTES + 1, mtime_ms: 2_000 }))).toEqual({
      kind: "verify",
      length: 100,
    });
  });

  test("an empty captured prefix always matches what it is given", () => {
    const empty = { ...ENTRY, length: 0 };
    expect(captureDecision(empty, stat({ size: 2 * MiB, mtime_ms: 2_000 }), B)).toMatchObject({
      kind: "append",
      offset: 0,
    });
  });

  test("the checkpoint entry a capture leaves", () => {
    const grown = stat({ size: 2 * MiB, mtime_ms: 2_000 });
    expect(
      capturedEntry(ENTRY, grown, { kind: "append", generation: 2, offset: MiB, length: MiB }, C),
    ).toEqual({ ...ENTRY, mtime_ms: 2_000, length: 2 * MiB, prefix_sha256: C });
    const replaced = stat({ identity: "1:2", size: 5 });
    expect(
      capturedEntry(
        { source: A, path: ENTRY.path },
        replaced,
        { kind: "new_generation", reason: "first", generation: 1, length: 5 },
        C,
      ),
    ).toEqual({
      source: A,
      path: ENTRY.path,
      identity: "1:2",
      mtime_ms: ENTRY.mtime_ms,
      generation: 1,
      length: 5,
      prefix_sha256: C,
    });
  });

  test("verified unchanged: the checkpoint records only the new modification time", () => {
    const touched = stat({ mtime_ms: 2_000 });
    expect(captureDecision(ENTRY, touched, B)).toEqual({ kind: "unchanged" });
    expect(touchedEntry(ENTRY, touched)).toEqual({ ...ENTRY, mtime_ms: 2_000 });
    expect(captureDecision(touchedEntry(ENTRY, touched), touched)).toEqual({ kind: "unchanged" });
  });

  test("only an entry stat finds as captured but for its time can be touched", () => {
    expect(() => touchedEntry(ENTRY, stat({ size: 2 * MiB, mtime_ms: 2_000 }))).toThrow();
    expect(() => touchedEntry(ENTRY, stat({ identity: "1:1", mtime_ms: 2_000 }))).toThrow();
  });
});

const CHECKPOINT: Checkpoint = {
  format: 1,
  epoch: EPOCH,
  next_seq: 3,
  saved_at: "2026-10-30T10:16:02.000Z",
  last_success_at: "2026-10-30T10:16:02.000Z",
  discovery_after: `${R}/file-history/0b6e1c3a`,
  sources: [
    ENTRY,
    {
      source: C,
      path: `${R}/file-history/0b6e1c3a/3f2a@v2`,
      identity: "66306:77",
      mtime_ms: 900,
      generation: 1,
      length: 42,
      prefix_sha256: A,
    },
  ],
};

describe("checkpoint", () => {
  test("checkpoint.json is the serializer's output, and round-trips", async () => {
    const text = await Bun.file(join(FIXTURES, "checkpoint.json")).text();
    expect(`${checkpointJson(CHECKPOINT)}\n`).toBe(text);
    expect(parseCheckpoint(text)).toEqual({ ok: true, document: CHECKPOINT });
  });

  test("sources are written in source ID order", () => {
    const reversed = { ...CHECKPOINT, sources: [...CHECKPOINT.sources].reverse() };
    expect(checkpointJson(reversed)).toBe(checkpointJson(CHECKPOINT));
  });

  test("a new checkpoint is an empty epoch from sequence 1", () => {
    expect(newCheckpoint(EPOCH, "2026-10-30T10:15:00.000Z")).toEqual({
      format: 1,
      epoch: EPOCH,
      next_seq: 1,
      saved_at: "2026-10-30T10:15:00.000Z",
      last_success_at: null,
      discovery_after: null,
      sources: [],
    });
  });

  test("a checkpoint saved before discovery resumed reads as starting from the beginning", () => {
    const { discovery_after: _, ...older } = CHECKPOINT;
    const parsed = parseCheckpoint(JSON.stringify(older));
    expect(parsed).toEqual({ ok: true, document: { ...CHECKPOINT, discovery_after: null } });
  });

  test("an unreadable checkpoint is refused, so the run starts a new epoch", () => {
    for (const text of [
      "",
      "{",
      JSON.stringify({ ...CHECKPOINT, format: 2 }),
      JSON.stringify({ ...CHECKPOINT, next_seq: 0 }),
      JSON.stringify({ ...CHECKPOINT, sources: [{ ...ENTRY, identity: "" }] }),
      JSON.stringify({ ...CHECKPOINT, sources: [{ ...ENTRY, path: `${R}/../x` }] }),
      JSON.stringify({ ...CHECKPOINT, sources: [ENTRY, ENTRY] }),
      JSON.stringify({ ...CHECKPOINT, discovery_after: `${R}/../x` }),
      JSON.stringify({ ...CHECKPOINT, discovery_after: "/etc" }),
    ])
      expect(parseCheckpoint(text).ok).toBe(false);
  });
});

describe("budgets", () => {
  const pending = (source: string, mtime_ms: number, bytes: number) => ({
    source,
    mtime_ms,
    captured: {
      kind: "new_generation" as const,
      reason: "first" as const,
      generation: 1,
      length: bytes,
    },
  });
  const sources = (result: ReturnType<typeof budgetedCaptures>) =>
    result.admitted.map((item) => item.source);

  test("40 s, 64 MiB and 50 000 entries discovered per run, more than a small file", () => {
    expect(COLLECTION_BUDGET).toEqual({ milliseconds: 40_000, bytes: 64 * MiB, entries: 50_000 });
    expect(COLLECTION_BUDGET.bytes).toBeGreaterThan(SMALL_FILE_BYTES);
  });

  test("newest first, ties by source ID, everything when it fits", () => {
    const result = budgetedCaptures(
      [pending("b", 1, 10), pending("c", 3, 10), pending("a", 1, 10)],
      100,
    );
    expect(sources(result)).toEqual(["c", "a", "b"]);
    expect(result.budget_hit).toBe(false);
  });

  test("exactly the budget fits", () => {
    const result = budgetedCaptures([pending("a", 2, 60), pending("b", 1, 40)], 100);
    expect(sources(result)).toEqual(["a", "b"]);
    expect(result.budget_hit).toBe(false);
  });

  test("stops at the first capture over the byte budget", () => {
    const result = budgetedCaptures(
      [pending("old", 1, 10), pending("newest", 9, 60), pending("middle", 5, 50)],
      100,
    );
    expect(sources(result)).toEqual(["newest"]);
    expect(result.admitted[0]?.captured.length).toBe(60);
    expect(result.budget_hit).toBe(true);
  });

  test("a first capture over the budget is cut to it, and later runs append the rest", () => {
    const result = budgetedCaptures([pending("huge", 2, 500), pending("small", 1, 1)], 100);
    expect(result.admitted).toEqual([{ ...pending("huge", 2, 100) }]);
    expect(result.budget_hit).toBe(true);

    const append = {
      source: "huge",
      mtime_ms: 2,
      captured: { kind: "append" as const, generation: 1, offset: 100, length: 400 },
    };
    expect(budgetedCaptures([append], 100)).toEqual({
      admitted: [{ ...append, captured: { ...append.captured, length: 100 } }],
      budget_hit: true,
    });
  });

  test("the rest of a cut capture is appended, never captured whole again", () => {
    const size = COLLECTION_BUDGET.bytes * 3;
    const first = captureDecision(undefined, stat({ size }));
    if (first.kind !== "new_generation") throw new Error("not a new generation");
    const [cut] = budgetedCaptures(
      [{ source: A, mtime_ms: 1_000, captured: first }],
      COLLECTION_BUDGET.bytes,
    ).admitted;
    if (cut === undefined) throw new Error("not admitted");
    const entry = capturedEntry(ENTRY, stat({ size }), cut.captured, C);
    expect(entry.length).toBe(COLLECTION_BUDGET.bytes);
    expect(captureDecision(entry, stat({ size }))).toEqual({
      kind: "verify",
      length: COLLECTION_BUDGET.bytes,
    });
    expect(captureDecision(entry, stat({ size }), C)).toEqual({
      kind: "append",
      generation: 1,
      offset: COLLECTION_BUDGET.bytes,
      length: size - COLLECTION_BUDGET.bytes,
    });
  });

  test("nothing pending admits nothing", () => {
    expect(budgetedCaptures([], 100)).toEqual({ admitted: [], budget_hit: false });
  });
});

describe("backlog", () => {
  const observed = (source: string, overrides: Partial<SourceStat>) => ({
    source,
    stat: stat(overrides),
  });

  test("no checkpoint: every source, every byte", () => {
    expect(backlog(null, [observed(A, { size: 10 }), observed(B, { size: 5 })])).toEqual({
      files: 2,
      bytes: 15,
    });
  });

  test("nothing unarchived when every source is as captured", () => {
    expect(backlog(CHECKPOINT, [observed(A, {})])).toEqual({ files: 0, bytes: 0 });
  });

  test("new, grown and rewritten sources", () => {
    expect(
      backlog(CHECKPOINT, [
        observed(B, { size: 7 }),
        observed(A, { size: ENTRY.length + 100, mtime_ms: 2_000 }),
      ]),
    ).toEqual({ files: 2, bytes: 107 });
    expect(backlog(CHECKPOINT, [observed(A, { size: 10, mtime_ms: 2_000 })])).toEqual({
      files: 1,
      bytes: 10,
    });
    expect(backlog(CHECKPOINT, [observed(A, { identity: "1:1" })])).toEqual({
      files: 1,
      bytes: ENTRY.length,
    });
    expect(backlog(CHECKPOINT, [observed(A, { mtime_ms: 2_000 })])).toEqual({
      files: 1,
      bytes: ENTRY.length,
    });
  });

  test("a touched entry is archived", () => {
    const touched = touchedEntry(ENTRY, stat({ mtime_ms: 2_000 }));
    const checkpoint = { ...CHECKPOINT, sources: [touched] };
    expect(backlog(checkpoint, [observed(A, { mtime_ms: 2_000 })])).toEqual({
      files: 0,
      bytes: 0,
    });
  });

  test("an empty file counts whenever the run would capture it", () => {
    const empty = { size: 0, mtime_ms: 2_000 };
    expect(backlog(CHECKPOINT, [observed(B, empty)])).toEqual({ files: 1, bytes: 0 });
    expect(backlog(CHECKPOINT, [observed(A, empty)])).toEqual({ files: 1, bytes: 0 });
    expect(backlog(CHECKPOINT, [observed(A, { ...empty, identity: "1:1" })])).toEqual({
      files: 1,
      bytes: 0,
    });
    const captured = { ...CHECKPOINT, sources: [{ ...ENTRY, length: 0, mtime_ms: 2_000 }] };
    expect(backlog(captured, [observed(A, empty)])).toEqual({ files: 0, bytes: 0 });
    expect(backlog(captured, [observed(A, { size: 0, mtime_ms: 3_000 })])).toEqual({
      files: 1,
      bytes: 0,
    });
  });

  test("a source gone from disk is not backlog", () => {
    expect(backlog(CHECKPOINT, [])).toEqual({ files: 0, bytes: 0 });
  });
});

describe("the collector's configuration (§Credentials and publishing)", () => {
  const CONFIGURATION: CollectorConfiguration = {
    format: 1,
    factory_id: "fff-r29c2un6",
    host_key: "builder-1",
    bucket: "fff-r29c2un6-logs-123456789012-us-east-1-an",
    region: "us-east-1",
  } as CollectorConfiguration;
  const text = () => Bun.file(join(FIXTURES, "collector.json")).text();

  test("lives in /etc/fffactory, beside nothing secret", () => {
    expect(COLLECTOR_CONFIGURATION).toBe("/etc/fffactory/collector.json");
  });

  test("is its serializer's output byte for byte, and parses back without loss", async () => {
    const fixture = await text();
    expect(`${collectorConfigurationJson(CONFIGURATION)}\n`).toBe(fixture);
    expect(parseCollectorConfiguration(fixture)).toEqual({ ok: true, document: CONFIGURATION });
  });

  test("ignores fields it does not know, and rejects another format first", async () => {
    const fields = JSON.parse(await text());
    expect(parseCollectorConfiguration(JSON.stringify({ ...fields, later: 1 }))).toEqual({
      ok: true,
      document: CONFIGURATION,
    });
    expect(parseCollectorConfiguration(JSON.stringify({ format: 2 }))).toEqual({
      ok: false,
      kind: "unsupported_format",
      format: 2,
    });
  });

  test("names a malformed field without quoting it", async () => {
    const fields = JSON.parse(await text());
    for (const [field, value] of [
      ["factory_id", "not a factory"],
      ["host_key", "Builder 1"],
      ["bucket", "Not_A_Bucket"],
      ["region", "the moon"],
    ] as const) {
      const parsed = parseCollectorConfiguration(JSON.stringify({ ...fields, [field]: value }));
      expect(parsed).toEqual({
        ok: false,
        kind: "invalid",
        problem: expect.stringContaining(field),
      });
      expect(JSON.stringify(parsed)).not.toContain(value);
    }
    expect(parseCollectorConfiguration("{")).toMatchObject({ ok: false, kind: "invalid" });
  });
});
