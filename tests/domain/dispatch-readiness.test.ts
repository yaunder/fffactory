import { describe, expect, test } from "bun:test";
import {
  type AdoptionState,
  describeDispatch,
  DISPATCH_GATES,
  type DispatchGate,
  type DispatchGateInputs,
  dispatchNextActions,
  dispatchReadiness,
  dispatchState,
  evaluateDispatchGates,
  githubCredential,
  type PaseoHealth,
} from "../../src/domain/dispatch-readiness";
import { enrollmentNextAction, type Verification } from "../../src/domain/readiness";
import { HOST_PROTOCOL_VERSION } from "../../src/domain/protocol-fields";

const HOSTNAME = "fff-abcd1234-builder-1";

/** Inputs where every dispatch gate passes. */
const PASSING: DispatchGateInputs = {
  releaseHealthy: true,
  githubCredential: "enrolled",
  repositorySync: "ready",
  ffflowAdoption: "passed",
  paseoHealth: "healthy",
};

/** The single input that makes `gate` fail, leaving the others passing. */
const FAILS: Readonly<Record<DispatchGate, Partial<DispatchGateInputs>>> = {
  worker_release: { releaseHealthy: false },
  github_credential: { githubCredential: "pending" },
  repository_sync: { repositorySync: "pending" },
  ffflow_adoption: { ffflowAdoption: "failed" as AdoptionState },
  paseo_health: { paseoHealth: "unhealthy" as PaseoHealth },
};

function verification(enrollment: Verification["enrollment"]): Verification {
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname: HOSTNAME,
    verified_at: "2026-01-01T00:00:00.000Z",
    checks: [],
    enrollment,
  };
}

describe("dispatch readiness gates (dispatch §Gate matrix)", () => {
  test("every gate passing makes requested dispatch active", () => {
    const state = dispatchState(true, PASSING, HOSTNAME);
    expect(state.kind).toBe("active");
    expect(dispatchReadiness(state)).toBe("active");
  });

  test.each([...DISPATCH_GATES])("gate %s independently keeps dispatch inactive", (gate) => {
    const state = dispatchState(true, { ...PASSING, ...FAILS[gate] }, HOSTNAME);
    expect(state.kind).toBe("pending");
    expect(dispatchReadiness(state)).toBe("pending");
    if (state.kind !== "pending") throw new Error("expected pending");
    expect(state.blocking.map((result) => result.gate)).toEqual([gate]);
    const blocked = state.blocking[0];
    expect(blocked?.passed).toBe(false);
    expect(blocked?.nextAction).not.toBeNull();
  });

  test("dispatch not requested in factory.json is never evaluated", () => {
    const state = dispatchState(false, { ...PASSING, releaseHealthy: false }, HOSTNAME);
    expect(state.kind).toBe("not_requested");
    expect(dispatchReadiness(state)).toBe("not_requested");
    expect(dispatchNextActions(state)).toEqual([]);
  });

  test("a missing GitHub credential keeps dispatch inactive and surfaces the enrollment next action", () => {
    const state = dispatchState(true, { ...PASSING, githubCredential: "pending" }, HOSTNAME);
    expect(state.kind).toBe("pending");
    const lines = dispatchNextActions(state);
    const expected = enrollmentNextAction("github", HOSTNAME);
    const line = lines.find((entry) => entry.includes("GitHub"));
    expect(line).toBeDefined();
    expect(line).toContain(expected.login);
    for (const command of expected.commands) expect(line).toContain(command);
  });

  test("an unknown GitHub credential also blocks dispatch", () => {
    const state = dispatchState(true, { ...PASSING, githubCredential: "unknown" }, HOSTNAME);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") throw new Error("expected pending");
    expect(state.blocking.map((result) => result.gate)).toEqual(["github_credential"]);
  });

  test("multiple failing gates all block, in gate order", () => {
    const state = dispatchState(
      true,
      { ...PASSING, releaseHealthy: false, paseoHealth: "unknown" },
      HOSTNAME,
    );
    if (state.kind !== "pending") throw new Error("expected pending");
    expect(state.blocking.map((result) => result.gate)).toEqual(["worker_release", "paseo_health"]);
  });

  test("evaluateDispatchGates reports every gate, in order", () => {
    const results = evaluateDispatchGates(PASSING, HOSTNAME);
    expect(results.map((result) => result.gate)).toEqual([...DISPATCH_GATES]);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.every((result) => result.nextAction === null)).toBe(true);
  });

  test("describeDispatch names the state", () => {
    expect(describeDispatch(dispatchState(false, PASSING, HOSTNAME))).toContain("not requested");
    expect(describeDispatch(dispatchState(true, PASSING, HOSTNAME))).toContain("active");
    expect(
      describeDispatch(dispatchState(true, { ...PASSING, repositorySync: "pending" }, HOSTNAME)),
    ).toContain("pending");
  });
});

describe("githubCredential (dispatch §Required credentials)", () => {
  test("reads the GitHub enrollment state the worker verified", () => {
    expect(githubCredential(verification([{ id: "github", state: "enrolled" }]))).toBe("enrolled");
    expect(githubCredential(verification([{ id: "github", state: "pending" }]))).toBe("pending");
  });

  test("is unknown without a verification or a GitHub entry", () => {
    expect(githubCredential(null)).toBe("unknown");
    expect(githubCredential(verification([{ id: "openai", state: "enrolled" }]))).toBe("unknown");
  });
});
