/**
 * A worker's agents as a person reads them, in status's `Agents:` line and under each worker
 * `worker inspect` reports (`docs/specs/status.md` §Output, `docs/specs/worker-lifecycle.md`
 * §Inspect), laid out from the `AgentActivity` the domain reports.
 */
import { AGENT_STATES, type AgentActivity, type AgentState } from "../../domain/control-plane";

/**
 * A state in words, as a count reads it (`2 working`, `1 needing input`) and as it labels the
 * agents listed in it (`needing input   agent-1`).
 */
export const STATE_WORDS: Readonly<Record<AgentState, string>> = {
  working: "working",
  needs_input: "needing input",
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
};

/** The agents in each state that has any, in fffactory's order of states. */
function byState(activity: AgentActivity) {
  const agents = activity.agents ?? [];
  return AGENT_STATES.map((state) => ({
    state,
    agents: agents.filter((agent) => agent.state === state),
  })).filter(({ agents: inState }) => inState.length > 0);
}

/**
 * Every agent counted by state, then the busy rule's verdict: `1 working, 2 finished (busy)`,
 * `none (idle)`; `unknown`, with why when the agents could not be read.
 */
export function agentsSummary(activity: AgentActivity): string {
  if (activity.agents === null)
    return activity.reason === null ? "unknown" : `unknown (${activity.reason})`;
  const counts = byState(activity).map(
    ({ state, agents }) => `${agents.length} ${STATE_WORDS[state]}`,
  );
  return `${counts.length === 0 ? "none" : counts.join(", ")} (${activity.state})`;
}

/**
 * Each state's agents by ID, those dispatch launched marked `(dispatched)`: the conversations a
 * removal would end, finished ones too.
 */
export function agentsByState(
  activity: AgentActivity,
): { readonly state: AgentState; readonly ids: readonly string[] }[] {
  return byState(activity).map(({ state, agents }) => ({
    state,
    ids: agents.map(({ id, dispatched }) => (dispatched ? `${id} (dispatched)` : id)),
  }));
}
