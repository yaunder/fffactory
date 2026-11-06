/**
 * The log archive over S3 (`docs/specs/collector.md` §Credentials and publishing): the
 * collector's `ArchiveWriter`, signed only with the instance role's credentials from instance
 * metadata (IMDSv2), never the default credential chain, a profile or static keys. Opening it
 * asks STS who the caller is, the incarnation whose prefix the hosts' policy lets it write
 * (`aws:userid`, `<role ID>:<instance ID>`), and the account that must own the bucket. Every put
 * creates its object once (`If-None-Match: *`, `ExpectedBucketOwner`). Every call has a
 * deadline, and a failure is named by its AWS error name or network error code, never a message.
 * The SDK is imported on first use.
 */
import type { S3Client } from "@aws-sdk/client-s3";
import {
  type ArchiveWriter,
  callerIncarnation,
  type PutOutcome,
  type WorkerIncarnation,
} from "../domain/archive-format";
import { httpStatus } from "../infrastructure/aws-session";

/** The bucket and Region the collector's configuration names. */
export interface ArchiveTarget {
  readonly bucket: string;
  readonly region: string;
}

/** The archive opened for this incarnation, until `close`. */
export interface OpenedArchive {
  readonly kind: "opened";
  /** The caller's account, which must own the bucket. */
  readonly account: string;
  readonly incarnation: WorkerIncarnation;
  readonly writer: ArchiveWriter;
  close(): void;
}

/** The archive, or why it could not be opened, by its class. */
export type ArchiveSession = OpenedArchive | { readonly kind: "failed"; readonly failure: string };

export interface InstanceArchiveOptions {
  /** Loopback stand-ins for S3 and STS, for tests; a worker never passes any. */
  readonly endpoints?: { readonly s3: string; readonly sts: string };
  /** Each call's deadline: opening (instance metadata and STS together), then each put. */
  readonly deadlineMs?: number;
}

/** Each AWS call's deadline: well inside a run's time budget. */
export const ARCHIVE_CALL_DEADLINE_MS = 10_000;
/** Instance metadata's own per-request timeout and retries, inside the open's deadline. */
const IMDS = { timeout: 1_000, maxRetries: 2 } as const;

/** What a call that passed its deadline is reported as. */
export const DEADLINE_EXCEEDED = "DeadlineExceeded";
/** A caller STS names that is no instance role's session (§Credentials and publishing). */
export const NOT_AN_INSTANCE_ROLE = "NotAnInstanceRole";
const UNEXPECTED = "UnexpectedError";

const FAILURE_CLASS = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const ACCOUNT_ID = /^\d{12}$/;
const DEADLINE = Symbol("deadline");

/**
 * A failure's class: the service error's name, else a network error code, else the error's name;
 * never its message. A name or code that is no plain identifier is unexpected.
 */
export function failureClass(error: unknown): string {
  if (error === DEADLINE) return DEADLINE_EXCEEDED;
  if (!(error instanceof Error)) return UNEXPECTED;
  const { name, code, $fault } = error as Error & { code?: unknown; $fault?: unknown };
  const candidate = $fault === undefined && typeof code === "string" ? code : name;
  return FAILURE_CLASS.test(candidate) ? candidate : UNEXPECTED;
}

/** Runs `work` within `ms`, aborting it at the deadline. */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(DEADLINE), ms);
  });
  const running = work(controller.signal);
  // After the deadline the aborted call still settles; nothing waits for it.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** The SDK's logger, silenced: nothing the SDK says reaches the journal. */
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

/** The instance role's credentials, from instance metadata alone, IMDSv2 only. */
async function instanceCredentials() {
  const { fromInstanceMetadata } = await import("@smithy/credential-provider-imds");
  return fromInstanceMetadata({ ...IMDS, ec2MetadataV1Disabled: true, logger: SILENT })();
}

type Credentials = Awaited<ReturnType<typeof instanceCredentials>>;

function clientConfig(region: string, credentials: Credentials, endpoint: string | undefined) {
  return {
    region,
    credentials,
    logger: SILENT,
    maxAttempts: 1,
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

/** Who the caller is: its account and incarnation, or undefined for any other caller. */
async function whoAmI(
  target: ArchiveTarget,
  credentials: Credentials,
  endpoint: string | undefined,
  signal: AbortSignal,
) {
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const client = new STSClient(clientConfig(target.region, credentials, endpoint));
  try {
    const { Account, UserId } = await client.send(new GetCallerIdentityCommand({}), {
      abortSignal: signal,
    });
    const incarnation = callerIncarnation(UserId ?? "");
    if (incarnation === undefined || !ACCOUNT_ID.test(Account ?? "")) return undefined;
    return { account: Account as string, incarnation };
  } finally {
    client.destroy();
  }
}

function writer(
  client: S3Client,
  target: ArchiveTarget,
  account: string,
  deadlineMs: number,
): ArchiveWriter {
  return {
    async put(key: string, bytes: Uint8Array): Promise<PutOutcome> {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const command = new PutObjectCommand({
        Bucket: target.bucket,
        Key: key,
        Body: bytes,
        IfNoneMatch: "*",
        ExpectedBucketOwner: account,
      });
      try {
        await within(deadlineMs, (signal) => client.send(command, { abortSignal: signal }));
        return { kind: "created" };
      } catch (error) {
        if (error !== DEADLINE && httpStatus(error) === 412) return { kind: "exists" };
        return { kind: "failed", failure: failureClass(error) };
      }
    },
  };
}

/**
 * Opens the archive as this worker's instance role: its credentials from instance metadata, its
 * account and incarnation from STS, within one deadline. A caller that is no instance role's
 * session fails it (`NotAnInstanceRole`), so nothing is written under a prefix not its own.
 */
export async function openInstanceArchive(
  target: ArchiveTarget,
  options: InstanceArchiveOptions = {},
): Promise<ArchiveSession> {
  const deadlineMs = options.deadlineMs ?? ARCHIVE_CALL_DEADLINE_MS;
  let opened: { credentials: Credentials; caller: Awaited<ReturnType<typeof whoAmI>> };
  try {
    opened = await within(deadlineMs, async (signal) => {
      const credentials = await instanceCredentials();
      return {
        credentials,
        caller: await whoAmI(target, credentials, options.endpoints?.sts, signal),
      };
    });
  } catch (error) {
    return { kind: "failed", failure: failureClass(error) };
  }
  const { credentials, caller } = opened;
  if (caller === undefined) return { kind: "failed", failure: NOT_AN_INSTANCE_ROLE };
  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    ...clientConfig(target.region, credentials, options.endpoints?.s3),
    ...(options.endpoints === undefined ? {} : { forcePathStyle: true }),
  });
  return {
    kind: "opened",
    account: caller.account,
    incarnation: caller.incarnation,
    writer: writer(client, target, caller.account, deadlineMs),
    close: () => client.destroy(),
  };
}
