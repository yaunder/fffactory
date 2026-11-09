/**
 * The worker's dispatcher (`docs/specs/dispatch.md` §The dispatcher, §Capacity), the port of the
 * Python `factory-dispatch`, run in process as `factory` against a worker laid out in a
 * temporary root: a real local Git remote standing in for GitHub's (`insteadOf`), the release's
 * real FFFlow adoption check and repository program, a stand-in `gh` on the caller's PATH, and a
 * fake execution backend holding the test's runs (or, where a case goes through the Paseo
 * adapter end to end, the real one over a stand-in for its auth wrapper). Each case is one of
 * the Python tests', named in the epic's mapping. The exact Paseo commands are the adapter's,
 * proved in `paseo-backend.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AgentState, parseActivityDocument } from "../../src/domain/control-plane";
import {
  DISPATCH_PROJECTION_PATH,
  dispatchProjection,
  dispatchProjectionJson,
} from "../../src/domain/dispatch-projection";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import type { Release } from "../../src/domain/instance";
import {
  ADOPTION_CHECK,
  REPOSITORY_MANIFEST_PATH,
  SYNC_SCRIPT,
} from "../../src/domain/repository-placement";
import type { Run, RunRequest, WorkerRuns } from "../../src/domain/run";
import type { ApplySystem } from "../../src/host/apply";
import {
  DISPATCH_LOCK,
  type DispatchCaller,
  type DispatchTick,
  workerDispatcher,
} from "../../src/host/dispatcher";
import { executionBackend } from "../../src/host/execution-backend";
import { flockExclusive } from "../../src/host/install-lock";
import { RETIRED_DISPATCH_LOCK } from "../../src/host/paseo-backend";
import { bunProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { fakeExecutionBackend } from "../support/fake-execution-backend";

const REPOSITORY_STEPS = join(import.meta.dir, "../../assets/steps/repositories");
const HOST = "test-host";
const REMOTE = "https://github.com/acme/product.git";
/** Each case clones, commits and runs the release's real repository programs. */
const SLOW = 60_000;

let root: string;
let files: ReturnType<typeof paths>;
let environment: Record<string, string>;
let schedule: {
  cron: string;
  timezone: string;
  provider: string;
  model: string;
  mode: string;
  cwd: string;
};

function paths(base: string) {
  return {
    bin: join(base, "bin"),
    remote: join(base, "remote.git"),
    checkout: join(base, "workspace/repos/product"),
    cwd: join(base, "home/factory"),
    agents: join(base, "agents.json"),
    rows: join(base, "paseo-rows.json"),
    rowsFail: join(base, "paseo-rows-fail"),
    run: join(base, "run.json"),
    ls: join(base, "ls.jsonl"),
    gh: join(base, "gh.jsonl"),
    sync: join(base, "sync-calls"),
    gitconfig: join(base, "gitconfig"),
  };
}

/**
 * A stand-in program: a shell wrapper running a script by Bun itself, with the stand-in's paths
 * written into it (Bun would read a `.sh` script as its own shell's).
 */
async function standIn(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true });
  const header = [
    'const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");',
    `const files = ${JSON.stringify(files)};`,
    "const a = process.argv.slice(2);",
  ].join("\n");
  await writeFile(`${path}.js`, `${header}\n${body}\n`);
  await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' '${path}.js' "$@"\n`, {
    mode: 0o755,
  });
}

/** GitHub as the Python test's mock answered it, by MOCK_READINESS. */
const GH = String.raw`
appendFileSync(files.gh, JSON.stringify({ args: a, marker: process.env.MOCK_MARKER ?? null }) + "\n");
const mode = process.env.MOCK_READINESS ?? "ready";
if (mode === "undecodable") { process.stdout.write(new Uint8Array([0x5b, 0xff, 0x5d])); process.exit(0); }
if (mode === "invalid") { console.log("not JSON"); process.exit(0); }
let value;
if (a[0] === "issue" && a[1] === "list")
  value = a.includes("ready")
    ? [{ number: 101, title: "Epic: Test", state: "OPEN" }]
    : [{ number: 102, title: "T1: Test", state: "OPEN", body: "Acceptance criteria" }];
else if (a[0] === "issue" && a[1] === "view")
  value = a[2] === "300"
    ? { number: 300, state: mode.endsWith("dependency") ? "OPEN" : "CLOSED" }
    : { number: 102, state: "OPEN",
        comments: mode === "commented-dependency" ? [{ body: "Depends on: #300" }] : [],
        body: mode === "dependency" ? "- Depends on: #300" : "Acceptance criteria" };
else if (a[0] === "pr" && a[1] === "list")
  value = mode === "pr" ? [{ number: 8, title: "Fix #102", body: "", headRefName: "task/test" }] : [];
else { console.error("unexpected gh command: " + a); process.exit(1); }
console.log(JSON.stringify(value));
`;

