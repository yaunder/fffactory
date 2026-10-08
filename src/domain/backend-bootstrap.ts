/**
 * Backend bootstrap's plan rules. The first apply creates the state bucket, which must
 * exist before the factory's Terraform state and the factory-wide lock can live in it. Its
 * small plan is shown and approved on its own, and may only create.
 */
import { changesSomething, describeTarget, type PlanTarget, type ResourceChange } from "./plan";
import { isRecord } from "./validation";

export type BootstrapPlanVerdict =
  | { readonly ok: true; readonly creates: readonly string[] }
  | { readonly ok: false; readonly unexpected: readonly string[] };

/** A backend bootstrap plan may only create resources; anything else is refused. */
export function bootstrapPlanVerdict(changes: readonly ResourceChange[]): BootstrapPlanVerdict {
  const changing = changes.filter(changesSomething);
  const unexpected = changing.filter(({ actions }) => actions.join() !== "create");
  if (unexpected.length > 0)
    return {
      ok: false,
      unexpected: unexpected.map(({ address, actions }) => `${address} (${actions.join(", ")})`),
    };
  return { ok: true, creates: changing.map(({ address }) => address) };
}

/** What the bootstrap plan shows before its changes: the plan's target and the bucket. */
export interface BootstrapContext extends PlanTarget {
  readonly bucket: string;
}

/** The lines an operator approves the backend bootstrap plan from. */
export function describeBootstrapPlan(
  context: BootstrapContext,
  creates: readonly string[],
): string[] {
  return [
    `Backend bootstrap: the state bucket ${context.bucket} does not exist yet.`,
    ...describeTarget(context),
    "Terraform will create:",
    ...creates.map((address) => `  + ${address}`),
  ];
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

function hardeningLabel(setting: BucketHardening, readiness: StateBucketReadiness): string {
  const labels: Record<BucketHardening, string> = {
    versioning: `versioning (${readiness.versioning ?? "never enabled"})`,
    public_access_block: "public access block",
    default_encryption: "default encryption",
    tls_only_policy: "TLS-only bucket policy",
  };
  return labels[setting];
}

function hardeningCommand(setting: BucketHardening, location: StateBucketLocation): string {
  const commands: Record<BucketHardening, readonly [string, string]> = {
    versioning: ["put-bucket-versioning", "--versioning-configuration Status=Enabled"],
    public_access_block: [
      "put-public-access-block",
      "--public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true," +
        "BlockPublicPolicy=true,RestrictPublicBuckets=true",
    ],
    default_encryption: [
      "put-bucket-encryption",
      "--server-side-encryption-configuration " +
        `'${JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] })}'`,
    ],
    tls_only_policy: ["put-bucket-policy", `--policy '${tlsOnlyPolicy(location.bucket)}'`],
  };
  const [command, settings] = commands[setting];
  return (
    `aws s3api ${command} --region ${location.region} --bucket ${location.bucket} ` +
    `--expected-bucket-owner ${location.accountId} ${settings}`
  );
}

// TODO(re-evaluate when the state-bucket module's hardening changes, or when apply can import
// existing resources into the backend root): converge the state bucket's hardening on rerun
// through the reviewed backend plan instead of printing AWS CLI commands.
/**
 * Why an operation refuses a state bucket that exists but lacks some of backend bootstrap's
 * settings, and how to complete it. The backend root keeps no state and a rerun skips a bucket
 * that exists, so fffactory itself cannot finish an interrupted bootstrap.
 */
export function unreadyBucketRefusal(
  location: StateBucketLocation,
  readiness: StateBucketReadiness,
): string[] {
  const missing = missingHardening(readiness);
  return [
    `The state bucket ${location.bucket} exists, but backend bootstrap did not finish it. It lacks:`,
    ...missing.map((setting) => `  ${hardeningLabel(setting, readiness)}`),
    "If another first apply is still bootstrapping it, wait for that to finish, then retry.",
    "Otherwise complete the bucket with these AWS CLI commands, using credentials for account " +
      `${location.accountId}, then retry:`,
    ...missing.map((setting) => `  ${hardeningCommand(setting, location)}`),
    ...(missing.includes("tls_only_policy")
      ? ["put-bucket-policy replaces the whole bucket policy: add any statements it already has."]
      : []),
  ];
}
