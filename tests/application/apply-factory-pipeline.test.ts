/**
 * The full apply pipeline wired into applyFactory: workers → repositories → control-plane →
 * dispatch → end-to-end verify (docs/specs/dispatch.md). The control-plane stage is independent;
 * the dispatch stages run when the workflow-queue port is also wired.
 */
import { describe, expect, test } from "bun:test";
import { applyFactory, type FactoryApplyRequest } from "../../src/application/apply-factory";
import type { ControlPlane } from "../../src/application/control-plane";
import type { WorkflowQueue } from "../../src/application/workflow-queue";
import type { Approval } from "../../src/application/approval";
import { factoryStatus } from "../../src/application/status";
import { planFactory } from "../../src/application/plan-factory";
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import type { HostInspection } from "../../src/domain/host-protocol";
import type { FactoryInstance, HostKey } from "../../src/domain/instance";
import { sha256Text } from "../../src/infrastructure/release-tarball";
import { fakeCallerIdentity } from "../support/doctor-fakes";
import { fakeControlPlane, fakeWorkflowQueue as fakeQueue } from "../support/fake-control-plane";
import {
  appliedRecord,
  fakeMachineInventory,
  inspection,
  installableWorker,
  machine,
  peer,
  peers,
  verification,
} from "../support/fake-workers";
import {
  currentWorker,
  declaring,
  FACTORY,
  NOW,
  factory,
  PASEO_PASSWORD_ARN,
  planRequest,
  RELEASE,
  requestingDispatch,
  WORKER_TAG,
  workerFleet,
} from "../support/factory-world";

/**
 * An enrolled worker fleet: builder-1 installs with every account enrolled, and already runs the
 * pinned release holding `held`, the host projection factory.json gives it by default.
 */
function enrolledFleet(held: HostInspection = currentWorker("builder-1")) {
  const name = `${FACTORY}-builder-1`;
  const worker = installableWorker(
    appliedRecord(name, "0.3.0", { verification: verification(name, "enrolled") }),
    { inspection: held },
  );
  return { ...workerFleet(["builder-1"], { [name]: worker }), worker };
}

const B1 = `${FACTORY}-builder-1`;
/** The workers stage's skip of a worker whose Paseo maintenance it deferred. */
const DEFERRED = "Paseo maintenance is deferred while agents may be active";
const CLOSE_AGENTS = `Close the active agents on ${B1}, then rerun \`fffactory apply\``;

function staleFleet() {
  const name = `${FACTORY}-builder-1`;
  return workerFleet(["builder-1"], {
    [name]: installableWorker(appliedRecord(name), {
      inspection: inspection(
        name,
        {
          release: { state: "active", version: "0.2.0", sha256: "c".repeat(64) },
        },
        "0.2.0",
      ),
    }),
  });
}

function approval(...answers: boolean[]): Approval {
  const queue = [...answers];
  return { approve: async () => queue.shift() ?? true };
}

function pipeline(
  instance: FactoryInstance,
  ports: { controlPlane: ControlPlane; workflowQueue?: WorkflowQueue },
  fleet: ReturnType<typeof workerFleet> = enrolledFleet(),
) {
  const world = factory({ hosts: ["builder-1"], workers: fleet });
  const deps = {
    ...world.deps,
    approval: approval(true),
    interrupted: () => false,
    ...ports,
  };
  const { now: _now, ...base } = planRequest();
  const request: FactoryApplyRequest = {
    ...base,
    instance,
    host: "operator-laptop",
    clock: () => new Date(NOW.getTime() + 1000),
  };
  return { deps, request, fleet, world };
}

