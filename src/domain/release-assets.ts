/**
 * Release assets: the bundle an executable embeds as one gzipped tarball with a recorded
 * SHA-256 digest, the rules its entry paths obey, and what a materialized copy holds.
 */
import { type CheckResult, notReady, ready, thenRerun } from "./check-result";
import type { Release } from "./instance";

/**
 * What the running executable's bundle and its materialized copy for this release look like.
 * `not_embedded` and `tampered` describe the bundle; the rest, the materialized directory.
 */
export type ReleaseAssetsState = "not_embedded" | "tampered" | "absent" | "materialized" | "stale";

/**
 * Written last into a materialized directory, at its root. Its presence with this release
 * and digest is what makes the directory current; no bundle entry may take its name.
 */
export const MATERIALIZED_MARKER = ".fffactory-assets.json";

/**
 * The Linux executable that serves the host protocol on workers: a build without an embedded
 * bundle, since a worker's assets are its unpacked release directory. The activator runs it.
 */
export const WORKER_EXECUTABLE_ENTRY = "bin/fffactory";

const SHA256 = /^[0-9a-f]{64}$/;
/** Printable ASCII, space included, without backslash. */
const PRINTABLE = /^[\x20-\x5b\x5d-\x7e]+$/;

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

/**
 * Why `path` cannot name a bundle entry, or `undefined` when it can. An entry path is
 * relative and has no empty, `.` or `..` segment, so it can never leave the directory it is
 * materialized into.
 */
export function bundlePathProblem(path: string): string | undefined {
  if (path === "") return "is empty";
  if (!PRINTABLE.test(path)) return "may hold only printable ASCII other than backslash";
  if (path.startsWith("/")) return "must be relative";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "must not contain '.' or '..' segments";
  }
  if (segments.includes("")) return "must not contain empty segments";
  if (path === MATERIALIZED_MARKER) return "is reserved for the materialization marker";
  return undefined;
}

/** The marker's contents for this release and bundle digest. */
export function markerFor(release: Release, sha256: string): string {
  return `${JSON.stringify({ release, sha256 }, null, 2)}\n`;
}

/** Whether `text` is the marker for exactly this release and bundle digest. */
export function isMarkerFor(text: string, release: Release, sha256: string): boolean {
  let marker: unknown;
  try {
    marker = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof marker !== "object" || marker === null) return false;
  const recorded = marker as Record<string, unknown>;
  return recorded.release === release && recorded.sha256 === sha256;
}

export const RELEASE_ASSETS_CHECK = { id: "release_assets", title: "Release assets" } as const;

const REINSTALL = thenRerun("Reinstall fffactory from its GitHub Release");

/** Assets are usable unless the executable's own bundle is missing or fails its digest. */
export function releaseAssetsCheck(
  path: string,
  release: Release,
  state: ReleaseAssetsState,
): CheckResult {
  switch (state) {
    case "materialized":
      return ready(RELEASE_ASSETS_CHECK, `Release ${release} assets are materialized at ${path}`);
    case "absent":
      return ready(
        RELEASE_ASSETS_CHECK,
        `Release ${release} assets are not materialized yet; FFFactory materializes them into ${path} when first needed`,
      );
    case "stale":
      return ready(
        RELEASE_ASSETS_CHECK,
        `${path} holds other assets for release ${release}; FFFactory replaces them when next needed`,
      );
    case "tampered":
      return notReady(
        RELEASE_ASSETS_CHECK,
        "The embedded release assets do not match their recorded SHA-256 digest",
        REINSTALL,
      );
    case "not_embedded":
      return notReady(
        RELEASE_ASSETS_CHECK,
        "This fffactory executable embeds no release assets",
        REINSTALL,
      );
  }
}
