import { describe, expect, test } from "bun:test";
import {
  activityJson,
  AGENT_STATES,
  agentActivity,
  type WorkerAgents,
  controlPlaneActionJson,
  parseActivityDocument,
  parseControlPlaneActionDocument,
} from "../../src/domain/control-plane";

const AGENTS = [
  { id: "4f1c2a9e-0b7d-4c3e-9a51-6d2e8f0b1c3a", state: "working" as const, dispatched: true },
  { id: "a7e3", state: "needs_input" as const, dispatched: false },
  { id: "b8f4", state: "finished" as const, dispatched: true },
  { id: "c9a5", state: "failed" as const, dispatched: false },
  { id: "d0b6", state: "stopped" as const, dispatched: false },
];

describe("fffactory's agent states", () => {
  test("are its own five, naming no Paseo status", () => {
    expect(AGENT_STATES).toEqual(["working", "needs_input", "finished", "failed", "stopped"]);
  });

  test.each([
    [{ kind: "listed", agents: [] } as WorkerAgents, { kind: "idle" }],
    [{ kind: "listed", agents: AGENTS } as WorkerAgents, { kind: "active", count: 5 }],
    [
      { kind: "unknown", reason: "Paseo did not answer" } as WorkerAgents,
      { kind: "unknown", reason: "Paseo did not answer" },
    ],
  ])("the activity field counts every listed agent, whatever its state %#", (agents, activity) => {
    expect(agentActivity(agents)).toEqual(activity as ReturnType<typeof agentActivity>);
  });
});

describe("control-plane protocol documents", () => {
  test.each([
    [{ kind: "listed", agents: [] } as WorkerAgents, { kind: "idle" }, []],
    [{ kind: "listed", agents: AGENTS } as WorkerAgents, { kind: "active", count: 5 }, AGENTS],
    [
      { kind: "unknown", reason: "Paseo did not answer" } as WorkerAgents,
      { kind: "unknown", reason: "Paseo did not answer" },
      null,
    ],
  ])("round-trips the activity document %#", (agents, activity, list) => {
    expect(parseActivityDocument(activityJson(agents))).toEqual({
      ok: true,
      document: {
        protocol_version: 1,
        activity: activity as ReturnType<typeof agentActivity>,
        agents: list,
      },
    });
  });

  test("writes the agents beside the unchanged activity field, null when they could not be read", () => {
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

  test("still reads an older worker's answer without agents, its agents absent", () => {
    const parsed = parseActivityDocument(
      JSON.stringify({ protocol_version: 1, activity: { kind: "active", count: 2 } }),
    );
    expect(parsed).toEqual({
      ok: true,
      document: { protocol_version: 1, activity: { kind: "active", count: 2 } },
    });
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
    const parsed = parseActivityDocument(JSON.stringify({ protocol_version: 1, activity }));
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
