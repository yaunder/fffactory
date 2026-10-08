import type { EC2ClientConfig } from "@aws-sdk/client-ec2";
import type { ServiceQuotasClientConfig } from "@aws-sdk/client-service-quotas";
import type { VpcQuotaProbe } from "../application/vpc-quota-probe";
import type { FactoryId } from "../domain/instance";
import { FACTORY_ID_TAG } from "../domain/resource-naming";
import { type VpcQuotaObservation, VPCS_PER_REGION } from "../domain/vpc-quota";
import { NETWORK_CODES } from "./aws-sts-caller-identity";

/**
 * One deadline for the whole inspection: credentials, the quota (and its default fallback)
 * and every DescribeVpcs page. Twice STS's, because it is up to three calls in sequence.
 */
export const VPC_QUOTA_TIMEOUT_MS = 10_000;

/** DescribeVpcs' largest page, so most Regions take one call. */
const PAGE_SIZE = 1000;

/** What every call in one inspection shares. */
export interface VpcQuotaSession {
  readonly region: string;
  /** The selected profile, or undefined for the standard AWS credential chain. */
  readonly profile: string | undefined;
  readonly abortSignal: AbortSignal;
}

/** The fields of a GetServiceQuota or GetAWSDefaultServiceQuota answer the adapter reads. */
export interface QuotaAnswer {
  readonly Quota?: { readonly Value?: number | undefined } | undefined;
}

/** The fields of one DescribeVpcs page the adapter reads. */
export interface VpcPage {
  readonly Vpcs?:
    | readonly {
        readonly Tags?:
          | readonly { readonly Key?: string | undefined; readonly Value?: string | undefined }[]
          | undefined;
      }[]
    | undefined;
  readonly NextToken?: string | undefined;
}

export type QuotaInput = typeof VPCS_PER_REGION;

/** The read-only calls of one session. Each rejects with the AWS SDK's own errors. */
export interface VpcQuotaCalls {
  getServiceQuota(input: QuotaInput): Promise<QuotaAnswer>;
  getAwsDefaultServiceQuota(input: QuotaInput): Promise<QuotaAnswer>;
  describeVpcs(nextToken: string | undefined): Promise<VpcPage>;
  /** Releases the clients. */
  close(): void;
}

/** Opens the calls for one session: its Region, credentials and abort signal. */
export type OpenVpcQuotaCalls = (session: VpcQuotaSession) => Promise<VpcQuotaCalls>;

/** Client configuration added to each service's client, such as a test endpoint. */
export interface SdkVpcQuotaConfig {
  readonly ec2?: Partial<EC2ClientConfig>;
  readonly serviceQuotas?: Partial<ServiceQuotasClientConfig>;
}

/**
 * The calls over AWS SDK for JavaScript v3. A selected profile is resolved from the shared
 * config and credentials files only, never by falling through to environment keys or
 * instance metadata; without one, the SDK's standard credential chain applies. The SDK is
 * imported on first use, so commands that never call AWS never load it.
 */
export function sdkVpcQuotaCalls(config: SdkVpcQuotaConfig = {}): OpenVpcQuotaCalls {
  return async ({ region, profile, abortSignal }) => {
    const [ec2, quotas] = await Promise.all([
      import("@aws-sdk/client-ec2"),
      import("@aws-sdk/client-service-quotas"),
    ]);
    const selected =
      profile === undefined
        ? {}
        : {
            profile,
            credentials: (await import("@aws-sdk/credential-provider-ini")).fromIni({ profile }),
          };
    const ec2Client = new ec2.EC2Client({ region, ...selected, ...config.ec2 });
    const quotaClient = new quotas.ServiceQuotasClient({
      region,
      ...selected,
      ...config.serviceQuotas,
    });
    const options = { abortSignal };
    return {
      getServiceQuota: (input) =>
        quotaClient.send(new quotas.GetServiceQuotaCommand(input), options),
      getAwsDefaultServiceQuota: (input) =>
        quotaClient.send(new quotas.GetAWSDefaultServiceQuotaCommand(input), options),
      describeVpcs: (NextToken) =>
        ec2Client.send(new ec2.DescribeVpcsCommand({ MaxResults: PAGE_SIZE, NextToken }), options),
      close: () => {
        ec2Client.destroy();
        quotaClient.destroy();
      },
    };
  };
}

/** A call's failure, labelled with the service that failed. */
class ServiceFailure {
  constructor(
    readonly service: "EC2" | "Service Quotas",
    readonly cause: unknown,
  ) {}
}

