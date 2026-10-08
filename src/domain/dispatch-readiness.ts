/**
 * Dispatch readiness (pure; `docs/specs/dispatch.md`). Requested dispatch and active dispatch
 * are distinct: factory.json requests dispatch on a host, but apply keeps it inactive until
 * every readiness gate passes, and a later apply activates it automatically once they do.
 *
 * This module holds the gate matrix and the requested-vs-active state. The gates are pure
 * functions of inputs the apply stages gather: the worker's release health and GitHub
 * credential (the workers stage's verification), its repository synchronization (the repository
 * stage), FFFlow adoption (the `WorkflowQueue`), and Paseo health (the control-plane stage).
 * `application/apply-dispatch.ts` gathers those inputs and drives activation; it never decides
 * readiness itself.
 */
import type { RepositoryReadiness } from "./repository-placement";
import {
  describeNextAction,
  type EnrollmentState,
  enrollmentNextAction,
  type Verification,
} from "./readiness";

/** Paseo's health as the dispatch gate reads it; the control-plane stage supplies it. */
export type PaseoHealth = "healthy" | "unhealthy" | "unknown";

/** FFFlow adoption readiness for the placed repositories, as the `WorkflowQueue` reports it. */
export type AdoptionState = "passed" | "failed" | "unknown";

/**
 * The dispatch gates, in the order they are reported. Every one must pass before apply
 * activates dispatch; any one failing keeps it pending. The table is closed: a new gate is one
 * more entry here and in the spec.
 */
export const DISPATCH_GATES = [
  "worker_release",
  "github_credential",
  "repository_sync",
  "ffflow_adoption",
  "paseo_health",
] as const;
export type DispatchGate = (typeof DISPATCH_GATES)[number];

/** What each gate is evaluated against; all pure, domain-owned values. */
export interface DispatchGateInputs {
  /** The worker's release is installed and verified (the workers stage marked it installed). */
  readonly releaseHealthy: boolean;
  /** The GitHub credential's enrollment state, from the worker's verification. */
  readonly githubCredential: EnrollmentState;
  /** Whether every placed checkout synchronized (the repository stage). */
  readonly repositorySync: RepositoryReadiness;
  /** Whether FFFlow adoption passes for the placed repositories (the `WorkflowQueue`). */
  readonly ffflowAdoption: AdoptionState;
  /** Paseo's health on the worker (the control-plane stage). */
  readonly paseoHealth: PaseoHealth;
}

/** One gate's result: whether it passed, in fffactory's own words, and what unblocks it. */
export interface DispatchGateResult {
  readonly gate: DispatchGate;
  readonly passed: boolean;
  readonly summary: string;
  /** What unblocks the gate when it has not passed; null once it has. */
  readonly nextAction: string | null;
}

function result(
  gate: DispatchGate,
  passed: boolean,
  passedSummary: string,
  failedSummary: string,
  failedAction: string,
): DispatchGateResult {
  return passed
    ? { gate, passed: true, summary: passedSummary, nextAction: null }
    : { gate, passed: false, summary: failedSummary, nextAction: failedAction };
}

/** The GitHub credential's state as the worker verified it; unknown without a verification. */
export function githubCredential(verification: Verification | null): EnrollmentState {
  if (verification === null) return "unknown";
  return verification.enrollment.find((entry) => entry.id === "github")?.state ?? "unknown";
}

function githubGate(state: EnrollmentState, hostname: string): DispatchGateResult {
  const failed =
    state === "pending"
      ? `GitHub is not authenticated for the runtime account on ${hostname}`
      : `GitHub authentication could not be checked on ${hostname}`;
  return result(
    "github_credential",
    state === "enrolled",
    "GitHub is authenticated for the runtime account",
    failed,
    describeNextAction(enrollmentNextAction("github", hostname)),
  );
}

