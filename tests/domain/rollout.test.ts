import { describe, expect, test } from "bun:test";
import {
  type HostApplyRecord,
  INSTALL_STEPS,
  pendingSteps,
  withStep,
} from "../../src/domain/installation";
import type { HostKey } from "../../src/domain/instance";
import {
  activationOutcome,
  awaitsFirstBoot,
  FIRST_BOOT_DEADLINE_MS,
  firstBootTimedOut,
  joiningTailnet,
  rolloutContinues,
  rolloutResult,
  skipped,
  type WorkerOutcome,
} from "../../src/domain/rollout";
import { locateWorker } from "../../src/domain/status";
import { peer, peers, TAG, verification } from "../support/fake-workers";

const HOST = "fff-aaaa1111-builder-1";
const WORKER = { key: "builder-1" as HostKey, hostname: HOST };
const THEN = ", then rerun `fffactory apply`.";
const RELEASE = "0.3.0";

function record(overrides: Partial<HostApplyRecord> = {}): HostApplyRecord {
  return {
    protocol_version: 1,
    hostname: HOST,
    state: "succeeded",
    release: "0.3.0",
    configuration_sha256: "d".repeat(64),
    started_at: "2026-09-30T12:00:00.000Z",
    finished_at: "2026-09-30T12:09:00.000Z",
    steps: INSTALL_STEPS.reduce(
      (steps, { name }) => withStep(steps, name, "succeeded"),
      pendingSteps(),
    ),
    verification: verification(HOST, "pending"),
    failure: null,
    ...overrides,
  };
}

