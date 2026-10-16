/**
 * Backend bootstrap's plan rules. The first apply creates the state bucket, which must
 * exist before the factory's Terraform state and the factory-wide lock can live in it. Its
 * small plan is shown and approved on its own, and may only create. A bucket an interrupted
 * bootstrap left without all its settings is refused (`unreadyBucket`); the CLI lays out how
 * to complete it (`cli/presentation/plan.ts`).
 */
import { changesSomething, type PlanTarget, type ResourceChange } from "./plan";
import { isRecord } from "./validation";

export type BootstrapPlanVerdict =
  | { readonly ok: true; readonly creates: readonly string[] }
  | { readonly ok: false; readonly unexpected: readonly ResourceChange[] };

/** A backend bootstrap plan may only create resources; anything else is refused. */
export function bootstrapPlanVerdict(changes: readonly ResourceChange[]): BootstrapPlanVerdict {
  const changing = changes.filter(changesSomething);
  const unexpected = changing.filter(({ actions }) => actions.join() !== "create");
  if (unexpected.length > 0) return { ok: false, unexpected };
  return { ok: true, creates: changing.map(({ address }) => address) };
}

/** What the bootstrap plan shows before its changes: the plan's target and the bucket. */
export interface BootstrapContext extends PlanTarget {
  readonly bucket: string;
}

/**
 * What backend bootstrap sets on the state bucket, as S3 reports it. HeadBucket alone cannot
 * tell a finished bootstrap from one interrupted after the bucket was created.
 */
export interface StateBucketReadiness {
  /** GetBucketVersioning's status: `Enabled`, `Suspended`, or undefined when never enabled. */
  readonly versioning: string | undefined;
  /** Every one of the four public access block settings is on. */
  readonly publicAccessBlocked: boolean;
  /** The bucket has a default encryption rule. */
  readonly encrypted: boolean;
  /** The bucket policy denies every request not made over TLS (`deniesInsecureTransport`). */
  readonly tlsOnly: boolean;
}

export type BucketHardening =
  | "versioning"
  | "public_access_block"
  | "default_encryption"
  | "tls_only_policy";

const HARDENING: readonly BucketHardening[] = [
  "versioning",
  "public_access_block",
  "default_encryption",
  "tls_only_policy",
];

/** Each setting backend bootstrap applies that the bucket lacks, in the order it applies them. */
export function missingHardening(readiness: StateBucketReadiness): BucketHardening[] {
  const present: Record<BucketHardening, boolean> = {
    versioning: readiness.versioning === "Enabled",
    public_access_block: readiness.publicAccessBlocked,
    default_encryption: readiness.encrypted,
    tls_only_policy: readiness.tlsOnly,
  };
  return HARDENING.filter((setting) => !present[setting]);
}

/**
 * The state bucket's TLS-only policy, as the `state-bucket` module writes it: every S3
 * action on the bucket and its objects is denied unless made over TLS.
 */
export function tlsOnlyPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  });
}

/** A policy element that may be one value or a list of them. */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function everyone(principal: unknown): boolean {
  if (principal === "*") return true;
  return isRecord(principal) && listOf(principal.AWS).includes("*");
}

function coversBucket(resource: unknown, bucket: string): boolean {
  const resources = listOf(resource).filter((value) => typeof value === "string");
  const covers = (suffix: string) => resources.some((value) => value.endsWith(`:s3:::${suffix}`));
  return covers(bucket) && covers(`${bucket}/*`);
}

function insecureTransportOnly(condition: unknown): boolean {
  if (!isRecord(condition) || !isRecord(condition.Bool)) return false;
  const values = listOf(condition.Bool["aws:SecureTransport"]);
  return values.length === 1 && String(values[0]) === "false";
}

function deniesInsecure(statement: unknown, bucket: string): boolean {
  return (
    isRecord(statement) &&
    statement.Effect === "Deny" &&
    everyone(statement.Principal) &&
    listOf(statement.Action).includes("s3:*") &&
    coversBucket(statement.Resource, bucket) &&
    insecureTransportOnly(statement.Condition)
  );
}

/** Whether a bucket policy denies every S3 action on the bucket and its objects without TLS. */
export function deniesInsecureTransport(policy: string | undefined, bucket: string): boolean {
  if (policy === undefined) return false;
  let document: unknown;
  try {
    document = JSON.parse(policy);
  } catch {
    return false;
  }
  if (!isRecord(document)) return false;
  return listOf(document.Statement).some((statement) => deniesInsecure(statement, bucket));
}

/** Where the state bucket is, for the commands that complete it. */
export interface StateBucketLocation {
  readonly bucket: string;
  readonly accountId: string;
  readonly region: string;
}

/**
 * A state bucket that exists but lacks some of backend bootstrap's settings: where it is, what
 * S3 reports of it, and each setting it lacks, in the order bootstrap applies them. The backend
 * root keeps no state and a rerun skips a bucket that exists, so fffactory itself cannot finish
 * an interrupted bootstrap: the operator completes it.
 */
export interface UnreadyBucket {
  readonly location: StateBucketLocation;
  readonly readiness: StateBucketReadiness;
  readonly missing: readonly BucketHardening[];
}

/** The bucket at `location` as an unready one, or undefined when it has every setting. */
export function unreadyBucket(
  location: StateBucketLocation,
  readiness: StateBucketReadiness,
): UnreadyBucket | undefined {
  const missing = missingHardening(readiness);
  if (missing.length === 0) return undefined;
  const { bucket, accountId, region } = location;
  return { location: { bucket, accountId, region }, readiness, missing };
}
