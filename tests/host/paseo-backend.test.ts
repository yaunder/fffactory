/**
 * The Paseo execution backend (`docs/specs/execution-backend.md` §The `ExecutionBackend`
 * contract) over a scripted runner: the exact commands it runs, as `factory` through the active
 * release's auth wrapper, Paseo 0.15.0's answers, and that no password reaches an argument, an
 * environment or a result.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compareSync } from "bcryptjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostProjection } from "../../src/domain/host-projection";
import type { RunRequest } from "../../src/domain/run";
import type { FactoryId, HostKey, Release, SecretReference } from "../../src/domain/instance";
import { SecretMaterial } from "../../src/domain/secrets";
import type { ApplySystem } from "../../src/host/apply";
import { executionBackend } from "../../src/host/execution-backend";
import { paseoBackend } from "../../src/host/paseo-backend";
import type {
  ProcessOptions,
  ProcessOutcome,
  ProcessRunner,
} from "../../src/infrastructure/local-tool-probe";
import { system } from "./worker-scenarios";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-paseo-backend-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ALPHA = "/workspace/repos/alpha";
const BETA = "/workspace/repos/team/beta";
const GAMMA = "/workspace/repos/gamma";
/** What the auth wrapper holds; the adapter never passes it to Paseo, nor shows it. */
const PASSWORD = "Paseo-pw 7f3e9aé";
const ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:fff-aaaa1111/paseo-AbCdEf" as SecretReference;
const PROJECTION = hostProjection(
  "fff-aaaa1111" as FactoryId,
  "builder-1" as HostKey,
  "0.3.0" as Release,
  ARN,
);
const WITHOUT_PASSWORD = hostProjection(
  "fff-aaaa1111" as FactoryId,
  "builder-1" as HostKey,
  "0.3.0" as Release,
);
const BUDGET_MS = 90_000;
const AUTH = "/opt/fffactory/current/steps/control-plane/paseo-auth.sh";
const SETUP = "/opt/fffactory/current/steps/control-plane/setup-host.sh";
const ROOT_ENV = {
  PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
};
const FACTORY_ENV = {
  HOME: "/home/factory",
  PATH: "/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
};
/** How root runs the Paseo CLI: as factory, in factory's clean environment, through the wrapper. */
const asFactory = () => [
  "/usr/sbin/runuser",
  "-u",
  "factory",
  "--",
  "/usr/bin/env",
  "-i",
  "HOME=/home/factory",
  "PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
  join(root, AUTH),
];

interface Call {
  readonly argv: readonly string[];
  readonly timeout: number;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string | undefined;
  readonly cwd?: string;
}

const exited = (exitCode: number, stdout = "", stderr = ""): ProcessOutcome => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr,
});
const json = (value: unknown) => exited(0, `${JSON.stringify(value)}\n`);

