import { parseArgs } from "node:util";
import {
  applyFactory,
  type FactoryApply,
  type OperationLocation,
} from "../../application/apply-factory";
import type { WorkerProgress } from "../../application/apply-workers";
import type { ControlPlaneOutcome } from "../../application/apply-control-plane";
import type { DispatchOutcome } from "../../application/apply-dispatch";
import type { RepositoryOutcome } from "../../application/apply-repositories";
import type { FactoryVerification } from "../../application/verify-factory";
import type { Approval } from "../../application/approval";
import { isPlanId, staleRefusal } from "../../domain/plan";
import {
  enrollmentReport,
  PASEO_CLIENTS,
  pendingEnrollment,
  pendingEnrollmentLines,
  type Verification,
} from "../../domain/readiness";
import { FIRST_BOOT_DEADLINE_MS, type WorkerOutcome } from "../../domain/rollout";
import type { CliContext, Command } from "../context";
import { sha256Text } from "../../infrastructure/release-tarball";
import { printDiagnostics } from "../diagnostics";
import { planningBasis, printPlanRefusal } from "./planning";

const USAGE = [
  "Usage: fffactory apply [--instance PATH] [--profile NAME] [--plan-id ID]",
  "",
  "Applies the factory's plan under the factory-wide lock. Without --plan-id it",
  "plans afresh from factory.json and what exists now, shows the plan (the",
  "configuration path, factory, AWS account, Region and release, the",
  "infrastructure changes, then each worker's install) and applies exactly that",
  "plan once you type yes, so it needs a terminal. With --plan-id ID it applies",
  "exactly the plan `fffactory plan` saved under that ID, which naming it",
  "approves, and refuses it once factory.json, the fffactory release, the AWS",
  "account or the factory's Terraform state has changed, or after an hour.",
  "",
  "The first apply creates the state bucket first, after its own approval.",
  "Terraform's output is not shown while it runs, which can take several minutes.",
  "Then each worker, one at a time, is found in your tailnet, receives this",
  "release's tarball over Tailscale SSH, and installs and verifies it through its",
  "root activator. A worker whose machine this apply created is waited for, up to",
  `${FIRST_BOOT_DEADLINE_MS / 60_000} minutes, until it has joined the tailnet and finished its first boot, so`,
  "one apply provisions, installs and verifies it. A worker counts as installed",
  "only once its verification completes; accounts it still needs a human to",
  "enroll are listed with their exact steps. Any other offline worker is skipped;",
  "a failed install stops the rollout, leaving that worker on the new release,",
  "unhealthy, until a rerun repairs it.",
  "",
  "Interrupting apply (Ctrl-C) stops Terraform gracefully and leaves the factory",
  "locked, with a record of the interrupted operation in the state bucket. Once",
  "fffactory has exited, break the lock with `fffactory lock break`; rerunning",
  "apply plans again from what exists and converges.",
  "",
  "Exits 0 once every worker is installed and verified, 2 when a worker was",
  "skipped, and 1 when anything failed or was refused, including a new worker",
  "whose first boot did not finish in time.",
  "",
  "Refused, naming what is missing, when this fffactory is not the release",
  "factory.json pins, and until host retirement exists (milestone M3) when",
  "factory.json removes a provisioned host key or the plan would destroy or",
  "replace a host machine. Like every command that plans or changes AWS, it first",
  "checks that the credentials belong to the factory's account.",
];

const APPROVAL_QUESTION = 'Apply this plan? Only "yes" applies it: ';
const APPLYING = "Applying. Terraform's output is not shown; this can take several minutes.";

/**
 * Shows each plan and asks the operator to approve exactly it. A saved plan was approved by
 * naming its ID, so it is shown and applied without asking.
 */
