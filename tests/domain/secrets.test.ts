import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import type { FactoryInstance, SecretReference } from "../../src/domain/instance";
import { parseFactoryInstance } from "../../src/domain/instance";
import {
  MAX_SECRET_BYTES,
  readSecretMaterial,
  resolveSecretTarget,
  SecretMaterial,
  secretReference,
  secretTags,
  withSecretReference,
} from "../../src/domain/secrets";

const VALUE = "tskey-auth-kSECRETVALUE-0123456789";
const ARN =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/tailscale-auth-key-AbCdEf" as SecretReference;
const PASEO_ARN =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/builder-2/paseo-password-AbCdEf" as SecretReference;

function instance(document: Record<string, unknown>): FactoryInstance {
  const parsed = parseFactoryInstance({ schema_version: 1, ...document });
  if (!parsed.valid) throw new Error(JSON.stringify(parsed.issues));
  return parsed.instance;
}

const FACTORY = instance({
  factory_id: "fff-abcd1234",
  name: "Test",
  tailscale: { tag: "tag:factory" },
  hosts: [{ key: "builder-1" }, { key: "builder-2", instance_type: "m7i.large" }],
});

describe("SecretMaterial", () => {
  test("never shows its value when printed, interpolated, inspected or serialized", () => {
    const material = new SecretMaterial(VALUE);
    expect(material.reveal()).toBe(VALUE);
    expect(`${material}`).toBe("[secret]");
    expect(String(material)).toBe("[secret]");
    expect(JSON.stringify({ material })).toBe('{"material":"[secret]"}');
    expect(inspect(material)).toBe("[secret]");
    expect(Object.keys(material)).toEqual([]);
  });
});

describe("readSecretMaterial", () => {
  test("a hidden prompt's answer is taken as typed", () => {
    const read = readSecretMaterial(` ${VALUE} `, "prompt");
    expect(read.ok && read.material.reveal()).toBe(` ${VALUE} `);
  });

  test.each([
    [`${VALUE}\n`, VALUE],
    [`${VALUE}\r\n`, VALUE],
    [`${VALUE}\n\n`, `${VALUE}\n`],
    [VALUE, VALUE],
  ])("standard input drops one final line ending", (raw, expected) => {
    const read = readSecretMaterial(raw, "input");
    expect(read.ok && read.material.reveal()).toBe(expected);
  });

  test.each([
    ["", "prompt"],
    ["   ", "prompt"],
    ["\n", "input"],
  ] as const)("empty material %j from %s is refused", (raw, source) => {
    expect(readSecretMaterial(raw, source)).toEqual({ ok: false, reason: "empty" });
  });

  test("material over Secrets Manager's size limit is refused, counted in UTF-8 bytes", () => {
    expect(readSecretMaterial("a".repeat(MAX_SECRET_BYTES), "prompt").ok).toBe(true);
    expect(readSecretMaterial("é".repeat(MAX_SECRET_BYTES / 2 + 1), "prompt")).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});

describe("resolveSecretTarget", () => {
  test("the Tailscale auth key goes to tailscale.auth_key_secret, named under the factory ID", () => {
    expect(resolveSecretTarget(FACTORY, "tailscale-auth-key", undefined) as unknown).toEqual({
      ok: true,
      target: {
        name: "tailscale-auth-key",
        field: "tailscale.auth_key_secret",
        secretName: "fff-abcd1234/tailscale-auth-key",
        description: "Tailscale auth key of factory fff-abcd1234",
        factoryId: "fff-abcd1234",
      },
    });
  });

  test("a Paseo password goes to its host's paseo_password_secret", () => {
    expect(resolveSecretTarget(FACTORY, "paseo-password", "builder-2") as unknown).toEqual({
      ok: true,
      target: {
        name: "paseo-password",
        field: "hosts[1].paseo_password_secret",
        secretName: "fff-abcd1234/builder-2/paseo-password",
        description: "Paseo password of host builder-2 of factory fff-abcd1234",
        factoryId: "fff-abcd1234",
        hostKey: "builder-2",
      },
    });
  });

  test.each([
    [
      "an unknown name, never echoed",
      FACTORY,
      VALUE,
      undefined,
      "unknown secret name; expected tailscale-auth-key or paseo-password",
    ],
    [
      "a factory without an ID",
      instance({}),
      "tailscale-auth-key",
      undefined,
      "factory.json needs factory_id before a secret can be named",
    ],
    [
      "a host for the factory-wide key",
      FACTORY,
      "tailscale-auth-key",
      "builder-1",
      "tailscale-auth-key belongs to the whole factory and takes no --host",
    ],
    [
      "a Paseo password without a host",
      FACTORY,
      "paseo-password",
      undefined,
      "paseo-password belongs to one host: name it with --host KEY",
    ],
    [
      "a malformed host key, never echoed",
      FACTORY,
      "paseo-password",
      VALUE,
      "--host must be a host key declared in factory.json",
    ],
    [
      "an undeclared host",
      FACTORY,
      "paseo-password",
      "builder-9",
      'host "builder-9" is not declared in factory.json',
    ],
  ])("refuses %s", (_, factory, name, host, message) => {
    expect(resolveSecretTarget(factory, name, host)).toEqual({ ok: false, message });
  });
});

describe("secret references in factory.json", () => {
  test("setting the Tailscale reference keeps every other field and their order", () => {
    const target = resolveSecretTarget(FACTORY, "tailscale-auth-key", undefined);
    if (!target.ok) throw new Error(target.message);
    expect(secretReference(FACTORY, target.target)).toBeUndefined();
    const updated = withSecretReference(FACTORY, target.target, ARN);
    expect(updated.tailscale).toEqual({ tag: "tag:factory", auth_key_secret: ARN });
    expect(Object.keys(updated)).toEqual(Object.keys(FACTORY));
    expect(updated.hosts).toEqual(FACTORY.hosts);
    expect(FACTORY.tailscale?.auth_key_secret).toBeUndefined();
    expect(secretReference(updated, target.target)).toBe(ARN);
    expect(parseFactoryInstance(updated).valid).toBe(true);
  });

  test("a factory without a tailscale block gets one", () => {
    const bare = instance({ factory_id: "fff-abcd1234" });
    const target = resolveSecretTarget(bare, "tailscale-auth-key", undefined);
    if (!target.ok) throw new Error(target.message);
    expect(withSecretReference(bare, target.target, ARN).tailscale).toEqual({
      auth_key_secret: ARN,
    });
  });

  test("setting a Paseo reference changes only that host", () => {
    const target = resolveSecretTarget(FACTORY, "paseo-password", "builder-2");
    if (!target.ok) throw new Error(target.message);
    const updated = withSecretReference(FACTORY, target.target, PASEO_ARN);
    expect(updated.hosts as unknown).toEqual([
      { key: "builder-1" },
      { key: "builder-2", instance_type: "m7i.large", paseo_password_secret: PASEO_ARN },
    ]);
    expect(secretReference(updated, target.target)).toBe(PASEO_ARN);
    expect(
      secretReference(instance({ factory_id: "fff-abcd1234" }), target.target),
    ).toBeUndefined();
  });

  test("secrets carry the factory ID and managed-by tags", () => {
    expect(secretTags(FACTORY.factory_id as never)).toEqual({
      "fffactory:factory-id": "fff-abcd1234",
      "fffactory:managed-by": "fffactory",
    });
  });
});
