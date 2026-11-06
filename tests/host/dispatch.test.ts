import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_PROJECTION_PATH,
  DISPATCH_RESULT_PATH,
  dispatchProjection,
  dispatchProjectionJson,
} from "../../src/domain/dispatch-projection";
import type { FactoryId, HostKey, Release, Repository } from "../../src/domain/instance";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import {
  REPOSITORY_MANIFEST_PATH,
  repositoryManifest,
  repositoryManifestJson,
} from "../../src/domain/repository-placement";
import type { ApplySystem } from "../../src/host/apply";
import { workerDispatch } from "../../src/host/dispatch";
import type { ProcessOutcome, ProcessRunner } from "../../src/infrastructure/local-tool-probe";
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

function endpoint(
  run: ProcessRunner,
  input = PROJECTION,
  isRoot = true,
  now: () => Date = () => new Date(),
) {
  const worker: ApplySystem = {
    ...system(root),
    run,
    now,
    isRoot: () => isRoot,
    readInput: async () => input,
    release: "0.3.0" as Release,
    lock: async () => ({ release: () => {} }),
  };
  return workerDispatch(worker);
}

/** What a reconcile registers on a worker whose manifest places nothing present on disk. */
const NONE_PLACED = { backend: "paseo", changed: false, checkouts: [] } as const;

const PENDING = dispatchProjectionJson(
  dispatchProjection(WORKER_HOSTNAME, SETTINGS, false, ["ffflow_adoption"]),
);
const STOP = () => readFile(join(import.meta.dir, "fixtures/dispatch-not-requested.json"), "utf8");

function repo(key: string): Repository {
  return { key, remote: `https://github.com/yaunder/${key}`, path: key, branch: "main" };
}

/** Writes the manifest the repository stage delivers, placing `placed`, and clones `cloned`. */
async function placeRepositories(placed: string[], cloned: string[]): Promise<void> {
  const manifest = repositoryManifestJson(
    repositoryManifest(
      "fff-aaaa1111" as FactoryId,
      { key: "builder-1" as HostKey, repositories: placed },
      placed.map(repo),
    ),
  );
  await mkdir(join(root, "/var/lib/fffactory"), { recursive: true });
  await writeFile(join(root, REPOSITORY_MANIFEST_PATH), manifest);
  for (const key of cloned) await mkdir(join(root, "/workspace/repos", key), { recursive: true });
}

const AUTH = () => join(root, WORKER_PATHS.activeRelease, "steps/control-plane/paseo-auth.sh");

/**
 * A worker whose schedule commands succeed and whose Paseo, after the auth wrapper, answers
 * `project ls` with `projects` (or `list`, when given) and `project create` with `create`.
 */
function worker(
  projects: string[],
  list?: ProcessOutcome,
  create: ProcessOutcome = { kind: "exited", exitCode: 0, stdout: "{}", stderr: "" },
) {
  const schedule: string[][] = [];
  const paseo: string[][] = [];
  const run: ProcessRunner = async (argv) => {
    const at = argv.indexOf(AUTH());
    if (at === -1 || argv[at + 1] !== "project") {
      schedule.push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "{}", stderr: "" };
    }
    paseo.push([...argv]);
    if (argv[at + 2] === "ls")
      return (
        list ?? {
          kind: "exited",
          exitCode: 0,
          stdout: JSON.stringify(
            projects.map((path, index) => ({
              projectId: `p${index}`,
              name: path,
              kind: "git",
              path,
            })),
          ),
          stderr: "",
        }
      );
    return create;
  };
  return { run, schedule, paseo };
}

