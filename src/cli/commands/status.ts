import { parseArgs } from "node:util";
import {
  credentialSelection,
  PROFILE_ENVIRONMENT_VARIABLE,
} from "../../application/caller-identity";
import { factoryStatus, type StatusOutcome, type StatusTarget } from "../../application/status";
import type { CredentialSelection } from "../../domain/aws-account";
import type { CheckStatus } from "../../domain/check-result";
import { exitCodeFor } from "../../domain/check-result";
import type { Release } from "../../domain/instance";
import { nextActionFields } from "../../domain/readiness";
import type { StatusReport, WorkerStatus } from "../../domain/status";
import { sha256Text } from "../../infrastructure/release-tarball";
import type { CliContext, Command } from "../context";
import { checkJson, checkLines } from "./doctor";
import { loadInstance, printAccountRefusal } from "./selected-instance";

/**
 * Version of the `--json` output format; `schemas/status-report.schema.json` publishes it.
 * Additions keep it; removing, renaming or redefining a field needs a new version.
 */
export const STATUS_JSON_SCHEMA_VERSION = 1;

function workerJson(worker: WorkerStatus) {
  return {
    key: worker.key,
    hostname: worker.hostname,
    status: worker.status,
    summary: worker.summary,
    details: [...worker.details],
    next_action: worker.nextAction,
    machine: { state: worker.machine, instance_id: worker.instanceId },
    tailnet: worker.tailnet,
    release: worker.release,
    configuration: worker.configuration,
    installation: worker.installation,
    repositories: {
      state: worker.repositories,
      unmanaged: worker.unmanagedRepositories === null ? null : [...worker.unmanagedRepositories],
    },
    dispatch: {
      state: worker.dispatch,
      blockers: worker.dispatchBlockers === null ? null : [...worker.dispatchBlockers],
    },
    enrollment:
      worker.enrollment?.map(({ id, title, state, next_action }) => ({
        id,
        title,
        state,
        next_action: next_action === null ? null : nextActionFields(next_action),
      })) ?? null,
  };
}

/** The versioned JSON document, with keys in a fixed order. */
export function statusJson(target: StatusTarget, report: StatusReport, release: Release) {
  return {
    schema_version: STATUS_JSON_SCHEMA_VERSION,
    release,
    status: report.status,
    factory: {
      factory_id: target.factoryId,
      account_id: target.accountId,
      region: target.region,
      release: target.release,
    },
    inventories: report.inventories.map(checkJson),
    workers: report.workers.map(workerJson),
  };
}

const LABELS: Readonly<Record<CheckStatus, string>> = {
  ready: "ready",
  not_ready: "not ready",
  error: "error",
};
const RESULTS: Readonly<Record<CheckStatus, string>> = {
  ready: "Ready",
  not_ready: "Not ready",
  error: "Error",
};
const STATUS_WIDTH = Math.max(...Object.values(LABELS).map((label) => label.length));
const INDENT = " ".repeat(2 + STATUS_WIDTH + 2);

function machineText(worker: WorkerStatus): string {
  return worker.instanceId === null ? worker.machine : `${worker.machine} (${worker.instanceId})`;
}

function workerLines(worker: WorkerStatus): string[] {
  return [
    `  ${LABELS[worker.status].padEnd(STATUS_WIDTH)}  ${worker.key} (${worker.hostname}): ${worker.summary}`,
    `${INDENT}Machine: ${machineText(worker)}; Tailscale: ${worker.tailnet}; Release: ${worker.release}; Repositories: ${worker.repositories}; Dispatch: ${worker.dispatch}${worker.dispatchBlockers?.length ? ` (${worker.dispatchBlockers.join(", ")})` : ""}`,
    ...worker.details.map((detail) => `${INDENT}  ${detail}`),
    ...(worker.nextAction === null ? [] : [`${INDENT}Next: ${worker.nextAction}`]),
  ];
}

function resultLine(report: StatusReport): string {
  const entries = [...report.inventories, ...report.workers];
  const attention = entries.filter((entry) => entry.status !== "ready").length;
  if (attention === 0) return `${RESULTS.ready}: all ${report.workers.length} workers are ready.`;
  const verb = attention === 1 ? "needs" : "need";
  return `${RESULTS[report.status]}: ${attention} of ${entries.length} entries ${verb} attention.`;
}

