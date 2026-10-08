import { describe, expect, test } from "bun:test";
import type { ControlPlaneOutcome } from "../../src/application/apply-control-plane";
import type { DispatchOutcome } from "../../src/application/apply-dispatch";
import type { RepositoryOutcome } from "../../src/application/apply-repositories";
import { verifyFactory, type VerifyFactoryRequest } from "../../src/application/verify-factory";
import type { HostKey } from "../../src/domain/instance";
import type { Verification } from "../../src/domain/readiness";
import type { WorkerIdentity, WorkerOutcome } from "../../src/domain/rollout";

function identity(key: string): WorkerIdentity {
  return { key: key as HostKey, hostname: `fff-abcd1234-${key}` };
}

const VERIFIED: Verification = {
  protocol_version: 1,
  hostname: "fff-abcd1234-builder-1",
  verified_at: "2026-01-01T00:00:00.000Z",
  checks: [],
  enrollment: [{ id: "github", state: "enrolled" }],
};

function installed(key: string): WorkerOutcome {
  return { ...identity(key), kind: "installed", release: "0.3.0", verification: VERIFIED };
}

function synchronized(key: string): RepositoryOutcome {
  return { ...identity(key), kind: "synchronized", unmanaged: [] };
}

function applied(key: string): ControlPlaneOutcome {
  return { ...identity(key), kind: "applied", live: [], reloaded: false, restarted: false };
}

function activeDispatch(key: string): DispatchOutcome {
  return { ...identity(key), kind: "active", changed: false, gates: [] };
}

function request(overrides: Partial<VerifyFactoryRequest>): VerifyFactoryRequest {
  return {
    workers: [installed("builder-1")],
    repositories: [synchronized("builder-1")],
    controlPlane: [applied("builder-1")],
    dispatch: [activeDispatch("builder-1")],
    ...overrides,
  };
}

describe("end-to-end verification (dispatch §End-to-end verification)", () => {
  test("a fully healthy, dispatching worker verifies the factory ready", () => {
    const verification = verifyFactory(request({}));
    expect(verification.ready).toBe(true);
    const worker = verification.workers[0];
    expect(worker).toMatchObject({
      release: "healthy",
      repositories: "synchronized",
      controlPlane: "applied",
      dispatch: "active",
      ready: true,
    });
  });

  test("a worker whose dispatch is pending is software-ready but the factory is not yet ready", () => {
    const pending: DispatchOutcome = {
      ...identity("builder-1"),
      kind: "pending",
      gates: [],
      blocking: [],
      summary: "Dispatch: pending",
      nextActions: ["enroll GitHub"],
    };
    const verification = verifyFactory(request({ dispatch: [pending] }));
    expect(verification.ready).toBe(false);
    expect(verification.workers[0]?.dispatch).toBe("pending");
    expect(verification.workers[0]?.details).toContain("enroll GitHub");
  });

  test("an unhealthy worker fails the factory verification", () => {
    const failed: WorkerOutcome = {
      ...identity("builder-1"),
      kind: "failed",
      summary: "Verification failed",
      nextAction: "Fix it",
    };
    const verification = verifyFactory(request({ workers: [failed] }));
    expect(verification.ready).toBe(false);
    expect(verification.workers[0]?.release).toBe("unhealthy");
  });

  test("a deferred control plane leaves the factory not ready", () => {
    const deferred: ControlPlaneOutcome = {
      ...identity("builder-1"),
      kind: "deferred",
      pending: ["paseo-package"],
      reloaded: false,
      summary: "Maintenance deferred",
      nextAction: "Close agents",
    };
    const verification = verifyFactory(request({ controlPlane: [deferred] }));
    expect(verification.ready).toBe(false);
    expect(verification.workers[0]?.controlPlane).toBe("deferred");
  });

  test("a worker whose maintenance was deferred stays on its release, named with the deferral's next action, never absent", () => {
    const hostname = "fff-abcd1234-builder-1";
    const close = `Close the active agents on ${hostname}, then rerun \`fffactory apply\``;
    const deferral = "Paseo maintenance is deferred while agents may be active";
    const skipped: WorkerOutcome = {
      ...identity("builder-1"),
      kind: "skipped",
      summary: deferral,
      nextAction: close,
    };
    const deferred: ControlPlaneOutcome = {
      ...identity("builder-1"),
      kind: "deferred",
      pending: ["password"],
      reloaded: false,
      summary: "Maintenance (password) was deferred while agents may be active",
      nextAction: close,
    };
    const dispatch: DispatchOutcome = {
      ...identity("builder-1"),
      kind: "skipped",
      reason: "deferred",
      summary: deferral,
      nextAction: close,
    };
    const verification = verifyFactory(
      request({ workers: [skipped], controlPlane: [deferred], dispatch: [dispatch] }),
    );
    expect(verification.ready).toBe(false);
    expect(verification.workers[0]).toMatchObject({
      release: "skipped",
      controlPlane: "deferred",
      dispatch: "skipped",
      ready: false,
      details: [
        `Release left as is: ${deferral}`,
        "Control plane is deferred",
        "Dispatch left as is",
        close,
      ],
      summary: `${hostname} is not ready: Release left as is: ${deferral}; Control plane is deferred; Dispatch left as is; ${close}`,
    });
  });

  test("an installed worker whose dispatch was skipped names the skip's reason and next action", () => {
    const next =
      "Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.";
    const dispatch: DispatchOutcome = {
      ...identity("builder-1"),
      kind: "skipped",
      reason: "unreachable",
      summary: "Offline in the tailnet",
      nextAction: next,
    };
    const verification = verifyFactory(request({ dispatch: [dispatch] }));
    expect(verification.workers[0]).toMatchObject({
      release: "healthy",
      dispatch: "skipped",
      ready: false,
      details: ["Dispatch left as is: Offline in the tailnet", next],
    });
  });

  test("dispatch not requested does not hold the factory back", () => {
    const notRequested: DispatchOutcome = { ...identity("builder-1"), kind: "not_requested" };
    const verification = verifyFactory(request({ dispatch: [notRequested] }));
    expect(verification.ready).toBe(true);
    expect(verification.workers[0]?.dispatch).toBe("not_requested");
  });

  test("a worker missing from a later stage is reported unknown, not ready", () => {
    const verification = verifyFactory(
      request({ repositories: [], controlPlane: [], dispatch: [] }),
    );
    expect(verification.ready).toBe(false);
    expect(verification.workers[0]).toMatchObject({
      repositories: "unknown",
      controlPlane: "unknown",
      dispatch: "not_requested",
    });
  });

  test("verifies every declared worker, joining each stage by host", () => {
    const verification = verifyFactory({
      workers: [installed("builder-1"), installed("builder-2")],
      repositories: [synchronized("builder-1"), synchronized("builder-2")],
      controlPlane: [applied("builder-1"), applied("builder-2")],
      dispatch: [activeDispatch("builder-1"), activeDispatch("builder-2")],
    });
    expect(verification.workers.map((worker) => worker.key as string)).toEqual([
      "builder-1",
      "builder-2",
    ]);
    expect(verification.ready).toBe(true);
  });
});
