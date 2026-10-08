import { describe, expect, test } from "bun:test";
import { run } from "../../src/cli/run";
import { harness } from "../support/cli-harness";
import { fakeAssetBundle } from "../support/doctor-fakes";
import { MemoryInstanceStore } from "../support/memory-instance-store";

describe("fffactory assets", () => {
  test("materializes this release's assets in the cache and prints their directory", async () => {
    const assets = fakeAssetBundle();
    const { context, out, err } = harness(new MemoryInstanceStore(), {}, { assets: assets.bundle });
    expect(await run(["assets"], context)).toBe(0);
    expect(assets.materialized).toEqual(["/home/operator/.cache/fffactory/releases/0.3.0"]);
    expect(out).toEqual(["/home/operator/.cache/fffactory/releases/0.3.0"]);
    expect(err).toEqual([]);
  });

  test("uses the XDG cache directory when XDG_CACHE_HOME is set", async () => {
    const assets = fakeAssetBundle();
    const { context } = harness(
      new MemoryInstanceStore(),
      { XDG_CACHE_HOME: "/xdg" },
      { assets: assets.bundle },
    );
    expect(await run(["assets"], context)).toBe(0);
    expect(assets.materialized).toEqual(["/xdg/fffactory/releases/0.3.0"]);
  });

  test("exits 1 with the reason when the bundle cannot be materialized", async () => {
    const { context, out, err } = harness(
      new MemoryInstanceStore(),
      {},
      {
        assets: {
          inspect: async () => "tampered",
          materialize: async () => {
            throw new Error("The embedded release assets do not match their recorded digest");
          },
          workerRelease: async () => undefined,
        },
      },
    );
    expect(await run(["assets"], context)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "fffactory: The embedded release assets do not match their recorded digest",
    ]);
  });

  test("rejects arguments", async () => {
    const assets = fakeAssetBundle();
    const { context, err } = harness(new MemoryInstanceStore(), {}, { assets: assets.bundle });
    expect(await run(["assets", "extra"], context)).toBe(1);
    expect(err[0]).toContain("extra");
    expect(assets.materialized).toEqual([]);
  });

  test("is listed in usage", async () => {
    const { context, out } = harness(new MemoryInstanceStore());
    expect(await run(["--help"], context)).toBe(0);
    expect(out.some((line) => line.trimStart().startsWith("assets "))).toBe(true);
  });
});
