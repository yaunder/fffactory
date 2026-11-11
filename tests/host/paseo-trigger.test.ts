/**
 * The Paseo dispatch trigger (`docs/specs/dispatch-trigger.md` §The trigger's contract) over a
 * scripted runner: the exact reconciler command it runs as `factory`, the only place
 * `PASEO_HOME` and `FACTORY_PASEO_BIN` are set, and how the reconciler's answer
 * (`{host, status, schedule_id, desired}`, as `dispatch-schedule.sh` prints it) becomes the
 * trigger's inspection.
 */
import { describe, expect, test } from "bun:test";
import { dispatchProjection } from "../../src/domain/dispatch-projection";
import type { ApplySystem } from "../../src/host/apply";
import { dispatchTrigger } from "../../src/host/dispatch-trigger";
import { paseoTrigger } from "../../src/host/paseo-trigger";
import type {
  ProcessOptions,
  ProcessOutcome,
  ProcessRunner,
} from "../../src/infrastructure/local-tool-probe";
import { applyingSystem, WORKER_HOSTNAME } from "./worker-scenarios";

const ROOT = "/worker";
const TIMEOUT_MS = 15 * 60_000;
const SETTINGS = {
  enabled: true,
  cron: "*/17 * * * *",
  timezone: "America/Chicago",
  provider: "codex",
  model: "configured-model",
  mode: "default",
  cwd: "/home/factory",
} as const;
const ACTIVE = dispatchProjection(WORKER_HOSTNAME, SETTINGS, true, []);
const PENDING = dispatchProjection(WORKER_HOSTNAME, SETTINGS, false, ["ffflow_adoption"]);

/** The reconciler's command for `mode`, byte for byte as the endpoint ran it before the seam. */
const reconciler = (mode: "--apply" | "--check") => [
  "/usr/sbin/runuser",
  "-u",
  "factory",
  "--",
  "/usr/bin/env",
  "-i",
  "HOME=/home/factory",
  "PASEO_HOME=/home/factory/.paseo",
  "PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "LANG=C.UTF-8",
  "FACTORY_PASEO_BIN=/worker/opt/fffactory/current/steps/control-plane/paseo-auth.sh",
  "/worker/opt/fffactory/current/steps/dispatch/dispatch-schedule.sh",
  mode,
  "--projection",
  "/worker/var/lib/fffactory/dispatch.json",
];
const ROOT_OPTIONS: ProcessOptions = {
  cwd: "/",
  env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
};

/** What `dispatch-schedule.sh` prints as its last line, its `desired` abridged. */
function answer(status: string, scheduleId: string | null, host = WORKER_HOSTNAME): string {
  return `${JSON.stringify({ host, status, schedule_id: scheduleId, desired: { enabled: true } })}\n`;
}
const exited = (exitCode: number, stdout = ""): ProcessOutcome => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr: exitCode === 0 ? "" : "factory dispatch schedule: schedule differs from declared state\n",
});

interface Call {
  readonly argv: readonly string[];
  readonly timeout: number;
  readonly options: ProcessOptions | undefined;
}

/** A trigger whose reconciler ends as `outcome`, and every command it ran. */
function scripted(outcome: ProcessOutcome) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (argv, timeout, options) => {
    calls.push({ argv: [...argv], timeout, options });
    return outcome;
  };
  const system: ApplySystem = applyingSystem(ROOT, run);
  return { trigger: paseoTrigger(system, TIMEOUT_MS), calls };
}

describe("the Paseo trigger's reconciler command", () => {
  test("inspect runs the active release's reconciler with --check, as factory, in its environment", async () => {
    const { trigger, calls } = scripted(exited(0, answer("active", "schedule-1")));
    await trigger.inspect();
    expect(calls).toEqual([
      { argv: reconciler("--check"), timeout: TIMEOUT_MS, options: ROOT_OPTIONS },
    ]);
  });

  test("reconcile runs it with --apply over the persisted projection, the same way", async () => {
    const { trigger, calls } = scripted(exited(0, answer("active", "schedule-1")));
    await trigger.reconcile(ACTIVE);
    expect(calls).toEqual([
      { argv: reconciler("--apply"), timeout: TIMEOUT_MS, options: ROOT_OPTIONS },
    ]);
  });

  test("PASEO_HOME and FACTORY_PASEO_BIN reach the reconciler's environment, nothing of root's", async () => {
    const { trigger, calls } = scripted(exited(0, answer("absent", null)));
    await trigger.reconcile(PENDING);
    await trigger.inspect();
    for (const { argv } of calls) {
      const environment = argv.slice(argv.indexOf("-i") + 1, argv.indexOf("-i") + 6);
      expect(environment.filter((item) => item.startsWith("PASEO_HOME="))).toEqual([
        "PASEO_HOME=/home/factory/.paseo",
      ]);
      expect(environment.filter((item) => item.startsWith("FACTORY_PASEO_BIN="))).toEqual([
        "FACTORY_PASEO_BIN=/worker/opt/fffactory/current/steps/control-plane/paseo-auth.sh",
      ]);
      expect(argv.some((item) => item.startsWith("HOME=/root"))).toBe(false);
    }
  });

  test("the one selection point chooses the Paseo trigger", async () => {
    const calls: string[][] = [];
    const system = applyingSystem(ROOT, async (argv) => {
      calls.push([...argv]);
      return exited(0, answer("active", "schedule-1"));
    });
    await dispatchTrigger(system, TIMEOUT_MS).inspect();
    expect(calls).toEqual([reconciler("--check")]);
  });
});

