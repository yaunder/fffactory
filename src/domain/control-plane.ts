import {
  array,
  type DocumentParse,
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

/**
 * A worker's agents as the CLI read them: its adapter's answer, or `outdated`, an answer without
 * the agent list from a worker whose release predates agent states, which the CLI refuses
 * (`docs/specs/control-plane.md` §Agent states).
 */
export type AgentsObservation = WorkerAgents | { readonly kind: "outdated" };

/** Why an outdated worker's agents are unknown. */
export const OUTDATED_AGENTS = "its release predates fffactory's agent states";

/**
 * A worker's activity by the busy rule: `busy` while any agent is `working` or `needs_input`,
 * counting each; `idle` when none is; `unknown` when its agents could not be read, and
 * `outdated` too when its release answered without them.
 */
export type WorkerActivity =
  | { readonly kind: "idle" }
  | { readonly kind: "busy"; readonly working: number; readonly needsInput: number }
  | { readonly kind: "unknown"; readonly reason: string; readonly outdated: boolean };

/** Activity that keeps a worker from maintenance or removal: agents busy, or unreadable. */
export type BlockingActivity = Exclude<WorkerActivity, { readonly kind: "idle" }>;

/** The busy rule: only `working` and `needs_input` agents count; the other states never do. */
export function workerActivity(agents: AgentsObservation): WorkerActivity {
  switch (agents.kind) {
    case "outdated":
      return { kind: "unknown", reason: OUTDATED_AGENTS, outdated: true };
    case "unknown":
      return { kind: "unknown", reason: agents.reason, outdated: false };
    case "listed": {
      const count = (state: AgentState) =>
        agents.agents.filter((agent) => agent.state === state).length;
      const working = count("working");
      const needsInput = count("needs_input");
      return working + needsInput === 0 ? { kind: "idle" } : { kind: "busy", working, needsInput };
    }
  }
}

function agentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}

/**
 * How many agents are busy on `hostname`, and how, in fffactory's words: `2 agents are working
 * and 1 needs input on HOSTNAME`.
 */
export function busyAgents(
  activity: Extract<WorkerActivity, { readonly kind: "busy" }>,
  hostname: string,
): string {
  const { working, needsInput } = activity;
  const needing = `${needsInput === 1 ? "needs" : "need"} input`;
  if (working === 0) return `${agentCount(needsInput)} ${needing} on ${hostname}`;
  const workingWords = `${agentCount(working)} ${working === 1 ? "is" : "are"} working`;
  if (needsInput === 0) return `${workingWords} on ${hostname}`;
  return `${workingWords} and ${needsInput} ${needing} on ${hostname}`;
}

/**
 * The activity document's `activity` field: the busy rule's verdict, `active` counting the busy
 * agents. The CLI reads only the agents, and this field's reason when they could not be read.
 */
type ActivityField =
  | { readonly kind: "idle" }
  | { readonly kind: "active"; readonly count: number }
  | { readonly kind: "unknown"; readonly reason: string };

export type ControlPlaneAction =
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly reason: string };

export interface ActivityDocument {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly activity: ActivityField;
  /** The worker's agents, `null` exactly when `activity` is unknown. */
  readonly agents: readonly Agent[] | null;
}

export interface ControlPlaneActionDocument {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly result: ControlPlaneAction;
}

function activityField(agents: WorkerAgents): ActivityField {
  const activity = workerActivity(agents);
  switch (activity.kind) {
    case "idle":
      return { kind: "idle" };
    case "busy":
      return { kind: "active", count: activity.working + activity.needsInput };
    case "unknown":
      return { kind: "unknown", reason: activity.reason };
  }
}

export function activityJson(agents: WorkerAgents): string {
  const document: ActivityDocument = {
    protocol_version: HOST_PROTOCOL_VERSION,
    activity: activityField(agents),
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

function readActivity(value: unknown): ActivityField {
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

function readAgents(value: unknown, activity: ActivityField): WorkerAgents {
  if ((value === null) !== (activity.kind === "unknown"))
    throw new Invalid("agents is null only when activity is unknown");
  if (activity.kind === "unknown") return { kind: "unknown", reason: activity.reason };
  return {
    kind: "listed",
    agents: array(value, "agents").map((agent, index) => readAgent(agent, `agents[${index}]`)),
  };
}

function readAction(value: unknown): ControlPlaneAction {
  const result = record(value, "result");
  if (result.kind === "done") return { kind: "done" };
  if (result.kind === "failed")
    return { kind: "failed", reason: reason(result.reason, "result.reason") };
  throw new Invalid("result.kind is not a known state");
}

/** Reading an activity answer: the worker's agents, or why the answer was refused. */
export type ActivityParse =
  | DocumentParse<WorkerAgents>
  /** A valid answer without `agents`, from a worker whose release predates agent states. */
  | { readonly ok: false; readonly kind: "outdated" };

/**
 * Reads an activity document into the worker's agents, which alone the CLI decides from: the
 * `activity` field is checked, and read only for its reason when the agents could not be read.
 * An answer without `agents` is refused as `outdated`, never read by its count (D4).
 */
export function parseActivityDocument(text: string): ActivityParse {
  const parsed = parseVersioned(text, (document) => {
    const activity = readActivity(document.activity);
    return document.agents === undefined ? undefined : readAgents(document.agents, activity);
  });
  if (!parsed.ok) return parsed;
  return parsed.document === undefined
    ? { ok: false, kind: "outdated" }
    : { ok: true, document: parsed.document };
}

export function parseControlPlaneActionDocument(text: string) {
  return parseVersioned(text, (document) => ({
    protocol_version: HOST_PROTOCOL_VERSION,
    result: readAction(document.result),
  }));
}
