import { describe, expect, test } from "bun:test";
import {
  applyDispatch,
  type DispatchSkip,
  type DispatchStageRequest,
  type DispatchWorker,
  type GatedDispatchWorker,
} from "../../src/application/apply-dispatch";
import type { WorkflowAdoption, WorkflowQueue } from "../../src/application/workflow-queue";
import { DISPATCH_GATES, type DispatchGate } from "../../src/domain/dispatch-readiness";
import type { DispatchInspection } from "../../src/domain/dispatch-projection";
import type { HostKey } from "../../src/domain/instance";
import { enrollmentNextAction } from "../../src/domain/readiness";
import type { WorkerIdentity } from "../../src/domain/rollout";
import { resolveWorker, type WorkerAddress } from "../../src/domain/tailnet";
import { peer, TAG } from "../support/fake-workers";

const HOSTNAME = "fff-abcd1234-builder-1";
const WORKER: WorkerIdentity = { key: "builder-1" as HostKey, hostname: HOSTNAME };
const SETTINGS = {
  enabled: true,
  cron: "*/15 * * * *",
  timezone: "UTC",
  provider: "claude",
  model: "configured-model",
  mode: "default",
  cwd: "/home/factory",
} as const;

function address(): WorkerAddress {
  const resolution = resolveWorker([peer(HOSTNAME)], HOSTNAME, TAG);
  if (resolution.kind !== "found") throw new Error(`worker did not resolve: ${resolution.kind}`);
  return resolution.worker;
}

/** A worker whose every gate passes and whose dispatch factory.json requests. */
function worker(overrides: Partial<GatedDispatchWorker> = {}): GatedDispatchWorker {
  return {
    worker: WORKER,
    address: address(),
    settings: SETTINGS,
    releaseHealthy: true,
    githubCredential: "enrolled",
    repositorySync: "ready",
    paseoHealth: "healthy",
    ...overrides,
  };
}

/** The single field that makes `gate` fail. */
const FAILS: Readonly<Record<DispatchGate, Partial<GatedDispatchWorker>>> = {
  worker_release: { releaseHealthy: false },
  github_credential: { githubCredential: "pending" },
  repository_sync: { repositorySync: "pending" },
  ffflow_adoption: {}, // driven by the adoption the queue reports
  paseo_health: { paseoHealth: "unhealthy" },
};

function inspectionFor(
  projection: Parameters<WorkflowQueue["reconcileDispatch"]>[1],
  changed: boolean,
): DispatchInspection {
  if (!projection.requested)
    return { protocol_version: 1 as const, state: "not_requested" as const, blockers: [], changed };
  return projection.active
    ? { protocol_version: 1 as const, state: "active" as const, blockers: [], changed }
    : {
        protocol_version: 1 as const,
        state: "pending" as const,
        blockers: projection.blockers,
        changed,
      };
}

/** A workflow queue reporting a fixed adoption and reconcile result, recording its calls. */
function fakeQueue(
  options: { adoption?: WorkflowAdoption; changed?: boolean; reconcileFails?: boolean } = {},
) {
  const calls: { adoption: number; reconcile: { active: boolean }[] } = {
    adoption: 0,
    reconcile: [],
  };
  const queue: WorkflowQueue = {
    adoption: async () => {
      calls.adoption += 1;
      return options.adoption ?? { kind: "passed" };
    },
    reconcileDispatch: async (_worker, projection) => {
      calls.reconcile.push({ active: projection.active });
      return options.reconcileFails && calls.reconcile.length === 1
        ? { kind: "failed", reason: "paseo schedule create failed" }
        : {
            kind: "reconciled",
            changed: options.changed ?? true,
            inspection: inspectionFor(projection, options.changed ?? true),
          };
    },
    inspectDispatch: async () => ({ protocol_version: 1, state: "none" }),
  };
  return { queue, calls };
}

function run(workers: DispatchWorker[], queue: WorkflowQueue) {
  const request: DispatchStageRequest = { workers };
  return applyDispatch({ workflowQueue: queue }, request);
}

