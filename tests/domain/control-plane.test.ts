import { describe, expect, test } from "bun:test";
import {
  activityJson,
  AGENT_STATES,
  type AgentState,
  type AgentsObservation,
  busyAgents,
  controlPlaneActionJson,
  OUTDATED_AGENTS,
  parseActivityDocument,
  parseControlPlaneActionDocument,
  type WorkerAgents,
  workerActivity,
} from "../../src/domain/control-plane";

const AGENTS = [
  { id: "4f1c2a9e-0b7d-4c3e-9a51-6d2e8f0b1c3a", state: "working" as const, dispatched: true },
  { id: "a7e3", state: "needs_input" as const, dispatched: false },
  { id: "b8f4", state: "finished" as const, dispatched: true },
  { id: "c9a5", state: "failed" as const, dispatched: false },
  { id: "d0b6", state: "stopped" as const, dispatched: false },
];

/** A worker listing one agent in each of `states`. */
function listing(...states: AgentState[]): WorkerAgents {
  return {
    kind: "listed",
    agents: states.map((state, index) => ({ id: `agent-${index}`, state, dispatched: true })),
  };
}

describe("fffactory's agent states", () => {
  test("are its own five, naming no Paseo status", () => {
    expect(AGENT_STATES).toEqual(["working", "needs_input", "finished", "failed", "stopped"]);
  });
});

describe("the busy rule (control-plane §Agent states)", () => {
  test("a worker with no agent is idle", () => {
    expect(workerActivity(listing())).toEqual({ kind: "idle" });
  });

  test("finished, failed and stopped agents never count: a worker with only those is idle", () => {
    expect(workerActivity(listing("finished"))).toEqual({ kind: "idle" });
    expect(workerActivity(listing("finished", "finished", "failed", "stopped"))).toEqual({
      kind: "idle",
    });
  });

  test("a worker is busy while any agent is working or needs input, each counted", () => {
    expect(workerActivity(listing("working"))).toEqual({
      kind: "busy",
      working: 1,
      needsInput: 0,
    });
    expect(workerActivity(listing("needs_input", "finished"))).toEqual({
      kind: "busy",
      working: 0,
      needsInput: 1,
    });
    expect(workerActivity({ kind: "listed", agents: AGENTS })).toEqual({
      kind: "busy",
      working: 1,
      needsInput: 1,
    });
  });

  test("agents that could not be read are unknown, with the adapter's reason", () => {
    expect(workerActivity({ kind: "unknown", reason: "Paseo activity could not be read" })).toEqual(
      { kind: "unknown", reason: "Paseo activity could not be read", outdated: false },
    );
  });

  test("an answer without the agent list, from an older release, is unknown and outdated", () => {
    expect(workerActivity({ kind: "outdated" } satisfies AgentsObservation)).toEqual({
      kind: "unknown",
      reason: OUTDATED_AGENTS,
      outdated: true,
    });
    expect(OUTDATED_AGENTS).toBe("its release predates fffactory's agent states");
  });

  test.each([
    [1, 0, "1 agent is working on fff-abcd1234-builder-1"],
    [2, 0, "2 agents are working on fff-abcd1234-builder-1"],
    [0, 1, "1 agent needs input on fff-abcd1234-builder-1"],
    [0, 3, "3 agents need input on fff-abcd1234-builder-1"],
    [1, 1, "1 agent is working and 1 needs input on fff-abcd1234-builder-1"],
    [2, 3, "2 agents are working and 3 need input on fff-abcd1234-builder-1"],
  ])(
    "names how many agents are busy, and how: %i working, %i needing input",
    (working, needsInput, words) => {
      expect(busyAgents({ kind: "busy", working, needsInput }, "fff-abcd1234-builder-1")).toBe(
        words,
      );
    },
  );
});

