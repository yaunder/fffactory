import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compareSync } from "bcryptjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "../../src/domain/installation";
import type { FactoryId, HostKey, Release, SecretReference } from "../../src/domain/instance";
import type { ApplySystem } from "../../src/host/apply";
import { workerControlPlane } from "../../src/host/control-plane";
import type {
  ProcessOptions,
  ProcessOutcome,
  ProcessRunner,
} from "../../src/infrastructure/local-tool-probe";
import { system } from "./worker-scenarios";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-control-plane-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:fff-aaaa1111/paseo-AbCdEf" as SecretReference;
const PROJECTION = hostProjectionJson(
  hostProjection("fff-aaaa1111" as FactoryId, "builder-1" as HostKey, "0.3.0" as Release, ARN),
);
const WITHOUT_PASSWORD = hostProjectionJson(
  hostProjection("fff-aaaa1111" as FactoryId, "builder-1" as HostKey, "0.3.0" as Release),
);
const PASSWORD = "Paseo-pw 7f3e9a\u00e9";
const SETUP = "/opt/fffactory/current/steps/control-plane/setup-host.sh";

interface Call {
  readonly argv: readonly string[];
  readonly timeout: number;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string | undefined;
}

/** Answers Secrets Manager with `secret` (its JSON `SecretString`), and every other command 0. */
function recording(secret: ProcessOutcome | string | null = PASSWORD) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (argv, timeout, options?: ProcessOptions) => {
    calls.push({
      argv: [...argv],
      timeout,
      env: { ...(options?.env ?? {}) },
      stdin: options?.stdin === undefined ? undefined : new TextDecoder().decode(options.stdin),
    });
    if (argv[0] !== "/usr/bin/aws") return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    if (typeof secret === "object" && secret !== null) return secret;
    return { kind: "exited", exitCode: 0, stdout: `${JSON.stringify(secret)}\n`, stderr: "" };
  };
  return { calls, run };
}

const AUTH = "/opt/fffactory/current/steps/control-plane/paseo-auth.sh";
/** How every Paseo command starts: as factory, in a clean environment, through the auth wrapper. */
const AS_FACTORY = [
  "/usr/sbin/runuser",
  "-u",
  "factory",
  "--",
  "/usr/bin/env",
  "-i",
  "HOME=/home/factory",
  "PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
  AUTH,
];

/** A row of `paseo ls --json`, as Paseo 0.13.2 prints it. */
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

/** `paseo agent inspect ID --json`, as Paseo 0.13.2 prints it, trimmed to what matters. */
function inspection(id: string, pending: readonly { id: string; tool: string }[]): ProcessOutcome {
  const stdout = JSON.stringify({
    Id: id,
    Name: "Fix the build",
    Status: "running",
    Archived: false,
    PendingPermissions: pending,
  });
  return { kind: "exited", exitCode: 0, stdout, stderr: "" };
}

type Answer = ProcessOutcome | readonly ReturnType<typeof row>[];

/**
 * A scripted Paseo: each list answers its rows (or an outcome), each inspection its agent's
 * outcome. It records each command's argv; anything else fails the test.
 */
function paseo(answers: {
  all: Answer;
  dispatched?: Answer;
  inspect?: Readonly<Record<string, ProcessOutcome>>;
}) {
  const calls: string[][] = [];
  const outcome = (answer: Answer): ProcessOutcome =>
    Array.isArray(answer)
      ? { kind: "exited", exitCode: 0, stdout: JSON.stringify(answer), stderr: "" }
      : (answer as ProcessOutcome);
  const run: ProcessRunner = async (argv) => {
    calls.push([...argv]);
    // Paseo's own arguments follow the auth wrapper, however the wrapper itself was run.
    const [verb, , id] = argv.slice(argv.findIndex((arg) => arg.endsWith(AUTH)) + 1);
    if (verb === "ls")
      return outcome(argv.includes("--label") ? (answers.dispatched ?? []) : answers.all);
    const inspected = answers.inspect?.[id ?? ""];
    if (inspected === undefined) throw new Error(`unexpected command: ${argv.join(" ")}`);
    return inspected;
  };
  return { calls, run };
}

