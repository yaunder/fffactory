import type { HostTransport } from "./host-transport";
import {
  type DispatchInspection,
  dispatchInspectionExitCode,
  INSPECT_DISPATCH_COMMAND,
  parseDispatchInspection,
} from "../domain/dispatch-projection";
import { HOST_PROTOCOL_VERSION } from "../domain/host-protocol";
import type { WorkerAddress } from "../domain/tailnet";

const TIMEOUT_MS = 2 * 60_000;

export async function inspectDispatch(
  transport: HostTransport,
  worker: WorkerAddress,
): Promise<DispatchInspection> {
  const outcome = await transport.run(worker, INSPECT_DISPATCH_COMMAND, { timeoutMs: TIMEOUT_MS });
  if (outcome.kind !== "completed")
    return { protocol_version: HOST_PROTOCOL_VERSION, state: "unreadable" };
  const inspection = parseDispatchInspection(outcome.stdout);
  return inspection !== undefined && outcome.exitCode === dispatchInspectionExitCode(inspection)
    ? inspection
    : { protocol_version: HOST_PROTOCOL_VERSION, state: "unreadable" };
}
