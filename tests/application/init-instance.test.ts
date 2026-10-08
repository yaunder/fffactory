import { describe, expect, test } from "bun:test";
import { initInstance, initTarget } from "../../src/application/init-instance";
import { validateInstance } from "../../src/application/validate-instance";
import type { RandomBytes } from "../../src/domain/initialization";
import type { Release } from "../../src/domain/instance";
import { MemoryInstanceStore } from "../support/memory-instance-store";

const PATH = "/work/.fffactory/factory.json";
const RELEASE = "0.3.0" as Release;
const zeroes: RandomBytes = (count) => new Uint8Array(count);
const unusedRandom: RandomBytes = () => {
  throw new Error("randomness must not be drawn when a factory ID already exists");
};

function init(store: MemoryInstanceStore, randomBytes: RandomBytes = zeroes) {
  return initInstance({ store, randomBytes }, { path: PATH, release: RELEASE });
}

describe("initTarget", () => {
  test("defaults to ./.fffactory/factory.json under the current directory", () => {
    expect(initTarget("/work/repo")).toBe("/work/repo/.fffactory/factory.json");
  });

  test("resolves PATH, naming the document file, against the current directory", () => {
    expect(initTarget("/work/repo", "config/prod.json")).toBe("/work/repo/config/prod.json");
    expect(initTarget("/work/repo", "/etc/factory.json")).toBe("/etc/factory.json");
  });
});

describe("initInstance", () => {
  test("creates a valid partial document with a new factory ID and the release pin", async () => {
    const store = new MemoryInstanceStore();
    const result = await init(store);
    expect(result).toMatchObject({
      ok: true,
      outcome: "created",
      filled: ["release", "factory_id"],
    });
    expect(JSON.parse(store.files[PATH] ?? "")).toEqual({
      schema_version: 1,
      release: "0.3.0",
      factory_id: "fff-aaaaaaaa",
    });
    const validation = await validateInstance(store, PATH);
    expect(validation.valid).toBe(true);
  });

  test("writes formatted JSON ending in a newline", async () => {
    const store = new MemoryInstanceStore();
    await init(store);
    expect(store.files[PATH]).toBe(
      '{\n  "schema_version": 1,\n  "release": "0.3.0",\n  "factory_id": "fff-aaaaaaaa"\n}\n',
    );
  });

  test("reports the fields still missing through the completeness report", async () => {
    const result = await init(new MemoryInstanceStore());
    if (!result.ok) throw new Error("expected success");
    expect(result.completeness.missing).not.toContain("release");
    expect(result.completeness.missing).not.toContain("factory_id");
    expect(result.completeness.missing).toContain("name");
    expect(result.completeness.missing).toHaveLength(10);
  });

  test("a rerun on a partial document keeps every value and fills only the gaps", async () => {
    const existing = {
      schema_version: 1,
      factory_id: "yaunder-v2",
      name: "Yaunder",
      aws: { region: "us-east-1" },
      hosts: [{ key: "builder-1" }],
    };
    const store = new MemoryInstanceStore({ [PATH]: JSON.stringify(existing) });
    const result = await init(store, unusedRandom);
    expect(result).toMatchObject({ ok: true, outcome: "updated", filled: ["release"] });
    expect(JSON.parse(store.files[PATH] ?? "")).toEqual({ ...existing, release: "0.3.0" });
  });

  test("a rerun never replaces an existing release pin", async () => {
    const existing = '{"schema_version": 1, "release": "0.1.0"}';
    const store = new MemoryInstanceStore({ [PATH]: existing });
    const result = await init(store);
    expect(result).toMatchObject({ ok: true, outcome: "updated", filled: ["factory_id"] });
    expect(JSON.parse(store.files[PATH] ?? "").release).toBe("0.1.0");
  });

  test("a rerun with nothing to fill leaves the file untouched", async () => {
    const existing = '{"schema_version":1,"release":"0.1.0","factory_id":"yaunder-v2"}';
    const store = new MemoryInstanceStore({ [PATH]: existing });
    const result = await init(store, unusedRandom);
    expect(result).toMatchObject({ ok: true, outcome: "unchanged", filled: [] });
    expect(store.writes).toEqual([]);
    expect(store.files[PATH]).toBe(existing);
  });

  test("a second init after a fresh one changes nothing, including the factory ID", async () => {
    const store = new MemoryInstanceStore();
    await init(store);
    const first = store.files[PATH];
    expect(await init(store, unusedRandom)).toMatchObject({ ok: true, outcome: "unchanged" });
    expect(store.files[PATH]).toBe(first);
  });

  test("refuses an invalid existing document with field paths and does not overwrite it", async () => {
    const existing = '{"schema_version": 1, "factory_id": "X", "__proto__": {}}';
    const store = new MemoryInstanceStore({ [PATH]: existing });
    const result = await init(store);
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: "__proto__", message: "is not a recognized field" },
        { path: "factory_id", message: expect.stringContaining("lowercase") },
      ],
    });
    expect(store.writes).toEqual([]);
    expect(store.files[PATH]).toBe(existing);
  });

  test("refuses an existing file that is not JSON without echoing it", async () => {
    const store = new MemoryInstanceStore({ [PATH]: "tskey-auth-secret" });
    expect(await init(store)).toEqual({
      ok: false,
      issues: [{ path: "(root)", message: "is not valid JSON" }],
    });
    expect(store.writes).toEqual([]);
  });
});
