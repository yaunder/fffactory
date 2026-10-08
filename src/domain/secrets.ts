/**
 * Secret material and where factory.json refers to it. Material comes from a hidden prompt
 * or standard input, goes straight to Secrets Manager, and is never shown or stored:
 * factory.json keeps only the secret's ARN.
 */
import {
  type FactoryId,
  type FactoryInstance,
  type HostKey,
  parseHostKey,
  type SecretReference,
} from "./instance";
import { FACTORY_ID_TAG, MANAGED_BY_TAG } from "./resource-naming";
import { fieldPath, itemPath } from "./validation";

/** Secrets Manager's limit on a secret string, in bytes. */
export const MAX_SECRET_BYTES = 65_536;

const REDACTED = "[secret]";

/**
 * A secret value that shows as `[secret]` wherever it is printed, interpolated, inspected
 * or serialized. Only `reveal` returns the value, for the one call that stores it.
 */
export class SecretMaterial {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/** Where material came from: a hidden prompt answer, or all of standard input. */
export type MaterialSource = "prompt" | "input";

export type MaterialRead =
  | { readonly ok: true; readonly material: SecretMaterial }
  | { readonly ok: false; readonly reason: "empty" | "too_large" };

/**
 * Material as read. Standard input loses one final line ending, which `echo` and editors
 * add; a prompt answer is taken as typed. Blank and oversized material are refused.
 */
export function readSecretMaterial(raw: string, source: MaterialSource): MaterialRead {
  const value = source === "input" ? raw.replace(/\r?\n$/, "") : raw;
  if (value.trim() === "") return { ok: false, reason: "empty" };
  if (new TextEncoder().encode(value).length > MAX_SECRET_BYTES)
    return { ok: false, reason: "too_large" };
  return { ok: true, material: new SecretMaterial(value) };
}

/** The secrets factory.json refers to, by the name `fffactory secret set` takes. */
export type SecretName = "tailscale-auth-key" | "paseo-password";

const SECRET_NAMES: readonly SecretName[] = ["tailscale-auth-key", "paseo-password"];

/** Where one secret lives in Secrets Manager and in factory.json. */
export interface SecretTarget {
  readonly name: SecretName;
  /** The factory.json field that holds its reference, such as `tailscale.auth_key_secret`. */
  readonly field: string;
  /** Its Secrets Manager name: the factory ID, then the host key for a host's secret. */
  readonly secretName: string;
  readonly description: string;
  readonly factoryId: FactoryId;
  readonly hostKey?: HostKey;
}

export type SecretTargetResolution =
  | { readonly ok: true; readonly target: SecretTarget }
  | { readonly ok: false; readonly message: string };

const refuse = (message: string): SecretTargetResolution => ({ ok: false, message });

function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name);
}

function hostTarget(
  instance: FactoryInstance,
  factoryId: FactoryId,
  host: string | undefined,
): SecretTargetResolution {
  if (host === undefined)
    return refuse("paseo-password belongs to one host: name it with --host KEY");
  // An operator may paste a secret into the wrong argument, so a malformed key is never echoed.
  const key = parseHostKey(host);
  if (!key.ok) return refuse("--host must be a host key declared in factory.json");
  const index = (instance.hosts ?? []).findIndex((declared) => declared.key === key.value);
  if (index < 0) return refuse(`host "${key.value}" is not declared in factory.json`);
  return {
    ok: true,
    target: {
      name: "paseo-password",
      field: fieldPath(itemPath("hosts", index), "paseo_password_secret"),
      secretName: `${factoryId}/${key.value}/paseo-password`,
      description: `Paseo password of host ${key.value} of factory ${factoryId}`,
      factoryId,
      hostKey: key.value,
    },
  };
}

/**
 * The target of `fffactory secret set NAME [--host KEY]`. An unknown name is never echoed:
 * it may be a secret pasted where the name belongs.
 */
export function resolveSecretTarget(
  instance: FactoryInstance,
  name: string,
  host: string | undefined,
): SecretTargetResolution {
  if (!isSecretName(name))
    return refuse(`unknown secret name; expected ${SECRET_NAMES.join(" or ")}`);
  const factoryId = instance.factory_id;
  if (factoryId === undefined)
    return refuse("factory.json needs factory_id before a secret can be named");
  if (name === "paseo-password") return hostTarget(instance, factoryId, host);
  if (host !== undefined)
    return refuse("tailscale-auth-key belongs to the whole factory and takes no --host");
  return {
    ok: true,
    target: {
      name,
      field: "tailscale.auth_key_secret",
      secretName: `${factoryId}/tailscale-auth-key`,
      description: `Tailscale auth key of factory ${factoryId}`,
      factoryId,
    },
  };
}

/** The reference factory.json currently holds for the target, if any. */
export function secretReference(
  instance: FactoryInstance,
  target: SecretTarget,
): SecretReference | undefined {
  if (target.hostKey === undefined) return instance.tailscale?.auth_key_secret;
  return instance.hosts?.find((host) => host.key === target.hostKey)?.paseo_password_secret;
}

function withEntry<T extends object>(value: T | undefined, key: string, entry: unknown): T {
  const entries = new Map<string, unknown>(Object.entries(value ?? {}));
  entries.set(key, entry);
  return Object.fromEntries(entries) as T;
}

/** A copy of a valid instance whose target field holds `arn`; nothing else changes. */
export function withSecretReference(
  instance: FactoryInstance,
  target: SecretTarget,
  arn: SecretReference,
): FactoryInstance {
  if (target.hostKey === undefined)
    return withEntry(instance, "tailscale", withEntry(instance.tailscale, "auth_key_secret", arn));
  const hosts = (instance.hosts ?? []).map((host) =>
    host.key === target.hostKey ? withEntry(host, "paseo_password_secret", arn) : host,
  );
  return withEntry(instance, "hosts", hosts);
}

/** The tags every secret fffactory creates carries, as every factory resource does. */
export function secretTags(factoryId: FactoryId): Readonly<Record<string, string>> {
  return { [FACTORY_ID_TAG]: factoryId, [MANAGED_BY_TAG]: "fffactory" };
}
