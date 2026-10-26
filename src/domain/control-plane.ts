import {
  array,
  HOST_PROTOCOL_VERSION,
  Invalid,
  oneOf,
  parseVersioned,
  record,
  string,
} from "./protocol-fields";

/**
 * fffactory's own agent states (`docs/specs/control-plane.md` §Agent states): mid-task,
 * blocked on a person approving something, its turn ended, its turn errored, not loaded.
 * They name no runtime's statuses; only the worker's adapter translates those.
 */
export const AGENT_STATES = ["working", "needs_input", "finished", "failed", "stopped"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** One agent on a worker: its ID, its state, and whether dispatch launched it. */
export interface Agent {
  readonly id: string;
  readonly state: AgentState;
  readonly dispatched: boolean;
}

/** An agent's ID: a short token that cannot be read as an option. */
export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A worker's agents as its adapter read them, or why they could not be read. */
export type WorkerAgents =
  | { readonly kind: "listed"; readonly agents: readonly Agent[] }
  | { readonly kind: "unknown"; readonly reason: string };

export type AgentActivity =
  | { readonly kind: "idle" }
  | { readonly kind: "active"; readonly count: number }
  | { readonly kind: "unknown"; readonly reason: string };

export type ControlPlaneAction =
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly reason: string };

export interface ActivityDocument {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly activity: AgentActivity;
  /**
   * The worker's agents, `null` exactly when `activity` is unknown. Absent from the answer of
   * a worker on a release from before agent states.
   */
  readonly agents?: readonly Agent[] | null;
}

export interface ControlPlaneActionDocument {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly result: ControlPlaneAction;
}

/** The document's `activity` field, as before agent states: every listed agent counts. */
export function agentActivity(agents: WorkerAgents): AgentActivity {
  if (agents.kind === "unknown") return { kind: "unknown", reason: agents.reason };
  return agents.agents.length === 0
    ? { kind: "idle" }
    : { kind: "active", count: agents.agents.length };
}

export function activityJson(agents: WorkerAgents): string {
  const document: ActivityDocument = {
    protocol_version: HOST_PROTOCOL_VERSION,
    activity: agentActivity(agents),
    agents:
      agents.kind === "listed"
        ? agents.agents.map(({ id, state, dispatched }) => ({ id, state, dispatched }))
        : null,
  };
  return JSON.stringify(document, null, 2);
}

export function controlPlaneActionJson(result: ControlPlaneAction): string {
  return JSON.stringify({ protocol_version: HOST_PROTOCOL_VERSION, result }, null, 2);
}

function reason(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200)
    throw new Invalid(`${field} is not a short reason`);
  return value;
}

function readActivity(value: unknown): AgentActivity {
  const activity = record(value, "activity");
  if (activity.kind === "idle") return { kind: "idle" };
  if (activity.kind === "active") {
    if (!Number.isSafeInteger(activity.count) || (activity.count as number) < 1)
      throw new Invalid("activity.count is not a positive count");
    return { kind: "active", count: activity.count as number };
  }
  if (activity.kind === "unknown")
    return { kind: "unknown", reason: reason(activity.reason, "activity.reason") };
  throw new Invalid("activity.kind is not a known state");
}

function readAgent(value: unknown, path: string): Agent {
  const agent = record(value, path);
  if (typeof agent.dispatched !== "boolean")
    throw new Invalid(`${path}.dispatched must be a boolean`);
  return {
    id: string(agent.id, `${path}.id`, AGENT_ID),
    state: oneOf(agent.state, `${path}.state`, AGENT_STATES),
    dispatched: agent.dispatched,
  };
}

function readAgents(value: unknown, activity: AgentActivity): readonly Agent[] | null {
  if ((value === null) !== (activity.kind === "unknown"))
    throw new Invalid("agents is null only when activity is unknown");
  if (value === null) return null;
  return array(value, "agents").map((agent, index) => readAgent(agent, `agents[${index}]`));
}

function readAction(value: unknown): ControlPlaneAction {
  const result = record(value, "result");
  if (result.kind === "done") return { kind: "done" };
  if (result.kind === "failed")
    return { kind: "failed", reason: reason(result.reason, "result.reason") };
  throw new Invalid("result.kind is not a known state");
}

export function parseActivityDocument(text: string) {
  return parseVersioned(text, (document): ActivityDocument => {
    const activity = readActivity(document.activity);
    // TODO(re-evaluate when #99 lands): refuse an answer without `agents`, an older worker's.
    if (document.agents === undefined) return { protocol_version: HOST_PROTOCOL_VERSION, activity };
    return {
      protocol_version: HOST_PROTOCOL_VERSION,
      activity,
      agents: readAgents(document.agents, activity),
    };
  });
}

export function parseControlPlaneActionDocument(text: string) {
  return parseVersioned(text, (document) => ({
    protocol_version: HOST_PROTOCOL_VERSION,
    result: readAction(document.result),
  }));
}
