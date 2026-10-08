/**
 * `fffactory status`: every declared host as the factory's EC2 instances, the operator's
 * tailnet view and the worker's own inspection show it now. Read-only: it takes no lock,
 * writes nothing and stores no result, so an unreachable worker's release is unknown.
 */
import type { AccountExpectation, CredentialSelection } from "../domain/aws-account";
import { accountExpectation } from "../domain/aws-account";
import { hostProjectionSha256, projectHost, type Sha256 } from "../domain/host-projection";
import {
  assessCompleteness,
  type FactoryId,
  type FactoryInstance,
  type Host,
  parseRelease,
  type Release,
} from "../domain/instance";
import { hostName } from "../domain/resource-naming";
import {
  ec2InventoryCheck,
  inspectionVerdict,
  locateWorker,
  type MachineInventory,
  machineFacts,
  machineVerdict,
  type StatusReport,
  statusReport,
  tailnetCheck,
  type WorkerStatus,
} from "../domain/status";
import type { PeerView } from "../domain/tailnet";
import type { CallerIdentity } from "./caller-identity";
import type { HostTransport } from "./host-transport";
import { inspectWorker } from "./inspect-worker";
import { inspectRepositories, type RepositoryObservation } from "./inspect-repositories";
import { inspectDispatch } from "./inspect-dispatch";
import type { DispatchInspection } from "../domain/dispatch-projection";
import type { MachineInventorySource } from "./machine-inventory";
import { type AccountRequirement, requireExpectedAccount } from "./require-expected-account";
import type { TailnetPeers } from "./tailnet-peers";

export interface StatusDependencies {
  readonly identity: CallerIdentity;
  readonly machines: MachineInventorySource;
  readonly peers: TailnetPeers;
  readonly transport: HostTransport;
  /** Digests the host projection each worker should hold. */
  readonly sha256: Sha256;
}

export interface StatusRequest {
  readonly instance: FactoryInstance;
  readonly credentials: CredentialSelection;
}

/** The factory the report is about. */
export interface StatusTarget {
  readonly factoryId: FactoryId;
  readonly accountId: string;
  readonly region: string;
  /** The release factory.json pins. */
  readonly release: Release;
}

export type StatusOutcome =
  /** factory.json cannot be inspected until these fields are set. */
  | { readonly kind: "incomplete"; readonly missing: readonly string[] }
  | {
      readonly kind: "account_refused";
      readonly requirement: Extract<AccountRequirement, { readonly allowed: false }>;
      readonly expectation: AccountExpectation;
    }
  | { readonly kind: "report"; readonly target: StatusTarget; readonly report: StatusReport };

interface Observed {
  readonly inventory: MachineInventory;
  readonly view: PeerView;
  /** factory.json's `tailscale.tag`, which the worker's device must carry. */
  readonly tag: string;
}

async function workerStatus(
  { transport, sha256 }: Pick<StatusDependencies, "transport" | "sha256">,
  target: StatusTarget,
  observed: Observed,
  host: Host,
): Promise<WorkerStatus> {
  const hostname = hostName(target.factoryId, host.key);
  const identity = { key: host.key, hostname };
  const machine = machineFacts(observed.inventory, host.key);
  const facts = { machine: machine.machine, instanceId: machine.instanceId };
  const unknown = {
    release: "unknown",
    configuration: "unknown",
    installation: "unknown",
    enrollment: null,
    repositories: "unknown" as const,
    unmanagedRepositories: null,
    dispatch: "unknown" as const,
    dispatchBlockers: null,
  };
  const blocked = machineVerdict(machine);
  if (blocked) return { ...identity, ...facts, tailnet: "not_checked", ...unknown, ...blocked };
  const location = locateWorker(observed.view, hostname, observed.tag);
  if (location.kind === "blocked")
    return { ...identity, ...facts, ...unknown, tailnet: location.tailnet, ...location.verdict };
  const inspection = await inspectWorker(transport, location.worker);
  const { verdict, ...inspected } = inspectionVerdict(inspection, {
    hostname,
    release: target.release,
    configurationSha256: hostProjectionSha256(
      projectHost(target.factoryId, target.release, host),
      sha256,
    ),
  });
  if (inspection.kind !== "inspected" || inspection.inspection.release.state !== "active")
    return {
      ...identity,
      ...facts,
      tailnet: "online",
      ...inspected,
      repositories: "unknown",
      unmanagedRepositories: null,
      dispatch: "unknown",
      dispatchBlockers: null,
      ...verdict,
    };
  const [repository, dispatch] = await Promise.all([
    inspectRepositories(transport, location.worker),
    inspectDispatch(transport, location.worker),
  ]);
  const repositoryFacts = {
    repositories: repository.state,
    unmanagedRepositories:
      repository.state === "synchronized" || repository.state === "unresolved"
        ? repository.unmanaged
        : null,
  } as const;
  const repositoryVerdict = assessRepositories(repository, verdict);
  const dispatchVerdict = assessDispatch(
    dispatch,
    host.dispatch?.enabled === true,
    repositoryVerdict,
  );
  return {
    ...identity,
    ...facts,
    tailnet: "online",
    ...inspected,
    ...repositoryFacts,
    dispatch: dispatch.state,
    dispatchBlockers: "blockers" in dispatch ? dispatch.blockers : null,
    ...dispatchVerdict,
  };
}

