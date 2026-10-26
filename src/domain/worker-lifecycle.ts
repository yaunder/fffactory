/**
 * `fffactory worker stop|start|terminate`'s rules (`docs/specs/worker-lifecycle.md`): the one
 * EC2 instance a command acts on, what each EC2 state means for an action, the gates of stop
 * and terminate, the confirmation rules, the bounded waits, the tailnet device removal's
 * outcome, and the words of every refusal and next action. Pure:
 * `application/worker-lifecycle.ts` makes the observations and the calls.
 */
import { type BlockingActivity, busyAgents, type WorkerActivity } from "./control-plane";
import { type FactoryInstance, type HostKey, parseHostKey } from "./instance";
import type { RepositoryObservation } from "./repository-placement";
import { RUNTIME_ACCOUNT, RUNTIME_LOGIN_POLICY, runtimeLogin } from "./readiness";
import { WORK_ROOTS, workFindings, type WorkObservation } from "./work-inspection";
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

/** What a lifecycle command does to the machine. */
export type PowerAction = "stop" | "start" | "terminate";

/**
 * A lifecycle command as the operator runs it, which its next actions rerun: terminate removes
 * the host from factory.json (`terminate`) unless it keeps it (`terminate-keep`, `--keep`).
 */
export type WorkerCommand = "stop" | "start" | "terminate" | "terminate-keep";

/** The terminate commands: removing the host, or keeping it. */
export type TerminateCommand = Extract<WorkerCommand, "terminate" | "terminate-keep">;

/** The action a command takes on the machine. */
export function actionOf(command: WorkerCommand): PowerAction {
  return command === "terminate-keep" ? "terminate" : command;
}

/** Whether `command` removes the host from factory.json: terminate without `--keep`. */
export function removesHost(command: WorkerCommand): command is "terminate" {
  return command === "terminate";
}

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

/** The command line that runs `command` for host `key`. */
export function workerCommandLine(command: WorkerCommand, key: HostKey): string {
  return `fffactory worker ${actionOf(command)} ${key}${command === "terminate-keep" ? " --keep" : ""}`;
}

