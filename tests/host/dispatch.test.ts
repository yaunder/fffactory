import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_PROJECTION_PATH,
  DISPATCH_RESULT_PATH,
  type DispatchProjection,
  dispatchProjection,
  dispatchProjectionJson,
  parseDispatchProjection,
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
import { fakeDispatchTrigger } from "../support/fake-dispatch-trigger";
import { system, WORKER_HOSTNAME } from "./worker-scenarios";

let root: string;
/** The worker's trigger, kept as a reconciler keeps it over the persisted projection. */
let trigger: ReturnType<typeof newTrigger>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-dispatch-"));
  trigger = newTrigger();
  const files: [string, string][] = [
    ["steps/dispatch/skill/SKILL.md", "---\nname: dispatch\n---\n"],
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
/** Each command of the trigger's within the schedule's timeout. */
const TIMEOUT_MS = 15 * 60_000;

/** Whether the persisted projection is active; undefined when there is none. */
async function persistedActive(): Promise<boolean | undefined> {
  try {
    return JSON.parse(await readFile(join(root, DISPATCH_PROJECTION_PATH), "utf8")).active === true;
  } catch {
    return undefined;
  }
}

function newTrigger() {
  return fakeDispatchTrigger(persistedActive);
}

function parsed(text: string): DispatchProjection {
  const result = parseDispatchProjection(text);
  if (!result.ok) throw new Error(result.reason);
  return result.projection;
}

function endpoint(
  run: ProcessRunner,
  input = PROJECTION,
  isRoot = true,
  now: () => Date = () => new Date(),
  using = trigger,
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
  return workerDispatch(worker, using.select);
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
 * A worker whose Paseo, after the auth wrapper, answers `project ls` with `projects` (or `list`,
 * when given) and `project create` with `create`; it runs nothing else.
 */
function worker(
  projects: string[],
  list?: ProcessOutcome,
  create: ProcessOutcome = { kind: "exited", exitCode: 0, stdout: "{}", stderr: "" },
) {
  const paseo: string[][] = [];
  const run: ProcessRunner = async (argv) => {
    const at = argv.indexOf(AUTH());
    if (at === -1 || argv[at + 1] !== "project") throw new Error(`unexpected command: ${argv}`);
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
  return { run, paseo };
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
    const failingTrigger = newTrigger();
    const succeedingTrigger = newTrigger();
    const strip = (result: object) => {
      const { repository_registration: _, ...dispatch } = result as Record<string, unknown>;
      return dispatch;
    };

    const failed = await endpoint(
      failing.run,
      PROJECTION,
      true,
      undefined,
      failingTrigger,
    ).reconcileDispatch();
    await rm(join(root, DISPATCH_PROJECTION_PATH));
    await rm(join(root, DISPATCH_RESULT_PATH));
    const registered = await endpoint(
      succeeding.run,
      PROJECTION,
      true,
      undefined,
      succeedingTrigger,
    ).reconcileDispatch();

    expect(strip(failed)).toEqual(strip(registered));
    expect(strip(failed)).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: true,
    });
    expect(failingTrigger.calls).toEqual(succeedingTrigger.calls);
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
    const rerun = await endpoint(
      failing.run,
      PROJECTION,
      true,
      undefined,
      failingTrigger,
    ).reconcileDispatch();
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
    trigger.answers.inspect = { state: "absent", identity: null };
    const { run } = worker([]);
    expect(await endpoint(run).inspectDispatch()).toEqual({ ...older, changed: false } as never);
  });

  test("a drifted schedule's inspection keeps the stored registration, and an older result none", async () => {
    await placeRepositories(["alpha"], ["alpha"]);
    const { run } = worker([]);
    const dispatch = endpoint(run);
    const reconciled = await dispatch.reconcileDispatch();
    trigger.answers.inspect = { state: "drift", identity: "schedule-1" };
    const failing = endpoint(run);
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
  /** A worker that runs no command: no manifest, so registration asks the backend nothing. */
  const quiet: ProcessRunner = async (argv) => {
    throw new Error(`unexpected command: ${argv}`);
  };
  const ACTIVE = parsed(PROJECTION);

  test("installs the skill, reconciles the trigger, and persists active", async () => {
    const result = await endpoint(quiet).reconcileDispatch();
    expect(result).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: true,
      repository_registration: NONE_PLACED,
    });
    // Nothing persisted to check against: the trigger is reconciled at once, never inspected.
    expect(trigger.calls).toEqual([{ method: "reconcile", projection: ACTIVE }]);
    expect(trigger.timeouts).toEqual([TIMEOUT_MS]);
    expect(
      await readFile(join(root, "/home/factory/.agents/skills/dispatch/SKILL.md"), "utf8"),
    ).toContain("name: dispatch");
    expect(
      await readFile(join(root, "/home/factory/.claude/skills/dispatch/SKILL.md"), "utf8"),
    ).toContain("name: dispatch");
    expect(await readFile(join(root, DISPATCH_RESULT_PATH), "utf8")).toContain('"state": "active"');
  });

  test("the trigger reconciles to the projection already persisted", async () => {
    const persisted: string[] = [];
    const recording = newTrigger();
    const reconcile = recording.trigger.reconcile;
    recording.trigger.reconcile = async (projection) => {
      persisted.push(await readFile(join(root, DISPATCH_PROJECTION_PATH), "utf8"));
      return reconcile(projection);
    };
    await endpoint(quiet, PENDING, true, undefined, recording).reconcileDispatch();
    expect(persisted).toEqual([PENDING]);
  });

  test("a matching rerun is a checked no-op", async () => {
    const dispatch = endpoint(quiet);
    await dispatch.reconcileDispatch();
    trigger.calls.length = 0;
    expect(await dispatch.reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: false,
      repository_registration: NONE_PLACED,
    });
    expect(trigger.calls).toEqual([{ method: "inspect" }]);
  });

  test("a changed projection reconciles the trigger without inspecting it first", async () => {
    await endpoint(quiet).reconcileDispatch();
    trigger.calls.length = 0;
    const changed = dispatchProjectionJson(
      dispatchProjection(WORKER_HOSTNAME, { ...SETTINGS, cron: "*/5 * * * *" }, true, []),
    );
    expect((await endpoint(quiet, changed).reconcileDispatch()).state).toBe("active");
    expect(trigger.calls).toEqual([{ method: "reconcile", projection: parsed(changed) }]);
  });

  test.each([
    ["drifted", { state: "drift", identity: "schedule-1" }],
    ["unreadable", { state: "unknown", reason: "the dispatch schedule's check timed out" }],
  ] as const)(
    "a persisted projection whose trigger is %s is reconciled again",
    async (_name, inspection) => {
      await endpoint(quiet).reconcileDispatch();
      trigger.calls.length = 0;
      trigger.answers.inspect = inspection;
      expect(await endpoint(quiet).reconcileDispatch()).toEqual({
        protocol_version: 1,
        state: "active",
        blockers: [],
        changed: true,
        repository_registration: NONE_PLACED,
      });
      expect(trigger.calls).toEqual([
        { method: "inspect" },
        { method: "reconcile", projection: ACTIVE },
      ]);
    },
  );

  test("a matching trigger still refreshes changed release-owned assets", async () => {
    const dispatch = endpoint(quiet);
    await dispatch.reconcileDispatch();
    await writeFile(
      join(root, WORKER_PATHS.activeRelease, "steps/dispatch/skill/SKILL.md"),
      "---\nname: dispatch\n---\n# new release\n",
    );
    trigger.calls.length = 0;

    expect(await dispatch.reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: true,
      repository_registration: NONE_PLACED,
    });
    expect(trigger.calls).toEqual([{ method: "inspect" }]);
    expect(
      await readFile(join(root, "/home/factory/.agents/skills/dispatch/SKILL.md"), "utf8"),
    ).toContain("new release");
  });

  test("an earlier release's Python dispatcher is removed once the skill no longer runs it", async () => {
    const dispatch = endpoint(quiet);
    await dispatch.reconcileDispatch();
    const retired = join(root, "/usr/local/bin/factory-dispatch");
    await mkdir(join(retired, ".."), { recursive: true });
    await writeFile(retired, "#!/usr/bin/env python3\n", { mode: 0o755 });
    trigger.calls.length = 0;

    expect((await dispatch.reconcileDispatch()) as unknown).toMatchObject({ changed: true });
    await expect(readFile(retired)).rejects.toThrow();
    expect((await dispatch.reconcileDispatch()) as unknown).toMatchObject({ changed: false });
  });

  test.each([
    ["drifts from", { state: "drift", identity: "schedule-1" }],
    [
      "cannot be read against",
      { state: "unknown", reason: "the dispatch schedule's check timed out" },
    ],
  ] as const)(
    "inspection reports failure when the real trigger %s recorded active state",
    async (_name, inspection) => {
      const dispatch = endpoint(quiet);
      await dispatch.reconcileDispatch();
      trigger.answers.inspect = inspection;

      expect(await dispatch.inspectDispatch()).toEqual({
        protocol_version: 1,
        state: "failed",
        blockers: [],
        reason: "dispatch schedule differs from its recorded state",
        repository_registration: NONE_PLACED,
      });
    },
  );

  test.each([
    ["none", undefined],
    ["unreadable", "{"],
  ])("inspection with %s recorded asks the trigger nothing", async (_name, stored) => {
    if (stored !== undefined) {
      await mkdir(join(root, "/var/lib/fffactory"), { recursive: true });
      await writeFile(join(root, DISPATCH_RESULT_PATH), stored);
    }
    const inspected = await endpoint(quiet).inspectDispatch();
    expect(inspected.state).toBe(stored === undefined ? "none" : "unreadable");
    expect(trigger.calls).toEqual([]);
  });

  test("pending dispatch deactivates its trigger without installing invocable assets", async () => {
    const result = await endpoint(quiet, PENDING).reconcileDispatch();
    expect(result).toEqual({
      protocol_version: 1,
      state: "pending",
      blockers: ["ffflow_adoption"],
      changed: true,
      repository_registration: NONE_PLACED,
    });
    expect(trigger.calls).toEqual([{ method: "reconcile", projection: parsed(PENDING) }]);
    expect(trigger.world.present).toBe(false);
    await expect(
      readFile(join(root, "/home/factory/.agents/skills/dispatch/SKILL.md")),
    ).rejects.toThrow();
  });

  test("the not-requested projection stops dispatch, a rerun changes nothing, and apply restarts it", async () => {
    const stop = await STOP();
    await endpoint(quiet).reconcileDispatch();
    expect(trigger.world.present).toBe(true);
    trigger.calls.length = 0;

    expect(await endpoint(quiet, stop).reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "not_requested",
      blockers: [],
      changed: true,
      repository_registration: NONE_PLACED,
    });
    expect(trigger.world.present).toBe(false);
    expect(trigger.calls).toEqual([{ method: "reconcile", projection: parsed(stop) }]);
    expect(await readFile(join(root, DISPATCH_PROJECTION_PATH), "utf8")).toBe(stop);
    expect(await endpoint(quiet, stop).inspectDispatch()).toEqual({
      protocol_version: 1,
      state: "not_requested",
      blockers: [],
      changed: false,
      repository_registration: NONE_PLACED,
    });

    trigger.calls.length = 0;
    expect(await endpoint(quiet, stop).reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "not_requested",
      blockers: [],
      changed: false,
      repository_registration: NONE_PLACED,
    });
    expect(trigger.calls).toEqual([{ method: "inspect" }]);

    expect(await endpoint(quiet).reconcileDispatch()).toEqual({
      protocol_version: 1,
      state: "active",
      blockers: [],
      changed: true,
      repository_registration: NONE_PLACED,
    });
    expect(trigger.world.present).toBe(true);
  });

  test.each([
    ["is left drifted", { state: "drift", identity: null }],
    [
      "cannot be read",
      { state: "unknown", reason: "the dispatch schedule's reconcile exited with status 1" },
    ],
  ] as const)(
    "a trigger that %s is a failed reconciliation, never pending or active",
    async (_name, inspection) => {
      trigger.answers.reconcile = inspection;
      expect(await endpoint(quiet).reconcileDispatch()).toEqual({
        protocol_version: 1,
        state: "failed",
        blockers: [],
        reason: "dispatch schedule did not reconcile",
        repository_registration: NONE_PLACED,
      });
    },
  );

  test("adoption checks every placed repository through the active release as factory, with no trigger or backend environment", async () => {
    await placeRepositories(["beta", "alpha"], []);
    const calls: { argv: string[]; timeout: number; options: unknown }[] = [];
    const result = await endpoint(
      async (argv, timeout, options) => {
        calls.push({ argv: [...argv], timeout, options });
        return argv.includes("https://github.com/yaunder/beta")
          ? { kind: "exited", exitCode: 1, stdout: "", stderr: "no FFFlow" }
          : { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
      },
      PROJECTION,
      true,
      () => new Date(0),
    ).adoption();
    expect(result).toEqual({ protocol_version: 1, state: "failed" });
    const check = join(
      root,
      WORKER_PATHS.activeRelease,
      "steps/repositories/check-ffflow-adoption.sh",
    );
    const asFactory = [
      "/usr/sbin/runuser",
      "-u",
      "factory",
      "--",
      "/usr/bin/env",
      "-i",
      "HOME=/home/factory",
      "PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
      "LANG=C.UTF-8",
      check,
    ];
    const options = {
      cwd: "/",
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
    };
    // Sorted by alias, each within what is left of the adoption's one timeout.
    expect(calls).toEqual([
      {
        argv: [...asFactory, "https://github.com/yaunder/alpha", "main"],
        timeout: TIMEOUT_MS,
        options,
      },
      {
        argv: [...asFactory, "https://github.com/yaunder/beta", "main"],
        timeout: TIMEOUT_MS,
        options,
      },
    ]);
    expect(trigger.calls).toEqual([]);
  });

  test("adoption passes only when every placed repository passes", async () => {
    await placeRepositories(["alpha"], []);
    const passing = await endpoint(async () => ({
      kind: "exited",
      exitCode: 0,
      stdout: "",
      stderr: "",
    })).adoption();
    expect(passing).toEqual({ protocol_version: 1, state: "passed" });
  });

  test.each([
    ["no manifest", undefined, { kind: "exited", exitCode: 0, stdout: "", stderr: "" }],
    ["a check that cannot start", ["alpha"], { kind: "not_found" }],
    ["a check that times out", ["alpha"], { kind: "timed_out" }],
  ] as const)("adoption with %s is failed", async (_name, placed, outcome) => {
    if (placed !== undefined) await placeRepositories([...placed], []);
    expect(await endpoint(async () => outcome).adoption()).toEqual({
      protocol_version: 1,
      state: "failed",
    });
  });

  test("adoption's checks share its one timeout", async () => {
    await placeRepositories(["alpha", "beta"], []);
    let now = 0;
    const timeouts: number[] = [];
    const result = await endpoint(
      async (_argv, timeout) => {
        timeouts.push(timeout);
        now += TIMEOUT_MS;
        return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
      },
      PROJECTION,
      true,
      () => new Date(now),
    ).adoption();
    expect(timeouts).toEqual([TIMEOUT_MS]);
    expect(result.state).toBe("failed");
  });

  test.each([
    ["an invalid projection", "{}", [], "invalid dispatch projection"],
    [
      "another worker's projection",
      dispatchProjectionJson(
        dispatchProjection("fff-aaaa1111-builder-2", SETTINGS, false, ["ffflow_adoption"]),
      ),
      ["ffflow_adoption"],
      "dispatch projection is for another worker",
    ],
  ])(
    "%s fails, persisting nothing and asking the trigger nothing",
    async (_name, input, blockers, reason) => {
      expect(await endpoint(quiet, input).reconcileDispatch()).toEqual({
        protocol_version: 1,
        state: "failed",
        blockers,
        reason,
      } as never);
      expect(trigger.calls).toEqual([]);
      await expect(readFile(join(root, DISPATCH_PROJECTION_PATH))).rejects.toThrow();
      await expect(readFile(join(root, DISPATCH_RESULT_PATH))).rejects.toThrow();
    },
  );

  test("refuses every dispatch operation outside the fixed root activator", async () => {
    const dispatch = endpoint(async () => ({ kind: "not_found" }), PROJECTION, false);
    expect(dispatch.adoption()).rejects.toThrow("through the activator");
    expect(dispatch.reconcileDispatch()).rejects.toThrow("through the activator");
    expect(dispatch.inspectDispatch()).rejects.toThrow("through the activator");
    expect(trigger.calls).toEqual([]);
  });
});