async function from<T>(service: ServiceFailure["service"], call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw new ServiceFailure(service, cause);
  }
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** The applied quota, or the AWS default when the account has no applied value. */
async function quotaValue(calls: VpcQuotaCalls): Promise<number | undefined> {
  try {
    return (await calls.getServiceQuota(VPCS_PER_REGION)).Quota?.Value;
  } catch (error) {
    if (errorName(error) !== "NoSuchResourceException") throw error;
    return (await calls.getAwsDefaultServiceQuota(VPCS_PER_REGION)).Quota?.Value;
  }
}

interface VpcCount {
  readonly used: number;
  readonly factoryVpc: boolean;
}

function isFactoryVpc(vpc: NonNullable<VpcPage["Vpcs"]>[number], factoryId: FactoryId): boolean {
  return (vpc.Tags ?? []).some(({ Key, Value }) => Key === FACTORY_ID_TAG && Value === factoryId);
}

/** Every VPC in the Region, page by page; stops paging once the session is aborted. */
async function countVpcs(
  calls: VpcQuotaCalls,
  signal: AbortSignal,
  factoryId: FactoryId,
): Promise<VpcCount> {
  let used = 0;
  let factoryVpc = false;
  let token: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await calls.describeVpcs(token);
    const vpcs = page.Vpcs ?? [];
    used += vpcs.length;
    factoryVpc ||= vpcs.some((vpc) => isFactoryVpc(vpc, factoryId));
    token = page.NextToken || undefined;
  } while (token !== undefined);
  return { used, factoryVpc };
}

function observed(limit: number | undefined, { used, factoryVpc }: VpcCount): VpcQuotaObservation {
  if (limit === undefined || !Number.isFinite(limit) || limit < 0)
    return { kind: "unusable", reason: "Service Quotas returned no value for VPCs per Region" };
  return { kind: "observed", limit, used, factoryVpc };
}

async function observe(
  open: OpenVpcQuotaCalls,
  session: VpcQuotaSession,
  factoryId: FactoryId,
): Promise<VpcQuotaObservation> {
  const calls = await open(session);
  try {
    const [limit, count] = await Promise.all([
      from("Service Quotas", () => quotaValue(calls)),
      from("EC2", () => countVpcs(calls, session.abortSignal, factoryId)),
    ]);
    return observed(limit, count);
  } finally {
    calls.close();
  }
}

type Unresolved = Exclude<VpcQuotaObservation, { readonly kind: "observed" }>;

const DENIED = new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation"]);
const CREDENTIAL_ERRORS = new Set(["CredentialsProviderError", "TokenProviderError"]);

interface ErrorShape {
  readonly name: string;
  readonly code?: unknown;
  readonly $fault?: unknown;
}

function timedOut(timeoutMs: number): Unresolved {
  return { kind: "unreachable", reason: `timed out after ${timeoutMs / 1000} s` };
}

/**
 * Interprets a failure by error name and code only. Messages are never echoed: they are
 * the SDK's or AWS's output, not something doctor derived. The account check has already
 * shown the credentials work, so a credential failure here is only unusable.
 */
function unresolved(failure: unknown, timeoutMs: number): Unresolved {
  const service = failure instanceof ServiceFailure ? failure.service : "AWS";
  const error = failure instanceof ServiceFailure ? failure.cause : failure;
  if (!(error instanceof Error)) return { kind: "unusable", reason: "unexpected error" };
  const { name, code, $fault } = error as ErrorShape;
  if (CREDENTIAL_ERRORS.has(name))
    return { kind: "unusable", reason: `the credential provider failed (${name})` };
  if (DENIED.has(name)) return { kind: "access_denied" };
  if ($fault !== undefined) return { kind: "unusable", reason: `${service} answered ${name}` };
  if (typeof code === "string" && NETWORK_CODES.has(code))
    return { kind: "unreachable", reason: `network error (${code})` };
  if (name === "TimeoutError") return timedOut(timeoutMs);
  return { kind: "unusable", reason: `unexpected ${name}` };
}

/**
 * VpcQuotaProbe over Service Quotas and EC2. At `timeoutMs` it aborts every call and
 * reports them as unreachable, whether credentials, the quota or a VPC page was pending.
 */
export function awsVpcQuotaProbe(
  open: OpenVpcQuotaCalls = sdkVpcQuotaCalls(),
  timeoutMs: number = VPC_QUOTA_TIMEOUT_MS,
): VpcQuotaProbe {
  return {
    async inspect(credentials, region, factoryId) {
      const controller = new AbortController();
      const profile = credentials.source === "chain" ? undefined : credentials.profile;
      const session = { region, profile, abortSignal: controller.signal };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<Unresolved>((resolve) => {
        timer = setTimeout(() => resolve(timedOut(timeoutMs)), timeoutMs);
      });
      try {
        return await Promise.race([
          observe(open, session, factoryId).catch((error) => unresolved(error, timeoutMs)),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