describe("the reconciler's answer as the trigger's inspection", () => {
  test.each([
    [
      "present and matching",
      exited(0, answer("active", "schedule-1")),
      { state: "active", identity: "schedule-1" },
    ],
    ["absent as declared", exited(0, answer("absent", null)), { state: "absent", identity: null }],
    [
      "drifted, with the schedule it found",
      exited(1, answer("drift", "schedule-1")),
      { state: "drift", identity: "schedule-1" },
    ],
    [
      "drifted, with none found",
      exited(1, answer("drift", null)),
      { state: "drift", identity: null },
    ],
    [
      "an answer on the last line, after other output",
      exited(0, `factory dispatch schedule: updated\n${answer("active", "schedule-1")}\n`),
      { state: "active", identity: "schedule-1" },
    ],
  ])("inspect: %s", async (_name, outcome, expected) => {
    expect(await scripted(outcome).trigger.inspect()).toEqual(expected as never);
  });

  test.each([
    [
      "a failure before any answer",
      exited(1),
      "the dispatch schedule's check exited with status 1",
    ],
    ["a timeout", { kind: "timed_out" } as const, "the dispatch schedule's check timed out"],
    [
      "a reconciler that cannot start",
      { kind: "not_found" } as const,
      "the dispatch schedule's check could not be started (ENOENT)",
    ],
    ["no output", exited(0), "the dispatch schedule's answer was invalid"],
    [
      "text that is not JSON",
      exited(0, "factory dispatch schedule: updated\n"),
      "the dispatch schedule's answer was invalid",
    ],
    [
      "an answer followed by a last line that is not one",
      exited(0, `${answer("active", "schedule-1")}factory dispatch schedule: updated\n`),
      "the dispatch schedule's answer was invalid",
    ],
    [
      "a JSON object with no status",
      exited(0, "{}\n"),
      "the dispatch schedule's answer was invalid",
    ],
    [
      "a JSON array",
      exited(
        0,
        `${JSON.stringify([{ host: WORKER_HOSTNAME, status: "active", schedule_id: "schedule-1" }])}\n`,
      ),
      "the dispatch schedule's answer was invalid",
    ],
    ["JSON null", exited(0, "null\n"), "the dispatch schedule's answer was invalid"],
    [
      "an unknown status",
      exited(0, answer("paused", "schedule-1")),
      "the dispatch schedule's answer was invalid",
    ],
    [
      "a status its exit disagrees with",
      exited(0, answer("drift", "schedule-1")),
      "the dispatch schedule's answer was invalid",
    ],
    [
      "a match it exited failing on",
      exited(1, answer("active", "schedule-1")),
      "the dispatch schedule's answer was invalid",
    ],
    [
      "a schedule ID that is not text",
      exited(0, `${JSON.stringify({ host: WORKER_HOSTNAME, status: "active", schedule_id: 7 })}\n`),
      "the dispatch schedule's answer was invalid",
    ],
    [
      "no host",
      exited(0, `${JSON.stringify({ status: "active", schedule_id: "schedule-1" })}\n`),
      "the dispatch schedule's answer was invalid",
    ],
  ])("inspect: %s is unknown, in fffactory's words", async (_name, outcome, reason) => {
    expect(await scripted(outcome).trigger.inspect()).toEqual({ state: "unknown", reason });
  });

  test("reconcile answers the trigger as the reconciler left it", async () => {
    expect(
      await scripted(exited(0, answer("active", "schedule-2"))).trigger.reconcile(ACTIVE),
    ).toEqual({
      state: "active",
      identity: "schedule-2",
    });
    expect(await scripted(exited(0, answer("absent", null))).trigger.reconcile(PENDING)).toEqual({
      state: "absent",
      identity: null,
    });
    expect(
      await scripted(exited(1, answer("drift", "schedule-2"))).trigger.reconcile(ACTIVE),
    ).toEqual({
      state: "drift",
      identity: "schedule-2",
    });
    expect(
      await scripted(
        exited(0, `factory dispatch schedule: created\n${answer("active", "schedule-3")}`),
      ).trigger.reconcile(ACTIVE),
    ).toEqual({ state: "active", identity: "schedule-3" });
    expect(await scripted(exited(1)).trigger.reconcile(ACTIVE)).toEqual({
      state: "unknown",
      reason: "the dispatch schedule's reconcile exited with status 1",
    });
  });

  test.each([
    ["another worker's", ACTIVE, answer("active", "schedule-1", "fff-aaaa1111-builder-2")],
    ["an inactive projection's, for an active one", ACTIVE, answer("absent", null)],
    ["an active projection's, for an inactive one", PENDING, answer("active", "schedule-1")],
  ])("reconcile: an answer for %s is unknown", async (_name, projection, stdout) => {
    expect(await scripted(exited(0, stdout)).trigger.reconcile(projection)).toEqual({
      state: "unknown",
      reason: "the dispatch schedule answered for another projection",
    });
  });

  test("no reconciler output reaches an inspection", async () => {
    const outcome: ProcessOutcome = {
      kind: "exited",
      exitCode: 1,
      stdout: "",
      stderr: "factory dispatch schedule: could not list Paseo schedules\n",
    };
    const { trigger } = scripted(outcome);
    expect(JSON.stringify(await trigger.inspect())).not.toContain("Paseo");
    expect(JSON.stringify(await trigger.reconcile(ACTIVE))).not.toContain("Paseo");
  });
});
