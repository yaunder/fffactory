/**
 * The install lock `host apply` holds while it installs (host protocol §apply): an exclusive
 * `flock` taken without waiting, released when its holder ends, and never inherited by the
 * steps it runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { flockExclusive } from "../../src/host/install-lock";
import { bunProcessRunner } from "../../src/infrastructure/local-tool-probe";

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fffactory-lock-"));
  path = join(directory, "host-apply.lock");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the install lock", () => {
  test("is taken by one holder at a time, without waiting, until it is released", async () => {
    const first = await flockExclusive(path);
    expect(first).toBeDefined();
    expect(await flockExclusive(path)).toBeUndefined();
    first?.release();
    const second = await flockExclusive(path);
    expect(second).toBeDefined();
    second?.release();
  });

  test("is held against another process", async () => {
    const held = await flockExclusive(path);
    const script = [
      `const { flockExclusive } = await import(${JSON.stringify(join(import.meta.dir, "../../src/host/install-lock.ts"))});`,
      `console.log((await flockExclusive(${JSON.stringify(path)})) === undefined ? "busy" : "taken");`,
    ].join("\n");
    const other = await bunProcessRunner([process.execPath, "-e", script], 10_000);
    held?.release();
    expect(other).toMatchObject({ kind: "exited", exitCode: 0, stdout: "busy\n" });
  });

  test.skipIf(platform() !== "linux")(
    "is never inherited by a command its holder runs",
    async () => {
      const held = await flockExclusive(path);
      const outcome = await bunProcessRunner(["/bin/sh", "-c", "ls -l /proc/$$/fd"], 5000);
      held?.release();
      expect(outcome.kind === "exited" && outcome.stdout).not.toContain("host-apply.lock");
    },
  );
});