describe("an install attempt's outcome (plan-apply §The workers stage)", () => {
  test("a verified install is installed, whatever its enrollment", () => {
    expect(activationOutcome(WORKER, RELEASE, { kind: "result", result: record() })).toEqual({
      ...WORKER,
      kind: "installed",
      release: "0.3.0",
      verification: verification(HOST, "pending"),
    });
  });

  test("a failed step leaves the release active but unhealthy, naming its log", () => {
    const steps = withStep(pendingSteps(), "packages", "failed", "exited with status 1");
    const outcome = activationOutcome(WORKER, RELEASE, {
      kind: "result",
      result: record({ state: "failed", steps, verification: null }),
    });
    expect(outcome).toEqual({
      ...WORKER,
      kind: "failed",
      summary: "Step packages failed: exited with status 1; release 0.3.0 is active but unhealthy",
      nextAction:
        `Read its output with \`tailscale ssh fffactory-admin@${HOST} cat /var/log/fffactory/packages.log\` ` +
        `and fix the cause; the steps are idempotent, so rerunning repairs the worker${THEN}`,
    });
    expect(rolloutContinues(outcome)).toBe(false);
  });

  test("a failed verification names the failed checks", () => {
    const unhealthy = verification(HOST, "enrolled", {
      checks: [
        { id: "agents", status: "failed", summary: "Codex is missing" },
        { id: "toolchain", status: "passed", summary: "fine" },
      ],
    });
    const outcome = activationOutcome(WORKER, RELEASE, {
      kind: "result",
      result: record({ state: "failed", verification: unhealthy }),
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      summary: "Verification failed: Codex is missing; release 0.3.0 is active but unhealthy",
    });
  });

  test("an unfinished bootstrap is a skip; any other refusal a failure", () => {
    const refusal = (reason: "bootstrap_incomplete" | "other_host", message: string) =>
      activationOutcome(WORKER, RELEASE, {
        kind: "result",
        result: { protocol_version: 1, hostname: HOST, state: "refused", reason, message },
      });
    const waiting = refusal("bootstrap_incomplete", "Bootstrap has not finished on this worker");
    expect(waiting).toEqual({
      ...WORKER,
      kind: "skipped",
      summary: "Its bootstrap has not finished",
      nextAction: `Wait for its first boot to finish${THEN}`,
    });
    expect(rolloutContinues(waiting)).toBe(true);
    expect(refusal("other_host", "The host configuration is for another worker")).toMatchObject({
      kind: "failed",
      summary: "host apply refused: The host configuration is for another worker",
    });
  });

  test("no document, a record still running or success without verification are failures", () => {
    expect(
      activationOutcome(WORKER, RELEASE, {
        kind: "no_result",
        reason: "another activation is running",
      }),
    ).toMatchObject({
      kind: "failed",
      summary: "Installing failed: another activation is running",
    });
    expect(
      activationOutcome(WORKER, RELEASE, { kind: "result", result: record({ state: "running" }) }),
    ).toMatchObject({ kind: "failed", summary: "host apply ended before its install finished" });
    expect(
      activationOutcome(WORKER, RELEASE, {
        kind: "result",
        result: record({ verification: null }),
      }),
    ).toMatchObject({ kind: "failed", summary: "host apply reported success without verifying" });
  });

  test("an answer for another worker or release is a failure, trusting nothing else in it", () => {
    const other = activationOutcome(WORKER, RELEASE, {
      kind: "result",
      result: record({ hostname: "fff-aaaa1111-builder-2" }),
    });
    expect(other).toEqual({
      ...WORKER,
      kind: "failed",
      summary: `host apply answered as fff-aaaa1111-builder-2, not ${HOST}; nothing it reported is trusted`,
      nextAction: `Check at https://login.tailscale.com/admin/machines that the device ${HOST} is this factory's worker${THEN}`,
    });
    const refused = activationOutcome(WORKER, RELEASE, {
      kind: "result",
      result: {
        protocol_version: 1,
        hostname: "fff-aaaa1111-builder-2",
        state: "refused",
        reason: "bootstrap_incomplete",
        message: "Bootstrap has not finished on this worker",
      },
    });
    expect(refused.kind).toBe("failed");
    // Hostnames compare without case.
    expect(
      activationOutcome(WORKER, RELEASE, {
        kind: "result",
        result: record({ hostname: HOST.toUpperCase() }),
      }).kind,
    ).toBe("installed");
    expect(
      activationOutcome(WORKER, RELEASE, { kind: "result", result: record({ release: "0.2.0" }) }),
    ).toEqual({
      ...WORKER,
      kind: "failed",
      summary: "host apply installed release 0.2.0, not 0.3.0",
      nextAction: `Check the worker with \`fffactory status\`${THEN}`,
    });
  });

  test("an install still running on the worker is a skip: wait for it, then rerun", () => {
    const busy = activationOutcome(WORKER, RELEASE, {
      kind: "result",
      result: {
        protocol_version: 1,
        hostname: HOST,
        state: "refused",
        reason: "busy",
        message: "Another host apply is installing on this worker; wait for it to finish",
      },
    });
    expect(busy).toEqual({
      ...WORKER,
      kind: "skipped",
      summary: `An install is still running on ${HOST}`,
      nextAction: `Wait for it to finish (\`fffactory status\` shows when it has)${THEN}`,
    });
  });

  test("a failure outside the steps is named, the release possibly active but unhealthy", () => {
    const outcome = activationOutcome(WORKER, RELEASE, {
      kind: "result",
      result: record({
        state: "failed",
        verification: null,
        failure: "host apply failed while making release 0.3.0 active (EISDIR)",
      }),
    });
    expect(outcome).toEqual({
      ...WORKER,
      kind: "failed",
      summary:
        "host apply failed while making release 0.3.0 active (EISDIR); release 0.3.0 may be active but unhealthy",
      nextAction: `Fix what host apply names; rerunning repairs the worker${THEN}`,
    });
  });

  test("a skip keeps the verdict's next action, or points at status", () => {
    expect(skipped(WORKER, { summary: "Offline", nextAction: null }).nextAction).toBe(
      `Check the worker with \`fffactory status\`${THEN}`,
    );
  });
});

