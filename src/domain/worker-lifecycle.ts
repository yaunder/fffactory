/**
 * `fffactory worker stop|start`'s rules (`docs/specs/worker-lifecycle.md`): the one EC2
 * instance a command acts on, what each EC2 state means for an action, stop's gates, the
 * confirmation rule, the bounded waits, and the words of every refusal and next action. Pure:
 * `application/worker-lifecycle.ts` makes the observations and the calls.
 */
import type { AgentActivity } from "./control-plane";
import { type FactoryInstance, type HostKey, parseHostKey } from "./instance";
import type { WorkerIdentity } from "./rollout";
import type { Machine, MachineInventory, MachineState, Then, Verdict } from "./status";

/** The power commands this module rules. Terminate is a later task's. */
export type PowerAction = "stop" | "start";

/** The operation each action holds the factory lock as, and names its record by. */
export const WORKER_OPERATIONS: Readonly<Record<PowerAction, string>> = {
  stop: "worker-stop",
  start: "worker-start",
};

/** The EC2 state each action brings the machine to. */
export const TARGET_STATE: Readonly<Record<PowerAction, MachineState>> = {
  stop: "stopped",
  start: "running",
};

/** How long an action waits for its target state: EC2 stops and starts take minutes. */
export const POWER_DEADLINE_MS = 10 * 60_000;
/** Between two reads of the machine's state while waiting for the target state. */
export const POWER_POLL_MS = 5_000;
/** How long start waits, once the machine runs, for its tailnet device to come online. */
export const ONLINE_DEADLINE_MS = 5 * 60_000;
/** Between two reads of the tailnet view while start waits for the device. */
export const ONLINE_POLL_MS = 15_000;

/** Why a command refused or failed, in fffactory's words, its next action complete. */
export interface Refusal {
  readonly summary: string;
  readonly details: readonly string[];
  readonly nextAction: string;
}

/** Completes a next action by rerunning the same command for the same host. */
export function thenRerunWorker(action: PowerAction, key: HostKey): Then {
  return (step) => `${step}, then rerun \`fffactory worker ${action} ${key}\`.`;
}

function refusal(summary: string, nextAction: string, details: readonly string[] = []): Refusal {
  return { summary, details, nextAction };
}

/**
 * Why `argument` does not name a host factory.json declares, or undefined when it does. An
 * argument that is not a well-formed host key is never echoed: it could be a pasted secret.
 */
export function hostKeyRefusal(argument: string, instance: FactoryInstance): Refusal | undefined {
  const parsed = parseHostKey(argument);
  if (!parsed.ok)
    return refusal(
      "The KEY argument is not a host key",
      "Name a host factory.json declares (hosts[].key)",
      [parsed.message],
    );
  const keys = (instance.hosts ?? []).map((host) => host.key);
  if (keys.includes(parsed.value)) return undefined;
  return refusal(
    `factory.json declares no host ${parsed.value}`,
    "Name a host factory.json declares (hosts[].key)",
    [keys.length === 0 ? "factory.json declares no hosts" : `Declared hosts: ${keys.join(", ")}`],
  );
}

export type MachineSelection =
  | { readonly kind: "found"; readonly machine: Machine }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** The one instance carrying `key`: none, or several, is refused, never guessed. */
export function selectMachine(
  inventory: MachineInventory,
  key: HostKey,
  action: PowerAction,
): MachineSelection {
  const then = thenRerunWorker(action, key);
  const refused = (summary: string, step: string, details: readonly string[] = []) =>
    ({ kind: "refused", refusal: refusal(summary, then(step), details) }) as const;
  if (inventory.kind === "unavailable")
    return refused(
      inventory.reason,
      "Check your network connection and that the credentials may call ec2:DescribeInstances",
    );
  const machines = inventory.machines.filter((machine) => machine.hostKey === key);
  const [only] = machines;
  if (only === undefined)
    return refused(
      `No EC2 instance carries the host key ${key}`,
      "Provision it with `fffactory apply`",
    );
  if (machines.length > 1)
    return refused(
      `${machines.length} EC2 instances carry the host key ${key}; fffactory never guesses which is the worker`,
      "Find the instance that is not this worker in the EC2 console and remove it yourself",
      machines.map((machine) => `Instance: ${machine.instanceId}`),
    );
  return { kind: "found", machine: only };
}

