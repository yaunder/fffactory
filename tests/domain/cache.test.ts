import { describe, expect, test } from "bun:test";
import { cacheDirectoryCheck } from "../../src/domain/cache";

const PATH = "/home/operator/.cache/fffactory";

describe("cache directory check", () => {
  test("an absent directory is ready: FFFactory creates it when first needed", () => {
    const check = cacheDirectoryCheck(PATH, "absent");
    expect(check).toMatchObject({ id: "cache_directory", status: "ready", nextAction: null });
    expect(check.summary).toBe(
      `${PATH} does not exist yet; FFFactory creates it when first needed`,
    );
  });

  test("a writable directory is ready", () => {
    expect(cacheDirectoryCheck(PATH, "writable")).toMatchObject({
      status: "ready",
      summary: `${PATH} is a writable directory`,
    });
  });

  test("a directory that cannot be written is not ready", () => {
    const check = cacheDirectoryCheck(PATH, "not_writable");
    expect(check.status).toBe("not_ready");
    expect(check.nextAction).toContain(`chmod u+rwx ${PATH}`);
  });

  test("a path that is not a directory is not ready", () => {
    const check = cacheDirectoryCheck(PATH, "not_directory");
    expect(check.status).toBe("not_ready");
    expect(check.nextAction).toContain(`Move or remove ${PATH}`);
  });
});