function assessDispatch(
  dispatch: DispatchInspection,
  requested: boolean,
  base: Pick<WorkerStatus, "status" | "summary" | "details" | "nextAction">,
): Pick<WorkerStatus, "status" | "summary" | "details" | "nextAction"> {
  const blockerDetails =
    "blockers" in dispatch ? dispatch.blockers.map((gate) => `Dispatch blocker: ${gate}`) : [];
  if (base.status !== "ready") return { ...base, details: [...base.details, ...blockerDetails] };
  if (!requested && dispatch.state === "not_requested") return base;
  if (requested && dispatch.state === "active") return base;
  if (dispatch.state === "pending")
    return {
      status: "not_ready",
      summary: "Dispatch is pending",
      details: blockerDetails,
      nextAction: "Resolve the dispatch blockers, then rerun `fffactory apply`.",
    };
  if (dispatch.state === "none")
    return {
      status: "not_ready",
      summary: "Dispatch has not been reconciled",
      details: [],
      nextAction: "Reconcile dispatch with `fffactory apply`, then rerun `fffactory status`.",
    };
  return {
    status: "error",
    summary:
      dispatch.state === "active" || dispatch.state === "not_requested"
        ? "Dispatch does not match factory.json"
        : "Dispatch state could not be verified",
    details: blockerDetails,
    nextAction: "Repair dispatch with `fffactory apply`, then rerun `fffactory status`.",
  };
}

function assessRepositories(
  repositories: RepositoryObservation,
  base: Pick<WorkerStatus, "status" | "summary" | "details" | "nextAction">,
): Pick<WorkerStatus, "status" | "summary" | "details" | "nextAction"> {
  const unmanaged =
    repositories.state === "synchronized" || repositories.state === "unresolved"
      ? repositories.unmanaged.map((path) => `Unmanaged repository: ${path}`)
      : [];
  if (base.status !== "ready") return { ...base, details: [...base.details, ...unmanaged] };
  switch (repositories.state) {
    case "synchronized":
      return { ...base, details: [...base.details, ...unmanaged] };
    case "unresolved":
      return {
        status: "not_ready",
        summary: "One or more placed repositories are unresolved",
        details: unmanaged,
        nextAction: "Resolve the reported checkouts, then rerun `fffactory apply`.",
      };
    case "none":
      return {
        status: "not_ready",
        summary: "Repositories have not been synchronized",
        details: [],
        nextAction: "Synchronize them with `fffactory apply`, then rerun `fffactory status`.",
      };
    case "unreadable":
    case "unknown":
      return {
        status: "error",
        summary: "The worker's repository result could not be read",
        details: [],
        nextAction: "Repair the worker with `fffactory apply`, then rerun `fffactory status`.",
      };
  }
}

/**
 * Checks the account first, even though status changes nothing, then reads the EC2
 * inventory and the tailnet view once and inspects every reachable worker at once.
 */
export async function factoryStatus(
  deps: StatusDependencies,
  { instance, credentials }: StatusRequest,
): Promise<StatusOutcome> {
  const { missing } = assessCompleteness(instance);
  const { factory_id: factoryId, aws } = instance;
  const tag = instance.tailscale?.tag;
  const pinned = parseRelease(instance.release ?? "");
  if (missing.length > 0 || !factoryId || !aws?.account_id || !aws.region || !pinned.ok || !tag)
    return { kind: "incomplete", missing };
  const release = pinned.value;
  const expectation = accountExpectation(instance);
  const requirement = await requireExpectedAccount(deps.identity, { expectation, credentials });
  if (!requirement.allowed) return { kind: "account_refused", requirement, expectation };
  const target = { factoryId, accountId: aws.account_id, region: aws.region, release };
  const [inventory, view] = await Promise.all([
    deps.machines.list(credentials, aws.region, factoryId),
    deps.peers.view(),
  ]);
  const workers = await Promise.all(
    (instance.hosts ?? []).map((host) =>
      workerStatus(deps, target, { inventory, view, tag }, host),
    ),
  );
  return {
    kind: "report",
    target,
    report: statusReport([ec2InventoryCheck(inventory), tailnetCheck(view)], workers),
  };
}