describe("the rollout's result", () => {
  const installed = activationOutcome(WORKER, RELEASE, { kind: "result", result: record() });
  const offline = skipped(WORKER, { summary: "Offline", nextAction: "x" });
  const broken: WorkerOutcome = { ...offline, kind: "failed" };
  const untouched: WorkerOutcome = { ...WORKER, kind: "not_attempted" };

  test("is installed only when every worker was, failed when one failed, else partial", () => {
    expect(rolloutResult([installed, installed])).toBe("installed");
    expect(rolloutResult([installed, offline])).toBe("partial");
    expect(rolloutResult([broken, untouched])).toBe("failed");
    expect(rolloutResult([])).toBe("installed");
  });
});

describe("a worker's first boot (plan-apply §Waiting for a new worker)", () => {
  const refused = (reason: "bootstrap_incomplete" | "busy", hostname = HOST) => ({
    kind: "result" as const,
    result: {
      protocol_version: 1 as const,
      hostname,
      state: "refused" as const,
      reason,
      message: "Bootstrap has not finished on this worker",
    },
  });

  test("lasts at most 15 minutes", () => {
    expect(FIRST_BOOT_DEADLINE_MS).toBe(15 * 60_000);
  });

  test("a worker not yet in the tailnet, offline or without Tailscale SSH is still joining", () => {
    const at = (...devices: Parameters<typeof peer>[]) =>
      locateWorker(peers(...devices.map((args) => peer(...args))), HOST, TAG);
    expect(joiningTailnet(at())).toBe(true);
    expect(joiningTailnet(at([HOST, { online: false }]))).toBe(true);
    expect(joiningTailnet(at([HOST, { sshHostKeys: [] }]))).toBe(true);
    expect(joiningTailnet(at([HOST]))).toBe(false);
    // The match rule refuses these at once: waiting never makes a guess safe.
    expect(joiningTailnet(at([HOST], [HOST]))).toBe(false);
    expect(joiningTailnet(at([HOST, { tags: [] }]))).toBe(false);
    expect(joiningTailnet(locateWorker({ kind: "daemon_unreachable" }, HOST, TAG))).toBe(false);
  });

  test("only this worker's refusal for an unfinished bootstrap is waited for", () => {
    expect(awaitsFirstBoot(WORKER, refused("bootstrap_incomplete"))).toBe(true);
    expect(awaitsFirstBoot(WORKER, refused("bootstrap_incomplete", HOST.toUpperCase()))).toBe(true);
    expect(awaitsFirstBoot(WORKER, refused("bootstrap_incomplete", "fff-aaaa1111-b"))).toBe(false);
    expect(awaitsFirstBoot(WORKER, refused("busy"))).toBe(false);
    expect(awaitsFirstBoot(WORKER, { kind: "result", result: record() })).toBe(false);
    expect(awaitsFirstBoot(WORKER, { kind: "no_result", reason: "x" })).toBe(false);
  });

  test("one that does not finish in time fails with the failed first boot's recovery", () => {
    const outcome = firstBootTimedOut(WORKER, "Its bootstrap has not finished");
    expect(outcome).toEqual({
      ...WORKER,
      kind: "failed",
      summary:
        "Its first boot did not finish within 15 min (last seen: Its bootstrap has not finished)",
      nextAction:
        "Read the bootstrap in the instance's EC2 console output, and check that tailnet policy " +
        "lets this device see the factory's tag. If the bootstrap failed, terminate the instance " +
        "in the EC2 console and wait until it is terminated; if it is still running, wait for it " +
        `to finish${THEN}`,
      beforeInstall: true,
    });
    expect(rolloutResult([outcome])).toBe("failed");
  });

  test("no install step ran on it, so the rollout goes on to the next worker", () => {
    expect(rolloutContinues(firstBootTimedOut(WORKER, "Offline in the tailnet"))).toBe(true);
    const broken = activationOutcome(WORKER, RELEASE, { kind: "no_result", reason: "x" });
    expect(rolloutContinues(broken)).toBe(false);
  });
});
