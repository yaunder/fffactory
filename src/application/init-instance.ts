import { resolve } from "node:path";
import { fillMissing, generateFactoryId, type RandomBytes } from "../domain/initialization";
import {
  assessCompleteness,
  type CompletenessReport,
  type FactoryInstance,
  type Issue,
  type Release,
  SCHEMA_VERSION,
  serializeInstance,
} from "../domain/instance";
import type { InstanceStore } from "./instance-store";
import { INSTANCE_FILE } from "./resolve-instance";
import { validateInstance } from "./validate-instance";

/**
 * Everything init may use. It deliberately has no network, AWS or provisioning capability:
 * init only reads and writes the local document.
 */
export interface InitDependencies {
  readonly store: InstanceStore;
  readonly randomBytes: RandomBytes;
}

export interface InitRequest {
  /** Absolute path of the document file to create or fill. */
  readonly path: string;
  /** The running CLI's release, pinned when the document has no release yet. */
  readonly release: Release;
}

export type InitOutcome = "created" | "updated" | "unchanged";

export type InitResult =
  | {
      readonly ok: true;
      readonly outcome: InitOutcome;
      readonly instance: FactoryInstance;
      /** Field paths init set, in order; empty when the document was left untouched. */
      readonly filled: readonly string[];
      readonly completeness: CompletenessReport;
    }
  | { readonly ok: false; readonly issues: readonly Issue[] };

/** The document file init targets: PATH, or `./.fffactory/factory.json`, from `cwd`. */
export function initTarget(cwd: string, path?: string): string {
  return resolve(cwd, path ?? INSTANCE_FILE);
}

type Existing = { ok: true; instance?: FactoryInstance } | { ok: false; issues: readonly Issue[] };

async function readExisting(store: InstanceStore, path: string): Promise<Existing> {
  if (!(await store.isFile(path))) return { ok: true };
  const validation = await validateInstance(store, path);
  return validation.valid
    ? { ok: true, instance: validation.instance }
    : { ok: false, issues: validation.issues };
}

/**
 * Creates the document at `path`, or fills the gaps in an existing valid one. Every value
 * already set is kept, including the factory ID and release pin; an invalid document is
 * refused and left as it is.
 */
export async function initInstance(
  { store, randomBytes }: InitDependencies,
  { path, release }: InitRequest,
): Promise<InitResult> {
  const existing = await readExisting(store, path);
  if (!existing.ok) return existing;
  const base = existing.instance ?? { schema_version: SCHEMA_VERSION };
  const defaults: FactoryInstance = {
    schema_version: SCHEMA_VERSION,
    release,
    factory_id: base.factory_id ?? generateFactoryId(randomBytes),
  };
  const { instance, filled } = fillMissing(base, defaults);
  // TODO(re-evaluate when init runs unattended or concurrently, e.g. from the companion skill):
  // create fresh documents with an exclusive no-clobber write so two racing inits cannot
  // replace each other's factory ID.
  if (filled.length > 0) await store.write(path, serializeInstance(instance));
  const outcome = !existing.instance ? "created" : filled.length > 0 ? "updated" : "unchanged";
  return { ok: true, outcome, instance, filled, completeness: assessCompleteness(instance) };
}
