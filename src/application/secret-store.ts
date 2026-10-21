import type { CredentialSelection } from "../domain/aws-account";
import type { FactoryId, SecretReference } from "../domain/instance";
import type { ListedSecret, SecretMaterial } from "../domain/secrets";

export interface SecretWrite {
  /** The secret's Secrets Manager name. */
  readonly name: string;
  readonly description: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly material: SecretMaterial;
  readonly region: string;
  readonly credentials: CredentialSelection;
}

/** Where to read, restore, delete or look for one secret, by its ARN. */
export interface SecretLookup {
  readonly reference: SecretReference;
  readonly region: string;
  readonly credentials: CredentialSelection;
}

export interface StoredSecret {
  readonly arn: SecretReference;
  /** True when the secret was created, false when a new value was added to an existing one. */
  readonly created: boolean;
}

/** The secrets carrying a factory's ID tag, in the factory Region. */
export interface SecretListRequest {
  readonly factoryId: FactoryId;
  readonly region: string;
  readonly credentials: CredentialSelection;
}

/** `reason` in every failure below is the AWS session's description: an error name, never a message. */
export type SecretListing =
  | { readonly kind: "listed"; readonly secrets: readonly ListedSecret[] }
  | { readonly kind: "failed"; readonly reason: string };

/** How restoring or deleting one secret ended. */
export type SecretChange =
  | { readonly kind: "done" }
  /** Secrets Manager does not find the secret (`ResourceNotFoundException`). */
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * How deleting one secret ended: a `SecretChange`, or `invalid` when Secrets Manager refused it
 * for the secret's state (`InvalidRequestException`), as it refuses to force-delete a secret
 * scheduled for deletion.
 */
export type SecretRemoval = SecretChange | { readonly kind: "invalid"; readonly reason: string };

/**
 * One secret as DescribeSecret finds it by its ARN: its name, ARN, tags and whether it is
 * pending deletion, what its ownership is judged on, and never its value. `unusable`: Secrets
 * Manager answered, but without a usable name or ARN, so nothing can be judged.
 */
export type SecretDescription =
  | { readonly kind: "found"; readonly secret: ListedSecret }
  | { readonly kind: "absent" }
  | { readonly kind: "unusable" }
  | { readonly kind: "failed"; readonly reason: string };

/** Whether Secrets Manager still finds one secret, pending deletion or not. */
export type SecretPresence =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Port: Secrets Manager. Material written goes to AWS and nowhere else, and material read
 * leaves the adapter only as `SecretMaterial`: never into a log, an error message or a
 * command argument. `write` and `read` reject, naming the AWS error but never quoting it, when
 * a call fails; `list`, `restore`, `remove`, `describe` and `exists` resolve every AWS failure
 * the same way, as `failed`, but `remove`'s `invalid` and `describe`'s `unusable`
 * (`docs/specs/secrets.md` §Deleting a factory's secrets).
 */
export interface SecretStore {
  /** Creates the secret named `name`, or stores a new value in it when it already exists. */
  write(request: SecretWrite): Promise<StoredSecret>;
  /** The secret's current value, which leaves the adapter only as `SecretMaterial`. */
  read(request: SecretLookup): Promise<SecretMaterial>;
  /**
   * Every secret whose tags match the factory-ID tag and the factory ID, scheduled for deletion
   * or not. AWS matches tags by prefix, so another factory's may be among them.
   */
  list(request: SecretListRequest): Promise<SecretListing>;
  /** Cancels the secret's scheduled deletion (RestoreSecret). */
  restore(request: SecretLookup): Promise<SecretChange>;
  /** Deletes the secret without a recovery window (DeleteSecret, ForceDeleteWithoutRecovery). */
  remove(request: SecretLookup): Promise<SecretRemoval>;
  /**
   * The secret's name, ARN, tags and deleted date (DescribeSecret): a reference ListSecrets did
   * not list, as it may not for a while after a change, judged as a listed one would be. A
   * description without a usable name or ARN is `unusable`.
   */
  describe(request: SecretLookup): Promise<SecretDescription>;
  /** Whether Secrets Manager still finds the secret (DescribeSecret). */
  exists(request: SecretLookup): Promise<SecretPresence>;
}