/**
 * Paseo behind the auth wrapper, for the cases through the real adapter. The epic's labelled
 * list answers the test's dispatched runs for that epic (`idle` for any state but `working`);
 * the launch records how it was run and adds a working dispatched run. The adapter's own lists
 * answer the rows a test writes.
 */
const PASEO = String.raw`
const read = (path, empty) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : empty;
if (a[0] === "ls") {
  appendFileSync(files.ls, JSON.stringify({ args: a, agent: process.env.PASEO_AGENT_ID ?? null }) + "\n");
  const epic = a.find((arg) => arg.startsWith("factory-epic="));
  if (epic !== undefined) {
    const runs = read(files.agents, { agents: [] }).agents.filter(
      (run) => run.dispatched && "factory-epic=" + run.work?.workItem === epic);
    console.log(JSON.stringify(runs.map(({ id, state }) => ({ id, status: state === "working" ? "initializing" : "idle" }))));
  } else if (existsSync(files.rowsFail)) {
    console.error("connect ECONNREFUSED 127.0.0.1\nat the daemon");
    process.exit(1);
  } else {
    const rows = read(files.rows, []);
    console.log(JSON.stringify(a.includes("--label") ? rows.filter((row) => row.dispatched) : rows));
  }
} else if (a[0] === "agent" && a[1] === "inspect") {
  console.log(JSON.stringify({ Id: a[2], PendingPermissions: [], Extra: true }));
} else if (a[0] === "run") {
  writeFileSync(files.run, JSON.stringify({
    args: a, cwd: process.cwd(), parent: process.env.PASEO_AGENT_ID ?? null,
    workspace: process.env.PASEO_WORKSPACE_ID ?? null, marker: process.env.MOCK_MARKER ?? null,
  }));
  const document = read(files.agents, { agents: [] });
  const epic = Number(a.find((arg) => arg.startsWith("factory-epic=")).slice("factory-epic=".length));
  document.agents.push({ id: "agent-1", state: "working", dispatched: true, work: { repository: "product", workItem: epic } });
  writeFileSync(files.agents, JSON.stringify(document));
  console.log(JSON.stringify({ agentId: "agent-1", status: "running" }));
} else { console.error("unexpected paseo command: " + a); process.exit(1); }
`;

function git(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: environment });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/**
 * The worker's runs in fffactory's states: (id, state, dispatched, and for a dispatched one the
 * epic of `product` it was launched for, 101 unless given) each.
 */
async function agents(...list: [string, AgentState, boolean, number?][]) {
  const runs: Run[] = list.map(([id, state, dispatched, epic]) =>
    dispatched
      ? { id, state, dispatched, work: { repository: "product", workItem: epic ?? 101 } }
      : { id, state, dispatched },
  );
  await writeFile(files.agents, JSON.stringify({ agents: runs }));
}

async function writeProjection(active = true) {
  const projection = dispatchProjection(
    HOST,
    { enabled: true, ...schedule },
    active,
    active ? [] : ["ffflow_adoption"],
  );
  await writeFile(join(root, DISPATCH_PROJECTION_PATH), dispatchProjectionJson(projection));
}

async function writeManifest(branch = "main") {
  await writeFile(
    join(root, REPOSITORY_MANIFEST_PATH),
    JSON.stringify({
      version: 2,
      repositories: {
        product: { remote: REMOTE, path: "product", branch, update_policy: "fast-forward-only" },
      },
      repository_sets: { core: ["product"] },
      hosts: { [HOST]: { repository_sets: ["core"] } },
    }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-dispatcher-"));
  files = paths(root);
  await mkdir(files.bin, { recursive: true });
  await mkdir(files.cwd, { recursive: true });
  await mkdir(join(root, WORKER_PATHS.state), { recursive: true });
  await writeFile(files.gitconfig, `[url "file://${files.remote}"]\n\tinsteadOf = ${REMOTE}\n`);
  environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1]),
    ),
    GIT_CONFIG_GLOBAL: files.gitconfig,
    PATH: `${files.bin}:${process.env.PATH}`,
    PASEO_AGENT_ID: "scheduled-agent",
    PASEO_WORKSPACE_ID: "scheduled-workspace",
    MOCK_MARKER: "the caller's",
  };
  await standIn(join(files.bin, "gh"), GH);
  const steps = join(root, WORKER_PATHS.activeRelease, "steps");
  await standIn(join(steps, "control-plane/paseo-auth.sh"), PASEO);
  await mkdir(join(root, dirname(ADOPTION_CHECK)), { recursive: true });
  await symlink(join(REPOSITORY_STEPS, "check-ffflow-adoption.sh"), join(root, ADOPTION_CHECK));
  await writeFile(
    join(root, SYNC_SCRIPT),
    `#!/bin/sh\nprintf '%s\\n' "$1" >> '${files.sync}'\nexec '${join(REPOSITORY_STEPS, "sync-repositories.sh")}' "$@"\n`,
    { mode: 0o755 },
  );
  await agents();
  git(["init", "--quiet", "--bare", "--initial-branch=main", files.remote]);
  git(["clone", "--quiet", files.remote, files.checkout]);
  git(["config", "user.name", "Test"], files.checkout);
  git(["config", "user.email", "test@example.invalid"], files.checkout);
  await mkdir(join(files.checkout, ".ffflow"));
  await writeFile(
    join(files.checkout, ".ffflow/config.yaml"),
    "version: 1\nlevel: L1\nffflow_version: 0.4.1\n",
  );
  git(["add", ".ffflow/config.yaml"], files.checkout);
  git(["commit", "--quiet", "-m", "Adopt FFFlow"], files.checkout);
  git(["push", "--quiet", "origin", "main"], files.checkout);
  git(["remote", "set-url", "origin", REMOTE], files.checkout);
  await writeManifest();
  schedule = {
    cron: "*/17 * * * *",
    timezone: "America/Chicago",
    provider: "codex",
    model: "configured-model",
    mode: "default",
    cwd: "/home/factory",
  };
  await writeProjection();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function worker(isRoot = false): ApplySystem {
  return {
    root,
    run: bunProcessRunner,
    hostname: () => HOST,
    machine: () => "x86_64",
    availableBytes: async () => 0,
    now: () => new Date("2026-11-09T07:05:03Z"),
    isRoot: () => isRoot,
    readInput: async () => "",
    release: "0.3.0" as Release,
    lock: flockExclusive,
  };
}

