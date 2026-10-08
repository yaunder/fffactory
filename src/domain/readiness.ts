/**
 * Readiness after software: what `host verify` reports (`docs/specs/readiness.md`). The
 * software checks say whether the release installed on a worker works; the enrollments say
 * which human steps it still waits for (GitHub and the model providers). The CLI names each
 * one's exact next action itself. Enrollment is guided, never automated: fffactory only
 * checks it.
 */
import {
  array,
  type DocumentParse,
  type Fields,
  HOST_PROTOCOL_VERSION,
  isoTime,
  NAME,
  oneOf,
  parseVersioned,
  record,
  SENTENCE,
  string,
  TOKEN,
} from "./protocol-fields";

/**
 * The accounts a worker needs a human to enroll and `host verify` checks, in the order they
 * are reported. Paseo clients are not among them yet: see `PASEO_CLIENTS`.
 */
export const ENROLLMENTS = [
  { id: "github", title: "GitHub" },
  { id: "openai", title: "OpenAI Codex" },
  { id: "anthropic", title: "Claude Code" },
] as const;
export type EnrollmentId = (typeof ENROLLMENTS)[number]["id"];
const ENROLLMENT_IDS: readonly EnrollmentId[] = ENROLLMENTS.map(({ id }) => id);

/**
 * A Paseo client's enrollment can be seen only from that client, not from the worker. Nothing
 * checks it on the worker and it does not count toward worker readiness: it is only mentioned.
 */
export const PASEO_CLIENTS =
  "Paseo clients: enrollment is checked from each client, not the worker";

/**
 * `enrolled`: the check passed. `pending`: it ran and found no credential. `unknown`: it
 * could not run, such as a tool that is missing.
 */
export const ENROLLMENT_STATES = ["enrolled", "pending", "unknown"] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

/** The runtime account every credential belongs to. */
export const RUNTIME_ACCOUNT = "factory";

/** What a human does to enroll one account on one worker. */
export interface NextAction {
  readonly summary: string;
  /** How to log in to the worker as the runtime account. */
  readonly login: string;
  /** The commands to run there, in order. */
  readonly commands: readonly string[];
}

/** One account's enrollment as the worker found it: states only, never instructions. */
export interface EnrollmentStatus {
  readonly id: EnrollmentId;
  readonly state: EnrollmentState;
}

export type CheckOutcome = "passed" | "failed";

/** One software verifier's result, in fffactory's own words. */
export interface SoftwareCheck {
  readonly id: string;
  readonly status: CheckOutcome;
  readonly summary: string;
}

/** `fffactory host verify --json`'s document. */
export interface Verification {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly hostname: string;
  readonly verified_at: string;
  readonly checks: readonly SoftwareCheck[];
  readonly enrollment: readonly EnrollmentStatus[];
}

/**
 * Tailscale SSH as the runtime account: the tailnet vouches for the host key, and the
 * credential is saved for `factory`, where agents use it, never for root.
 */
function login(hostname: string): string {
  return `tailscale ssh ${RUNTIME_ACCOUNT}@${hostname}`;
}

/** Logging in as `factory` is tailnet SSH policy's to allow, an administrator's step. */
const POLICY = `(tailnet SSH policy must let you log in as \`${RUNTIME_ACCOUNT}\`)`;

/**
 * The exact steps that enroll `id` on the worker `hostname`. Only the CLI makes them, from the
 * hostname it resolved: a worker reports states, never text an operator is told to run.
 */
export function enrollmentNextAction(id: EnrollmentId, hostname: string): NextAction {
  switch (id) {
    case "github":
      return {
        summary: `Authenticate GitHub as ${RUNTIME_ACCOUNT} on ${hostname} ${POLICY}`,
        login: login(hostname),
        commands: [
          "gh auth login --hostname github.com --git-protocol https --web",
          "gh auth status",
        ],
      };
    case "openai":
      return {
        summary: `Log in to OpenAI Codex as ${RUNTIME_ACCOUNT} on ${hostname} ${POLICY}`,
        login: login(hostname),
        commands: ["codex login --device-auth", "codex login status"],
      };
    case "anthropic":
      return {
        summary: `Log in to Claude Code as ${RUNTIME_ACCOUNT} on ${hostname} ${POLICY}`,
        login: login(hostname),
        commands: ["claude auth login", "claude auth status"],
      };
  }
}

/** One account's enrollment as the CLI reports it: its state, and its steps unless enrolled. */
export interface EnrollmentReport {
  readonly id: EnrollmentId;
  readonly title: string;
  readonly state: EnrollmentState;
  /** Null exactly when enrolled. */
  readonly next_action: NextAction | null;
}