describe("repository registration on dispatch reconcile (dispatch §Repository registration)", () => {
  const projections: [string, () => Promise<string>, Record<string, unknown>][] = [
    ["active", async () => PROJECTION, { state: "active", blockers: [] }],
    ["pending", async () => PENDING, { state: "pending", blockers: ["ffflow_adoption"] }],
    ["not requested", STOP, { state: "not_requested", blockers: [] }],
  ];
  test.each(projections)(
    "registers the placed checkouts present on disk through the execution backend, %s",
    async (_name, input, expected) => {
      await placeRepositories(["alpha", "beta"], ["alpha", "beta"]);
      const { run, paseo } = worker(["/workspace/repos/alpha"]);
      const registration = {
        backend: "paseo",
        changed: true,
        checkouts: [
          { path: "/workspace/repos/alpha", state: "present" },
          { path: "/workspace/repos/beta", state: "registered" },
        ],
      };
      const result = await endpoint(run, await input()).reconcileDispatch();
      expect(result).toEqual({
        protocol_version: 1,
        ...expected,
        changed: true,
        repository_registration: registration,
      } as never);
      // Paseo as factory, in its clean environment, through the active release's auth wrapper.
      expect(paseo.map((argv) => argv.slice(argv.indexOf(AUTH()) + 1))).toEqual([
        ["project", "ls", "--json"],
        ["project", "create", "/workspace/repos/beta", "--json"],
      ]);
      for (const argv of paseo) {
        expect(argv.slice(0, 3)).toEqual(["/usr/sbin/runuser", "-u", "factory"]);
        expect(argv).toContain("HOME=/home/factory");
      }
      const stored = JSON.parse(await readFile(join(root, DISPATCH_RESULT_PATH), "utf8"));
      expect(stored.repository_registration).toEqual(registration);
    },
  );

  test("a placed checkout not yet cloned, or not a directory, is left out", async () => {
    await placeRepositories(["alpha", "beta", "gamma"], ["gamma"]);
    await mkdir(join(root, "/workspace/repos"), { recursive: true });
    await writeFile(join(root, "/workspace/repos/beta"), "not a checkout\n");
    const { run, paseo } = worker([]);
    const result = await endpoint(run).reconcileDispatch();
    expect("repository_registration" in result && result.repository_registration).toEqual({
      backend: "paseo",
      changed: true,
      checkouts: [{ path: "/workspace/repos/gamma", state: "registered" }],
    });
    expect(paseo.map((argv) => argv.at(-2))).toEqual(["ls", "/workspace/repos/gamma"]);
  });

  test("a checkout reached through a symbolic link is left out, as sync refuses it", async () => {
    await placeRepositories(["alpha", "team/beta", "gamma"], ["alpha", "gamma"]);
    await mkdir(join(root, "/elsewhere/beta"), { recursive: true });
    await mkdir(join(root, "/elsewhere/gamma"), { recursive: true });
    await symlink(join(root, "/elsewhere"), join(root, "/workspace/repos/team"));
    await rm(join(root, "/workspace/repos/gamma"), { recursive: true });
    await symlink(join(root, "/elsewhere/gamma"), join(root, "/workspace/repos/gamma"));
    const { run, paseo } = worker([]);
    const result = await endpoint(run).reconcileDispatch();
    expect("repository_registration" in result && result.repository_registration).toEqual({
      backend: "paseo",
      changed: true,
      checkouts: [{ path: "/workspace/repos/alpha", state: "registered" }],
    });
    expect(paseo.map((argv) => argv.at(-2))).toEqual(["ls", "/workspace/repos/alpha"]);
  });

  test("a repository root that is a symbolic link leaves every checkout out", async () => {
    await placeRepositories(["alpha"], []);
    await mkdir(join(root, "/elsewhere/alpha"), { recursive: true });
    await mkdir(join(root, "/workspace"), { recursive: true });
    await symlink(join(root, "/elsewhere"), join(root, "/workspace/repos"));
    const { run, paseo } = worker([]);
    const result = await endpoint(run).reconcileDispatch();
    expect("repository_registration" in result && result.repository_registration).toEqual(
      NONE_PLACED,
    );
    expect(paseo).toEqual([]);
  });

  test("a registration that throws records none, and the schedule's result is still persisted", async () => {
    await placeRepositories(["alpha"], ["alpha"]);
    const scripted = worker([]);
    const run: ProcessRunner = async (argv, timeout, options) => {
      if (argv.includes(AUTH()) && argv.includes("project")) throw new Error("spawn failed");
      return scripted.run(argv, timeout, options);
    };
    const dispatch = { protocol_version: 1, state: "active", blockers: [], changed: true };
    expect(await endpoint(run).reconcileDispatch()).toEqual(dispatch as never);
    expect(JSON.parse(await readFile(join(root, DISPATCH_RESULT_PATH), "utf8"))).toEqual(dispatch);
    expect(await readFile(join(root, DISPATCH_PROJECTION_PATH), "utf8")).toBe(PROJECTION);
  });

  test("a registration failure leaves the dispatch state, the schedule and its changed as they are", async () => {
    await placeRepositories(["alpha"], ["alpha"]);
    const listing = { kind: "exited", exitCode: 1, stdout: "", stderr: "daemon down" } as const;
    const failing = worker([], listing);
    const succeeding = worker([]);
    const strip = (result: object) => {
      const { repository_registration: _, ...dispatch } = result as Record<string, unknown>;
      return dispatch;
    };

    const failed = await endpoint(failing.run).reconcileDispatch();
    await rm(join(root, DISPATCH_PROJECTION_PATH));
    await rm(join(root, DISPATCH_RESULT_PATH));
    const registered = await endpoint(succeeding.run).reconcileDispatch();

    expect(strip(failed)).toEqual(strip(registered));
    expect(strip(failed)).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: true,
    });
    expect(failing.schedule).toEqual(succeeding.schedule);
    expect("repository_registration" in failed && failed.repository_registration).toEqual({
      backend: "paseo",
      changed: false,
      checkouts: [
        {
          path: "/workspace/repos/alpha",
          state: "failed",
          reason: "listing Paseo's projects exited with status 1",
        },
      ],
    });
    // A rerun, the schedule matching, still reports the schedule unchanged.
    const rerun = await endpoint(failing.run).reconcileDispatch();
    expect(strip(rerun)).toEqual({ ...strip(registered), changed: false });
    expect(JSON.stringify(rerun)).not.toContain("daemon down");
  });

  test("its Paseo calls share one budget", async () => {
    await placeRepositories(["alpha", "beta"], ["alpha", "beta"]);
    let clock = 0;
    const timeouts: number[] = [];
    const scripted = worker([]);
    const run: ProcessRunner = async (argv, timeout, options) => {
      if (argv.includes(AUTH()) && argv.includes("project")) {
        timeouts.push(timeout);
        clock += 50_000;
      }
      return scripted.run(argv, timeout, options);
    };
    const result = await endpoint(run, PROJECTION, true, () => new Date(clock)).reconcileDispatch();
    expect(timeouts).toEqual([120_000, 70_000, 20_000]);
    expect("repository_registration" in result && result.repository_registration).toEqual({
      backend: "paseo",
      changed: true,
      checkouts: [
        { path: "/workspace/repos/alpha", state: "registered" },
        { path: "/workspace/repos/beta", state: "registered" },
      ],
    });
  });

  test("without a manifest nothing placed is present: the backend is asked nothing", async () => {
    const { run, paseo } = worker([]);
    const result = await endpoint(run).reconcileDispatch();
    expect("repository_registration" in result && result.repository_registration).toEqual(
      NONE_PLACED,
    );
    expect(paseo).toEqual([]);
  });

  test.each([
    ["invalid", "file"],
    ["unreadable", "directory"],
  ])(
    "an %s manifest registers nothing and records no registration, dispatch as it is",
    async (_name, kind) => {
      await mkdir(join(root, "/var/lib/fffactory"), { recursive: true });
      if (kind === "file") await writeFile(join(root, REPOSITORY_MANIFEST_PATH), '{"version":1}\n');
      else await mkdir(join(root, REPOSITORY_MANIFEST_PATH));
      const { run, paseo } = worker([]);
      expect(await endpoint(run).reconcileDispatch()).toEqual({
        protocol_version: 1,
        state: "active",
        blockers: [],
        changed: true,
      });
      expect(paseo).toEqual([]);
      expect(await readFile(join(root, DISPATCH_RESULT_PATH), "utf8")).not.toContain(
        "repository_registration",
      );
    },
  );

  test("inspection returns the stored registration unchanged", async () => {
    await placeRepositories(["alpha"], ["alpha"]);
    const { run } = worker([]);
    const dispatch = endpoint(run);
    const reconciled = await dispatch.reconcileDispatch();
    expect(await dispatch.inspectDispatch()).toEqual({ ...reconciled, changed: false } as never);
    expect("repository_registration" in reconciled).toBe(true);
  });

  test("an older stored result without it still parses, with no registration", async () => {
    const older = {
      protocol_version: 1,
      state: "pending",
      blockers: ["ffflow_adoption"],
      changed: true,
    };
    await mkdir(join(root, "/var/lib/fffactory"), { recursive: true });
    await writeFile(join(root, DISPATCH_RESULT_PATH), `${JSON.stringify(older, null, 2)}\n`);
    const { run } = worker([]);
    expect(await endpoint(run).inspectDispatch()).toEqual({ ...older, changed: false } as never);
  });

  test("a drifted schedule's inspection keeps the stored registration, and an older result none", async () => {
    await placeRepositories(["alpha"], ["alpha"]);
    const drifted = (argv: readonly string[]) => argv.includes("--check");
    const { run } = worker([]);
    const dispatch = endpoint(run);
    const reconciled = await dispatch.reconcileDispatch();
    const failing = endpoint(async (argv, timeout, options) =>
      drifted(argv)
        ? { kind: "exited", exitCode: 1, stdout: "", stderr: "" }
        : run(argv, timeout, options),
    );
    const failure = {
      protocol_version: 1,
      state: "failed",
      blockers: [],
      reason: "dispatch schedule differs from its recorded state",
    };
    expect(await failing.inspectDispatch()).toEqual({
      ...failure,
      repository_registration:
        "repository_registration" in reconciled ? reconciled.repository_registration : undefined,
    } as never);

    const older = { protocol_version: 1, state: "active", blockers: [], changed: true };
    await writeFile(join(root, DISPATCH_RESULT_PATH), `${JSON.stringify(older, null, 2)}\n`);
    const inspected = await failing.inspectDispatch();
    expect(inspected).toEqual(failure as never);
    expect("repository_registration" in inspected).toBe(false);
  });
});