/** A runner recording every call and answering by `answer`, given Paseo's own arguments. */
function recording(answer: (paseo: readonly string[], argv: readonly string[]) => ProcessOutcome) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (argv, timeout, options?: ProcessOptions) => {
    calls.push({
      argv: [...argv],
      timeout,
      env: { ...(options?.env ?? {}) },
      stdin: options?.stdin === undefined ? undefined : new TextDecoder().decode(options.stdin),
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    // Paseo's own arguments follow the auth wrapper, however the wrapper itself was run.
    const wrapper = argv.findIndex((arg) => arg.endsWith(AUTH));
    return answer(wrapper === -1 ? [] : argv.slice(wrapper + 1), argv);
  };
  /** Paseo's own arguments of every call through the wrapper. */
  const paseo = () =>
    calls
      .map((call) => call.argv)
      .filter((argv) => argv.some((arg) => arg.endsWith(AUTH)))
      .map((argv) => argv.slice(argv.findIndex((arg) => arg.endsWith(AUTH)) + 1));
  return { calls, run, paseo };
}

function worker(
  run: ProcessRunner,
  options: { isRoot?: boolean; now?: () => Date } = {},
): ApplySystem {
  return {
    ...system(root),
    run,
    now: options.now ?? (() => new Date(0)),
    isRoot: () => options.isRoot ?? true,
    readInput: async () => "",
    release: "0.3.0" as Release,
    lock: async () => ({ release: () => {} }),
  };
}

const backend = (run: ProcessRunner, options: { isRoot?: boolean; now?: () => Date } = {}) =>
  paseoBackend(worker(run, options), BUDGET_MS);

/** A row of `paseo project ls --json`, as Paseo 0.15.0 prints it. */
function project(path: string) {
  return { projectId: `proj-${path.length}`, name: path.split("/").at(-1), kind: "git", path };
}

/**
 * A scripted Paseo's projects: `project ls` lists `registered` (or answers `ls`), `project
 * create` registers its path unless `create` answers otherwise for it.
 */
function projects(
  registered: readonly string[],
  answers: { ls?: ProcessOutcome; create?: Readonly<Record<string, ProcessOutcome>> } = {},
) {
  const listed = [...registered];
  return recording(([verb, action, path]) => {
    if (verb === "project" && action === "ls") return answers.ls ?? json(listed.map(project));
    if (verb === "project" && action === "create" && path !== undefined) {
      const answer = answers.create?.[path];
      if (answer !== undefined) return answer;
      listed.push(path);
      return json(project(path));
    }
    return exited(2, "", "unknown command");
  });
}

describe("registering the placed checkouts as Paseo projects", () => {
  test("nothing missing: lists once, creates nothing, changes nothing", async () => {
    const scripted = projects([ALPHA, BETA, "/home/factory/elsewhere"]);
    expect(await backend(scripted.run).registerRepositories([ALPHA, BETA])).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "present" },
        { path: BETA, state: "present" },
      ],
      changed: false,
    });
    expect(scripted.paseo()).toEqual([["project", "ls", "--json"]]);
  });

  test("runs Paseo from root as factory, through the active release's auth wrapper, in a clean environment", async () => {
    const scripted = projects([ALPHA]);
    await backend(scripted.run).registerRepositories([ALPHA]);
    expect(scripted.calls).toEqual([
      {
        argv: [...asFactory(), "project", "ls", "--json"],
        timeout: BUDGET_MS,
        env: ROOT_ENV,
        stdin: undefined,
      },
    ]);
  });

  test("some missing: creates only those, in order, by their absolute path", async () => {
    const scripted = projects([BETA]);
    expect(await backend(scripted.run).registerRepositories([ALPHA, BETA, GAMMA])).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "registered" },
        { path: BETA, state: "present" },
        { path: GAMMA, state: "registered" },
      ],
      changed: true,
    });
    expect(scripted.paseo()).toEqual([
      ["project", "ls", "--json"],
      ["project", "create", ALPHA, "--json"],
      ["project", "create", GAMMA, "--json"],
    ]);
  });

  test("a rerun after registering is a no-op", async () => {
    const scripted = projects([]);
    const paseo = backend(scripted.run);
    await paseo.registerRepositories([ALPHA]);
    expect((await paseo.registerRepositories([ALPHA])).changed).toBe(false);
    expect(scripted.paseo().filter((call) => call[1] === "create")).toHaveLength(1);
  });

  test("no checkouts: nothing to register, nothing asked, nothing changed", async () => {
    const scripted = projects([]);
    expect(await backend(scripted.run).registerRepositories([])).toEqual({
      backend: "paseo",
      checkouts: [],
      changed: false,
    });
    expect(scripted.calls).toEqual([]);
  });

  test.each([
    [exited(1, "", `AUTH_FAILED ${PASSWORD}`), "listing Paseo's projects exited with status 1"],
    [{ kind: "timed_out" } as const, "listing Paseo's projects timed out"],
    [{ kind: "not_found" } as const, "listing Paseo's projects could not be started (ENOENT)"],
    [
      { kind: "not_started", code: "EACCES" } as const,
      "listing Paseo's projects could not be started (EACCES)",
    ],
    [exited(0, "not json"), "Paseo's project list was invalid"],
    [json({ path: ALPHA }), "Paseo's project list was invalid"],
    [json([{ projectId: "p" }]), "Paseo's project list was invalid"],
  ])("listing fails (%#): every checkout fails, none is created", async (ls, reason) => {
    const scripted = projects([], { ls });
    expect(await backend(scripted.run).registerRepositories([ALPHA, BETA])).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "failed", reason },
        { path: BETA, state: "failed", reason },
      ],
      changed: false,
    });
    expect(scripted.paseo()).toEqual([["project", "ls", "--json"]]);
  });

  test("one create fails: only it fails, in fffactory's words, never Paseo's output", async () => {
    const refused = exited(1, "", "PROJECT_CREATE_FAILED: Directory not found");
    const scripted = projects([], { create: { [BETA]: refused } });
    const result = await backend(scripted.run).registerRepositories([ALPHA, BETA, GAMMA]);
    expect(result).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "registered" },
        {
          path: BETA,
          state: "failed",
          reason: "registering it as a Paseo project exited with status 1",
        },
        { path: GAMMA, state: "registered" },
      ],
      changed: true,
    });
    expect(JSON.stringify(result)).not.toContain("Directory not found");
  });

  test("a create that times out fails that checkout alone", async () => {
    const scripted = projects([], { create: { [ALPHA]: { kind: "timed_out" } } });
    expect(await backend(scripted.run).registerRepositories([ALPHA])).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "failed", reason: "registering it as a Paseo project timed out" },
      ],
      changed: false,
    });
  });

  test("only lists and creates: never deletes, archives or touches the daemon", async () => {
    const scripted = projects([BETA], { create: { [GAMMA]: exited(1) } });
    await backend(scripted.run).registerRepositories([ALPHA, BETA, GAMMA]);
    expect(scripted.calls).toHaveLength(3);
    expect(
      scripted
        .paseo()
        .every((call) => call[0] === "project" && ["ls", "create"].includes(call[1] ?? "")),
    ).toBe(true);
  });

  test("the password never appears in an argument or the result", async () => {
    const leaky = exited(1, PASSWORD, `AUTH_FAILED: ${PASSWORD}`);
    const scripted = projects([], { create: { [ALPHA]: leaky } });
    const result = await backend(scripted.run).registerRepositories([ALPHA, BETA]);
    const listingLeak = projects([], { ls: leaky });
    const listed = await backend(listingLeak.run).registerRepositories([ALPHA]);
    const seen = [...scripted.calls, ...listingLeak.calls].flatMap((call) => [
      ...call.argv,
      ...Object.values(call.env),
    ]);
    expect(seen).toContain(ALPHA);
    expect(seen.filter((arg) => arg.includes(PASSWORD) || /password/i.test(arg))).toEqual([]);
    expect(JSON.stringify([result, listed])).not.toContain(PASSWORD);
  });
});