export function operatorApproval(
  planId: string | undefined,
  context: CliContext,
  question = APPROVAL_QUESTION,
): Approval {
  return {
    approve: async (plan) => {
      for (const line of plan) context.out(line);
      if (planId !== undefined) {
        context.out(`Applying saved plan ${planId}, approved by naming its ID.`);
        context.out(APPLYING);
        return true;
      }
      const approved = (await context.prompt.ask(question))?.trim() === "yes";
      if (approved) context.out(APPLYING);
      return approved;
    },
  };
}

function printRecord(operation: OperationLocation, context: CliContext): void {
  context.out(`Operation record: s3://${operation.bucket}/${operation.key}`);
}

/**
 * How a result is reported: the action refused, such as `apply`, and the command a rerun
 * uses, `apply`, or `upgrade` for an upgrade whose pin was not moved.
 */
export interface Reporting {
  readonly action: "apply" | "upgrade";
  readonly rerun: "apply" | "upgrade";
}

const APPLYING_REPORT: Reporting = { action: "apply", rerun: "apply" };

const rerunLine = ({ rerun }: Reporting) =>
  `Rerun \`fffactory ${rerun}\`: it plans again from what exists now and converges what remains.`;

const breakThenRerun = ({ rerun }: Reporting) =>
  "Once fffactory has exited, break the lock with `fffactory lock break`, then rerun " +
  `\`fffactory ${rerun}\`.`;

/** What an interrupt left: no lock, the lock alone, or the lock and a record of the apply. */
function reportInterrupted(
  result: Extract<FactoryApply, { readonly kind: "interrupted" }>,
  context: CliContext,
  reporting: Reporting,
): void {
  if (!result.locked) {
    context.err(
      `Interrupted before the factory was locked: it is not locked. Rerun \`fffactory ${reporting.rerun}\`: ` +
        "it plans again from what exists now.",
    );
    return;
  }
  if (result.installing !== undefined) {
    const { key, hostname } = result.installing;
    context.err(
      `Interrupted while installing on ${key} (${hostname}): host apply may still be running ` +
        "there, and a rerun skips that worker until it has finished.",
    );
  }
  if (result.waiting !== undefined) {
    const { key, hostname } = result.waiting;
    context.err(
      `Interrupted while waiting for ${key} (${hostname}) to finish its first boot: no ` +
        "install step ran on it.",
    );
  }
  if (result.record === undefined) {
    context.err(
      `Interrupted: the factory stays locked by this ${reporting.action}, which may have no ` +
        `operation record. ${breakThenRerun(reporting)}`,
    );
    return;
  }
  context.err(
    "Interrupted: the factory stays locked, with a record of this operation. " +
      breakThenRerun(reporting),
  );
  printRecord(result.record, context);
}

const LABELS: Readonly<Record<WorkerOutcome["kind"], string>> = {
  installed: "installed",
  skipped: "skipped",
  failed: "failed",
  not_attempted: "not tried",
};
const LABEL_WIDTH = Math.max(...Object.values(LABELS).map((label) => label.length));
const INDENT = " ".repeat(2 + LABEL_WIDTH + 2);

/**
 * What an installed worker still waits for: nothing, or accounts to enroll and how, in steps
 * the CLI names for `hostname`, the worker it resolved, never in the worker's own words.
 */
function installedLines(release: string, verification: Verification, hostname: string): string[] {
  const report = enrollmentReport(verification, hostname);
  const pending = pendingEnrollment(report);
  if (pending.length === 0)
    return [
      `release ${release} installed and verified; every account is enrolled`,
      `${INDENT}${PASEO_CLIENTS}`,
    ];
  return [
    `release ${release} installed and verified; enrollment pending: ${pending
      .map((entry) => entry.title)
      .join(", ")}`,
    ...pendingEnrollmentLines(report).map((line) => `${INDENT}${line}`),
  ];
}

function workerLines(outcome: WorkerOutcome): string[] {
  const head = `  ${LABELS[outcome.kind].padEnd(LABEL_WIDTH)}  ${outcome.key} (${outcome.hostname}): `;
  switch (outcome.kind) {
    case "installed": {
      const [first = "", ...rest] = installedLines(
        outcome.release,
        outcome.verification,
        outcome.hostname,
      );
      return [head + first, ...rest];
    }
    case "not_attempted":
      return [`${head}the rollout stopped at the failure above`];
    default:
      return [head + outcome.summary, `${INDENT}Next: ${outcome.nextAction}`];
  }
}

