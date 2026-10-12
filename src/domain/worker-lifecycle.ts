/**
 * `fffactory worker stop|start|terminate`'s rules (`docs/specs/worker-lifecycle.md`): the one
 * EC2 instance a command acts on, what each EC2 state means for an action, the gates of stop
 * and terminate, the confirmation rules, the bounded waits, the tailnet device removal's
 * outcome, and the words of every refusal and next action. Pure:
 * `application/worker-lifecycle.ts` makes the observations and the calls.
 */
import type { AgentActivity } from "./control-plane";
import { type FactoryInstance, type HostKey, parseHostKey } from "./instance";
import type { RepositoryObservation } from "./repository-placement";
import type { WorkerIdentity } from "./rollout";
import {
  ADMIN_CONSOLE,
  type Machine,
  type MachineInventory,
  type MachineState,
  type TailnetFact,
  type Then,
  type Verdict,
} from "./status";

/** The lifecycle commands this module rules. Terminate keeps the host (`--keep`). */
export type PowerAction = "stop" | "start" | "terminate";

/** The operation each action holds the factory lock as, and names its record by. */
export const WORKER_OPERATIONS: Readonly<Record<PowerAction, string>> = {
  stop: "worker-stop",
  start: "worker-start",
  terminate: "worker-terminate",
};

/** The machine's state as one read while waiting found it: also `terminated` or gone. */
export type ObservedMachineState = MachineState | "terminated" | "absent";

