import type {
  ControlPlane,
  ControlPlaneAction,
  ControlPlaneHealth,
} from "../application/control-plane";
import type { HostCommandOutcome, HostTransport } from "../application/host-transport";
import {
  parseActivityDocument,
  parseControlPlaneActionDocument,
  type AgentActivity,
} from "../domain/control-plane";
import { remoteCommand, WORKER_PATHS, type RemoteCommand } from "../domain/host-protocol";
import { hostProjectionJson, type HostProjection } from "../domain/host-projection";
import type { WorkerAddress } from "../domain/tailnet";

export const PASEO_PORT = "6767";
export const CONTROL_PLANE_TIMEOUT_MS = 2 * 60_000;

function activator(action: "activity" | "install" | "reload" | "restart"): RemoteCommand {
  return remoteCommand(["sudo", "-n", WORKER_PATHS.activator, "control-plane", action]);
}

function healthCommand(worker: WorkerAddress): RemoteCommand {
  return remoteCommand([
    "curl",
    "--fail",
    "--silent",
    "--show-error",
    "--noproxy",
    worker.address,
    "--connect-timeout",
    "2",
    "--max-time",
    "120",
    "--retry",
    "30",
    "--retry-delay",
    "2",
    "--retry-connrefused",
    `http://${worker.address}:${PASEO_PORT}/api/health`,
  ]);
}

function failed(outcome: HostCommandOutcome, what: string): ControlPlaneAction {
  if (outcome.kind !== "completed") return { kind: "failed", reason: `${what} ${outcome.kind}` };
  return { kind: "failed", reason: `${what} exited ${outcome.exitCode}` };
}

function readAction(outcome: HostCommandOutcome, what: string): ControlPlaneAction {
  if (outcome.kind !== "completed" || outcome.exitCode !== 0) return failed(outcome, what);
  const parsed = parseControlPlaneActionDocument(outcome.stdout);
  return parsed.ok
    ? parsed.document.result
    : { kind: "failed", reason: `${what} returned invalid data` };
}

export function paseoControlPlane(transport: HostTransport): ControlPlane {
  const run = (worker: WorkerAddress, command: RemoteCommand, stdin?: Uint8Array) =>
    transport.run(worker, command, {
      timeoutMs: CONTROL_PLANE_TIMEOUT_MS,
      ...(stdin ? { stdin } : {}),
    });
  return {
    async health(worker): Promise<ControlPlaneHealth> {
      const outcome = await run(worker, healthCommand(worker));
      if (outcome.kind !== "completed") return "unreachable";
      return outcome.exitCode === 0 ? "healthy" : "unhealthy";
    },
    async activeAgents(worker): Promise<AgentActivity> {
      const outcome = await run(worker, activator("activity"));
      if (outcome.kind !== "completed" || outcome.exitCode !== 0)
        return { kind: "unknown", reason: "Paseo activity could not be read" };
      const parsed = parseActivityDocument(outcome.stdout);
      return parsed.ok
        ? parsed.document.activity
        : { kind: "unknown", reason: "Paseo activity returned invalid data" };
    },
    async install(worker, projection: HostProjection): Promise<ControlPlaneAction> {
      return readAction(
        await run(
          worker,
          activator("install"),
          new TextEncoder().encode(hostProjectionJson(projection)),
        ),
        "Paseo install",
      );
    },
    async reload(worker): Promise<ControlPlaneAction> {
      return readAction(await run(worker, activator("reload")), "Paseo reload");
    },
    async restart(worker): Promise<ControlPlaneAction> {
      return readAction(await run(worker, activator("restart")), "Paseo restart");
    },
  };
}
