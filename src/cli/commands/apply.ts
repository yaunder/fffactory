import { parseArgs } from "node:util";
import { applyFactory, type FactoryApply } from "../../application/apply-factory";
import type { WorkerProgress } from "../../application/apply-workers";
import type { ControlPlaneOutcome } from "../../application/apply-control-plane";
import type { DispatchOutcome } from "../../application/apply-dispatch";
import type { Approval } from "../../application/approval";
import type { PlanRefusal } from "../../application/plan-factory";
import { isPlanId, type PlanReview } from "../../domain/plan";
import { FIRST_BOOT_DEADLINE_MS, type WorkerOutcome } from "../../domain/rollout";
import type { CliContext, Command } from "../context";
import { sha256Text } from "../../infrastructure/release-tarball";
import {
  type ApplyReporting,
  appliedLines,
  applyingLabelWidth,
  applyingRow,
  applyingSection,
  bootstrappedLines,
  failedLines,
  infrastructureApplyingRow,
  interruptedLines,
  pinNotice,
  pinnedRow,
  progressRow,
  refusedRunReport,
  savedPlanApproved,
  type StreamLine,
} from "../presentation/apply";
import { type Report, type Row, render, renderInSection } from "../presentation/blocks";
import type { Selection } from "../presentation/command-line";
import {
  damagedPlanReport,
  planRefusalReport,
  reviewBlocks,
  staleReport,
  unknownPlanReport,
} from "../presentation/plan";
import type { Writer } from "../presentation/style";
import { planningBasis, printReport, withNotice } from "./planning";

const USAGE = [
  "Usage: fffactory apply [--instance PATH] [--profile NAME] [--plan-id ID]",
  "",
  "Applies the factory's plan under the factory-wide lock. Without --plan-id it",
  "plans afresh from factory.json and what exists now, shows the plan (the",
  "factory, AWS account, Region and release, the infrastructure changes, then",
  "every stage's changes for each worker) and applies exactly that",
  "plan once you type yes, so it needs a terminal. With --plan-id ID it applies",
  "exactly the plan `fffactory plan` saved under that ID, which naming it",
  "approves, and refuses it once factory.json, the fffactory release, the AWS",
  "account or the factory's Terraform state has changed, or after an hour.",
  "",
  "A saved bootstrap plan, made while the state bucket does not exist, is applied",
  "the same way with --plan-id ID, without a terminal: it creates the bucket",
  "exactly as planned, and is refused once the bucket exists. Apply then records it",
  "and stops; plan the factory next with `fffactory plan`.",
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
  "unhealthy, until a rerun repairs it. A worker whose EC2 instance is stopped",
  "(`fffactory worker stop`) is never started: it is listed as stopped and sent",
  "nothing, and the plan refuses to change its instance type until it is started.",
  "",
  "Interrupting apply (Ctrl-C) stops Terraform gracefully and leaves the factory",
  "locked, with a record of the interrupted operation in the state bucket. Once",
  "fffactory has exited, break the lock with `fffactory lock break`; rerunning",
  "apply plans again from what exists and converges. An interrupted saved bootstrap",
  "plan may be spent: run `fffactory plan` instead.",
  "",
  "Exits 0 once every worker is installed and verified or stopped, or once a saved",
  "bootstrap plan has created the bucket, 2 when a worker was skipped, and 1 when",
  "anything failed or was refused, including a new worker whose first boot did not",
  "finish in time.",
  "",
  "Refused, naming what is missing, when this fffactory is not the release",
  "factory.json pins, when factory.json no longer declares a provisioned host key",
  "(only `fffactory worker terminate KEY` removes a host), and until host",
  "replacement exists (milestone M3) when the plan would destroy or replace a host",
  "machine. Like every command that plans or changes AWS, it first checks that the",
  "credentials belong to the factory's account.",
];

const APPROVAL_QUESTION = 'Apply this plan? Only "yes" applies it: ';

/**
 * The Applying section as it streams: its rule once something is applied, then a row per
 * step, Terraform's apply, an upgrade's pin and each worker's progress, labels aligned to
 * the widest the approved review can have. A review shown afterwards, such as the factory's
 * plan after backend bootstrap's, starts a new section.
 */
export interface ApplyingProgress {
  /** A review is shown: what is applied next is its. */
  readonly review: (review: PlanReview) => void;
  /** It was approved and Terraform applies it now, when it has anything to apply. */
  readonly applying: () => void;
  /** An upgrade's pin was written, before Terraform applies anything. */
  readonly pinned: (release: string) => void;
  readonly progress: (event: WorkerProgress) => void;
}

export function applyingProgress(writer: Writer): ApplyingProgress {
  let started = false;
  let width = 0;
  let infrastructure: Row | undefined;
  const row = (shown: Row) => {
    if (!started) {
      writer("");
      for (const line of render(writer.style, [applyingSection()])) writer(line);
      started = true;
    }
    for (const line of renderInSection(writer.style, [applyingRow(shown, width)])) writer(line);
  };
  const applying = () => {
    if (infrastructure !== undefined) row(infrastructure);
    infrastructure = undefined;
  };
  return {
    review: (review) => {
      started = false;
      width = applyingLabelWidth(review);
      infrastructure = infrastructureApplyingRow(review);
    },
    applying,
    pinned: (release) => {
      row(pinnedRow(release));
      applying();
    },
    progress: (event) => row(progressRow(event)),
  };
}

