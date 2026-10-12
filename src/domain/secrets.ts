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
  type TailscaleSecretField,
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
export type SecretName = "tailscale-auth-key" | "tailscale-admin-client" | "paseo-password";

const SECRET_NAMES: readonly SecretName[] = [
  "tailscale-auth-key",
  "tailscale-admin-client",
  "paseo-password",
];

/** The secrets that belong to the whole factory, each under factory.json's `tailscale`. */
type FactorySecretName = Exclude<SecretName, "paseo-password">;

/**
 * Each factory-wide secret's field under `tailscale` and what it is. The auth key is the
 * workers' join-only enrollment key; the admin client is the operator's own Tailscale OAuth
 * client, which no worker ever receives.
 */
const FACTORY_SECRETS: Readonly<
  Record<FactorySecretName, { readonly field: TailscaleSecretField; readonly what: string }>
> = {
  "tailscale-auth-key": { field: "auth_key_secret", what: "Tailscale auth key" },
  "tailscale-admin-client": { field: "admin_client_secret", what: "Tailscale admin client" },
};

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
    return refuse(
      `unknown secret name; expected ${SECRET_NAMES.slice(0, -1).join(", ")} or ${SECRET_NAMES.at(-1)}`,
    );
  const factoryId = instance.factory_id;
  if (factoryId === undefined)
    return refuse("factory.json needs factory_id before a secret can be named");
  if (name === "paseo-password") return hostTarget(instance, factoryId, host);
  if (host !== undefined) return refuse(`${name} belongs to the whole factory and takes no --host`);
  const { field, what } = FACTORY_SECRETS[name];
  return {
    ok: true,
    target: {
      name,
      field: fieldPath("tailscale", field),
      secretName: `${factoryId}/${name}`,
      description: `${what} of factory ${factoryId}`,
      factoryId,
    },
  };
}

/** The `tailscale` field of a factory-wide target; a host's target has none. */
function tailscaleField(target: SecretTarget): TailscaleSecretField | undefined {
  return target.name === "paseo-password" ? undefined : FACTORY_SECRETS[target.name].field;
}

/** The reference factory.json currently holds for the target, if any. */
export function secretReference(
  instance: FactoryInstance,
  target: SecretTarget,
): SecretReference | undefined {
  const field = tailscaleField(target);
  if (field !== undefined) return instance.tailscale?.[field];
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
  const field = tailscaleField(target);
  if (field !== undefined)
    return withEntry(instance, "tailscale", withEntry(instance.tailscale, field, arn));
  const hosts = (instance.hosts ?? []).map((host) =>
    host.key === target.hostKey ? withEntry(host, "paseo_password_secret", arn) : host,
  );
  return withEntry(instance, "hosts", hosts);
}

/** The tags every secret fffactory creates carries, as every factory resource does. */
export function secretTags(factoryId: FactoryId): Readonly<Record<string, string>> {
  return { [FACTORY_ID_TAG]: factoryId, [MANAGED_BY_TAG]: "fffactory" };
}
