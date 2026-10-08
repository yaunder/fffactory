/**
 * AssetBundle over a release bundle: a gzipped tarball with its recorded SHA-256, embedded in
 * the compiled executable, or packed from the checkout's `assets/` when run from source.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AssetBundle } from "../application/asset-bundle";
import type { Release } from "../domain/instance";
import {
  isMarkerFor,
  isSha256,
  MATERIALIZED_MARKER,
  markerFor,
  type ReleaseAssetsState,
  WORKER_EXECUTABLE_ENTRY,
} from "../domain/release-assets";
import { packTarball, sha256Hex, type TarballEntry, unpackTarball } from "./release-tarball";

export interface ReleaseBundle {
  readonly release: Release;
  /** The SHA-256 recorded for the tarball when it was built. */
  readonly sha256: string;
  readonly tarball: () => Promise<Uint8Array<ArrayBuffer>>;
}

/** Produces the running release's bundle, or `undefined` when there is none. */
export type BundleSource = () => Promise<ReleaseBundle | undefined>;

/** Generated into every bundle's root from the release; `assets/` may not hold one. */
export const RELEASE_METADATA = "release.json";
/** Repository documentation for agents, never bundled. */
const DOCUMENTATION = "CLAUDE.md";

const REINSTALL = "reinstall fffactory from its GitHub Release";
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
/** What `rename` reports when its target is occupied by something it will not replace. */
const OCCUPIED = new Set(["ENOTEMPTY", "EEXIST", "ENOTDIR", "EISDIR"]);

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function required(source: BundleSource): Promise<ReleaseBundle> {
  const bundle = await source();
  if (!bundle) throw new Error(`This fffactory executable embeds no release assets; ${REINSTALL}`);
  return bundle;
}

async function verifiedTarball(bundle: ReleaseBundle): Promise<Uint8Array<ArrayBuffer> | null> {
  const tarball = await bundle.tarball();
  return sha256Hex(tarball) === bundle.sha256 ? tarball : null;
}

async function requiredTarball(bundle: ReleaseBundle): Promise<Uint8Array<ArrayBuffer>> {
  const tarball = await verifiedTarball(bundle);
  if (!tarball)
    throw new Error(
      `The embedded release assets do not match their recorded SHA-256 digest; ${REINSTALL}`,
    );
  return tarball;
}

/** The marker's text, or `undefined` when `directory` or its marker is absent. */
async function markerText(directory: string): Promise<string | undefined> {
  try {
    return await readFile(join(directory, MATERIALIZED_MARKER), "utf8");
  } catch (error) {
    if (ABSENT.has(code(error) ?? "")) return undefined;
    throw error;
  }
}

async function isCurrent(directory: string, bundle: ReleaseBundle): Promise<boolean> {
  const text = await markerText(directory);
  return text !== undefined && isMarkerFor(text, bundle.release, bundle.sha256);
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

/** Creates `path` exclusively with `data`, flushed to disk before it counts as written. */
async function writeDurably(path: string, data: Uint8Array | string, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes every entry, then the marker, into the fresh private directory `staging`. */
async function stage(staging: string, entries: readonly TarballEntry[], bundle: ReleaseBundle) {
  for (const entry of entries) {
    // Entry paths are relative with no `.` or `..` segment (unpackTarball), so they stay inside.
    const path = join(staging, entry.path);
    await mkdir(dirname(path), { recursive: true });
    await writeDurably(path, entry.data, entry.executable ? 0o755 : 0o644);
  }
  await writeDurably(
    join(staging, MATERIALIZED_MARKER),
    markerFor(bundle.release, bundle.sha256),
    0o644,
  );
}

/** Renames `from` to `to`; `false` when something `rename` will not replace occupies `to`. */
async function renamed(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if (OCCUPIED.has(code(error) ?? "")) return false;
    throw error;
  }
}

/** How often a run tries to rename its copy into place before giving up to concurrent runs. */
export const INSTALL_ATTEMPTS = 10;

/** Renames whatever is at `directory` to `aside`; nothing to do when it is already gone. */
async function moveAside(directory: string, aside: string): Promise<void> {
  try {
    await rename(directory, aside);
  } catch (error) {
    if (!ABSENT.has(code(error) ?? "")) throw error;
  }
}

/**
 * Older than any materialization takes: a staging or replaced copy this old was left by a run
 * that was killed, since every run removes its own however it ends.
 */
export const STALE_STAGING_MS = 60 * 60 * 1000;

/** Removes the staging and replaced copies of `directory` that killed runs left behind. */
async function removeStaleCopies(directory: string): Promise<void> {
  const parent = dirname(directory);
  const prefixes = [".staging-", ".replaced-"].map((kind) => `.${basename(directory)}${kind}`);
  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const name of await readdir(parent)) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const info = await lstat(join(parent, name)).catch(() => undefined);
    if (info !== undefined && info.mtimeMs < cutoff)
      await rm(join(parent, name), { recursive: true, force: true });
  }
}

/** The steps `install` takes between renames; tests replace them to stage a race. */
export interface InstallSteps {
  readonly isCurrent: (directory: string, bundle: ReleaseBundle) => Promise<boolean>;
  readonly moveAside: (directory: string, aside: string) => Promise<void>;
}

const FILESYSTEM_STEPS: InstallSteps = { isCurrent, moveAside };

/**
 * Moves the complete `staging` directory into place with one atomic rename. When another
 * run got there first with the same bundle, its copy stands. Anything else at `directory`
 * is renamed aside and removed, and the rename retried: concurrent runs replacing the same
 * stale directory can clear each other's way, so each retries until one copy stands. Every
 * move aside is followed by another rename, so a run that gives up never leaves `directory`
 * absent, nor removes a current copy another run installed after this run last checked.
 */
