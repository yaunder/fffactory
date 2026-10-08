import {
  AWS_ACCOUNT_CHECK,
  type AccountExpectation,
  accountExpectation,
  awsAccountCheck,
  type CredentialSelection,
} from "../domain/aws-account";
import { CACHE_DIRECTORY_CHECK, cacheDirectoryCheck } from "../domain/cache";
import {
  type Capability,
  type CheckIdentity,
  type CheckResult,
  capability,
  type DoctorReport,
  doctorReport,
  failed,
  notReady,
  ready,
  thenRerun,
} from "../domain/check-result";
import type { FactoryInstance, Release } from "../domain/instance";
import {
  OPENSSH_CHECK,
  OPENSSH_DIAGNOSIS,
  openSshCheck,
  TAILSCALE_CHECK,
  TAILSCALE_DIAGNOSIS,
  tailscaleCheck,
} from "../domain/local-tooling";
import {
  MANAGED_TERRAFORM_CHECK,
  managedTerraformCheck,
  SUPPORTED_TERRAFORM,
} from "../domain/managed-terraform";
import { RELEASE_ASSETS_CHECK, releaseAssetsCheck } from "../domain/release-assets";
import {
  VPC_QUOTA_CHECK,
  vpcQuotaCheck,
  vpcQuotaNotInspected,
  vpcQuotaTarget,
} from "../domain/vpc-quota";
import { type AssetBundle, releaseAssetsDirectory } from "./asset-bundle";
import type { CacheDirectoryProbe } from "./cache-directory";
import type { CallerIdentity } from "./caller-identity";
import type { InstanceStore } from "./instance-store";
import { type ManagedTerraformProbe, managedTerraformPaths } from "./managed-terraform";
import { requireExpectedAccount } from "./require-expected-account";
import {
  describeSource,
  INSTANCE_ENVIRONMENT_VARIABLE,
  type InstanceResolution,
  type InstanceSelection,
  resolveInstance,
} from "./resolve-instance";
import type { ToolProbe } from "./tool-probe";
import { type InstanceValidation, validateInstance } from "./validate-instance";
import type { VpcQuotaProbe } from "./vpc-quota-probe";

/** Everything doctor may use. Every capability is read-only. */
export interface DoctorDependencies {
  readonly store: InstanceStore;
  readonly tools: ToolProbe;
  readonly cache: CacheDirectoryProbe;
  readonly assets: AssetBundle;
  readonly identity: CallerIdentity;
  readonly terraform: ManagedTerraformProbe;
  readonly vpcQuota: VpcQuotaProbe;
}

export interface DoctorRequest {
  readonly selection: InstanceSelection;
  /** Absolute path of the FFFactory cache directory. */
  readonly cacheDirectory: string;
  /** The running CLI's release, whose materialized assets doctor inspects. */
  readonly release: Release;
  /** The operator's AWS credential selection. */
  readonly credentials: CredentialSelection;
}

/** The selected instance, resolved and validated once per run for every check that needs it. */
type LoadedInstance =
  | Extract<InstanceResolution, { readonly found: false }>
  | (Extract<InstanceResolution, { readonly found: true }> & {
      readonly validation: InstanceValidation;
    });

async function loadInstance(
  store: InstanceStore,
  selection: InstanceSelection,
): Promise<LoadedInstance> {
  const resolution = await resolveInstance(store, selection);
  if (!resolution.found) return resolution;
  return { ...resolution, validation: await validateInstance(store, resolution.path) };
}

/** What one capability's inspection may use. */
interface Inspecting {
  readonly dependencies: DoctorDependencies;
  readonly request: DoctorRequest;
  /** Rejects when the instance cannot be read; the `instance` check reports why. */
  readonly instance: Promise<LoadedInstance>;
}

/** Runs one check; an unexpected rejection becomes an `error` check, never a crash. */
async function guarded(
  identity: CheckIdentity,
  onError: string,
  inspect: () => Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    return await inspect();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failed(identity, `Could not inspect: ${reason}`, thenRerun(onError));
  }
}

async function localTooling({ dependencies: { tools } }: Inspecting): Promise<Capability> {
  const checks = await Promise.all([
    guarded(OPENSSH_CHECK, OPENSSH_DIAGNOSIS, async () => openSshCheck(await tools.openSsh())),
    guarded(TAILSCALE_CHECK, TAILSCALE_DIAGNOSIS, async () =>
      tailscaleCheck(await tools.tailscale()),
    ),
  ]);
  return capability({ id: "local_tooling", title: "Local tooling" }, checks);
}

const INSTANCE_CHECK = { id: "instance", title: "factory.json" } as const;
const VALIDATE_THEN_RERUN = "check the result with `fffactory validate`";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function instanceCheck(loaded: LoadedInstance): CheckResult {
  if (!loaded.found && loaded.path !== undefined) {
    const action = `Select an existing factory.json, or create this one with \`fffactory init ${loaded.path}\``;
    return notReady(INSTANCE_CHECK, loaded.message, thenRerun(action));
  }
  if (!loaded.found) {
    const action =
      "Run `fffactory init` to create ./.fffactory/factory.json, or select an existing one " +
      `with --instance PATH or ${INSTANCE_ENVIRONMENT_VARIABLE}`;
    return notReady(INSTANCE_CHECK, "No factory instance found", thenRerun(action));
  }
  const named = `${loaded.path} (${describeSource(loaded.source)})`;
  const result = loaded.validation;
  if (!result.valid) {
    const issues = result.issues.map((issue) => `${issue.path}: ${issue.message}`);
    const action = `Fix each issue listed, ${VALIDATE_THEN_RERUN}`;
    return notReady(INSTANCE_CHECK, `${named} is invalid`, thenRerun(action), issues);
  }
  const { missing } = result.completeness;
  if (missing.length === 0) return ready(INSTANCE_CHECK, `${named} is valid and complete`);
  const summary = `${named} is missing ${plural(missing.length, "field")}`;
  const action = `Fill in each field listed, ${VALIDATE_THEN_RERUN}`;
  return notReady(INSTANCE_CHECK, summary, thenRerun(action), missing);
}

