/**
 * Managed Terraform: downloads the supported Terraform release from HashiCorp into the
 * FFFactory cache, verifies it against HashiCorp's published SHA256SUMS (whose own digest
 * FFFactory pins), and installs it atomically. Terraform on PATH is never used.
 */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import {
  type ManagedTerraformPaths,
  type ManagedTerraformProbe,
  managedTerraformPaths,
} from "../../application/managed-terraform";
import {
  type ManagedTerraformState,
  SUPPORTED_TERRAFORM,
  type TerraformDistribution,
} from "../../domain/managed-terraform";
import { sha256Hex } from "../release-tarball";
import { extractZipEntry } from "./zip";

export const HASHICORP_RELEASES_URL = "https://releases.hashicorp.com/terraform";
/** Deadline for each download, SHA256SUMS or archive. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Age past which a staging directory belongs to no running install: an install's two
 * downloads each have a deadline, so a live one is never this old.
 */
export const STALE_STAGING_MS = 60 * 60 * 1000;

/** An operating system and CPU as Node names them, such as `darwin` and `arm64`. */
export interface Platform {
  readonly os: string;
  readonly arch: string;
}

const OPERATING_SYSTEMS: Readonly<Record<string, string>> = { darwin: "darwin", linux: "linux" };
const ARCHITECTURES: Readonly<Record<string, string>> = { x64: "amd64", arm64: "arm64" };

/** HashiCorp's name for a platform FFFactory supports, such as `linux_amd64`. */
export function hashicorpPlatform({ os, arch }: Platform): string | undefined {
  const system = Object.hasOwn(OPERATING_SYSTEMS, os) ? OPERATING_SYSTEMS[os] : undefined;
  const cpu = Object.hasOwn(ARCHITECTURES, arch) ? ARCHITECTURES[arch] : undefined;
  return system && cpu ? `${system}_${cpu}` : undefined;
}

export interface ManagedTerraformOptions {
  readonly distribution: TerraformDistribution;
  /** Where releases are published, standing in for `HASHICORP_RELEASES_URL`. */
  readonly releasesUrl: string;
  readonly platform: Platform;
  readonly timeoutMs: number;
}

export interface ManagedTerraform extends ManagedTerraformProbe {
  /**
   * The absolute path of the verified Terraform executable in the cache, downloading and
   * installing it first when it is not installed. Rejects, installing nothing, when a
   * download fails or does not match its digest.
   */
  install(cacheDirectory: string): Promise<string>;
}

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
/** What `rename` reports when its target is occupied. */
const OCCUPIED = new Set(["ENOTEMPTY", "EEXIST"]);

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (ABSENT.has(code(error) ?? "")) return false;
    throw error;
  }
}

async function installedState(paths: ManagedTerraformPaths): Promise<ManagedTerraformState> {
  try {
    const info = await lstat(paths.executable);
    return info.isFile() && (info.mode & 0o111) !== 0 ? "installed" : "damaged";
  } catch (error) {
    if (!ABSENT.has(code(error) ?? "")) throw error;
    return (await exists(paths.versionDirectory)) ? "damaged" : "absent";
  }
}

/** Why a request failed, by error code or name; never the error's message. */
function failure(error: unknown): string {
  const errorCode = code(error);
  if (typeof errorCode === "string") return errorCode;
  return error instanceof Error ? error.name : "unexpected error";
}

/** Fetches `url` to its end within the deadline. */
async function download(url: string, timeoutMs: number): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadFailed(`Downloading ${url} failed with HTTP status ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof DownloadFailed) throw error;
    if (signal.aborted)
      throw new Error(`Downloading ${url} did not finish within ${timeoutMs / 1000} s`);
    throw new Error(`Could not download ${url} (${failure(error)})`);
  }
}

class DownloadFailed extends Error {}

/** The SHA-256 SHA256SUMS lists for `name`, as `sha256sum` writes it. */
function listedDigest(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (match?.[2] === name) return match[1];
  }
  return undefined;
}

interface Download {
  readonly url: string;
  readonly timeoutMs: number;
  readonly distribution: TerraformDistribution;
}

async function verifiedSums({ url, timeoutMs, distribution }: Download): Promise<string> {
  const { version } = distribution;
  const sums = await download(`${url}/${version}/terraform_${version}_SHA256SUMS`, timeoutMs);
  if (sha256Hex(sums) !== distribution.sha256sums)
    throw new Error(
      `HashiCorp's SHA256SUMS for Terraform ${version} does not match the digest fffactory ` +
        "pins; nothing was installed",
    );
  return new TextDecoder().decode(sums);
}

