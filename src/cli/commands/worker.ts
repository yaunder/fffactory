import { parseArgs } from "node:util";
import type { OperationLocation } from "../../application/apply-factory";
import {
  credentialSelection,
  PROFILE_ENVIRONMENT_VARIABLE,
} from "../../application/caller-identity";
import {
  type PowerProgress,
  startWorker,
  stopWorker,
  terminateWorker,
  type WorkerLifecycleDependencies,
  type WorkerPower,
} from "../../application/worker-lifecycle";
import type { CredentialSelection } from "../../domain/aws-account";
import { lockRefusal } from "../../domain/factory-lock";
import type { HostKey } from "../../domain/instance";
import { ADMIN_CONSOLE, type Verdict } from "../../domain/status";
import {
  type DeviceRemoval,
  ONLINE_DEADLINE_MS,
  POWER_DEADLINE_MS,
  type PowerAction,
  type Refusal,
  TARGET_STATE,
  unconfirmable,
  workerCommandLine,
} from "../../domain/worker-lifecycle";
import { sha256Text } from "../../infrastructure/release-tarball";
import type { CliContext, Command } from "../context";
import { loadInstance, printAccountRefusal } from "./selected-instance";

const USAGE = [
  "Usage: fffactory worker stop KEY [--force] [--yes] [--instance PATH] [--profile NAME]",
  "       fffactory worker start KEY [--yes] [--instance PATH] [--profile NAME]",
  "       fffactory worker terminate KEY --keep [--force] [--confirm KEY] [--instance PATH] [--profile NAME]",
  "",
  "Powers the EC2 instance of the worker factory.json declares as host KEY off or",
  "on, under the factory-wide lock and with a record of the operation in the state",
  "bucket. Stopping ends compute billing; the instance, its root volume (still",
  "billed), its Terraform state, its tailnet device and its factory.json entry all",
  "stay. Starting brings the same worker back, waits for it to come online in the",
  "tailnet and reports its readiness as `fffactory status` would: a release or",
  "configuration it missed while stopped names `fffactory apply`.",
  "",
  "Stop first inspects the worker over Tailscale SSH and refuses while agents are",
  "active on it, or when a running worker cannot be inspected. --force skips that",
  "inspection, never the account check, the release pin, the lock or the",
  "confirmation. Stopping a stopped worker, or starting a running one, does nothing",
  "and succeeds; one already on its way there is only waited for. Each asks y/N at",
  "a terminal; --yes confirms in advance, and without a terminal is required.",
  "",
  "Terminate destroys the worker's EC2 instance and root volume, then deletes its",
  "Tailscale devices with the factory's admin client (`fffactory secret set",
  "tailscale-admin-client`), whose secret it reads from Secrets Manager. With",
  "--keep, the only mode yet, the host stays in factory.json and the next",
  "`fffactory apply` creates it afresh; Terraform is not run. A running worker is",
  "first inspected, and refused while agents are active on it or its checkouts",
  "are unresolved or unmanaged; a stopped one is not inspected. You confirm by",
  "typing the host key at a terminal, or with --confirm KEY. A device it could not",
  "delete is reported, and exits 2: the terminate stands.",
  "",
  "Refused, changing nothing, when KEY is not a host factory.json declares, the",
  "credentials belong to another account, this fffactory is not the release",
  "factory.json pins, another operation holds the lock, or no single EC2 instance",
  "carries the factory ID and host key tags. Interrupting the wait leaves the",
  "factory locked, with its record: once fffactory has exited, break the lock with",
  "`fffactory lock break`, then rerun the command.",
  "",
  "  --force          stop and terminate: act without inspecting the worker (ends any",
  "                   agents; terminate also loses unpushed work).",
  "  --yes            stop and start: confirm without asking.",
  "  --keep           terminate: keep the host in factory.json (required).",
  "  --confirm KEY    terminate: confirm without asking, naming the host key.",
  "  --instance PATH  Select the instance, as for `fffactory validate`.",
  "  --profile NAME   Use this AWS profile. Otherwise AWS_PROFILE, or else the",
  "                   standard AWS credential chain.",
  "",
  "Exits 0 once the worker is stopped, started (even when it is not ready) or",
  "terminated, 2 when it is terminated but a tailnet device remains, and 1 when",
  "refused, declined or failed.",
];

