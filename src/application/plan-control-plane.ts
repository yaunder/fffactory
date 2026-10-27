import type { FactoryInstance } from "../domain/instance";
import type { ChangeType } from "../domain/change-classification";
import type { PlanTarget, PlannedControlPlane } from "../domain/plan";
import {
  controlPlaneProjection,
  hostProjectionSha256,
  projectHost,
  type Sha256,
} from "../domain/host-projection";
import type { ConfigurationState } from "../domain/host-protocol";
import { hostName } from "../domain/resource-naming";
import { locateWorker } from "../domain/status";
import type { HostTransport } from "./host-transport";
import type { TailnetPeers } from "./tailnet-peers";
import { inspectWorker } from "./inspect-worker";

export interface ControlPlanePlanDependencies {
  readonly peers: TailnetPeers;
  readonly transport: HostTransport;
  readonly sha256: Sha256;
}

/**
 * The factory-owned Paseo settings a projection mismatch changes. Every host has a Paseo password
 * reference: a host without one is incomplete, and `checkPlannable` refuses it before any plan.
 */
const CONFIGURATION_CHANGES = [
  "listen-address",
  "password",
] as const satisfies readonly ChangeType[];
/** What a worker with no active release, or one that cannot be inspected, needs. */
const EVERY_CHANGE = [
  "paseo-package",
  "service-definition",
  ...CONFIGURATION_CHANGES,
] as const satisfies readonly ChangeType[];

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: every observation state fails closed in one exhaustive planner
export async function planControlPlane(
  deps: ControlPlanePlanDependencies,
  target: PlanTarget,
  tag: string,
  instance: FactoryInstance,
  assetsSha256: string,
  created: ReadonlySet<string> = new Set(),
  stopped: ReadonlySet<string> = new Set(),
): Promise<PlannedControlPlane[]> {
  let view: Awaited<ReturnType<TailnetPeers["view"]>> | undefined;
  const planned: PlannedControlPlane[] = [];
  for (const host of instance.hosts ?? []) {
    const hostname = hostName(target.factoryId, host.key);
    // A stopped worker is sent nothing, not even an inspection: apply skips it.
    if (stopped.has(host.key)) {
      planned.push({ key: host.key, hostname, observation: "stopped", changes: [] });
      continue;
    }
    // Only the control plane's part: a credential reference is no Paseo change (D3).
    const desiredConfiguration = hostProjectionSha256(
      controlPlaneProjection(projectHost(instance, target.factoryId, target.release, host)),
      deps.sha256,
    );
    if (created.has(host.key)) {
      planned.push({
        key: host.key,
        hostname,
        observation: "no-release",
        changes: EVERY_CHANGE,
      });
      continue;
    }
    view ??= await deps.peers.view();
    const location = locateWorker(view, { key: host.key, hostname }, tag);
    if (location.kind !== "found") {
      planned.push({
        key: host.key,
        hostname,
        observation: `unavailable:${location.kind}`,
        changes: EVERY_CHANGE,
      });
      continue;
    }
    const inspection = await inspectWorker(deps.transport, location.worker);
    if (inspection.kind === "no_release") {
      planned.push({
        key: host.key,
        hostname,
        observation: "no-release",
        changes: EVERY_CHANGE,
      });
      continue;
    }
    if (inspection.kind !== "inspected") {
      planned.push({
        key: host.key,
        hostname,
        observation: `unavailable:${inspection.kind}`,
        changes: EVERY_CHANGE,
      });
      continue;
    }
    const { release, configuration } = inspection.inspection;
    const releaseCurrent =
      release.state === "active" &&
      release.version === target.release &&
      release.sha256 === assetsSha256;
    const configurationCurrent = controlPlaneSha256(configuration) === desiredConfiguration;
    planned.push({
      key: host.key,
      hostname,
      observation: JSON.stringify({ release, configuration }),
      changes: [
        ...(releaseCurrent ? [] : (["paseo-package", "service-definition"] as const)),
        ...(configurationCurrent ? [] : CONFIGURATION_CHANGES),
      ],
    });
  }
  return planned;
}

/**
 * The digest of the control plane's part of the worker's configuration. A worker from before
 * credential references reports none: its whole configuration is that part.
 */
function controlPlaneSha256(configuration: ConfigurationState): string | undefined {
  if (configuration.state !== "present") return undefined;
  return configuration.control_plane_sha256 ?? configuration.sha256;
}
