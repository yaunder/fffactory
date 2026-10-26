/**
 * What removing a worker needs, shared by `worker terminate` (`worker-lifecycle.ts`) and
 * teardown (`teardown-factory.ts`), which removes every worker: the fresh inspection of a
 * running worker its gates judge (`removalGate`), the factory's Tailscale admin session, and
 * deleting tailnet devices. Each caller words its own refusals and records its own steps.
 */
import { workerActivity } from "../domain/control-plane";
import type { SecretMaterial } from "../domain/secrets";
import type { Then } from "../domain/status";
import { locateWorker } from "../domain/status";
import type { TailnetDevice } from "../domain/tailnet";
import type { WorkerIdentity } from "../domain/rollout";
import type { TerminateInspection } from "../domain/worker-lifecycle";
import type { ControlPlane } from "./control-plane";
import type { Interrupted } from "./factory-lock";
import type { HostTransport } from "./host-transport";
import { inspectRepositories } from "./inspect-repositories";
import { inspectWork } from "./inspect-work";
import type { SecretLookup, SecretStore } from "./secret-store";
import type { TailnetAdmin, TailnetAdminSession } from "./tailnet-admin";
import type { TailnetPeers } from "./tailnet-peers";

export interface RemovalInspectionDependencies {
  readonly peers: TailnetPeers;
  readonly transport: HostTransport;
  /** Reads the worker's agents; without one, a running worker cannot be inspected. */
  readonly controlPlane: ControlPlane | undefined;
  readonly interrupted: Interrupted;
}

/** The running worker to inspect, the factory's tag, and the checkouts factory.json places there. */
export interface RemovalTarget {
  readonly worker: WorkerIdentity;
  readonly tag: string;
  /** Relative to the repository root: the work inspection must report each. */
  readonly placed: readonly string[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The running worker's activity by the busy rule and its last repository result, then its current
 * work: only once the activity is read, since both go through the activator, which runs one
 * operation at a time, and only when the activity does not already refuse, which would leave the activator
 * held for nothing (`INSPECT_WORK_TIMEOUT_MS`). A worker the tailnet does not locate is
 * `unlocated`, its verdict's next action completed by `then`. Undefined once interrupted, which
 * asks the worker nothing more.
 */
export async function inspectForRemoval(
  deps: RemovalInspectionDependencies,
  target: RemovalTarget,
  then: Then,
): Promise<TerminateInspection | undefined> {
  const location = locateWorker(await deps.peers.view(), target.worker, target.tag, then);
  if (location.kind === "blocked") return { kind: "unlocated", verdict: location.verdict };
  const [agents, repositories] = await Promise.all([
    deps.controlPlane === undefined
      ? {
          kind: "unknown" as const,
          reason: "this fffactory cannot reach the worker's control plane",
        }
      : deps.controlPlane.agents(location.worker),
    inspectRepositories(deps.transport, location.worker),
  ]);
  if (deps.interrupted()) return undefined;
  const activity = workerActivity(agents);
  if (activity.kind !== "idle") return { kind: "activity", activity };
  const work = await inspectWork(deps.transport, location.worker);
  return { kind: "inspected", repositories, work, placed: target.placed };
}

export interface TailnetAdminDependencies {
  /** Reads the admin client's secret. */
  readonly secrets: SecretStore;
  readonly tailnetAdmin: TailnetAdmin;
  readonly interrupted: Interrupted;
}

/**
 * The factory's tailnet admin session, or why there is none: its secret could not be read
 * (`unreadable`), or Tailscale did not grant it a token (`unusable`), each `reason` in
 * fffactory's words. The session is undefined once interrupted after the read.
 */
export type TailnetAdminOpening =
  | { readonly kind: "open"; readonly session: TailnetAdminSession | undefined }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "unusable"; readonly reason: string };

/**
 * Opens the factory's tailnet admin session as its admin client (`tailscale.admin_client_secret`,
 * looked up by `lookup`). The client secret is read here, given to the admin client, and kept
 * nowhere.
 */
export async function openTailnetAdmin(
  deps: TailnetAdminDependencies,
  lookup: SecretLookup,
): Promise<TailnetAdminOpening> {
  let secret: SecretMaterial;
  try {
    secret = await deps.secrets.read(lookup);
  } catch (error) {
    return { kind: "unreadable", reason: reasonOf(error) };
  }
  if (deps.interrupted()) return { kind: "open", session: undefined };
  const opening = await deps.tailnetAdmin.open(secret);
  if (opening.kind === "failed") return { kind: "unusable", reason: opening.reason };
  return { kind: "open", session: opening.session };
}

/** The devices deleted, by ID, and those that could not be, with why. */
export interface DeviceDeletions {
  readonly removed: readonly string[];
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

/** Deletes `devices`, one at a time; stops at an interrupt, leaving the rest undeleted. */
export async function deleteDevices(
  admin: TailnetAdminSession,
  devices: readonly TailnetDevice[],
  interrupted: Interrupted,
): Promise<DeviceDeletions> {
  const removed: string[] = [];
  const failed: { readonly id: string; readonly reason: string }[] = [];
  for (const device of devices) {
    if (interrupted()) break;
    const deletion = await admin.remove(device.id);
    if (deletion.kind === "removed") removed.push(device.id);
    else failed.push({ id: device.id, reason: deletion.reason });
  }
  return { removed, failed };
}