/** How each action is told: its verb, its participles, and its progress. */
const WORDS: Readonly<
  Record<
    PowerAction,
    { readonly verb: string; readonly done: string; readonly past: string; readonly doing: string }
  >
> = {
  stop: { verb: "stop", done: "Stopped", past: "stopped", doing: "Stopping" },
  start: { verb: "start", done: "Started", past: "started", doing: "Starting" },
  terminate: { verb: "terminate", done: "Terminated", past: "terminated", doing: "Terminating" },
};

/** What `--force` skipped, for each action that has gates. */
const UNINSPECTED: Readonly<Record<PowerAction, string>> = {
  stop: "active agents",
  start: "active agents",
  terminate: "active agents or checkouts",
};

function progressLine(event: PowerProgress): string {
  const wait = (action: PowerAction) =>
    `waiting for it to be ${TARGET_STATE[action]} (up to ${POWER_DEADLINE_MS / 60_000} min).`;
  switch (event.kind) {
    case "located":
      return `Worker ${event.key} (${event.hostname}): EC2 instance ${event.instanceId} is ${event.state}.`;
    case "forced":
      return `--force: the worker is not inspected for ${UNINSPECTED[event.action]}.`;
    case "uninspected_stopped":
      return "The machine is stopped: the worker is not inspected, and unpushed work on its disk is not reported.";
    case "requested":
      return `${WORDS[event.action].doing} EC2 instance ${event.instanceId}; ${wait(event.action)}`;
    case "awaiting":
      return `EC2 instance ${event.instanceId} is already on its way; ${wait(event.action)}`;
    case "waiting_online":
      return `Waiting for ${event.hostname} to come online in the tailnet (up to ${ONLINE_DEADLINE_MS / 60_000} min).`;
    case "removing_devices":
      return `Deleting the Tailscale devices named ${event.hostname}.`;
  }
}

function printRecord(
  operation: OperationLocation | undefined,
  recordFailure: string | undefined,
  context: CliContext,
): void {
  if (operation !== undefined)
    context.out(`Operation record: s3://${operation.bucket}/${operation.key}`);
  if (recordFailure !== undefined)
    context.err(`The operation record could not be finished: ${recordFailure}`);
}

function printRefusal(heading: string, refusal: Refusal, context: CliContext): void {
  context.err(`${heading}: ${refusal.summary}`);
  for (const detail of refusal.details) context.err(`  ${detail}`);
  context.err(`Next: ${refusal.nextAction}`);
}

const STATUS_LABELS: Readonly<Record<Verdict["status"], string>> = {
  ready: "ready",
  not_ready: "not ready",
  error: "error",
  stopped: "stopped",
};

/** The started worker's readiness, in status's words. */
function printVerdict(verdict: Verdict, context: CliContext): void {
  context.out("Status:");
  context.out(`  ${STATUS_LABELS[verdict.status]}  ${verdict.summary}`);
  for (const detail of verdict.details) context.out(`    ${detail}`);
  if (verdict.nextAction !== null) context.out(`  Next: ${verdict.nextAction}`);
}

/** What deleting the terminated worker's tailnet devices did; any device left on standard error. */
function printDevices(
  devices: DeviceRemoval,
  leftover: Refusal | undefined,
  hostname: string,
  context: CliContext,
): void {
  const removed = devices.kind === "listed" ? devices.removed : [];
  for (const id of removed) context.out(`Deleted Tailscale device ${id} (${hostname}).`);
  if (leftover !== undefined)
    printRefusal("Deleting the worker's tailnet devices was not complete", leftover, context);
  else if (removed.length === 0)
    context.out(`No Tailscale device named ${hostname} remained to delete.`);
}

