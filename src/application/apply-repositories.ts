/**
 * Apply's repository stage (`docs/specs/repositories.md`): on each declared worker, deliver the
 * host's projected repository manifest and run `sync-repositories.sh`, which
 * clones missing repositories, fast-forwards clean primary checkouts, and refuses resets,
 * dirty trees, divergence and unsafe branch state, leaving a removed checkout on disk. The
 * worker is reached only over Tailscale SSH, as the workers stage is. A worker that is not
 * reachable is a known skip that leaves the others to be attempted; the stage itself issues no
 * destructive command. Each worker's outcome feeds `status` and the dispatch readiness gate
 * (`domain/repository-placement.ts`, task #105).
 */
import type { FactoryId, Host, Repository } from "../domain/instance";
import {
  repositoryManifest,
  repositoryManifestJson,
  parseRepositoryInspection,
  SYNC_COMMAND,
} from "../domain/repository-placement";
import { hostName } from "../domain/resource-naming";
import type { WorkerIdentity } from "../domain/rollout";
import {
  type ConnectionFailure,
  connectionVerdict,
  locateWorker,
  thenRerunApply,
  type Verdict,
} from "../domain/status";
import type { WorkerAddress } from "../domain/tailnet";
import type { HostCommandOutcome, HostTransport } from "./host-transport";
import type { TailnetPeers } from "./tailnet-peers";

/** Cloning missing repositories over the tailnet can take minutes. */
export const SYNC_TIMEOUT_MS = 15 * 60_000;

/** One worker's repository synchronization outcome, for `status` and the dispatch gate. */
export type RepositoryOutcome =
  /** The sync program resolved every placed checkout on the worker. */
  | (WorkerIdentity & { readonly kind: "synchronized"; readonly unmanaged: readonly string[] })
  /** The sync left one or more checkouts unresolved (dirty, divergent, unadopted, ...). */
  | (WorkerIdentity & {
      readonly kind: "unresolved";
      readonly unmanaged: readonly string[];
      readonly summary: string;
      readonly nextAction: string;
    })
  /** Not attempted or not completed for a known reason: the others are still attempted. */
  | (WorkerIdentity & {
      readonly kind: "skipped";
      readonly summary: string;
      readonly nextAction: string;
    });

export interface RepositoriesStageDependencies {
  readonly peers: TailnetPeers;
  readonly transport: HostTransport;
}

export interface RepositoriesStageRequest {
  readonly factoryId: FactoryId;
  /** factory.json's `tailscale.tag`, which each worker's device must carry. */
  readonly tag: string;
  /** factory.json's hosts, whole: each one's placement comes from its own `repositories`. */
  readonly hosts: readonly Host[];
  /** factory.json's repository inventory, which host placement selects from. */
  readonly repositories: readonly Repository[];
}

export interface RepositoriesStage {
  readonly outcomes: readonly RepositoryOutcome[];
}

const CHECK_STATUS = "Check the repositories on the worker with `fffactory status`";

function skip(worker: WorkerIdentity, verdict: Pick<Verdict, "summary" | "nextAction">) {
  return {
    ...worker,
    kind: "skipped",
    summary: verdict.summary,
    nextAction: verdict.nextAction ?? thenRerunApply(CHECK_STATUS),
  } as const satisfies RepositoryOutcome;
}

/** A skip from an SSH command that did not complete, during `action` on the worker. */
function transportSkip(
  worker: WorkerIdentity,
  outcome: Exclude<HostCommandOutcome, { readonly kind: "completed" }>,
  action: string,
): RepositoryOutcome {
  if (outcome.kind === "timed_out")
    return skip(worker, {
      summary: `The command to ${action} ${worker.hostname} did not finish in time`,
      nextAction: thenRerunApply(`Check the connection with \`tailscale ping ${worker.hostname}\``),
    });
  if (outcome.kind === "not_started")
    return skip(worker, {
      summary: `ssh could not be started (${outcome.code})`,
      nextAction: thenRerunApply(CHECK_STATUS),
    });
  return skip(
    worker,
    connectionVerdict(outcome as ConnectionFailure, worker.hostname, thenRerunApply),
  );
}

/** Delivers the manifest, runs the sync program, and reads the outcome; or why it could not. */
async function syncWorker(
  deps: RepositoriesStageDependencies,
  worker: WorkerIdentity,
  address: WorkerAddress,
  manifestJson: string,
): Promise<RepositoryOutcome> {
  const synced = await deps.transport.run(address, SYNC_COMMAND, {
    timeoutMs: SYNC_TIMEOUT_MS,
    stdin: new TextEncoder().encode(manifestJson),
  });
  if (synced.kind !== "completed")
    return transportSkip(worker, synced, "synchronize the repositories on");
  const parsed = parseRepositoryInspection(synced.stdout);
  if (!parsed.ok || (synced.exitCode === 0) !== (parsed.inspection.state === "synchronized"))
    return skip(worker, {
      summary: "The worker returned an invalid repository result",
      nextAction: thenRerunApply(`Repair the active release on ${worker.hostname}`),
    });
  if (parsed.inspection.state === "synchronized")
    return { ...worker, kind: "synchronized", unmanaged: parsed.inspection.unmanaged };
  if (parsed.inspection.state !== "unresolved")
    return skip(worker, {
      summary: "The worker returned no completed repository result",
      nextAction: thenRerunApply(`Repair the active release on ${worker.hostname}`),
    });
  return {
    ...worker,
    kind: "unresolved",
    unmanaged: parsed.inspection.unmanaged,
    summary: `Some repositories on ${worker.hostname} could not be synchronized (dirty, divergent, or unadopted); they were left untouched`,
    nextAction: thenRerunApply(`Resolve the reported checkouts on ${worker.hostname}`),
  };
}

/** The repository stage: every declared worker, in factory.json's order, each attempted. */
export async function applyRepositories(
  deps: RepositoriesStageDependencies,
  request: RepositoriesStageRequest,
): Promise<RepositoriesStage> {
  const view = await deps.peers.view();
  const outcomes: RepositoryOutcome[] = [];
  for (const host of request.hosts) {
    const worker: WorkerIdentity = {
      key: host.key,
      hostname: hostName(request.factoryId, host.key),
    };
    const location = locateWorker(view, worker.hostname, request.tag, thenRerunApply);
    if (location.kind === "blocked") {
      outcomes.push(skip(worker, location.verdict));
      continue;
    }
    const manifestJson = repositoryManifestJson(
      repositoryManifest(request.factoryId, host, request.repositories),
    );
    outcomes.push(await syncWorker(deps, worker, location.worker, manifestJson));
  }
  return { outcomes };
}
