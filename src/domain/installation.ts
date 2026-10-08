/**
 * Installing a release on a worker (`docs/specs/host-protocol.md` §apply): the wrapped setup
 * steps and their order, each step's result, the install's state, and `host apply`'s
 * document, which the worker also keeps as its record of the last install. Pure.
 */
import {
  array,
  type DocumentParse,
  type Fields,
  HOST_PROTOCOL_VERSION,
  Invalid,
  isoTime,
  NAME,
  nullable,
  oneOf,
  parseVersioned,
  RELEASE_VERSION,
  record,
  SENTENCE,
  sha256,
  string,
  TOKEN,
} from "./protocol-fields";
import { readVerification, type Verification, verificationFields } from "./readiness";

const MINUTE_MS = 60_000;

/**
 * The wrapped setup steps, `steps/<name>.sh` in the release, run in this order in one
 * process. Each is idempotent, so a rerun repairs what a failed one left.
 */
export const INSTALL_STEPS = [
  /** Amazon Linux packages, the GitHub CLI and ripgrep. */
  { name: "packages", timeoutMs: 20 * MINUTE_MS },
  /** The runtime account's directories, profile, npm prefix and Git defaults. */
  { name: "user", timeoutMs: 5 * MINUTE_MS },
  /** The services a worker runs, enabled and started. */
  { name: "systemd", timeoutMs: 2 * MINUTE_MS },
  /** Codex and Claude Code at their pinned versions. */
  { name: "harness", timeoutMs: 20 * MINUTE_MS },
  /** The pinned agent plugins. */
  { name: "plugins", timeoutMs: 15 * MINUTE_MS },
] as const;
export type StepName = (typeof INSTALL_STEPS)[number]["name"];

/**
 * The verifiers' whole budget, after the steps: `host apply` fails an install whose
 * verification takes longer, and the CLI's wait includes it.
 */
export const VERIFY_TIMEOUT_MS = 5 * MINUTE_MS;

/** How long the CLI waits for the activator and `host apply`: every step, verification, slack. */
export const ACTIVATION_TIMEOUT_MS =
  INSTALL_STEPS.reduce((total, step) => total + step.timeoutMs, 0) +
  VERIFY_TIMEOUT_MS +
  5 * MINUTE_MS;

export type StepStatus = "succeeded" | "failed" | "not_run";

export interface StepResult {
  readonly name: string;
  readonly status: StepStatus;
  /** Why it failed, in fffactory's own words; null unless it failed. */
  readonly reason: string | null;
}

/** Every step, none run yet. */
export function pendingSteps(
  steps: readonly { readonly name: string }[] = INSTALL_STEPS,
): StepResult[] {
  return steps.map(({ name }) => ({ name, status: "not_run", reason: null }));
}

/** `steps` with `name` now at `status`. */
export function withStep(
  steps: readonly StepResult[],
  name: string,
  status: StepStatus,
  reason: string | null = null,
): StepResult[] {
  return steps.map((step) => (step.name === name ? { name, status, reason } : step));
}

/**
 * `running` until it ends: `failed` at the first failed step or failed check, or a failure
 * outside them, `succeeded` once every step succeeded and verification passed every check.
 * Enrollment pending is still `succeeded`: the software is installed.
 */
export type InstallState = "running" | "succeeded" | "failed";

export function installState(
  steps: readonly StepResult[],
  verification: Verification | null,
  failure: string | null = null,
): InstallState {
  if (failure !== null || steps.some((step) => step.status === "failed")) return "failed";
  if (!steps.every((step) => step.status === "succeeded") || verification === null)
    return "running";
  return verification.checks.some((check) => check.status === "failed") ? "failed" : "succeeded";
}

export function failedStep(steps: readonly StepResult[]): StepResult | undefined {
  return steps.find((step) => step.status === "failed");
}

