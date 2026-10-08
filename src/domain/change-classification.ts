/**
 * Control-plane change classification (pure; `docs/specs/control-plane.md`). Paseo agents may
 * run for days, and restarting the pinned Paseo daemon terminates their active turns, provider
 * processes, managed terminals and background commands. So every plan classifies each change it
 * would make to a worker's control plane:
 *
 * - **live** changes (schedules, repositories, the dispatch helper, skills, most
 *   configuration) take effect without touching the daemon and never interrupt an agent;
 * - a **reload-safe** change (a reloadable Paseo configuration) uses Paseo's reload;
 * - a **maintenance** change (the Paseo package, its service definition, its listen address,
 *   its password, a host reboot) cannot be made without restarting the daemon.
 *
 * When a maintenance change is needed while agents are active, apply leaves the worker on its
 * complete current release, marks the change pending and moves on, never interrupting the
 * agents; a later apply completes it once the agents are closed. This module decides those
 * actions from the changes and whether agents are active; `application/apply-control-plane.ts`
 * drives the `ControlPlane` port from them, and never touches a worker itself.
 */

/** How a change reaches a worker: live, by reloading the daemon, or only by restarting it. */
export type ChangeClass = "live" | "reload-safe" | "maintenance";

/**
 * Every kind of control-plane change a plan can make, each mapped to its class below. The
 * classification table is closed: a new kind of change is one more entry here and in the spec.
 */
export const CHANGE_TYPES = [
  "schedule",
  "repository",
  "dispatch-helper",
  "skill",
  "configuration",
  "paseo-configuration",
  "paseo-package",
  "service-definition",
  "listen-address",
  "password",
  "reboot",
] as const;

export type ChangeType = (typeof CHANGE_TYPES)[number];

/** The spec's classification table: every change type to the class that carries it. */
const CLASSIFICATION: Readonly<Record<ChangeType, ChangeClass>> = {
  schedule: "live",
  repository: "live",
  "dispatch-helper": "live",
  skill: "live",
  configuration: "live",
  "paseo-configuration": "reload-safe",
  "paseo-package": "maintenance",
  "service-definition": "maintenance",
  "listen-address": "maintenance",
  password: "maintenance",
  reboot: "maintenance",
};

/** The class that carries `type`, straight from the table. */
export function classifyChange(type: ChangeType): ChangeClass {
  return CLASSIFICATION[type];
}

/**
 * What apply does with a worker's maintenance changes: none to make, apply them now (the daemon
 * may restart), or leave them pending because agents are active and must not be interrupted.
 */
export type MaintenanceDecision =
  | { readonly kind: "none" }
  | { readonly kind: "apply"; readonly changes: readonly ChangeType[] }
  | { readonly kind: "deferred"; readonly pending: readonly ChangeType[] };

/** The actions a worker's planned changes call for, given whether agents are active on it. */
export interface ControlPlaneActions {
  /** Live changes, taken without touching the daemon; they never interrupt an agent. */
  readonly live: readonly ChangeType[];
  /** Whether a reloadable configuration change means the daemon should reload. */
  readonly reload: boolean;
  /** Whether the daemon must restart now, or that is deferred while agents are active. */
  readonly maintenance: MaintenanceDecision;
}

/**
 * Decides, for one worker, what its changes call for. Maintenance changes are applied only when
 * no agents are active; otherwise they are deferred, the worker left on its complete current
 * release. A restart (an applied maintenance change) already reloads configuration, so a
 * reload-safe change reloads only when the daemon is not restarting now; a deferred maintenance
 * change does not stop a reload-safe change from reloading.
 */
export function controlPlaneActions(
  changes: readonly ChangeType[],
  agentsActive: boolean,
): ControlPlaneActions {
  const ofClass = (wanted: ChangeClass) =>
    changes.filter((type) => classifyChange(type) === wanted);
  const live = ofClass("live");
  const reloadSafe = ofClass("reload-safe");
  const maintenanceChanges = ofClass("maintenance");
  const maintenance: MaintenanceDecision =
    maintenanceChanges.length === 0
      ? { kind: "none" }
      : agentsActive
        ? { kind: "deferred", pending: maintenanceChanges }
        : { kind: "apply", changes: maintenanceChanges };
  const reload = reloadSafe.length > 0 && maintenance.kind !== "apply";
  return { live, reload, maintenance };
}

/**
 * How apply reports a worker's deferred maintenance, wherever it defers it: before activation
 * or in the control-plane stage. Activity that could not be read defers like active activity,
 * so the words are that agents *may* be active (`docs/specs/control-plane.md` §Pre-activation
 * deferral).
 */
export function maintenanceDeferral(
  hostname: string,
  pending: readonly ChangeType[],
): { readonly summary: string; readonly nextAction: string } {
  return {
    summary: `Maintenance (${pending.join(", ")}) was deferred while agents may be active on ${hostname}; it stays on its complete current release`,
    nextAction: closeActiveAgents(hostname),
  };
}

/**
 * How the workers stage skips, and the dispatch stage then leaves, a worker whose maintenance was
 * deferred before activation (`docs/specs/dispatch.md` §Skipped workers).
 */
export function preActivationDeferral(hostname: string): {
  readonly summary: string;
  readonly nextAction: string;
} {
  return {
    summary: "Paseo maintenance is deferred while agents may be active",
    nextAction: closeActiveAgents(hostname),
  };
}

/** The next action of every deferral: close the agents, then rerun apply to complete it. */
export function closeActiveAgents(hostname: string): string {
  return `Close the active agents on ${hostname}, then rerun \`fffactory apply\``;
}
