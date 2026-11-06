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
 * When a maintenance change is needed while agents are busy, or may be, apply leaves the worker on
 * its complete current release, marks the change pending and moves on, never interrupting the
 * agents; a later apply completes it once none is busy. This module decides those actions from
 * the changes and the worker's activity by the busy rule (`domain/control-plane.ts`);
 * `application/apply-control-plane.ts` drives the `ControlPlane` port from them, and never
 * touches a worker itself.
 */
import type { BlockingActivity, WorkerActivity } from "./control-plane";
import { busyAgents } from "./control-plane";
import type { WorkerIdentity } from "./rollout";
import { replaceOutdatedWorker } from "./worker-lifecycle";

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
 * may restart), or leave them pending because agents are busy, or may be (`activity`), and must
 * not be interrupted.
 */
export type MaintenanceDecision =
  | { readonly kind: "none" }
  | { readonly kind: "apply"; readonly changes: readonly ChangeType[] }
  | {
      readonly kind: "deferred";
      readonly pending: readonly ChangeType[];
      readonly activity: BlockingActivity;
    };

/** The actions a worker's planned changes call for, given its activity. */
export interface ControlPlaneActions {
  /** Live changes, taken without touching the daemon; they never interrupt an agent. */
  readonly live: readonly ChangeType[];
  /** Whether a reloadable configuration change means the daemon should reload. */
  readonly reload: boolean;
  /** Whether the daemon must restart now, or that is deferred while agents may be busy. */
  readonly maintenance: MaintenanceDecision;
}

/**
 * Decides, for one worker, what its changes call for. Maintenance changes are applied only when
 * the worker is idle by the busy rule; busy or unknown, they are deferred, the worker left on
 * its complete current release. A restart (an applied maintenance change) already reloads
 * configuration, so a reload-safe change reloads only when the daemon is not restarting now; a
 * deferred maintenance change does not stop a reload-safe change from reloading.
 */
export function controlPlaneActions(
  changes: readonly ChangeType[],
  activity: WorkerActivity,
): ControlPlaneActions {
  const ofClass = (wanted: ChangeClass) =>
    changes.filter((type) => classifyChange(type) === wanted);
  const live = ofClass("live");
  const reloadSafe = ofClass("reload-safe");
  const maintenanceChanges = ofClass("maintenance");
  const maintenance: MaintenanceDecision =
    maintenanceChanges.length === 0
      ? { kind: "none" }
      : activity.kind === "idle"
        ? { kind: "apply", changes: maintenanceChanges }
        : { kind: "deferred", pending: maintenanceChanges, activity };
  const reload = reloadSafe.length > 0 && maintenance.kind !== "apply";
  return { live, reload, maintenance };
}

/** How apply reports a deferral: what was deferred and why, and what to do next. */
export interface Deferral {
  readonly summary: string;
  readonly nextAction: string;
}

/**
 * How apply reports a worker's deferred maintenance, wherever it defers it: before activation
 * or in the control-plane stage (`docs/specs/control-plane.md` §Pre-activation deferral). Busy
 * agents are named, how many of each, and waited for; agents that could not be read may be busy,
 * and the worker is checked, or, on a release from before agent states, replaced (D4).
 */
export function maintenanceDeferral(
  worker: WorkerIdentity,
  pending: readonly ChangeType[],
  activity: BlockingActivity,
): Deferral {
  const { hostname } = worker;
  const why =
    activity.kind === "busy"
      ? busyAgents(activity, hostname)
      : `agents may be busy on ${hostname} (${activity.reason})`;
  return {
    summary: `Maintenance (${pending.join(", ")}) was deferred while ${why}; it stays on its complete current release`,
    nextAction: deferralAction(worker, activity),
  };
}

function deferralAction(worker: WorkerIdentity, activity: BlockingActivity): string {
  if (activity.kind === "busy")
    return `Wait until no agent on ${worker.hostname} is working or needs input, then rerun \`fffactory apply\``;
  if (activity.outdated) return replaceOutdatedWorker(worker);
  return "Check the worker with `fffactory status`, then rerun `fffactory apply`";
}

/**
 * How the workers stage skips, and the dispatch stage then leaves, a worker whose maintenance was
 * deferred before activation (`docs/specs/dispatch.md` §Skipped workers): the deferral's own
 * next action, so it is said once.
 */
export function preActivationDeferral(deferral: Deferral): Deferral {
  return {
    summary: "Paseo maintenance is deferred while agents may be busy",
    nextAction: deferral.nextAction,
  };
}
