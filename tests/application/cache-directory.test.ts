import { describe, expect, test } from "bun:test";
import { cacheDirectoryPath } from "../../src/application/cache-directory";

const HOME = "/home/operator";

describe("cacheDirectoryPath", () => {
  test("defaults to ~/.cache/fffactory", () => {
    expect(cacheDirectoryPath({}, HOME)).toBe("/home/operator/.cache/fffactory");
  });

  test("uses an absolute XDG_CACHE_HOME", () => {
    expect(cacheDirectoryPath({ XDG_CACHE_HOME: "/var/cache/me" }, HOME)).toBe(
      "/var/cache/me/fffactory",
    );
  });

  test("ignores an empty or relative XDG_CACHE_HOME, as the XDG specification requires", () => {
    expect(cacheDirectoryPath({ XDG_CACHE_HOME: "" }, HOME)).toBe(
      "/home/operator/.cache/fffactory",
    );
    expect(cacheDirectoryPath({ XDG_CACHE_HOME: "cache" }, HOME)).toBe(
      "/home/operator/.cache/fffactory",
    );
  });
});
