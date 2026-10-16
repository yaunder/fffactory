import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type DescriptorIo,
  descriptorOutput,
  systemDescriptorIo,
} from "../../src/cli/descriptor-lines";

/** A descriptor that accepts at most `accepts[n]` bytes on the nth write, or throws `code`. */
function scriptedDescriptor(steps: readonly (number | string)[]) {
  const written: number[] = [];
  const calls: { fd: number; length: number }[] = [];
  let waits = 0;
  let step = 0;
  const io: DescriptorIo = {
    write(fd, bytes, offset, length) {
      calls.push({ fd, length });
      const next = steps[step++] ?? length;
      if (typeof next === "string") throw Object.assign(new Error(next), { code: next });
      const count = Math.min(next, length);
      written.push(...bytes.subarray(offset, offset + count));
      return count;
    },
    async wait() {
      waits++;
    },
  };
  return {
    io,
    calls,
    text: () => new TextDecoder().decode(new Uint8Array(written)),
    waits: () => waits,
  };
}

describe("descriptorOutput (cli-output §Plain output)", () => {
  test("writes each line and its newline to its descriptor, as given", () => {
    const descriptor = scriptedDescriptor([]);
    const line = descriptorOutput(descriptor.io).lines(2);
    line("\x1b[1mRefusing\x1b[22m to plan: %s");
    line("");
    expect(descriptor.text()).toBe("\x1b[1mRefusing\x1b[22m to plan: %s\n\n");
    expect(descriptor.calls.map((call) => call.fd)).toEqual([2, 2]);
  });

  test("finishes a line a write took only part of, even inside a character", () => {
    const descriptor = scriptedDescriptor([3, 1, 2]);
    descriptorOutput(descriptor.io).lines(1)("✔ ready ✖");
    expect(descriptor.text()).toBe("✔ ready ✖\n");
  });

  test("waits while the descriptor is full (EAGAIN) and retries an interrupted write", async () => {
    const descriptor = scriptedDescriptor([4, "EAGAIN", "EAGAIN", "EINTR", 2]);
    const output = descriptorOutput(descriptor.io);
    output.lines(1)("Applying workers");
    await output.flush();
    expect(descriptor.text()).toBe("Applying workers\n");
    expect(descriptor.waits()).toBe(3);
  });

  test("waits after a write that took nothing, rather than retrying at once", async () => {
    const descriptor = scriptedDescriptor([0, 0, 5]);
    const output = descriptorOutput(descriptor.io);
    output.lines(1)("ready");
    await output.flush();
    expect(descriptor.text()).toBe("ready\n");
    expect(descriptor.waits()).toBe(2);
  });

  test("stops writing a stream whose reader is gone, without throwing", () => {
    for (const code of ["EPIPE", "EBADF"]) {
      const descriptor = scriptedDescriptor([2, code]);
      const line = descriptorOutput(descriptor.io).lines(1);
      line("first");
      line("second");
      expect(descriptor.text()).toBe("fi");
      expect(descriptor.calls).toHaveLength(2);
    }
  });
});

describe("descriptorOutput cancellation", () => {
  test("releases pending flushes and drops queued and future lines", async () => {
    const descriptor = scriptedDescriptor(["EAGAIN"]);
    let resume!: () => void;
    const output = descriptorOutput({
      ...descriptor.io,
      wait: () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    });
    output.lines(1)("blocked");
    output.lines(2)("queued");
    const first = output.flush();
    const second = output.flush();
    output.cancel();
    await Promise.all([first, second]);
    output.lines(1)("later");
    resume();
    await output.flush();
    expect(descriptor.calls).toHaveLength(1);
    expect(descriptor.text()).toBe("");
  });

  test("a broken stdout does not discard stderr queued behind it", async () => {
    const descriptor = scriptedDescriptor(["EAGAIN", "EPIPE"]);
    const output = descriptorOutput(descriptor.io);
    output.lines(1)("broken");
    output.lines(2)("diagnostic");
    await output.flush();
    expect(descriptor.text()).toBe("diagnostic\n");
  });
});

describe("descriptorOutput over a real pipe", () => {
  const SCRIPT = resolve(import.meta.dir, "../support/descriptor-lines-main.ts");
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fffactory-lines-"));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** Runs the script under `sh` with `redirect` after it, and gives what `sh` printed. */
  function shell(args: string, redirect: string): string {
    const command = `'${process.execPath}' '${SCRIPT}' ${args} ${redirect}`;
    const result = Bun.spawnSync(["/bin/sh", "-c", command], {
      cwd: scratch,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  }

  test("loses nothing written before process.exit into a slow, non-blocking pipe", () => {
    // The script touches process.stdout and process.stderr as main.ts does, which makes
    // both pipes non-blocking, then writes far more than a pipe holds and flushes at exit.
    const counted = shell("large 700000 300000", `2>'${scratch}/err' | (sleep 0.3; wc -c)`);
    expect(Number(counted.trim())).toBe(700001);
    const errors = Bun.spawnSync(["wc", "-c", join(scratch, "err")]).stdout.toString();
    expect(Number(errors.trim().split(/\s+/)[0])).toBe(300001);
  });

  test("writes through the real descriptor by default, and waits a moment while it is full", async () => {
    const file = join(scratch, "lines");
    const fd = openSync(file, "w");
    try {
      const line = descriptorOutput().lines(fd);
      line("✔ ready");
      line("");
    } finally {
      closeSync(fd);
    }
    expect(await readFile(file, "utf8")).toBe("✔ ready\n\n");
    const before = performance.now();
    await systemDescriptorIo.wait();
    expect(performance.now() - before).toBeGreaterThanOrEqual(0.5);
  });

  test("a prompt and its echo follow the entire review before its result", () => {
    const merged = shell("prompt 700000", "2>&1 | (sleep 0.1; cat)");
    expect(merged.indexOf("PROMPT ")).toBe(700001);
    expect(merged.slice(700001)).toBe("PROMPT yes\nANSWER yes\n");
  });

  test("keeps the order of lines written to both streams on one pipe", () => {
    const merged = shell("alternate 20000", "2>&1 | (sleep 0.1; cat)");
    const expected = Array.from({ length: 20000 }, (_, n) => `${n % 2 ? "err" : "out"} ${n}\n`);
    expect(merged).toBe(expected.join(""));
  });
});
