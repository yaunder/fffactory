import type { AssetBundle } from "../application/asset-bundle";
import type { CacheDirectoryProbe } from "../application/cache-directory";
import type { CallerIdentity } from "../application/caller-identity";
import type { ControlPlane } from "../application/control-plane";
import type { WorkflowQueue } from "../application/workflow-queue";
import type { Interrupted } from "../application/factory-lock";
import type { HostTransport } from "../application/host-transport";
import type { InstanceStore } from "../application/instance-store";
import type { LockStore } from "../application/lock-store";
import type { MachineInventorySource } from "../application/machine-inventory";
import type { ManagedTerraformProbe } from "../application/managed-terraform";
import type { OperatorPrompt } from "../application/operator-prompt";
import type { PlanStore } from "../application/plan-store";
import type { Provisioner } from "../application/provisioner";
import type { SecretStore } from "../application/secret-store";
import type { TailnetPeers } from "../application/tailnet-peers";
import type { ToolProbe } from "../application/tool-probe";
import type { VpcQuotaProbe } from "../application/vpc-quota-probe";
import type { RandomBytes } from "../domain/initialization";
import type { Release } from "../domain/instance";
import type { ReleaseCompatibility } from "../domain/release-compatibility";
import type { WorkerEndpoint } from "../host/endpoint";

/** Everything a command may touch, injected so commands run the same in tests and the executable. */
export interface CliContext {
  readonly cwd: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly store: InstanceStore;
  readonly tools: ToolProbe;
  readonly cache: CacheDirectoryProbe;
  /** The running release's asset bundle. */
  readonly assets: AssetBundle;
  readonly identity: CallerIdentity;
  /** The managed Terraform in the cache, inspected read-only. */
  readonly terraform: ManagedTerraformProbe;
  /** The factory Region's VPC quota and VPCs, read only after an account match. */
  readonly vpcQuota: VpcQuotaProbe;
  /** The factory-wide lock, in the state bucket; reached only after an account match. */
  readonly lockStore: LockStore;
  /** Secrets Manager; written only after an account match. */
  readonly secrets: SecretStore;
  /** Managed Terraform, run only after an account match. */
  readonly provisioner: Provisioner;
  /** The factory's EC2 instances, listed only after an account match. */
  readonly machines: MachineInventorySource;
  /** The devices the local Tailscale client sees. */
  readonly tailnet: TailnetPeers;
  /** SSH to workers the hostname-match rule found. */
  readonly transport: HostTransport;
  /**
   * Paseo's control plane and the FFFlow/GitHub workflow queue on a worker, over the host
   * protocol. Apply's phase-3 stages run only when both are wired; `main.ts` always wires them.
   */
  readonly controlPlane?: ControlPlane;
  readonly workflowQueue?: WorkflowQueue;
  /** This machine as a worker: what the `fffactory host` subcommands do. */
  readonly worker: WorkerEndpoint;
  /** The operator's local plans, in the FFFactory cache. */
  readonly planStore: PlanStore;
  /** Whether fffactory has been interrupted; `cli/interrupts.ts` owns the signals. */
  readonly interrupted: Interrupted;
  /** The operator at the terminal, and standard input. */
  readonly prompt: OperatorPrompt;
  /** This machine's name, recorded with whoever holds or breaks the factory lock. */
  readonly hostname: string;
  readonly now: () => Date;
  /** Waits `ms`, or less once interrupted, as apply does while a new worker boots. */
  readonly sleep: (ms: number) => Promise<void>;
  /** The running CLI's release version. */
  readonly release: Release;
  /** What the running release declares: its factory.json schema version and base generation. */
  readonly compatibility: ReleaseCompatibility;
  readonly randomBytes: RandomBytes;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface Command {
  readonly summary: string;
  readonly usage: readonly string[];
  /** Returns the process exit code. */
  readonly run: (args: readonly string[], context: CliContext) => Promise<number>;
  /**
   * Set only by a command that checks `interrupted`, starts nothing more once it is set and
   * reports what the interrupt left: `fffactory` then waits for it to return, at most
   * `RETURN_GRACE_MS` (`cli/interrupts.ts`). Any other exits once its tools have stopped.
   */
  readonly waitsOnInterrupt?: true;
}
