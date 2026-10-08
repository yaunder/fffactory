import { describe, expect, test } from "bun:test";
import { run } from "../../src/cli/run";
import { harness } from "../support/cli-harness";
import { MemoryInstanceStore } from "../support/memory-instance-store";

const DEFAULT_PATH = "/work/repo/.fffactory/factory.json";

describe("fffactory init", () => {
  test("creates ./.fffactory/factory.json and lists what is still missing", async () => {
    const store = new MemoryInstanceStore();
    const { context, out, err } = harness(store);
    expect(await run(["init"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out.slice(0, 3)).toEqual([
      `Created ${DEFAULT_PATH}.`,
      "  New factory ID: fff-aaaaaaaa",
      "  Release pin: 0.3.0",
    ]);
    expect(out).toContain("Incomplete: 10 fields still needed:");
    expect(out).toContain("  name");
    expect(out).not.toContain("  factory_id");
  });

  test("a freshly initialized instance passes validate", async () => {
    const store = new MemoryInstanceStore();
    expect(await run(["init"], harness(store).context)).toBe(0);
    const { context, out } = harness(store);
    expect(await run(["validate"], context)).toBe(0);
    expect(out).toContain("Valid factory.json (schema version 1).");
  });

  test("PATH names the document file and resolves against the current directory", async () => {
    const store = new MemoryInstanceStore();
    const { context, out } = harness(store);
    expect(await run(["init", "config/prod.json"], context)).toBe(0);
    expect(out[0]).toBe("Created /work/repo/config/prod.json.");
    expect(Object.keys(store.files)).toEqual(["/work/repo/config/prod.json"]);
  });

  test("a rerun fills only the gaps and reports what it filled", async () => {
    const store = new MemoryInstanceStore({
      [DEFAULT_PATH]: '{"schema_version": 1, "factory_id": "yaunder-v2", "name": "Yaunder"}',
    });
    const { context, out } = harness(store);
    expect(await run(["init"], context)).toBe(0);
    expect(out.slice(0, 2)).toEqual([`Updated ${DEFAULT_PATH}.`, "  Release pin: 0.3.0"]);
    expect(JSON.parse(store.files[DEFAULT_PATH] ?? "").factory_id).toBe("yaunder-v2");
  });

  test("a rerun with nothing to fill says so and writes nothing", async () => {
    const existing = '{"schema_version": 1, "release": "0.1.0", "factory_id": "yaunder-v2"}';
    const store = new MemoryInstanceStore({ [DEFAULT_PATH]: existing });
    const { context, out } = harness(store);
    expect(await run(["init"], context)).toBe(0);
    expect(out[0]).toBe(`Unchanged ${DEFAULT_PATH}: nothing to fill.`);
    expect(store.writes).toEqual([]);
  });

  test("refuses an invalid existing document with field paths", async () => {
    const existing = '{"schema_version": 1, "factory_id": "X"}';
    const store = new MemoryInstanceStore({ [DEFAULT_PATH]: existing });
    const { context, out, err } = harness(store);
    expect(await run(["init"], context)).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toBe(`Refusing to change ${DEFAULT_PATH}: it is not a valid factory.json.`);
    expect(err.some((line) => line.startsWith("  factory_id: must be"))).toBe(true);
    expect(store.files[DEFAULT_PATH]).toBe(existing);
  });

  test("accepts at most one PATH", async () => {
    const { context, err } = harness(new MemoryInstanceStore());
    expect(await run(["init", "a.json", "b.json"], context)).toBe(1);
    expect(err).toEqual(["fffactory init: expected at most one PATH"]);
  });

  test("rejects unknown options", async () => {
    const { context, err } = harness(new MemoryInstanceStore());
    expect(await run(["init", "--profile", "x"], context)).toBe(1);
    expect(err[0]).toContain("--profile");
  });

  test("prints its usage for --help", async () => {
    const { context, out } = harness(new MemoryInstanceStore());
    expect(await run(["init", "--help"], context)).toBe(0);
    expect(out[0]).toBe("Usage: fffactory init [PATH]");
  });
});