/** A row of `paseo ls --json`, as Paseo 0.15.0 prints it. */
function row(id: string, status: string) {
  return {
    id,
    shortId: id.slice(0, 7),
    name: "Fix the build",
    provider: "claude",
    thinking: "auto",
    status,
    cwd: "/workspace/repos/factory",
    created: "2 hours ago",
  };
}

/** `paseo agent inspect ID --json`, as Paseo 0.15.0 prints it, trimmed to what matters. */
function inspection(id: string, pending: readonly { id: string; tool: string }[]): ProcessOutcome {
  return json({
    Id: id,
    Name: "Fix the build",
    Status: "running",
    Archived: false,
    PendingPermissions: pending,
  });
}

type Answer = ProcessOutcome | readonly ReturnType<typeof row>[];

/**
 * A scripted Paseo's agents: each list answers its rows (or an outcome), each inspection its
 * agent's outcome. Anything else fails the test.
 */
function agents(answers: {
  all: Answer;
  dispatched?: Answer;
  inspect?: Readonly<Record<string, ProcessOutcome>>;
}) {
  const outcome = (answer: Answer): ProcessOutcome =>
    Array.isArray(answer) ? json(answer) : (answer as ProcessOutcome);
  return recording(([verb, , id], argv) => {
    if (verb === "ls")
      return outcome(argv.includes("--label") ? (answers.dispatched ?? []) : answers.all);
    const inspected = answers.inspect?.[id ?? ""];
    if (inspected === undefined) throw new Error(`unexpected command: ${argv.join(" ")}`);
    return inspected;
  });
}

const LIST = ["ls", "--global", "--background", "--json"];
const DISPATCHED = ["ls", "--global", "--background", "--label", "factory-dispatch=true", "--json"];

