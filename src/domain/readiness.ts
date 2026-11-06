/**
 * Readiness after software: what `host verify` reports (`docs/specs/readiness.md`). The
 * software checks say whether the release installed on a worker works; the enrollments say
 * which accounts it still waits for (GitHub and the model providers). The CLI names each
 * one's exact next action itself: a human login on the worker, or, for an account whose API
 * credential factory.json delivers to it, storing a valid one. fffactory never performs a
 * human login: it only checks it.
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
import type { SecretName } from "./secrets";

/**
 * The accounts a worker needs enrolled and `host verify` checks, in the order they are
 * reported, each with the API credential that can be delivered for it: what it is and the
 * `fffactory secret set` name that stores it. Paseo clients are not among them yet: see
 * `PASEO_CLIENTS`.
 */
export const ENROLLMENTS = [
  { id: "github", title: "GitHub", credential: "GitHub token", secret: "github-token" },
  { id: "openai", title: "OpenAI Codex", credential: "OpenAI API key", secret: "openai-api-key" },
  {
    id: "anthropic",
    title: "Claude Code",
    credential: "Anthropic API key",
    secret: "anthropic-api-key",
  },
] as const satisfies readonly {
  readonly id: string;
  readonly title: string;
  readonly credential: string;
  readonly secret: SecretName;
}[];
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

/**
 * What an operator does to enroll one account on one worker: log in there and run its
 * commands, or, for a delivered account, run them on the workstation.
 */
