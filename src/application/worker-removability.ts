/**
 * `fffactory worker inspect`: whether terminate would remove each worker without `--force`
 * (`docs/specs/worker-lifecycle.md` §Inspect), from terminate's own inspection
 * (`inspectForRemoval`) and gates (`removalGate`). Read-only: it takes no lock, writes no record
 * and changes nothing, so its answer can be stale by the time a terminate runs.
 */
import {
  type AccountExpectation,
  accountExpectation,
  type CredentialSelection,
} from "../domain/aws-account";
import {
  assessCompleteness,
  type FactoryInstance,
  type Host,
  parseRelease,
} from "../domain/instance";
import { placedRepositories } from "../domain/repository-placement";
import { hostName } from "../domain/resource-naming";
import type { WorkerIdentity } from "../domain/rollout";
import type { MachineInventory } from "../domain/status";
import { hostKeyRefusal, powerStep, type Refusal, selectMachine } from "../domain/worker-lifecycle";
import {
  inspectGateActions,
  type RemovalObservation,
  thenRerunInspect,
  type WorkerRemovability,
  workerRemovability,
} from "../domain/worker-removability";
import type { CallerIdentity } from "./caller-identity";
import type { MachineInventorySource } from "./machine-inventory";
import { type AccountRequirement, requireExpectedAccount } from "./require-expected-account";
import type { StatusTarget } from "./status";
import { inspectForRemoval, type RemovalInspectionDependencies } from "./worker-removal";

export interface RemovabilityDependencies extends RemovalInspectionDependencies {
  readonly identity: CallerIdentity;
  readonly machines: MachineInventorySource;
}

export interface RemovabilityRequest {
  readonly instance: FactoryInstance;
  /** The KEY argument as given, checked against factory.json's hosts; every host without one. */
  readonly key: string | undefined;
  readonly credentials: CredentialSelection;
}

export type Removability =
  /** KEY names no host factory.json declares. */
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | { readonly kind: "incomplete"; readonly missing: readonly string[] }
  | {
      readonly kind: "account_refused";
      readonly requirement: Extract<AccountRequirement, { readonly allowed: false }>;
      readonly expectation: AccountExpectation;
    }
  /** Interrupted: the workers were asked nothing more, and there is nothing to report. */
  | { readonly kind: "interrupted" }
  /**
   * Each worker inspected, in factory.json's order, with inspect's next action; `archiving`
   * when factory.json enables the log archive, for what its report says (`saysUnarchived`).
   */
  | {
      readonly kind: "inspected";
      readonly target: StatusTarget;
      readonly workers: readonly WorkerRemovability[];
      readonly archiving: boolean;
    };

/** What every worker's inspection shares: the factory, its tag and the EC2 inventory read once. */
interface Inspecting {
  readonly instance: FactoryInstance;
  readonly target: StatusTarget;
  readonly tag: string;
  readonly inventory: MachineInventory;
}

/**
 * What terminate would see of `host`: its machine first, by terminate's own rules (`selectMachine`,
 * `powerStep`), then, for a running one, terminate's own fresh inspection. Undefined once
 * interrupted.
 */
async function observe(
  deps: RemovabilityDependencies,
  inspecting: Inspecting,
  host: Host,
  worker: WorkerIdentity,
): Promise<RemovalObservation | undefined> {
  const { key } = worker;
  const then = thenRerunInspect(key);
  const selection = selectMachine(inspecting.inventory, key, "terminate", then);
  if (selection.kind === "refused") return { kind: "machine", refusal: selection.refusal };
  if (selection.kind === "absent") return { kind: "absent" };
  const step = powerStep("terminate", selection.machine, key, then);
  if (step.kind === "refused") return { kind: "machine", refusal: step.refusal };
  // Terminate only waits for a machine already being terminated: no gate runs for it.
  if (step.kind !== "act") return { kind: "shutting_down" };
  // Accepted risk, as for terminate: unpushed work on a stopped worker's disk goes unreported.
  if (selection.machine.state === "stopped") return { kind: "stopped" };
  const placed = placedRepositories(inspecting.instance.repositories ?? [], host);
  return inspectForRemoval(
    deps,
    {
      worker,
      tag: inspecting.tag,
      placed: placed.map(({ path }) => path),
    },
    then,
  );
}

async function inspectHost(
  deps: RemovabilityDependencies,
  inspecting: Inspecting,
  host: Host,
): Promise<WorkerRemovability | undefined> {
  const worker = { key: host.key, hostname: hostName(inspecting.target.factoryId, host.key) };
  const observed = await observe(deps, inspecting, host, worker);
  if (observed === undefined) return undefined;
  return workerRemovability(worker, observed, inspectGateActions(host.key));
}

/**
 * Checks KEY, completeness and the account, then reads the EC2 inventory once and inspects each
 * worker named, all at once, by terminate's own inspection and gates.
 */
export async function inspectRemovability(
  deps: RemovabilityDependencies,
  { instance, key, credentials }: RemovabilityRequest,
): Promise<Removability> {
  if (key !== undefined) {
    const refusal = hostKeyRefusal(key, instance);
    if (refusal !== undefined) return { kind: "refused", refusal };
  }
  const { missing } = assessCompleteness(instance);
  const { factory_id: factoryId, aws } = instance;
  const tag = instance.tailscale?.tag;
  const pinned = parseRelease(instance.release ?? "");
  if (missing.length > 0 || !factoryId || !aws?.account_id || !aws.region || !pinned.ok || !tag)
    return { kind: "incomplete", missing };
  const expectation = accountExpectation(instance);
  const requirement = await requireExpectedAccount(deps.identity, { expectation, credentials });
  if (!requirement.allowed) return { kind: "account_refused", requirement, expectation };
  if (deps.interrupted()) return { kind: "interrupted" };
  const target = {
    factoryId,
    accountId: aws.account_id,
    region: aws.region,
    release: pinned.value,
  };
  const inventory = await deps.machines.list(credentials, aws.region, factoryId);
  const hosts = (instance.hosts ?? []).filter((host) => key === undefined || host.key === key);
  const inspecting = { instance, target, tag, inventory };
  const workers = await Promise.all(hosts.map((host) => inspectHost(deps, inspecting, host)));
  if (deps.interrupted()) return { kind: "interrupted" };
  return {
    kind: "inspected",
    target,
    workers: workers.filter((worker) => worker !== undefined),
    archiving: instance.log_archive?.enabled === true,
  };
}