export async function install(
  staging: string,
  directory: string,
  bundle: ReleaseBundle,
  steps: InstallSteps = FILESYSTEM_STEPS,
): Promise<void> {
  const asides: string[] = [];
  try {
    for (let attempt = 0; attempt < INSTALL_ATTEMPTS; attempt += 1) {
      if ((await renamed(staging, directory)) || (await steps.isCurrent(directory, bundle))) return;
      if (attempt === INSTALL_ATTEMPTS - 1) break;
      const aside = join(dirname(directory), `.${basename(directory)}.replaced-${randomUUID()}`);
      asides.push(aside);
      await steps.moveAside(directory, aside);
    }
    throw new Error(`Could not replace ${directory} with release ${bundle.release} assets`);
  } finally {
    await Promise.all(asides.map((aside) => rm(aside, { recursive: true, force: true })));
  }
}

/**
 * AssetBundle over the bundle `source` produces. Materialization verifies the tarball's
 * digest, extracts it into a private staging directory beside the target, and renames that
 * into place, so the target is never partly written and concurrent runs converge on one
 * complete copy.
 */
export function releaseAssetBundle(source: BundleSource): AssetBundle {
  return {
    async inspect(directory): Promise<ReleaseAssetsState> {
      const bundle = await source();
      if (!bundle) return "not_embedded";
      if (!(await verifiedTarball(bundle))) return "tampered";
      if (await isCurrent(directory, bundle)) return "materialized";
      return (await exists(directory)) ? "stale" : "absent";
    },

    async materialize(directory) {
      const bundle = await required(source);
      if (await isCurrent(directory, bundle)) return bundle.sha256;
      const tarball = await requiredTarball(bundle);
      const entries = unpackTarball(tarball);
      const parent = dirname(directory);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await removeStaleCopies(directory);
      const staging = await mkdtemp(join(parent, `.${basename(directory)}.staging-`));
      try {
        await stage(staging, entries, bundle);
        await install(staging, directory, bundle);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return bundle.sha256;
    },

    async workerRelease() {
      const bundle = await required(source);
      const tarball = await requiredTarball(bundle);
      const worker = unpackTarball(tarball).find(
        (entry) => entry.path === WORKER_EXECUTABLE_ENTRY && entry.executable,
      );
      if (worker === undefined) return undefined;
      return { release: bundle.release, sha256: bundle.sha256, tarball };
    },
  };
}

async function assetEntries(root: string, relative = ""): Promise<TarballEntry[]> {
  const entries: TarballEntry[] = [];
  for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) entries.push(...(await assetEntries(root, path)));
    else if (!item.isFile()) {
      throw new Error(`Asset ${JSON.stringify(path)} is not a regular file or directory`);
    } else if (item.name !== DOCUMENTATION) {
      const file = join(root, path);
      const executable = ((await lstat(file)).mode & 0o111) !== 0;
      entries.push({ path, executable, data: new Uint8Array(await readFile(file)) });
    }
  }
  return entries;
}

/**
 * The release bundle for `release`: every regular file under `directory` except CLAUDE.md
 * files, plus a generated `release.json` and, when given, the worker executable as
 * `bin/fffactory`. Rejects symbolic links and other special files.
 */
export async function packAssetsDirectory(
  directory: string,
  release: Release,
  workerExecutable?: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const metadata = new TextEncoder().encode(`${JSON.stringify({ release }, null, 2)}\n`);
  const generated = [
    { path: RELEASE_METADATA, executable: false, data: metadata },
    ...(workerExecutable === undefined
      ? []
      : [{ path: WORKER_EXECUTABLE_ENTRY, executable: true, data: workerExecutable }]),
  ];
  return packTarball([...(await assetEntries(directory)), ...generated]);
}

/** Run from source: the bundle is packed from the checkout's `assets/` when first needed. */
export function checkoutReleaseBundle(directory: string, release: Release): BundleSource {
  return async () => {
    const tarball = await packAssetsDirectory(directory, release);
    return { release, sha256: sha256Hex(tarball), tarball: async () => tarball };
  };
}

/** File name of the bundle `scripts/build.ts` embeds in the executable. */
export const EMBEDDED_BUNDLE_NAME = "fffactory-assets.tar.gz";

/** The tarball's SHA-256, defined by `scripts/build.ts`; absent when run from source. */
declare const FFFACTORY_ASSETS_SHA256: string | undefined;

/** What `scripts/build.ts` embeds: the files `Bun.embeddedFiles` lists, and the digest. */
export interface Embedded {
  readonly files: readonly Blob[];
  readonly sha256: string | undefined;
}

function compiledIn(): Embedded {
  return {
    files: Bun.embeddedFiles,
    sha256: typeof FFFACTORY_ASSETS_SHA256 === "string" ? FFFACTORY_ASSETS_SHA256 : undefined,
  };
}

/**
 * The compiled executable's embedded bundle: the file named `EMBEDDED_BUNDLE_NAME` with
 * the digest recorded beside it, or `undefined` when either is missing.
 */
export function embeddedReleaseBundle(
  release: Release,
  embedded: () => Embedded = compiledIn,
): BundleSource {
  return async () => {
    const { files, sha256 } = embedded();
    const file = files.find(
      (blob) => (blob as Blob & { name?: string }).name === EMBEDDED_BUNDLE_NAME,
    );
    if (!file || !isSha256(sha256)) return undefined;
    return { release, sha256, tarball: async () => new Uint8Array(await file.arrayBuffer()) };
  };
}
