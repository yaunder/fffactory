import { join } from "node:path";
import type { ManagedTerraformState } from "../domain/managed-terraform";

/** Port: inspects the managed Terraform in the cache without downloading or changing it. */
export interface ManagedTerraformProbe {
  /**
   * The state of the supported Terraform release under `cacheDirectory` on this platform.
   * Rejects on I/O errors other than absence.
   */
  inspect(cacheDirectory: string): Promise<ManagedTerraformState>;
}

/** Where managed Terraform lives in the FFFactory cache. */
export interface ManagedTerraformPaths {
  /** `<cache>/terraform`: everything below is FFFactory's own. */
  readonly root: string;
  /** `<cache>/terraform/<version>`, created whole once its download is verified. */
  readonly versionDirectory: string;
  /** `<cache>/terraform/<version>/terraform`: the only Terraform FFFactory runs. */
  readonly executable: string;
  /** `<cache>/terraform/plugins`: the provider cache, checked against the shipped lockfile. */
  readonly pluginCache: string;
  /** `<cache>/terraform/operations`: a fresh private directory per Terraform operation. */
  readonly operations: string;
  /** `<cache>/terraform/diagnostics`: failed Terraform commands' standard error, private. */
  readonly diagnostics: string;
}

/** The managed Terraform layout for `version` in the FFFactory cache directory. */
export function managedTerraformPaths(
  cacheDirectory: string,
  version: string,
): ManagedTerraformPaths {
  const root = join(cacheDirectory, "terraform");
  const versionDirectory = join(root, version);
  return {
    root,
    versionDirectory,
    executable: join(versionDirectory, "terraform"),
    pluginCache: join(root, "plugins"),
    operations: join(root, "operations"),
    diagnostics: join(root, "diagnostics"),
  };
}
