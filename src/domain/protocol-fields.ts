/**
 * Reading the host protocol's JSON documents (`docs/specs/host-protocol.md`): the version
 * rule, and field readers that name a malformed field without ever quoting its value.
 */
import { isSha256 } from "./release-assets";

/**
 * The protocol's major version. Adding a field keeps it, and readers ignore fields they do
 * not know; removing, renaming or redefining a field, or adding a state, needs a new one.
 * The CLI rejects any other major version.
 */
export const HOST_PROTOCOL_VERSION = 1;

/** A malformed document; its message names the field, never its value. */
export class Invalid extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = "Invalid";
  }
}

export type Fields = Readonly<Record<string, unknown>>;

export function record(value: unknown, path: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Invalid(`${path} must be an object`);
  return value as Fields;
}

export function string(value: unknown, path: string, rule: RegExp): string {
  if (typeof value !== "string" || !rule.test(value))
    throw new Invalid(`${path} is missing or malformed`);
  return value;
}

export function sha256(value: unknown, path: string): string {
  if (!isSha256(value)) throw new Invalid(`${path} must be a SHA-256 digest`);
  return value;
}

export function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Invalid(`${path} must be an array`);
  return value;
}

export function oneOf<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Invalid(`${path} is not a known state`);
  return value as T;
}

/** A UTC time as `Date.toISOString` writes it. */
export function isoTime(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Invalid(`${path} must be a time`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new Invalid(`${path} must be a time`);
  return value;
}

export function nullable<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null ? null : read(value);
}

/** A host name, OS ID, version or architecture: short printable tokens. */
export const TOKEN = /^[A-Za-z0-9._-]{1,253}$/;
export const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** A step, check or enrollment name. */
export const NAME = /^[a-z][a-z0-9_]{0,63}$/;
/**
 * Text fffactory wrote itself, such as a summary or a command to run: printable ASCII,
 * one line, bounded.
 */
export const SENTENCE = /^[\x20-\x7e]{1,400}$/;

/** Why a document could not be read. Never quotes the document. */
export type DocumentParse<T> =
  | { readonly ok: true; readonly document: T }
  | { readonly ok: false; readonly kind: "unsupported_version"; readonly version: number }
  | { readonly ok: false; readonly kind: "invalid"; readonly problem: string };

/**
 * Reads a versioned document. One of another major version is rejected before anything else
 * is read; fields this version does not know are ignored by `read`.
 */
export function parseVersioned<T>(text: string, read: (document: Fields) => T): DocumentParse<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, kind: "invalid", problem: "the output is not JSON" };
  }
  try {
    const document = record(parsed, "the document");
    const version = document.protocol_version;
    if (!Number.isSafeInteger(version)) throw new Invalid("protocol_version must be an integer");
    if (version !== HOST_PROTOCOL_VERSION)
      return { ok: false, kind: "unsupported_version", version: version as number };
    return { ok: true, document: read(document) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, kind: "invalid", problem: error.message };
    throw error;
  }
}