describe("apply's full pipeline (dispatch §Requested versus active, §End-to-end verification)", () => {
  test("installs, synchronizes, reconciles the control plane, activates dispatch, and verifies ready", async () => {
    const { controlPlane } = fakeControlPlane("healthy", { kind: "idle" });
    const { queue, reconcile } = fakeQueue({ changed: true });
    const {
      deps,
      request,
      world: { lockStore },
    } = pipeline(requestingDispatch(), {
      controlPlane,
      workflowQueue: queue,
    });
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
    expect(result.workers.map((w) => w.kind)).toEqual(["installed"]);
    expect(result.repositories?.map((r) => r.kind)).toEqual(["synchronized"]);
    expect(result.controlPlane?.map((c) => c.kind)).toEqual(["applied"]);
    expect(result.dispatch?.map((d) => d.kind)).toEqual(["active"]);
    expect(reconcile).toEqual([true]);
    expect(result.verification?.ready).toBe(true);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "succeeded",
      stages: expect.arrayContaining([
        { name: "dispatch", status: "active" },
        { name: "verification", status: "verified" },
      ]),
      dispatch: [{ status: "active", blockers: [] }],
      verification: { ready: true, workers: [{ dispatch: "active", ready: true }] },
    });
  });

  test("a failing gate (FFFlow adoption) keeps dispatch pending and the factory not ready", async () => {
    const { controlPlane } = fakeControlPlane("healthy", { kind: "idle" });
    const { queue, reconcile } = fakeQueue({ adoption: { kind: "failed", reason: "no .ffflow" } });
    const {
      deps,
      request,
      world: { lockStore },
    } = pipeline(requestingDispatch(), {
      controlPlane,
      workflowQueue: queue,
    });
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.dispatch?.[0]?.kind).toBe("pending");
    // Kept inactive: the reconcile was asked for false.
    expect(reconcile).toEqual([false]);
    expect(result.verification?.ready).toBe(false);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "partial",
      stages: expect.arrayContaining([
        { name: "dispatch", status: "pending" },
        { name: "verification", status: "pending" },
      ]),
      dispatch: [{ status: "pending", blockers: ["ffflow_adoption"] }],
      verification: { ready: false, workers: [{ dispatch: "pending", ready: false }] },
    });
  });

  test("a failed dispatch reconciliation fails the recorded dispatch and verification stages", async () => {
    const { controlPlane } = fakeControlPlane("healthy", { kind: "idle" });
    const { queue } = fakeQueue({ failure: "schedule apply exited 1" });
    const {
      deps,
      request,
      world: { lockStore },
    } = pipeline(requestingDispatch(), {
      controlPlane,
      workflowQueue: queue,
    });
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error("expected applied result");
    expect(result.dispatch?.[0]?.kind).toBe("failed");
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "failed",
      stages: expect.arrayContaining([
        { name: "dispatch", status: "failed" },
        { name: "verification", status: "failed" },
      ]),
    });
  });

  test("rerunning with an active agent is a no-op for Paseo and the agent", async () => {
    const { controlPlane, calls } = fakeControlPlane("healthy", { kind: "active", count: 1 });
    const { queue } = fakeQueue({ changed: false });
    const { deps, request } = pipeline(requestingDispatch(), {
      controlPlane,
      workflowQueue: queue,
    });
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.dispatch?.[0]?.kind).toBe("active");
    if (result.dispatch?.[0]?.kind === "active") expect(result.dispatch[0].changed).toBe(false);
    // Only the health probe runs; no Paseo CLI or lifecycle action touches the active agent.
    expect(calls).toEqual(["health"]);
  });

  test("maintenance is detected before activation, so an active agent leaves the old release complete", async () => {
    const { controlPlane, calls } = fakeControlPlane("healthy", { kind: "active", count: 1 });
    const { queue, reconcile, adoptions } = fakeQueue();
    const {
      deps,
      request,
      fleet,
      world: { lockStore },
    } = pipeline(requestingDispatch(), { controlPlane, workflowQueue: queue }, staleFleet());
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
    expect(result.workers[0]?.kind).toBe("skipped");
    expect(result.controlPlane?.[0]?.kind).toBe("deferred");
    expect(calls).toEqual(["activeAgents"]);
    expect(fleet.transport.calls.some((call) => call.command[0] === "dd")).toBe(false);
    expect(
      fleet.transport.calls.some(
        (call) => call.command[0] === "sudo" && !call.command.includes("repositories"),
      ),
    ).toBe(false);
    // Deferred, not unreachable (#134): dispatch sends the worker nothing, so its existing
    // schedule stays as it is, and the deferral's next action is the one named.
    expect(result.dispatch).toEqual([
      {
        key: "builder-1" as HostKey,
        hostname: B1,
        kind: "skipped",
        reason: "deferred",
        summary: DEFERRED,
        nextAction: CLOSE_AGENTS,
      },
    ]);
    expect(adoptions.count).toBe(0);
    expect(reconcile).toEqual([]);
    expect(result.verification?.workers).toMatchObject([
      { release: "skipped", controlPlane: "deferred", dispatch: "skipped", ready: false },
    ]);
    const verified = result.verification?.workers[0];
    expect(verified?.details).toContain(`Release left as is: ${DEFERRED}`);
    expect(verified?.details).toContain(CLOSE_AGENTS);
    expect(verified?.summary).not.toContain("absent");
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "partial",
      failure: null,
      stages: expect.arrayContaining([
        { name: "control-plane", status: "deferred" },
        { name: "dispatch", status: "pending" },
        { name: "verification", status: "pending" },
      ]),
      control_plane: [
        {
          key: "builder-1",
          hostname: "fff-abcd1234-builder-1",
          status: "deferred",
          summary: `Maintenance (paseo-package, service-definition, listen-address) was deferred while agents may be active on ${B1}; it stays on its complete current release`,
        },
      ],
      dispatch: [{ key: "builder-1", status: "skipped", blockers: [], summary: DEFERRED }],
      verification: { ready: false, workers: [{ release: "skipped", dispatch: "skipped" }] },
    });
  });

  test("runs and records Paseo reconciliation without requiring the dispatch stage", async () => {
    const { controlPlane, calls } = fakeControlPlane("healthy", { kind: "idle" });
    const {
      deps,
      request,
      world: { lockStore },
    } = pipeline(declaring("builder-1"), { controlPlane });
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
    expect(result.controlPlane?.map((outcome) => outcome.kind)).toEqual(["applied"]);
    expect(result.dispatch).toBeUndefined();
    expect(calls).toContain("health");
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      stages: expect.arrayContaining([{ name: "control-plane", status: "reconciled" }]),
      control_plane: [
        {
          key: "builder-1",
          hostname: "fff-abcd1234-builder-1",
          status: "applied",
          summary: null,
        },
      ],
    });
  });

  test("a failed Paseo install fails the recorded operation", async () => {
    const control = fakeControlPlane("unhealthy", { kind: "idle" });
    control.controlPlane.install = async () => {
      control.calls.push("install");
      return { kind: "failed", reason: "setup exited 1" };
    };
    const {
      deps,
      request,
      world: { lockStore },
    } = pipeline(declaring("builder-1"), { controlPlane: control.controlPlane }, staleFleet());
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error(`expected applied result, got ${result.kind}`);
    expect(result.controlPlane?.[0]?.kind).toBe("failed");
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "failed",
      failure: "control-plane builder-1: Paseo installation failed: setup exited 1",
      stages: expect.arrayContaining([{ name: "control-plane", status: "failed" }]),
    });
  });

  test("a later idle apply completes previously deferred maintenance", async () => {
    const { controlPlane, calls } = fakeControlPlane("healthy", { kind: "idle" });
    const { queue } = fakeQueue();
    const { deps, request, fleet } = pipeline(
      requestingDispatch(),
      { controlPlane, workflowQueue: queue },
      staleFleet(),
    );
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
    expect(result.workers[0]?.kind).toBe("installed");
    expect(result.controlPlane?.[0]?.kind).toBe("applied");
    expect(calls).toEqual(["activeAgents", "activeAgents", "install", "restart", "health"]);
    expect(fleet.transport.calls.some((call) => call.command[0] === "dd")).toBe(true);
  });

  test("unknown activity defers before activation just like active activity", async () => {
    const { controlPlane, calls } = fakeControlPlane("unreachable", {
      kind: "unknown",
      reason: "activity endpoint did not answer",
    });
    const { queue, reconcile } = fakeQueue();
    const {
      deps,
      request,
      fleet,
      world: { lockStore },
    } = pipeline(requestingDispatch(), { controlPlane, workflowQueue: queue }, staleFleet());
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
    expect(result.workers[0]?.kind).toBe("skipped");
    expect(result.controlPlane?.[0]?.kind).toBe("deferred");
    expect(calls).toEqual(["activeAgents"]);
    expect(fleet.transport.calls.some((call) => call.command[0] === "dd")).toBe(false);
    expect(result.dispatch).toMatchObject([{ kind: "skipped", reason: "deferred" }]);
    expect(reconcile).toEqual([]);
    expect(result.verification?.workers).toMatchObject([{ release: "skipped" }]);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "partial", failure: null });
  });

  test("a deferred worker's dispatch skip names the deferral, even when no worker executable skipped it first", async () => {
    const { controlPlane } = fakeControlPlane("healthy", { kind: "active", count: 1 });
    const { queue, reconcile } = fakeQueue();
    const { deps, request } = pipeline(
      requestingDispatch(),
      { controlPlane, workflowQueue: queue },
      staleFleet(),
    );
    const result = await applyFactory(
      { ...deps, assets: { ...deps.assets, workerRelease: async () => undefined } },
      request,
    );
    if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
    expect(result.workers[0]).toMatchObject({
      kind: "skipped",
      summary: expect.stringContaining("no worker executable"),
    });
    expect(result.controlPlane?.[0]?.kind).toBe("deferred");
    // The reason and its words come from the one deferral, never mixed with the workers stage's.
    expect(result.dispatch).toEqual([
      {
        key: "builder-1" as HostKey,
        hostname: B1,
        kind: "skipped",
        reason: "deferred",
        summary: DEFERRED,
        nextAction: CLOSE_AGENTS,
      },
    ]);
    expect(reconcile).toEqual([]);
  });

  test("an offline worker the workers stage skipped is sent nothing by dispatch, and is not a failure", async () => {
    const { controlPlane, calls } = fakeControlPlane("healthy", { kind: "idle" });
    const { queue, reconcile, adoptions } = fakeQueue();
    const offline = workerFleet(["builder-1"], {}, () =>
      peers(peer(B1, { tags: [WORKER_TAG], online: false })),
    );
    const {
      deps,
      request,
      world: { lockStore },
    } = pipeline(requestingDispatch(), { controlPlane, workflowQueue: queue }, offline);
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
    const skipped = result.workers[0];
    if (skipped?.kind !== "skipped") throw new Error(`expected skipped, got ${skipped?.kind}`);
    expect(skipped.summary).toBe("Offline in the tailnet");
    // The workers stage's skip, carried as it is: its reason and next action, never "unreachable".
    expect(result.dispatch).toEqual([
      {
        key: "builder-1" as HostKey,
        hostname: B1,
        kind: "skipped",
        reason: "worker_skipped",
        summary: skipped.summary,
        nextAction: skipped.nextAction,
      },
    ]);
    expect(adoptions.count).toBe(0);
    expect(reconcile).toEqual([]);
    expect(calls).toEqual([]);
    const verified = result.verification?.workers[0];
    expect(verified).toMatchObject({ release: "skipped", dispatch: "skipped", ready: false });
    expect(verified?.details).toContain("Release left as is: Offline in the tailnet");
    expect(verified?.details).toContain(skipped.nextAction);
    expect(verified?.summary).not.toContain("absent");
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "partial",
      failure: null,
      stages: expect.arrayContaining([
        { name: "dispatch", status: "pending" },
        { name: "verification", status: "pending" },
      ]),
      dispatch: [{ status: "skipped", summary: "Offline in the tailnet" }],
    });
  });

  test("an installed worker that went offline before dispatch is skipped as unreachable, not failed", async () => {
    const { controlPlane } = fakeControlPlane("healthy", { kind: "idle" });
    const { queue, reconcile } = fakeQueue();
    const worker = installableWorker(
      appliedRecord(B1, "0.3.0", { verification: verification(B1, "enrolled") }),
      { inspection: currentWorker("builder-1") },
    );
    // Online until the worker has received its projection, offline from then on.
    const fleet = workerFleet(["builder-1"], { [B1]: worker }, () =>
      peers(peer(B1, { tags: [WORKER_TAG], online: worker.projections.length === 0 })),
    );
    const {
      deps,
      request,
      world: { lockStore },
    } = pipeline(requestingDispatch(), { controlPlane, workflowQueue: queue }, fleet);
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
    expect(result.workers.map((outcome) => outcome.kind)).toEqual(["installed"]);
    expect(result.dispatch).toEqual([
      {
        key: "builder-1" as HostKey,
        hostname: B1,
        kind: "skipped",
        reason: "unreachable",
        summary: "Offline in the tailnet",
        nextAction:
          "Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.",
      },
    ]);
    expect(reconcile).toEqual([]);
    expect(result.verification?.workers).toMatchObject([
      { release: "healthy", dispatch: "skipped", ready: false },
    ]);
    expect(result.verification?.workers[0]?.details).toContain(
      "Dispatch left as is: Offline in the tailnet",
    );
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "partial", failure: null });
  });

  test("dispatch not requested does not block a ready factory", async () => {
    const { controlPlane } = fakeControlPlane("healthy", { kind: "idle" });
    const { queue } = fakeQueue();
    const base = declaring("builder-1");
    const instance: FactoryInstance = {
      ...base,
      hosts: (base.hosts ?? []).map((host) => ({ ...host })),
    };
    const { deps, request } = pipeline(instance, { controlPlane, workflowQueue: queue });
    const result = await applyFactory(deps, request);
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.dispatch?.[0]?.kind).toBe("not_requested");
    expect(result.verification?.ready).toBe(true);
  });
});