describe("the worker's runs in fffactory's states (docs/specs/control-plane.md §Agent states)", () => {
  test("from root, drops to factory and runs the active release's auth wrapper", async () => {
    const scripted = agents({ all: [row("one", "idle")] });
    expect(await backend(scripted.run).runs()).toEqual({
      kind: "listed",
      runs: [{ id: "one", state: "finished", dispatched: false }],
    });
    expect(scripted.calls.map((call) => call.argv)).toEqual([
      [...asFactory(), ...LIST],
      [...asFactory(), ...DISPATCHED],
    ]);
    for (const call of scripted.calls) expect(call.env).toEqual(ROOT_ENV);
  });

  test("as factory, runs the auth wrapper itself, in factory's clean environment", async () => {
    const scripted = agents({
      all: [row("a1", "running"), row("b2", "idle")],
      dispatched: [row("a1", "running")],
      inspect: { a1: inspection("a1", [{ id: "p", tool: "Bash" }]) },
    });
    expect(await backend(scripted.run, { isRoot: false }).runs()).toEqual({
      kind: "listed",
      runs: [
        { id: "a1", state: "needs_input", dispatched: true },
        { id: "b2", state: "finished", dispatched: false },
      ],
    });
    expect(scripted.calls.map((call) => call.argv)).toEqual([
      [join(root, AUTH), ...LIST],
      [join(root, AUTH), ...DISPATCHED],
      [join(root, AUTH), "agent", "inspect", "a1", "--json"],
    ]);
    for (const call of scripted.calls) expect(call.env).toEqual(FACTORY_ENV);
  });

  test.each([
    ["initializing", "working"],
    ["idle", "finished"],
    ["error", "failed"],
    ["closed", "stopped"],
  ] as const)(
    "translates an agent Paseo reports %s as %s, without inspecting it",
    async (status, state) => {
      const scripted = agents({ all: [row("one", status)] });
      expect(await backend(scripted.run).runs()).toEqual({
        kind: "listed",
        runs: [{ id: "one", state, dispatched: false }],
      });
      expect(scripted.paseo().filter((call) => call.includes("inspect"))).toEqual([]);
    },
  );

  test.each([
    [[], "working"],
    [[{ id: "permission-1", tool: "Bash" }], "needs_input"],
  ] as const)(
    "inspects a running agent: with pending permissions %j it reads %s",
    async (pending, state) => {
      const scripted = agents({
        all: [row("one", "running")],
        inspect: { one: inspection("one", pending) },
      });
      expect(await backend(scripted.run).runs()).toEqual({
        kind: "listed",
        runs: [{ id: "one", state, dispatched: false }],
      });
      expect(scripted.paseo().at(-1)).toEqual(["agent", "inspect", "one", "--json"]);
    },
  );

  test("inspects only the running agents, and marks the ones dispatch launched", async () => {
    const scripted = agents({
      all: [
        row("a1", "running"),
        row("b2", "idle"),
        row("c3", "running"),
        row("d4", "initializing"),
        row("e5", "closed"),
      ],
      dispatched: [row("b2", "idle"), row("c3", "running")],
      inspect: { a1: inspection("a1", []), c3: inspection("c3", [{ id: "p", tool: "Edit" }]) },
    });
    expect(await backend(scripted.run).runs()).toEqual({
      kind: "listed",
      runs: [
        { id: "a1", state: "working", dispatched: false },
        { id: "b2", state: "finished", dispatched: true },
        { id: "c3", state: "needs_input", dispatched: true },
        { id: "d4", state: "working", dispatched: false },
        { id: "e5", state: "stopped", dispatched: false },
      ],
    });
    expect(
      scripted
        .paseo()
        .filter((call) => call.includes("inspect"))
        .map((call) => call.at(-2)),
    ).toEqual(["a1", "c3"]);
  });

  test("a worker with no agents lists none", async () => {
    const scripted = agents({ all: [] });
    expect(await backend(scripted.run).runs()).toEqual({ kind: "listed", runs: [] });
  });

  test("a status fffactory does not know makes the whole answer unknown, before any inspection", async () => {
    const scripted = agents({
      all: [row("one", "running"), row("two", "permission")],
      inspect: { one: inspection("one", []) },
    });
    expect(await backend(scripted.run).runs()).toEqual({
      kind: "unknown",
      reason: "Paseo reported an agent status fffactory does not know",
    });
    expect(scripted.paseo().filter((call) => call.includes("inspect"))).toEqual([]);
  });

  test.each([[exited(1, "", "no such agent")], [{ kind: "timed_out" as const }]])(
    "a running agent it cannot inspect makes the answer unknown (%#)",
    async (outcome) => {
      const scripted = agents({ all: [row("one", "running")], inspect: { one: outcome } });
      expect(await backend(scripted.run).runs()).toEqual({
        kind: "unknown",
        reason: "a Paseo agent could not be inspected",
      });
    },
  );

  test.each([
    ["not json"],
    ["[]"],
    [JSON.stringify({ Id: "one", Status: "running" })],
    [JSON.stringify({ Id: "one", Status: "running", PendingPermissions: "none" })],
    [JSON.stringify({ Id: "other", Status: "running", PendingPermissions: [] })],
  ])("an inspection it cannot read makes the answer unknown: %s", async (stdout) => {
    const scripted = agents({ all: [row("one", "running")], inspect: { one: exited(0, stdout) } });
    expect(await backend(scripted.run).runs()).toEqual({
      kind: "unknown",
      reason: "a Paseo agent's inspection was invalid",
    });
  });

  test.each([
    ['{"agents":[]}'],
    ["not json"],
    ['[{"status":"idle"}]'],
    ['[{"id":"one"}]'],
    ['[{"id":"--all","status":"running"}]'],
    ['[{"id":"one two","status":"idle"}]'],
    ['["one"]'],
  ])("conservatively reads Paseo's agent list %s as unknown", async (stdout) => {
    const scripted = agents({ all: exited(0, stdout) });
    expect(await backend(scripted.run).runs()).toEqual({
      kind: "unknown",
      reason: "Paseo activity was invalid",
    });
    expect(scripted.paseo().filter((call) => call.includes("inspect"))).toEqual([]);
  });

  test.each([['{"agents":[]}'], ['[{"status":"idle"}]']])(
    "conservatively reads Paseo's dispatched list %s as unknown",
    async (stdout) => {
      const scripted = agents({ all: [row("one", "idle")], dispatched: exited(0, stdout) });
      expect(await backend(scripted.run).runs()).toEqual({
        kind: "unknown",
        reason: "Paseo activity was invalid",
      });
    },
  );

  test.each(["all", "dispatched"] as const)(
    "treats a failed Paseo %s list as unknown",
    async (list) => {
      const scripted = agents({ all: [row("one", "idle")], [list]: { kind: "timed_out" } });
      expect(await backend(scripted.run).runs()).toEqual({
        kind: "unknown",
        reason: "Paseo activity could not be read",
      });
    },
  );

  test.each([true, false])(
    "bounds the whole answer by its budget, each command given what is left (root: %p)",
    async (isRoot) => {
      let clock = 0;
      const timeouts: number[] = [];
      const scripted = agents({
        all: [row("a1", "running"), row("b2", "running")],
        inspect: { a1: inspection("a1", []), b2: inspection("b2", []) },
      });
      const run: ProcessRunner = async (argv, timeout, options) => {
        timeouts.push(timeout);
        clock += 40_000;
        return scripted.run(argv, timeout, options);
      };
      const answer = await backend(run, { isRoot, now: () => new Date(clock) }).runs();
      expect(answer).toEqual({ kind: "unknown", reason: "a Paseo agent could not be inspected" });
      expect(timeouts).toEqual([90_000, 50_000, 10_000]);
      expect(scripted.paseo().map((call) => call.at(-2))).toEqual([
        "--background",
        "factory-dispatch=true",
        "a1",
      ]);
    },
  );
});