/**
 * What an action does with the machine as it is: request the change (`act`), only wait for one
 * already under way (`await`), nothing (`done`, a no-op success), or refuse.
 */
export type PowerStep =
  | { readonly kind: "act" }
  | { readonly kind: "await" }
  | { readonly kind: "done" }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** The state each action acts on, and the one it only waits through. */
const STEPS: Readonly<
  Record<PowerAction, { readonly act: MachineState; readonly await: MachineState }>
> = {
  stop: { act: "running", await: "stopping" },
  start: { act: "stopped", await: "pending" },
};

/** The state an action refuses until the machine has got past it, and what to wait for. */
const IN_PASSING: Readonly<
  Record<PowerAction, { readonly state: MachineState; readonly until: string }>
> = {
  stop: { state: "pending", until: "Wait until it is running" },
  start: { state: "stopping", until: "Wait until it has stopped" },
};

export function powerStep(action: PowerAction, machine: Machine, key: HostKey): PowerStep {
  const { state, instanceId } = machine;
  if (state === TARGET_STATE[action]) return { kind: "done" };
  if (state === STEPS[action].act) return { kind: "act" };
  if (state === STEPS[action].await) return { kind: "await" };
  const then = thenRerunWorker(action, key);
  if (state === IN_PASSING[action].state)
    return {
      kind: "refused",
      refusal: refusal(`EC2 instance ${instanceId} is ${state}`, then(IN_PASSING[action].until)),
    };
  return {
    kind: "refused",
    refusal: refusal(
      `EC2 instance ${instanceId} is shutting down: it is being terminated`,
      then(`Check instance ${instanceId} in the EC2 console`),
    ),
  };
}

/**
 * What stop saw before acting: `--force` skipped the inspection, the tailnet did not locate the
 * worker (`verdict`, its next action completed by `thenRerunWorker`), or its agent activity.
 */
export type StopInspection =
  | { readonly kind: "forced" }
  | { readonly kind: "unlocated"; readonly verdict: Verdict }
  | { readonly kind: "activity"; readonly activity: AgentActivity };

const FORCE_UNINSPECTED = "--force stops it uninspected.";

/**
 * Stop's gates: active agents, or a running worker that cannot be inspected, refuse the stop;
 * `--force` skips them. Undefined when stop may go on.
 */
export function stopGate(inspection: StopInspection, worker: WorkerIdentity): Refusal | undefined {
  const then = thenRerunWorker("stop", worker.key);
  switch (inspection.kind) {
    case "forced":
      return undefined;
    case "unlocated": {
      const { verdict } = inspection;
      return refusal(
        `${worker.hostname} could not be inspected: ${verdict.summary}`,
        `${verdict.nextAction ?? then("Check the worker with `fffactory status`")} ${FORCE_UNINSPECTED}`,
        verdict.details,
      );
    }
    case "activity":
      break;
  }
  const { activity } = inspection;
  switch (activity.kind) {
    case "idle":
      return undefined;
    case "active": {
      const one = activity.count === 1;
      return refusal(
        `${activity.count} ${one ? "agent is" : "agents are"} active on ${worker.hostname}: stopping it would end ${one ? "it" : "them"}`,
        `Wait until no agent is active there, then rerun \`fffactory worker stop ${worker.key}\`, or pass --force to stop it anyway.`,
      );
    }
    case "unknown":
      return refusal(
        `${worker.hostname} could not be inspected for active agents: ${activity.reason}`,
        `Check the worker with \`fffactory status\`, then rerun \`fffactory worker stop ${worker.key}\`, or pass --force to stop it uninspected.`,
      );
  }
}

/** Confirmed by `--yes`, asked at a terminal, or impossible to confirm: refused. */
export type ConfirmationRule = "confirmed" | "ask" | "unavailable";

export function confirmationRule(yes: boolean, interactive: boolean): ConfirmationRule {
  if (yes) return "confirmed";
  return interactive ? "ask" : "unavailable";
}

