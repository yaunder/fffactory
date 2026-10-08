import type { InstanceStore } from "../../src/application/instance-store";
import type { CliContext } from "../../src/cli/run";
import type { RandomBytes } from "../../src/domain/initialization";
import type { Release } from "../../src/domain/instance";
import { RELEASE_COMPATIBILITY } from "../../src/domain/release-compatibility";
import {
  fakeAssetBundle,
  fakeCacheDirectory,
  fakeCallerIdentity,
  fakeManagedTerraform,
  fakeToolProbe,
  fakeVpcQuotaProbe,
} from "./doctor-fakes";
import { fakeProvisioner } from "./fake-provisioner";
import { fakePrompt, fakeSecretStore } from "./fake-secrets";
import {
  fakeMachineInventory,
  fakeTailnet,
  fakeTransport,
  fakeWorker,
  inspection,
} from "./fake-workers";
import { MemoryLockStore } from "./memory-lock-store";
import { MemoryPlanStore } from "./memory-plan-store";

export const CWD = "/work/repo";
export const TEST_RELEASE = "0.3.0" as Release;
export const TEST_HOSTNAME = "operator-laptop";
export const TEST_NOW = new Date("2026-09-30T12:00:00.000Z");
/** All-zero bytes, so a generated factory ID is always `fff-aaaaaaaa`. */
export const zeroBytes: RandomBytes = (count) => new Uint8Array(count);

/**
 * An in-process CLI context over `store` that captures standard output and error. Tools,
 * the cache directory, the asset bundle, the AWS caller, the VPC quota, managed Terraform,
 * the lock store, Secrets Manager, the prompt, Terraform, the plan store, the EC2 inventory,
 * the tailnet, SSH and this machine as a worker are fakes unless overridden, and nothing is interrupted; the clock is fixed and sleeping returns at once. Nothing touches the host or AWS.
 */
export function harness(
  store: InstanceStore,
  env: Record<string, string> = {},
  overrides: Partial<
    Pick<
      CliContext,
      | "tools"
      | "cache"
      | "assets"
      | "identity"
      | "terraform"
      | "vpcQuota"
      | "lockStore"
      | "secrets"
      | "prompt"
      | "provisioner"
      | "planStore"
      | "machines"
      | "tailnet"
      | "transport"
      | "controlPlane"
      | "workflowQueue"
      | "worker"
      | "interrupted"
      | "now"
      | "sleep"
      | "compatibility"
    >
  > = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = {
    cwd: CWD,
    home: "/home/operator",
    env,
    store,
    tools: fakeToolProbe(),
    cache: fakeCacheDirectory().probe,
    assets: fakeAssetBundle().bundle,
    identity: fakeCallerIdentity().identity,
    terraform: fakeManagedTerraform().probe,
    vpcQuota: fakeVpcQuotaProbe().probe,
    lockStore: new MemoryLockStore(),
    secrets: fakeSecretStore().store,
    prompt: fakePrompt().prompt,
    provisioner: fakeProvisioner().provisioner,
    planStore: new MemoryPlanStore(),
    machines: fakeMachineInventory().machines,
    tailnet: fakeTailnet().tailnet,
    transport: fakeTransport().transport,
    worker: fakeWorker(inspection("fff-aaaaaaaa-builder-1")),
    interrupted: () => false,
    hostname: TEST_HOSTNAME,
    now: () => TEST_NOW,
    sleep: async () => {},
    release: TEST_RELEASE,
    compatibility: RELEASE_COMPATIBILITY,
    randomBytes: zeroBytes,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...overrides,
  };
  return { context, out, err };
}
