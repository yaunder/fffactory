import { describe, expect, test } from "bun:test";
import {
  FACTORY_ID_PREFIX,
  fillMissing,
  generateFactoryId,
  type RandomBytes,
} from "../../src/domain/initialization";
import {
  type FactoryInstance,
  parseFactoryId,
  parseFactoryInstance,
  parseRelease,
} from "../../src/domain/instance";

/** Returns the given bytes in order, then fails, so a test pins exactly what generation consumes. */
function scripted(...bytes: number[]): RandomBytes {
  let offset = 0;
  return (count) => {
    if (offset + count > bytes.length) throw new Error("random source exhausted");
    const chunk = Uint8Array.from(bytes.slice(offset, offset + count));
    offset += count;
    return chunk;
  };
}

function seeded(seed: number): RandomBytes {
  let state = seed;
  return (count) =>
    Uint8Array.from({ length: count }, () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state >>> 16;
    });
}

describe("generateFactoryId", () => {
  test("maps random bytes onto lowercase letters and digits after the prefix", () => {
    expect(generateFactoryId(scripted(0, 1, 2, 25, 26, 35, 36, 71)) as string).toBe(
      `${FACTORY_ID_PREFIX}abcz09a9`,
    );
  });

  test("rejects bytes that would bias the alphabet and draws again", () => {
    expect(generateFactoryId(scripted(252, 253, 254, 255, 0, 0, 0, 0, 0, 0, 0, 0)) as string).toBe(
      `${FACTORY_ID_PREFIX}aaaaaaaa`,
    );
  });

  test("always produces an ID that parseFactoryId accepts", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const id = generateFactoryId(seeded(seed));
      expect(parseFactoryId(id)).toEqual({ ok: true, value: id });
    }
  });
});

describe("parseRelease", () => {
  test("accepts MAJOR.MINOR.PATCH with an optional prerelease", () => {
    expect(parseRelease("1.2.3").ok).toBe(true);
    expect(parseRelease("0.1.0-rc.1").ok).toBe(true);
  });

  test("rejects anything else", () => {
    expect(parseRelease("v1.2.3")).toEqual({
      ok: false,
      message: expect.stringContaining("1.2.3"),
    });
  });
});

const DEFAULTS = {
  schema_version: 1,
  release: "0.2.0",
  factory_id: "fff-defaults",
} as FactoryInstance;

describe("fillMissing", () => {
  test("keeps every existing value and fills only absent fields", () => {
    const existing = { schema_version: 1, factory_id: "yaunder-v2", name: "Yaunder" };
    const { instance, filled } = fillMissing(existing as FactoryInstance, DEFAULTS);
    expect(instance).toEqual({
      schema_version: 1,
      factory_id: "yaunder-v2",
      name: "Yaunder",
      release: "0.2.0",
    } as FactoryInstance);
    expect(filled).toEqual(["release"]);
  });

  test("keeps existing field order and appends filled fields", () => {
    const existing = { name: "Yaunder", schema_version: 1 } as FactoryInstance;
    expect(Object.keys(fillMissing(existing, DEFAULTS).instance)).toEqual([
      "name",
      "schema_version",
      "release",
      "factory_id",
    ]);
  });

  test("fills nested fields without replacing their siblings", () => {
    const existing = { schema_version: 1, aws: { region: "us-east-1" } } as FactoryInstance;
    const defaults = { schema_version: 1, aws: { account_id: "123456789012" } } as FactoryInstance;
    expect(fillMissing(existing, defaults)).toEqual({
      instance: { schema_version: 1, aws: { region: "us-east-1", account_id: "123456789012" } },
      filled: ["aws.account_id"],
    } as never);
  });

  test("treats arrays and scalars as set, never merging into them", () => {
    const existing = { schema_version: 1, hosts: [{ key: "a" }] } as unknown as FactoryInstance;
    const defaults = { schema_version: 1, hosts: [{ key: "b" }] } as unknown as FactoryInstance;
    expect(fillMissing(existing, defaults)).toEqual({ instance: existing, filled: [] });
  });

  test("reports nothing filled when every default is already present", () => {
    const existing = { ...DEFAULTS, release: "0.1.0", factory_id: "yaunder-v2" } as FactoryInstance;
    expect(fillMissing(existing, DEFAULTS)).toEqual({ instance: existing, filled: [] });
  });

  test("does not mutate its inputs", () => {
    const existing = { schema_version: 1, aws: { region: "us-east-1" } } as FactoryInstance;
    const defaults = { schema_version: 1, aws: { account_id: "123456789012" } } as FactoryInstance;
    const before = structuredClone(existing);
    fillMissing(existing, defaults);
    expect(existing).toEqual(before);
  });

  test("the result of filling a valid document with valid defaults is valid", () => {
    const existing = { schema_version: 1, name: "Yaunder" } as FactoryInstance;
    expect(parseFactoryInstance(fillMissing(existing, DEFAULTS).instance).valid).toBe(true);
  });

  test("copies a parsed __proto__ key as data and never pollutes a prototype", () => {
    const existing = JSON.parse('{"schema_version": 1, "__proto__": {"polluted": true}}');
    const defaults = JSON.parse(
      '{"__proto__": {"injected": true}, "aws": {"__proto__": {"x": 1}}}',
    );
    const { instance } = fillMissing(existing, defaults);
    const record = instance as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(instance)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(record.aws)).toBe(Object.prototype);
    expect(Object.hasOwn(record, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
    expect((record.aws as Record<string, unknown>).x).toBeUndefined();
  });
});
