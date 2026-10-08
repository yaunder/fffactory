import { describe, expect, test } from "bun:test";
import { releaseAssetsDirectory } from "../../src/application/asset-bundle";
import type { Release } from "../../src/domain/instance";

describe("releaseAssetsDirectory", () => {
  test("keys materialized assets by release version under the cache directory", () => {
    expect(releaseAssetsDirectory("/home/operator/.cache/fffactory", "0.3.0" as Release)).toBe(
      "/home/operator/.cache/fffactory/releases/0.3.0",
    );
    expect(releaseAssetsDirectory("/cache", "1.0.0-rc.1" as Release)).toBe(
      "/cache/releases/1.0.0-rc.1",
    );
  });
});
