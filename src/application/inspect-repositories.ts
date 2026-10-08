/** Read-only observation of the repository result persisted by the worker endpoint. */
import {
  INSPECT_REPOSITORIES_COMMAND,
  parseRepositoryInspection,
  type RepositoryInspection,
} from "../domain/repository-placement";
import type { WorkerAddress } from "../domain/tailnet";
import type { HostTransport } from "./host-transport";

export const INSPECT_REPOSITORIES_TIMEOUT_MS = 30_000;
export type RepositoryObservation =
  | RepositoryInspection
  | { readonly state: "unknown"; readonly reason: string };

export async function inspectRepositories(
  transport: HostTransport,
  worker: WorkerAddress,
): Promise<RepositoryObservation> {
  const outcome = await transport.run(worker, INSPECT_REPOSITORIES_COMMAND, {
    timeoutMs: INSPECT_REPOSITORIES_TIMEOUT_MS,
  });
  if (outcome.kind !== "completed")
    return { state: "unknown", reason: "the worker's repository result could not be read" };
  const parsed = parseRepositoryInspection(outcome.stdout);
  return parsed.ok ? parsed.inspection : { state: "unknown", reason: parsed.reason };
}