describe("a password-bearing host (host protocol §The host projection, #132)", () => {
  /** factory.json declaring builder-1 with its Paseo password reference. */
  const PASSWORD_BEARING = declaring({
    key: "builder-1",
    paseo_password_secret: PASEO_PASSWORD_ARN,
  });

  test("host apply and the Paseo install get the projection with its secret reference, so the rerun's plan and status find it current", async () => {
    const { controlPlane, installed } = fakeControlPlane("healthy", { kind: "idle" });
    // The worker starts holding the projection the 0.0.1 workers stage sent, without the
    // reference, so this apply has a drifted configuration to replace and must send one.
    const fleet = enrolledFleet(currentWorker("builder-1"));
    const { deps, request, world } = pipeline(PASSWORD_BEARING, { controlPlane }, fleet);
    const applied = await applyFactory(deps, request);
    if (applied.kind !== "applied") throw new Error(`expected applied, got ${applied.kind}`);
    expect(applied.workers.map((worker) => worker.kind)).toEqual(["installed"]);

    // 1. The workers stage streamed the canonical projection, reference included.
    const sent = hostProjectionJson(
      hostProjection(FACTORY, "builder-1" as HostKey, RELEASE, PASEO_PASSWORD_ARN),
    );
    expect(fleet.worker.projections).toEqual([sent]);

    // 2. The control-plane stage installed Paseo from that same projection.
    expect(installed.map(hostProjectionJson)).toEqual([sent]);

    // 3. Planning again finds no control-plane change for the host.
    const replanned = await planFactory(
      world.deps,
      planRequest({ instance: PASSWORD_BEARING, now: new Date(NOW.getTime() + 2000) }),
    );
    if (replanned.kind !== "planned") throw new Error(`expected planned, got ${replanned.kind}`);
    expect(replanned.saved.control_plane).toMatchObject([{ key: "builder-1", changes: [] }]);

    // 4. Status finds the host configuration the one factory.json projects.
    const status = await factoryStatus(
      {
        identity: fakeCallerIdentity().identity,
        machines: fakeMachineInventory({ kind: "machines", machines: [machine("builder-1")] })
          .machines,
        peers: fleet.tailnet.tailnet,
        transport: fleet.transport.transport,
        sha256: sha256Text,
      },
      { instance: PASSWORD_BEARING, credentials: request.credentials },
    );
    if (status.kind !== "report") throw new Error(`expected a report, got ${status.kind}`);
    expect(status.report.workers).toMatchObject([
      { key: "builder-1", status: "ready", configuration: sha256Text(sent) },
    ]);
  });
});
