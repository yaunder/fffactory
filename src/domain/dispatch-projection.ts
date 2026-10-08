/** The versioned desired and observed dispatch documents exchanged with a worker. */
import type { DispatchGate } from "./dispatch-readiness";
import { DISPATCH_GATES } from "./dispatch-readiness";
import { HOST_PROTOCOL_VERSION, remoteCommand, WORKER_PATHS } from "./host-protocol";
import type { DispatchSettings } from "./instance";

export const DISPATCH_PROJECTION_PATH = "/var/lib/fffactory/dispatch.json";
export const DISPATCH_RESULT_PATH = "/var/lib/fffactory/dispatch-result.json";
export const INSPECT_DISPATCH_COMMAND = remoteCommand([
  "sudo",
  "-n",
  WORKER_PATHS.activator,
  "dispatch",
  "inspect",
]);

export interface DispatchSchedule {
  readonly cron: string;
  readonly timezone: string;
  readonly provider: string;
  readonly model: string;
  readonly mode: string;
  readonly cwd: string;
}

export interface DispatchProjection {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly hostname: string;
  readonly requested: boolean;
  readonly active: boolean;
  readonly blockers: readonly DispatchGate[];
  readonly schedule: DispatchSchedule | null;
}

export type DispatchInspection =
  | {
      readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
      readonly state: "none" | "unreadable";
    }
  | {
      readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
      readonly state: "not_requested" | "active";
      readonly blockers: readonly [];
      readonly changed: boolean;
    }
  | {
      readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
      readonly state: "pending";
      readonly blockers: readonly DispatchGate[];
      readonly changed: boolean;
    }
  | {
      readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
      readonly state: "failed";
      readonly blockers: readonly DispatchGate[];
      readonly reason: string;
    };

export type DispatchAdoption = {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly state: "passed" | "failed";
};

const NON_EMPTY = /\S/;
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

function absolutePath(value: string): boolean {
  return (
    value.startsWith("/") && !value.includes("\0") && !value.includes("\r") && !value.includes("\n")
  );
}

function scheduleOf(settings: DispatchSettings | undefined): DispatchSchedule | null {
  if (
    settings?.cron === undefined ||
    settings.timezone === undefined ||
    settings.provider === undefined ||
    settings.model === undefined ||
    settings.mode === undefined ||
    settings.cwd === undefined
  )
    return null;
  return {
    cron: settings.cron,
    timezone: settings.timezone,
    provider: settings.provider,
    model: settings.model,
    mode: settings.mode,
    cwd: settings.cwd,
  };
}

/** Builds the exact desired worker state. Completeness rejects an enabled incomplete schedule. */
export function dispatchProjection(
  hostname: string,
  settings: DispatchSettings | undefined,
  active: boolean,
  blockers: readonly DispatchGate[],
): DispatchProjection {
  const requested = settings?.enabled === true;
  const schedule = requested ? scheduleOf(settings) : null;
  if (requested && schedule === null) throw new Error("enabled dispatch settings are incomplete");
  if (active && (!requested || blockers.length > 0))
    throw new Error("active dispatch must be requested and unblocked");
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname,
    requested,
    active,
    blockers: [...blockers],
    schedule,
  };
}

export function dispatchProjectionJson(projection: DispatchProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function blockersOf(value: unknown): DispatchGate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (
    !value.every(
      (item) => typeof item === "string" && DISPATCH_GATES.includes(item as DispatchGate),
    )
  )
    return undefined;
  if (new Set(value).size !== value.length) return undefined;
  return value as DispatchGate[];
}

function scheduleFrom(value: unknown): DispatchSchedule | null | undefined {
  if (value === null) return null;
  const item = record(value);
  if (item === undefined) return undefined;
  const fields = ["cron", "timezone", "provider", "model", "mode", "cwd"] as const;
  if (
    !fields.every(
      (field) => typeof item[field] === "string" && NON_EMPTY.test(item[field] as string),
    )
  )
    return undefined;
  if (!absolutePath(String(item.cwd))) return undefined;
  return Object.fromEntries(
    fields.map((field) => [field, item[field]]),
  ) as unknown as DispatchSchedule;
}

export type DispatchProjectionParse =
  | { readonly ok: true; readonly projection: DispatchProjection }
  | { readonly ok: false; readonly reason: string };

type ProjectionHeader = Pick<DispatchProjection, "hostname" | "requested" | "active">;

function projectionHeader(
  item: Record<string, unknown>,
): { readonly header: ProjectionHeader } | { readonly reason: string } {
  if (item.protocol_version !== HOST_PROTOCOL_VERSION)
    return { reason: "the dispatch projection uses another protocol version" };
  if (typeof item.hostname !== "string" || !HOSTNAME.test(item.hostname))
    return { reason: "the dispatch projection has an invalid hostname" };
  if (typeof item.requested !== "boolean" || typeof item.active !== "boolean")
    return { reason: "the dispatch projection has invalid state" };
  return {
    header: { hostname: item.hostname, requested: item.requested, active: item.active },
  };
}

