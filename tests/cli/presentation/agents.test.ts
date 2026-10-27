import { describe, expect, test } from "bun:test";
import { agentActivity, type AgentState } from "../../../src/domain/control-plane";
import { agentsByState, agentsSummary } from "../../../src/cli/presentation/agents";

/** A worker listing one agent in each of `states`, the first dispatched. */
function listed(...states: AgentState[]) {
  return agentActivity({
    kind: "listed",
    agents: states.map((state, index) => ({
      id: `agent-${index + 1}`,
      state,
      dispatched: index === 0,
    })),
  });
}

describe("a worker's agents in one line (status §Output, worker-lifecycle §Inspect)", () => {
  test("counts each state in fffactory's order, then the busy rule's verdict", () => {
    expect(agentsSummary(listed("finished", "working", "finished"))).toBe(
      "1 working, 2 finished (busy)",
    );
    expect(agentsSummary(listed("needs_input", "stopped", "failed", "needs_input"))).toBe(
      "2 needing input, 1 failed, 1 stopped (busy)",
    );
    expect(agentsSummary(listed("finished"))).toBe("1 finished (idle)");
  });

  test("a worker with no agent has none, and is idle", () => {
    expect(agentsSummary(listed())).toBe("none (idle)");
  });

  test("agents not read are unknown, saying why when they could not be", () => {
    expect(agentsSummary(agentActivity(undefined))).toBe("unknown");
    expect(agentsSummary(agentActivity({ kind: "outdated" }))).toBe(
      "unknown (its release predates fffactory's agent states)",
    );
  });
});

describe("a worker's agents listed by state (worker-lifecycle §Inspect)", () => {
  test("each state's agents by ID, those dispatch launched marked, in fffactory's order", () => {
    expect(agentsByState(listed("finished", "working", "finished"))).toEqual([
      { state: "working", ids: ["agent-2"] },
      { state: "finished", ids: ["agent-1 (dispatched)", "agent-3"] },
    ]);
  });

  test("none when the agents were not listed, or there are none", () => {
    expect(agentsByState(listed())).toEqual([]);
    expect(agentsByState(agentActivity(undefined))).toEqual([]);
  });
});