/** The backend's runs as the test's world holds them; a start records its request and takes a slot. */
function backend() {
  const world = async () => JSON.parse(await readFile(files.agents, "utf8")) as { agents: Run[] };
  return fakeExecutionBackend({
    runs: async () => ({ kind: "listed", runs: (await world()).agents }),
    startRun: async (request) => {
      await writeFile(files.run, JSON.stringify(request));
      const document = await world();
      const { repository, workItem } = request.launch;
      document.agents.push({
        id: "agent-1",
        state: "working",
        dispatched: true,
        work: { repository, workItem },
      });
      await writeFile(files.agents, JSON.stringify(document));
      return { kind: "started", handle: { id: "agent-1" } };
    },
  });
}

interface Options {
  readonly mode?: string;
  readonly adoptionOnly?: boolean;
  readonly cwd?: string;
  readonly select?: ReturnType<typeof backend>["select"];
}

/** One run of the dispatcher, as the dispatch skill runs it from the declared directory. */
async function dispatcher(options: Options = {}): Promise<DispatchTick> {
  const caller: DispatchCaller = {
    environment: { ...environment, MOCK_READINESS: options.mode ?? "ready" },
    cwd: () => options.cwd ?? files.cwd,
  };
  return workerDispatcher(worker(), caller, options.select ?? backend().select).runDispatch(
    options.adoptionOnly ?? false,
  );
}

async function invoke(mode = "ready") {
  const tick = await dispatcher({ mode });
  if (tick.kind !== "dispatched") throw new Error(`the tick failed: ${JSON.stringify(tick)}`);
  return tick.summary;
}

