/**
 * `fffactory worker inspect [KEY] [--json]` (`docs/specs/worker-lifecycle.md` §Inspect): whether
 * terminate would remove each worker without `--force`. Read-only: no lock, no confirmation, no
 * change. The `worker` command (`worker.ts`) dispatches to it.
 */
import { parseArgs } from "node:util";
import {
  credentialSelection,
  PROFILE_ENVIRONMENT_VARIABLE,
} from "../../application/caller-identity";
import type { StatusTarget } from "../../application/status";
import {
  inspectRemovability,
  type Removability,
  type RemovabilityDependencies,
} from "../../application/worker-removability";
import type { CredentialSelection } from "../../domain/aws-account";
import type { Release } from "../../domain/instance";
import { removalExitCode, type WorkerRemovability } from "../../domain/worker-removability";
import type { CliContext } from "../context";
import type { Selection } from "../presentation/command-line";
import { planRefusalReport } from "../presentation/plan";
import { inspectionReport, keyRefusalReport } from "../presentation/worker-inspection";
import { printReport } from "./planning";
import { loadInstance, printAccountRefusal } from "./selected-instance";
import { factoryJson } from "./status";

/**
 * Version of the `--json` output format; `schemas/worker-inspection.schema.json` publishes it.
 * Additions keep it; removing, renaming or redefining a field needs a new version.
 */
export const WORKER_INSPECTION_SCHEMA_VERSION = 1;

/**
 * The versioned JSON document: each worker as the domain makes it, its inspection document (the
 * one a removal record carries) and inspect's next action.
 */
export function inspectionJson(
  target: StatusTarget,
  workers: readonly WorkerRemovability[],
  release: Release,
) {
  return {
    schema_version: WORKER_INSPECTION_SCHEMA_VERSION,
    release,
    factory: factoryJson(target),
    workers,
  };
}

const COMMAND = "fffactory worker inspect";
/** What a refusal of `worker inspect` is called. */
const ACTION = "inspect the workers";

function dependencies(context: CliContext): RemovabilityDependencies {
  return {
    identity: context.identity,
    machines: context.machines,
    peers: context.tailnet,
    transport: context.transport,
    controlPlane: context.controlPlane,
    interrupted: context.interrupted,
  };
}

/** Runs `worker inspect` with the arguments after `inspect`, and returns its exit code. */
export async function inspectWorkers(
  args: readonly string[],
  context: CliContext,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      instance: { type: "string" },
      profile: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.profile === "") {
    context.err(`${COMMAND}: --profile needs a profile name`);
    return 1;
  }
  if (positionals.length > 1) {
    context.err(`${COMMAND}: expected at most one host KEY`);
    return 1;
  }
  const selection: Selection = { instance: values.instance, profile: values.profile };
  // With --json, standard output holds the document and nothing else.
  const human = values.json ? { ...context, out: context.err } : context;
  const loaded = await loadInstance(values.instance, human, "worker inspect");
  if (!loaded) return 1;
  const credentials = credentialSelection(
    values.profile,
    context.env[PROFILE_ENVIRONMENT_VARIABLE],
  );
  const outcome = await inspectRemovability(dependencies(context), {
    instance: loaded.instance,
    key: positionals[0],
    credentials,
  });
  // Interrupted, its tools were stopped: a report would show that, not the workers.
  if (outcome.kind === "interrupted" || context.interrupted()) return 1;
  return printOutcome(outcome, { json: values.json, selection, credentials }, context);
}

interface Printing {
  readonly json: boolean;
  readonly selection: Selection;
  readonly credentials: CredentialSelection;
}

/** Prints the report, or why the command refused, and returns the exit code. */
function printOutcome(
  outcome: Exclude<Removability, { readonly kind: "interrupted" }>,
  { json, selection, credentials }: Printing,
  context: CliContext,
): number {
  switch (outcome.kind) {
    case "refused":
      printReport(context.err, keyRefusalReport(outcome.refusal));
      return 1;
    case "incomplete": {
      const issues = outcome.missing.map((path) => ({
        path,
        message: "is required to inspect a worker",
      }));
      const refusing = { action: ACTION, now: context.now(), selection };
      printReport(context.err, planRefusalReport({ kind: "refused", issues }, refusing));
      return 1;
    }
    case "account_refused":
      printAccountRefusal(ACTION, outcome.requirement, context, {
        expectation: outcome.expectation,
        credentials,
      });
      return 1;
    case "inspected": {
      const { target, workers } = outcome;
      if (json)
        context.out(JSON.stringify(inspectionJson(target, workers, context.release), null, 2));
      else printReport(context.out, inspectionReport(workers, selection));
      return removalExitCode(workers);
    }
  }
}
