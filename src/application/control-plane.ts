import type { WorkerAddress } from "../domain/tailnet";
import type { AgentsObservation, ControlPlaneAction } from "../domain/control-plane";
import type { HostProjection } from "../domain/host-projection";

export type { AgentsObservation, ControlPlaneAction } from "../domain/control-plane";

/**
 * Port: the worker's Paseo control plane, driven over the host protocol (`infrastructure/
 * paseo-control-plane.ts`). Apply reads health and the worker's agents to decide what a plan's
 * changes may do, then reloads or restarts the daemon when a change requires it. A restart ends
 * busy agents, so the stage restarts only when the busy rule (`workerActivity`) finds the worker
 * idle; it never passes a raw Paseo password through here, only the authenticated Paseo CLI the
 * adapter wraps.
 */
export interface ControlPlane {
  /** Whether Paseo answers its health endpoint on the worker. */
  health(worker: WorkerAddress): Promise<ControlPlaneHealth>;
  /**
   * The worker's agents in fffactory's states, or why they could not be read, so a maintenance
   * change or a removal never interrupts a busy one.
   */
  agents(worker: WorkerAddress): Promise<AgentsObservation>;
  /**
   * Installs the release-owned package, settings (the password as its hash only), auth wrapper
   * and service without lifecycle action.
   */
  install(worker: WorkerAddress, projection: HostProjection): Promise<ControlPlaneAction>;
  /** Asks Paseo to reload its configuration, without ending any agent's turn. */
  reload(worker: WorkerAddress): Promise<ControlPlaneAction>;
  /** Restarts the Paseo daemon, ending agents' turns: only when none is busy. */
  restart(worker: WorkerAddress): Promise<ControlPlaneAction>;
}

/** Paseo's health on a worker as the adapter found it. */
export type ControlPlaneHealth = "healthy" | "unhealthy" | "unreachable";
