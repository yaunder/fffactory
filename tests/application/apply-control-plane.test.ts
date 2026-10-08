import { describe, expect, test } from "bun:test";
import {
  applyControlPlane,
  type ControlPlaneStageRequest,
} from "../../src/application/apply-control-plane";
import type { AgentActivity, ControlPlane } from "../../src/application/control-plane";
import type { ChangeType } from "../../src/domain/change-classification";
import type { HostKey } from "../../src/domain/instance";
import type { WorkerIdentity } from "../../src/domain/rollout";
import { resolveWorker, type WorkerAddress } from "../../src/domain/tailnet";
import { peer, TAG } from "../support/fake-workers";
import { hostProjection } from "../../src/domain/host-projection";
import type { FactoryId, Release } from "../../src/domain/instance";

const HOSTNAME = "fff-abcd1234-builder-1";

/** A real `WorkerAddress`, made by the match rule as the stage's caller would resolve one. */
function address(): WorkerAddress {
  const resolution = resolveWorker([peer(HOSTNAME)], HOSTNAME, TAG);
  if (resolution.kind !== "found")
    throw new Error(`test worker did not resolve: ${resolution.kind}`);
  return resolution.worker;
}

const WORKER: WorkerIdentity = { key: "builder-1" as HostKey, hostname: HOSTNAME };
const PROJECTION = hostProjection("fff-abcd1234" as FactoryId, WORKER.key, "0.3.0" as Release);

/** A fake control plane that records every call and reports a fixed agent activity. */
function fakeControlPlane(activity: AgentActivity) {
  const calls: string[] = [];
  const controlPlane: ControlPlane = {
    health: async () => {
      calls.push("health");
      return "healthy";
    },
    activeAgents: async () => {
      calls.push("activeAgents");
      return activity;
    },
    install: async () => {
      calls.push("install");
      return { kind: "done" };
    },
    reload: async () => {
      calls.push("reload");
      return { kind: "done" };
    },
    restart: async () => {
      calls.push("restart");
      return { kind: "done" };
    },
  };
  return { controlPlane, calls };
}

function run(activity: AgentActivity, changes: readonly ChangeType[]) {
  const { controlPlane, calls } = fakeControlPlane(activity);
  const request: ControlPlaneStageRequest = {
    worker: WORKER,
    address: address(),
    changes,
    projection: PROJECTION,
  };
  return applyControlPlane({ controlPlane }, request).then((outcome) => ({ outcome, calls }));
}

describe("the control-plane stage", () => {
  test("an unchanged plan does not query or touch Paseo", async () => {
    const { outcome, calls } = await run({ kind: "active", count: 1 }, []);
    expect(outcome).toMatchObject({
      kind: "applied",
      restarted: false,
      reloaded: false,
    });
    expect(calls).toEqual([]);
  });

  test("applies live changes without reloading or restarting the daemon", async () => {
    const { outcome, calls } = await run({ kind: "idle" }, ["schedule", "repository"]);
    expect(outcome.kind).toBe("applied");
    expect(calls).not.toContain("reload");
    expect(calls).not.toContain("restart");
  });

  test("a reload-safe change reloads, never restarts", async () => {
    const { outcome, calls } = await run({ kind: "idle" }, ["paseo-configuration"]);
    expect(outcome.kind).toBe("applied");
    expect(calls).toContain("reload");
    expect(calls).not.toContain("restart");
  });

  test("a maintenance change with no active agents restarts the daemon", async () => {
    const { outcome, calls } = await run({ kind: "idle" }, ["paseo-package"]);
    expect(outcome.kind).toBe("applied");
    expect(calls).toContain("restart");
  });

  test("with an active agent, a maintenance change is deferred and the daemon is not restarted", async () => {
    const { outcome, calls } = await run({ kind: "active", count: 1 }, [
      "paseo-package",
      "password",
    ]);
    expect(outcome).toMatchObject({
      kind: "deferred",
      pending: ["paseo-package", "password"],
      // Worded as the pre-activation deferral words it (control plane §Pre-activation deferral).
      summary: `Maintenance (paseo-package, password) was deferred while agents may be active on ${HOSTNAME}; it stays on its complete current release`,
      nextAction: `Close the active agents on ${HOSTNAME}, then rerun \`fffactory apply\``,
    });
    expect(calls).not.toContain("restart");
  });

  test("an active agent does not block a reload-safe change from reloading", async () => {
    const { outcome, calls } = await run({ kind: "active", count: 2 }, [
      "paseo-configuration",
      "service-definition",
    ]);
    expect(outcome.kind).toBe("deferred");
    expect(calls).toContain("reload");
    expect(calls).not.toContain("restart");
  });

  test("agent activity that cannot be read defers maintenance rather than risk interrupting", async () => {
    const { outcome, calls } = await run({ kind: "unknown", reason: "paseo unreachable" }, [
      "listen-address",
    ]);
    expect(outcome.kind).toBe("deferred");
    expect(calls).not.toContain("restart");
  });

  test("a failed reload is reported, without restarting", async () => {
    const { controlPlane, calls } = (() => {
      const base = fakeControlPlane({ kind: "idle" });
      return {
        controlPlane: {
          ...base.controlPlane,
          reload: async () => ({ kind: "failed", reason: "boom" }) as const,
        },
        calls: base.calls,
      };
    })();
    const outcome = await applyControlPlane(
      { controlPlane },
      {
        worker: WORKER,
        address: address(),
        changes: ["paseo-configuration"],
        projection: PROJECTION,
      },
    );
    expect(outcome.kind).toBe("failed");
    expect(calls).not.toContain("restart");
  });
});