/** The bcrypt hash setup was sent, after checking the reference line before it. */
function sentHash(calls: readonly Call[]): string {
  const setup = calls.find((call) => call.argv[0] === "/bin/bash");
  const [reference, hash, rest] = (setup?.stdin ?? "").split("\n");
  expect({ reference, rest }).toEqual({ reference: ARN, rest: "" });
  return hash ?? "";
}

function endpoint(
  run: ProcessRunner,
  input = PROJECTION,
  isRoot = true,
  hostname = "fff-aaaa1111-builder-1",
  now = () => new Date(),
) {
  const worker: ApplySystem = {
    ...system(root),
    run,
    now,
    isRoot: () => isRoot,
    hostname: () => hostname,
    readInput: async () => input,
    release: "0.3.0" as Release,
    lock: async () => ({ release: () => {} }),
  };
  return workerControlPlane(worker);
}

describe("host agents, the dispatcher's read of the same adapter", () => {
  test("lists the agents through the active release auth wrapper as itself, in factory's clean environment", async () => {
    const scripted = paseo({
      all: [row("a1", "running"), row("b2", "idle")],
      dispatched: [row("a1", "running")],
      inspect: { a1: inspection("a1", [{ id: "p", tool: "Bash" }]) },
    });
    const runs: { argv: readonly string[]; env: ProcessOptions["env"] }[] = [];
    const run: ProcessRunner = async (argv, timeout, options) => {
      runs.push({ argv, env: options?.env });
      return scripted.run(argv, timeout, options);
    };
    expect(await endpoint(run, PROJECTION, false).agents()).toEqual({
      kind: "listed",
      agents: [
        { id: "a1", state: "needs_input", dispatched: true },
        { id: "b2", state: "finished", dispatched: false },
      ],
    });
    expect(runs.map((call) => call.argv)).toEqual([
      [join(root, AUTH), "ls", "--global", "--background", "--json"],
      [
        join(root, AUTH),
        "ls",
        "--global",
        "--background",
        "--label",
        "factory-dispatch=true",
        "--json",
      ],
      [join(root, AUTH), "agent", "inspect", "a1", "--json"],
    ]);
    for (const call of runs)
      expect(call.env).toEqual({
        HOME: "/home/factory",
        PATH: "/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
      });
  });

  test("bounds the whole answer by the activity's budget", async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const scripted = paseo({
      all: [row("a1", "running")],
      inspect: { a1: inspection("a1", []) },
    });
    const run: ProcessRunner = async (argv, timeout, options) => {
      timeouts.push(timeout);
      clock += 50_000;
      return scripted.run(argv, timeout, options);
    };
    const answer = await endpoint(
      run,
      PROJECTION,
      false,
      undefined,
      () => new Date(clock),
    ).agents();
    expect(answer).toEqual({ kind: "unknown", reason: "a Paseo agent could not be inspected" });
    expect(timeouts).toEqual([90_000, 40_000]);
  });

  test("an agent list it cannot read is unknown, as the activity's is", async () => {
    const { run } = paseo({ all: { kind: "exited", exitCode: 1, stdout: "", stderr: "denied" } });
    expect(await endpoint(run, PROJECTION, false).agents()).toEqual({
      kind: "unknown",
      reason: "Paseo activity could not be read",
    });
  });

  test("refuses to run as root, where Paseo's files would become root's", async () => {
    let ran = false;
    const agents = await endpoint(
      async () => {
        ran = true;
        return { kind: "not_found" };
      },
      PROJECTION,
      true,
    ).agents();
    expect(agents).toEqual({ kind: "unknown", reason: "run as root" });
    expect(ran).toBe(false);
  });
});

