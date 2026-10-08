/**
 * Repository placement and repository readiness (pure; `docs/specs/repositories.md`).
 * factory.json's repository inventory and each host's placement produce the per-host manifest
 * the worker's `sync-repositories.sh` reads, in the version-2 shape that script
 * validates. The same module interprets the sync run's exit status into a repository readiness
 * that gates dispatch, and names the checkouts on disk that factory.json no longer places
 * there as unmanaged, which the sync program leaves untouched. The domain never runs the
 * script or touches a worker; `application/apply-repositories.ts` does, over `HostTransport`.
 */
import {
  HOST_PROTOCOL_VERSION,
  remoteCommand,
  type RemoteCommand,
  WORKER_EXECUTABLE,
  WORKER_PATHS,
} from "./host-protocol";
import type { FactoryId, Host, Repository } from "./instance";
import { hostName } from "./resource-naming";

/** The repository-sync program's directory inside the active release. */
export const REPOSITORY_STEP_DIR = `${WORKER_PATHS.activeRelease}/steps/repositories`;
/** The repository synchronization program (`assets/steps/repositories/sync-repositories.sh`). */
export const SYNC_SCRIPT = `${REPOSITORY_STEP_DIR}/sync-repositories.sh`;
/** The FFFlow adoption check the sync script calls per repository. */
export const ADOPTION_CHECK = `${REPOSITORY_STEP_DIR}/check-ffflow-adoption.sh`;
/** Where the repository stage writes the host's projected manifest for the sync script. */
export const REPOSITORY_MANIFEST_PATH = WORKER_PATHS.repositoryManifest;
/** Where the worker records the last completed repository reconciliation for status. */
export const REPOSITORY_RESULT_PATH = WORKER_PATHS.repositoryResult;

/** One repository in the manifest the sync script reads; v2 pins a fast-forward-only policy. */
export interface ManifestRepository {
  readonly remote: string;
  readonly path: string;
  readonly branch: string;
  readonly update_policy: "fast-forward-only";
}

/** The version-2 repository manifest `sync-repositories.sh` validates and reads. */
export interface RepositoryManifest {
  readonly version: 2;
  readonly repositories: Readonly<Record<string, ManifestRepository>>;
  readonly repository_sets: Readonly<Record<string, readonly string[]>>;
  readonly hosts: Readonly<Record<string, { readonly repository_sets: readonly string[] }>>;
}

/** The one synthetic set a per-host projection places every repository in. */
export const PLACED_SET = "placed";

/** The repositories factory.json places on `host`, resolved from the inventory, in placement order. */
export function placedRepositories(
  repositories: readonly Repository[],
  host: Pick<Host, "repositories">,
): Repository[] {
  const byKey = new Map(repositories.map((repository) => [repository.key, repository]));
  return (host.repositories ?? []).flatMap((key) => {
    const repository = byKey.get(key);
    return repository === undefined ? [] : [repository];
  });
}

function manifestRepository(repository: Repository): ManifestRepository {
  return {
    remote: repository.remote,
    path: repository.path,
    branch: repository.branch,
    update_policy: "fast-forward-only",
  };
}

/**
 * The per-host manifest the worker's sync script reads: the repositories placed on the host,
 * one synthetic set holding them, and one host entry keyed by the worker's namespaced
 * hostname, which the script resolves with `hostname --short`.
 */
export function repositoryManifest(
  factoryId: FactoryId,
  host: Pick<Host, "key" | "repositories">,
  repositories: readonly Repository[],
): RepositoryManifest {
  const placed = placedRepositories(repositories, host);
  return {
    version: 2,
    repositories: Object.fromEntries(
      placed.map((repository) => [repository.key, manifestRepository(repository)]),
    ),
    repository_sets: { [PLACED_SET]: placed.map((repository) => repository.key) },
    hosts: { [hostName(factoryId, host.key)]: { repository_sets: [PLACED_SET] } },
  };
}