describe("the dispatch stage (dispatch §Requested versus active)", () => {
  test("activates dispatch when requested and every gate passes", async () => {
    const { queue, calls } = fakeQueue({ changed: true });
    const { outcomes } = await run([worker()], queue);
    expect(outcomes[0]?.kind).toBe("active");
    if (outcomes[0]?.kind === "active") expect(outcomes[0].changed).toBe(true);
    expect(calls.reconcile).toEqual([{ active: true }]);
  });

  test.each([...DISPATCH_GATES])("gate %s failing keeps dispatch inactive", async (gate) => {
    const adoption: WorkflowAdoption =
      gate === "ffflow_adoption" ? { kind: "failed", reason: "no .ffflow" } : { kind: "passed" };
    const { queue, calls } = fakeQueue({ adoption });
    const { outcomes } = await run([worker(FAILS[gate])], queue);
    expect(outcomes[0]?.kind).toBe("pending");
    if (outcomes[0]?.kind !== "pending") throw new Error("expected pending");
    expect(outcomes[0].blocking.map((result) => result.gate)).toEqual([gate]);
    // Kept inactive, never activated.
    expect(calls.reconcile).toEqual([{ active: false }]);
  });

  test("a later apply activates dispatch after adoption becomes ready", async () => {
    const { queue, calls } = fakeQueue();
    let adopted = false;
    queue.adoption = async () =>
      adopted ? { kind: "passed" } : { kind: "failed", reason: "no .fflow" };

    const first = await run([worker()], queue);
    expect(first.outcomes[0]?.kind).toBe("pending");

    adopted = true;
    const second = await run([worker()], queue);
    expect(second.outcomes[0]?.kind).toBe("active");
    expect(calls.reconcile).toEqual([{ active: false }, { active: true }]);
  });

  test("a missing GitHub credential keeps dispatch inactive and shows the next action", async () => {
    const { queue } = fakeQueue();
    const { outcomes } = await run([worker({ githubCredential: "pending" })], queue);
    const outcome = outcomes[0];
    expect(outcome?.kind).toBe("pending");
    if (outcome?.kind !== "pending") throw new Error("expected pending");
    const next = enrollmentNextAction("github", HOSTNAME);
    const line = outcome.nextActions.find((entry) => entry.includes("GitHub"));
    expect(line).toContain(next.login);
    for (const command of next.commands) expect(line).toContain(command);
  });

  test("rerunning with an active agent is a no-op: dispatch stays active and nothing restarts", async () => {
    // The schedule already matches, so the reconcile changes nothing; the stage never reaches
    // Paseo's daemon (it holds no control-plane port), so no agent is disturbed.
    const { queue, calls } = fakeQueue({ changed: false });
    const { outcomes } = await run([worker()], queue);
    expect(outcomes[0]?.kind).toBe("active");
    if (outcomes[0]?.kind === "active") expect(outcomes[0].changed).toBe(false);
    expect(calls.reconcile).toEqual([{ active: true }]);
  });

  test("dispatch not requested actively removes an existing schedule", async () => {
    const { queue, calls } = fakeQueue();
    const { outcomes } = await run([worker({ settings: undefined, releaseHealthy: false })], queue);
    expect(outcomes[0]?.kind).toBe("not_requested");
    expect(calls).toEqual({ adoption: 0, reconcile: [{ active: false }] });
  });

  test("a failed reconcile is reported without stopping the other workers", async () => {
    const { queue } = fakeQueue({ reconcileFails: true });
    const second = worker({
      worker: { key: "builder-2" as HostKey, hostname: "h2" },
      settings: undefined,
    });
    const { outcomes } = await run([worker(), second], queue);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["failed", "not_requested"]);
  });

  test.each([
    [
      worker(),
      {
        protocol_version: 1 as const,
        state: "pending" as const,
        blockers: [] as const,
        changed: true,
      },
    ],
    [
      worker({ settings: undefined }),
      {
        protocol_version: 1 as const,
        state: "active" as const,
        blockers: [] as const,
        changed: true,
      },
    ],
  ])(
    "fails closed when the reconciled schedule disagrees with the gated state",
    async (entry, inspection) => {
      const { queue } = fakeQueue();
      queue.reconcileDispatch = async () => ({ kind: "reconciled", changed: true, inspection });

      const { outcomes } = await run([entry], queue);

      expect(outcomes[0]).toMatchObject({
        kind: "failed",
        nextAction: expect.stringContaining("rerun `fffactory apply`"),
      });
    },
  );

  test("adoption the queue cannot check keeps dispatch inactive", async () => {
    const { queue } = fakeQueue({ adoption: { kind: "unknown", reason: "gh timed out" } });
    const { outcomes } = await run([worker()], queue);
    expect(outcomes[0]?.kind).toBe("pending");
    if (outcomes[0]?.kind === "pending")
      expect(outcomes[0].blocking.map((result) => result.gate)).toEqual(["ffflow_adoption"]);
  });

  test.each<DispatchSkip>([
    {
      reason: "deferred",
      summary: "Paseo maintenance is deferred while agents may be active",
      nextAction: `Close the active agents on ${HOSTNAME}, then rerun \`fffactory apply\``,
    },
    {
      reason: "worker_skipped",
      summary: "Offline in the tailnet",
      nextAction:
        "Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.",
    },
    {
      reason: "unreachable",
      summary: "Offline in the tailnet",
      nextAction:
        "Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.",
    },
  ])(
    "a skipped worker ($reason) is sent nothing and reported skipped with its next action",
    async (skip) => {
      const { queue, calls } = fakeQueue();
      const skipped: DispatchWorker = { worker: WORKER, skip };
      const { outcomes } = await run([skipped, worker()], queue);
      expect(outcomes[0]).toEqual({ ...WORKER, kind: "skipped", ...skip });
      // Neither adoption nor the schedule is touched for it: its existing schedule stays as it is.
      // The next worker is still reconciled.
      expect(calls).toEqual({ adoption: 1, reconcile: [{ active: true }] });
      expect(outcomes[1]?.kind).toBe("active");
    },
  );
});
