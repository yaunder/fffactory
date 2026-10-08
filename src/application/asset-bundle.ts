import { join } from "node:path";
import type { Release } from "../domain/instance";
import type { ReleaseAssetsState } from "../domain/release-assets";

/** Port: the running release's embedded asset bundle and its materialized copy. */
export interface AssetBundle {
  /**
   * Read-only: whether the bundle is embedded and matches its recorded digest, and if so
   * what `directory` holds. Rejects on I/O errors other than absence.
   */
  inspect(directory: string): Promise<ReleaseAssetsState>;
  /**
   * Makes `directory` hold exactly the bundle's assets, unless it already does, and resolves
   * with the bundle's SHA-256: the identity of the assets now there. Rejects a missing or
   * tampered bundle, leaving `directory` as it was.
   */
  materialize(directory: string): Promise<string>;
  /**
   * The bundle as a worker receives it (`docs/specs/host-protocol.md` §apply): the verified
   * tarball and the digest the executable embeds for it, when it carries the worker
   * executable `bin/fffactory`; undefined when it does not, as run from source. Rejects a
   * missing or tampered bundle.
   */
  workerRelease(): Promise<WorkerRelease | undefined>;
}

/** The release tarball a worker's activator installs, and the SHA-256 it must have. */
export interface WorkerRelease {
  readonly release: Release;
  readonly sha256: string;
  readonly tarball: Uint8Array;
}

/**
 * Where a release's assets are materialized: one directory per release version,
 * `<cache directory>/releases/<release>`.
 */
export function releaseAssetsDirectory(cacheDirectory: string, release: Release): string {
  return join(cacheDirectory, "releases", release);
}