/**
 * Downloads the archive into `staging` and verifies it. On a mismatch the downloaded file is
 * deleted before the refusal.
 */
async function verifiedArchive(
  source: Download,
  platformName: string,
  staging: string,
): Promise<Uint8Array> {
  const { version } = source.distribution;
  const sums = await verifiedSums(source);
  const name = `terraform_${version}_${platformName}.zip`;
  const expected = listedDigest(sums, name);
  if (expected === undefined)
    throw new Error(`HashiCorp's SHA256SUMS for Terraform ${version} lists no ${name}`);
  const path = join(staging, name);
  await writeFile(path, await download(`${source.url}/${version}/${name}`, source.timeoutMs), {
    mode: 0o600,
  });
  const archive = new Uint8Array(await readFile(path));
  if (sha256Hex(archive) !== expected) {
    await rm(path, { force: true });
    throw new Error(
      `${name} does not match its SHA-256 in HashiCorp's SHA256SUMS for Terraform ${version}; ` +
        "the download was deleted",
    );
  }
  await rm(path);
  return archive;
}

/** Renames the staged version directory into place, accepting a concurrent run's copy. */
async function place(staged: string, paths: ManagedTerraformPaths): Promise<void> {
  try {
    await rename(staged, paths.versionDirectory);
  } catch (error) {
    if (!OCCUPIED.has(code(error) ?? "") || (await installedState(paths)) !== "installed")
      throw error;
  }
}

const STAGING_PREFIX = ".download-";

/** Removes `path` if it was last modified before `cutoff`, unless it is already gone. */
async function removeIfStale(path: string, cutoff: number): Promise<void> {
  try {
    if ((await lstat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!ABSENT.has(code(error) ?? "")) throw error;
    // A concurrent install has just removed its own.
  }
}

/**
 * Removes staging directories older than STALE_STAGING_MS: an install interrupted by a signal
 * leaves its own behind. A concurrent install's is recent and is left alone.
 */
async function removeStaleStaging(root: string): Promise<void> {
  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const name of await readdir(root))
    if (name.startsWith(STAGING_PREFIX)) await removeIfStale(join(root, name), cutoff);
}

async function installInto(
  paths: ManagedTerraformPaths,
  source: Download,
  platformName: string,
): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await removeStaleStaging(paths.root);
  const staging = await mkdtemp(join(paths.root, STAGING_PREFIX));
  try {
    const archive = await verifiedArchive(source, platformName, staging);
    const staged = join(staging, source.distribution.version);
    await mkdir(staged);
    const executable = join(staged, "terraform");
    await writeFile(executable, extractZipEntry(archive, "terraform"), { mode: 0o700 });
    // The umask narrows a mode given at creation; chmod sets it exactly.
    await chmod(executable, 0o755);
    if ((await installedState(paths)) === "damaged")
      await rm(paths.versionDirectory, { recursive: true, force: true });
    await place(staged, paths);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Managed Terraform for the supported release on this platform, from HashiCorp. */
export function managedTerraform(options: Partial<ManagedTerraformOptions> = {}): ManagedTerraform {
  const distribution = options.distribution ?? SUPPORTED_TERRAFORM;
  const target = options.platform ?? { os: platform(), arch: arch() };
  const platformName = hashicorpPlatform(target);
  const source: Download = {
    url: options.releasesUrl ?? HASHICORP_RELEASES_URL,
    timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    distribution,
  };
  const pathsIn = (cacheDirectory: string) =>
    managedTerraformPaths(cacheDirectory, distribution.version);
  return {
    async inspect(cacheDirectory) {
      if (platformName === undefined) return "unsupported_platform";
      return installedState(pathsIn(cacheDirectory));
    },
    async install(cacheDirectory) {
      if (platformName === undefined)
        throw new Error(
          `FFFactory has no Terraform ${distribution.version} build for ${target.os} ${target.arch}`,
        );
      const paths = pathsIn(cacheDirectory);
      if ((await installedState(paths)) !== "installed")
        await installInto(paths, source, platformName);
      return paths.executable;
    },
  };
}
