import type { CredentialSelection } from "../domain/aws-account";
import type { SecretReference } from "../domain/instance";
import type { SecretMaterial } from "../domain/secrets";

export interface SecretWrite {
  /** The secret's Secrets Manager name. */
  readonly name: string;
  readonly description: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly material: SecretMaterial;
  readonly region: string;
  readonly credentials: CredentialSelection;
}

export interface StoredSecret {
  readonly arn: SecretReference;
  /** True when the secret was created, false when a new value was added to an existing one. */
  readonly created: boolean;
}

/**
 * Port: Secrets Manager. The material goes to AWS and nowhere else: never into a log, an
 * error message or a command argument. Rejects, naming the AWS error but never quoting it,
 * when the write fails.
 */
export interface SecretStore {
  /** Creates the secret named `name`, or stores a new value in it when it already exists. */
  write(request: SecretWrite): Promise<StoredSecret>;
}
