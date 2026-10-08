import { describe, expect, test } from "bun:test";
import manifest from "../../package.json";
import { RELEASE, releaseFrom } from "../../src/cli/release";

describe("release version", () => {
  test("is the package.json version", () => {
    expect(RELEASE as string).toBe(manifest.version);
  });

  test("refuses a package version that is not a release version", () => {
    expect(() => releaseFrom("next")).toThrow("package.json version must be a release version");
  });
});