const PRODUCT_101 = { repository: "product", workItem: 101 };
const LAUNCHED_FOR = [
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
];
/** The dispatcher's environment: the scheduled agent's, its own Paseo identity among it. */
const CALLER_ENV = {
  HOME: "/home/factory",
  PATH: "/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
  PASEO_HOME: "/home/factory/.paseo",
  PASEO_AGENT_ID: "scheduled-agent",
  PASEO_WORKSPACE_ID: "scheduled-workspace",
  MARKER: "the caller's",
};
const caller = (run: ProcessRunner, budgetMs = BUDGET_MS) =>
  executionBackend(worker(run, { isRoot: false }), budgetMs, CALLER_ENV);

describe("the runs dispatch launched for some work (docs/specs/execution-backend.md §Inspect)", () => {
  test("lists only the agents labelled for it, background workspaces' too, each launched for it", async () => {
    const scripted = agents({
      all: [],
      dispatched: [row("old", "closed"), row("live", "running")],
      inspect: { live: inspection("live", []) },
    });
    expect(await backend(scripted.run).runs(PRODUCT_101)).toEqual({
      kind: "listed",
      runs: [
        { id: "old", state: "stopped", dispatched: true, work: PRODUCT_101 },
        { id: "live", state: "working", dispatched: true, work: PRODUCT_101 },
      ],
    });
    expect(scripted.paseo()).toEqual([LAUNCHED_FOR, ["agent", "inspect", "live", "--json"]]);
  });

  test("for a caller that gives its environment, runs the wrapper itself in it, as it is", async () => {
    const scripted = agents({ all: [], dispatched: [row("old", "idle")] });
    expect(await caller(scripted.run).runs(PRODUCT_101)).toEqual({
      kind: "listed",
      runs: [{ id: "old", state: "finished", dispatched: true, work: PRODUCT_101 }],
    });
    expect(scripted.calls).toEqual([
      {
        argv: [join(root, AUTH), ...LAUNCHED_FOR],
        timeout: BUDGET_MS,
        env: CALLER_ENV,
        stdin: undefined,
      },
    ]);
  });

  test("none launched for it lists none", async () => {
    const scripted = agents({ all: [row("other", "running")], dispatched: [] });
    expect(await backend(scripted.run).runs(PRODUCT_101)).toEqual({ kind: "listed", runs: [] });
    expect(scripted.paseo()).toEqual([LAUNCHED_FOR]);
  });

  test.each([
    [{ kind: "timed_out" } as const, "Paseo activity could not be read"],
    [exited(1, "", "connect ECONNREFUSED"), "Paseo activity could not be read"],
    [exited(0, '{"agents":[]}'), "Paseo activity was invalid"],
    [exited(0, "[{}]"), "Paseo activity was invalid"],
    [json([row("one", "permission")]), "Paseo reported an agent status fffactory does not know"],
  ])("a list it cannot read is unknown, never none (%#)", async (dispatched, reason) => {
    const scripted = agents({ all: [], dispatched });
    expect(await backend(scripted.run).runs(PRODUCT_101)).toEqual({ kind: "unknown", reason });
  });
});

