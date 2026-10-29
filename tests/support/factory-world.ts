/**
 * A factory to plan and apply in application tests: a complete factory.json declaring the
 * given hosts, the account check's allowed verdict, and the in-memory state bucket,
 * Terraform world and plan store behind the use cases' ports. Its workers digest projections
 * for real, as the CLI does, so a worker reports exactly the drift a real one would.
 */
import type { FactoryPlanRequest } from "../../src/application/plan-factory";
import type { AllowedAccount } from "../../src/application/require-expected-account";
import type {
  FactoryId,
  FactoryInstance,
  HostKey,
  Release,
  SecretReference,
} from "../../src/domain/instance";
import type { WorkerProgress } from "../../src/application/apply-workers";
import type { HostInspection } from "../../src/domain/host-protocol";
import { FAKE_CALLER, FAKE_WORKER_RELEASE } from "./doctor-fakes";
import { fakeFactoryWorld } from "./fake-provisioner";
import { MemoryLockStore } from "./memory-lock-store";
import { MemoryPlanStore } from "./memory-plan-store";
import {
  type Answer,
  appliedRecord,
  fakeTailnet,
  fakeTransport,
  installableWorker,
  peer,
  peers,
  readyWorker,
} from "./fake-workers";
import type { PeerView } from "../../src/domain/tailnet";
import type { MachineInventory } from "../../src/domain/status";
import type { MachineInventorySource } from "../../src/application/machine-inventory";
import { sha256Text } from "../../src/infrastructure/release-tarball";

export const BUCKET = "fff-abcd1234-state";
export const FACTORY = "fff-abcd1234" as FactoryId;
/** The log archive's bucket `archiving` derives (`archiveBucketName`). */
export const ARCHIVE = "fff-abcd1234-logs-123456789012-eu-west-2-an";
/** The release `planRequest` runs, and the digest of its assets. */
export const RELEASE = "0.3.0" as Release;
export const ASSETS_SHA256 = "b".repeat(64);
const ARN =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/tailscale-auth-key-AbCdEf";

/** Host `key`'s Paseo password reference: an ARN in the test account, never a value. */
export function paseoPasswordArn(key: string): SecretReference {
  return `arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/${key}/paseo-password-AbCdEf` as SecretReference;
}

/** builder-1's Paseo password reference. */
export const PASEO_PASSWORD_ARN = paseoPasswordArn("builder-1");

/** A declared host: its key, and the Paseo password reference it carries, by default its own. */
export type DeclaredHost =
  | string
  | { readonly key: string; readonly paseo_password_secret?: SecretReference };

/**
 * A complete factory.json declaring `hosts`, each a key or a key with its password reference.
 * Every host has one, as completeness requires.
 */
export function declaring(...hosts: DeclaredHost[]): FactoryInstance {
  return {
    schema_version: 1,
    release: RELEASE,
    factory_id: FACTORY,
    name: "Test factory",
    aws: { account_id: "123456789012", region: "eu-west-2" },
    state_backend: { bucket: BUCKET },
    network: {
      vpc_cidr: "10.42.0.0/16",
      public_subnet_cidr: "10.42.1.0/24",
      availability_zone: "eu-west-2a",
    },
    tailscale: { tag: "tag:factory", auth_key_secret: ARN as never },
    hosts: hosts.map((host) => {
      const { key, paseo_password_secret = paseoPasswordArn(key) } =
        typeof host === "string" ? { key: host } : host;
      return {
        key: key as HostKey,
        instance_type: "t3.large",
        root_volume_gib: 64,
        paseo_password_secret,
      };
    }),
  };
}

/** `declaring(...hosts)` with the log archive enabled, named `ARCHIVE`. */
export function archiving(...hosts: DeclaredHost[]): FactoryInstance {
  return { ...declaring(...hosts), log_archive: { enabled: true } };
}

/** `declaring(key)` with one repository placed on the host and dispatch requested on it. */
export function requestingDispatch(key = "builder-1"): FactoryInstance {
  const base = declaring(key);
  return {
    ...base,
    repositories: [
      {
        key: "product",
        remote: "https://github.com/yaunder/product",
        path: "product",
        branch: "main",
      },
    ],
    hosts: (base.hosts ?? []).map((host) => ({
      ...host,
      repositories: ["product"],
      dispatch: {
        enabled: true,
        cron: "*/15 * * * *",
        timezone: "UTC",
        provider: "claude",
        model: "configured-model",
        mode: "default",
        cwd: "/home/factory",
      },
    })),
  };
}