/** The manifest's canonical text: two-space indented JSON with one final newline. */
export function repositoryManifestJson(manifest: RepositoryManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * How one worker's repository synchronization ended, read from the sync run's exit status: the
 * sync program exits non-zero when it left any declared checkout unresolved (a dirty tree,
 * divergence, a wrong branch, an unadopted branch), each reported and left untouched.
 */
export type RepositorySync = { readonly kind: "synchronized" } | { readonly kind: "unresolved" };

export function repositorySync(exitCode: number): RepositorySync {
  return exitCode === 0 ? { kind: "synchronized" } : { kind: "unresolved" };
}

/** Repository readiness gates dispatch: ready only when every placed checkout synchronized. */
export type RepositoryReadiness = "ready" | "pending";

export function repositoryReadiness(sync: RepositorySync): RepositoryReadiness {
  return sync.kind === "synchronized" ? "ready" : "pending";
}

/**
 * Checkouts present on the worker that factory.json no longer places there: reported as
 * unmanaged and left on disk, never removed. `placed` and `present` are checkout paths
 * relative to the repository root.
 */
export function unmanagedRepositories(
  placed: readonly string[],
  present: readonly string[],
): string[] {
  const managed = new Set(placed);
  return present.filter((path) => !managed.has(path)).sort();
}

export type RepositoryInspection =
  | { readonly protocol_version: typeof HOST_PROTOCOL_VERSION; readonly state: "none" }
  | { readonly protocol_version: typeof HOST_PROTOCOL_VERSION; readonly state: "unreadable" }
  | {
      readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
      readonly state: "synchronized" | "unresolved";
      readonly unmanaged: readonly string[];
    };

/** A repository protocol document, with stable key order. */
export function repositoryInspectionJson(inspection: RepositoryInspection): string {
  return JSON.stringify(
    inspection.state === "synchronized" || inspection.state === "unresolved"
      ? {
          protocol_version: inspection.protocol_version,
          state: inspection.state,
          unmanaged: [...inspection.unmanaged],
        }
      : { protocol_version: inspection.protocol_version, state: inspection.state },
    null,
    2,
  );
}

export type RepositoryInspectionParse =
  | { readonly ok: true; readonly inspection: RepositoryInspection }
  | { readonly ok: false; readonly reason: string };

/** Reads the worker repository endpoint without trusting its output. */
export function parseRepositoryInspection(text: string): RepositoryInspectionParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the repository result is not JSON" };
  }
  if (typeof value !== "object" || value === null)
    return { ok: false, reason: "the repository result is not an object" };
  const document = value as Record<string, unknown>;
  if (document.protocol_version !== HOST_PROTOCOL_VERSION)
    return { ok: false, reason: "the repository result uses another protocol version" };
  if (document.state === "none" || document.state === "unreadable")
    return {
      ok: true,
      inspection: { protocol_version: HOST_PROTOCOL_VERSION, state: document.state },
    };
  if (document.state !== "synchronized" && document.state !== "unresolved")
    return { ok: false, reason: "the repository result has an unknown state" };
  if (
    !Array.isArray(document.unmanaged) ||
    document.unmanaged.some((path) => typeof path !== "string" || path.length === 0)
  )
    return { ok: false, reason: "the repository result has invalid unmanaged paths" };
  return {
    ok: true,
    inspection: {
      protocol_version: HOST_PROTOCOL_VERSION,
      state: document.state,
      unmanaged: [...(document.unmanaged as string[])],
    },
  };
}

/**
 * Runs the sync program as the unprivileged runtime account against the written manifest; the
 * script refuses to run as root and resolves the host from the worker's own hostname.
 */
export const SYNC_COMMAND: RemoteCommand = remoteCommand([
  "sudo",
  "-n",
  WORKER_PATHS.activator,
  "repositories",
]);

/** Read-only repository observation used by status, as fffactory-admin. */
export const INSPECT_REPOSITORIES_COMMAND: RemoteCommand = remoteCommand([
  WORKER_EXECUTABLE,
  "host",
  "repositories",
  "--json",
]);