function dispatchStateFailure(header: ProjectionHeader, blockers: readonly DispatchGate[]) {
  if (header.active && (!header.requested || blockers.length > 0))
    return "active dispatch is not requested and unblocked";
  if (!header.requested && blockers.length > 0)
    return "dispatch blockers exist when dispatch is not requested";
  return header.requested && !header.active && blockers.length === 0
    ? "inactive requested dispatch has no blocker"
    : undefined;
}

function projectionFrom(item: Record<string, unknown>): DispatchProjectionParse {
  const checked = projectionHeader(item);
  if ("reason" in checked) return { ok: false, reason: checked.reason };
  const blockers = blockersOf(item.blockers);
  const schedule = scheduleFrom(item.schedule);
  if (blockers === undefined || schedule === undefined)
    return { ok: false, reason: "the dispatch projection has invalid settings" };
  const stateFailure = dispatchStateFailure(checked.header, blockers);
  if (stateFailure !== undefined) return { ok: false, reason: stateFailure };
  if (checked.header.requested !== (schedule !== null))
    return { ok: false, reason: "requested dispatch and its schedule disagree" };
  const projection: DispatchProjection = {
    protocol_version: HOST_PROTOCOL_VERSION,
    ...checked.header,
    blockers,
    schedule,
  };
  return { ok: true, projection };
}

export function parseDispatchProjection(text: string): DispatchProjectionParse {
  let item: Record<string, unknown> | undefined;
  try {
    item = record(JSON.parse(text));
  } catch {
    return { ok: false, reason: "the dispatch projection is not JSON" };
  }
  if (item === undefined)
    return { ok: false, reason: "the dispatch projection uses another protocol version" };
  const parsed = projectionFrom(item);
  if (!parsed.ok) return parsed;
  return dispatchProjectionJson(parsed.projection) === text
    ? parsed
    : { ok: false, reason: "the dispatch projection is not canonical" };
}

export function dispatchInspectionJson(inspection: DispatchInspection): string {
  return JSON.stringify(inspection, null, 2);
}

export function dispatchInspectionExitCode(inspection: DispatchInspection): 0 | 1 | 2 {
  if (inspection.state === "failed" || inspection.state === "unreadable") return 1;
  return inspection.state === "pending" || inspection.state === "none" ? 2 : 0;
}

function parsedInspection(
  item: Record<string, unknown>,
  blockers: DispatchGate[],
): DispatchInspection | undefined {
  const changed = typeof item.changed === "boolean" ? item.changed : undefined;
  if ((item.state === "not_requested" || item.state === "active") && blockers.length === 0)
    return changed === undefined
      ? undefined
      : {
          protocol_version: HOST_PROTOCOL_VERSION,
          state: item.state,
          blockers: [],
          changed,
        };
  if (item.state === "pending" && changed !== undefined && blockers.length > 0)
    return { protocol_version: HOST_PROTOCOL_VERSION, state: "pending", blockers, changed };
  if (item.state === "failed") return failedInspection(item.reason, blockers);
  return undefined;
}

function failedInspection(
  reason: unknown,
  blockers: DispatchGate[],
): DispatchInspection | undefined {
  return typeof reason === "string" && NON_EMPTY.test(reason)
    ? { protocol_version: HOST_PROTOCOL_VERSION, state: "failed", blockers, reason }
    : undefined;
}

export function parseDispatchInspection(text: string): DispatchInspection | undefined {
  let item: Record<string, unknown> | undefined;
  try {
    item = record(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (item === undefined || item.protocol_version !== HOST_PROTOCOL_VERSION) return undefined;
  if (item.state === "none" || item.state === "unreadable")
    return { protocol_version: HOST_PROTOCOL_VERSION, state: item.state };
  const blockers = blockersOf(item.blockers);
  return blockers === undefined ? undefined : parsedInspection(item, blockers);
}

export function dispatchAdoptionJson(adoption: DispatchAdoption): string {
  return JSON.stringify(adoption, null, 2);
}

export function dispatchAdoptionExitCode(adoption: DispatchAdoption): 0 | 2 {
  return adoption.state === "passed" ? 0 : 2;
}

export function parseDispatchAdoption(text: string): DispatchAdoption | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const item = record(value);
  return item?.protocol_version === HOST_PROTOCOL_VERSION &&
    (item.state === "passed" || item.state === "failed")
    ? { protocol_version: HOST_PROTOCOL_VERSION, state: item.state }
    : undefined;
}
