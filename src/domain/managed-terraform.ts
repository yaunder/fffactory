/**
 * Managed Terraform: the one Terraform release FFFactory supports, which it downloads into
 * its private cache and never takes from PATH, and the rule that reports its cache state.
 */
import { type CheckResult, notReady, ready, thenRerun } from "./check-result";

/** A Terraform release, identified by version and the SHA-256 of HashiCorp's SHA256SUMS for it. */
export interface TerraformDistribution {
  readonly version: string;
  /**
   * SHA-256 of `terraform_<version>_SHA256SUMS` as HashiCorp publishes it. The file lists the
   * SHA-256 of every platform's zip archive, so pinning it pins every download.
   */
  readonly sha256sums: string;
}

/**
 * The exact Terraform release FFFactory runs. This is the only place it is pinned; changing it
 * means changing both values, the second taken from HashiCorp's published SHA256SUMS file.
 */
export const SUPPORTED_TERRAFORM: TerraformDistribution = {
  version: "1.16.4",
  sha256sums: "e8702b6a51705a6846412055205819091ac9a74d551611015ddf36087fe9a2b5",
};

/**
 * What the cache holds for the supported release on this platform. `damaged`: something is
 * at its place in the cache that is not an executable Terraform.
 */
export type ManagedTerraformState = "installed" | "absent" | "damaged" | "unsupported_platform";

export const MANAGED_TERRAFORM_CHECK = { id: "terraform", title: "Managed Terraform" } as const;

/** Managed Terraform is usable unless this platform has no build FFFactory can download. */
export function managedTerraformCheck(
  path: string,
  version: string,
  state: ManagedTerraformState,
): CheckResult {
  switch (state) {
    case "installed":
      return ready(MANAGED_TERRAFORM_CHECK, `Terraform ${version} is installed at ${path}`);
    case "absent":
      return ready(
        MANAGED_TERRAFORM_CHECK,
        `Terraform ${version} is not downloaded yet; FFFactory downloads it into ${path} from ` +
          "releases.hashicorp.com when first needed",
      );
    case "damaged":
      return ready(
        MANAGED_TERRAFORM_CHECK,
        `${path} is not a usable Terraform ${version}; FFFactory downloads it again when next needed`,
      );
    case "unsupported_platform":
      return notReady(
        MANAGED_TERRAFORM_CHECK,
        `FFFactory has no Terraform ${version} build for this platform`,
        thenRerun("Run fffactory on macOS or Linux, on x86-64 or arm64"),
      );
  }
}
