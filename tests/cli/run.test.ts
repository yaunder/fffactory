import { describe, expect, test } from "bun:test";
import type { InstanceStore } from "../../src/application/instance-store";
import { run, waitsOnInterrupt } from "../../src/cli/run";
import { harness } from "../support/cli-harness";
import { MemoryInstanceStore } from "../support/memory-instance-store";

const NEAREST = "/work/repo/.fffactory/factory.json";

describe("fffactory validate", () => {
  test("reports a valid partial instance, its source and what is still missing", async () => {
    const { context, out, err } = harness(
      new MemoryInstanceStore({ [NEAREST]: '{"schema_version": 1}' }),
    );
    expect(await run(["validate"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe(`Instance: ${NEAREST} (nearest .fffactory/factory.json)`);
    expect(out).toContain("Valid factory.json (schema version 1).");
    expect(out).toContain("Incomplete: 12 fields still needed:");
    expect(out).toContain("  tailscale.auth_key_secret");
  });

  test("reports a complete instance", async () => {
    const document = await Bun.file("examples/factory.json").text();
    const { context, out } = harness(new MemoryInstanceStore({ "/x/factory.json": document }));
    expect(await run(["validate", "--instance", "/x/factory.json"], context)).toBe(0);
    expect(out).toContain("Complete: nothing further is needed.");
  });

  test("honours FFFACTORY_INSTANCE", async () => {
    const store = new MemoryInstanceStore({ "/env/factory.json": '{"schema_version": 1}' });
    const { context, out } = harness(store, { FFFACTORY_INSTANCE: "/env/factory.json" });
    expect(await run(["validate"], context)).toBe(0);
    expect(out[0]).toBe("Instance: /env/factory.json (FFFACTORY_INSTANCE)");
  });

  test("fails with field paths for an invalid instance", async () => {
    const store = new MemoryInstanceStore({
      [NEAREST]: '{"schema_version": 1, "factory_id": "X"}',
    });
    const { context, err } = harness(store);
    expect(await run(["validate"], context)).toBe(1);
    expect(err).toContain("Invalid factory.json:");
    expect(err.some((line) => line.startsWith("  factory_id: must be"))).toBe(true);
  });

  test("fails with an initialization instruction when no instance exists", async () => {
    const { context, err } = harness(new MemoryInstanceStore());
    expect(await run(["validate"], context)).toBe(1);
    expect(err.join("\n")).toContain("fffactory init");
  });

  test("fails when the instance cannot be read", async () => {
    const store: InstanceStore = {
      isFile: async () => true,
      read: async () => {
        throw new Error("EACCES: permission denied");
      },
      write: async () => {
        throw new Error("validate must not write");
      },
    };
    const { context, err } = harness(store);
    expect(await run(["validate"], context)).toBe(1);
    expect(err).toEqual(["fffactory: EACCES: permission denied"]);
  });

  test("rejects unexpected arguments", async () => {
    const { context, err } = harness(new MemoryInstanceStore());
    expect(await run(["validate", "--bogus"], context)).toBe(1);
    expect(err[0]).toContain("--bogus");
  });
});

describe("fffactory", () => {
  test("prints the running release for --version", async () => {
    const { context, out, err } = harness(new MemoryInstanceStore());
    expect(await run(["--version"], context)).toBe(0);
    expect(out).toEqual(["0.3.0"]);
    expect(err).toEqual([]);
  });

  test("rejects arguments after --version", async () => {
    const { context, out, err } = harness(new MemoryInstanceStore());
    expect(await run(["--version", "extra"], context)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["fffactory: --version takes no arguments"]);
  });

  test("prints usage for --help", async () => {
    const { context, out } = harness(new MemoryInstanceStore());
    expect(await run(["--help"], context)).toBe(0);
    expect(out.join("\n")).toContain("validate");
    expect(out.join("\n")).toContain("init");
  });

  test("prints usage for a command's --help", async () => {
    const { context, out } = harness(new MemoryInstanceStore());
    expect(await run(["validate", "--help"], context)).toBe(0);
    expect(out.join("\n")).toContain("--instance PATH");
  });

  test("fails with usage when no command is given", async () => {
    const { context, err } = harness(new MemoryInstanceStore());
    expect(await run([], context)).toBe(1);
    expect(err.join("\n")).toContain("Usage: fffactory <command>");
  });

  test("fails for an unknown command", async () => {
    const { context, err } = harness(new MemoryInstanceStore());
    expect(await run(["deploy"], context)).toBe(1);
    expect(err[0]).toBe('fffactory: unknown command "deploy"');
  });
});

describe("which commands wait on an interrupt (plan-apply §Interruption)", () => {
  test("apply, upgrade, doctor and status report what an interrupt left, so they wait", () => {
    for (const name of ["apply", "upgrade", "doctor", "status"])
      expect(waitsOnInterrupt([name, "--instance", "/x/factory.json"])).toBe(true);
  });

  test("every other command exits once its tools stop, never waiting for it", () => {
    for (const argv of [
      ["host", "apply"],
      ["host", "inspect"],
      ["host", "verify"],
      ["secret", "set", "tailscale.auth_key_secret"],
      ["lock", "break", "--lock-id", "x"],
      ["init"],
      ["validate"],
      ["plan"],
      ["assets"],
      ["--version"],
      ["--help"],
      ["unknown"],
      ["hasOwnProperty"],
      [],
    ])
      expect(waitsOnInterrupt(argv)).toBe(false);
  });
});
