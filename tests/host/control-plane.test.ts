/**
 * The worker's control-plane endpoint (`docs/specs/control-plane.md` §Worker protocol and
 * privilege boundary) and `host agents`, over a fake `ExecutionBackend`: what the endpoint
 * decides itself (privilege, the projection, the password read by its reference) and that it
 * hands everything else to the backend from the selection point. What the Paseo backend runs is
 * `paseo-backend.test.ts`'s.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneAction, WorkerAgents } from "../../src/domain/control-plane";
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
import { type BackendAnswers, fakeExecutionBackend } from "../support/fake-execution-backend";
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
const PASSWORD = "Paseo-pw 7f3e9aé";
/** The activity's budget, under the CLI's two-minute wait for its answer. */
const ACTIVITY_BUDGET_MS = 90_000;
/** Each maintenance action's. */
const ACTION_BUDGET_MS = 2 * 60_000;
const AGENTS: WorkerAgents = {
  kind: "listed",
  agents: [
    { id: "a1", state: "needs_input", dispatched: true },
    { id: "b2", state: "finished", dispatched: false },
  ],
};

interface Call {
  readonly argv: readonly string[];
  readonly timeout: number;
  readonly env: Readonly<Record<string, string>>;
}

/** Answers Secrets Manager with `secret` (its JSON `SecretString`); anything else fails the test. */
function secretsManager(secret: ProcessOutcome | string | null = PASSWORD) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (argv, timeout, options?: ProcessOptions) => {
    calls.push({ argv: [...argv], timeout, env: { ...(options?.env ?? {}) } });
    if (argv[0] !== "/usr/bin/aws") throw new Error(`unexpected command: ${argv.join(" ")}`);
    if (typeof secret === "object" && secret !== null) return secret;
    return { kind: "exited", exitCode: 0, stdout: `${JSON.stringify(secret)}\n`, stderr: "" };
  };
  return { calls, run };
}

/** A runner that fails the test if the endpoint runs anything itself. */
const nothing: ProcessRunner = async (argv) => {
  throw new Error(`unexpected command: ${argv.join(" ")}`);
};

function endpoint(
  options: {
    run?: ProcessRunner;
    input?: string;
    isRoot?: boolean;
    hostname?: string;
    answers?: BackendAnswers;
  } = {},
) {
  const fake = fakeExecutionBackend(options.answers);
  const worker: ApplySystem = {
    ...system(root),
    run: options.run ?? nothing,
    now: () => new Date(0),
    isRoot: () => options.isRoot ?? true,
    hostname: () => options.hostname ?? "fff-aaaa1111-builder-1",
    readInput: async () => options.input ?? hostProjectionJson(PROJECTION),
    release: "0.3.0" as Release,
    lock: async () => ({ release: () => {} }),
  };
  return { ...fake, controlPlane: workerControlPlane(worker, fake.select) };
}

describe("host agents, the dispatcher's read of the backend's agents", () => {
  test("reads the agents from the backend the selection point chose, within the activity's budget", async () => {
    const { controlPlane, calls, budgets } = endpoint({
      isRoot: false,
      answers: { agents: AGENTS },
    });
    expect(await controlPlane.agents()).toEqual(AGENTS);
    expect(calls).toEqual([{ method: "agents" }]);
    expect(budgets).toEqual([ACTIVITY_BUDGET_MS]);
  });

  test("passes the backend's unknown agents on as they are", async () => {
    const unknown: WorkerAgents = { kind: "unknown", reason: "Paseo activity could not be read" };
    const { controlPlane } = endpoint({ isRoot: false, answers: { agents: unknown } });
    expect(await controlPlane.agents()).toEqual(unknown);
  });

  test("refuses to run as root, where the backend's files would become root's", async () => {
    const { controlPlane, calls, budgets } = endpoint({ isRoot: true });
    expect(await controlPlane.agents()).toEqual({ kind: "unknown", reason: "run as root" });
    expect({ calls, budgets }).toEqual({ calls: [], budgets: [] });
  });
});