/** Standard output for installed and skipped workers, standard error for the rest. */
function printWorkers(outcomes: readonly WorkerOutcome[], context: CliContext): number {
  context.out("Workers:");
  for (const outcome of outcomes) {
    const print =
      outcome.kind === "failed" || outcome.kind === "not_attempted" ? context.err : context.out;
    for (const line of workerLines(outcome)) print(line);
  }
  if (outcomes.some((outcome) => outcome.kind === "failed")) return 1;
  return outcomes.some((outcome) => outcome.kind !== "installed") ? 2 : 0;
}

const FIRST_BOOT_MINUTES = FIRST_BOOT_DEADLINE_MS / 60_000;

export function progressLine(event: WorkerProgress, release: string): string {
  const worker = `${event.key} (${event.hostname})`;
  switch (event.kind) {
    case "waiting":
      return `Waiting for ${worker} to finish its first boot (up to ${FIRST_BOOT_MINUTES} min): this apply just created its machine.`;
    case "still_waiting":
      return `Still waiting for ${worker} after ${Math.floor(event.waitedMs / 60_000)} of up to ${FIRST_BOOT_MINUTES} min: ${event.lastSeen}.`;
    case "uploading":
      return `Installing release ${release} on ${worker}: uploading ${(event.bytes / 1024 ** 2).toFixed(1)} MiB.`;
    case "installing":
      return `Installing release ${release} on ${worker}: host apply runs the install steps, then verifies; this can take many minutes.`;
  }
}

function printRecordFailure(recordFailure: string | undefined, context: CliContext): void {
  if (recordFailure !== undefined)
    context.err(`The operation record could not be finished: ${recordFailure}`);
}

const worker = (outcome: { readonly key: string; readonly hostname: string }) =>
  `${outcome.key} (${outcome.hostname})`;

/** The repository stage's result: each worker's synchronization, with the next step for any gap. */
function printRepositories(outcomes: readonly RepositoryOutcome[], context: CliContext): void {
  context.out("Repositories:");
  for (const outcome of outcomes) {
    if (outcome.kind === "synchronized") {
      context.out(`  synchronized  ${worker(outcome)}`);
      continue;
    }
    context.out(`  ${outcome.kind}  ${worker(outcome)}: ${outcome.summary}`);
    context.out(`    Next: ${outcome.nextAction}`);
  }
}

/** The control-plane stage's result: each worker's reconciliation, with deferrals and failures. */
function printControlPlane(outcomes: readonly ControlPlaneOutcome[], context: CliContext): void {
  context.out("Control plane:");
  for (const outcome of outcomes) {
    if (outcome.kind === "applied") {
      context.out(`  applied  ${worker(outcome)}`);
      continue;
    }
    context.out(`  ${outcome.kind}  ${worker(outcome)}: ${outcome.summary}`);
    context.out(`    Next: ${outcome.nextAction}`);
  }
}

/**
 * The dispatch stage's result: requested-versus-active, with each pending gate's next action, and
 * for a failed or skipped worker its summary and next action.
 */
function printDispatch(outcomes: readonly DispatchOutcome[], context: CliContext): void {
  context.out("Dispatch:");
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case "active":
        context.out(`  active  ${worker(outcome)}`);
        break;
      case "not_requested":
        context.out(`  not requested  ${worker(outcome)}`);
        break;
      case "failed":
      case "skipped":
        context.out(`  ${outcome.kind}  ${worker(outcome)}: ${outcome.summary}`);
        context.out(`    Next: ${outcome.nextAction}`);
        break;
      case "pending":
        context.out(`  pending  ${worker(outcome)}`);
        for (const action of outcome.nextActions) context.out(`    ${action}`);
        break;
    }
  }
}

