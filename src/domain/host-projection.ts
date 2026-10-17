/**
 * The host projection: the non-secret part of factory.json one worker needs, which apply
 * sends to `host apply` on standard input and the worker keeps as
 * `/var/lib/fffactory/host.json` (`docs/specs/host-protocol.md` §The host projection). It may
 * hold Secrets Manager ARNs but never the secret material they name. Its text is canonical, so
 * its SHA-256 identifies it: status and plan compare the digest the worker reports with the one
 * of the projection apply would send. Every stage builds it with `projectHost`, from a `Host` it
 * took from factory.json's `hosts`, or with `projectHosts`, from the instance itself, so all of
 * them send, install, plan and check the same one. The types do not enforce this (`Host` requires
 * only `key`); the pipeline test does (`tests/application/apply-factory-pipeline.test.ts`): `host
 * apply` and the Paseo install must get the same projection, and the plan and status after the
 * apply must find it current.
 */
import {
  CREDENTIAL_SECRET_FIELDS,
  type CredentialSecretField,
  deliveredAccounts,
  type FactoryId,
  type FactoryInstance,
  type Host,
  type HostKey,
  parseSecretReference,
  parseFactoryId,
  parseHostKey,
  parseRelease,
  type Release,
  type SecretReference,
} from "./instance";
import {
  type DocumentParse,
  type Fields,
  HOST_PROTOCOL_VERSION,
  Invalid,
  parseVersioned,
  record,
} from "./protocol-fields";
import { hostName } from "./resource-naming";

/** A SHA-256 of text, as 64 lowercase hexadecimal digits; injected where the domain needs one. */
export type Sha256 = (text: string) => string;

/**
 * The references of the API credentials delivered to one host, by factory.json's field name.
 * Never empty: a host delivered none has no `credentials` in its projection.
 */
export type HostCredentials = Readonly<Partial<Record<CredentialSecretField, SecretReference>>>;

/** The canonical order of `credentials`' fields: factory.json's. */
const CREDENTIAL_FIELDS: readonly CredentialSecretField[] = Object.values(CREDENTIAL_SECRET_FIELDS);

export interface HostProjection {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly factory_id: FactoryId;
  readonly host_key: HostKey;
  /** `<factory ID>-<host key>`: the worker's OS and Tailscale hostname. */
  readonly hostname: string;
  /** The release factory.json pins, which the worker installs. */
  readonly release: Release;
  /** The reference the factory-owned Paseo client uses; never the password it names. */
  readonly paseo_password_secret?: SecretReference;
  /**
   * The references of the API credentials delivered to the host (`deliveredAccounts`), never
   * the credentials they name. Not the control plane's: see `controlPlaneProjection`.
   */
  readonly credentials?: HostCredentials;
}

/** No projection is anywhere near this; `host apply` reads no more of standard input. */
export const MAX_PROJECTION_BYTES = 64 * 1024;

export function hostProjection(
  factoryId: FactoryId,
  hostKey: HostKey,
  release: Release,
  paseoPasswordSecret?: SecretReference,
  credentials?: HostCredentials,
): HostProjection {
  const canonical = canonicalCredentials(credentials ?? {});
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    factory_id: factoryId,
    host_key: hostKey,
    hostname: hostName(factoryId, hostKey),
    release,
    ...(paseoPasswordSecret === undefined ? {} : { paseo_password_secret: paseoPasswordSecret }),
    ...(canonical === undefined ? {} : { credentials: canonical }),
  };
}

