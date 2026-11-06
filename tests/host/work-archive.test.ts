/**
 * `host work inspect`'s archive section (`docs/specs/host-protocol.md` §work inspect): the log
 * archive's backlog, counted as root from the collector's checkpoint against the sources' current
 * stats (`docs/specs/collector.md` §Backlog), over a Claude root laid out in a temporary worker
 * root. No checkout is placed, so Git is never run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_ROOT } from "../../src/domain/archive-format";
import { COLLECTOR_STATE } from "../../src/domain/collector-installation";
import type { ApplySystem } from "../../src/host/apply";
import { CHECKPOINT } from "../../src/host/collect";
import { ARCHIVE_BUDGET_MS, workerWork } from "../../src/host/work";
import {
  captured as capturedIn,
  configureCollector,
  type GitWorld,
  gitWorld,
  LAST_SUCCESS,
  PROJECT,
  putFile,
  SESSION,
  SUBAGENT,
  saveCheckpoint as saveCheckpointIn,
  TOOL_RESULT,
} from "./work-scenarios";

let world: GitWorld;

beforeEach(async () => {
  world = await gitWorld();
});
afterEach(async () => {
  await world.remove();
});

const at = (path: string) => world.at(path);
const put = (path: string, content: string) => putFile(world, path, content);
const configure = () => configureCollector(world);
const captured = (path: string) => capturedIn(world, path);
const saveCheckpoint = (sources: Parameters<typeof saveCheckpointIn>[1]) =>
  saveCheckpointIn(world, sources);

async function archive(overrides: Partial<ApplySystem> = {}) {
  return (await workerWork(world.system(overrides)).inspectWork()).archive;
}

describe("host work inspect: the archive's backlog (host-protocol §work inspect)", () => {
  test("a worker without the collector's configuration reports it not collected", async () => {
    await put(SESSION, "{}\n");
    expect(await archive()).toEqual({ state: "not_collected" });
  });

  test("every source as its checkpoint captured it: nothing unarchived, and the last success", async () => {
    await configure();
    await put(SESSION, "{}\n".repeat(10));
    await put(SUBAGENT, "{}\n");
    await saveCheckpoint([await captured(SESSION), await captured(SUBAGENT)]);
    expect(await archive()).toEqual({
      state: "collected",
      complete: true,
      unarchived_files: 0,
      unarchived_bytes: 0,
      last_success_at: LAST_SUCCESS,
    });
  });

  test("a new, a grown and a rewritten source are unarchived, counted by stat alone", async () => {
    await configure();
    await put(SESSION, "0123456789");
    await put(SUBAGENT, "abcdefghij");
    await saveCheckpoint([await captured(SESSION), await captured(SUBAGENT)]);
    await put(SESSION, "0123456789+grown"); // 6 bytes beyond the captured 10
    await put(SUBAGENT, "ABCDEFGHIJ"); // the same size, a later time: all 10 bytes
    await put(TOOL_RESULT, "new result"); // never captured: all 10 bytes
    expect(await archive()).toEqual({
      state: "collected",
      complete: true,
      unarchived_files: 3,
      unarchived_bytes: 26,
      last_success_at: LAST_SUCCESS,
    });
  });

  test("without a checkpoint every source is unarchived, and no run has succeeded", async () => {
    await configure();
    await put(SESSION, "0123456789");
    expect(await archive()).toEqual({
      state: "collected",
      complete: true,
      unarchived_files: 1,
      unarchived_bytes: 10,
      last_success_at: null,
    });
  });

  test("a checkpoint that is a symbolic link is not followed: read as none", async () => {
    await configure();
    await put(SESSION, "0123456789");
    await saveCheckpoint([await captured(SESSION)]);
    const real = join(at(COLLECTOR_STATE), "elsewhere.json");
    await rename(join(at(COLLECTOR_STATE), CHECKPOINT), real);
    await symlink(real, join(at(COLLECTOR_STATE), CHECKPOINT));
    expect(await archive()).toMatchObject({ unarchived_files: 1, last_success_at: null });
  });

  test("the collector's allowlist: no symbolic link followed, no file outside it counted", async () => {
    await configure();
    const outside = await mkdtemp(join(tmpdir(), "fffactory-archive-outside-"));
    try {
      await writeFile(join(outside, "elsewhere.jsonl"), "0123456789");
      await mkdir(at(PROJECT), { recursive: true });
      await symlink(outside, at(`${PROJECT}/linked`));
      await symlink(join(outside, "elsewhere.jsonl"), at(`${PROJECT}/linked.jsonl`));
      await put(`${CLAUDE_ROOT}/.credentials.json`, "secret");
      await put(`${CLAUDE_ROOT}/sessions/1.json`, "state");
      await put(SESSION, "01234");
      expect(await archive()).toMatchObject({ unarchived_files: 1, unarchived_bytes: 5 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("past its time budget it stops counting and says so: at least these, never nothing", async () => {
    await configure();
    await put(SESSION, "0123456789");
    await put(SUBAGENT, "0123456789");
    let now = Date.parse(LAST_SUCCESS);
    const result = await archive({
      now: () => {
        const reading = new Date(now);
        now += ARCHIVE_BUDGET_MS;
        return reading;
      },
    });
    expect(result).toMatchObject({ state: "collected", complete: false });
  });
});
