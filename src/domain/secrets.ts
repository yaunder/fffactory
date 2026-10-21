/**
 * Secret material and where factory.json refers to it. Material comes from a hidden prompt,
 * standard input or Secrets Manager (`SecretStore.read`), goes only to Secrets Manager or, for
 * the Tailscale admin client, to Tailscale's token exchange, and is never shown or stored:
 * factory.json keeps only the secret's ARN.
 */
import {
  CREDENTIAL_SECRET_FIELDS,
  type CredentialSecretField,
  type FactoryId,
  type FactoryInstance,
  type HostKey,
  parseHostKey,
  type SecretReference,
  type TailscaleSecretField,
} from "./instance";
import { enrollmentOf } from "./readiness";
import { FACTORY_ID_TAG, MANAGED_BY_TAG } from "./resource-naming";
import { fieldPath, itemPath } from "./validation";

/** Secrets Manager's limit on a secret string, in bytes. */
export const MAX_SECRET_BYTES = 65_536;

const REDACTED = "[secret]";

/**
 * A secret value that shows as `[secret]` wherever it is printed, interpolated, inspected
 * or serialized. Only `reveal` returns the value, and only adapters call it: a `SecretStore`
 * adapter, to store or read it, and the Tailscale API adapter, for its token requests.
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
export type SecretName =
  | "tailscale-auth-key"
  | "tailscale-admin-client"
  | "paseo-password"
  | "github-token"
  | "anthropic-api-key"
  | "openai-api-key";

const SECRET_NAMES: readonly SecretName[] = [
  "tailscale-auth-key",
  "tailscale-admin-client",
  "paseo-password",
  "github-token",
  "anthropic-api-key",
  "openai-api-key",
];

/** The secrets that belong to the whole factory, under factory.json's `tailscale` or `credentials`. */
type FactorySecretName = Exclude<SecretName, "paseo-password">;

/** Where a factory-wide secret's reference lives: one field of one top-level section. */
type FactorySecretField =
  | { readonly section: "tailscale"; readonly field: TailscaleSecretField }
  | { readonly section: "credentials"; readonly field: CredentialSecretField };

/**
 * Each factory-wide secret's field and what it is. The auth key is the workers' join-only
 * enrollment key; the admin client is the operator's own Tailscale OAuth client, which no
 * worker ever receives. The API credentials are delivered to the hosts that keep no human
 * login for their account.
 */
const FACTORY_SECRETS: Readonly<
  Record<FactorySecretName, FactorySecretField & { readonly what: string }>
> = {
  "tailscale-auth-key": {
    section: "tailscale",
    field: "auth_key_secret",
    what: "Tailscale auth key",
  },
  "tailscale-admin-client": {
    section: "tailscale",
    field: "admin_client_secret",
    what: "Tailscale admin client",
  },
  "github-token": {
    section: "credentials",
    field: CREDENTIAL_SECRET_FIELDS.github,
    what: enrollmentOf("github").credential,
  },
  "anthropic-api-key": {
    section: "credentials",
    field: CREDENTIAL_SECRET_FIELDS.anthropic,
    what: enrollmentOf("anthropic").credential,
  },
  "openai-api-key": {
    section: "credentials",
    field: CREDENTIAL_SECRET_FIELDS.openai,
    what: enrollmentOf("openai").credential,
  },
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
  const { section, field, what } = FACTORY_SECRETS[name];
  return {
    ok: true,
    target: {
      name,
      field: fieldPath(section, field),
      secretName: `${factoryId}/${name}`,
      description: `${what} of factory ${factoryId}`,
      factoryId,
    },
  };
}

/** The section and field of a factory-wide target; a host's target has none. */
function factoryField(target: SecretTarget): FactorySecretField | undefined {
  return target.name === "paseo-password" ? undefined : FACTORY_SECRETS[target.name];
}

/** The reference factory.json currently holds for the target, if any. */
export function secretReference(
  instance: FactoryInstance,
  target: SecretTarget,
): SecretReference | undefined {
  const factory = factoryField(target);
  if (factory?.section === "tailscale") return instance.tailscale?.[factory.field];
  if (factory?.section === "credentials") return instance.credentials?.[factory.field];
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
  const factory = factoryField(target);
  if (factory !== undefined)
    return withEntry(
      instance,
      factory.section,
      withEntry(instance[factory.section], factory.field, arn),
    );
  const hosts = (instance.hosts ?? []).map((host) =>
    host.key === target.hostKey ? withEntry(host, "paseo_password_secret", arn) : host,
  );
  return withEntry(instance, "hosts", hosts);
}