/** Every gate's result for one worker, in `DISPATCH_GATES` order. */
export function evaluateDispatchGates(
  inputs: DispatchGateInputs,
  hostname: string,
): DispatchGateResult[] {
  return [
    result(
      "worker_release",
      inputs.releaseHealthy,
      "The worker's release is installed and verified",
      "The worker's release is not installed and verified",
      "Install and verify the release with `fffactory apply`",
    ),
    githubGate(inputs.githubCredential, hostname),
    result(
      "repository_sync",
      inputs.repositorySync === "ready",
      "Every placed repository is synchronized",
      `Some repositories on ${hostname} are not synchronized`,
      "Resolve the reported checkouts and rerun `fffactory apply`",
    ),
    result(
      "ffflow_adoption",
      inputs.ffflowAdoption === "passed",
      "FFFlow adoption passes for the placed repositories",
      inputs.ffflowAdoption === "failed"
        ? `A placed repository on ${hostname} does not pass FFFlow adoption`
        : `FFFlow adoption could not be checked on ${hostname}`,
      "Adopt FFFlow (`.ffflow/config.yaml`) on the placed repositories and rerun `fffactory apply`",
    ),
    result(
      "paseo_health",
      inputs.paseoHealth === "healthy",
      "Paseo is healthy",
      inputs.paseoHealth === "unhealthy"
        ? `Paseo is not healthy on ${hostname}`
        : `Paseo health could not be read on ${hostname}`,
      `Check \`systemctl status paseo.service\` on ${hostname} and rerun \`fffactory apply\``,
    ),
  ];
}

/**
 * Requested dispatch's readiness: not evaluated when factory.json does not request it; active
 * once every gate passes; pending, with the blocking gates, until then.
 */
export type DispatchState =
  | { readonly kind: "not_requested" }
  | {
      readonly kind: "pending";
      readonly gates: readonly DispatchGateResult[];
      readonly blocking: readonly DispatchGateResult[];
    }
  | { readonly kind: "active"; readonly gates: readonly DispatchGateResult[] };

/**
 * One worker's dispatch state: `requested` is factory.json's `hosts[].dispatch.enabled`; the
 * gates decide active versus pending.
 */
export function dispatchState(
  requested: boolean,
  inputs: DispatchGateInputs,
  hostname: string,
): DispatchState {
  if (!requested) return { kind: "not_requested" };
  const gates = evaluateDispatchGates(inputs, hostname);
  const blocking = gates.filter((gate) => !gate.passed);
  return blocking.length === 0 ? { kind: "active", gates } : { kind: "pending", gates, blocking };
}

/**
 * The readiness progression's dispatch step: initialized -> … -> dispatch pending or active.
 * Apply drives and reports this; `status` reflects only the GitHub-credential gate today.
 */
// TODO(re-evaluate when status can observe dispatch readiness): surface the dispatch state in
// `fffactory status`. Status runs unprivileged and reads only the last install's recorded
// verification, so it cannot yet evaluate the repository-sync, FFFlow-adoption and Paseo-health
// gates the way apply does.
export type DispatchReadiness = "not_requested" | "pending" | "active";

export function dispatchReadiness(state: DispatchState): DispatchReadiness {
  return state.kind === "not_requested" ? "not_requested" : state.kind;
}

/** A one-line description of a worker's dispatch state, for apply and status. */
export function describeDispatch(state: DispatchState): string {
  switch (state.kind) {
    case "not_requested":
      return "Dispatch: not requested in factory.json";
    case "active":
      return "Dispatch: active";
    case "pending":
      return `Dispatch: pending — ${state.blocking.map((gate) => gate.summary).join("; ")}`;
  }
}

/** Each blocking gate's next action as a line, for apply and status; empty unless pending. */
export function dispatchNextActions(state: DispatchState): string[] {
  if (state.kind !== "pending") return [];
  return state.blocking.flatMap((gate) =>
    gate.nextAction === null ? [] : [`${gate.summary}: ${gate.nextAction}`],
  );
}