export interface NextAction {
  /** Published wording: status's `next_action.summary` and `details` carry it. */
  readonly summary: string;
  /**
   * How to log in to the worker as the runtime account; null for a delivered account, whose
   * commands run where fffactory does.
   */
  readonly login: string | null;
  /** The commands to run, in order. */
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
export function runtimeLogin(hostname: string): string {
  return `tailscale ssh ${RUNTIME_ACCOUNT}@${hostname}`;
}

/** Logging in as `factory` is tailnet SSH policy's to allow, an administrator's step. */
export const RUNTIME_LOGIN_POLICY = `tailnet SSH policy must let you log in as \`${RUNTIME_ACCOUNT}\``;

/**
 * GitHub's check, as `host verify` runs it and the steps end with it: the active account only,
 * so a stale stored account does not fail an active one that works.
 */
export const GITHUB_STATUS: readonly string[] = [
  "gh",
  "auth",
  "status",
  "--hostname",
  "github.com",
  "--active",
];

/** Each account's `ENROLLMENTS` entry, by its `id`. */
const BY_ID = Object.fromEntries(ENROLLMENTS.map((entry) => [entry.id, entry])) as Readonly<
  Record<EnrollmentId, (typeof ENROLLMENTS)[number]>
>;

/** `id`'s `ENROLLMENTS` entry. */
export function enrollmentOf(id: EnrollmentId): (typeof ENROLLMENTS)[number] {
  return BY_ID[id];
}

/** A delivered account's credential, refused by the worker: store a valid one and apply it. */
function deliveredNextAction(id: EnrollmentId, hostname: string): NextAction {
  const { credential, secret } = enrollmentOf(id);
  return {
    summary: `Replace the ${credential}, which ${hostname} did not accept`,
    login: null,
    commands: [`fffactory secret set ${secret}`, "fffactory apply"],
  };
}

/**
 * The exact steps that enroll `id` on the worker `hostname`: for an account factory.json
 * `delivered` to it, storing a valid credential and applying it; otherwise a human login there.
 * Only the CLI makes them, from the hostname it resolved and factory.json's delivered accounts:
 * a worker reports states, never text an operator is told to run.
 */
export function enrollmentNextAction(
  id: EnrollmentId,
  hostname: string,
  delivered: boolean,
): NextAction {
  if (delivered) return deliveredNextAction(id, hostname);
  switch (id) {
    case "github":
      return {
        summary: `Authenticate GitHub as ${RUNTIME_ACCOUNT} on ${hostname}`,
        login: runtimeLogin(hostname),
        commands: [
          "gh auth login --hostname github.com --git-protocol https --web",
          GITHUB_STATUS.join(" "),
        ],
      };
    case "openai":
      return {
        summary: `Log in to OpenAI Codex as ${RUNTIME_ACCOUNT} on ${hostname}`,
        login: runtimeLogin(hostname),
        commands: ["codex login --device-auth", "codex login status"],
      };
    case "anthropic":
      return {
        summary: `Log in to Claude Code as ${RUNTIME_ACCOUNT} on ${hostname}`,
        login: runtimeLogin(hostname),
        commands: ["claude auth login", "claude auth status"],
      };
  }
}

/** One account's enrollment as the CLI reports it: its state, and its steps unless enrolled. */
export interface EnrollmentReport {
  readonly id: EnrollmentId;
  readonly title: string;
  readonly state: EnrollmentState;
  /** factory.json delivers the account's API credential to the worker. */
  readonly delivered: boolean;
  /** Null exactly when enrolled. */
  readonly next_action: NextAction | null;
}

/** `id`'s state as `verification` found it; `unknown` when the worker did not report it. */
function stateOf(verification: Verification, id: EnrollmentId): EnrollmentState {
  return verification.enrollment.find((entry) => entry.id === id)?.state ?? "unknown";
}

/**
 * Every account `ENROLLMENTS` names, in its order, as `verification` found it on the worker
 * `hostname` the CLI resolved; an account the worker did not report is `unknown`. `delivered`
 * is factory.json's (`deliveredAccounts`), never the worker's.
 */
export function enrollmentReport(
  verification: Verification,
  hostname: string,
  delivered: readonly EnrollmentId[],
): EnrollmentReport[] {
  return ENROLLMENTS.map(({ id, title }) => {
    const state = stateOf(verification, id);
    const isDelivered = delivered.includes(id);
    return {
      id,
      title,
      state,
      delivered: isDelivered,
      next_action: state === "enrolled" ? null : enrollmentNextAction(id, hostname, isDelivered),
    };
  });
}

/** The accounts of `report` still to enroll. */
export function pendingEnrollment(report: readonly EnrollmentReport[]): EnrollmentReport[] {
  return report.filter((entry) => entry.state !== "enrolled");
}

/**
 * Each account still to enroll as a line, its title and exact steps, then what Paseo clients
 * wait for. Published wording: status's `details` for a worker with enrollment pending, in
 * text and `--json` alike. Human layout renders a `WorkerEnrollment` instead.
 */
export function pendingEnrollmentLines(report: readonly EnrollmentReport[]): string[] {
  return [
    ...pendingEnrollment(report).flatMap(({ title, next_action }) =>
      next_action === null ? [] : [`${title}: ${describeNextAction(next_action)}`],
    ),
    PASEO_CLIENTS,
  ];
}

/**
 * A next action as one sentence: its summary, then how to get there and what to run. Published
 * wording: the sentence in status's `details` and a dispatch gate's next action.
 */
export function describeNextAction(action: NextAction): string {
  const login = action.login === null ? [] : [action.login];
  const steps = [...login, ...action.commands].map((command) => `\`${command}\``);
  return `${action.summary}: run ${steps.join(", then ")}`;
}

/** One account still to enroll on a worker: the commands to run once logged in. */
export interface EnrollmentAccount {
  readonly id: EnrollmentId;
  readonly title: string;
  readonly commands: readonly string[];
}

/**
 * One delivered account still to enroll on a worker: the worker did not accept its credential,
 * which `fffactory secret set SECRET` replaces and the next apply delivers.
 */
export interface DeliveredEnrollment {
  readonly id: EnrollmentId;
  readonly title: string;
  /** What the credential is, such as `GitHub token`. */
  readonly credential: string;
  readonly secret: SecretName;
}

/**
 * A worker's enrollment grouped for an operator: one login to the runtime account, what that
 * login requires (`tailnet_ssh_as_runtime`: tailnet SSH policy must let the operator log in as
 * `factory`, `RUNTIME_LOGIN_POLICY`), then each account still to enroll there, in
 * `ENROLLMENTS`' order; and apart, each delivered account still to enroll, whose credential is
 * replaced from the workstation. The structure human output renders from; status's published
 * `details` and `next_action` keep their own wording.
 */
export interface WorkerEnrollment {
  readonly hostname: string;
  readonly login: string;
  readonly requirement: "tailnet_ssh_as_runtime";
  readonly accounts: readonly EnrollmentAccount[];
  readonly delivered: readonly DeliveredEnrollment[];
}

/** `report`'s accounts still to enroll on the worker `hostname` the CLI resolved, grouped. */
export function workerEnrollment(
  report: readonly EnrollmentReport[],
  hostname: string,
): WorkerEnrollment {
  const pending = pendingEnrollment(report);
  return {
    hostname,
    login: runtimeLogin(hostname),
    requirement: "tailnet_ssh_as_runtime",
    accounts: pending.flatMap(({ id, title, delivered, next_action }) =>
      delivered || next_action === null ? [] : [{ id, title, commands: [...next_action.commands] }],
    ),
    delivered: pending.flatMap(({ id, title, delivered }) => {
      if (!delivered) return [];
      const { credential, secret } = enrollmentOf(id);
      return [{ id, title, credential, secret }];
    }),
  };
}

/** How many accounts `enrollment` still has to enroll, by login or by a delivered credential. */
export function pendingCount(enrollment: WorkerEnrollment): number {
  return enrollment.accounts.length + enrollment.delivered.length;
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