function printVerification(verification: FactoryVerification, context: CliContext): void {
  context.out(`End-to-end verification: ${verification.summary}`);
  for (const worker of verification.workers) if (!worker.ready) context.out(`  ${worker.summary}`);
}

function controlPlaneExit(outcomes: readonly ControlPlaneOutcome[] | undefined): 0 | 1 | 2 {
  if (outcomes?.some((outcome) => outcome.kind === "failed")) return 1;
  return outcomes?.some((outcome) => outcome.kind === "deferred") ? 2 : 0;
}

/** A skipped worker, sent nothing because an earlier stage skipped it or the tailnet no longer locates it, is not a failure: 2. */
function dispatchExit(outcomes: readonly DispatchOutcome[] | undefined): 0 | 1 | 2 {
  if (outcomes?.some((outcome) => outcome.kind === "failed")) return 1;
  return outcomes?.some((outcome) => outcome.kind === "pending" || outcome.kind === "skipped")
    ? 2
    : 0;
}

function appliedExit(
  result: Extract<FactoryApply, { readonly kind: "applied" }>,
  workerCode: number,
): number {
  const repositoriesReady =
    result.repositories === undefined ||
    result.repositories.every((outcome) => outcome.kind === "synchronized");
  const controlCode = controlPlaneExit(result.controlPlane);
  const dispatchCode = dispatchExit(result.dispatch);
  if (controlCode === 1 || dispatchCode === 1) return 1;
  const pending =
    (result.verification !== undefined && !result.verification.ready) ||
    !repositoriesReady ||
    controlCode === 2 ||
    dispatchCode === 2;
  return pending ? Math.max(workerCode, 2) : workerCode;
}

function reportApplied(
  result: Extract<FactoryApply, { readonly kind: "applied" }>,
  context: CliContext,
): number {
  context.out(
    result.infrastructure === "applied"
      ? "Applied: the factory's infrastructure matches factory.json."
      : "Infrastructure: no changes to apply.",
  );
  const code = printWorkers(result.workers, context);
  if (result.repositories !== undefined) printRepositories(result.repositories, context);
  if (result.controlPlane !== undefined) printControlPlane(result.controlPlane, context);
  if (result.dispatch !== undefined) printDispatch(result.dispatch, context);
  if (result.verification !== undefined) printVerification(result.verification, context);
  printRecord(result.operation, context);
  printRecordFailure(result.recordFailure, context);
  // A factory that installed every worker but has not reached its requested end state (dispatch
  // pending, a deferred maintenance) is not fully ready: report it like a skip, exit 2.
  return appliedExit(result, code);
}

/** What each step's failure may have changed. */
const FAILED: Readonly<
  Record<
    Extract<FactoryApply, { readonly kind: "failed" }>["step"],
    (reason: string, reporting: Reporting) => string[]
  >
> = {
  planning: (reason) => [`Planning failed: ${reason}. Nothing was applied.`],
  pinning: (reason) => [`Moving factory.json's pin failed: ${reason}. Nothing was applied.`],
  pinned: (reason) => [
    `Upgrading failed once factory.json's pin moved: ${reason}. Nothing was applied.`,
  ],
  applying: (reason, reporting) => [
    `Applying failed: ${reason}.`,
    "Terraform may have changed some of the infrastructure before it stopped.",
    rerunLine(reporting),
  ],
  installing: (reason, reporting) => [
    `Installing the workers failed: ${reason}.`,
    "The worker being installed may be on the new release, unhealthy.",
    rerunLine(reporting),
  ],
  repositories: (reason, reporting) => [
    `Repository synchronization failed: ${reason}.`,
    "Completed repository changes were left in place.",
    rerunLine(reporting),
  ],
  "control-plane": (reason, reporting) => [
    `Control-plane reconciliation failed: ${reason}.`,
    rerunLine(reporting),
  ],
  dispatch: (reason, reporting) => [
    `Dispatch reconciliation failed: ${reason}.`,
    rerunLine(reporting),
  ],
  verification: (reason, reporting) => [
    `End-to-end verification failed: ${reason}.`,
    rerunLine(reporting),
  ],
};