function reportDone(
  result: Extract<WorkerPower, { readonly kind: "done" }>,
  context: CliContext,
): number {
  const { action, worker, changed, awaited } = result;
  const named = `${worker.key} (${worker.hostname})`;
  if (awaited)
    context.out(
      `Worker ${named} is now ${TARGET_STATE[action]}: it was already on its way, and fffactory waited for it.`,
    );
  else if (!changed)
    context.out(
      `Worker ${named} is already ${TARGET_STATE[action]}${action === "stop" ? ": nothing to do" : ""}.`,
    );
  else if (action === "stop")
    context.out(
      `Stopped worker ${named}. Its instance, volume, tailnet device and factory.json entry ` +
        `stay; \`fffactory worker start ${worker.key}\` brings it back.`,
    );
  else if (action === "terminate")
    context.out(
      `Terminated worker ${named}: its EC2 instance and root volume are gone. factory.json ` +
        "keeps the host, so `fffactory apply` creates it afresh.",
    );
  else context.out(`${WORDS[action].done} worker ${named}.`);
  if (result.verdict !== undefined) printVerdict(result.verdict, context);
  if (result.devices !== undefined)
    printDevices(result.devices, result.leftover, worker.hostname, context);
  printRecord(result.operation, result.recordFailure, context);
  return result.leftover === undefined ? 0 : 2;
}

/** What an interrupt left: no lock, or the lock, with its record when one was written. */
function reportInterrupted(
  result: Extract<WorkerPower, { readonly kind: "interrupted" }>,
  action: PowerAction,
  rerun: string,
  context: CliContext,
): void {
  if (!result.locked) {
    context.err(
      "Interrupted before the factory was locked: it is not locked, and nothing was asked of EC2.",
    );
    return;
  }
  if (result.requested && action === "terminate")
    context.err(
      "EC2 was asked to terminate the instance and may still be doing so; its tailnet " +
        `devices may remain: check them at ${ADMIN_CONSOLE}.`,
    );
  else if (result.requested)
    context.err("EC2 was asked to change the instance and may still be doing so.");
  const left =
    result.record === undefined
      ? "the factory stays locked by this operation, which may have no operation record."
      : "the factory stays locked, with a record of this operation.";
  context.err(
    `Interrupted: ${left} Once fffactory has exited, break the lock with \`fffactory lock break\`, then rerun \`${rerun}\`.`,
  );
  printRecord(result.record, undefined, context);
}

/** Reports how the command ended, and returns its exit code. */
function report(
  result: WorkerPower,
  action: PowerAction,
  rerun: string,
  credentials: CredentialSelection,
  context: CliContext,
): number {
  const refusing = `Refusing to ${WORDS[action].verb} the worker`;
  switch (result.kind) {
    case "done":
      return reportDone(result, context);
    case "unconfirmable":
      context.err(unconfirmable(action));
      return 1;
    case "incomplete":
      context.err(`${refusing}: factory.json is not ready:`);
      for (const path of result.missing)
        context.err(`  ${path}: is required to ${WORDS[action].verb} a worker`);
      return 1;
    case "account_refused":
      printAccountRefusal(`${WORDS[action].verb} the worker`, result.requirement, context, {
        expectation: result.expectation,
        credentials,
      });
      return 1;
    case "release_mismatch":
      context.err(`${refusing}: ${result.message}`);
      return 1;
    case "locked":
      for (const line of lockRefusal(result.held, context.now())) context.err(line);
      return 1;
    case "interrupted":
      reportInterrupted(result, action, rerun, context);
      return 1;
    case "refused":
      printRefusal(refusing, result.refusal, context);
      printRecord(result.operation, result.recordFailure, context);
      return 1;
    case "declined":
      context.err(`Not confirmed: the worker was not ${WORDS[action].past}.`);
      printRecord(result.operation, result.recordFailure, context);
      return 1;
    case "failed":
      printRefusal(`${WORDS[action].doing} the worker failed`, result.refusal, context);
      printRecord(result.operation, result.recordFailure, context);
      return 1;
  }
}