/** The tags every secret fffactory creates carries, as every factory resource does. */
export function secretTags(factoryId: FactoryId): Readonly<Record<string, string>> {
  return { [FACTORY_ID_TAG]: factoryId, [MANAGED_BY_TAG]: "fffactory" };
}

/**
 * The Region a secret's ARN names: the only one where Secrets Manager finds it, so the only
 * one to ask about it. Any other answers `ResourceNotFoundException`, which is no proof of
 * absence.
 */
export function secretRegion(arn: SecretReference): string {
  const [, , , region = ""] = arn.split(":");
  return region;
}

/** A secret as Secrets Manager lists it: what its ownership is judged on. */
export interface ListedSecret {
  readonly name: string;
  readonly arn: SecretReference;
  readonly tags: Readonly<Record<string, string>>;
  /** Scheduled for deletion: Secrets Manager reports a deleted date. */
  readonly pendingDeletion: boolean;
}

declare const ownedBrand: unique symbol;

/**
 * A listed secret the factory owns. Only `classifySecrets` makes one, so nothing deletes a
 * secret the ownership rule did not pass.
 */
export type OwnedSecret = ListedSecret & { readonly [ownedBrand]: "OwnedSecret" };

/**
 * Whether factory `factoryId` owns the secret (D7): its name starts with `<factory ID>/` and
 * goes on, and it carries both `fffactory:factory-id = <factory ID>` and
 * `fffactory:managed-by = fffactory`, exactly. A tag alone, or a name alone, is never enough.
 */
export function ownsSecret(
  factoryId: FactoryId,
  secret: Pick<ListedSecret, "name" | "tags">,
): boolean {
  const prefix = `${factoryId}/`;
  const tags = secretTags(factoryId);
  return (
    secret.name.startsWith(prefix) &&
    secret.name.length > prefix.length &&
    Object.entries(tags).every(([key, value]) => secret.tags[key] === value)
  );
}

/** Every secret reference factory.json holds, in field order, each once. */
export function secretReferences(instance: FactoryInstance): readonly SecretReference[] {
  const factoryWide = Object.values(FACTORY_SECRETS).map((target) =>
    target.section === "tailscale"
      ? instance.tailscale?.[target.field]
      : instance.credentials?.[target.field],
  );
  const hosts = (instance.hosts ?? []).map((host) => host.paseo_password_secret);
  const references = [...factoryWide, ...hosts].filter(
    (reference): reference is SecretReference => reference !== undefined,
  );
  return [...new Set(references)];
}

/**
 * Whether a factory.json reference names the listed secret: its full ARN, or the partial ARN
 * without the six characters Secrets Manager adds after a hyphen.
 */
export function refersTo(reference: SecretReference, arn: SecretReference): boolean {
  return (
    reference === arn || (arn.startsWith(`${reference}-`) && arn.length === reference.length + 7)
  );
}

/** A factory's secrets as teardown sees them (D7). */
export interface SecretInventory {
  /** Owned: deleted permanently. */
  readonly owned: readonly OwnedSecret[];
  /** Tagged with the factory ID but not owned, by name or managed-by tag: kept. */
  readonly taggedNotOwned: readonly ListedSecret[];
  /** factory.json references that are no owned secret, such as a `fffv/*` source: kept. */
  readonly referencedNotOwned: readonly SecretReference[];
}

/**
 * Sorts the secrets listed by the factory-ID tag, and factory.json's references, by
 * ownership. A listed secret whose factory-ID tag is not exactly this factory's (the listing
 * filters by prefix) is another factory's, and is in no group.
 */
export function classifySecrets(
  factoryId: FactoryId,
  listed: readonly ListedSecret[],
  references: readonly SecretReference[],
): SecretInventory {
  const tagged = listed.filter((secret) => secret.tags[FACTORY_ID_TAG] === factoryId);
  const owned = tagged.filter((secret) => ownsSecret(factoryId, secret)) as OwnedSecret[];
  return {
    owned,
    taggedNotOwned: tagged.filter((secret) => !ownsSecret(factoryId, secret)),
    referencedNotOwned: [...new Set(references)].filter(
      (reference) => !owned.some((secret) => refersTo(reference, secret.arn)),
    ),
  };
}

/**
 * How deleting one owned secret ended (D8): `absent` only once Secrets Manager no longer
 * finds it. `reason` is fffactory's words or an AWS error name, never an AWS message.
 */
export type SecretDeletion =
  | { readonly kind: "absent" }
  | { readonly kind: "remains"; readonly reason: string };