/** The human-readable report, one line per element. */
export function statusText(target: StatusTarget, report: StatusReport, release: Release): string[] {
  return [
    `fffactory status, release ${release}`,
    `Factory ${target.factoryId} in AWS account ${target.accountId}, ${target.region}; ` +
      `factory.json pins release ${target.release}`,
    "",
    "Inventories:",
    ...report.inventories.flatMap(checkLines),
    "",
    "Workers:",
    ...(report.workers.length === 0 ? ["  none declared"] : report.workers.flatMap(workerLines)),
    "",
    resultLine(report),
  ];
}

async function status(args: readonly string[], context: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      instance: { type: "string" },
      profile: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.profile === "") {
    context.err("fffactory status: --profile needs a profile name");
    return 1;
  }
  // With --json, standard output holds the document and nothing else.
  const loaded = await loadInstance(
    values.instance,
    values.json ? { ...context, out: context.err } : context,
  );
  if (!loaded) return 1;
  const credentials = credentialSelection(
    values.profile,
    context.env[PROFILE_ENVIRONMENT_VARIABLE],
  );
  const outcome = await factoryStatus(
    {
      identity: context.identity,
      machines: context.machines,
      peers: context.tailnet,
      transport: context.transport,
      sha256: sha256Text,
    },
    { instance: loaded.instance, credentials },
  );
  // Interrupted, its tools were stopped: a report would show that, not the factory. fffactory
  // exits with the signal's status.
  if (context.interrupted()) return 1;
  return printOutcome(outcome, values.json, credentials, context);
}

/** Prints the report, or why status refused, and returns the exit code. */
function printOutcome(
  outcome: StatusOutcome,
  json: boolean,
  credentials: CredentialSelection,
  context: CliContext,
): number {
  switch (outcome.kind) {
    case "incomplete":
      context.err("Refusing to inspect the factory: factory.json is not ready:");
      for (const path of outcome.missing) context.err(`  ${path}: is required for status`);
      return 1;
    case "account_refused":
      printAccountRefusal("inspect the factory", outcome.requirement, context, {
        expectation: outcome.expectation,
        credentials,
      });
      return 1;
    case "report": {
      const { target, report } = outcome;
      if (json) context.out(JSON.stringify(statusJson(target, report, context.release), null, 2));
      else for (const line of statusText(target, report, context.release)) context.out(line);
      return exitCodeFor(report.status);
    }
  }
}

export const statusCommand: Command = {
  summary: "Show every worker's machine, tailnet presence and installed release (read-only)",
  usage: [
    "Usage: fffactory status [--instance PATH] [--profile NAME] [--json]",
    "",
    "Reports each host factory.json declares: its EC2 instance, found by the",
    "factory ID tag, its device in this machine's Tailscale peer view, and what",
    "the worker itself reports over SSH as fffactory-admin: its active release,",
    "configuration digest, services and readiness evidence. A hostname that is",
    "missing from the peer view, or that more than one device carries, is refused",
    "with the next step: fffactory never guesses. A worker it cannot reach has an",
    "unknown release: status keeps no record of earlier results.",
    "",
    "status changes nothing and takes no lock. It first checks that the",
    "credentials belong to the factory's account, then calls EC2",
    "DescribeInstances and runs `tailscale status --json` and `ssh`.",
    "",
    "  --instance PATH  Select the instance, as for `fffactory validate`.",
    "  --profile NAME   Use this AWS profile. Otherwise AWS_PROFILE, or else the",
    "                   standard AWS credential chain.",
    "  --json           Print a versioned JSON report instead of text.",
    "",
    "Exits 0 when every worker is ready on the pinned release, 2 when something is",
    "missing, offline, drifting, unhealthy or pending, and 1 when status itself",
    "failed: invalid arguments, an unusable factory.json, another AWS account, or",
    "an inventory or worker it could not inspect.",
  ],
  run: status,
  waitsOnInterrupt: true,
};