/** `host apply`'s record of an install, kept on the worker and printed when it ends. */
export interface HostApplyRecord {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly hostname: string;
  readonly state: InstallState;
  /** The release installed, which is active from the first step on. */
  readonly release: string;
  /** SHA-256 of the host configuration installed with it. */
  readonly configuration_sha256: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly steps: readonly StepResult[];
  /** Null until every step succeeded and the verifiers ran. */
  readonly verification: Verification | null;
  /**
   * Why the install failed outside its steps and checks, such as a record, log or link it
   * could not write, or verification that did not finish, in fffactory's own words; null
   * otherwise.
   */
  readonly failure: string | null;
}

/** Why `host apply` changed nothing at all. */
export const REFUSALS = [
  "not_root",
  /** Another `host apply` holds the install lock: an install is still running. */
  "busy",
  "invalid_configuration",
  "other_host",
  "release_mismatch",
  "release_missing",
  "bootstrap_incomplete",
  "unsupported_base",
] as const;
export type RefusalReason = (typeof REFUSALS)[number];

export interface HostApplyRefusal {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly hostname: string;
  readonly state: "refused";
  readonly reason: RefusalReason;
  /** In fffactory's own words. */
  readonly message: string;
}

/** `fffactory host apply`'s document. */
export type HostApplyResult = HostApplyRecord | HostApplyRefusal;

function stepFields({ name, status, reason }: StepResult) {
  return { name, status, reason };
}

/** The document as the worker prints and keeps it: keys in a fixed order, two-space indented. */
export function hostApplyJson(result: HostApplyResult): string {
  if (result.state === "refused") {
    const { protocol_version, hostname, state, reason, message } = result;
    return JSON.stringify({ protocol_version, hostname, state, reason, message }, null, 2);
  }
  return JSON.stringify(
    {
      protocol_version: result.protocol_version,
      hostname: result.hostname,
      state: result.state,
      release: result.release,
      configuration_sha256: result.configuration_sha256,
      started_at: result.started_at,
      finished_at: result.finished_at,
      steps: result.steps.map(stepFields),
      verification: result.verification === null ? null : verificationFields(result.verification),
      failure: result.failure,
    },
    null,
    2,
  );
}

function readStep(value: unknown, index: number): StepResult {
  const path = `steps[${index}]`;
  const step = record(value, path);
  const status = oneOf(step.status, `${path}.status`, ["succeeded", "failed", "not_run"] as const);
  const reason = nullable(step.reason, (text) => string(text, `${path}.reason`, SENTENCE));
  if ((status === "failed") !== (reason !== null))
    throw new Invalid(`${path}.reason must be given exactly when the step failed`);
  return { name: string(step.name, `${path}.name`, NAME), status, reason };
}

function readEmbeddedVerification(value: unknown): Verification {
  return readVerification(record(value, "verification"), "verification.");
}

/** A failure outside the steps; absent, as from a worker that never records one, is none. */
function readFailure(value: unknown, path: string): string | null {
  return value === undefined ? null : nullable(value, (text) => string(text, path, SENTENCE));
}

function readRecord(document: Fields, hostname: string): HostApplyRecord {
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname,
    state: oneOf(document.state, "state", ["running", "succeeded", "failed"] as const),
    release: string(document.release, "release", RELEASE_VERSION),
    configuration_sha256: sha256(document.configuration_sha256, "configuration_sha256"),
    started_at: isoTime(document.started_at, "started_at"),
    finished_at: nullable(document.finished_at, (time) => isoTime(time, "finished_at")),
    steps: array(document.steps, "steps").map(readStep),
    verification: nullable(document.verification, readEmbeddedVerification),
    failure: readFailure(document.failure, "failure"),
  };
}

function readResult(document: Fields): HostApplyResult {
  const hostname = string(document.hostname, "hostname", TOKEN);
  if (document.state !== "refused") return readRecord(document, hostname);
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname,
    state: "refused",
    reason: oneOf(document.reason, "reason", REFUSALS),
    message: string(document.message, "message", SENTENCE),
  };
}

/**
 * The last install as `host inspect` reports it: none recorded, a record that cannot be read,
 * or the record's state, release, configuration, failed step and verification.
 */
