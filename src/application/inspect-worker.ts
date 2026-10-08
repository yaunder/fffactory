import { COMMAND_NOT_FOUND, INSPECT_COMMAND, parseHostInspection } from "../domain/host-protocol";
import type { WorkerInspection } from "../domain/status";
import type { WorkerAddress } from "../domain/tailnet";
import type { HostTransport } from "./host-transport";

/** Connecting, and the worker reading its state; a worker taking longer is unreachable. */
export const INSPECT_TIMEOUT_MS = 30_000;

/**
 * Runs `host inspect --json` on the worker with its active release and reads the document.
 * The worker's shell not finding that release's executable means there is none.
 */
export async function inspectWorker(
  transport: HostTransport,
  worker: WorkerAddress,
): Promise<WorkerInspection> {
  const outcome = await transport.run(worker, INSPECT_COMMAND, { timeoutMs: INSPECT_TIMEOUT_MS });
  switch (outcome.kind) {
    case "completed":
      break;
    case "timed_out":
      return {
        kind: "unreachable",
        reason: `no answer within ${INSPECT_TIMEOUT_MS / 1000} s`,
      };
    case "not_started":
      return { kind: "failed", reason: `ssh could not be started (${outcome.code})` };
    default:
      return outcome;
  }
  if (outcome.exitCode === COMMAND_NOT_FOUND) return { kind: "no_release" };
  if (outcome.exitCode !== 0)
    return { kind: "failed", reason: `host inspect exited with status ${outcome.exitCode}` };
  const parsed = parseHostInspection(outcome.stdout);
  if (parsed.ok) return { kind: "inspected", inspection: parsed.inspection };
  if (parsed.kind === "unsupported_version")
    return { kind: "unsupported_protocol", version: parsed.version };
  return { kind: "failed", reason: `its answer is not a host inspection: ${parsed.problem}` };
}
