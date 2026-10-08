import {
  assessCompleteness,
  type CompletenessReport,
  DOCUMENT_ROOT,
  type FactoryInstance,
  type Issue,
  parseFactoryInstance,
} from "../domain/instance";
import type { InstanceStore } from "./instance-store";

export type InstanceValidation =
  | {
      readonly valid: true;
      readonly instance: FactoryInstance;
      readonly completeness: CompletenessReport;
      /** The document's exact text, as validated. */
      readonly text: string;
    }
  | { readonly valid: false; readonly issues: readonly Issue[] };

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Reads and validates the instance at `path`; completeness is reported only for valid documents. */
export async function validateInstance(
  store: InstanceStore,
  path: string,
): Promise<InstanceValidation> {
  const text = await store.read(path);
  const json = parseJson(text);
  // The parser's message may quote file contents, which could include a pasted secret.
  if (!json.ok)
    return { valid: false, issues: [{ path: DOCUMENT_ROOT, message: "is not valid JSON" }] };
  const parsed = parseFactoryInstance(json.value);
  if (!parsed.valid) return parsed;
  return {
    valid: true,
    instance: parsed.instance,
    completeness: assessCompleteness(parsed.instance),
    text,
  };
}
