import { describe, expect, test } from "bun:test";
import type { Agent } from "../../src/domain/control-plane";
import { HOST_PROTOCOL_VERSION } from "../../src/domain/host-protocol";
import type { HostKey } from "../../src/domain/instance";
import type { RepositoryObservation } from "../../src/domain/repository-placement";
import type { WorkObservation } from "../../src/domain/work-inspection";
import {
  powerStep,
  selectMachine,
  type TerminateInspection,
  terminateGate,
} from "../../src/domain/worker-lifecycle";
import { teardownGateActions } from "../../src/domain/teardown";
import {
  inspectGateActions,
  type RemovalObservation,
  removalExitCode,
  thenRerunInspect,
  workerRemovability,
} from "../../src/domain/worker-removability";

const KEY = "builder-1" as HostKey;
const WORKER = { key: KEY, hostname: "fff-abcd1234-builder-1" };
const ID = "i-0123456789abcdef0";
const INSPECT = "`fffactory worker inspect builder-1`";
const TERMINATE_FORCE = "`fffactory worker terminate builder-1 --force`";

const FINISHED: readonly Agent[] = [
  { id: "agent-1", state: "finished", dispatched: true },
  { id: "agent-2", state: "finished", dispatched: false },
];
const SYNCHRONIZED: RepositoryObservation = {
  protocol_version: HOST_PROTOCOL_VERSION,
  state: "synchronized",
  unmanaged: [],
};

/** The work inspection of a worker whose one checkout holds `untracked` untracked files. */
function work(untracked: number): WorkObservation {
  return {
    kind: "inspected",
    inspection: {
      protocol_version: HOST_PROTOCOL_VERSION,
      hostname: WORKER.hostname,
      complete: true,
      repositories: [
        {
          path: "/workspace/repos/acme/widget",
          state: "inspected",
          unpushed_commits: 0,
          unpushed_branches: [],
          stashes: 0,
          worktrees: [
            {
              path: "/workspace/repos/acme/widget",
              branch: "main",
              state: "inspected",
              tracked_changes: 0,
              untracked_files: untracked,
              unpushed_commits: 0,
              operation: null,
            },
          ],
        },
      ],
    },
  };
}

/** An idle worker whose agents are only `agents`, with its work and checkouts read. */
function inspected(
  agents: readonly Agent[],
  untracked = 0,
): Extract<TerminateInspection, { readonly kind: "inspected" }> {
  return {
    kind: "inspected",
    agents,
    repositories: SYNCHRONIZED,
    work: work(untracked),
    placed: [],
  };
}

const actions = inspectGateActions(KEY);

/** The inspection document of `WORKER` as `observed`, judged with inspect's next actions. */
const inspectionOf = (observed: RemovalObservation) =>
  workerRemovability(WORKER, observed, actions).inspection;
/** The next action `worker inspect` gives for `WORKER` as `observed`. */
const nextActionOf = (observed: RemovalObservation) =>
  workerRemovability(WORKER, observed, actions).next_action;

