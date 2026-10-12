import type { SecretMaterial } from "../domain/secrets";
import type { TailnetDevice } from "../domain/tailnet";

/** Every device of the tailnet, or why they could not be listed. */
export type TailnetDeviceList =
  | { readonly kind: "devices"; readonly devices: readonly TailnetDevice[] }
  /** `reason` is fffactory's words: never an API body or a token. */
  | { readonly kind: "failed"; readonly reason: string };

/** How deleting one device went; a device already gone counts as removed. */
export type DeviceDeletion =
  | { readonly kind: "removed" }
  | { readonly kind: "failed"; readonly reason: string };

/** The tailnet as the admin client may change it, for as long as its token lasts. */
export interface TailnetAdminSession {
  devices(): Promise<TailnetDeviceList>;
  remove(deviceId: string): Promise<DeviceDeletion>;
}

export type TailnetAdminOpening =
  | { readonly kind: "open"; readonly session: TailnetAdminSession }
  /** Tailscale refused the client or could not be reached; never quoting its answer. */
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Port: the factory's tailnet through the Tailscale API, as the operator's admin client
 * (`tailscale.admin_client_secret`, `docs/specs/worker-lifecycle.md` §Tailnet device removal).
 * `open` exchanges the client secret for a short-lived token, which only the session holds,
 * with the secret: a call refused for an expired token renews it once and is retried.
 * Every call has a deadline, and every failure resolves to `failed`; nothing rejects but a
 * defect. No answer body, token or secret reaches a reason.
 */
export interface TailnetAdmin {
  open(clientSecret: SecretMaterial): Promise<TailnetAdminOpening>;
}