export type Installation =
  | { readonly state: "none" }
  | { readonly state: "unreadable" }
  | RecordedInstallation;

export interface RecordedInstallation {
  readonly state: InstallState;
  readonly release: string;
  readonly configuration_sha256: string;
  readonly failed_step: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly verification: Verification | null;
  readonly failure: string | null;
}

export function installationOf(record: HostApplyRecord): RecordedInstallation {
  return {
    state: record.state,
    release: record.release,
    configuration_sha256: record.configuration_sha256,
    failed_step: failedStep(record.steps)?.name ?? null,
    started_at: record.started_at,
    finished_at: record.finished_at,
    verification: record.verification,
    failure: record.failure,
  };
}

export function installationFields(installation: Installation) {
  if (installation.state === "none" || installation.state === "unreadable")
    return { state: installation.state };
  const { verification } = installation;
  return {
    state: installation.state,
    release: installation.release,
    configuration_sha256: installation.configuration_sha256,
    failed_step: installation.failed_step,
    started_at: installation.started_at,
    finished_at: installation.finished_at,
    verification: verification === null ? null : verificationFields(verification),
    failure: installation.failure,
  };
}

/** Reads the `installation` field of an inspection. */
export function readInstallation(value: unknown): Installation {
  const installation = record(value, "installation");
  const state = oneOf(installation.state, "installation.state", [
    "none",
    "unreadable",
    "running",
    "succeeded",
    "failed",
  ] as const);
  if (state === "none" || state === "unreadable") return { state };
  return {
    state,
    release: string(installation.release, "installation.release", RELEASE_VERSION),
    configuration_sha256: sha256(
      installation.configuration_sha256,
      "installation.configuration_sha256",
    ),
    failed_step: nullable(installation.failed_step, (name) =>
      string(name, "installation.failed_step", NAME),
    ),
    started_at: isoTime(installation.started_at, "installation.started_at"),
    finished_at: nullable(installation.finished_at, (time) =>
      isoTime(time, "installation.finished_at"),
    ),
    verification: nullable(installation.verification, (verification) =>
      readVerification(
        record(verification, "installation.verification"),
        "installation.verification.",
      ),
    ),
    failure: readFailure(installation.failure, "installation.failure"),
  };
}

/** Reads `host apply` output, or the worker's kept record, the same way. */
export function parseHostApply(text: string): DocumentParse<HostApplyResult> {
  return parseVersioned(text, readResult);
}

/**
 * What the activator's exit statuses mean when no `host apply` document came back
 * (`docs/specs/worker-bootstrap.md` §Activator).
 */
const ACTIVATOR_EXITS: Readonly<Record<number, string>> = {
  1: "sudo refused to run the activator, or host apply ended without a result",
  64: "the activator refused its arguments",
  65: "the worker refused the release tarball: it did not pass the activator's digest and content checks",
  75: "another activation is running on the worker",
  77: "the activator did not run as root",
  127: "the worker has no activator or no sudo",
};

/** What the CLI got back from running the activator. */
export type ActivationAnswer =
  | { readonly kind: "result"; readonly result: HostApplyResult }
  | { readonly kind: "no_result"; readonly reason: string };

/**
 * Reads the activator's answer: `host apply`'s document when it printed one, whatever its
 * exit status, and otherwise what the status means. Never quotes the output.
 */
export function readActivation(exitCode: number, stdout: string): ActivationAnswer {
  const parsed = parseHostApply(stdout);
  if (parsed.ok) return { kind: "result", result: parsed.document };
  if (parsed.kind === "unsupported_version")
    return {
      kind: "no_result",
      reason: `host apply answered in host protocol version ${parsed.version}; this fffactory speaks version ${HOST_PROTOCOL_VERSION}`,
    };
  if (stdout.trim() !== "")
    return {
      kind: "no_result",
      reason: `host apply's answer is not a host apply document: ${parsed.problem}`,
    };
  return {
    kind: "no_result",
    reason: ACTIVATOR_EXITS[exitCode] ?? `the activator exited with status ${exitCode}`,
  };
}
