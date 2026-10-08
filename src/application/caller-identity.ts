import type { CallerObservation, CredentialSelection } from "../domain/aws-account";

/** Port: asks AWS STS who the selected credentials belong to. Read-only. */
export interface CallerIdentity {
  /**
   * Calls STS GetCallerIdentity in `region`. Every credential, AWS, network and timeout
   * failure resolves to an observation; it rejects only on a defect.
   */
  resolve(credentials: CredentialSelection, region: string): Promise<CallerObservation>;
}

export const PROFILE_ENVIRONMENT_VARIABLE = "AWS_PROFILE";

/**
 * Selects credentials by precedence: `--profile NAME`, then `AWS_PROFILE`, then the
 * standard AWS credential chain. An empty `AWS_PROFILE` counts as unset.
 */
export function credentialSelection(
  flag: string | undefined,
  environment: string | undefined,
): CredentialSelection {
  if (flag !== undefined) return { source: "--profile", profile: flag };
  if (environment) return { source: PROFILE_ENVIRONMENT_VARIABLE, profile: environment };
  return { source: "chain" };
}