/** y/N: only `y` or `yes`, in any case, confirms; anything else, or no answer, declines. */
export function confirms(answer: string | undefined): boolean {
  const typed = answer?.trim().toLowerCase();
  return typed === "y" || typed === "yes";
}

const VERBS: Readonly<Record<PowerAction, { readonly name: string; readonly doing: string }>> = {
  stop: { name: "Stop", doing: "Stopping" },
  start: { name: "Start", doing: "Starting" },
};

export function confirmationQuestion(
  action: PowerAction,
  worker: WorkerIdentity,
  instanceId: string,
): string {
  return `${VERBS[action].name} worker ${worker.key} (${worker.hostname}), EC2 instance ${instanceId}? [y/N] `;
}

/** Why the command refuses without a terminal or `--yes`. */
export function unconfirmable(action: PowerAction): string {
  return `${VERBS[action].doing} a worker needs your confirmation: rerun at a terminal, or pass --yes.`;
}

/** The machine's state as one read while waiting found it: also `terminated` or gone. */
export type ObservedMachineState = MachineState | "terminated" | "absent";

/**
 * One read while waiting for the action's target state: reached, still on the way (every
 * other state, including a lagging one, and a read that failed: `undefined`), or gone.
 */
export function waitStep(
  action: PowerAction,
  observed: ObservedMachineState | undefined,
): "reached" | "waiting" | "gone" {
  if (observed === TARGET_STATE[action]) return "reached";
  if (observed === "shutting-down" || observed === "terminated" || observed === "absent")
    return "gone";
  return "waiting";
}

function checkInstance(action: PowerAction, worker: WorkerIdentity, instanceId: string): string {
  return thenRerunWorker(action, worker.key)(`Check instance ${instanceId} in the EC2 console`);
}

/** The machine did not reach the target state in time; `lastSeen` is its last state read. */
export function powerTimedOut(
  action: PowerAction,
  worker: WorkerIdentity,
  instanceId: string,
  lastSeen: ObservedMachineState | undefined,
): Refusal {
  return refusal(
    `EC2 instance ${instanceId} did not reach ${TARGET_STATE[action]} within ${POWER_DEADLINE_MS / 60_000} min (last seen: ${lastSeen ?? "unknown"})`,
    checkInstance(action, worker, instanceId),
  );
}

/** The machine went away, or is being terminated, while the action waited for it. */
export function machineGone(
  action: PowerAction,
  worker: WorkerIdentity,
  instanceId: string,
  state: ObservedMachineState,
): Refusal {
  const now = state === "absent" ? "gone" : state;
  return refusal(
    `EC2 instance ${instanceId} is ${now} while fffactory waited for it to be ${TARGET_STATE[action]}`,
    checkInstance(action, worker, instanceId),
  );
}

const PERMISSIONS: Readonly<Record<PowerAction, string>> = {
  stop: "ec2:StopInstances",
  start: "ec2:StartInstances",
};

/** EC2 refused or failed the request; `reason` names the error, never quoting AWS. */
export function requestFailed(
  action: PowerAction,
  worker: WorkerIdentity,
  instanceId: string,
  reason: string,
): Refusal {
  return refusal(
    reason,
    thenRerunWorker(
      action,
      worker.key,
    )(`Check that the credentials may call ${PERMISSIONS[action]} on instance ${instanceId}`),
  );
}

const UNDER_WAY: Readonly<Record<PowerAction, string>> = {
  stop: "stopping",
  start: "starting",
};

/**
 * EC2 did not answer the request within its deadline: unlike a refusal, the request may have
 * reached EC2, so the machine may be changing. `reason` names the timeout, never quoting AWS.
 */
export function requestUnanswered(
  action: PowerAction,
  worker: WorkerIdentity,
  instanceId: string,
  reason: string,
): Refusal {
  return refusal(
    reason,
    thenRerunWorker(action, worker.key)("Check the worker with `fffactory status`"),
    [`The request may have reached EC2: instance ${instanceId} may be ${UNDER_WAY[action]}.`],
  );
}