describe("worker inspect's verdict (worker-lifecycle §Inspect)", () => {
  test("a worker terminate's gates pass is removable, its finished agents listed", () => {
    expect(workerRemovability(WORKER, inspected(FINISHED), actions)).toEqual({
      inspection: {
        key: KEY,
        hostname: WORKER.hostname,
        verdict: "removable",
        not_inspected: null,
        summary:
          "fff-abcd1234-builder-1 can be terminated: no agent is working or needs input, and " +
          "no work or checkout would be lost",
        details: [],
        activity: { state: "idle", reason: null, agents: FINISHED },
      },
      next_action: null,
    });
  });

  test("busy agents refuse it with terminate's own findings, every agent listed", () => {
    const agents: readonly Agent[] = [
      { id: "agent-1", state: "working", dispatched: true },
      ...FINISHED,
    ];
    const inspection: TerminateInspection = {
      kind: "activity",
      activity: { kind: "busy", working: 1, needsInput: 0 },
      agents: { kind: "listed", agents },
    };
    const { inspection: document, next_action } = workerRemovability(WORKER, inspection, actions);
    expect(document).toEqual({
      key: KEY,
      hostname: WORKER.hostname,
      verdict: "refused",
      not_inspected: null,
      summary: "1 agent is working on fff-abcd1234-builder-1: terminating it would end it",
      details: [],
      activity: { state: "busy", reason: null, agents },
    });
    expect(next_action).toBe(
      `Wait until no agent there is working or needs input, then rerun ${INSPECT}, or ` +
        `terminate it anyway with ${TERMINATE_FORCE}.`,
    );
    expect(document.summary).toBe(
      terminateGate(inspection, WORKER, "terminate")?.summary as string,
    );
  });

  test("unpushed work refuses it, listing where, with the same findings terminate refuses with", () => {
    const inspection = inspected(FINISHED, 2);
    const terminate = terminateGate(inspection, WORKER, "terminate");
    const document = inspectionOf(inspection);
    expect(document).toMatchObject({
      verdict: "refused",
      summary: terminate?.summary,
      details: ["/workspace/repos/acme/widget (branch main): 2 untracked files"],
      activity: { state: "idle", agents: FINISHED },
    });
    expect(nextActionOf(inspection)).toBe(
      `Push or discard it, then rerun ${INSPECT}, or terminate it anyway with ${TERMINATE_FORCE}.`,
    );
    expect(document.details).toEqual(terminate?.details as string[]);
  });

  test("activity that could not be read refuses it, saying why", () => {
    const unreadable: RemovalObservation = {
      kind: "activity",
      activity: { kind: "unknown", reason: "Paseo activity could not be read", outdated: false },
      agents: { kind: "unknown", reason: "Paseo activity could not be read" },
    };
    expect(inspectionOf(unreadable)).toMatchObject({
      verdict: "refused",
      summary:
        "fff-abcd1234-builder-1 could not be inspected for busy agents: Paseo activity could not be read",
      activity: { state: "unknown", reason: "Paseo activity could not be read", agents: null },
    });
    expect(nextActionOf(unreadable)).toBe(
      `Check the worker with \`fffactory status\`, then rerun ${INSPECT}, or terminate it ` +
        `uninspected with ${TERMINATE_FORCE}.`,
    );
  });

  test("a worker the tailnet does not locate is refused, its agents not read", () => {
    const unlocated: RemovalObservation = {
      kind: "unlocated",
      verdict: {
        status: "not_ready",
        summary: "Offline in the tailnet",
        details: [],
        nextAction: "Check that Tailscale is up on it.",
      },
    };
    expect(inspectionOf(unlocated)).toMatchObject({
      verdict: "refused",
      summary: "fff-abcd1234-builder-1 could not be inspected: Offline in the tailnet",
      activity: { state: "unknown", reason: null, agents: null },
    });
    expect(nextActionOf(unlocated)).toBe(
      `Check the worker with \`fffactory status\`, then rerun ${INSPECT}. If the instance's ` +
        "EC2 console output shows its bootstrap failed, it never joined the tailnet: " +
        `${TERMINATE_FORCE} terminates it uninspected.`,
    );
  });

  test("an older activator is checked by hand, then terminated with --force", () => {
    const nextAction = nextActionOf({
      ...inspected(FINISHED),
      work: { kind: "unknown", reason: "its activator predates it", unsupported: true },
    });
    expect(nextAction).toEndWith(`then terminate it with --force: ${TERMINATE_FORCE}.`);
  });

  test("a stopped machine is not inspected, as terminate passes it", () => {
    expect(workerRemovability(WORKER, { kind: "stopped" }, actions)).toEqual({
      inspection: {
        key: KEY,
        hostname: WORKER.hostname,
        verdict: "not_inspected",
        not_inspected: "stopped",
        summary:
          "The machine is stopped: the worker is not inspected, and unpushed work on its disk is not reported.",
        details: [],
        activity: { state: "unknown", reason: null, agents: null },
      },
      next_action: null,
    });
  });

  test("a forced, shutting-down or absent machine is not inspected either, saying why", () => {
    expect(workerRemovability(WORKER, { kind: "forced" }, actions)).toMatchObject({
      inspection: {
        verdict: "not_inspected",
        not_inspected: "forced",
        summary: "--force: the worker is not inspected for busy agents, current work or checkouts.",
      },
      next_action: null,
    });
    expect(inspectionOf({ kind: "shutting_down" })).toMatchObject({
      verdict: "not_inspected",
      not_inspected: "shutting_down",
      summary: "The machine is already being terminated: the worker is not inspected.",
    });
    expect(inspectionOf({ kind: "absent" })).toMatchObject({
      verdict: "not_inspected",
      not_inspected: "absent",
      summary: "No EC2 instance carries its key: its machine is already gone.",
    });
  });

  test("a machine terminate refuses is refused, with inspect's rerun", () => {
    const step = powerStep(
      "terminate",
      { instanceId: ID, state: "pending", hostKey: KEY },
      KEY,
      thenRerunInspect(KEY),
    );
    if (step.kind !== "refused") throw new Error("a pending machine is refused");
    expect(workerRemovability(WORKER, { kind: "machine", refusal: step.refusal }, actions)).toEqual(
      {
        inspection: {
          key: KEY,
          hostname: WORKER.hostname,
          verdict: "refused",
          not_inspected: null,
          summary: `EC2 instance ${ID} is pending`,
          details: [],
          activity: { state: "unknown", reason: null, agents: null },
        },
        next_action: `Wait until it is running, then rerun ${INSPECT}.`,
      },
    );
    const selection = selectMachine(
      { kind: "unavailable", reason: "EC2 DescribeInstances failed: UnauthorizedOperation" },
      KEY,
      "terminate",
      thenRerunInspect(KEY),
    );
    expect(selection).toMatchObject({
      kind: "refused",
      refusal: {
        nextAction:
          "Check your network connection and that the credentials may call " +
          `ec2:DescribeInstances, then rerun ${INSPECT}.`,
      },
    });
  });
});

