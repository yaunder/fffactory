/**
 * Apply's workers stage as text: each worker's outcome under an aligned label, and an
 * installed worker's enrollment rendered from its `WorkerEnrollment`
 * (`docs/specs/plan-apply.md` §The workers stage, `docs/specs/readiness.md` §Where it is
 * reported). The domain decides each outcome and what is still to enroll; this lays it out.
 */
import {
  enrollmentNextAction,
  enrollmentReport,
  PASEO_CLIENTS,
  type Verification,
  type WorkerEnrollment,
  workerEnrollment,
} from "../../domain/readiness";
import type { WorkerOutcome } from "../../domain/rollout";

const LABELS: Readonly<Record<WorkerOutcome["kind"], string>> = {
  installed: "installed",
  skipped: "skipped",
  failed: "failed",
  not_attempted: "not tried",
  stopped: "stopped",
};
const LABEL_WIDTH = Math.max(...Object.values(LABELS).map((label) => label.length));
const INDENT = " ".repeat(2 + LABEL_WIDTH + 2);

/**
 * Each account still to enroll as one sentence: its title, the account's summary, then the
 * login and its commands.
 */
function accountLines(enrollment: WorkerEnrollment): string[] {
  return enrollment.accounts.map(({ id, title, commands }) => {
    const { summary } = enrollmentNextAction(id, enrollment.hostname);
    const steps = [enrollment.login, ...commands].map((command) => `\`${command}\``);
    return `${title}: ${summary}: run ${steps.join(", then ")}`;
  });
}

/**
 * What an installed worker still waits for: nothing, or accounts to enroll and how, in steps
 * the CLI names for `hostname`, the worker it resolved, never in the worker's own words.
 */
function installedLines(release: string, verification: Verification, hostname: string): string[] {
  const enrollment = workerEnrollment(enrollmentReport(verification, hostname), hostname);
  if (enrollment.accounts.length === 0)
    return [
      `release ${release} installed and verified; every account is enrolled`,
      `${INDENT}${PASEO_CLIENTS}`,
    ];
  return [
    `release ${release} installed and verified; enrollment pending: ${enrollment.accounts
      .map((account) => account.title)
      .join(", ")}`,
    ...[...accountLines(enrollment), PASEO_CLIENTS].map((line) => `${INDENT}${line}`),
  ];
}

/** One worker's outcome: its label, key and hostname, then what happened and what is next. */
export function workerLines(outcome: WorkerOutcome): string[] {
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