describe("the worker dispatch endpoint", () => {
  test("installs the stable entrypoint and skill, reconciles as factory, and persists active", async () => {
    const calls: readonly string[][] = [];
    const run: ProcessRunner = async (argv) => {
      (calls as string[][]).push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "{}", stderr: "" };
    };
    const result = await endpoint(run).reconcileDispatch();
    expect(result).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: true,
      repository_registration: NONE_PLACED,
    });
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
      repository_registration: NONE_PLACED,
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
      repository_registration: NONE_PLACED,
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
      repository_registration: NONE_PLACED,
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
      repository_registration: NONE_PLACED,
    });
    await expect(readFile(join(root, "/usr/local/bin/factory-dispatch"))).rejects.toThrow();
  });

  test("the not-requested projection stops dispatch, a rerun changes nothing, and apply restarts it", async () => {
    // A schedule as the reconciler keeps it: `--apply` makes it what the persisted projection
    // says, and `--check` passes only when it already is.
    const schedule = { exists: false };
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      const projection = JSON.parse(await readFile(join(root, DISPATCH_PROJECTION_PATH), "utf8"));
      const wanted = projection.active === true;
      if (argv.includes("--apply")) schedule.exists = wanted;
      const matches = schedule.exists === wanted;
      return { kind: "exited", exitCode: matches ? 0 : 1, stdout: "{}", stderr: "" };
    };
    const stop = await readFile(
      join(import.meta.dir, "fixtures/dispatch-not-requested.json"),
      "utf8",
    );
    await endpoint(run).reconcileDispatch();
    expect(schedule.exists).toBe(true);
    calls.length = 0;

    expect(await endpoint(run, stop).reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "not_requested",
      blockers: [],
      changed: true,
      repository_registration: NONE_PLACED,
    });
    expect(schedule.exists).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--apply");
    expect(await readFile(join(root, DISPATCH_PROJECTION_PATH), "utf8")).toBe(stop);
    expect(await endpoint(run, stop).inspectDispatch()).toEqual({
      protocol_version: 1,
      state: "not_requested",
      blockers: [],
      changed: false,
      repository_registration: NONE_PLACED,
    });

    calls.length = 0;
    expect(await endpoint(run, stop).reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "not_requested",
      blockers: [],
      changed: false,
      repository_registration: NONE_PLACED,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--check");

    expect(await endpoint(run).reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: true,
      repository_registration: NONE_PLACED,
    });
    expect(schedule.exists).toBe(true);
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
      repository_registration: NONE_PLACED,
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
