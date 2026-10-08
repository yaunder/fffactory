import { describe, expect, test } from "bun:test";
import {
  ACTIVATION_TIMEOUT_MS,
  failedStep,
  type HostApplyRecord,
  hostApplyJson,
  INSTALL_STEPS,
  installationFields,
  installationOf,
  installState,
  parseHostApply,
  pendingSteps,
  REFUSALS,
  readActivation,
  readInstallation,
  withStep,
} from "../../src/domain/installation";
import { ENROLLMENTS, type Verification } from "../../src/domain/readiness";

const HOST = "fff-aaaa1111-builder-1";

const VERIFIED: Verification = {
  protocol_version: 1,
  hostname: HOST,
  verified_at: "2026-09-30T12:10:00.000Z",
  checks: [{ id: "toolchain", status: "passed", summary: "Every tool runs" }],
  enrollment: ENROLLMENTS.map(({ id }) => ({ id, state: "pending" })),
};

function succeeded(): string[] {
  return INSTALL_STEPS.map(({ name }) => name);
}

function allSucceeded() {
  return succeeded().reduce((steps, name) => withStep(steps, name, "succeeded"), pendingSteps());
}

function record(overrides: Partial<HostApplyRecord> = {}): HostApplyRecord {
  return {
    protocol_version: 1,
    hostname: HOST,
    state: "succeeded",
    release: "0.3.0",
    configuration_sha256: "d".repeat(64),
    started_at: "2026-09-30T12:00:00.000Z",
    finished_at: "2026-09-30T12:10:00.000Z",
    steps: allSucceeded(),
    verification: VERIFIED,
    failure: null,
    ...overrides,
  };
}

describe("the install steps (host protocol §apply)", () => {
  test("run packages, user, systemd, harness, then plugins", () => {
    expect(succeeded()).toEqual(["packages", "user", "systemd", "harness", "plugins"]);
    expect(pendingSteps().every((step) => step.status === "not_run")).toBe(true);
  });

  test("the CLI waits for every step, verification and some slack", () => {
    const steps = INSTALL_STEPS.reduce((total, step) => total + step.timeoutMs, 0);
    expect(ACTIVATION_TIMEOUT_MS).toBeGreaterThan(steps);
  });

  test("an install is running until it ends, and fails at its first failed step", () => {
    const started = withStep(pendingSteps(), "packages", "succeeded");
    expect(installState(started, null)).toBe("running");
    const broken = withStep(started, "user", "failed", "exited with status 1");
    expect(installState(broken, null)).toBe("failed");
    expect(failedStep(broken)).toEqual({
      name: "user",
      status: "failed",
      reason: "exited with status 1",
    });
    expect(installState(allSucceeded(), null)).toBe("running");
  });

  test("a failure outside the steps and checks fails it, whatever they say", () => {
    expect(
      installState(
        allSucceeded(),
        VERIFIED,
        "host apply failed while making release 0.3.0 active (EISDIR)",
      ),
    ).toBe("failed");
    expect(installState(pendingSteps(), null, "verification did not finish within 300 s")).toBe(
      "failed",
    );
  });

  test("it succeeds once verification passes every check, enrollment pending or not", () => {
    expect(installState(allSucceeded(), VERIFIED)).toBe("succeeded");
    const unhealthy = {
      ...VERIFIED,
      checks: [{ id: "agents", status: "failed" as const, summary: "Codex is missing" }],
    };
    expect(installState(allSucceeded(), unhealthy)).toBe("failed");
  });
});

function problem(document: unknown): string | undefined {
  const parsed = parseHostApply(JSON.stringify(document));
  return parsed.ok ? undefined : parsed.kind === "invalid" ? parsed.problem : parsed.kind;
}