/** `id`'s state as `verification` found it; `unknown` when the worker did not report it. */
function stateOf(verification: Verification, id: EnrollmentId): EnrollmentState {
  return verification.enrollment.find((entry) => entry.id === id)?.state ?? "unknown";
}

/**
 * Every account `ENROLLMENTS` names, in its order, as `verification` found it on the worker
 * `hostname` the CLI resolved; an account the worker did not report is `unknown`.
 */
export function enrollmentReport(verification: Verification, hostname: string): EnrollmentReport[] {
  return ENROLLMENTS.map(({ id, title }) => {
    const state = stateOf(verification, id);
    return {
      id,
      title,
      state,
      next_action: state === "enrolled" ? null : enrollmentNextAction(id, hostname),
    };
  });
}

/** The accounts of `report` still to enroll. */
export function pendingEnrollment(report: readonly EnrollmentReport[]): EnrollmentReport[] {
  return report.filter((entry) => entry.state !== "enrolled");
}

/**
 * Each account still to enroll as a line, its title and exact steps, then what Paseo clients
 * wait for.
 */
export function pendingEnrollmentLines(report: readonly EnrollmentReport[]): string[] {
  return [
    ...pendingEnrollment(report).flatMap(({ title, next_action }) =>
      next_action === null ? [] : [`${title}: ${describeNextAction(next_action)}`],
    ),
    PASEO_CLIENTS,
  ];
}

/** A next action as one sentence: its summary, then how to get there and what to run. */
export function describeNextAction(action: NextAction): string {
  const steps = [action.login, ...action.commands].map((command) => `\`${command}\``);
  return `${action.summary}: run ${steps.join(", then ")}`;
}

/**
 * The design's progression after software is installed: a failed check leaves the worker
 * unhealthy; otherwise it is usable once every account is enrolled, and enrollment is
 * pending until then.
 */
export type WorkerReadiness = "unhealthy" | "enrollment_pending" | "usable";

export function workerReadiness(verification: Verification): WorkerReadiness {
  if (verification.checks.some((check) => check.status === "failed")) return "unhealthy";
  if (ENROLLMENTS.some(({ id }) => stateOf(verification, id) !== "enrolled"))
    return "enrollment_pending";
  return "usable";
}

/** A next action's fields in their fixed order, as JSON reports them. */
export function nextActionFields(action: NextAction) {
  return { summary: action.summary, login: action.login, commands: [...action.commands] };
}

/** The document's fields in their fixed order, for embedding in another document. */
export function verificationFields(verification: Verification) {
  return {
    protocol_version: verification.protocol_version,
    hostname: verification.hostname,
    verified_at: verification.verified_at,
    checks: verification.checks.map(({ id, status, summary }) => ({ id, status, summary })),
    enrollment: verification.enrollment.map(({ id, state }) => ({ id, state })),
  };
}

/** The document as the worker prints it: keys in a fixed order, two-space indented. */
export function verificationJson(verification: Verification): string {
  return JSON.stringify(verificationFields(verification), null, 2);
}

function readCheck(value: unknown, path: string): SoftwareCheck {
  const check = record(value, path);
  return {
    id: string(check.id, `${path}.id`, NAME),
    status: oneOf(check.status, `${path}.status`, ["passed", "failed"] as const),
    summary: string(check.summary, `${path}.summary`, SENTENCE),
  };
}

/** An account's state; any instructions a worker sends with it are ignored, never shown. */
function readEnrollment(value: unknown, path: string): EnrollmentStatus {
  const entry = record(value, path);
  return {
    id: oneOf(entry.id, `${path}.id`, ENROLLMENT_IDS),
    state: oneOf(entry.state, `${path}.state`, ENROLLMENT_STATES),
  };
}

/**
 * Reads the verify document's fields, standing alone or embedded in another document under
 * `prefix`, such as `verification.`.
 */
export function readVerification(document: Fields, prefix = ""): Verification {
  const checks = `${prefix}checks`;
  const enrollment = `${prefix}enrollment`;
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname: string(document.hostname, `${prefix}hostname`, TOKEN),
    verified_at: isoTime(document.verified_at, `${prefix}verified_at`),
    checks: array(document.checks, checks).map((value, index) =>
      readCheck(value, `${checks}[${index}]`),
    ),
    enrollment: array(document.enrollment, enrollment).map((value, index) =>
      readEnrollment(value, `${enrollment}[${index}]`),
    ),
  };
}

/** Reads `host verify --json` output on the CLI side. */
export function parseVerification(text: string): DocumentParse<Verification> {
  return parseVersioned(text, (document) => readVerification(document));
}
