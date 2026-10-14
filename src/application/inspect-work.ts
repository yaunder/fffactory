/**
 * The CLI side of `host work inspect` (`docs/specs/host-protocol.md` §work inspect): runs the
 * activator's fixed operation on a worker and reads the document, trusting it only for that
 * worker. Anything else is `unknown`, in fffactory's words: the worker's output is never quoted.
 */
import type { WorkerAddress } from "../domain/tailnet";
import {
  INSPECT_WORK_COMMAND,
  parseWorkInspection,
  type WorkObservation,
} from "../domain/work-inspection";
import type { HostCommandOutcome, HostTransport } from "./host-transport";

/** Connecting, and the worker reading every checkout, which bounds itself well within this. */
export const INSPECT_WORK_TIMEOUT_MS = 2 * 60_000;

/** The activator's usage error: one bootstrapped before it offered `work inspect`. */
const ACTIVATOR_USAGE = 64;
/** The activator found no active release to run the inspection with. */
const ACTIVATOR_NO_RELEASE = 65;
/** The activator's lock was held by another activation or host reconciliation. */
const ACTIVATOR_BUSY = 75;

function unknown(reason: string, unsupported = false): WorkObservation {
  return { kind: "unknown", reason, unsupported };
}

function transportFailure(outcome: Exclude<HostCommandOutcome, { kind: "completed" }>): string {
  switch (outcome.kind) {
    case "timed_out":
      return `no answer within ${INSPECT_WORK_TIMEOUT_MS / 60_000} min`;
    case "unreachable":
      return outcome.reason;
    case "access_denied":
      return "the tailnet's SSH policy refused the login";
    case "host_key_mismatch":
      return "its SSH host key is not the one the tailnet lists";
    case "client_missing":
      return "ssh is not installed";
    case "not_started":
      return `ssh could not be started (${outcome.code})`;
  }
}

function exitFailure(exitCode: number): WorkObservation {
  switch (exitCode) {
    case ACTIVATOR_USAGE:
      return unknown("its activator predates the work inspection", true);
    case ACTIVATOR_NO_RELEASE:
      return unknown("it has no active release to inspect with");
    case ACTIVATOR_BUSY:
      return unknown("another host operation was running on it");
    default:
      return unknown(`the work inspection exited with status ${exitCode}`);
  }
}

export async function inspectWork(
  transport: HostTransport,
  worker: WorkerAddress,
): Promise<WorkObservation> {
  const outcome = await transport.run(worker, INSPECT_WORK_COMMAND, {
    timeoutMs: INSPECT_WORK_TIMEOUT_MS,
  });
  if (outcome.kind !== "completed") return unknown(transportFailure(outcome));
  if (outcome.exitCode !== 0) return exitFailure(outcome.exitCode);
  const parsed = parseWorkInspection(outcome.stdout);
  if (!parsed.ok)
    return unknown(
      parsed.kind === "unsupported_version"
        ? `the work inspection speaks protocol version ${parsed.version}`
        : `its answer is not a work inspection: ${parsed.problem}`,
    );
  if (parsed.document.hostname.toLowerCase() !== worker.hostname.toLowerCase())
    return unknown("its answer is for another worker");
  return { kind: "inspected", inspection: parsed.document };
}