describe("the host apply document", () => {
  test("round-trips a record and a refusal with keys in a fixed order", () => {
    for (const result of [
      record(),
      record({ state: "running", finished_at: null, verification: null }),
      record({
        state: "failed",
        verification: null,
        failure: "host apply failed while making release 0.3.0 active (EISDIR)",
      }),
      {
        protocol_version: 1 as const,
        hostname: HOST,
        state: "refused" as const,
        reason: "bootstrap_incomplete" as const,
        message: "Bootstrap has not finished on this worker",
      },
    ]) {
      const text = hostApplyJson(result);
      const parsed = parseHostApply(text);
      expect(parsed.ok && hostApplyJson(parsed.document)).toBe(text);
    }
  });

  test("names the first malformed field, never quoting it", () => {
    const valid = JSON.parse(hostApplyJson(record()));
    const cases: [unknown, string][] = [
      [{ ...valid, state: "installing" }, "state is not a known state"],
      [{ ...valid, release: "latest" }, "release is missing or malformed"],
      [{ ...valid, configuration_sha256: "x" }, "configuration_sha256 must be a SHA-256 digest"],
      [{ ...valid, started_at: 1 }, "started_at must be a time"],
      [
        { ...valid, steps: [{ name: "packages", status: "failed", reason: null }] },
        "steps[0].reason must be given exactly when the step failed",
      ],
      [
        { ...valid, steps: [{ name: "Packages", status: "succeeded", reason: null }] },
        "steps[0].name is missing or malformed",
      ],
      [
        { ...valid, verification: { ...valid.verification, verified_at: "now" } },
        "verification.verified_at must be a time",
      ],
      [{ ...valid, verification: [] }, "verification must be an object"],
      [{ ...valid, failure: "a\nb" }, "failure is missing or malformed"],
      [
        { ...valid, state: "refused", reason: "tired", message: "x" },
        "reason is not a known state",
      ],
    ];
    for (const [document, expected] of cases) expect(problem(document)).toBe(expected);
  });

  test("keys keep their order, the failure last; a record without one has none", () => {
    const text = hostApplyJson(record());
    expect(Object.keys(JSON.parse(text))).toEqual([
      "protocol_version",
      "hostname",
      "state",
      "release",
      "configuration_sha256",
      "started_at",
      "finished_at",
      "steps",
      "verification",
      "failure",
    ]);
    const { failure: _, ...older } = JSON.parse(text);
    const parsed = parseHostApply(JSON.stringify(older));
    expect(parsed.ok && parsed.document.state !== "refused" && parsed.document.failure).toBeNull();
  });

  test("an install still running is a refusal of its own", () => {
    expect(REFUSALS).toContain("busy");
    const busy = {
      protocol_version: 1 as const,
      hostname: HOST,
      state: "refused" as const,
      reason: "busy" as const,
      message: "Another host apply is installing on this worker",
    };
    const parsed = parseHostApply(hostApplyJson(busy));
    expect(parsed.ok && parsed.document).toEqual(busy);
  });
});

describe("the install as host inspect summarizes it", () => {
  test("carries when it started and why it failed outside its steps", () => {
    const failed = record({
      state: "failed",
      verification: null,
      failure: "host apply failed while making release 0.3.0 active (EISDIR)",
    });
    const installation = installationOf(failed);
    expect(installation).toMatchObject({
      state: "failed",
      started_at: "2026-09-30T12:00:00.000Z",
      failure: "host apply failed while making release 0.3.0 active (EISDIR)",
    });
    const fields = installationFields(installation);
    expect(Object.keys(fields)).toEqual([
      "state",
      "release",
      "configuration_sha256",
      "failed_step",
      "started_at",
      "finished_at",
      "verification",
      "failure",
    ]);
    expect(readInstallation(JSON.parse(JSON.stringify(fields)))).toEqual(installation);
  });
});

describe("reading the activator's answer", () => {
  test("host apply's document is the answer, whatever the exit status", () => {
    const failed = record({
      state: "failed",
      steps: withStep(pendingSteps(), "packages", "failed", "exited with status 1"),
      verification: null,
    });
    expect(readActivation(1, hostApplyJson(failed))).toEqual({ kind: "result", result: failed });
  });

  test("without one, the exit status says what the activator refused", () => {
    expect(readActivation(65, "")).toEqual({
      kind: "no_result",
      reason:
        "the worker refused the release tarball: it did not pass the activator's digest and content checks",
    });
    expect(readActivation(75, "").kind === "no_result" && readActivation(75, "")).toMatchObject({
      reason: "another activation is running on the worker",
    });
    expect(readActivation(3, "")).toEqual({
      kind: "no_result",
      reason: "the activator exited with status 3",
    });
  });

  test("output that is not a document, or another major version, is never quoted", () => {
    expect(readActivation(0, "sudo: a terminal is required")).toEqual({
      kind: "no_result",
      reason: "host apply's answer is not a host apply document: the output is not JSON",
    });
    expect(readActivation(0, JSON.stringify({ protocol_version: 2 }))).toEqual({
      kind: "no_result",
      reason: "host apply answered in host protocol version 2; this fffactory speaks version 1",
    });
  });
});
