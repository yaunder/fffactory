/** docs/specs/collector.md §Archive format v1. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ARCHIVE_FORMAT,
  archiveKeys,
  type Capture,
  CLAUDE_ROOT,
  callerIncarnation,
  type Heartbeat,
  heartbeatJson,
  type Incarnation,
  incarnationJson,
  isEpoch,
  isS3SafeKey,
  isSourcePath,
  type JournalRecord,
  journalJson,
  newEpoch,
  parseHeartbeat,
  parseIncarnation,
  parseJournal,
  type WorkerIncarnation,
} from "../../src/domain/archive-format";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";

const FIXTURES = join(import.meta.dir, "fixtures", "archive");
const fixture = (name: string) => Bun.file(join(FIXTURES, name)).text();

const FACTORY = "fff-r29c2un6" as FactoryId;
const WORKER: WorkerIncarnation = {
  role_id: "AROAEXAMPLEROLEID1234",
  instance_id: "i-0123456789abcdef0",
};
const EPOCH = "20261030T101500Z-0123456789abcdef";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const PROJECT = `${CLAUDE_ROOT}/projects/-home-factory--paseo-worktrees-1zu9oxdf-x`;

const INCARNATION: Incarnation = {
  format: ARCHIVE_FORMAT,
  factory_id: FACTORY,
  host_key: "builder-1" as HostKey,
  role_id: WORKER.role_id,
  instance_id: WORKER.instance_id,
  created_at: "2026-10-30T10:15:00.000Z",
  release: "0.0.9" as Release,
  claude_code_version: "2.1.302",
  claude_root: CLAUDE_ROOT,
};

const CAPTURE: Capture = {
  source: A,
  path: `${PROJECT}/0b6e1c3a-session.jsonl`,
  generation: 1,
  offset: 4096,
  length: 512,
  blob: B,
  base_sha256: D,
  prefix_sha256: C,
  mtime_ms: 1793355360000,
};

const JOURNAL: JournalRecord = {
  format: ARCHIVE_FORMAT,
  epoch: EPOCH,
  seq: 2,
  run_started_at: "2026-10-30T10:16:00.000Z",
  captures: [
    CAPTURE,
    {
      source: D,
      path: `${PROJECT}/0b6e1c3a-session/subagents/agent-1.meta.json`,
      generation: 3,
      offset: 0,
      length: 120,
      blob: C,
      base_sha256: null,
      prefix_sha256: C,
      mtime_ms: 1793355350000,
    },
  ],
};

const HEARTBEAT: Heartbeat = {
  format: ARCHIVE_FORMAT,
  at: "2026-10-30T10:16:02.345Z",
  epoch: EPOCH,
  boot_id: "6f2c1d9e-3b4a-4c5d-8e7f-0123456789ab",
  release: "0.0.9" as Release,
  claude_code_version: null,
  outcome: "failed",
  failure: "AccessDenied",
  budget_hit: "bytes",
  uploaded_bytes: 632,
  journal_seq: null,
  last_success_at: "2026-10-30T10:15:01.000Z",
  backlog: { files: 3, bytes: 70_000_000 },
};

describe("keys", () => {
  const keys = archiveKeys(FACTORY, WORKER);
  const prefix = "archive/1/fff-r29c2un6/workers/AROAEXAMPLEROLEID1234:i-0123456789abcdef0/";

  test("every key sits under the incarnation's own prefix", () => {
    expect(keys.prefix).toBe(prefix);
    expect(keys.incarnation).toBe(`${prefix}incarnation.json`);
    expect(keys.blob(A)).toBe(`${prefix}blobs/sha256/${A}`);
    expect(keys.journal(EPOCH, 2)).toBe(`${prefix}journal/${EPOCH}/0000000002.json`);
    expect(keys.heartbeat("2026-10-30T10:16:02.345Z")).toBe(
      `${prefix}heartbeat/2026-10-30/20261030T101602.345Z.json`,
    );
  });

  test("journal keys sort in sequence order", () => {
    const sorted = [10, 9, 100, 1].map((seq) => keys.journal(EPOCH, seq)).sort();
    expect(sorted).toEqual([1, 9, 10, 100].map((seq) => keys.journal(EPOCH, seq)));
  });

  test("refuses what would make a bad key", () => {
    expect(() => keys.blob("A".repeat(64))).toThrow();
    expect(() => keys.journal("not-an-epoch", 1)).toThrow();
    expect(() => keys.journal(EPOCH, 0)).toThrow();
    expect(() => keys.journal(EPOCH, 1.5)).toThrow();
    expect(() => keys.heartbeat("yesterday")).toThrow();
    expect(() => archiveKeys(FACTORY, { ...WORKER, instance_id: "../x" })).toThrow();
  });

  test("keys are S3-safe whatever the encoded project directory, which they never carry", () => {
    const awkward = [
      "-home-factory--paseo-worktrees-1zu9oxdf-dispatch-epic-117-20261030t103020z",
      "-tmp-a b-c",
      "-home-factory-ünïcødé-dir",
      "-home-factory-%2F-?#[]{}<>|\\^~`\"'",
    ];
    for (const directory of awkward) {
      const record: JournalRecord = {
        ...JOURNAL,
        captures: [{ ...CAPTURE, path: `${CLAUDE_ROOT}/projects/${directory}/x.jsonl` }],
      };
      const keysWritten = [
        keys.incarnation,
        keys.blob(CAPTURE.blob),
        keys.journal(record.epoch, record.seq),
        keys.heartbeat(HEARTBEAT.at),
      ];
      for (const key of keysWritten) {
        expect(isS3SafeKey(key)).toBe(true);
        expect(key).not.toContain(directory);
      }
      expect(parseJournal(journalJson(record))).toEqual({ ok: true, document: record });
    }
  });

  test("isS3SafeKey refuses unsafe characters and segments", () => {
    for (const key of ["a b", "a//b", "a/../b", "a/./b", "/a", "a#b", "a\\b", "", "x".repeat(1025)])
      expect(isS3SafeKey(key)).toBe(false);
  });
});

describe("the caller's incarnation", () => {
  test("reads aws:userid as role ID and instance ID", () => {
    expect(callerIncarnation("AROAEXAMPLEROLEID1234:i-0123456789abcdef0")).toEqual(WORKER);
  });

  test("refuses anything but an instance role's", () => {
    for (const userId of [
      "AIDAEXAMPLEUSERID1234",
      "AROAEXAMPLEROLEID1234:operator-session",
      "AROAEXAMPLEROLEID1234:i-0123/../x",
      "aroa:i-0123456789abcdef0",
      "",
    ])
      expect(callerIncarnation(userId)).toBeUndefined();
  });
});

describe("epochs", () => {
  test("a new epoch is the time and eight random bytes", () => {
    const epoch = newEpoch(new Date("2026-10-30T10:15:00.789Z"), (count) =>
      new Uint8Array(count).map((_, index) => index * 17),
    );
    expect(epoch).toBe("20261030T101500Z-0011223344556677");
    expect(isEpoch(epoch)).toBe(true);
  });

  test("isEpoch refuses other shapes", () => {
    for (const value of ["", "20261030T101500Z", "20261030T101500Z-0123456789ABCDEF", "../x"])
      expect(isEpoch(value)).toBe(false);
  });
});

describe("source paths", () => {
  test("are absolute paths under Claude's root with plain segments", () => {
    expect(isSourcePath(`${PROJECT}/a.jsonl`)).toBe(true);
    for (const path of [
      "projects/a.jsonl",
      CLAUDE_ROOT,
      `${CLAUDE_ROOT}/`,
      `${CLAUDE_ROOT}/projects/../.credentials.json`,
      `${CLAUDE_ROOT}/projects/./a`,
      `${CLAUDE_ROOT}//projects/a`,
      `${CLAUDE_ROOT}/projects/a/`,
      `${CLAUDE_ROOT}/projects/a\0b`,
      `${CLAUDE_ROOT}-other/projects/a`,
      `${CLAUDE_ROOT}/projects/${"x".repeat(4096)}`,
    ])
      expect(isSourcePath(path)).toBe(false);
  });
});

describe("documents", () => {
  const cases = [
    ["incarnation.json", INCARNATION, incarnationJson, parseIncarnation],
    ["journal.json", JOURNAL, journalJson, parseJournal],
    ["heartbeat.json", HEARTBEAT, heartbeatJson, parseHeartbeat],
  ] as const;

  for (const [name, document, serialize, parse] of cases) {
    test(`${name} is the serializer's output, and round-trips`, async () => {
      const text = await fixture(name);
      expect(`${(serialize as (value: typeof document) => string)(document)}\n`).toBe(text);
      const parsed = parse(text);
      expect(parsed).toEqual({ ok: true, document } as never);
      if (parsed.ok)
        expect(`${(serialize as (value: typeof document) => string)(parsed.document)}\n`).toBe(
          text,
        );
    });

    test(`${name}: another format is unsupported, unknown fields are ignored`, async () => {
      const fields = JSON.parse(await fixture(name));
      expect(parse(JSON.stringify({ ...fields, format: 2 }))).toEqual({
        ok: false,
        kind: "unsupported_format",
        format: 2,
      });
      expect(parse(JSON.stringify({ ...fields, later: true }))).toEqual({
        ok: true,
        document,
      } as never);
    });
  }

  test("a malformed document names the field, never its value", () => {
    const secretish = "AKIAIOSFODNN7EXAMPLE/../";
    const results = [
      parseIncarnation(JSON.stringify({ ...INCARNATION, host_key: secretish })),
      parseJournal(JSON.stringify({ ...JOURNAL, captures: [{ ...CAPTURE, blob: secretish }] })),
      parseJournal(JSON.stringify({ ...JOURNAL, captures: [{ ...CAPTURE, path: secretish }] })),
      parseHeartbeat(JSON.stringify({ ...HEARTBEAT, failure: secretish })),
      parseHeartbeat(JSON.stringify({ ...HEARTBEAT, outcome: secretish })),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("AKIA");
    }
    expect(parseJournal("not json")).toEqual({
      ok: false,
      kind: "invalid",
      problem: "the document is not JSON",
    });
    expect(parseJournal("[]")).toMatchObject({ ok: false, kind: "invalid" });
    expect(parseJournal(JSON.stringify({ ...JOURNAL, format: "1" }))).toMatchObject({
      ok: false,
      kind: "invalid",
    });
  });

  test("a journal refuses captures that cannot describe bytes", () => {
    const capture = CAPTURE;
    for (const broken of [
      { ...capture, generation: 0 },
      { ...capture, offset: -1 },
      { ...capture, length: 1.5 },
      { ...capture, mtime_ms: "now" },
      { ...capture, source: "x" },
      { ...capture, base_sha256: "x" },
      { ...capture, base_sha256: null },
      { ...capture, offset: 0 },
      { ...capture, base_sha256: undefined },
    ])
      expect(parseJournal(JSON.stringify({ ...JOURNAL, captures: [broken] })).ok).toBe(false);
    expect(parseJournal(JSON.stringify({ ...JOURNAL, captures: [] })).ok).toBe(false);
    expect(parseJournal(JSON.stringify({ ...JOURNAL, seq: 0 })).ok).toBe(false);
  });

  test("a heartbeat's nullable fields and states", () => {
    const succeeded: Heartbeat = {
      ...HEARTBEAT,
      claude_code_version: "2.1.302",
      outcome: "succeeded",
      failure: null,
      budget_hit: null,
      journal_seq: 7,
      last_success_at: null,
    };
    expect(parseHeartbeat(heartbeatJson(succeeded))).toEqual({ ok: true, document: succeeded });
    expect(
      parseHeartbeat(JSON.stringify({ ...HEARTBEAT, backlog: { files: -1, bytes: 0 } })).ok,
    ).toBe(false);
    expect(parseHeartbeat(JSON.stringify({ ...HEARTBEAT, budget_hit: "memory" })).ok).toBe(false);
    expect(parseHeartbeat(JSON.stringify({ ...HEARTBEAT, at: "yesterday" })).ok).toBe(false);
  });

  test("a succeeded run carries no failure", () => {
    expect(
      parseHeartbeat(
        JSON.stringify({ ...HEARTBEAT, outcome: "succeeded", failure: "AccessDenied" }),
      ),
    ).toMatchObject({ ok: false, kind: "invalid" });
  });
});
