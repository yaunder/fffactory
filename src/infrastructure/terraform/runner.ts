/**
 * Runs the managed Terraform for one operation: by absolute path, never from PATH, in the
 * operation's working directory, with an environment built from an allowlist rather than
 * inherited. The environment carries the AWS credential selection the account check
 * resolved, the factory Region, and the operation's own data directory and CLI config.
 */
import type { CredentialSelection } from "../../domain/aws-account";
import { bunProcessRunner, type ProcessRunner } from "../local-tool-probe";

/** Everything one Terraform operation runs with. */
export interface TerraformSession {
  /** The managed Terraform executable. */
  readonly executable: string;
  /** Where Terraform runs: the operation's copy of the root module. */
  readonly workingDirectory: string;
  /** `TF_DATA_DIR`: the operation's own, never shared with another operation. */
  readonly dataDirectory: string;
  /** `TF_PLUGIN_CACHE_DIR`: the provider cache every operation shares. */
  readonly pluginCache: string;
  /** `TF_CLI_CONFIG_FILE`: replaces the operator's `~/.terraformrc`. */
  readonly cliConfigFile: string;
  /** The credential selection the account check resolved. */
  readonly credentials: CredentialSelection;
  /** The factory Region. */
  readonly region: string;
}

export type EnvironmentSettings = Omit<TerraformSession, "executable" | "workingDirectory">;

/** Operator variables Terraform and its providers may need that select no credentials. */
const PASSED_THROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/** Set by FFFactory itself: the profile it selected, and the factory Region. */
const SELECTED = new Set([
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
]);

/**
 * Credential sources the standard chain reads from the environment. With a selected profile
 * none may reach Terraform: the AWS SDK for Go prefers environment keys to a profile, and
 * the profile alone is what the account check resolved.
 */
const CHAIN_SOURCES = [
  /^AWS_ACCESS_KEY_ID$/,
  /^AWS_SECRET_ACCESS_KEY$/,
  /^AWS_SESSION_TOKEN$/,
  /^AWS_SECURITY_TOKEN$/,
  /^AWS_WEB_IDENTITY_TOKEN_FILE$/,
  /^AWS_ROLE_ARN$/,
  /^AWS_ROLE_SESSION_NAME$/,
  /^AWS_CONTAINER_/,
  /^AWS_EC2_METADATA_/,
];

function isChainSource(name: string): boolean {
  return CHAIN_SOURCES.some((pattern) => pattern.test(name));
}

function passesAws(name: string, credentials: CredentialSelection): boolean {
  if (!name.startsWith("AWS_") || SELECTED.has(name)) return false;
  return credentials.source === "chain" || !isChainSource(name);
}

/**
 * Terraform's entire environment. From the operator's: the allowlisted variables above and
 * the `AWS_*` variables the credential selection permits. Then the selected profile (with
 * instance metadata disabled, so a profile never falls through to it), the factory Region,
 * and the operation's Terraform settings. Every other `TF_*` variable of the operator's,
 * such as `TF_LOG` or `TF_VAR_*`, is left out.
 */
export function terraformEnvironment(
  operator: Readonly<Record<string, string | undefined>>,
  settings: EnvironmentSettings,
): Record<string, string> {
  const { credentials, region } = settings;
  const kept = Object.entries(operator).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      (PASSED_THROUGH.includes(entry[0]) || passesAws(entry[0], credentials)),
  );
  const profile =
    credentials.source === "chain"
      ? []
      : [
          ["AWS_PROFILE", credentials.profile],
          ["AWS_EC2_METADATA_DISABLED", "true"],
        ];
  return Object.fromEntries([
    ...kept,
    ...profile,
    ["AWS_REGION", region],
    ["AWS_DEFAULT_REGION", region],
    ["TF_DATA_DIR", settings.dataDirectory],
    ["TF_PLUGIN_CACHE_DIR", settings.pluginCache],
    ["TF_CLI_CONFIG_FILE", settings.cliConfigFile],
    ["TF_IN_AUTOMATION", "1"],
    ["TF_INPUT", "0"],
    ["CHECKPOINT_DISABLE", "1"],
  ]);
}

export interface TerraformResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Terraform ran and exited with a status its caller does not accept. */
export class TerraformFailed extends Error {
  override readonly name = "TerraformFailed";

  constructor(
    readonly subcommand: string,
    readonly exitCode: number,
    /**
     * Terraform's standard error. Kept out of the message: it may quote configuration. The
     * provisioner keeps it in a private diagnostics file (`ProvisioningFailed`).
     */
    readonly diagnostics: string,
  ) {
    super(`\`terraform ${subcommand}\` exited with status ${exitCode}`);
  }
}

/**
 * How long Terraform may take to stop after SIGINT, at its deadline or when `fffactory` is
 * interrupted, before it is killed. Interrupted, Terraform finishes or cancels what it is
 * doing, persists state and releases the backend's state lock; killed, it may lose state
 * for resources it just created and leave the lock held.
 */
export const TERRAFORM_STOP_GRACE_MS = 2 * 60 * 1000;

export interface RunOptions {
  readonly timeoutMs: number;
  /** Exit statuses that count as success; only 0 when omitted. */
  readonly exitCodes?: readonly number[];
}

/** Runs one Terraform command in `session`. Rejects on any exit status not accepted. */
export type TerraformRunner = (
  session: TerraformSession,
  args: readonly string[],
  options: RunOptions,
) => Promise<TerraformResult>;

/** A TerraformRunner over `run`, passing Terraform the operator's environment filtered. */
export function terraformRunner(
  operator: Readonly<Record<string, string | undefined>>,
  run: ProcessRunner = bunProcessRunner,
): TerraformRunner {
  return async (session, args, { timeoutMs, exitCodes = [0] }) => {
    const subcommand = args[0] ?? "";
    const outcome = await run([session.executable, ...args], timeoutMs, {
      cwd: session.workingDirectory,
      env: terraformEnvironment(operator, session),
      stop: { signal: "SIGINT", graceMs: TERRAFORM_STOP_GRACE_MS },
    });
    switch (outcome.kind) {
      case "exited": {
        const { exitCode, stdout, stderr } = outcome;
        if (!exitCodes.includes(exitCode)) throw new TerraformFailed(subcommand, exitCode, stderr);
        return { exitCode, stdout, stderr };
      }
      case "timed_out":
        throw new Error(`\`terraform ${subcommand}\` did not finish within ${timeoutMs / 1000} s`);
      case "not_found":
        throw new Error(`The managed Terraform ${session.executable} is missing`);
      case "not_started":
        throw new Error(
          `The managed Terraform ${session.executable} could not be started (${outcome.code})`,
        );
    }
  };
}
