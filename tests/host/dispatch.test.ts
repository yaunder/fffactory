import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_PROJECTION_PATH,
  DISPATCH_RESULT_PATH,
  dispatchProjection,
  dispatchProjectionJson,
} from "../../src/domain/dispatch-projection";
import type { Release } from "../../src/domain/instance";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import type { ApplySystem } from "../../src/host/apply";
import { workerDispatch } from "../../src/host/dispatch";
import type { ProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { system, WORKER_HOSTNAME } from "./worker-scenarios";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-dispatch-"));
  const files: [string, string][] = [
    ["steps/dispatch/factory-dispatch", "#!/usr/bin/env python3\n"],
    ["steps/dispatch/skill/SKILL.md", "---\nname: dispatch\n---\n"],
    ["steps/dispatch/dispatch-schedule.sh", "#!/bin/bash\n"],
    ["steps/control-plane/paseo-auth.sh", "#!/bin/bash\n"],
  ];
  for (const [relative, contents] of files) {
    const path = join(root, WORKER_PATHS.activeRelease, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents, { mode: 0o755 });
  }
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const SETTINGS = {
  enabled: true,
  cron: "*/17 * * * *",
  timezone: "America/Chicago",
  provider: "codex",
  model: "configured-model",
  mode: "default",
  cwd: "/home/factory",
} as const;
const PROJECTION = dispatchProjectionJson(dispatchProjection(WORKER_HOSTNAME, SETTINGS, true, []));

function endpoint(run: ProcessRunner, input = PROJECTION, isRoot = true) {
  const worker: ApplySystem = {
    ...system(root),
    run,
    now: () => new Date(),
    isRoot: () => isRoot,
    readInput: async () => input,
    release: "0.3.0" as Release,
    lock: async () => ({ release: () => {} }),
  };
  return workerDispatch(worker);
}

describe("the worker dispatch endpoint", () => {
  test("installs the stable entrypoint and skill, reconciles as factory, and persists active", async () => {
    const calls: readonly string[][] = [];
    const run: ProcessRunner = async (argv) => {
      (calls as string[][]).push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "{}", stderr: "" };
    };
    const result = await endpoint(run).reconcileDispatch();
    expect(result).toEqual({ protocol_version: 1, state: "active", blockers: [], changed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("factory");
    expect(calls[0]).toContain("--apply");
    expect(calls[0]).toContain(join(root, DISPATCH_PROJECTION_PATH));
    expect(await readFile(join(root, "/usr/local/bin/factory-dispatch"), "utf8")).toContain(
      "python3",
    );
    expect(
      await readFile(join(root, "/home/factory/.agents/skills/dispatch/SKILL.md"), "utf8"),
    ).toContain("name: dispatch");
    expect(
      await readFile(join(root, "/home/factory/.claude/skills/dispatch/SKILL.md"), "utf8"),
    ).toContain("name: dispatch");
    expect(await readFile(join(root, DISPATCH_RESULT_PATH), "utf8")).toContain('"state": "active"');
  });

  test("a matching rerun is a checked no-op", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "{}", stderr: "" };
    };
    const dispatch = endpoint(run);
    await dispatch.reconcileDispatch();
    calls.length = 0;
    expect(await dispatch.reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--check");
  });

  test("a matching schedule still refreshes changed release-owned assets", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "{}", stderr: "" };
    };
    const dispatch = endpoint(run);
    await dispatch.reconcileDispatch();
    await writeFile(
      join(root, WORKER_PATHS.activeRelease, "steps/dispatch/factory-dispatch"),
      "#!/usr/bin/env python3\n# new release\n",
    );
    calls.length = 0;

    expect(await dispatch.reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--check");
    expect(await readFile(join(root, "/usr/local/bin/factory-dispatch"), "utf8")).toContain(
      "new release",
    );
  });

  test("inspection reports failure when the real schedule drifts from recorded active state", async () => {
    let checking = false;
    const dispatch = endpoint(async (argv) => {
      const check = argv.includes("--check");
      return {
        kind: "exited",
        exitCode: check && checking ? 1 : 0,
        stdout: "{}",
        stderr: "",
      };
    });
    await dispatch.reconcileDispatch();
    checking = true;

    expect(await dispatch.inspectDispatch()).toEqual({
      protocol_version: 1,
      state: "failed",
      blockers: [],
      reason: "dispatch schedule differs from its recorded state",
    });
  });

  test("pending dispatch deactivates its schedule without installing invocable assets", async () => {
    const pending = dispatchProjectionJson(
      dispatchProjection(WORKER_HOSTNAME, SETTINGS, false, ["ffflow_adoption"]),
    );
    const result = await endpoint(
      async () => ({ kind: "exited", exitCode: 0, stdout: "{}", stderr: "" }),
      pending,
    ).reconcileDispatch();
    expect(result).toEqual({
      protocol_version: 1,
      state: "pending",
      blockers: ["ffflow_adoption"],
      changed: true,
    });
    await expect(readFile(join(root, "/usr/local/bin/factory-dispatch"))).rejects.toThrow();
  });

  test("a missing Paseo credential is a failed reconciliation, never pending or active", async () => {
    const result = await endpoint(async () => ({
      kind: "exited",
      exitCode: 1,
      stdout: "",
      stderr: "missing credential",
    })).reconcileDispatch();
    expect(result).toEqual({
      protocol_version: 1,
      state: "failed",
      blockers: [],
      reason: "dispatch schedule did not reconcile",
    });
  });

  test("adoption probes through the active release without launching Paseo", async () => {
    const calls: string[][] = [];
    const result = await endpoint(async (argv) => {
      calls.push([...argv]);
      return { kind: "exited", exitCode: 2, stdout: "{}", stderr: "" };
    }).adoption();
    expect(result.state).toBe("failed");
    expect(calls[0]).toContain("--adoption-only");
    expect(calls[0]?.some((item) => item.includes("factory-paseo"))).toBe(false);
  });

  test("refuses every dispatch operation outside the fixed root activator", async () => {
    const dispatch = endpoint(async () => ({ kind: "not_found" }), PROJECTION, false);
    expect(dispatch.adoption()).rejects.toThrow("through the activator");
    expect(dispatch.reconcileDispatch()).rejects.toThrow("through the activator");
    expect(dispatch.inspectDispatch()).rejects.toThrow("through the activator");
  });
});