function reportFailed(
  result: Extract<FactoryApply, { readonly kind: "failed" }>,
  context: CliContext,
  reporting: Reporting,
): number {
  for (const line of FAILED[result.step](result.reason, reporting)) context.err(line);
  printDiagnostics(result.diagnosticsFile, context);
  printRecord(result.operation, context);
  printRecordFailure(result.recordFailure, context);
  return 1;
}

/** Reports how apply, or upgrade's apply, ended, and returns the exit code. */
export function reportApply(
  result: FactoryApply,
  context: CliContext,
  reporting: Reporting = APPLYING_REPORT,
): number {
  switch (result.kind) {
    case "applied":
      return reportApplied(result, context);
    case "declined":
      context.err("Not approved: nothing was applied.");
      return 1;
    case "configuration_changed":
      context.err(
        `Refusing to ${reporting.action}: factory.json changed after the plan was made. ` +
          `Nothing was applied. Review a new plan with \`fffactory ${reporting.rerun}\`.`,
      );
      return 1;
    case "no_state_bucket":
      context.err(
        "Refusing to upgrade: the factory has no state bucket yet, and an upgrade never " +
          "creates it. Nothing was created or applied. Run `fffactory apply` with the release " +
          "factory.json pins first, then rerun `fffactory upgrade`.",
      );
      return 1;
    case "failed":
      return reportFailed(result, context, reporting);
    case "interrupted":
      reportInterrupted(result, context, reporting);
      return 1;
    case "no_plan":
      context.err(
        `There is no saved plan ${result.planId} for this factory here: it expired, was ` +
          "applied, or was saved elsewhere. Review a new plan with `fffactory plan`.",
      );
      return 1;
    case "damaged_plan":
      context.err(
        `Saved plan ${result.planId} cannot be applied: its record cannot be read, or its ` +
          "Terraform plan changed after it was saved. Review a new plan with `fffactory plan`.",
      );
      return 1;
    case "stale":
      for (const line of staleRefusal(result.planId, result.reasons)) context.err(line);
      return 1;
    default:
      printPlanRefusal(reporting.action, result, context);
      return 1;
  }
}

async function apply(args: readonly string[], context: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      instance: { type: "string" },
      profile: { type: "string" },
      "plan-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.profile === "") {
    context.err("fffactory apply: --profile needs a profile name");
    return 1;
  }
  const planId = values["plan-id"];
  if (planId !== undefined && !isPlanId(planId)) {
    context.err(
      "fffactory apply: --plan-id takes the 8-character plan ID `fffactory plan` printed",
    );
    return 1;
  }
  if (planId === undefined && !context.prompt.interactive) {
    context.err(
      "Applying needs your approval of the plan: rerun at a terminal, or save a plan with " +
        "`fffactory plan` and apply exactly it with --plan-id ID.",
    );
    return 1;
  }
  const basis = await planningBasis("apply", values, context);
  if (!basis) return 1;
  const result = await applyFactory(
    {
      lockStore: context.lockStore,
      provisioner: context.provisioner,
      planStore: context.planStore,
      approval: operatorApproval(planId, context),
      interrupted: context.interrupted,
      peers: context.tailnet,
      transport: context.transport,
      controlPlane: context.controlPlane,
      workflowQueue: context.workflowQueue,
      assets: context.assets,
      progress: (event) => context.out(progressLine(event, context.release)),
      sleep: context.sleep,
      sha256: sha256Text,
    },
    {
      ...basis,
      ...(planId === undefined ? {} : { planId }),
      host: context.hostname,
      clock: context.now,
      randomBytes: context.randomBytes,
    },
  );
  return reportApply(result, context);
}

export const applyCommand: Command = {
  summary: "Apply the factory's plan after approval, under the factory-wide lock",
  usage: USAGE,
  run: apply,
  waitsOnInterrupt: true,
};
