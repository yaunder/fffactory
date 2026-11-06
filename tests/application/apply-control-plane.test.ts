import { describe, expect, test } from "bun:test";
import {
  applyControlPlane,
  type ControlPlaneStageRequest,
} from "../../src/application/apply-control-plane";
import { OUTDATED_AGENTS, type AgentsObservation } from "../../src/domain/control-plane";
import { replaceOutdatedWorker } from "../../src/domain/worker-lifecycle";
import { agentsIn, fakeControlPlane } from "../support/fake-control-plane";
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

function run(agents: AgentsObservation, changes: readonly ChangeType[]) {
  const { controlPlane, calls } = fakeControlPlane("healthy", agents);
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
    const { outcome, calls } = await run(agentsIn("working"), []);
    expect(outcome).toMatchObject({
      kind: "applied",
      restarted: false,
      reloaded: false,
    });
    expect(calls).toEqual([]);
  });

  test("applies live changes without reloading or restarting the daemon", async () => {
    const { outcome, calls } = await run(agentsIn(), ["schedule", "repository"]);
    expect(outcome.kind).toBe("applied");
    expect(calls).not.toContain("reload");
    expect(calls).not.toContain("restart");
  });

  test("a reload-safe change reloads, never restarts", async () => {
    const { outcome, calls } = await run(agentsIn(), ["paseo-configuration"]);
    expect(outcome.kind).toBe("applied");
    expect(calls).toContain("reload");
    expect(calls).not.toContain("restart");
  });

  test("a maintenance change with no busy agent restarts the daemon", async () => {
    const { outcome, calls } = await run(agentsIn(), ["paseo-package"]);
    expect(outcome.kind).toBe("applied");
    expect(calls).toContain("restart");
  });

  test("a worker with only finished, failed and stopped agents is idle: maintenance restarts", async () => {
    // The busy rule (#92): only working and needs_input agents defer maintenance.
    const { outcome, calls } = await run(agentsIn("finished", "finished", "failed", "stopped"), [
      "paseo-package",
    ]);
    expect(outcome).toMatchObject({ kind: "applied", restarted: true });
    expect(calls).toEqual(["agents", "install", "restart"]);
  });

  test("with a busy agent, a maintenance change is deferred and the daemon is not restarted", async () => {
    const { outcome, calls } = await run(agentsIn("working", "needs_input", "finished"), [
      "paseo-package",
      "password",
    ]);
    expect(outcome).toMatchObject({
      kind: "deferred",
      pending: ["paseo-package", "password"],
      // Worded as the pre-activation deferral words it (control plane §Pre-activation deferral).
      summary: `Maintenance (paseo-package, password) was deferred while 1 agent is working and 1 needs input on ${HOSTNAME}; it stays on its complete current release`,
      nextAction: `Wait until no agent on ${HOSTNAME} is working or needs input, then rerun \`fffactory apply\``,
    });
    expect(calls).not.toContain("restart");
  });

  test("an agent needing input defers maintenance as a working one does", async () => {
    const { outcome } = await run(agentsIn("needs_input"), ["paseo-package"]);
    expect(outcome).toMatchObject({
      kind: "deferred",
      summary: `Maintenance (paseo-package) was deferred while 1 agent needs input on ${HOSTNAME}; it stays on its complete current release`,
    });
  });

  test("a worker on a release from before agent states defers, naming its replacement", async () => {
    const { outcome, calls } = await run({ kind: "outdated" }, ["paseo-package"]);
    expect(outcome).toMatchObject({
      kind: "deferred",
      summary: `Maintenance (paseo-package) was deferred while agents may be busy on ${HOSTNAME} (${OUTDATED_AGENTS}); it stays on its complete current release`,
      nextAction: replaceOutdatedWorker(WORKER),
    });
    expect(calls).toEqual(["agents"]);
  });

  test("a busy agent does not block a reload-safe change from reloading", async () => {
    const { outcome, calls } = await run(agentsIn("working", "working"), [
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
      const base = fakeControlPlane("healthy", agentsIn());
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