function dependencies(context: CliContext): WorkerLifecycleDependencies {
  return {
    identity: context.identity,
    lockStore: context.lockStore,
    machines: context.machines,
    control: context.machineControl,
    peers: context.tailnet,
    transport: context.transport,
    controlPlane: context.controlPlane,
    prompt: context.prompt,
    secrets: context.secrets,
    tailnetAdmin: context.tailnetAdmin,
    interrupted: context.interrupted,
    sleep: context.sleep,
    sha256: sha256Text,
    progress: (event) => context.out(progressLine(event)),
  };
}

/** The options each action takes beyond `--instance` and `--profile`. */
const ACTION_OPTIONS: Readonly<Record<PowerAction, readonly string[]>> = {
  stop: ["yes", "force"],
  start: ["yes"],
  terminate: ["force", "keep", "confirm"],
};

const OPTIONS = {
  instance: { type: "string" },
  profile: { type: "string" },
  yes: { type: "boolean" },
  force: { type: "boolean" },
  keep: { type: "boolean" },
  confirm: { type: "string" },
} as const;

async function power(
  action: PowerAction,
  args: readonly string[],
  context: CliContext,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: OPTIONS,
    strict: true,
    allowPositionals: true,
  });
  const command = `fffactory worker ${action}`;
  if (values.profile === "") {
    context.err(`${command}: --profile needs a profile name`);
    return 1;
  }
  const foreign = Object.keys(values).find(
    (name) => name !== "instance" && name !== "profile" && !ACTION_OPTIONS[action].includes(name),
  );
  if (foreign !== undefined) {
    context.err(`${command}: unknown option --${foreign}`);
    return 1;
  }
  const [key] = positionals;
  if (key === undefined || positionals.length !== 1) {
    context.err(`${command}: expected one host KEY`);
    return 1;
  }
  // TODO(re-evaluate when terminate removal lands): without --keep, terminate removes the host
  // from factory.json (#10); until then only --keep is accepted.
  if (action === "terminate" && values.keep !== true) {
    context.err(`${command}: removal arrives in a later release; use --keep`);
    return 1;
  }
  const loaded = await loadInstance(values.instance, context);
  if (!loaded) return 1;
  const credentials = credentialSelection(
    values.profile,
    context.env[PROFILE_ENVIRONMENT_VARIABLE],
  );
  const request = {
    instance: loaded.instance,
    key,
    credentials,
    release: context.release,
    force: values.force === true,
    yes: values.yes === true,
    confirm: values.confirm,
    host: context.hostname,
    clock: context.now,
    randomBytes: context.randomBytes,
  };
  const deps = dependencies(context);
  const result = await USE_CASES[action](deps, request);
  // Only a result past the key check names the key again: it is then a declared host key.
  return report(result, action, workerCommandLine(action, key as HostKey), credentials, context);
}

const USE_CASES = { stop: stopWorker, start: startWorker, terminate: terminateWorker } as const;

const ACTIONS: readonly string[] = Object.keys(USE_CASES);

function isAction(action: string | undefined): action is PowerAction {
  return action !== undefined && ACTIONS.includes(action);
}

async function worker(args: readonly string[], context: CliContext): Promise<number> {
  const [action, ...rest] = args;
  if (isAction(action)) return power(action, rest, context);
  context.err(`fffactory worker: expected a subcommand: ${ACTIONS.join(", ")}`);
  for (const line of USAGE) context.err(line);
  return 1;
}

export const workerCommand: Command = {
  summary: "Stop, start or terminate a worker's EC2 instance, under the factory-wide lock",
  usage: USAGE,
  run: worker,
  waitsOnInterrupt: true,
};