async function configuration({ instance }: Inspecting): Promise<Capability> {
  const check = await guarded(INSTANCE_CHECK, "Make sure the instance file can be read", async () =>
    instanceCheck(await instance),
  );
  return capability({ id: "configuration", title: "Configuration" }, [check]);
}

/** The selected instance when it was loaded and is valid; the `instance` check reports why not. */
async function validInstanceOf(
  instance: Promise<LoadedInstance>,
): Promise<FactoryInstance | undefined> {
  try {
    const loaded = await instance;
    return loaded.found && loaded.validation.valid ? loaded.validation.instance : undefined;
  } catch {
    return undefined;
  }
}

/** The expected account and Region; `unavailable` unless a valid instance was loaded. */
function expectationOf(valid: FactoryInstance | undefined): AccountExpectation {
  return valid === undefined ? { kind: "unavailable" } : accountExpectation(valid);
}

/**
 * The `vpc_quota` check. It asks AWS only once the account check has matched, so doctor
 * never reads another account's VPCs, and only for a factory ID and Region to look for.
 */
async function vpcQuota(
  probe: VpcQuotaProbe,
  credentials: CredentialSelection,
  valid: FactoryInstance | undefined,
  allowed: Promise<boolean>,
): Promise<CheckResult> {
  if (valid === undefined || !(await allowed)) return vpcQuotaNotInspected({ kind: "account" });
  const target = vpcQuotaTarget(valid);
  if (target.kind === "missing") return vpcQuotaNotInspected(target);
  const { region, factoryId } = target;
  return vpcQuotaCheck(await probe.inspect(credentials, region, factoryId), {
    region,
    credentials,
  });
}

async function aws({ dependencies, request, instance }: Inspecting): Promise<Capability> {
  const valid = await validInstanceOf(instance);
  const expectation = expectationOf(valid);
  const { credentials } = request;
  const requirement = requireExpectedAccount(dependencies.identity, { expectation, credentials });
  // A failed account check is reported by that check; the quota check only waits for it.
  const allowed = requirement.then(
    ({ allowed }) => allowed,
    () => false,
  );
  const account = await guarded(
    AWS_ACCOUNT_CHECK,
    "Run `aws sts get-caller-identity` to see whether the AWS credentials work",
    async () => awsAccountCheck((await requirement).verdict, { expectation, credentials }),
  );
  const quota = await guarded(
    VPC_QUOTA_CHECK,
    "Run `aws ec2 describe-vpcs` in the factory Region to see whether it can be read",
    () => vpcQuota(dependencies.vpcQuota, credentials, valid, allowed),
  );
  return capability({ id: "aws", title: "AWS" }, [account, quota]);
}

async function cache({
  dependencies: { cache, assets, terraform },
  request: { cacheDirectory, release },
}: Inspecting): Promise<Capability> {
  const assetsDirectory = releaseAssetsDirectory(cacheDirectory, release);
  const { version } = SUPPORTED_TERRAFORM;
  const terraformPaths = managedTerraformPaths(cacheDirectory, version);
  const checks = await Promise.all([
    guarded(CACHE_DIRECTORY_CHECK, `Check that ${cacheDirectory} can be inspected`, async () =>
      cacheDirectoryCheck(cacheDirectory, await cache.inspect(cacheDirectory)),
    ),
    guarded(RELEASE_ASSETS_CHECK, `Check that ${assetsDirectory} can be read`, async () =>
      releaseAssetsCheck(assetsDirectory, release, await assets.inspect(assetsDirectory)),
    ),
    guarded(MANAGED_TERRAFORM_CHECK, `Check that ${terraformPaths.root} can be read`, async () =>
      managedTerraformCheck(
        terraformPaths.executable,
        version,
        await terraform.inspect(cacheDirectory),
      ),
    ),
  ]);
  return capability({ id: "cache", title: "Cache" }, checks);
}

/** One capability's inspection. Adding a capability means adding one to `CAPABILITIES`. */
type Inspection = (inspecting: Inspecting) => Promise<Capability>;

/** Report order. */
const CAPABILITIES: readonly Inspection[] = [localTooling, configuration, aws, cache];

/**
 * Read-only readiness report for this workstation and the selected instance, grouped by
 * capability. Every check runs; a failed inspection is reported, not thrown.
 */
export async function doctor(
  dependencies: DoctorDependencies,
  request: DoctorRequest,
): Promise<DoctorReport> {
  const instance = loadInstance(dependencies.store, request.selection);
  const capabilities = await Promise.all(
    CAPABILITIES.map((inspect) => inspect({ dependencies, request, instance })),
  );
  return doctorReport(capabilities);
}
