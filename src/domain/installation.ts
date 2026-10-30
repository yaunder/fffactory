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
 * The install steps (shell assets, then the native TypeScript plugins and credentials steps),
 * run in this order in one process. Each is idempotent, so a rerun repairs what a failed one
 * left.
 */
export const INSTALL_STEPS = [
  /** Amazon Linux packages, the GitHub CLI, and pinned ripgrep, just and pnpm. */
  { name: "packages", timeoutMs: 20 * MINUTE_MS },
  /** The runtime account's directories, profile, npm prefix and Git defaults. */
  { name: "user", timeoutMs: 5 * MINUTE_MS },
  /** The services a worker runs, enabled and started. */
  { name: "systemd", timeoutMs: 2 * MINUTE_MS },
  /** Codex and Claude Code at their pinned versions. */
  { name: "harness", timeoutMs: 20 * MINUTE_MS },
  /** The pinned agent plugins. */
  { name: "plugins", timeoutMs: 15 * MINUTE_MS, implementation: "plugins" },
  /** The API credentials delivered to the host, in each tool's own store. */
  { name: "credentials", timeoutMs: 10 * MINUTE_MS, implementation: "credentials" },
] as const;
export type StepName = (typeof INSTALL_STEPS)[number]["name"];

/**
 * The deadline of each login that takes delivered material (`gh auth login`, `codex login`);
 * every other command of the credentials step has `CREDENTIAL_COMMAND_TIMEOUT_MS`
 * (`docs/specs/credential-delivery.md`).
 */
export const CREDENTIAL_LOGIN_TIMEOUT_MS = 60_000;
export const CREDENTIAL_COMMAND_TIMEOUT_MS = 30_000;

/** The delivered Anthropic API key: `factory`'s own 0600 file, which the helper reads. */
export const ANTHROPIC_KEY_FILE = "/home/factory/.config/fffactory/anthropic-api-key";

/** fffactory's Claude Code API key helper: the command Claude Code runs, as `factory`, for the key. */
export const ANTHROPIC_KEY_HELPER = `cat ${ANTHROPIC_KEY_FILE}`;

/**
 * Claude Code's root-owned managed settings. The `credentials` step composes them from what
 * fffactory needs (`claudeManagedSettingsJson`), replacing whatever was there, and removes them
 * when it needs none only while they are fffactory's own (`ownsManagedSettings`).
 */
export const CLAUDE_MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";

/**
 * How many days Claude Code keeps its session history while the log archive is enabled: the
 * value Claude's own hint suggests for long retention (~10 years), so evidence stays on the
 * worker until it is collected.
 */
export const CLAUDE_CLEANUP_PERIOD_DAYS = 3650;

/** fffactory's managed settings, each key with the one value fffactory gives it, in order. */
const FFFACTORY_SETTINGS = {
  apiKeyHelper: ANTHROPIC_KEY_HELPER,
  cleanupPeriodDays: CLAUDE_CLEANUP_PERIOD_DAYS,
} as const;
type FffactorySetting = keyof typeof FFFACTORY_SETTINGS;

/**
 * What fffactory needs of Claude Code's managed settings: its key helper while Anthropic is
 * delivered, and the long history while the projection carries the log archive.
 */
export interface ManagedSettingsNeeds {
  readonly keyHelper: boolean;
  readonly keepHistory: boolean;
}

/**
 * The managed settings' text for `needs`, two-space indented with a final newline, or
 * undefined when fffactory needs none.
 */
export function claudeManagedSettingsJson(
  needs: ManagedSettingsNeeds & { readonly keyHelper: true },
): string;
export function claudeManagedSettingsJson(needs: ManagedSettingsNeeds): string | undefined;
export function claudeManagedSettingsJson(needs: ManagedSettingsNeeds): string | undefined {
  const keys: FffactorySetting[] = [
    ...(needs.keyHelper ? (["apiKeyHelper"] as const) : []),
    ...(needs.keepHistory ? (["cleanupPeriodDays"] as const) : []),
  ];
  if (keys.length === 0) return undefined;
  const settings = Object.fromEntries(keys.map((key) => [key, FFFACTORY_SETTINGS[key]]));
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** `text` as a JSON object, or undefined when it is none. */
function settingsObject(text: string): Readonly<Record<string, unknown>> | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof settings === "object" && settings !== null && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : undefined;
}

/**
 * Whether managed settings' `text` is fffactory's own: a JSON object holding at least one key,
 * and only `apiKeyHelper` and `cleanupPeriodDays`, each with fffactory's value. Anything else,
 * one more key or another value, is someone else's policy and is never removed.
 */
export function ownsManagedSettings(text: string): boolean {
  const settings = settingsObject(text);
  if (settings === undefined) return false;
  const entries = Object.entries(settings);
  return (
    entries.length > 0 &&
    entries.every(
      ([key, value]) =>
        Object.hasOwn(FFFACTORY_SETTINGS, key) &&
        FFFACTORY_SETTINGS[key as FffactorySetting] === value,
    )
  );
}

/**
 * Whether managed settings' `text` names fffactory's key helper (`apiKeyHelper` exactly
 * `ANTHROPIC_KEY_HELPER`), whatever else it holds: Claude Code then runs that helper, so
 * `host verify` also checks the key file it reads. Text that is not a JSON object names none.
 */
export function namesKeyHelper(text: string): boolean {
  return settingsObject(text)?.apiKeyHelper === ANTHROPIC_KEY_HELPER;
}

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
