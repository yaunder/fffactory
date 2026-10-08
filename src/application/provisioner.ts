import type { CredentialSelection } from "../domain/aws-account";

/** A Terraform root module shipped in the materialized release assets. */
export interface TerraformConfiguration {
  /**
   * Absolute path of the Terraform tree in the materialized release assets. It is copied
   * for each operation and never written.
   */
  readonly directory: string;
  /**
   * The root module, relative to `directory` and inside it, such as `factory`. It holds the
   * shipped provider lockfile, `.terraform.lock.hcl`.
   */
  readonly root: string;
}

/** What every provisioning operation runs against. */
export interface ProvisioningTarget {
  readonly configuration: TerraformConfiguration;
  /** The credential selection `requireExpectedAccount` allowed, passed to Terraform as is. */
  readonly credentials: CredentialSelection;
  /** The factory Region. */
  readonly region: string;
  /** Settings for the root module's backend, such as the state bucket. Never secrets. */
  readonly backend: Readonly<Record<string, string>>;
}

export interface PlanRequest extends ProvisioningTarget {
  /** Input variables, private to the operation. Never secret values, only references. */
  readonly variables: Readonly<Record<string, unknown>>;
  /** Absolute path to write the saved plan to. */
  readonly planFile: string;
  /**
   * Whether Terraform takes its own state lock while planning; true when omitted. False for
   * a plan made outside the factory-wide lock, which must leave nothing behind if it is
   * killed: the factory lock and the saved plan's state revision guard consistency instead.
   */
  readonly stateLock?: boolean;
}

export interface SavedPlanRequest extends ProvisioningTarget {
  /** Absolute path of a plan `plan` saved for the same configuration. */
  readonly planFile: string;
}

export interface PlanResult {
  /** Whether applying the plan would change anything. */
  readonly changes: boolean;
}

/**
 * Port: provisions factory infrastructure with managed Terraform. Each call is its own
 * operation, in a fresh private directory that no other operation shares and that is
 * removed when the call settles. Every call rejects when Terraform fails.
 */
export interface Provisioner {
  /** Plans the configuration with `variables` and saves the plan to `planFile`. */
  plan(request: PlanRequest): Promise<PlanResult>;
  /** The saved plan in Terraform's JSON plan representation. */
  showPlan(request: SavedPlanRequest): Promise<unknown>;
  /** Applies exactly the saved plan, and nothing else. */
  applyPlan(request: SavedPlanRequest): Promise<void>;
  /** The root module's output values, by output name. */
  output(request: ProvisioningTarget): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * A Provisioner call that failed, whose tool's diagnostics (Terraform's standard error) are
 * kept in `diagnosticsFile`, a private local file. The message is fffactory's own and never
 * holds the diagnostics: they may quote configuration. Show the file's path, never its text.
 */
export class ProvisioningFailed extends Error {
  override readonly name = "ProvisioningFailed";

  constructor(
    message: string,
    readonly diagnosticsFile: string,
  ) {
    super(message);
  }
}

/** The private file holding the diagnostics of a failed Provisioner call, if it kept any. */
export function diagnosticsFileOf(error: unknown): string | undefined {
  return error instanceof ProvisioningFailed ? error.diagnosticsFile : undefined;
}