/** `credentials`' references in canonical order, or undefined when there is none. */
function canonicalCredentials(credentials: HostCredentials): HostCredentials | undefined {
  const entries = CREDENTIAL_FIELDS.flatMap((field) => {
    const secret = credentials[field];
    return secret === undefined ? [] : [[field, secret] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * The part of a projection the control plane installs Paseo from: all of it but `credentials`
 * (D3). The control-plane plan digests only this part, so adding, changing or removing a
 * credential reference plans no Paseo change; it is what a worker without credentials keeps.
 */
export function controlPlaneProjection(projection: HostProjection): HostProjection {
  return hostProjection(
    projection.factory_id,
    projection.host_key,
    projection.release,
    projection.paseo_password_secret,
  );
}

/**
 * The one projection of `instance`'s `host` for the pinned `release`: what the control-plane
 * stage installs from, and plan and status digest. Pass the `Host` from factory.json's `hosts`
 * itself: any value with a `key` type-checks, and a narrower one, such as a planned worker,
 * silently drops the Paseo secret reference (#132). The credential references are those
 * `deliveredAccounts` delivers to the host.
 */
export function projectHost(
  instance: FactoryInstance,
  factoryId: FactoryId,
  release: Release,
  host: Host,
): HostProjection {
  const credentials = Object.fromEntries(
    deliveredAccounts(instance, host.key).map(({ id, secret }) => [
      CREDENTIAL_SECRET_FIELDS[id],
      secret,
    ]),
  );
  return hostProjection(factoryId, host.key, release, host.paseo_password_secret, credentials);
}

/**
 * Every host factory.json declares, projected for the pinned `release` in factory.json's order:
 * what the workers stage sends. It reads the hosts from the instance, so its caller never holds
 * a narrower list to project.
 */
export function projectHosts(
  instance: FactoryInstance,
  factoryId: FactoryId,
  release: Release,
): HostProjection[] {
  return (instance.hosts ?? []).map((host) => projectHost(instance, factoryId, release, host));
}

/** The SHA-256 of the projection's canonical text: what a worker holding it reports. */
export function hostProjectionSha256(projection: HostProjection, sha256: Sha256): string {
  return sha256(hostProjectionJson(projection));
}

/** The canonical text: keys in a fixed order, two-space indented, one final newline. */
export function hostProjectionJson(projection: HostProjection): string {
  const {
    protocol_version,
    factory_id,
    host_key,
    hostname,
    release,
    paseo_password_secret,
    credentials,
  } = projection;
  const canonical = canonicalCredentials(credentials ?? {});
  return `${JSON.stringify(
    {
      protocol_version,
      factory_id,
      host_key,
      hostname,
      release,
      ...(paseo_password_secret === undefined ? {} : { paseo_password_secret }),
      ...(canonical === undefined ? {} : { credentials: canonical }),
    },
    null,
    2,
  )}\n`;
}

function parsed<T>(result: { ok: true; value: T } | { ok: false }, field: string): T {
  if (!result.ok) throw new Invalid(`${field} is missing or malformed`);
  return result.value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readProjection(document: Fields): HostProjection {
  const factoryId = parsed(parseFactoryId(text(document.factory_id)), "factory_id");
  const hostKey = parsed(parseHostKey(text(document.host_key)), "host_key");
  const release = parsed(parseRelease(text(document.release)), "release");
  const secret =
    document.paseo_password_secret === undefined
      ? undefined
      : parsed(parseSecretReference(text(document.paseo_password_secret)), "paseo_password_secret");
  const projection = hostProjection(
    factoryId,
    hostKey,
    release,
    secret,
    document.credentials === undefined ? undefined : readCredentials(document.credentials),
  );
  if (document.hostname !== projection.hostname)
    throw new Invalid("hostname is not the factory ID and host key");
  return projection;
}

/** The known credential references; any other field fails the canonical check. */
function readCredentials(value: unknown): HostCredentials {
  const fields = record(value, "credentials");
  return Object.fromEntries(
    CREDENTIAL_FIELDS.flatMap((field) =>
      fields[field] === undefined
        ? []
        : [
            [
              field,
              parsed(parseSecretReference(text(fields[field])), `credentials.${field}`),
            ] as const,
          ],
    ),
  );
}

/**
 * Reads the projection on the worker. Only the canonical text is accepted, so the file the
 * worker keeps has exactly the digest the CLI computed.
 */
export function parseHostProjection(input: string): DocumentParse<HostProjection> {
  if (input.length > MAX_PROJECTION_BYTES)
    return {
      ok: false,
      kind: "invalid",
      problem: `the document is larger than ${MAX_PROJECTION_BYTES} bytes`,
    };
  const result = parseVersioned(input, readProjection);
  if (result.ok && hostProjectionJson(result.document) !== input)
    return { ok: false, kind: "invalid", problem: "the document is not in its canonical form" };
  return result;
}
