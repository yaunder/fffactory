import type { FactoryId, FactoryInstance } from "./instance";
import { fieldPath, isRecord, ROOT } from "./validation";

/** Source of uniformly random bytes, injected so ID generation stays pure and testable. */
export type RandomBytes = (count: number) => Uint8Array;

export const FACTORY_ID_PREFIX = "fff-";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SUFFIX_LENGTH = 8;
/** Bytes at or above this bound would favour the first letters of the alphabet. */
const UNBIASED_BOUND = 256 - (256 % ALPHABET.length);

/** `length` random lowercase letters or digits, sampled without bias. */
export function randomAlphanumeric(randomBytes: RandomBytes, length: number): string {
  let text = "";
  while (text.length < length) {
    for (const byte of randomBytes(length - text.length)) {
      if (byte < UNBIASED_BOUND) text += ALPHABET[byte % ALPHABET.length];
    }
  }
  return text;
}

/**
 * A new permanent factory ID: `fff-` and eight random lowercase letters or digits.
 * 12 characters leave room for the ID to prefix AWS names and Tailscale hostnames.
 */
export function generateFactoryId(randomBytes: RandomBytes): FactoryId {
  return `${FACTORY_ID_PREFIX}${randomAlphanumeric(randomBytes, SUFFIX_LENGTH)}` as FactoryId;
}

export interface FilledInstance {
  readonly instance: FactoryInstance;
  /** Field paths taken from the defaults, in the order they were filled. */
  readonly filled: readonly string[];
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Builds new objects from own entries only. `Object.fromEntries` defines a `__proto__`
 * key as plain data, so no key in either input can reach a prototype.
 */
function merge(
  existing: Record<string, unknown>,
  defaults: Record<string, unknown>,
  path: string,
  filled: string[],
): Record<string, unknown> {
  const entries = new Map(Object.entries(existing));
  for (const [key, fallback] of Object.entries(defaults)) {
    const current = own(existing, key);
    if (current === undefined) {
      entries.set(key, fallback);
      filled.push(fieldPath(path, key));
    } else if (isRecord(current) && isRecord(fallback)) {
      entries.set(key, merge(current, fallback, fieldPath(path, key), filled));
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Fills fields absent from `existing` with those in `defaults`. Every value already set,
 * including arrays, is kept as is; nested objects are filled field by field.
 */
export function fillMissing(existing: FactoryInstance, defaults: FactoryInstance): FilledInstance {
  const filled: string[] = [];
  const instance = merge(
    existing as unknown as Record<string, unknown>,
    defaults as unknown as Record<string, unknown>,
    ROOT,
    filled,
  );
  return { instance: instance as unknown as FactoryInstance, filled };
}
