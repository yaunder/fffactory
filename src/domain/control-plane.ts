import { HOST_PROTOCOL_VERSION, Invalid, parseVersioned, record } from "./protocol-fields";

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
}

export interface ControlPlaneActionDocument {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly result: ControlPlaneAction;
}

export function activityJson(activity: AgentActivity): string {
  return JSON.stringify({ protocol_version: HOST_PROTOCOL_VERSION, activity }, null, 2);
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

function readAction(value: unknown): ControlPlaneAction {
  const result = record(value, "result");
  if (result.kind === "done") return { kind: "done" };
  if (result.kind === "failed")
    return { kind: "failed", reason: reason(result.reason, "result.reason") };
  throw new Invalid("result.kind is not a known state");
}

export function parseActivityDocument(text: string) {
  return parseVersioned(text, (document) => ({
    protocol_version: HOST_PROTOCOL_VERSION,
    activity: readActivity(document.activity),
  }));
}

export function parseControlPlaneActionDocument(text: string) {
  return parseVersioned(text, (document) => ({
    protocol_version: HOST_PROTOCOL_VERSION,
    result: readAction(document.result),
  }));
}
