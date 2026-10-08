import type { WorkerAddress } from "../domain/tailnet";
import type { AgentActivity, ControlPlaneAction } from "../domain/control-plane";
import type { HostProjection } from "../domain/host-projection";

export type { AgentActivity, ControlPlaneAction } from "../domain/control-plane";

/**
 * Port: the worker's Paseo control plane, driven over the host protocol (`infrastructure/
 * paseo-control-plane.ts`). Apply reads health and agent activity to decide what a plan's
 * changes may do, then reloads or restarts the daemon when a change requires it. A restart ends
 * active agents, so the stage restarts only when `activeAgents` reports none; it never passes a
 * raw Paseo password through here, only the authenticated Paseo CLI the adapter wraps.
 */
export interface ControlPlane {
  /** Whether Paseo answers its health endpoint on the worker. */
  health(worker: WorkerAddress): Promise<ControlPlaneHealth>;
  /** How many agents are active, so a maintenance change never interrupts one. */
  activeAgents(worker: WorkerAddress): Promise<AgentActivity>;
  /** Installs the release-owned package, settings, auth wrapper and service without lifecycle action. */
  install(worker: WorkerAddress, projection: HostProjection): Promise<ControlPlaneAction>;
  /** Asks Paseo to reload its configuration, without ending active agents. */
  reload(worker: WorkerAddress): Promise<ControlPlaneAction>;
  /** Restarts the Paseo daemon, ending active agents: only when none are active. */
  restart(worker: WorkerAddress): Promise<ControlPlaneAction>;
}

/** Paseo's health on a worker as the adapter found it. */
export type ControlPlaneHealth = "healthy" | "unhealthy" | "unreachable";