/** The EC2 state each action brings the machine to. */
export const TARGET_STATE: Readonly<Record<PowerAction, ObservedMachineState>> = {
  stop: "stopped",
  start: "running",
  terminate: "terminated",
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

/**
 * The command line that runs `action` for host `key`. Terminate runs only with `--keep` until
 * it can remove the host too (`cli/commands/worker.ts`).
 */
export function workerCommandLine(action: PowerAction, key: HostKey): string {
  return `fffactory worker ${action} ${key}${action === "terminate" ? " --keep" : ""}`;
}

/** Completes a next action by rerunning the same command for the same host. */
export function thenRerunWorker(action: PowerAction, key: HostKey): Then {
  return (step) => `${step}, then rerun \`${workerCommandLine(action, key)}\`.`;
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

/** The states each action acts on, and the one it only waits through. */
const STEPS: Readonly<
  Record<PowerAction, { readonly act: readonly MachineState[]; readonly await: MachineState }>
> = {
  stop: { act: ["running"], await: "stopping" },
  start: { act: ["stopped"], await: "pending" },
  terminate: { act: ["running", "stopped"], await: "shutting-down" },
};

const UNTIL_RUNNING = "Wait until it is running";
const UNTIL_STOPPED = "Wait until it has stopped";

/** The states an action refuses until the machine has got past them, and what to wait for. */
const IN_PASSING: Readonly<Record<PowerAction, Partial<Record<MachineState, string>>>> = {
  stop: { pending: UNTIL_RUNNING },
  start: { stopping: UNTIL_STOPPED },
  terminate: { pending: UNTIL_RUNNING, stopping: UNTIL_STOPPED },
};

export function powerStep(action: PowerAction, machine: Machine, key: HostKey): PowerStep {
  const { state, instanceId } = machine;
  if (state === TARGET_STATE[action]) return { kind: "done" };
  if (STEPS[action].act.includes(state)) return { kind: "act" };
  if (state === STEPS[action].await) return { kind: "await" };
  const then = thenRerunWorker(action, key);
  const until = IN_PASSING[action][state];
  if (until !== undefined)
    return {
      kind: "refused",
      refusal: refusal(`EC2 instance ${instanceId} is ${state}`, then(until)),
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
 * worker (why, as `tailnet`, and `verdict`, its next action completed by `thenRerunWorker`), or
 * its agent activity.
 */
export type StopInspection =
  | { readonly kind: "forced" }
  | { readonly kind: "unlocated"; readonly tailnet: TailnetFact; readonly verdict: Verdict }
  | { readonly kind: "activity"; readonly activity: AgentActivity };

/** The actions whose gates inspect the worker first, and their words. */
type GatedAction = Extract<PowerAction, "stop" | "terminate">;

const GATE_WORDS: Readonly<Record<GatedAction, { readonly verb: string; readonly doing: string }>> =
  {
    stop: { verb: "stop", doing: "stopping" },
    terminate: { verb: "terminate", doing: "terminating" },
  };

/** Completes a gate's next action: rerun, or pass `--force` to act `how`. */
function orForce(action: GatedAction, key: HostKey, step: string, how: string): string {
  return `${step}, then rerun \`${workerCommandLine(action, key)}\`, or pass --force to ${GATE_WORDS[action].verb} it ${how}.`;
}

/**
 * A running worker the tailnet does not locate cannot be inspected: refused with the
 * tailnet's `verdict` and the action's own `nextAction`. The gate stays even for a worker
 * whose bootstrap failed: a missing device can also be tailnet policy hiding a live worker.
 */
function unlocatedGate(verdict: Verdict, worker: WorkerIdentity, nextAction: string): Refusal {
  return refusal(
    `${worker.hostname} could not be inspected: ${verdict.summary}`,
    nextAction,
    verdict.details,
  );
}

const CHECK_STATUS = "Check the worker with `fffactory status`";

/**
 * Stop completes the tailnet's next action, except for a missing worker: status's recovery
 * for one is the failed first boot's, terminating it, which a refused stop leaves to status.
 */
function stopUnlocatedAction(tailnet: TailnetFact, verdict: Verdict, key: HostKey): string {
  const tailnets = tailnet === "missing" ? undefined : verdict.nextAction;
  return `${tailnets ?? thenRerunWorker("stop", key)(CHECK_STATUS)} --force stops it uninspected.`;
}

/**
 * Terminate always names its own: status's would, for a missing worker, have the operator
 * terminate it and then rerun the very command refused, but a worker whose bootstrap failed
 * never joins the tailnet, so only `--force` terminates it.
 */
function terminateUnlocatedAction(key: HostKey): string {
  return (
    `${thenRerunWorker("terminate", key)(CHECK_STATUS)} If the instance's EC2 console output ` +
    "shows its bootstrap failed, it never joined the tailnet: rerun with --force, which " +
    "terminates it uninspected."
  );
}

/** Active agents, or activity that could not be read, refuse the action. */
function activityGate(
  action: GatedAction,
  activity: AgentActivity,
  worker: WorkerIdentity,
): Refusal | undefined {
  switch (activity.kind) {
    case "idle":
      return undefined;
    case "active": {
      const one = activity.count === 1;
      return refusal(
        `${activity.count} ${one ? "agent is" : "agents are"} active on ${worker.hostname}: ${GATE_WORDS[action].doing} it would end ${one ? "it" : "them"}`,
        orForce(action, worker.key, "Wait until no agent is active there", "anyway"),
      );
    }
    case "unknown":
      return refusal(
        `${worker.hostname} could not be inspected for active agents: ${activity.reason}`,
        orForce(action, worker.key, CHECK_STATUS, "uninspected"),
      );
  }
}

/**
 * Stop's gates: active agents, or a running worker that cannot be inspected, refuse the stop;
 * `--force` skips them. Undefined when stop may go on.
 */
export function stopGate(inspection: StopInspection, worker: WorkerIdentity): Refusal | undefined {
  switch (inspection.kind) {
    case "forced":
      return undefined;
    case "unlocated":
      return unlocatedGate(
        inspection.verdict,
        worker,
        stopUnlocatedAction(inspection.tailnet, inspection.verdict, worker.key),
      );
    case "activity":
      return activityGate("stop", inspection.activity, worker);
  }
}

/**
 * What terminate saw before acting: `--force` skipped the inspection, the machine is stopped
 * (never inspected), the tailnet did not locate the running worker, or the worker's agent
 * activity and its last repository result.
 */
export type TerminateInspection =
  | { readonly kind: "forced" }
  | { readonly kind: "stopped" }
  | { readonly kind: "unlocated"; readonly verdict: Verdict }
  | {
      readonly kind: "inspected";
      readonly activity: AgentActivity;
      readonly repositories: RepositoryObservation;
    };

/** Unresolved or unmanaged checkouts, or a repository result that could not be read. */
function checkoutGate(
  repositories: RepositoryObservation,
  worker: WorkerIdentity,
): Refusal | undefined {
  const { hostname, key } = worker;
  switch (repositories.state) {
    case "none":
      return undefined;
    case "unreadable":
    case "unknown":
      return refusal(
        `${hostname} could not be inspected for checkouts: ${
          repositories.state === "unknown"
            ? repositories.reason
            : "the worker's repository result could not be read"
        }`,
        orForce("terminate", key, CHECK_STATUS, "uninspected"),
      );
    case "synchronized":
    case "unresolved":
      break;
  }
  const unmanaged = repositories.unmanaged.map((path) => `Unmanaged repository: ${path}`);
  if (repositories.state === "unresolved")
    return refusal(
      `Placed repositories on ${hostname} are unresolved: terminating it would lose their work`,
      orForce("terminate", key, "Resolve the checkouts `fffactory status` reports", "anyway"),
      unmanaged,
    );
  if (unmanaged.length === 0) return undefined;
  return refusal(
    `${hostname} holds unmanaged checkouts: terminating it would lose them`,
    "Copy what you need off them, then terminate it with --force: " +
      `\`${workerCommandLine("terminate", key)} --force\`.`,
    unmanaged,
  );
}

/**
 * Terminate's gates: active agents, unresolved or unmanaged checkouts, or a running worker that
 * cannot be inspected refuse it; `--force` skips them. A stopped machine passes uninspected:
 * nothing runs on it, and unpushed work on its disk goes unreported (an accepted risk).
 * Undefined when terminate may go on.
 */
export function terminateGate(
  inspection: TerminateInspection,
  worker: WorkerIdentity,
): Refusal | undefined {
  switch (inspection.kind) {
    case "forced":
    case "stopped":
      return undefined;
    case "unlocated":
      return unlocatedGate(inspection.verdict, worker, terminateUnlocatedAction(worker.key));
    case "inspected":
      return (
        activityGate("terminate", inspection.activity, worker) ??
        checkoutGate(inspection.repositories, worker)
      );
  }
}

/**
 * Confirmed in advance (`--yes`, or terminate's `--confirm KEY`), asked at a terminal, or
 * impossible to confirm: refused.
 */
export type ConfirmationRule = "confirmed" | "ask" | "unavailable";

export function confirmationRule(inAdvance: boolean, interactive: boolean): ConfirmationRule {
  if (inAdvance) return "confirmed";
  return interactive ? "ask" : "unavailable";
}

/**
 * Terminate's typed confirmation: only the host key itself, exactly, around blank space,
 * confirms; anything else, or no answer, declines.
 */
export function typedKeyConfirms(answer: string | undefined, key: HostKey): boolean {
  return answer?.trim() === key;
}

/** `--confirm` named something other than the host key: refused, the value never echoed. */
export function confirmMismatch(key: HostKey): Refusal {
  return refusal(
    `--confirm does not name the host ${key}`,
    `Pass --confirm ${key} to terminate it, or type the host key when asked at a terminal.`,
  );
}

/** y/N: only `y` or `yes`, in any case, confirms; anything else, or no answer, declines. */
export function confirms(answer: string | undefined): boolean {
  const typed = answer?.trim().toLowerCase();
  return typed === "y" || typed === "yes";
}

const VERBS: Readonly<Record<PowerAction, { readonly name: string; readonly doing: string }>> = {
  stop: { name: "Stop", doing: "Stopping" },
  start: { name: "Start", doing: "Starting" },
  terminate: { name: "Terminate", doing: "Terminating" },
};

export function confirmationQuestion(
  action: PowerAction,
  worker: WorkerIdentity,
  instanceId: string,
): string {
  const asked = `${VERBS[action].name} worker ${worker.key} (${worker.hostname}), EC2 instance ${instanceId}?`;
  return action === "terminate"
    ? `${asked} Its machine and root volume are destroyed. Type the host key to confirm: `
    : `${asked} [y/N] `;
}

/** Why the command refuses without a terminal or a confirmation in advance. */
export function unconfirmable(action: PowerAction): string {
  const pass = action === "terminate" ? "--confirm KEY" : "--yes";
  return `${VERBS[action].doing} a worker needs your confirmation: rerun at a terminal, or pass ${pass}.`;
}

/**
 * One read while waiting for the action's target state: reached, still on the way (every
 * other state, including a lagging one, and a read that failed: `undefined`), or gone.
 * Terminate is done once EC2 lists the instance `terminated`, or no longer lists it.
 */
export function waitStep(
  action: PowerAction,
  observed: ObservedMachineState | undefined,
): "reached" | "waiting" | "gone" {
  if (action === "terminate")
    return observed === "terminated" || observed === "absent" ? "reached" : "waiting";
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
  terminate: "ec2:TerminateInstances",
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
  terminate: "shutting down",
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
  return refusal(reason, thenRerunWorker(action, worker.key)(CHECK_STATUS), [
    `The request may have reached EC2: instance ${instanceId} may be ${UNDER_WAY[action]}.`,
  ]);
}

/** Terminate deletes the worker's tailnet device with the admin client: refused without one. */
export function adminClientMissing(key: HostKey): Refusal {
  return refusal(
    "factory.json has no Tailscale admin client (tailscale.admin_client_secret): terminate deletes the worker's tailnet device with it",
    thenRerunWorker(
      "terminate",
      key,
    )("Store it with `fffactory secret set tailscale-admin-client`"),
  );
}

/** The admin client's secret could not be read; `reason` names the error, never quoting AWS. */
export function adminSecretUnreadable(key: HostKey, reason: string): Refusal {
  return refusal(
    reason,
    thenRerunWorker(
      "terminate",
      key,
    )(
      "Check that the credentials may call secretsmanager:GetSecretValue on the secret " +
        "tailscale.admin_client_secret refers to",
    ),
  );
}

/** Where the tailnet's OAuth clients are managed. */
const TRUST_CREDENTIALS = "https://login.tailscale.com/admin/settings/trust-credentials";

/** Tailscale did not grant the admin client a token, or could not be reached. */
export function adminClientUnusable(key: HostKey, reason: string): Refusal {
  return refusal(
    `The Tailscale admin client could not be used: ${reason}`,
    thenRerunWorker(
      "terminate",
      key,
    )(
      `Check the OAuth client at ${TRUST_CREDENTIALS} (scope devices:core) and store its ` +
        "secret with `fffactory secret set tailscale-admin-client`",
    ),
  );
}

/**
 * How deleting the terminated worker's tailnet devices went: the tailnet's devices could not
 * be listed, or each device carrying its hostname was deleted, failed to be, or, without the
 * factory's tag, was left alone. Devices are named by their ID, never their tags.
 */
export type DeviceRemoval =
  | { readonly kind: "unlisted"; readonly reason: string }
  | {
      readonly kind: "listed";
      readonly removed: readonly string[];
      readonly failed: readonly { readonly id: string; readonly reason: string }[];
      readonly untagged: readonly string[];
    };

/**
 * Why the device removal left something behind, or undefined when it did not. The machine is
 * already terminated: what remains is the operator's to remove before the next apply, whose
 * new device a remaining one would make a duplicate.
 */
export function deviceRemovalRefusal(
  removal: DeviceRemoval,
  worker: WorkerIdentity,
): Refusal | undefined {
  const left =
    `Remove the remaining devices named ${worker.hostname} at ${ADMIN_CONSOLE} yourself (one ` +
    "without the factory's tag only if it was this worker), then run `fffactory apply`, which " +
    "creates the worker afresh.";
  if (removal.kind === "unlisted")
    return refusal(`The tailnet's devices could not be listed: ${removal.reason}`, left);
  if (removal.failed.length === 0 && removal.untagged.length === 0) return undefined;
  return refusal(`Not every Tailscale device named ${worker.hostname} was deleted`, left, [
    ...removal.failed.map(({ id, reason }) => `Deleting device ${id} failed: ${reason}`),
    ...removal.untagged.map(
      (id) =>
        `Device ${id} does not carry the factory's tag (tailscale.tag in factory.json): not deleted`,
    ),
  ]);
}