/** A request to start a run, as the dispatcher makes it. */
const REQUEST: RunRequest = {
  launch: { ...PRODUCT_101, attempt: "20261109T070503Z" },
  checkout: "/workspace/repos/product",
  base: "origin/main",
  branch: "dispatch/epic-101-20261109T070503Z",
  invocation: "/fff:work-epic 101\n\nWork it.",
  agent: { provider: "codex", model: "configured-model", mode: "default" },
};
/** Paseo's arguments for it: exactly the Python dispatcher's. */
const LAUNCH = [
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
  "/workspace/repos/product",
  "--label",
  "factory-dispatch=true",
  "--label",
  "factory-repository=product",
  "--label",
  "factory-epic=101",
  "--label",
  "factory-dispatched-at=20261109T070503Z",
  "/fff:work-epic 101\n\nWork it.",
];

/** A scripted Paseo launching every run as `agent-1`, as 0.15.0 answers `run --no-wait --json`. */
const launching = (answer: ProcessOutcome = json({ agentId: "agent-1", status: "running" })) =>
  recording(([verb]) => (verb === "run" ? answer : exited(2, "", "unknown command")));

describe("starting a run (docs/specs/execution-backend.md §Start)", () => {
  test("launches with the dispatcher's exact arguments, from the checkout, in its environment without its Paseo identity", async () => {
    const scripted = launching();
    expect(await caller(scripted.run, 900_000).startRun(REQUEST)).toEqual({
      kind: "started",
      handle: { id: "agent-1" },
    });
    const { PASEO_AGENT_ID, PASEO_WORKSPACE_ID, ...rest } = CALLER_ENV;
    expect(scripted.calls).toEqual([
      {
        argv: [join(root, AUTH), ...LAUNCH],
        timeout: 900_000,
        env: rest,
        stdin: undefined,
        cwd: REQUEST.checkout,
      },
    ]);
    // Top-level: the launch inherits neither the scheduled agent nor its workspace.
    const env = scripted.calls[0]?.env ?? {};
    expect(Object.keys(env)).not.toContain("PASEO_AGENT_ID");
    expect(Object.keys(env)).not.toContain("PASEO_WORKSPACE_ID");
    expect(env).toEqual({
      HOME: "/home/factory",
      PATH: "/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
      PASEO_HOME: "/home/factory/.paseo",
      MARKER: "the caller's",
    });
    expect([PASEO_AGENT_ID, PASEO_WORKSPACE_ID]).toEqual([
      "scheduled-agent",
      "scheduled-workspace",
    ]);
  });

  test("launches without waiting, by the current flag, never its deprecated alias", async () => {
    const scripted = launching();
    await caller(scripted.run).startRun(REQUEST);
    const [args] = scripted.paseo();
    expect(args).toContain("--no-wait");
    expect(args).not.toContain("--background");
  });

  test("without a caller's environment, as factory in its clean one", async () => {
    const scripted = launching();
    await backend(scripted.run, { isRoot: false }).startRun(REQUEST);
    expect(scripted.calls.map(({ argv, env, cwd }) => ({ argv, env, cwd }))).toEqual([
      { argv: [join(root, AUTH), ...LAUNCH], env: FACTORY_ENV, cwd: REQUEST.checkout },
    ]);
  });

  test("from root, drops to factory in its clean environment, from the checkout", async () => {
    const scripted = launching();
    expect((await backend(scripted.run).startRun(REQUEST)).kind).toBe("started");
    expect(scripted.calls.map(({ argv, env, cwd }) => ({ argv, env, cwd }))).toEqual([
      { argv: [...asFactory(), ...LAUNCH], env: ROOT_ENV, cwd: REQUEST.checkout },
    ]);
  });

  test.each([
    [exited(1, "AUTH_FAILED", "Paseo said no"), "starting a Paseo run exited with status 1"],
    [{ kind: "timed_out" } as const, "starting a Paseo run timed out"],
    [{ kind: "not_found" } as const, "starting a Paseo run could not be started (ENOENT)"],
    [exited(0, "not json"), "Paseo's answer to the run was invalid"],
    [json([{ agentId: "agent-1" }]), "Paseo's answer to the run was invalid"],
    [json({ status: "running" }), "Paseo's answer to the run was invalid"],
    [json({ agentId: 7 }), "Paseo's answer to the run was invalid"],
    [json({ agentId: "--all" }), "Paseo's answer to the run was invalid"],
  ])(
    "a launch that fails, or whose answer it cannot read, fails in fffactory's words (%#)",
    async (answer, reason) => {
      const scripted = launching(answer);
      const start = await caller(scripted.run).startRun(REQUEST);
      expect(start).toEqual({ kind: "failed", reason });
      expect(JSON.stringify(start)).not.toContain("Paseo said no");
    },
  );

  test("a launch that would start past the budget is not run, and has timed out", async () => {
    let clock = 0;
    const scripted = launching();
    const paseo = backend(scripted.run, { now: () => new Date(clock) });
    clock = BUDGET_MS;
    expect(await paseo.startRun(REQUEST)).toEqual({
      kind: "failed",
      reason: "starting a Paseo run timed out",
    });
    expect(scripted.calls).toEqual([]);
  });
});