describe("the worker control-plane endpoint", () => {
  test("reads every agent by dropping to factory and using the active release auth wrapper", async () => {
    const { calls, run } = paseo({ all: [row("one", "idle")] });
    expect(await endpoint(run).activity()).toEqual({
      kind: "listed",
      agents: [{ id: "one", state: "finished", dispatched: false }],
    });
    expect(calls).toHaveLength(2);
    for (const call of calls)
      expect(call.slice(0, AS_FACTORY.length)).toEqual([
        ...AS_FACTORY.slice(0, -1),
        join(root, AUTH),
      ]);
    expect(calls.map((call) => call.slice(AS_FACTORY.length))).toEqual([
      ["ls", "--global", "--background", "--json"],
      ["ls", "--global", "--background", "--label", "factory-dispatch=true", "--json"],
    ]);
  });

  test.each([
    ["initializing", "working"],
    ["idle", "finished"],
    ["error", "failed"],
    ["closed", "stopped"],
  ] as const)(
    "translates an agent Paseo reports %s as %s, without inspecting it",
    async (status, state) => {
      const { calls, run } = paseo({ all: [row("one", status)] });
      expect(await endpoint(run).activity()).toEqual({
        kind: "listed",
        agents: [{ id: "one", state, dispatched: false }],
      });
      expect(calls.filter((call) => call.includes("inspect"))).toEqual([]);
    },
  );

  test.each([
    [[], "working"],
    [[{ id: "permission-1", tool: "Bash" }], "needs_input"],
  ] as const)(
    "inspects a running agent: with pending permissions %j it reads %s",
    async (pending, state) => {
      const { calls, run } = paseo({
        all: [row("one", "running")],
        inspect: { one: inspection("one", pending) },
      });
      expect(await endpoint(run).activity()).toEqual({
        kind: "listed",
        agents: [{ id: "one", state, dispatched: false }],
      });
      expect(calls.at(-1)?.slice(AS_FACTORY.length)).toEqual(["agent", "inspect", "one", "--json"]);
    },
  );

  test("inspects only the running agents, and marks the ones dispatch launched", async () => {
    const { calls, run } = paseo({
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
    expect(await endpoint(run).activity()).toEqual({
      kind: "listed",
      agents: [
        { id: "a1", state: "working", dispatched: false },
        { id: "b2", state: "finished", dispatched: true },
        { id: "c3", state: "needs_input", dispatched: true },
        { id: "d4", state: "working", dispatched: false },
        { id: "e5", state: "stopped", dispatched: false },
      ],
    });
    expect(calls.filter((call) => call.includes("inspect")).map((call) => call.at(-2))).toEqual([
      "a1",
      "c3",
    ]);
  });

  test("a worker with no agents lists none", async () => {
    const { run } = paseo({ all: [] });
    expect(await endpoint(run).activity()).toEqual({ kind: "listed", agents: [] });
  });

  test("a status fffactory does not know makes the whole activity unknown, before any inspection", async () => {
    const { calls, run } = paseo({
      all: [row("one", "running"), row("two", "permission")],
      inspect: { one: inspection("one", []) },
    });
    expect(await endpoint(run).activity()).toEqual({
      kind: "unknown",
      reason: "Paseo reported an agent status fffactory does not know",
    });
    expect(calls.filter((call) => call.includes("inspect"))).toEqual([]);
  });

  test.each([
    [{ kind: "exited" as const, exitCode: 1, stdout: "", stderr: "no such agent" }],
    [{ kind: "timed_out" as const }],
  ])("a running agent it cannot inspect makes the activity unknown (%#)", async (outcome) => {
    const { run } = paseo({ all: [row("one", "running")], inspect: { one: outcome } });
    expect(await endpoint(run).activity()).toEqual({
      kind: "unknown",
      reason: "a Paseo agent could not be inspected",
    });
  });

  test.each([
    ["not json"],
    ["[]"],
    [JSON.stringify({ Id: "one", Status: "running" })],
    [JSON.stringify({ Id: "one", Status: "running", PendingPermissions: "none" })],
    [JSON.stringify({ Id: "other", Status: "running", PendingPermissions: [] })],
  ])("an inspection it cannot read makes the activity unknown: %s", async (stdout) => {
    const { run } = paseo({
      all: [row("one", "running")],
      inspect: { one: { kind: "exited", exitCode: 0, stdout, stderr: "" } },
    });
    expect(await endpoint(run).activity()).toEqual({
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
    const { calls, run } = paseo({ all: { kind: "exited", exitCode: 0, stdout, stderr: "" } });
    expect(await endpoint(run).activity()).toEqual({
      kind: "unknown",
      reason: "Paseo activity was invalid",
    });
    expect(calls.filter((call) => call.includes("inspect"))).toEqual([]);
  });

  test.each([['{"agents":[]}'], ['[{"status":"idle"}]']])(
    "conservatively reads Paseo's dispatched list %s as unknown",
    async (stdout) => {
      const { run } = paseo({
        all: [row("one", "idle")],
        dispatched: { kind: "exited", exitCode: 0, stdout, stderr: "" },
      });
      expect(await endpoint(run).activity()).toEqual({
        kind: "unknown",
        reason: "Paseo activity was invalid",
      });
    },
  );

  test.each(["all", "dispatched"] as const)(
    "treats a failed Paseo %s list as unknown",
    async (list) => {
      const { run } = paseo({ all: [row("one", "idle")], [list]: { kind: "timed_out" } });
      expect(await endpoint(run).activity()).toEqual({
        kind: "unknown",
        reason: "Paseo activity could not be read",
      });
    },
  );

  test("bounds the whole answer by one budget, under the CLI's wait, each command given what is left", async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const scripted = paseo({
      all: [row("a1", "running"), row("b2", "running")],
      inspect: { a1: inspection("a1", []), b2: inspection("b2", []) },
    });
    const run: ProcessRunner = async (argv, timeout, options) => {
      timeouts.push(timeout);
      clock += 40_000;
      return scripted.run(argv, timeout, options);
    };
    const answer = await endpoint(
      run,
      PROJECTION,
      true,
      undefined,
      () => new Date(clock),
    ).activity();
    expect(answer).toEqual({ kind: "unknown", reason: "a Paseo agent could not be inspected" });
    expect(timeouts).toEqual([90_000, 50_000, 10_000]);
    expect(scripted.calls.map((call) => call.at(-2))).toEqual([
      "--background",
      "factory-dispatch=true",
      "a1",
    ]);
  });

  test("reads the Paseo password by its reference as root and sends setup only the reference and Paseo's bcrypt hash", async () => {
    const { calls, run } = recording();
    expect(await endpoint(run).install()).toEqual({ kind: "done" });
    expect(calls.map((call) => call.argv)).toEqual([
      [
        "/usr/bin/aws",
        "secretsmanager",
        "get-secret-value",
        "--region",
        "us-east-1",
        "--secret-id",
        ARN,
        "--query",
        "SecretString",
        "--output",
        "json",
      ],
      ["/bin/bash", join(root, SETUP)],
    ]);
    expect(calls[0]?.timeout).toBe(CREDENTIAL_COMMAND_TIMEOUT_MS);
    expect(calls[0]?.env).toEqual({
      PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/root",
      LANG: "C.UTF-8",
      AWS_PAGER: "",
    });
    const hash = sentHash(calls);
    // Paseo's own form and cost: bcryptjs's hashSync(password, 12), as `paseo daemon set-password`.
    expect(hash).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{53}$/);
    expect(compareSync(PASSWORD, hash)).toBe(true);
    expect(compareSync(`${PASSWORD}x`, hash)).toBe(false);
  });

  test("the password reaches no argument, environment or setup input, only its hash", async () => {
    const { calls, run } = recording();
    await endpoint(run).install();
    const seen = calls.flatMap((call) => [
      ...call.argv,
      ...Object.values(call.env),
      call.stdin ?? "",
    ]);
    expect(seen.filter((text) => text.includes(PASSWORD))).toEqual([]);
    expect(seen.filter((text) => text.includes("Paseo-pw"))).toEqual([]);
  });

  test("hashes the password as paseo-auth.sh sends it: final line endings dropped, all else kept", async () => {
    const { calls, run } = recording(`  ${PASSWORD} \n\n`);
    expect(await endpoint(run).install()).toEqual({ kind: "done" });
    expect(compareSync(`  ${PASSWORD} `, sentHash(calls))).toBe(true);
  });

  test("a host without a Paseo password reads no secret and sends setup two empty lines", async () => {
    const { calls, run } = recording();
    expect(await endpoint(run, WITHOUT_PASSWORD).install()).toEqual({ kind: "done" });
    expect(calls).toEqual([
      {
        argv: ["/bin/bash", join(root, SETUP)],
        timeout: expect.any(Number),
        env: expect.any(Object),
        stdin: "\n\n",
      },
    ]);
  });

  test.each([
    [
      {
        kind: "exited" as const,
        exitCode: 254,
        stdout: "",
        stderr:
          "An error occurred (AccessDeniedException) when calling the GetSecretValue operation: no",
      },
      "Paseo password: reading its secret failed (AccessDeniedException)",
    ],
    [
      { kind: "exited" as const, exitCode: 255, stdout: "", stderr: "Could not connect" },
      "Paseo password: reading its secret failed (exit status 255)",
    ],
    [{ kind: "timed_out" as const }, "Paseo password: reading its secret timed out"],
    [
      { kind: "not_found" as const },
      "Paseo password: reading its secret failed (the AWS CLI is not installed)",
    ],
    [
      { kind: "not_started" as const, code: "EACCES" },
      "Paseo password: reading its secret failed (EACCES)",
    ],
    [
      { kind: "not_started" as const, code: "not a code" },
      "Paseo password: reading its secret failed (unexpected error)",
    ],
    [
      { kind: "exited" as const, exitCode: 0, stdout: "not json", stderr: "" },
      "Paseo password: Secrets Manager's answer could not be read",
    ],
    ["", "Paseo password: its secret is empty"],
    [" \t\n", "Paseo password: its secret is empty"],
    [null, "Paseo password: its secret is empty"],
  ])(
    "a password it cannot read or use fails the install before setup runs (%#)",
    async (secret, reason) => {
      const { calls, run } = recording(secret);
      expect(await endpoint(run).install()).toEqual({ kind: "failed", reason });
      expect(calls.map((call) => call.argv[0])).toEqual(["/usr/bin/aws"]);
    },
  );

  test("restarts only through the fixed systemd action", async () => {
    const calls: readonly string[][] = [];
    const run: ProcessRunner = async (argv) => {
      (calls as string[][]).push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await endpoint(run).restart()).toEqual({ kind: "done" });
    expect(calls).toEqual([["/usr/bin/systemctl", "restart", "paseo.service"]]);
  });

  test("reloads through the active release authentication wrapper", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await endpoint(run).reload()).toEqual({ kind: "done" });
    expect(calls[0]).toContain(
      join(root, "/opt/fffactory/current/steps/control-plane/paseo-auth.sh"),
    );
    expect(calls[0]?.slice(-2)).toEqual(["daemon", "reload"]);
  });

  test("reports process failures without exposing process output", async () => {
    const exited: ProcessRunner = async () => ({
      kind: "exited",
      exitCode: 7,
      stdout: "secret output",
      stderr: "secret error",
    });
    expect(await endpoint(exited).restart()).toEqual({
      kind: "failed",
      reason: "Paseo restart exited 7",
    });
    const timedOut: ProcessRunner = async () => ({ kind: "timed_out" });
    expect(await endpoint(timedOut).reload()).toEqual({
      kind: "failed",
      reason: "Paseo reload timed_out",
    });
  });

  test("refuses an invalid projection before setup runs", async () => {
    let ran = false;
    const result = await endpoint(async () => {
      ran = true;
      return { kind: "not_found" };
    }, "{}\n").install();
    expect(result).toEqual({ kind: "failed", reason: "invalid host projection" });
    expect(ran).toBe(false);
  });

  test("refuses a projection addressed to another worker before setup runs", async () => {
    let ran = false;
    const result = await endpoint(
      async () => {
        ran = true;
        return { kind: "not_found" };
      },
      PROJECTION,
      true,
      "fff-aaaa1111-builder-2",
    ).install();
    expect(result).toEqual({ kind: "failed", reason: "host projection is for another worker" });
    expect(ran).toBe(false);
  });

  test("refuses every privileged control-plane action outside the root activator", async () => {
    let ran = false;
    const controlPlane = endpoint(
      async () => {
        ran = true;
        return { kind: "not_found" };
      },
      PROJECTION,
      false,
    );
    expect(await controlPlane.activity()).toEqual({ kind: "unknown", reason: "not root" });
    expect(await controlPlane.install()).toEqual({ kind: "failed", reason: "not root" });
    expect(await controlPlane.reload()).toEqual({ kind: "failed", reason: "not root" });
    expect(await controlPlane.restart()).toEqual({ kind: "failed", reason: "not root" });
    expect(ran).toBe(false);
  });
});
