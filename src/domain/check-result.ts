/**
 * Doctor's result model: checks grouped by capability, each with one status, and the rule
 * that turns the worst status into an exit code.
 */

/**
 * `ready`: inspected and in the required state. `not_ready`: inspected, and something the
 * operator can fix is missing or wrong. `error`: doctor could not make the observation.
 */
export type CheckStatus = "ready" | "not_ready" | "error";

export interface CheckIdentity {
  /** Stable machine-readable ID, such as `tailscale`. */
  readonly id: string;
  readonly title: string;
}

interface CheckBase extends CheckIdentity {
  readonly summary: string;
  /** Further lines, such as missing field paths. Never configuration values. */
  readonly details: readonly string[];
}

/** One check. Every check that is not ready carries the exact next action. */
export type CheckResult =
  | (CheckBase & { readonly status: "ready"; readonly nextAction: null })
  | (CheckBase & { readonly status: "not_ready" | "error"; readonly nextAction: string });

export interface Capability extends CheckIdentity {
  readonly status: CheckStatus;
  readonly checks: readonly CheckResult[];
}

export interface DoctorReport {
  readonly status: CheckStatus;
  readonly capabilities: readonly Capability[];
}

export function ready(
  check: CheckIdentity,
  summary: string,
  details: readonly string[] = [],
): CheckResult {
  return { ...check, status: "ready", summary, details, nextAction: null };
}

export function notReady(
  check: CheckIdentity,
  summary: string,
  nextAction: string,
  details: readonly string[] = [],
): CheckResult {
  return { ...check, status: "not_ready", summary, details, nextAction };
}

/** A check doctor could not inspect. */
export function failed(
  check: CheckIdentity,
  summary: string,
  nextAction: string,
  details: readonly string[] = [],
): CheckResult {
  return { ...check, status: "error", summary, details, nextAction };
}

/** Completes a next action: every one ends by asking the operator to rerun doctor. */
export function thenRerun(action: string): string {
  return `${action}, then rerun \`fffactory doctor\`.`;
}

const SEVERITY: Readonly<Record<CheckStatus, number>> = { ready: 0, not_ready: 1, error: 2 };

/** `error` over `not_ready` over `ready`; nothing to inspect is ready. */
export function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>(
    (worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    "ready",
  );
}

export function capability(identity: CheckIdentity, checks: readonly CheckResult[]): Capability {
  return { ...identity, status: worstStatus(checks.map((check) => check.status)), checks };
}

export function doctorReport(capabilities: readonly Capability[]): DoctorReport {
  return { status: worstStatus(capabilities.map((group) => group.status)), capabilities };
}

export function attentionCount(report: DoctorReport): { attention: number; total: number } {
  const checks = report.capabilities.flatMap((group) => group.checks);
  return {
    attention: checks.filter((check) => check.status !== "ready").length,
    total: checks.length,
  };
}

const EXIT_CODES: Readonly<Record<CheckStatus, 0 | 1 | 2>> = { ready: 0, not_ready: 2, error: 1 };

/**
 * 0 when everything is ready; 2 when inspection succeeded but something is not ready;
 * 1 when some inspection itself failed.
 */
export function exitCodeFor(status: CheckStatus): 0 | 1 | 2 {
  return EXIT_CODES[status];
}