/** Answers every command 0. */
const done = () => recording(() => exited(0));

/** The bcrypt hash setup was sent, after checking the reference line before it. */
function sentHash(calls: readonly Call[]): string {
  const setup = calls.find((call) => call.argv[0] === "/bin/bash");
  const [reference, hash, rest] = (setup?.stdin ?? "").split("\n");
  expect({ reference, rest }).toEqual({ reference: ARN, rest: "" });
  return hash ?? "";
}

describe("maintenance (docs/specs/control-plane.md §Worker protocol and privilege boundary)", () => {
  test("install sends the active release's setup only the reference and Paseo's bcrypt hash", async () => {
    const scripted = done();
    expect(await backend(scripted.run).install(PROJECTION, new SecretMaterial(PASSWORD))).toEqual({
      kind: "done",
    });
    expect(scripted.calls).toEqual([
      {
        argv: ["/bin/bash", join(root, SETUP)],
        timeout: BUDGET_MS,
        env: ROOT_ENV,
        stdin: expect.any(String),
      },
    ]);
    const hash = sentHash(scripted.calls);
    // Paseo's own form and cost: bcryptjs's hashSync(password, 12), as `paseo daemon set-password`.
    expect(hash).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{53}$/);
    expect(compareSync(PASSWORD, hash)).toBe(true);
    expect(compareSync(`${PASSWORD}x`, hash)).toBe(false);
  });

  test("the password reaches no argument, environment or setup input, only its hash", async () => {
    const scripted = done();
    await backend(scripted.run).install(PROJECTION, new SecretMaterial(PASSWORD));
    const seen = scripted.calls.flatMap((call) => [
      ...call.argv,
      ...Object.values(call.env),
      call.stdin ?? "",
    ]);
    expect(seen.filter((text) => text.includes(PASSWORD))).toEqual([]);
    expect(seen.filter((text) => text.includes("Paseo-pw"))).toEqual([]);
  });

  test("hashes the password as paseo-auth.sh sends it: final line endings dropped, all else kept", async () => {
    const scripted = done();
    const password = new SecretMaterial(`  ${PASSWORD} \n\n`);
    expect(await backend(scripted.run).install(PROJECTION, password)).toEqual({ kind: "done" });
    expect(compareSync(`  ${PASSWORD} `, sentHash(scripted.calls))).toBe(true);
  });

  test("a host without a password reference sends setup two empty lines", async () => {
    const scripted = done();
    expect(await backend(scripted.run).install(WITHOUT_PASSWORD, undefined)).toEqual({
      kind: "done",
    });
    expect(scripted.calls.map((call) => [call.argv, call.stdin])).toEqual([
      [["/bin/bash", join(root, SETUP)], "\n\n"],
    ]);
  });

  test.each([[""], [" \t\n"]])(
    "an empty or blank password %j fails the install before setup runs",
    async (value) => {
      const scripted = done();
      expect(await backend(scripted.run).install(PROJECTION, new SecretMaterial(value))).toEqual({
        kind: "failed",
        reason: "Paseo password: its secret is empty",
      });
      expect(scripted.calls).toEqual([]);
    },
  );

  test("a referenced password it was not given fails the install before setup runs", async () => {
    const scripted = done();
    expect(await backend(scripted.run).install(PROJECTION, undefined)).toEqual({
      kind: "failed",
      reason: "Paseo password: it was not read",
    });
    expect(scripted.calls).toEqual([]);
  });

  test("reloads through the active release's auth wrapper, as factory", async () => {
    const scripted = done();
    expect(await backend(scripted.run).reload()).toEqual({ kind: "done" });
    expect(scripted.calls).toEqual([
      {
        argv: [...asFactory(), "daemon", "reload"],
        timeout: BUDGET_MS,
        env: ROOT_ENV,
        stdin: undefined,
      },
    ]);
  });

  test("restarts only through the fixed systemd action", async () => {
    const scripted = done();
    expect(await backend(scripted.run).restart()).toEqual({ kind: "done" });
    expect(scripted.calls).toEqual([
      {
        argv: ["/usr/bin/systemctl", "restart", "paseo.service"],
        timeout: BUDGET_MS,
        env: ROOT_ENV,
        stdin: undefined,
      },
    ]);
  });

  test("reports process failures without exposing process output", async () => {
    const exitedSeven = recording(() => exited(7, "secret output", "secret error"));
    expect(await backend(exitedSeven.run).restart()).toEqual({
      kind: "failed",
      reason: "Paseo restart exited 7",
    });
    expect(await backend(exitedSeven.run).install(WITHOUT_PASSWORD, undefined)).toEqual({
      kind: "failed",
      reason: "Paseo setup exited 7",
    });
    const timedOut = recording(() => ({ kind: "timed_out" }));
    expect(await backend(timedOut.run).reload()).toEqual({
      kind: "failed",
      reason: "Paseo reload timed_out",
    });
  });

  test("a command that would start past the budget is not run, and has timed out", async () => {
    let clock = 0;
    const scripted = done();
    const paseo = backend(scripted.run, { now: () => new Date(clock) });
    clock = BUDGET_MS;
    expect(await paseo.restart()).toEqual({ kind: "failed", reason: "Paseo restart timed_out" });
    expect(scripted.calls).toEqual([]);
  });
});

describe("the execution backend selection", () => {
  test("is Paseo, as factory in its clean environment unless its caller gives its own", async () => {
    const scripted = agents({ all: [] });
    await executionBackend(worker(scripted.run, { isRoot: false }), 60_000).runs();
    await executionBackend(worker(scripted.run, { isRoot: false }), 60_000, CALLER_ENV).runs();
    expect(scripted.calls.map((call) => call.env)).toEqual([
      FACTORY_ENV,
      FACTORY_ENV,
      CALLER_ENV,
      CALLER_ENV,
    ]);
  });

  test("is Paseo, its commands within the budget the caller gives", async () => {
    const scripted = projects([ALPHA]);
    const result = await executionBackend(worker(scripted.run), 60_000).registerRepositories([
      ALPHA,
    ]);
    expect(result.backend).toBe("paseo");
    expect(scripted.calls.map((call) => [call.argv, call.timeout])).toEqual([
      [[...asFactory(), "project", "ls", "--json"], 60_000],
    ]);
  });
});