/** Completes a next action by rerunning the same command for the same host. */
export function thenRerunWorker(command: WorkerCommand, key: HostKey): Then {
  return (step) => `${step}, then rerun \`${workerCommandLine(command, key)}\`.`;
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
  /** Terminate, with or without `--keep`: no instance carries its key, so its machine is gone. */
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/**
 * The one instance carrying `key`: several, or an inventory that could not be read, is refused,
 * never guessed. None is refused too for stop and start, which have no machine to act on; to
 * terminate, it is a machine already gone (`absent`), as an interrupted terminate leaves it.
 */
export function selectMachine(
  inventory: MachineInventory,
  key: HostKey,
  command: WorkerCommand,
): MachineSelection {
  const then = thenRerunWorker(command, key);
  const refused = (summary: string, step: string, details: readonly string[] = []) =>
    ({ kind: "refused", refusal: refusal(summary, then(step), details) }) as const;
  if (inventory.kind === "unavailable")
    return refused(
      inventory.reason,
      "Check your network connection and that the credentials may call ec2:DescribeInstances",
    );
  const machines = inventory.machines.filter((machine) => machine.hostKey === key);
  const [only] = machines;
  const action = actionOf(command);
  if (only === undefined && action === "terminate") return { kind: "absent" };
  if (only === undefined)
    return {
      kind: "refused",
      refusal: refusal(
        `No EC2 instance carries the host key ${key}`,
        `There is no machine to ${action}: \`fffactory apply\` provisions the worker.`,
      ),
    };
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

export function powerStep(command: WorkerCommand, machine: Machine, key: HostKey): PowerStep {
  const { state, instanceId } = machine;
  const action = actionOf(command);
  if (state === TARGET_STATE[action]) return { kind: "done" };
  if (STEPS[action].act.includes(state)) return { kind: "act" };
  if (state === STEPS[action].await) return { kind: "await" };
  const then = thenRerunWorker(command, key);
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
  | { readonly kind: "activity"; readonly activity: WorkerActivity };

/** The actions whose gates inspect the worker first, and their words. */
type GatedAction = Extract<PowerAction, "stop" | "terminate">;

/** The commands whose gates inspect the worker first. */
type GatedCommand = Exclude<WorkerCommand, "start">;

const GATE_WORDS: Readonly<Record<GatedAction, { readonly verb: string; readonly doing: string }>> =
  {
    stop: { verb: "stop", doing: "stopping" },
    terminate: { verb: "terminate", doing: "terminating" },
  };

/** Completes a gate's next action: rerun, or pass `--force` to act `how`. */
function orForce(command: GatedCommand, key: HostKey, step: string, how: string): string {
  const { verb } = GATE_WORDS[actionOf(command) as GatedAction];
  return `${step}, then rerun \`${workerCommandLine(command, key)}\`, or pass --force to ${verb} it ${how}.`;
}

/**
 * How the next actions of the gates that guard a worker's removal end, for the command they
 * refused: `worker terminate`, or teardown, which removes every worker (`teardown.ts`).
 */
export interface RemovalGateActions {
  /** `step`, then rerun the refused command, or force past the gate `how` (`anyway`, `uninspected`). */
  readonly orForce: (step: string, how: string) => string;
  /** A running worker the tailnet does not locate. */
  readonly unlocated: string;
  /**
   * What follows `then ` once the operator has checked the worker by hand: terminate it with
   * `--force`, or what stands for that, and what then. A complete sentence's end.
   */
  readonly forced: string;
}

/** The next actions of terminate's own gates: rerun it as run, or with `--force`. */
function terminateActions(command: TerminateCommand, key: HostKey): RemovalGateActions {
  return {
    orForce: (step, how) => orForce(command, key, step, how),
    unlocated: terminateUnlocatedAction(command, key),
    forced: `terminate it with --force: \`${workerCommandLine(command, key)} --force\`.`,
  };
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
function terminateUnlocatedAction(command: TerminateCommand, key: HostKey): string {
  return (
    `${thenRerunWorker(command, key)(CHECK_STATUS)} If the instance's EC2 console output ` +
    "shows its bootstrap failed, it never joined the tailnet: rerun with --force, which " +
    "terminates it uninspected."
  );
}

/** Why a worker on a release from before agent states is refused. */
const OUTDATED_DETAIL =
  "Its release answers without its agents, so fffactory cannot tell whether any is busy.";

/**
 * Busy agents, or activity that could not be read, refuse the action, `doing` it (`stopping`,
 * `terminating`), each next action completed by `actions.orForce`; a worker on a release from
 * before agent states is checked by hand, then `outdated` (D4).
 */
function activityGate(
  doing: string,
  actions: Pick<RemovalGateActions, "orForce">,
  outdated: string,
  activity: WorkerActivity,
  worker: WorkerIdentity,
): Refusal | undefined {
  switch (activity.kind) {
    case "idle":
      return undefined;
    case "busy": {
      const one = activity.working + activity.needsInput === 1;
      return refusal(
        `${busyAgents(activity, worker.hostname)}: ${doing} it would end ${one ? "it" : "them"}`,
        actions.orForce("Wait until no agent there is working or needs input", "anyway"),
      );
    }
    case "unknown": {
      const summary = `${worker.hostname} could not be inspected for busy agents: ${activity.reason}`;
      if (activity.outdated) return refusal(summary, outdated, [OUTDATED_DETAIL]);
      return refusal(summary, actions.orForce(CHECK_STATUS, "uninspected"));
    }
  }
}

/**
 * Stop's gates: busy agents, or a running worker that cannot be inspected, refuse the stop;
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
      return activityGate(
        GATE_WORDS.stop.doing,
        { orForce: (step, how) => orForce("stop", worker.key, step, how) },
        `${replaceOutdatedWorker(worker)} Or pass --force to stop it uninspected.`,
        inspection.activity,
        worker,
      );
  }
}

/**
 * What terminate saw before acting: `--force` skipped the inspection, the machine is stopped
 * (never inspected), the tailnet did not locate the running worker, its activity when that
 * alone refuses, agents busy or unreadable (the work is then never asked for), or, the worker
 * idle, its last repository result, the current work in its checkouts and worktrees, and the
 * checkouts factory.json places there (`placed`, relative to the repository root), which the
 * work inspection must report.
 */
export type TerminateInspection =
  | { readonly kind: "forced" }
  | { readonly kind: "stopped" }
  | { readonly kind: "unlocated"; readonly verdict: Verdict }
  | { readonly kind: "activity"; readonly activity: BlockingActivity }
  | {
      readonly kind: "inspected";
      readonly repositories: RepositoryObservation;
      readonly work: WorkObservation;
      readonly placed: readonly string[];
    };

/** The most lines a work refusal lists; the rest are counted. */
export const WORK_DETAIL_LINES = 20;

function bounded(lines: readonly string[]): string[] {
  if (lines.length <= WORK_DETAIL_LINES) return [...lines];
  return [...lines.slice(0, WORK_DETAIL_LINES), `... and ${lines.length - WORK_DETAIL_LINES} more`];
}

/**
 * What a worker is checked for by hand, as the runtime account that owns its checkouts, when
 * fffactory cannot inspect it (its activator predates the work inspection, or its release
 * predates agent states), before `then`: what the work inspection reads.
 */
function checkByHand(then: string, worker: WorkerIdentity): string {
  return (
    `Log in as \`${RUNTIME_ACCOUNT}\` (\`${runtimeLogin(worker.hostname)}\`; ${RUNTIME_LOGIN_POLICY}). ` +
    `In every checkout under ${WORK_ROOTS.repositories} and ~/.paseo/worktrees, and every ` +
    "worktree `git worktree list` shows, run `git status`, `git log --branches --not " +
    `--remotes\` and \`git stash list\`, and push or copy off what you need; then ${then}`
  );
}

/**
 * How a worker on a release from before agent states is replaced (D4): checked by hand, then
 * terminated keeping its host, which `fffactory apply` then creates afresh on this release.
 */
export function replaceOutdatedWorker(worker: WorkerIdentity): string {
  return checkByHand(
    "replace it: terminate it with --force, keeping its host, " +
      `\`${workerCommandLine("terminate-keep", worker.key)} --force\`, then run \`fffactory apply\`, ` +
      "which creates it afresh.",
    worker,
  );
}

/**
 * The current work could not be had: refused, with the last repository result's own refusal,
 * when it has one (`persisted`), listed too, so the operator sees it before `--force` is named.
 * A worker whose activator predates the inspection is checked by hand, then forced.
 */
function uninspectedWork(
  work: Extract<WorkObservation, { readonly kind: "unknown" }>,
  worker: WorkerIdentity,
  actions: RemovalGateActions,
  persisted: Refusal | undefined,
): Refusal {
  const summary = `${worker.hostname} could not be inspected for unpushed work: ${work.reason}`;
  const known = persisted === undefined ? [] : [persisted.summary, ...persisted.details];
  // TODO(re-evaluate when base migration lands in M3): deliver the work-inspecting activator to
  // existing workers so terminate need not rely on a manual check and --force.
  if (work.unsupported)
    return refusal(summary, checkByHand(actions.forced, worker), [
      "A worker's activator is installed at its first boot and never updated: this worker's predates this release.",
      ...known,
    ]);
  return refusal(summary, actions.orForce(CHECK_STATUS, "uninspected"), known);
}

/**
 * The current work (`workFindings`): unresolved work refuses, naming each checkout or worktree
 * that holds it; work that could not be inspected, a placed checkout the inspection did not
 * report, or a worker that could not be asked, refuses too; the last, listing the last
 * repository result's refusal (`persisted`) with it.
 */
function workGate(
  inspection: Extract<TerminateInspection, { readonly kind: "inspected" }>,
  worker: WorkerIdentity,
  actions: RemovalGateActions,
  persisted: Refusal | undefined,
): Refusal | undefined {
  const { work } = inspection;
  const { hostname } = worker;
  if (work.kind === "unknown") return uninspectedWork(work, worker, actions, persisted);
  const { unresolved, uninspected } = workFindings(work.inspection, inspection.placed);
  if (unresolved.length > 0)
    return refusal(
      `${hostname} holds work not pushed to any remote: terminating it would lose it`,
      actions.orForce("Push or discard it", "anyway"),
      bounded([...unresolved, ...uninspected]),
    );
  if (uninspected.length > 0)
    return refusal(
      `${hostname} could not be fully inspected for unpushed work`,
      actions.orForce(CHECK_STATUS, "uninspected"),
      bounded(uninspected),
    );
  return undefined;
}

/** Unresolved or unmanaged checkouts, or a repository result that could not be read. */
function checkoutGate(
  repositories: RepositoryObservation,
  worker: WorkerIdentity,
  actions: RemovalGateActions,
): Refusal | undefined {
  const { hostname } = worker;
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
        actions.orForce(CHECK_STATUS, "uninspected"),
      );
    case "synchronized":
    case "unresolved":
      break;
  }
  const unmanaged = repositories.unmanaged.map((path) => `Unmanaged repository: ${path}`);
  if (repositories.state === "unresolved")
    return refusal(
      `Placed repositories on ${hostname} are unresolved: terminating it would lose their work`,
      actions.orForce("Resolve the checkouts `fffactory status` reports", "anyway"),
      unmanaged,
    );
  if (unmanaged.length === 0) return undefined;
  return refusal(
    `${hostname} holds unmanaged checkouts: terminating it would lose them`,
    `Copy what you need off them, then ${actions.forced}`,
    unmanaged,
  );
}

/**
 * Terminate's gates: busy agents, work in its checkouts or worktrees not pushed to any remote,
 * unresolved or unmanaged checkouts, or a running worker that cannot be inspected refuse it;
 * `--force` skips them. A stopped machine passes uninspected: nothing runs on it, and unpushed
 * work on its disk goes unreported (an accepted risk). Undefined when terminate may go on.
 */
export function terminateGate(
  inspection: TerminateInspection,
  worker: WorkerIdentity,
  command: TerminateCommand,
): Refusal | undefined {
  return removalGate(inspection, worker, terminateActions(command, worker.key));
}

/**
 * The gates that guard a worker's removal, terminate's (`terminateGate`) or teardown's, judged
 * alike, each next action completed by `actions`. Undefined when the removal may go on.
 */
export function removalGate(
  inspection: TerminateInspection,
  worker: WorkerIdentity,
  actions: RemovalGateActions,
): Refusal | undefined {
  switch (inspection.kind) {
    case "forced":
    case "stopped":
      return undefined;
    case "unlocated":
      return unlocatedGate(inspection.verdict, worker, actions.unlocated);
    case "activity":
      return activityGate(
        GATE_WORDS.terminate.doing,
        actions,
        checkByHand(actions.forced, worker),
        inspection.activity,
        worker,
      );
    case "inspected": {
      const persisted = checkoutGate(inspection.repositories, worker, actions);
      return workGate(inspection, worker, actions, persisted) ?? persisted;
    }
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

const TYPE_KEY = "Type the host key to confirm: ";

const GONE = "No EC2 instance carries its key: its machine is already gone.";

/**
 * The question asked before acting on the machine located. Terminate removing the host says so.
 * Without a machine, already gone, terminate asks only to remove the host, or with `--keep`
 * only to delete its tailnet devices. For a machine EC2 was already terminating, `--keep` asks,
 * before its wait, to wait and delete the devices; a removal asks, after it, to remove the host.
 */
export function confirmationQuestion(
  command: WorkerCommand,
  worker: WorkerIdentity,
  machine: Pick<Machine, "instanceId" | "state"> | undefined,
): string {
  const named = `worker ${worker.key} (${worker.hostname})`;
  if (machine === undefined)
    return removesHost(command)
      ? `Remove ${named} from factory.json? ${GONE} ${TYPE_KEY}`
      : `Delete the Tailscale devices of ${named}? ${GONE} ${TYPE_KEY}`;
  const { instanceId } = machine;
  if (machine.state === "shutting-down")
    return removesHost(command)
      ? `Remove ${named} from factory.json? Its EC2 instance ${instanceId} was already being terminated, and is now terminated. ${TYPE_KEY}`
      : `Wait for EC2 instance ${instanceId}, already being terminated, then delete the Tailscale devices of ${named}? ${TYPE_KEY}`;
  const action = actionOf(command);
  const asked = `${VERBS[action].name} ${named}, EC2 instance ${instanceId}`;
  if (removesHost(command))
    return `${asked}, and remove it from factory.json? Its machine and root volume are destroyed. ${TYPE_KEY}`;
  return action === "terminate"
    ? `${asked}? Its machine and root volume are destroyed. ${TYPE_KEY}`
    : `${asked}? [y/N] `;
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

function checkInstance(command: WorkerCommand, worker: WorkerIdentity, instanceId: string): string {
  return thenRerunWorker(command, worker.key)(`Check instance ${instanceId} in the EC2 console`);
}

/** The machine did not reach the target state in time; `lastSeen` is its last state read. */
export function powerTimedOut(
  command: WorkerCommand,
  worker: WorkerIdentity,
  instanceId: string,
  lastSeen: ObservedMachineState | undefined,
): Refusal {
  return refusal(
    `EC2 instance ${instanceId} did not reach ${TARGET_STATE[actionOf(command)]} within ${POWER_DEADLINE_MS / 60_000} min (last seen: ${lastSeen ?? "unknown"})`,
    checkInstance(command, worker, instanceId),
  );
}

/** The machine went away, or is being terminated, while the action waited for it. */
export function machineGone(
  command: WorkerCommand,
  worker: WorkerIdentity,
  instanceId: string,
  state: ObservedMachineState,
): Refusal {
  const now = state === "absent" ? "gone" : state;
  return refusal(
    `EC2 instance ${instanceId} is ${now} while fffactory waited for it to be ${TARGET_STATE[actionOf(command)]}`,
    checkInstance(command, worker, instanceId),
  );
}

const PERMISSIONS: Readonly<Record<PowerAction, string>> = {
  stop: "ec2:StopInstances",
  start: "ec2:StartInstances",
  terminate: "ec2:TerminateInstances",
};

/** EC2 refused or failed the request; `reason` names the error, never quoting AWS. */
export function requestFailed(
  command: WorkerCommand,
  worker: WorkerIdentity,
  instanceId: string,
  reason: string,
): Refusal {
  const permission = PERMISSIONS[actionOf(command)];
  return refusal(
    reason,
    thenRerunWorker(
      command,
      worker.key,
    )(`Check that the credentials may call ${permission} on instance ${instanceId}`),
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
  command: WorkerCommand,
  worker: WorkerIdentity,
  instanceId: string,
  reason: string,
): Refusal {
  return refusal(reason, thenRerunWorker(command, worker.key)(CHECK_STATUS), [
    `The request may have reached EC2: instance ${instanceId} may be ${UNDER_WAY[actionOf(command)]}.`,
  ]);
}

/** Terminate deletes the worker's tailnet device with the admin client: refused without one. */
export function adminClientMissing(command: TerminateCommand, key: HostKey): Refusal {
  return refusal(
    "factory.json has no Tailscale admin client (tailscale.admin_client_secret): terminate deletes the worker's tailnet device with it",
    thenRerunWorker(command, key)("Store it with `fffactory secret set tailscale-admin-client`"),
  );
}

/** The admin client's secret could not be read; `reason` names the error, never quoting AWS. */
export function adminSecretUnreadable(
  command: TerminateCommand,
  key: HostKey,
  reason: string,
): Refusal {
  return refusal(
    reason,
    thenRerunWorker(
      command,
      key,
    )(
      "Check that the credentials may call secretsmanager:GetSecretValue on the secret " +
        "tailscale.admin_client_secret refers to",
    ),
  );
}

/** Where the tailnet's OAuth clients are managed. */
export const TRUST_CREDENTIALS = "https://login.tailscale.com/admin/settings/trust-credentials";

/** Tailscale did not grant the admin client a token, or could not be reached. */
export function adminClientUnusable(
  command: TerminateCommand,
  key: HostKey,
  reason: string,
): Refusal {
  return refusal(
    `The Tailscale admin client could not be used: ${reason}`,
    thenRerunWorker(
      command,
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
 * What to do about the devices a terminate may have left: remove them by hand, then, after
 * `--keep`, run the apply that creates the worker afresh. Removing the host, there is nothing
 * to rerun: factory.json no longer declares it.
 */
export function remainingDevicesAction(worker: WorkerIdentity, command: TerminateCommand): string {
  const yourself =
    `Remove the remaining devices named ${worker.hostname} at ${ADMIN_CONSOLE} yourself (one ` +
    "without the factory's tag only if it was this worker)";
  return removesHost(command)
    ? `${yourself}: factory.json no longer declares the host.`
    : `${yourself}, then run \`fffactory apply\`, which creates the worker afresh.`;
}

/**
 * Why the device removal left something behind, or undefined when it did not. The machine is
 * already terminated: what remains is the operator's to remove, with `--keep` before the next
 * apply, whose new device a remaining one would make a duplicate.
 */
export function deviceRemovalRefusal(
  removal: DeviceRemoval,
  worker: WorkerIdentity,
  command: TerminateCommand,
): Refusal | undefined {
  const left = remainingDevicesAction(worker, command);
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