describe("the inspection document a removal record carries (worker-lifecycle §Inspect)", () => {
  test("is the same whichever command's next actions judge it: only the next action differs", () => {
    const observations: readonly RemovalObservation[] = [
      inspected(FINISHED),
      inspected(FINISHED, 2),
      { kind: "stopped" },
      { kind: "absent" },
      {
        kind: "activity",
        activity: { kind: "busy", working: 1, needsInput: 0 },
        agents: { kind: "listed", agents: [{ id: "agent-1", state: "working", dispatched: true }] },
      },
    ];
    for (const observed of observations) {
      const inspecting = workerRemovability(WORKER, observed, actions);
      const tearingDown = workerRemovability(WORKER, observed, teardownGateActions(WORKER));
      expect(tearingDown.inspection).toEqual(inspecting.inspection);
      expect(Object.keys(inspecting.inspection)).not.toContain("next_action");
    }
    const busy = observations[4] as RemovalObservation;
    expect(workerRemovability(WORKER, busy, teardownGateActions(WORKER)).next_action).not.toBe(
      nextActionOf(busy),
    );
  });
});

describe("worker inspect's exit code (worker-lifecycle §Inspect)", () => {
  const removable = workerRemovability(WORKER, inspected(FINISHED), actions);
  const refused = workerRemovability(WORKER, inspected(FINISHED, 1), actions);
  const stopped = workerRemovability(WORKER, { kind: "stopped" }, actions);

  test("0 when every inspected worker is removable; a worker not inspected does not count", () => {
    expect(removalExitCode([removable])).toBe(0);
    expect(removalExitCode([removable, stopped])).toBe(0);
    expect(removalExitCode([stopped])).toBe(0);
    expect(removalExitCode([])).toBe(0);
  });

  test("2 when any is refused, or could not be inspected", () => {
    expect(removalExitCode([removable, refused, stopped])).toBe(2);
  });
});
