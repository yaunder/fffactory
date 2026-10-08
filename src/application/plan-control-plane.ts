import type { Host } from "../domain/instance";
import type { PlanTarget, PlannedControlPlane } from "../domain/plan";
import { hostProjectionSha256, projectHost, type Sha256 } from "../domain/host-projection";
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: every observation state fails closed in one exhaustive planner
export async function planControlPlane(
  deps: ControlPlanePlanDependencies,
  target: PlanTarget,
  tag: string,
  hosts: readonly Host[],
  assetsSha256: string,
  created: ReadonlySet<string> = new Set(),
): Promise<PlannedControlPlane[]> {
  let view: Awaited<ReturnType<TailnetPeers["view"]>> | undefined;
  const planned: PlannedControlPlane[] = [];
  for (const host of hosts) {
    const hostname = hostName(target.factoryId, host.key);
    const desiredConfiguration = hostProjectionSha256(
      projectHost(target.factoryId, target.release, host),
      deps.sha256,
    );
    if (created.has(host.key)) {
      planned.push({
        key: host.key,
        hostname,
        observation: "no-release",
        changes: [
          "paseo-package",
          "service-definition",
          "listen-address",
          ...(host.paseo_password_secret ? ["password" as const] : []),
        ],
      });
      continue;
    }
    view ??= await deps.peers.view();
    const location = locateWorker(view, hostname, tag);
    if (location.kind !== "found") {
      planned.push({
        key: host.key,
        hostname,
        observation: `unavailable:${location.kind}`,
        changes: [
          "paseo-package",
          "service-definition",
          "listen-address",
          ...(host.paseo_password_secret ? ["password" as const] : []),
        ],
      });
      continue;
    }
    const inspection = await inspectWorker(deps.transport, location.worker);
    if (inspection.kind === "no_release") {
      planned.push({
        key: host.key,
        hostname,
        observation: "no-release",
        changes: [
          "paseo-package",
          "service-definition",
          "listen-address",
          ...(host.paseo_password_secret ? ["password" as const] : []),
        ],
      });
      continue;
    }
    if (inspection.kind !== "inspected") {
      planned.push({
        key: host.key,
        hostname,
        observation: `unavailable:${inspection.kind}`,
        changes: [
          "paseo-package",
          "service-definition",
          "listen-address",
          ...(host.paseo_password_secret ? ["password" as const] : []),
        ],
      });
      continue;
    }
    const { release, configuration } = inspection.inspection;
    const releaseCurrent =
      release.state === "active" &&
      release.version === target.release &&
      release.sha256 === assetsSha256;
    const configurationCurrent =
      configuration.state === "present" && configuration.sha256 === desiredConfiguration;
    planned.push({
      key: host.key,
      hostname,
      observation: JSON.stringify({ release, configuration }),
      changes: [
        ...(releaseCurrent ? [] : (["paseo-package", "service-definition"] as const)),
        ...(configurationCurrent
          ? []
          : ([
              "listen-address",
              ...(host.paseo_password_secret ? ["password" as const] : []),
            ] as const)),
      ],
    });
  }
  return planned;
}
