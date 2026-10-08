import {
  arrayOf,
  boolean,
  duplicateKeys,
  fieldPath,
  type Issue,
  integer,
  isRecord,
  itemPath,
  literal,
  nonEmptyText,
  object,
  pattern,
  ROOT,
  text,
} from "./validation";
import { carriesFactoryId } from "./resource-naming";

export type { Issue } from "./validation";
export { ROOT as DOCUMENT_ROOT } from "./validation";

export const SCHEMA_VERSION = 1;

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Permanent factory identifier that namespaces AWS resources and Tailscale hostnames. */
export type FactoryId = Brand<string, "FactoryId">;
/** Factory release version, `MAJOR.MINOR.PATCH` with an optional `-prerelease`. */
export type Release = Brand<string, "Release">;
/** Stable host identifier; renaming one means declaring a new host. */
export type HostKey = Brand<string, "HostKey">;
/** Secrets Manager ARN standing in for a secret value that never enters configuration. */
export type SecretReference = Brand<string, "SecretReference">;

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const FACTORY_ID = /^(?=.{3,20}$)[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const FACTORY_ID_MESSAGE =
  "must be 3-20 lowercase letters, digits and single hyphens, starting with a letter";
const HOST_KEY = /^(?=.{1,32}$)[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HOST_KEY_MESSAGE =
  "must be 1-32 lowercase letters, digits and single hyphens, starting with a letter";
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
const SECRET_MESSAGE =
  "must be a Secrets Manager secret ARN; secret values never belong in factory.json";
const RELEASE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const RELEASE_MESSAGE = "must be a release version like 1.2.3";
const ACCOUNT_ID = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REPOSITORY_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isRepositoryKey = (value: string) => REPOSITORY_KEY.test(value);
const isHostKey = (value: string) => HOST_KEY.test(value);

function parseWith<T>(expression: RegExp, message: string) {
  return (value: string): Parsed<T> =>
    expression.test(value) ? { ok: true, value: value as T } : { ok: false, message };
}

export const parseFactoryId = parseWith<FactoryId>(FACTORY_ID, FACTORY_ID_MESSAGE);
export const parseHostKey = parseWith<HostKey>(HOST_KEY, HOST_KEY_MESSAGE);
export const parseRelease = parseWith<Release>(RELEASE, RELEASE_MESSAGE);
export const parseSecretReference = parseWith<SecretReference>(SECRET_ARN, SECRET_MESSAGE);

export interface DispatchSettings {
  readonly enabled?: boolean;
  readonly cron?: string;
  readonly timezone?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly cwd?: string;
}

export interface Host {
  readonly key: HostKey;
  readonly instance_type?: string;
  readonly root_volume_gib?: number;
  readonly paseo_password_secret?: SecretReference;
  readonly repositories?: readonly string[];
  readonly dispatch?: DispatchSettings;
}

export interface Repository {
  readonly key: string;
  readonly remote: string;
  readonly path: string;
  readonly branch: string;
}

/** The `.fffactory/factory.json` document. Every field but the schema version may be absent. */
export interface FactoryInstance {
  readonly $schema?: string;
  readonly schema_version: typeof SCHEMA_VERSION;
  readonly release?: string;
  readonly factory_id?: FactoryId;
  readonly name?: string;
  readonly aws?: { readonly account_id?: string; readonly region?: string };
  readonly state_backend?: { readonly bucket?: string };
  readonly network?: {
    readonly vpc_cidr?: string;
    readonly public_subnet_cidr?: string;
    readonly availability_zone?: string;
  };
  readonly tailscale?: { readonly tag?: string; readonly auth_key_secret?: SecretReference };
  readonly repositories?: readonly Repository[];
  readonly hosts?: readonly Host[];
}

const OCTET = String.raw`(25[0-5]|2[0-4]\d|1\d\d|0?\d?\d)`;
/** Same rule as the schema's CIDR pattern: octets 0-255, prefix 0-32 without a leading zero. */
const IPV4_CIDR = new RegExp(String.raw`^(${OCTET}\.){3}${OCTET}/(3[0-2]|[12]?\d)$`);

function isCheckoutPath(value: string): boolean {
  const segments = value.split("/");
  return segments.every(
    (segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..",
  );
}

const secretReference = pattern(SECRET_ARN, SECRET_MESSAGE);
const repositoryKey = pattern(
  REPOSITORY_KEY,
  "must be letters, digits, dots, underscores and hyphens, starting with a letter or digit",
);

const hostRule = object(
  {
    key: pattern(HOST_KEY, HOST_KEY_MESSAGE),
    instance_type: pattern(/^[a-z0-9-]+\.[a-z0-9]+$/, "must be an EC2 instance type"),
    root_volume_gib: integer(8, 16384),
    paseo_password_secret: secretReference,
    repositories: arrayOf(repositoryKey),
    dispatch: object({
      enabled: boolean,
      cron: nonEmptyText,
      timezone: nonEmptyText,
      provider: nonEmptyText,
      model: nonEmptyText,
      mode: nonEmptyText,
      cwd: text(
        (value) =>
          value.startsWith("/") &&
          !value.includes("\0") &&
          !value.includes("\r") &&
          !value.includes("\n"),
        "must be an absolute path",
      ),
    }),
  },
  ["key"],
);

const repositoryRule = object(
  {
    key: repositoryKey,
    remote: pattern(
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
      "must be an https://github.com/OWNER/NAME remote",
    ),
    path: text(isCheckoutPath, "must be a relative path without empty, '.' or '..' segments"),
    branch: nonEmptyText,
  },
  ["key", "remote", "path", "branch"],
);

const documentRule = object(
  {
    $schema: nonEmptyText,
    schema_version: literal(SCHEMA_VERSION),
    release: pattern(RELEASE, RELEASE_MESSAGE),
    factory_id: pattern(FACTORY_ID, FACTORY_ID_MESSAGE),
    name: nonEmptyText,
    aws: object({
      account_id: pattern(ACCOUNT_ID, "must be a 12-digit AWS account ID"),
      region: pattern(REGION, "must be an AWS Region like us-east-1"),
    }),
    state_backend: object({
      bucket: pattern(BUCKET, "must be an S3 bucket name"),
    }),
    network: object({
      vpc_cidr: pattern(IPV4_CIDR, "must be an IPv4 CIDR block"),
      public_subnet_cidr: pattern(IPV4_CIDR, "must be an IPv4 CIDR block"),
      availability_zone: pattern(
        /^[a-z]{2}(-[a-z]+)+-\d+[a-z]$/,
        "must be an availability zone like us-east-1a",
      ),
    }),
    tailscale: object({
      tag: pattern(/^tag:[A-Za-z][A-Za-z0-9-]*$/, "must be a Tailscale tag like tag:factory"),
      auth_key_secret: secretReference,
    }),
    repositories: arrayOf(repositoryRule),
    hosts: arrayOf(hostRule),
  },
  ["schema_version"],
);

interface KeyedEntry {
  readonly key: string;
  readonly path: string;
  readonly itemPath: string;
  readonly value: Record<string, unknown>;
}

/** Array entries whose field is a well-formed string, so messages may safely quote it. */
function wellFormedEntries(
  list: unknown,
  listPath: string,
  field: string,
  accept: (value: string) => boolean,
): KeyedEntry[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((value, index) => {
    const key = isRecord(value) ? value[field] : undefined;
    if (typeof key !== "string" || !accept(key)) return [];
    const entryPath = itemPath(listPath, index);
    return [{ key, value, itemPath: entryPath, path: fieldPath(entryPath, field) }];
  });
}

function checkRepositories(document: Record<string, unknown>, issues: Issue[]): Set<string> {
  const repositories = document.repositories;
  const byKey = wellFormedEntries(repositories, "repositories", "key", isRepositoryKey);
  duplicateKeys(byKey, (key) => `duplicates repository key "${key}"`, issues);
  const byPath = wellFormedEntries(repositories, "repositories", "path", isCheckoutPath);
  duplicateKeys(byPath, (path) => `duplicates checkout path "${path}"`, issues);
  return new Set(byKey.map((entry) => entry.key));
}

function checkPlacement(host: KeyedEntry, declared: Set<string>, issues: Issue[]): void {
  const placed = host.value.repositories;
  if (!Array.isArray(placed)) return;
  placed.forEach((repository, index) => {
    if (typeof repository !== "string" || !isRepositoryKey(repository)) return;
    if (!declared.has(repository)) {
      issues.push({
        path: itemPath(fieldPath(host.itemPath, "repositories"), index),
        message: `references undeclared repository "${repository}"`,
      });
    }
  });
}

function checkHosts(document: Record<string, unknown>, declared: Set<string>, issues: Issue[]) {
  const hosts = wellFormedEntries(document.hosts, "hosts", "key", isHostKey);
  duplicateKeys(hosts, (key) => `duplicates host key "${key}"`, issues);
  for (const host of hosts) checkPlacement(host, declared, issues);
}

/** The state bucket's name carries the factory ID, as every factory resource name does. */
function checkStateBucket(document: Record<string, unknown>, issues: Issue[]): void {
  const factoryId = document.factory_id;
  const backend = document.state_backend;
  const bucket = isRecord(backend) ? backend.bucket : undefined;
  if (typeof factoryId !== "string" || !FACTORY_ID.test(factoryId)) return;
  if (typeof bucket !== "string" || !BUCKET.test(bucket)) return;
  if (!carriesFactoryId(bucket, factoryId as FactoryId))
    issues.push({
      path: "state_backend.bucket",
      message: "must start with the factory ID and a hyphen, so its name carries the factory ID",
    });
}

/** A field of one of the document's objects, or undefined. */
function nested(document: Record<string, unknown>, parent: string, field: string): unknown {
  const value = document[parent];
  return isRecord(value) ? value[field] : undefined;
}

/** Every secret field that holds a well-formed ARN, by field path. */
function secretFields(document: Record<string, unknown>): { path: string; arn: string }[] {
  const tailscale = nested(document, "tailscale", "auth_key_secret");
  const fields = [{ path: "tailscale.auth_key_secret", arn: tailscale }];
  if (Array.isArray(document.hosts))
    document.hosts.forEach((host, index) => {
      if (!isRecord(host)) return;
      const path = fieldPath(itemPath("hosts", index), "paseo_password_secret");
      fields.push({ path, arn: host.paseo_password_secret });
    });
  return fields.flatMap(({ path, arn }) =>
    typeof arn === "string" && SECRET_ARN.test(arn) ? [{ path, arn }] : [],
  );
}

/**
 * Every secret lives in the factory's own Region and account: first boot reads the Tailscale
 * key in the factory Region, and the host role has no access to another account. Messages
 * name the field, never the ARN.
 */
function checkSecretPlacement(document: Record<string, unknown>, issues: Issue[]): void {
  const region = nested(document, "aws", "region");
  const account = nested(document, "aws", "account_id");
  for (const { path, arn } of secretFields(document)) {
    const [, , , arnRegion, arnAccount] = arn.split(":");
    if (typeof region === "string" && REGION.test(region) && arnRegion !== region)
      issues.push({ path, message: "must be a secret in the factory Region, aws.region" });
    if (typeof account === "string" && ACCOUNT_ID.test(account) && arnAccount !== account)
      issues.push({ path, message: "must be a secret in the factory account, aws.account_id" });
  }
}

/** factory.json's text: two-space indented JSON and a final newline. */
export function serializeInstance(instance: FactoryInstance): string {
  return `${JSON.stringify(instance, null, 2)}\n`;
}

export type InstanceParse =
  | { readonly valid: true; readonly instance: FactoryInstance }
  | { readonly valid: false; readonly issues: readonly Issue[] };

/** Validates an untyped document as factory.json schema v1, reporting every issue by field path. */
export function parseFactoryInstance(document: unknown): InstanceParse {
  const issues: Issue[] = [];
  documentRule(document, ROOT, issues);
  if (isRecord(document)) {
    const declared = checkRepositories(document, issues);
    checkHosts(document, declared, issues);
    checkStateBucket(document, issues);
    checkSecretPlacement(document, issues);
  }
  return issues.length === 0
    ? { valid: true, instance: document as unknown as FactoryInstance }
    : { valid: false, issues };
}

export interface CompletenessReport {
  readonly complete: boolean;
  readonly missing: readonly string[];
}

const REQUIRED_FOR_COMPLETENESS: readonly (readonly [string, (i: FactoryInstance) => unknown])[] = [
  ["release", (i) => i.release],
  ["factory_id", (i) => i.factory_id],
  ["name", (i) => i.name],
  ["aws.account_id", (i) => i.aws?.account_id],
  ["aws.region", (i) => i.aws?.region],
  ["state_backend.bucket", (i) => i.state_backend?.bucket],
  ["network.vpc_cidr", (i) => i.network?.vpc_cidr],
  ["network.public_subnet_cidr", (i) => i.network?.public_subnet_cidr],
  ["network.availability_zone", (i) => i.network?.availability_zone],
  ["tailscale.tag", (i) => i.tailscale?.tag],
  ["tailscale.auth_key_secret", (i) => i.tailscale?.auth_key_secret],
];

const REQUIRED_HOST_FIELDS = ["instance_type", "root_volume_gib"] as const;

function missingHostFields(hosts: readonly Host[] | undefined): string[] {
  if (!hosts || hosts.length === 0) return ["hosts"];
  const dispatchFields = ["cron", "timezone", "provider", "model", "mode", "cwd"] as const;
  return hosts.flatMap((host, index) => [
    ...REQUIRED_HOST_FIELDS.filter((field) => host[field] === undefined).map((field) =>
      fieldPath(itemPath("hosts", index), field),
    ),
    ...(host.dispatch?.enabled === true
      ? dispatchFields
          .filter((field) => host.dispatch?.[field] === undefined)
          .map((field) => fieldPath(fieldPath(itemPath("hosts", index), "dispatch"), field))
      : []),
  ]);
}

/** Lists the fields a valid, possibly partial, instance still needs before it can be planned. */
export function assessCompleteness(instance: FactoryInstance): CompletenessReport {
  const missing = [
    ...REQUIRED_FOR_COMPLETENESS.filter(([, read]) => read(instance) === undefined).map(
      ([path]) => path,
    ),
    ...missingHostFields(instance.hosts),
  ];
  return { complete: missing.length === 0, missing };
}