describe("the worker control-plane endpoint", () => {
  test("activity reads the agents from the backend as root, within the activity's budget", async () => {
    const { controlPlane, calls, budgets } = endpoint({ answers: { agents: AGENTS } });
    expect(await controlPlane.activity()).toEqual(AGENTS);
    expect(calls).toEqual([{ method: "agents" }]);
    expect(budgets).toEqual([ACTIVITY_BUDGET_MS]);
  });

  test("reads the password by its reference as root and gives the backend the projection and the password", async () => {
    const secrets = secretsManager();
    const { controlPlane, calls, budgets } = endpoint({ run: secrets.run });
    expect(await controlPlane.install()).toEqual({ kind: "done" });
    expect(secrets.calls).toEqual([
      {
        argv: [
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
        timeout: CREDENTIAL_COMMAND_TIMEOUT_MS,
        env: {
          PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          HOME: "/root",
          LANG: "C.UTF-8",
          AWS_PAGER: "",
        },
      },
    ]);
    expect(calls).toEqual([
      { method: "install", projection: PROJECTION, password: expect.anything() },
    ]);
    const [call] = calls;
    expect(call?.method === "install" ? call.password?.reveal() : undefined).toBe(PASSWORD);
    expect(budgets).toEqual([ACTION_BUDGET_MS]);
  });

  test("gives the backend the password as stored: no line ending dropped, nothing judged", async () => {
    const secrets = secretsManager(`  ${PASSWORD} \n\n`);
    const { controlPlane, calls } = endpoint({ run: secrets.run });
    await controlPlane.install();
    const [call] = calls;
    expect(call?.method === "install" ? call.password?.reveal() : undefined).toBe(
      `  ${PASSWORD} \n\n`,
    );
  });

  test("a host without a password reference reads no secret and gives the backend none", async () => {
    const { controlPlane, calls } = endpoint({ input: hostProjectionJson(WITHOUT_PASSWORD) });
    expect(await controlPlane.install()).toEqual({ kind: "done" });
    expect(calls).toEqual([
      { method: "install", projection: WITHOUT_PASSWORD, password: undefined },
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
  ])(
    "a password it cannot read fails the install before the backend is asked (%#)",
    async (secret, reason) => {
      const secrets = secretsManager(secret);
      const { controlPlane, calls, budgets } = endpoint({ run: secrets.run });
      expect(await controlPlane.install()).toEqual({ kind: "failed", reason });
      expect({ calls, budgets }).toEqual({ calls: [], budgets: [] });
    },
  );

  test.each(["reload", "restart"] as const)(
    "%s is the backend's, within the action's budget",
    async (action) => {
      const { controlPlane, calls, budgets } = endpoint();
      expect(await controlPlane[action]()).toEqual({ kind: "done" });
      expect(calls).toEqual([{ method: action }]);
      expect(budgets).toEqual([ACTION_BUDGET_MS]);
    },
  );

  test.each(["install", "reload", "restart"] as const)(
    "passes the backend's failed %s on as it is",
    async (action) => {
      const failed: ControlPlaneAction = { kind: "failed", reason: "Paseo setup exited 1" };
      const { controlPlane } = endpoint({
        input: hostProjectionJson(WITHOUT_PASSWORD),
        answers: { [action]: failed },
      });
      expect(await controlPlane[action]()).toEqual(failed);
    },
  );

  test("refuses an invalid projection before anything runs", async () => {
    const { controlPlane, calls } = endpoint({ input: "{}\n" });
    expect(await controlPlane.install()).toEqual({
      kind: "failed",
      reason: "invalid host projection",
    });
    expect(calls).toEqual([]);
  });

  test("refuses a projection addressed to another worker before anything runs", async () => {
    const { controlPlane, calls } = endpoint({ hostname: "fff-aaaa1111-builder-2" });
    expect(await controlPlane.install()).toEqual({
      kind: "failed",
      reason: "host projection is for another worker",
    });
    expect(calls).toEqual([]);
  });

  test("refuses every privileged control-plane action outside the root activator", async () => {
    const { controlPlane, calls, budgets } = endpoint({ isRoot: false });
    expect(await controlPlane.activity()).toEqual({ kind: "unknown", reason: "not root" });
    expect(await controlPlane.install()).toEqual({ kind: "failed", reason: "not root" });
    expect(await controlPlane.reload()).toEqual({ kind: "failed", reason: "not root" });
    expect(await controlPlane.restart()).toEqual({ kind: "failed", reason: "not root" });
    expect({ calls, budgets }).toEqual({ calls: [], budgets: [] });
  });
});
