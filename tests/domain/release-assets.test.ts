import { describe, expect, test } from "bun:test";
import type { Release } from "../../src/domain/instance";
import {
  bundlePathProblem,
  isMarkerFor,
  isSha256,
  MATERIALIZED_MARKER,
  markerFor,
  releaseAssetsCheck,
} from "../../src/domain/release-assets";

const RELEASE = "0.3.0" as Release;
const DIGEST = "a".repeat(64);
const PATH = "/home/operator/.cache/fffactory/releases/0.3.0";

describe("bundle entry paths", () => {
  test.each([
    "release.json",
    "terraform/modules/worker/main.tf",
    "bin/setup step.sh",
    ".hidden/file",
  ])("accepts the relative path %p", (path) => {
    expect(bundlePathProblem(path)).toBeUndefined();
  });

  test.each([
    ["", "is empty"],
    ["/etc/passwd", "must be relative"],
    ["../outside", "must not contain '.' or '..' segments"],
    ["a/../../outside", "must not contain '.' or '..' segments"],
    ["a/./b", "must not contain '.' or '..' segments"],
    [".", "must not contain '.' or '..' segments"],
    ["a//b", "must not contain empty segments"],
    ["a/", "must not contain empty segments"],
    ["a\\..\\b", "may hold only printable ASCII other than backslash"],
    ["a\0b", "may hold only printable ASCII other than backslash"],
    ["café", "may hold only printable ASCII other than backslash"],
    [MATERIALIZED_MARKER, "is reserved for the materialization marker"],
  ])("rejects %p: %s", (path, problem) => {
    expect(bundlePathProblem(path)).toBe(problem);
  });

  test("reserves the marker name only at the root", () => {
    expect(bundlePathProblem(`nested/${MATERIALIZED_MARKER}`)).toBeUndefined();
  });
});

describe("SHA-256 digests", () => {
  test("are 64 lowercase hexadecimal digits", () => {
    expect(isSha256(DIGEST)).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(false);
    expect(isSha256("a".repeat(63))).toBe(false);
    expect(isSha256(undefined)).toBe(false);
  });
});

describe("materialization marker", () => {
  test("records the release and the bundle digest, and recognizes itself", () => {
    const marker = markerFor(RELEASE, DIGEST);
    expect(JSON.parse(marker)).toEqual({ release: RELEASE, sha256: DIGEST });
    expect(isMarkerFor(marker, RELEASE, DIGEST)).toBe(true);
  });

  test("does not match another release, another digest, or text that is not a marker", () => {
    const marker = markerFor(RELEASE, DIGEST);
    expect(isMarkerFor(marker, "0.4.0" as Release, DIGEST)).toBe(false);
    expect(isMarkerFor(marker, RELEASE, "b".repeat(64))).toBe(false);
    expect(isMarkerFor("not json", RELEASE, DIGEST)).toBe(false);
    expect(isMarkerFor("null", RELEASE, DIGEST)).toBe(false);
  });
});

describe("release assets check", () => {
  test("materialized assets are ready and located", () => {
    expect(releaseAssetsCheck(PATH, RELEASE, "materialized")).toMatchObject({
      id: "release_assets",
      status: "ready",
      summary: `Release 0.3.0 assets are materialized at ${PATH}`,
    });
  });

  test("assets not yet materialized are ready: FFFactory materializes them when first needed", () => {
    expect(releaseAssetsCheck(PATH, RELEASE, "absent")).toMatchObject({
      status: "ready",
      summary: `Release 0.3.0 assets are not materialized yet; FFFactory materializes them into ${PATH} when first needed`,
    });
  });

  test("stale assets are ready: FFFactory replaces them when next needed", () => {
    expect(releaseAssetsCheck(PATH, RELEASE, "stale")).toMatchObject({
      status: "ready",
      summary: `${PATH} holds other assets for release 0.3.0; FFFactory replaces them when next needed`,
    });
  });

  test("a tampered embedded bundle is not ready: reinstall", () => {
    const check = releaseAssetsCheck(PATH, RELEASE, "tampered");
    expect(check).toMatchObject({
      status: "not_ready",
      summary: "The embedded release assets do not match their recorded SHA-256 digest",
    });
    expect(check.nextAction).toBe(
      "Reinstall fffactory from its GitHub Release, then rerun `fffactory doctor`.",
    );
  });

  test("an executable without embedded assets is not ready: reinstall", () => {
    const check = releaseAssetsCheck(PATH, RELEASE, "not_embedded");
    expect(check).toMatchObject({
      status: "not_ready",
      summary: "This fffactory executable embeds no release assets",
    });
    expect(check.nextAction).toContain("Reinstall fffactory");
  });
});