/** How an approval is asked: the question, and whether Terraform waits for the pin's write. */
export interface Asking {
  readonly question: string;
  readonly afterPin: boolean;
}

/**
 * Shows each plan's review and asks the operator to approve exactly it. A saved plan was
 * approved by naming its ID, so it is shown and applied without asking. The commands a review
 * names repeat the instance and profile in `selection`. Once approved, the Applying section
 * says Terraform applies it, or, for an upgrade, waits to say so until the pin is written.
 */
export function operatorApproval(
  planId: string | undefined,
  context: CliContext,
  selection: Selection,
  applying: ApplyingProgress,
  asking: Asking = { question: APPROVAL_QUESTION, afterPin: false },
): Approval {
  return {
    approve: async (review) => {
      printReport(context.out, { blocks: reviewBlocks(review, selection) });
      applying.review(review);
      if (planId !== undefined) {
        printReport(context.out, { blocks: [savedPlanApproved(planId)] });
        applying.applying();
        return true;
      }
      context.out("");
      const approved = (await context.prompt.ask(asking.question))?.trim() === "yes";
      if (approved && !asking.afterPin) applying.applying();
      return approved;
    },
  };
}

/** A failed worker stops the rollout: 1; a skipped one leaves it partial: 2. */
function workersExit(outcomes: readonly WorkerOutcome[]): 0 | 1 | 2 {
  if (outcomes.some((outcome) => outcome.kind === "failed")) return 1;
  return outcomes.some((outcome) => outcome.kind !== "installed" && outcome.kind !== "stopped")
    ? 2
    : 0;
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

/**
 * An applied run's exit code: 1 when a stage failed; 2 when it installed every worker but has
 * not reached its requested end state (a skip, a repository gap, dispatch pending, a deferred
 * maintenance), as a skip is; 0 otherwise. A stopped worker keeps 0.
 */
function appliedExit(result: Extract<FactoryApply, { readonly kind: "applied" }>): number {
  const workerCode = workersExit(result.workers);
  const repositoriesReady =
    result.repositories === undefined ||
    result.repositories.every(
      (outcome) => outcome.kind === "synchronized" || outcome.kind === "stopped",
    );
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

/** The outcomes that refuse the plan before anything is applied: restyled, with a Next block. */
type Refused =
  | PlanRefusal
  | Extract<FactoryApply, { readonly kind: "stale" | "no_plan" | "damaged_plan" }>;

/** Every refusal's kind: a kind added to `Refused` but not here fails to compile. */
const REFUSED: Readonly<Record<Refused["kind"], true>> = {
  refused: true,
  release_mismatch: true,
  d11: true,
  stopped_resize: true,
  unready: true,
  unexpected_plan: true,
  locked: true,
  stale: true,
  no_plan: true,
  damaged_plan: true,
};

const isRefused = (result: FactoryApply): result is Refused => Object.hasOwn(REFUSED, result.kind);

function refusalReport(result: Refused, context: CliContext, reporting: ApplyReporting): Report {
  const { selection } = reporting;
  switch (result.kind) {
    case "stale":
      return staleReport(result.planId, result.reasons, selection);
    case "no_plan":
      return unknownPlanReport(result.planId, selection);
    case "damaged_plan":
      return damagedPlanReport(result.planId, selection);
    default:
      return planRefusalReport(result, { action: reporting.action, now: context.now(), selection });
  }
}

/** Writes each line on the stream it is laid out for. */
function write(lines: readonly StreamLine[], context: CliContext): void {
  for (const { stream, line } of lines) context[stream](line);
}

/**
 * Reports how apply, or upgrade's apply, ended, and returns the exit code. What refused or
 * applied nothing is laid out as a refusal, on standard error; what ran is its Result and one
 * Next block, each line on its stream (`docs/specs/plan-apply.md` §Apply); an upgrade's pin
 * notice comes before the Next block either way.
 */
export function reportApply(
  result: FactoryApply,
  context: CliContext,
  reporting: ApplyReporting,
): number {
  if (isRefused(result)) {
    printReport(
      context.err,
      withNotice(refusalReport(result, context, reporting), pinNotice(reporting)),
    );
    return 1;
  }
  const styles = { out: context.out.style, err: context.err.style };
  switch (result.kind) {
    case "applied": {
      const code = appliedExit(result);
      write(appliedLines(result, reporting, styles), context);
      return code;
    }
    case "bootstrapped":
      write(bootstrappedLines(result, reporting, styles), context);
      return 0;
    case "failed":
      write(failedLines(result, reporting, styles), context);
      return 1;
    case "interrupted":
      write(interruptedLines(result, reporting, styles), context);
      return 1;
    default:
      printReport(
        context.err,
        withNotice(refusedRunReport(result, reporting), pinNotice(reporting)),
      );
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
  const applying = applyingProgress(context.out);
  const result = await applyFactory(
    {
      lockStore: context.lockStore,
      provisioner: context.provisioner,
      planStore: context.planStore,
      machines: context.machines,
      approval: operatorApproval(planId, context, values, applying),
      interrupted: context.interrupted,
      peers: context.tailnet,
      transport: context.transport,
      controlPlane: context.controlPlane,
      workflowQueue: context.workflowQueue,
      assets: context.assets,
      progress: applying.progress,
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
  return reportApply(result, context, { action: "apply", rerun: "apply", selection: values });
}

export const applyCommand: Command = {
  summary: "Apply the factory's plan after approval, under the factory-wide lock",
  usage: USAGE,
  run: apply,
  waitsOnInterrupt: true,
};