async function lines(path: string): Promise<unknown[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** The duplicate check's Paseo lists, through the real adapter. */
async function duplicateChecks() {
  return ((await lines(files.ls)) as { args: string[]; agent: string | null }[]).filter(
    ({ args }) => args.some((arg) => arg.startsWith("factory-epic=")),
  );
}

/** The request the backend was asked to start. */
async function launchRequest() {
  return JSON.parse(await readFile(files.run, "utf8")) as RunRequest;
}

/** How Paseo's launch was run, through the real adapter. */
async function launchCall() {
  return JSON.parse(await readFile(files.run, "utf8")) as {
    args: string[];
    cwd: string;
    parent: string | null;
    workspace: string | null;
    marker: string | null;
  };
}

const launched = () =>
  readFile(files.run).then(
    () => true,
    () => false,
  );

/** No epic was read, no sync run, no duplicate checked and nothing launched. */
async function nothingDispatched() {
  expect(await lines(files.gh)).toEqual([]);
  expect(await readFile(files.sync).catch(() => "")).toBe("");
  expect(await duplicateChecks()).toEqual([]);
  expect(await launched()).toBe(false);
}

/** Nothing was read or launched, and no Paseo list at all. */
async function nothingRan() {
  await nothingDispatched();
  expect(await lines(files.ls)).toEqual([]);
}

/** The prompt the dispatcher asks the backend to start epic 101 with, off `base`. */
const invocation = (base = "origin/main") =>
  "/fff:work-epic 101\n\nThis fresh worktree starts on a dispatch branch; create " +
  `epic/101 from ${base} here as work-epic requires.`;

describe("launching (dispatch §The dispatcher)", () => {
  test(
    "starts one run, then respects the cap",
    async () => {
      const first = await invoke();
      expect(first.started).toEqual([{ repository: "product", epic: 101, agent_id: "agent-1" }]);
      const request = await launchRequest();
      expect(request.agent).toEqual({
        provider: "codex",
        model: "configured-model",
        mode: "default",
      });
      expect(request.launch).toMatchObject({ repository: "product", workItem: 101 });
      expect(request.invocation.startsWith("/fff:work-epic 101\n")).toBe(true);
      expect(request.invocation).not.toContain("epic:<id>");
      expect(request.invocation).toContain("create epic/101 from origin/main");
      const second = await invoke();
      expect(second.started).toEqual([]);
      expect(second.skipped[0]?.reason).toBe("host cap reached");
    },
    SLOW,
  );

  test(
    "asks the backend for the epic's runs, then to start it, acting for the caller",
    async () => {
      const chosen = backend();
      const tick = await dispatcher({ select: chosen.select });
      if (tick.kind !== "dispatched") throw new Error(`the tick failed: ${JSON.stringify(tick)}`);
      const request: RunRequest = {
        launch: { repository: "product", workItem: 101, attempt: "20261109T070503Z" },
        checkout: files.checkout,
        base: "origin/main",
        branch: "dispatch/epic-101-20261109T070503Z",
        invocation: invocation(),
        agent: { provider: "codex", model: "configured-model", mode: "default" },
      };
      expect(chosen.calls).toEqual([
        { method: "runs" },
        { method: "runs", work: { repository: "product", workItem: 101 } },
        { method: "startRun", request },
      ]);
      // Capacity within the agents' budget; the duplicate check and the launch each within a
      // command's, in the caller's own environment.
      expect(chosen.budgets).toEqual([90_000, 900_000, 900_000]);
      const callerEnvironment = { ...environment, MOCK_READINESS: "ready" };
      expect(chosen.environments).toEqual([undefined, callerEnvironment, callerEnvironment]);
      // gh gets the caller's whole environment.
      const gh = (await lines(files.gh)) as { marker: string }[];
      expect(new Set(gh.map(({ marker }) => marker))).toEqual(new Set(["the caller's"]));
      expect(tick.summary).toEqual({
        host: HOST,
        cap: 1,
        running: 0,
        considered: [{ repository: "product", epic: 101 }],
        skipped: [],
        started: [{ repository: "product", epic: 101, agent_id: "agent-1" }],
        running_after: 1,
      });
    },
    SLOW,
  );

  test(
    "through the Paseo backend, launches exactly as the Python dispatcher did, top-level, from the checkout, in the caller's environment",
    async () => {
      await agents(["agent-other", "finished", true, 102]);
      const summary = await (async () => {
        const tick = await dispatcher({ select: executionBackend });
        if (tick.kind !== "dispatched") throw new Error(`the tick failed: ${JSON.stringify(tick)}`);
        return tick.summary;
      })();
      expect(summary.started).toEqual([{ repository: "product", epic: 101, agent_id: "agent-1" }]);
      const call = await launchCall();
      expect(call.args).toEqual([
        "run",
        "--no-wait",
        "--json",
        "--provider",
        "codex/configured-model",
        "--mode",
        "default",
        "--new-workspace",
        "worktree",
        "--worktree-mode",
        "branch-off",
        "--new-branch",
        "dispatch/epic-101-20261109T070503Z",
        "--base",
        "origin/main",
        "--cwd",
        files.checkout,
        "--label",
        "factory-dispatch=true",
        "--label",
        "factory-repository=product",
        "--label",
        "factory-epic=101",
        "--label",
        "factory-dispatched-at=20261109T070503Z",
        invocation(),
      ]);
      expect(call.cwd).toBe(await realpath(files.checkout));
      expect(call.marker).toBe("the caller's");
      expect(call.parent).toBeNull();
      expect(call.workspace).toBeNull();
      // The duplicate check lists background workspaces' runs too, in the caller's whole
      // environment, its Paseo identity among it.
      const checks = await duplicateChecks();
      expect(checks.map(({ args }) => args)).toEqual([
        [
          "ls",
          "--global",
          "--background",
          "--label",
          "factory-dispatch=true",
          "--label",
          "factory-repository=product",
          "--label",
          "factory-epic=101",
          "--json",
        ],
      ]);
      expect(checks.map(({ agent }) => agent)).toEqual(["scheduled-agent"]);
    },
    SLOW,
  );

  test(
    "through the Paseo backend, a run labelled for the epic prevents a duplicate",
    async () => {
      await agents(["agent-old", "finished", true]);
      const tick = await dispatcher({ select: executionBackend });
      if (tick.kind !== "dispatched") throw new Error(`the tick failed: ${JSON.stringify(tick)}`);
      expect(tick.summary.skipped[0]?.reason).toBe("existing dispatched agent");
      expect(await launched()).toBe(false);
    },
    SLOW,
  );

  test(
    "a finished agent prevents a duplicate without using the host cap",
    async () => {
      await agents(["agent-old", "finished", true]);
      const summary = await invoke();
      expect(summary.running).toBe(0);
      expect(summary.started).toEqual([]);
      expect(summary.skipped[0]?.reason).toBe("existing dispatched agent");
    },
    SLOW,
  );

  test(
    "a run dispatch launched for another epic is no duplicate",
    async () => {
      await agents(["agent-old", "finished", true, 102]);
      const summary = await invoke();
      expect(summary.skipped).toEqual([]);
      expect(summary.started).toEqual([{ repository: "product", epic: 101, agent_id: "agent-1" }]);
    },
    SLOW,
  );

  test(
    "runs it cannot read for the epic fail the tick before anything is launched",
    async () => {
      const chosen = backend();
      const unknown: WorkerRuns = { kind: "unknown", reason: "Paseo activity was invalid" };
      const select: typeof chosen.select = (system, budgetMs, env) => {
        const real = chosen.select(system, budgetMs, env);
        return {
          ...real,
          runs: (work) => (work === undefined ? real.runs() : Promise.resolve(unknown)),
        };
      };
      expect(await dispatcher({ select })).toEqual({
        kind: "failed",
        reason: "the epic's runs could not be read: Paseo activity was invalid",
      });
      expect(await readFile(files.sync).catch(() => "")).toBe("");
      expect(await launched()).toBe(false);
    },
    SLOW,
  );

  test(
    "a run the backend could not start fails the tick in its words",
    async () => {
      const chosen = fakeExecutionBackend({
        startRun: { kind: "failed", reason: "starting a Paseo run exited with status 1" },
      });
      expect(await dispatcher({ select: chosen.select })).toEqual({
        kind: "failed",
        reason: "the epic's run could not be started: starting a Paseo run exited with status 1",
      });
    },
    SLOW,
  );

  test(
    "a non-main branch and the configured executor are honored",
    async () => {
      git(["branch", "-m", "develop"], files.checkout);
      git(["push", "--quiet", "origin", "develop"], files.checkout);
      await writeManifest("develop");
      const summary = await invoke();
      expect(summary.started[0]?.agent_id).toBe("agent-1");
      const request = await launchRequest();
      expect(request.base).toBe("origin/develop");
      expect(request.invocation).toBe(invocation("origin/develop"));
    },
    SLOW,
  );
});

describe("capacity (dispatch §Capacity)", () => {
  test(
    "asks the execution backend's runs, never a Paseo list",
    async () => {
      // The backend translates its runs into fffactory's states (D7): the capacity check lists
      // nothing itself, so no Paseo status reaches the dispatcher.
      await agents(["agent-busy", "working", true]);
      const chosen = backend();
      const summary = await (async () => {
        const tick = await dispatcher({ select: chosen.select });
        if (tick.kind !== "dispatched") throw new Error("the tick failed");
        return tick.summary;
      })();
      expect(chosen.calls).toEqual([{ method: "runs" }]);
      expect(chosen.budgets).toEqual([90_000]);
      expect(await lines(files.ls)).toEqual([]);
      expect(summary.skipped[0]?.reason).toBe("host cap reached");
    },
    SLOW,
  );

  test.each([
    ["a dispatched working agent", [["a", "working", true]], 1, [], ["host cap reached"]],
    ["a dispatched agent needing input", [["a", "needs_input", true]], 1, [], ["host cap reached"]],
    [
      "busy agents dispatch did not launch",
      [
        ["a", "working", false],
        ["b", "needs_input", false],
      ],
      0,
      ["agent-1"],
      [],
    ],
    [
      "dispatched agents finished, failed or stopped",
      [
        ["a", "finished", true],
        ["b", "failed", true],
        ["c", "stopped", true],
      ],
      0,
      [],
      ["existing dispatched agent"],
    ],
  ] as [string, [string, AgentState, boolean][], number, string[], string[]][])(
    "counts only dispatched agents working or needing input: %s",
    async (_name, list, running, started, skipped) => {
      await agents(...list);
      const summary = await invoke();
      expect(summary.running).toBe(running);
      expect({
        started: summary.started.map(({ agent_id }) => agent_id),
        skipped: summary.skipped.map(({ reason }) => reason),
      }).toEqual({ started, skipped });
    },
    SLOW,
  );

  test(
    "counts the agents of the activity document host agents prints",
    async () => {
      // One dispatched agent needs input; the other busy one was not dispatched, and the other
      // dispatched one finished.
      const text = await readFile(join(import.meta.dir, "fixtures/activity-agents.json"), "utf8");
      const parsed = parseActivityDocument(text);
      if (!parsed.ok || parsed.document.kind !== "listed") throw new Error("fixture unreadable");
      const runs: WorkerRuns = { kind: "listed", runs: parsed.document.agents };
      const summary = await (async () => {
        const tick = await dispatcher({ select: fakeExecutionBackend({ runs }).select });
        if (tick.kind !== "dispatched") throw new Error("the tick failed");
        return tick.summary;
      })();
      expect(summary.running).toBe(1);
      expect(summary.skipped[0]?.reason).toBe("host cap reached");
    },
    SLOW,
  );

  test.each([
    "Paseo activity could not be read",
    "Paseo activity was invalid",
    "Paseo reported an agent status fffactory does not know",
    "a Paseo agent's inspection was invalid",
  ])(
    "agents the backend cannot read (%s) fail the tick before anything is read or launched",
    async (reason) => {
      const tick = await dispatcher({
        select: fakeExecutionBackend({ runs: { kind: "unknown", reason } }).select,
      });
      expect(tick).toEqual({
        kind: "failed",
        reason: `the worker's agents could not be read: ${reason}`,
      });
      await nothingRan();
    },
    SLOW,
  );

  /** The Paseo adapter's own list, as Paseo 0.15.0 prints it, read by the real backend. */
  async function paseoRows(rows: unknown) {
    await writeFile(files.rows, JSON.stringify(rows));
  }
  const viaPaseo = () => dispatcher({ select: executionBackend });

  test.each([
    ["an empty row", [{}]],
    ["an unknown status", [{ id: "busy", status: "unexpected", dispatched: true }]],
    ["no status", [{ id: "busy", dispatched: true }]],
    ["no ID", [{ status: "running", dispatched: true }]],
    ["an ID read as an option", [{ id: "-busy", status: "running", dispatched: true }]],
    ["an ID with a newline", [{ id: "busy\n", status: "running", dispatched: true }]],
    ["an ID that is not a string", [{ id: 7, status: "running", dispatched: true }]],
    ["not a list", { agents: [] }],
  ])(
    "an agent the backend cannot read, %s, fails the tick and never frees a slot",
    async (_name, rows) => {
      await paseoRows(rows);
      const tick = await viaPaseo();
      expect(tick.kind).toBe("failed");
      expect(tick.kind === "failed" && tick.reason).toStartWith(
        "the worker's agents could not be read: ",
      );
      await nothingDispatched();
    },
    SLOW,
  );

  test(
    "ignores fields the backend's agents carry that it does not know",
    async () => {
      // The adapter's rows gain fields within a Paseo version; readers ignore them.
      await paseoRows([{ id: "busy", status: "running", dispatched: true, title: "x" }]);
      const summary = await (async () => {
        const tick = await viaPaseo();
        if (tick.kind !== "dispatched") throw new Error(`the tick failed: ${JSON.stringify(tick)}`);
        return tick.summary;
      })();
      expect(summary.running).toBe(1);
      expect(summary.skipped[0]?.reason).toBe("host cap reached");
    },
    SLOW,
  );

  test(
    "a backend that cannot read its agents names its reason on one line, never Paseo's output",
    async () => {
      await writeFile(files.rowsFail, "");
      const tick = await viaPaseo();
      expect(tick).toEqual({
        kind: "failed",
        reason: "the worker's agents could not be read: Paseo activity could not be read",
      });
      await nothingDispatched();
    },
    SLOW,
  );
});

describe("the lock (dispatch trigger §The trigger's contract)", () => {
  test(
    "a tick overlapping a running one fails before anything runs",
    async () => {
      // The running tick holds the dispatch lock in factory's own state directory for its whole
      // run: an overlapping tick reads no agent or epic, runs no sync and launches nothing. Once
      // the lock is free, the next tick runs.
      expect(DISPATCH_LOCK).toBe("/home/factory/.local/state/fffactory/dispatch.lock");
      const path = join(root, DISPATCH_LOCK);
      await mkdir(dirname(path), { recursive: true });
      const held = await flockExclusive(path);
      if (held === undefined) throw new Error("the lock was not taken");
      const chosen = backend();
      try {
        expect(await dispatcher({ select: chosen.select })).toEqual({
          kind: "failed",
          reason: "another dispatch tick holds its lock",
        });
      } finally {
        held.release();
      }
      expect(chosen.calls).toEqual([]);
      await nothingRan();
      expect((await invoke()).started[0]?.agent_id).toBe("agent-1");
    },
    SLOW,
  );

  test(
    "a Python tick of a release before #142 still holding its lock fails it before anything runs",
    async () => {
      // An upgrade's dispatch reconcile may swap the skill while the Python dispatcher's tick
      // runs under its own lock in Paseo's home: the next tick takes that lock too.
      expect(RETIRED_DISPATCH_LOCK).toBe("/home/factory/.paseo/factory-dispatch.lock");
      const path = join(root, RETIRED_DISPATCH_LOCK);
      await mkdir(dirname(path), { recursive: true });
      const held = await flockExclusive(path);
      if (held === undefined) throw new Error("the lock was not taken");
      const chosen = backend();
      try {
        expect(await dispatcher({ select: chosen.select })).toEqual({
          kind: "failed",
          reason: "another dispatch tick holds its lock",
        });
      } finally {
        held.release();
      }
      expect(chosen.calls).toEqual([]);
      await nothingRan();
      expect((await invoke()).started).toHaveLength(1);
      for (const lock of [DISPATCH_LOCK, RETIRED_DISPATCH_LOCK]) {
        const free = await flockExclusive(join(root, lock));
        expect(free).toBeDefined();
        free?.release();
      }
    },
    SLOW,
  );

  test(
    "without Paseo's home, takes only its own lock and creates none there",
    async () => {
      expect((await invoke()).started).toHaveLength(1);
      expect(await readdir(join(root, "home/factory"))).not.toContain(".paseo");
    },
    SLOW,
  );

  test(
    "is created where none is, and released when the tick ends",
    async () => {
      await rm(join(root, "home/factory/.local"), { recursive: true, force: true });
      expect((await invoke()).started).toHaveLength(1);
      const held = await flockExclusive(join(root, DISPATCH_LOCK));
      expect(held).toBeDefined();
      held?.release();
    },
    SLOW,
  );
});

describe("readiness (dispatch §The dispatcher)", () => {
  test.each([
    ["pr", "task #102 has open PR #8"],
    ["dependency", "task #102 has open external dependency #300"],
    ["commented-dependency", "task #102 has open external dependency #300"],
  ])(
    "a task held by %s is not ready",
    async (mode, reason) => {
      const summary = await invoke(mode);
      expect(summary.started).toEqual([]);
      expect(summary.skipped[0]?.reason).toBe(reason);
    },
    SLOW,
  );

  test(
    "an existing remote epic branch is not ready",
    async () => {
      git(["update-ref", "refs/heads/epic/101", "HEAD"], files.checkout);
      git(["push", "--quiet", "origin", "epic/101"], files.checkout);
      const summary = await invoke();
      expect(summary.skipped[0]?.reason).toBe("remote branch epic/101 already exists");
    },
    SLOW,
  );

  test(
    "reads GitHub with the Python dispatcher's exact commands",
    async () => {
      await invoke("dependency");
      expect(((await lines(files.gh)) as { args: string[] }[]).map(({ args }) => args)).toEqual([
        [
          "issue",
          "list",
          "--repo",
          "acme/product",
          "--state",
          "open",
          "--label",
          "ready",
          "--label",
          "ffflow-epic",
          "--limit",
          "1000",
          "--json",
          "number,title,state",
        ],
        [
          "pr",
          "list",
          "--repo",
          "acme/product",
          "--state",
          "open",
          "--limit",
          "1000",
          "--json",
          "number,title,body,headRefName",
        ],
        [
          "issue",
          "list",
          "--repo",
          "acme/product",
          "--state",
          "all",
          "--label",
          "ffflow-task",
          "--label",
          "epic-101",
          "--limit",
          "1000",
          "--json",
          "number,title,state,body",
        ],
        ["issue", "view", "102", "--repo", "acme/product", "--json", "number,state,body,comments"],
        ["issue", "view", "300", "--repo", "acme/product", "--json", "number,state"],
      ]);
    },
    SLOW,
  );
});

describe("the checkout (dispatch §The dispatcher)", () => {
  test(
    "a dirty checkout is skipped",
    async () => {
      await writeFile(join(files.checkout, "dirty.txt"), "local change");
      const summary = await invoke();
      expect(summary.started).toEqual([]);
      expect(summary.skipped[0]?.reason).toContain("dirty");
    },
    SLOW,
  );

  test(
    "a wrong remote is skipped",
    async () => {
      git(["remote", "set-url", "origin", "https://github.com/acme/other.git"], files.checkout);
      const summary = await invoke();
      expect(summary.started).toEqual([]);
      expect(summary.skipped[0]?.reason).toContain("wrong origin remote");
    },
    SLOW,
  );

  test(
    "a diverged checkout is skipped",
    async () => {
      const other = join(root, "other");
      git(["clone", "--quiet", files.remote, other]);
      git(["config", "user.name", "Test"], other);
      git(["config", "user.email", "test@example.invalid"], other);
      await writeFile(join(other, "remote.txt"), "remote");
      git(["add", "remote.txt"], other);
      git(["commit", "--quiet", "-m", "Remote work"], other);
      git(["push", "--quiet", "origin", "main"], other);
      await writeFile(join(files.checkout, "local.txt"), "local");
      git(["add", "local.txt"], files.checkout);
      git(["commit", "--quiet", "-m", "Local work"], files.checkout);
      const summary = await invoke();
      expect(summary.started).toEqual([]);
      expect(summary.skipped[0]?.reason).toContain("DIVERGED");
      expect((await readFile(files.sync, "utf8")).split("\n").filter(Boolean)).toEqual(["--plan"]);
    },
    SLOW,
  );

  test(
    "a repository that fails the FFFlow adoption check is skipped, its epics never read",
    async () => {
      git(["rm", "--quiet", ".ffflow/config.yaml"], files.checkout);
      git(["commit", "--quiet", "-m", "Unadopt"], files.checkout);
      git(["push", "--quiet", "origin", "main"], files.checkout);
      const summary = await invoke();
      expect(summary.considered).toEqual([]);
      expect(summary.skipped).toHaveLength(1);
      expect(summary.skipped[0]).toMatchObject({ repository: "product" });
      expect(summary.skipped[0]?.reason).toStartWith(
        `FFFlow adoption check failed: ${join(root, ADOPTION_CHECK)} ${REMOTE} main: `,
      );
      expect(await lines(files.gh)).toEqual([]);
    },
    SLOW,
  );
});

describe("adoption only (dispatch §The `WorkflowQueue` connector)", () => {
  test(
    "never launches work",
    async () => {
      const tick = await dispatcher({ adoptionOnly: true });
      expect(tick).toEqual({
        kind: "adoption",
        report: { adoption: "passed", failed_repositories: [] },
      });
      expect(await launched()).toBe(false);
      expect(await lines(files.gh)).toEqual([]);
    },
    SLOW,
  );

  test(
    "names the repositories that fail it",
    async () => {
      await writeFile(
        join(root, REPOSITORY_MANIFEST_PATH),
        JSON.stringify({
          version: 2,
          repositories: {
            product: { remote: REMOTE, path: "product", branch: "missing" },
          },
          repository_sets: { core: ["product"] },
          hosts: { [HOST]: { repository_sets: ["core"] } },
        }),
      );
      expect(await dispatcher({ adoptionOnly: true })).toEqual({
        kind: "adoption",
        report: { adoption: "failed", failed_repositories: ["product"] },
      });
    },
    SLOW,
  );
});

describe("what fails the tick (exit 1, nothing on standard output)", () => {
  test.each([
    [
      "a manifest that does not name the host",
      async () => {
        await writeFile(
          join(root, REPOSITORY_MANIFEST_PATH),
          JSON.stringify({ version: 2, repositories: {}, repository_sets: {}, hosts: {} }),
        );
      },
      "host test-host is absent from the deployed manifest",
    ],
    ["no manifest", () => rm(join(root, REPOSITORY_MANIFEST_PATH)), undefined],
    ["a pending projection", () => writeProjection(false), "dispatch is not active for this host"],
    [
      "a projection for another worker",
      async () => {
        const other = dispatchProjection("other-host", { enabled: true, ...schedule }, true, []);
        await writeFile(join(root, DISPATCH_PROJECTION_PATH), dispatchProjectionJson(other));
      },
      "dispatch is not active for this host",
    ],
  ])(
    "%s",
    async (_name, arrange, reason) => {
      await arrange();
      const tick = await dispatcher();
      expect(tick.kind).toBe("failed");
      if (reason !== undefined) expect(tick).toEqual({ kind: "failed", reason });
      await nothingRan();
    },
    SLOW,
  );

  test(
    "a run from anywhere but the declared dispatch directory",
    async () => {
      for (const cwd of [root, join(root, "gone")])
        expect(await dispatcher({ cwd })).toEqual({
          kind: "failed",
          reason: "run from the declared dispatch directory: /home/factory",
        });
      await nothingRan();
    },
    SLOW,
  );

  test(
    "output that is not UTF-8, read leniently, is no JSON",
    async () => {
      const tick = await dispatcher({ mode: "undecodable" });
      expect(tick.kind === "failed" && tick.reason).toStartWith("invalid JSON from gh: ");
      expect(await launched()).toBe(false);
    },
    SLOW,
  );

  test(
    "an answer from gh that is not JSON",
    async () => {
      const tick = await dispatcher({ mode: "invalid" });
      expect(tick.kind === "failed" && tick.reason).toStartWith("invalid JSON from gh: ");
      expect(await launched()).toBe(false);
    },
    SLOW,
  );

  test(
    "a checkout it cannot look at, as Python's Path.exists raises",
    async () => {
      const repositories = join(root, "workspace/repos");
      await chmod(repositories, 0o000);
      try {
        const tick = await dispatcher();
        expect(tick.kind === "failed" && tick.reason).toContain("EACCES");
      } finally {
        await chmod(repositories, 0o755);
      }
      expect(await launched()).toBe(false);
    },
    SLOW,
  );

  test("as root, before anything is read", async () => {
    const chosen = backend();
    const caller = { environment, cwd: () => files.cwd };
    expect(await workerDispatcher(worker(true), caller, chosen.select).runDispatch(false)).toEqual({
      kind: "failed",
      reason: "run as root",
    });
    expect(chosen.calls).toEqual([]);
    await nothingRan();
  });
});