export const ACCOUNT: AllowedAccount = {
  allowed: true,
  verdict: { kind: "match", caller: FAKE_CALLER },
};
export const NOW = new Date("2026-09-30T12:00:00.000Z");
export const TERRAFORM = "/cache/releases/0.3.0/terraform";

export function planRequest(overrides: Partial<FactoryPlanRequest> = {}): FactoryPlanRequest {
  return {
    account: ACCOUNT,
    instancePath: "/work/.fffactory/factory.json",
    instance: declaring("builder-1"),
    configurationSha256: "a".repeat(64),
    credentials: { source: "--profile", profile: "factory" },
    release: RELEASE,
    assetsSha256: ASSETS_SHA256,
    terraformDirectory: TERRAFORM,
    now: NOW,
    randomBytes: (count) => new Uint8Array(count),
    ...overrides,
  };
}

/** The tag `declaring` gives the factory's workers. */
export const WORKER_TAG = "tag:factory";

/**
 * The factory's workers, in the tailnet and installing whatever release they are given: each
 * of `keys` answers the upload and the activator as a worker whose install and verification
 * succeed, unless `script` answers for it. `view` replaces the tailnet's view, read by read,
 * as when a new worker joins it during apply's wait; `sleeps` records each wait, after which
 * `afterSleep` runs. The EC2 inventory lists `machines.inventory`, no machine until a test sets
 * one, and counts each listing in `machines.reads`.
 */
export function workerFleet(
  keys: readonly string[] = ["builder-1", "builder-2", "b"],
  script: Record<string, Answer> = {},
  view?: (read: number) => PeerView,
) {
  const hostnames = keys.map((key) => `${FACTORY}-${key}`);
  const tailnet = fakeTailnet(
    view ?? peers(...hostnames.map((name) => peer(name, { tags: [WORKER_TAG] }))),
  );
  const transport = fakeTransport({
    ...Object.fromEntries(hostnames.map((name) => [name, installableWorker(appliedRecord(name))])),
    ...script,
  });
  const progress: WorkerProgress[] = [];
  const sleeps: number[] = [];
  const fleet = {
    afterSleep: (_slept: number) => {},
  };
  const machines = {
    inventory: { kind: "machines", machines: [] } as MachineInventory,
    reads: 0,
  };
  const inventory: MachineInventorySource = {
    list: async () => {
      machines.reads += 1;
      return machines.inventory;
    },
    // No stage lists the factory's VPCs.
    listVpcs: async () => ({ kind: "vpcs", vpcIds: [] }),
  };
  const deps = {
    machines: inventory,
    peers: tailnet.tailnet,
    transport: transport.transport,
    assets: { workerRelease: async () => FAKE_WORKER_RELEASE },
    progress: (event: WorkerProgress) => {
      progress.push(event);
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      fleet.afterSleep(sleeps.length);
    },
    // The CLI's real digest, so a worker reports drift exactly as it would on a real one.
    sha256: sha256Text,
  };
  return { deps, tailnet, transport, progress, sleeps, fleet, machines };
}

/**
 * The inspection of `key`'s worker, ready on the release `planRequest` runs and holding the host
 * projection `declaring` gives it, its own Paseo password reference included: a worker the plan
 * finds current. Hold another reference, or none (`null`), to model drift.
 */
export function currentWorker(
  key: string,
  paseoPasswordSecret: SecretReference | null = paseoPasswordArn(key),
): HostInspection {
  const ready = readyWorker(FACTORY, key, RELEASE, paseoPasswordSecret ?? undefined);
  return { ...ready, release: { state: "active", version: RELEASE, sha256: ASSETS_SHA256 } };
}

/** The tailnet view in which `keys`' workers are online, carrying the factory's tag. */
export function fleetView(...keys: string[]): PeerView {
  return peers(...keys.map((key) => peer(`${FACTORY}-${key}`, { tags: [WORKER_TAG] })));
}

/** A factory whose state bucket exists (unless `bucket` is false), with `hosts` provisioned. */
export function factory(
  options: { bucket?: boolean; hosts?: string[]; workers?: ReturnType<typeof workerFleet> } = {},
) {
  const lockStore = new MemoryLockStore(options.bucket === false ? [] : [BUCKET]);
  const terraform = fakeFactoryWorld({ store: lockStore, bucket: BUCKET, hosts: options.hosts });
  if ((options.hosts ?? []).length > 0) lockStore.states.set(BUCKET, "revision-0");
  const planStore = new MemoryPlanStore();
  const fleet = options.workers ?? workerFleet();
  const deps = { lockStore, provisioner: terraform.provisioner, planStore, ...fleet.deps };
  return { lockStore, terraform, planStore, fleet, deps };
}
