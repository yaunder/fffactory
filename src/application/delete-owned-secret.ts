import type { CredentialSelection } from "../domain/aws-account";
import { type OwnedSecret, type SecretDeletion, secretRegion } from "../domain/secrets";
import type { SecretLookup, SecretStore } from "./secret-store";

/** How long a deleted secret may still be found before it is reported as remaining. */
export const SECRET_DELETION_DEADLINE_MS = 60_000;
/** The pause between two looks for a deleted secret. */
export const SECRET_DELETION_POLL_MS = 2_000;

export interface SecretDeletionDependencies {
  readonly secrets: SecretStore;
  readonly clock: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly interrupted: () => boolean;
}

/** No Region: the secret is asked about only in the one its ARN names (`secretRegion`). */
export interface SecretDeletionRequest {
  readonly secret: OwnedSecret;
  readonly credentials: CredentialSelection;
}

const remains = (reason: string): SecretDeletion => ({ kind: "remains", reason });

/**
 * Looks for the secret every `SECRET_DELETION_POLL_MS` until Secrets Manager no longer finds
 * it, within `deadlineMs`. Every look after the first follows a sleep, so a stalled clock
 * cannot stretch the wait; a look that fails, an interrupt or the deadline leaves it remaining.
 */
async function awaitAbsence(
  deps: SecretDeletionDependencies,
  lookup: SecretLookup,
  deadlineMs: number,
): Promise<SecretDeletion> {
  const start = deps.clock().getTime();
  for (let polls = 0; ; polls += 1) {
    const presence = await deps.secrets.exists(lookup);
    if (presence.kind === "absent") return { kind: "absent" };
    if (presence.kind === "failed") return remains(presence.reason);
    const waited = Math.max(deps.clock().getTime() - start, polls * SECRET_DELETION_POLL_MS);
    if (waited >= deadlineMs)
      return remains(`Secrets Manager still finds it ${deadlineMs / 1000} s after its deletion`);
    await deps.sleep(SECRET_DELETION_POLL_MS);
    if (deps.interrupted()) return remains("interrupted before its absence was confirmed");
  }
}

/**
 * Restores the secret, cancelling its scheduled deletion, then deletes it once more; any
 * failure, a second refusal included, leaves it remaining.
 */
async function restoreThenRemove(
  deps: SecretDeletionDependencies,
  lookup: SecretLookup,
  confirm: () => Promise<SecretDeletion>,
): Promise<SecretDeletion> {
  const restored = await deps.secrets.restore(lookup);
  if (restored.kind === "failed") return remains(restored.reason);
  if (restored.kind === "absent") return confirm();
  const removed = await deps.secrets.remove(lookup);
  if (removed.kind === "failed" || removed.kind === "invalid") return remains(removed.reason);
  return confirm();
}

/**
 * Deletes one secret the factory owns permanently, and confirms it gone (D8,
 * `docs/specs/secrets.md` §Deleting a factory's secrets): a secret pending deletion is
 * restored first, since Secrets Manager refuses to force-delete one; then it is deleted
 * without a recovery window, and looked for until it is not found. The listing is eventually
 * consistent, so a deletion refused as invalid for a secret it did not show pending is taken
 * for one scheduled since: restored once and deleted once more. Deletion is
 * asynchronous, and a forced delete succeeds even for a secret that does not exist, so only
 * that last look makes it `absent`; any failure along the way leaves it `remains`.
 */
export async function deleteOwnedSecret(
  deps: SecretDeletionDependencies,
  request: SecretDeletionRequest,
  deadlineMs: number = SECRET_DELETION_DEADLINE_MS,
): Promise<SecretDeletion> {
  const lookup: SecretLookup = {
    reference: request.secret.arn,
    region: secretRegion(request.secret.arn),
    credentials: request.credentials,
  };
  const confirm = () => awaitAbsence(deps, lookup, deadlineMs);
  if (request.secret.pendingDeletion) return restoreThenRemove(deps, lookup, confirm);
  const removed = await deps.secrets.remove(lookup);
  if (removed.kind === "invalid") return restoreThenRemove(deps, lookup, confirm);
  if (removed.kind === "failed") return remains(removed.reason);
  return confirm();
}