describe("control-plane protocol documents", () => {
  test.each([
    [{ kind: "listed", agents: [] } as WorkerAgents, { kind: "idle" }, []],
    [{ kind: "listed", agents: AGENTS } as WorkerAgents, { kind: "active", count: 2 }, AGENTS],
    [
      { kind: "unknown", reason: "Paseo did not answer" } as WorkerAgents,
      { kind: "unknown", reason: "Paseo did not answer" },
      null,
    ],
  ])(
    "round-trips the activity document, its activity field the busy rule's %#",
    (agents, activity, list) => {
      const text = activityJson(agents);
      expect(JSON.parse(text)).toEqual({ protocol_version: 1, activity, agents: list });
      expect(parseActivityDocument(text)).toEqual({ ok: true, document: agents });
    },
  );

  test("writes the agents beside the activity field, null when they could not be read", () => {
    expect(JSON.parse(activityJson({ kind: "listed", agents: AGENTS.slice(0, 1) }))).toEqual({
      protocol_version: 1,
      activity: { kind: "active", count: 1 },
      agents: [{ id: AGENTS[0]?.id, state: "working", dispatched: true }],
    });
    expect(JSON.parse(activityJson({ kind: "unknown", reason: "not root" }))).toEqual({
      protocol_version: 1,
      activity: { kind: "unknown", reason: "not root" },
      agents: null,
    });
  });

  test("refuses an older worker's answer without agents as outdated, never reading its count", () => {
    for (const activity of [{ kind: "active", count: 2 }, { kind: "idle" }])
      expect(parseActivityDocument(JSON.stringify({ protocol_version: 1, activity }))).toEqual({
        ok: false,
        kind: "outdated",
      });
  });

  test("an answer without agents whose activity is malformed is invalid, not outdated", () => {
    expect(
      parseActivityDocument(
        JSON.stringify({ protocol_version: 1, activity: { kind: "surprising" } }),
      ),
    ).toEqual({ ok: false, kind: "invalid", problem: "activity.kind is not a known state" });
  });

  test.each([
    [{ kind: "active", count: 1 }, "not-an-array", "agents must be an array"],
    [{ kind: "active", count: 1 }, ["one"], "agents[0] must be an object"],
    [
      { kind: "active", count: 1 },
      [{ id: "one", state: "idle", dispatched: false }],
      "agents[0].state is not a known state",
    ],
    [
      { kind: "active", count: 1 },
      [{ id: "one", state: "running", dispatched: false }],
      "agents[0].state is not a known state",
    ],
    [
      { kind: "active", count: 1 },
      [{ id: "-one", state: "working", dispatched: false }],
      "agents[0].id is missing or malformed",
    ],
    [
      { kind: "active", count: 1 },
      [{ id: "o n e", state: "working", dispatched: false }],
      "agents[0].id is missing or malformed",
    ],
    [
      { kind: "active", count: 1 },
      [{ id: "one", state: "working", dispatched: "true" }],
      "agents[0].dispatched must be a boolean",
    ],
    [{ kind: "idle" }, null, "agents is null only when activity is unknown"],
    [{ kind: "unknown", reason: "not root" }, [], "agents is null only when activity is unknown"],
  ])("rejects an invalid agent list %#", (activity, agents, problem) => {
    const parsed = parseActivityDocument(JSON.stringify({ protocol_version: 1, activity, agents }));
    expect(parsed).toEqual({ ok: false, kind: "invalid", problem });
  });

  test.each([{ kind: "done" as const }, { kind: "failed" as const, reason: "reload failed" }])(
    "round-trips action $kind",
    (result) => {
      expect(parseControlPlaneActionDocument(controlPlaneActionJson(result))).toEqual({
        ok: true,
        document: { protocol_version: 1, result },
      });
    },
  );

  test.each([
    [{ kind: "active", count: 0 }, "positive count"],
    [{ kind: "active", count: 1.5 }, "positive count"],
    [{ kind: "unknown", reason: "" }, "short reason"],
    [{ kind: "unknown", reason: "x".repeat(201) }, "short reason"],
    [{ kind: "surprising" }, "known state"],
  ])("rejects invalid activity %#", (activity, problem) => {
    const parsed = parseActivityDocument(
      JSON.stringify({ protocol_version: 1, activity, agents: [] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.kind === "invalid") expect(parsed.problem).toContain(problem);
  });

  test.each([
    [{ kind: "failed", reason: 42 }, "short reason"],
    [{ kind: "failed", reason: "" }, "short reason"],
    [{ kind: "surprising" }, "known state"],
  ])("rejects invalid action %#", (result, problem) => {
    const parsed = parseControlPlaneActionDocument(JSON.stringify({ protocol_version: 1, result }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.kind === "invalid") expect(parsed.problem).toContain(problem);
  });
});
