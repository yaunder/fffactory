/**
 * `fffactory worker inspect`'s verdict (`docs/specs/worker-lifecycle.md` §Inspect): whether
 * terminate would remove a worker without `--force`, judged by terminate's own gates
 * (`removalGate`) over terminate's own inspection, and the inspection document it prints for each
 * worker (`schemas/worker-inspection.schema.json`), which removal records carry as it is. The
 * document names no next action: that is the command's that judged it, never the worker's. Pure:
 * `application/worker-removability.ts` makes the observations.
 */
import { type AgentActivity, type AgentsObservation, agentActivity } from "./control-plane";
import type { HostKey } from "./instance";
import type { WorkerIdentity } from "./rollout";
import type { Then } from "./status";
import {
  CHECK_STATUS,
  forcedUninspected,
  GONE,
  outdatedReplacement,
  type Refusal,
  type RemovalGateActions,
  removalGate,
  STOPPED_UNINSPECTED,
  type TerminateInspection,
  workerCommandLine,
} from "./worker-lifecycle";

/** Why a worker was not inspected, as terminate passes it: its gates never run for it. */
export const NOT_INSPECTED = ["stopped", "shutting_down", "absent", "forced"] as const;
export type NotInspected = (typeof NOT_INSPECTED)[number];

/**
 * Whether terminate would remove the worker without `--force` (`removable`), its gates refuse it
 * (`refused`, a worker that could not be inspected among them), or they never run for it
 * (`not_inspected`).
 */
export type RemovalVerdict = "removable" | "refused" | "not_inspected";

/**
 * One worker's inspection document: its verdict, why it was not inspected, the findings in
 * fffactory's words (a refusal's summary and details), and its agents, each in its state,
 * finished ones too: the conversations a removal would end. The same whichever command judged
 * it, so a removal record carries it as `worker inspect --json` prints it.
 */
export interface RemovalInspection {
  readonly key: HostKey;
  readonly hostname: string;
  readonly verdict: RemovalVerdict;
  /** Null unless the verdict is `not_inspected`. */
  readonly not_inspected: NotInspected | null;
  readonly summary: string;
  readonly details: readonly string[];
  readonly activity: AgentActivity;
}

/**
 * One worker as `worker inspect --json` reports it: its inspection document, and the next action
 * of a refusal, completed by the `RemovalGateActions` of the command that judged it.
 */
export interface WorkerRemovability {
  readonly inspection: RemovalInspection;
  /** Null unless the verdict is `refused`. */
  readonly next_action: string | null;
}

/**
 * What a removal saw of a worker: terminate's own inspection, or what its machine alone decides
 * before any gate: being terminated already (`shutting_down`), gone (`absent`), or refused by
 * terminate's machine rules (`machine`: the inventory unreadable, several instances, a machine on
 * its way to running or stopped).
 */
export type RemovalObservation =
  | TerminateInspection
  | { readonly kind: "shutting_down" }
  | { readonly kind: "absent" }
  | { readonly kind: "machine"; readonly refusal: Refusal };

/** Completes a next action by rerunning `worker inspect` for the same host. */
export function thenRerunInspect(key: HostKey): Then {
  return (step) => `${step}, then rerun \`fffactory worker inspect ${key}\`.`;
}

/**
 * The next actions of terminate's gates when `worker inspect` reports them: inspect again, or
 * terminate the worker with `--force`, which removes its host; a worker on a release from before
 * agent states is replaced instead, keeping its host (`outdatedReplacement`, D4).
 */
export function inspectGateActions(key: HostKey): RemovalGateActions {
  const terminate = `\`${workerCommandLine("terminate", key)} --force\``;
  const rerun = `\`fffactory worker inspect ${key}\``;
  return {
    orForce: (step, how) =>
      `${step}, then rerun ${rerun}, or terminate it ${how} with ${terminate}.`,
    unlocated:
      `${thenRerunInspect(key)(CHECK_STATUS)} If the instance's EC2 console output shows its ` +
      `bootstrap failed, it never joined the tailnet: ${terminate} terminates it uninspected.`,
    forced: `terminate it with --force: ${terminate}.`,
    outdated: outdatedReplacement(key),
  };
}

const NOT_INSPECTED_SUMMARIES: Readonly<Record<NotInspected, string>> = {
  stopped: STOPPED_UNINSPECTED,
  shutting_down: "The machine is already being terminated: the worker is not inspected.",
  absent: GONE,
  forced: forcedUninspected("terminate"),
};

/** The agents an inspection read: none when it never asked for them. */
function agentsOf(inspection: RemovalObservation): AgentsObservation | undefined {
  switch (inspection.kind) {
    case "activity":
      return inspection.agents;
    case "inspected":
      return { kind: "listed", agents: inspection.agents };
    default:
      return undefined;
  }
}

/** A worker the gates never ran for, and why. */
function notInspected(
  worker: WorkerIdentity,
  why: NotInspected,
  activity: AgentActivity,
): WorkerRemovability {
  return {
    inspection: {
      key: worker.key,
      hostname: worker.hostname,
      verdict: "not_inspected",
      not_inspected: why,
      summary: NOT_INSPECTED_SUMMARIES[why],
      details: [],
      activity,
    },
    next_action: null,
  };
}

/** A worker the gates judged: refused by `refusal`, or removable without one. */
function judged(
  worker: WorkerIdentity,
  refusal: Refusal | undefined,
  activity: AgentActivity,
): WorkerRemovability {
  const identity = { key: worker.key, hostname: worker.hostname, not_inspected: null };
  if (refusal === undefined)
    return {
      inspection: {
        ...identity,
        verdict: "removable",
        summary:
          `${worker.hostname} can be terminated: no agent is working or needs input, and no ` +
          "work or checkout would be lost",
        details: [],
        activity,
      },
      next_action: null,
    };
  return {
    inspection: {
      ...identity,
      verdict: "refused",
      summary: refusal.summary,
      details: [...refusal.details],
      activity,
    },
    next_action: refusal.nextAction,
  };
}

/**
 * The inspection document of `worker` as `observed`, judged by terminate's gates
 * (`removalGate`), and a refusal's next action, completed by `actions`: inspect's own
 * (`inspectGateActions`), or the removal's that records the document. Only the next action
 * depends on `actions`.
 */
export function workerRemovability(
  worker: WorkerIdentity,
  observed: RemovalObservation,
  actions: RemovalGateActions,
): WorkerRemovability {
  const activity = agentActivity(agentsOf(observed));
  switch (observed.kind) {
    case "stopped":
    case "shutting_down":
    case "absent":
    case "forced":
      return notInspected(worker, observed.kind, activity);
    case "machine":
      return judged(worker, observed.refusal, activity);
    default:
      return judged(worker, removalGate(observed, worker, actions), activity);
  }
}

/**
 * 0 when every worker inspected is removable, 2 when any is refused, one whose agents or work
 * could not be read among them; one not inspected counts not.
 */
export function removalExitCode(workers: readonly WorkerRemovability[]): number {
  return workers.some(({ inspection }) => inspection.verdict === "refused") ? 2 : 0;
}
