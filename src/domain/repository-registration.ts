/**
 * Repository registration (pure; `docs/specs/dispatch.md` §Repository registration): the
 * absolute paths of the checkouts a host's repository manifest places, and the backend-neutral
 * result of making them available through the worker's execution backend, with its document
 * and a tolerant reader. The domain never asks a backend anything; `host/execution-backend.ts`
 * does.
 */
import { isCheckoutPath } from "./instance";
import { Invalid, oneOf, record, SENTENCE, string, array, type Fields } from "./protocol-fields";
import { PLACED_SET } from "./repository-placement";
import { WORK_ROOTS } from "./work-inspection";

/** The execution backends a worker can have; Paseo is the only one built. */
export const EXECUTION_BACKENDS = ["paseo"] as const;
export type ExecutionBackendName = (typeof EXECUTION_BACKENDS)[number];

export const CHECKOUT_REGISTRATION_STATES = [
  "registered",
  "present",
  "failed",
  "not_applicable",
] as const;

/**
 * One placed checkout, by its absolute path: `registered` newly, `present` already, `failed`
 * with fffactory's own short reason (never the backend tool's output), or `not_applicable` for a
 * backend with nothing to register.
 */
export type CheckoutRegistration =
  | { readonly path: string; readonly state: "registered" | "present" | "not_applicable" }
  | { readonly path: string; readonly state: "failed"; readonly reason: string };

/** What registering the placed checkouts did, `changed` when any was newly registered. */
export interface RepositoryRegistration {
  readonly backend: ExecutionBackendName;
  readonly checkouts: readonly CheckoutRegistration[];
  readonly changed: boolean;
}

export function repositoryRegistration(
  backend: ExecutionBackendName,
  checkouts: readonly CheckoutRegistration[],
): RepositoryRegistration {
  return {
    backend,
    checkouts,
    changed: checkouts.some((checkout) => checkout.state === "registered"),
  };
}

const ROOT = `${WORK_ROOTS.repositories}/`;

/** A normalized absolute path under the repository root, as `placedCheckouts` makes them. */
function isPlacedCheckout(path: string): boolean {
  return path.startsWith(ROOT) && isCheckoutPath(path.slice(ROOT.length));
}

export type PlacedCheckouts =
  | { readonly ok: true; readonly checkouts: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** The repositories the manifest's placed set names, by checkout path; throws `Invalid`. */
function placedPaths(document: Fields): string[] {
  const repositories = record(document.repositories, "repositories");
  const placed = array(record(document.repository_sets, "repository_sets")[PLACED_SET], "placed");
  return placed.map((key) => {
    if (typeof key !== "string" || !Object.hasOwn(repositories, key))
      throw new Invalid("a placed repository is missing");
    const path = record(repositories[key], key).path;
    if (typeof path !== "string" || !isCheckoutPath(path))
      throw new Invalid("a placed repository's path is invalid");
    return `${ROOT}${path}`;
  });
}

/**
 * The absolute paths of the checkouts a host's repository manifest (`repositoryManifestJson`'s
 * text, as the repository stage writes it) places, in placement order. A manifest that is not
 * one is refused in fffactory's words, never quoted.
 */
export function placedCheckouts(text: string): PlacedCheckouts {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the repository manifest is not JSON" };
  }
  try {
    const document = record(value, "the repository manifest");
    if (document.version !== 2)
      return { ok: false, reason: "the repository manifest is not version 2" };
    return { ok: true, checkouts: placedPaths(document) };
  } catch (error) {
    if (error instanceof Invalid)
      return { ok: false, reason: "the repository manifest is invalid" };
    throw error;
  }
}

function checkoutDocument(checkout: CheckoutRegistration) {
  return checkout.state === "failed"
    ? { path: checkout.path, state: checkout.state, reason: checkout.reason }
    : { path: checkout.path, state: checkout.state };
}

/** The result as a JSON value with a stable key order, for the document that carries it. */
export function repositoryRegistrationDocument(registration: RepositoryRegistration) {
  return {
    backend: registration.backend,
    changed: registration.changed,
    checkouts: registration.checkouts.map(checkoutDocument),
  };
}

function readCheckout(value: unknown, path: string): CheckoutRegistration {
  const fields = record(value, path);
  const checkout = string(fields.path, `${path}.path`, /^\//);
  if (!isPlacedCheckout(checkout)) throw new Invalid(`${path}.path is malformed`);
  const state = oneOf(fields.state, `${path}.state`, CHECKOUT_REGISTRATION_STATES);
  return state === "failed"
    ? { path: checkout, state, reason: string(fields.reason, `${path}.reason`, SENTENCE) }
    : { path: checkout, state };
}

function readRegistration(value: unknown): RepositoryRegistration {
  const fields = record(value, "repository_registration");
  const backend = oneOf(fields.backend, "backend", EXECUTION_BACKENDS);
  const checkouts = array(fields.checkouts, "checkouts").map((item, index) =>
    readCheckout(item, `checkouts[${index}]`),
  );
  const registration = repositoryRegistration(backend, checkouts);
  if (fields.changed !== registration.changed) throw new Invalid("changed disagrees");
  return registration;
}

/**
 * Reads the result without trusting it, ignoring fields it does not know. Absent, as from a
 * worker whose release predates registration, it is no result; malformed, it is no result too,
 * so it never invalidates the document carrying it.
 */
export function parseRepositoryRegistration(value: unknown): RepositoryRegistration | undefined {
  if (value === undefined) return undefined;
  try {
    return readRegistration(value);
  } catch (error) {
    if (error instanceof Invalid) return undefined;
    throw error;
  }
}
