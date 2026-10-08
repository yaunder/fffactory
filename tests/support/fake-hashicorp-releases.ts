/**
 * A local stand-in for releases.hashicorp.com, so the Terraform installer is tested without
 * downloading Terraform. It serves `/terraform/<version>/<file>` like HashiCorp does, and
 * builds releases whose zip archives hold a stand-in `terraform` script.
 */
import { createHash } from "node:crypto";
import type { TerraformDistribution } from "../../src/domain/managed-terraform";
import { zipArchive } from "./zip";

export type ReleaseFiles = Record<string, Uint8Array | string>;

/** A stand-in executable that says which version it pretends to be. */
export function fakeTerraformScript(version: string): string {
  return `#!/bin/sh\necho "Terraform v${version}"\n`;
}

export function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The SHA256SUMS text HashiCorp publishes for `archives`, in name order. */
export function sha256sums(archives: ReleaseFiles): string {
  return Object.entries(archives)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, content]) => `${sha256(content)}  ${name}\n`)
    .join("");
}

export interface FakeTerraformRelease {
  /** Every file of the release by name: one zip per platform, then `SHA256SUMS`. */
  readonly files: ReleaseFiles;
  /** The pin that accepts exactly this release's SHA256SUMS. */
  readonly distribution: TerraformDistribution;
  readonly sumsName: string;
}

export function zipName(version: string, platform: string): string {
  return `terraform_${version}_${platform}.zip`;
}

/**
 * A release of `version` for `platforms` (HashiCorp names, such as `linux_amd64`), each zip
 * holding a license and a stand-in `terraform`, and its SHA256SUMS.
 */
export function fakeTerraformRelease(
  version: string,
  platforms: readonly string[] = ["darwin_arm64", "linux_amd64"],
): FakeTerraformRelease {
  const archives: ReleaseFiles = Object.fromEntries(
    platforms.map((platform) => [
      zipName(version, platform),
      zipArchive([
        { name: "LICENSE.txt", data: "Business Source License\n", deflate: true },
        { name: "terraform", data: fakeTerraformScript(version), deflate: true },
      ]),
    ]),
  );
  const sums = sha256sums(archives);
  const sumsName = `terraform_${version}_SHA256SUMS`;
  return {
    files: { ...archives, [sumsName]: sums },
    distribution: { version, sha256sums: sha256(sums) },
    sumsName,
  };
}

export interface FakeHashicorpReleases {
  /** Base URL standing in for `https://releases.hashicorp.com/terraform`. */
  readonly url: string;
  /** Request paths, in order. */
  readonly requests: readonly string[];
  stop(): void;
}

/**
 * Serves `files` of `version` at `/terraform/<version>/<name>`; anything else is 404. With
 * `stall`, it accepts requests and never answers, as an unresponsive mirror would.
 */
export function fakeHashicorpReleases(
  version: string,
  files: ReleaseFiles,
  { stall = false }: { stall?: boolean } = {},
): FakeHashicorpReleases {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      if (stall) return new Promise<Response>(() => {});
      const prefix = `/terraform/${version}/`;
      const name = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : undefined;
      const content = name !== undefined && Object.hasOwn(files, name) ? files[name] : undefined;
      return content === undefined
        ? new Response("Not Found", { status: 404 })
        : new Response(content);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/terraform`,
    requests,
    stop: () => server.stop(true),
  };
}
