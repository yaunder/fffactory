import { describe, expect, test } from "bun:test";
import { type InstanceSelection, resolveInstance } from "../../src/application/resolve-instance";
import { MemoryInstanceStore } from "../support/memory-instance-store";

const DOCUMENT = '{"schema_version": 1}';
const HOME = "/home/operator";
const CWD = "/work/repo/src";
const NEAREST = "/work/repo/.fffactory/factory.json";
const HOME_INSTANCE = "/home/operator/.fffactory/factory.json";

function select(overrides: Partial<InstanceSelection> = {}): InstanceSelection {
  return { cwd: CWD, home: HOME, ...overrides };
}

function storeWith(...paths: string[]): MemoryInstanceStore {
  return new MemoryInstanceStore(Object.fromEntries(paths.map((path) => [path, DOCUMENT])));
}

const everyLevel = storeWith("/flag/factory.json", "/env/factory.json", NEAREST, HOME_INSTANCE);

describe("resolveInstance precedence", () => {
  test("1. --instance PATH wins over every other source", async () => {
    const selection = select({ flag: "/flag/factory.json", environment: "/env/factory.json" });
    expect(await resolveInstance(everyLevel, selection)).toEqual({
      found: true,
      path: "/flag/factory.json",
      source: "--instance",
    });
  });

  test("2. FFFACTORY_INSTANCE wins when no --instance is given", async () => {
    const selection = select({ environment: "/env/factory.json" });
    expect(await resolveInstance(everyLevel, selection)).toEqual({
      found: true,
      path: "/env/factory.json",
      source: "FFFACTORY_INSTANCE",
    });
  });

  test("3. the nearest .fffactory/factory.json searching upward wins next", async () => {
    expect(await resolveInstance(everyLevel, select())).toEqual({
      found: true,
      path: NEAREST,
      source: "nearest",
    });
  });

  test("4. ~/.fffactory/factory.json is used when nothing closer exists", async () => {
    expect(await resolveInstance(storeWith(HOME_INSTANCE), select())).toEqual({
      found: true,
      path: HOME_INSTANCE,
      source: "home",
    });
  });

  test("5. otherwise resolution fails with an initialization instruction", async () => {
    const result = await resolveInstance(storeWith(), select());
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.message).toContain("No factory instance found");
    expect(result.message).toContain("fffactory init");
    expect(result.message).toContain("--instance PATH");
    expect(result.message).toContain("FFFACTORY_INSTANCE");
  });
});

describe("resolveInstance details", () => {
  test("the upward search prefers the closest directory", async () => {
    const closer = "/work/repo/src/.fffactory/factory.json";
    const result = await resolveInstance(storeWith(NEAREST, closer), select());
    expect(result).toMatchObject({ found: true, path: closer });
  });

  test("the upward search reaches the filesystem root", async () => {
    const result = await resolveInstance(storeWith("/.fffactory/factory.json"), select());
    expect(result).toMatchObject({ found: true, path: "/.fffactory/factory.json" });
  });

  test("a v1 .fffactory directory without factory.json is skipped", async () => {
    const store = storeWith(
      "/work/repo/src/.fffactory/config.json",
      "/work/repo/src/.fffactory/infrastructure.tfvars",
      NEAREST,
    );
    expect(await resolveInstance(store, select())).toMatchObject({ found: true, path: NEAREST });
  });

  test("a relative --instance PATH resolves against the working directory", async () => {
    const store = storeWith("/work/repo/src/custom/factory.json");
    const result = await resolveInstance(store, select({ flag: "custom/factory.json" }));
    expect(result).toMatchObject({ found: true, path: "/work/repo/src/custom/factory.json" });
  });

  test("a missing --instance PATH is an error, never a fallback", async () => {
    const result = await resolveInstance(everyLevel, select({ flag: "/missing/factory.json" }));
    expect(result).toEqual({
      found: false,
      path: "/missing/factory.json",
      message: "--instance names /missing/factory.json, which is not a file",
    });
  });

  test("a missing FFFACTORY_INSTANCE path is an error, never a fallback", async () => {
    const result = await resolveInstance(everyLevel, select({ environment: "/missing.json" }));
    expect(result).toEqual({
      found: false,
      path: "/missing.json",
      message: "FFFACTORY_INSTANCE names /missing.json, which is not a file",
    });
  });

  test("an empty FFFACTORY_INSTANCE is treated as unset", async () => {
    const result = await resolveInstance(everyLevel, select({ environment: "" }));
    expect(result).toMatchObject({ found: true, source: "nearest" });
  });

  test("resolution reads no instance contents", async () => {
    const store = storeWith(NEAREST);
    await resolveInstance(store, select());
    expect(store.reads).toEqual([]);
  });
});
