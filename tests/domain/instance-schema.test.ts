import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import example from "../../examples/factory.json";
import schema from "../../schemas/factory.schema.json";
import { parseFactoryInstance } from "../../src/domain/instance";

// The published JSON Schema serves editors; the domain validator is authoritative.
// These cases keep their structural rules in agreement.
const schemaAccepts = new Ajv2020({ allErrors: true }).compile(schema);

const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:x-AbCdEf";
const repository = { key: "r", remote: "https://github.com/a/b.git", path: "r", branch: "main" };

const valid: Record<string, unknown>[] = [
  { schema_version: 1 },
  example,
  {
    schema_version: 1,
    network: { vpc_cidr: "0.0.0.0/0", public_subnet_cidr: "255.255.255.255/32" },
  },
  { schema_version: 1, network: { vpc_cidr: "010.001.0.09/9", public_subnet_cidr: "10.0.0.0/19" } },
  { schema_version: 1, repositories: [{ ...repository, path: "a/b.c/..d" }] },
  { schema_version: 1, hosts: [{ key: "a", paseo_password_secret: ARN, repositories: [] }] },
  {
    schema_version: 1,
    hosts: [
      {
        key: "a",
        dispatch: {
          enabled: true,
          cron: "* * * * *",
          timezone: "UTC",
          provider: "codex",
          model: "configured",
          mode: "default",
          cwd: "/srv/factory work",
        },
      },
    ],
  },
];

const invalid: Record<string, unknown>[] = [
  {},
  { schema_version: 2 },
  { schema_version: 1, extra: true },
  { schema_version: 1, constructor: 1 },
  { schema_version: 1, toString: "x" },
  JSON.parse('{"schema_version":1,"__proto__":{"a":1}}'),
  { schema_version: 1, hosts: [{ key: "a", hasOwnProperty: "x" }] },
  { schema_version: 1, network: { valueOf: "x" } },
  JSON.parse('{"schema_version":1,"hosts":[{"key":"a","__proto__":{"a":1}}]}'),
  { schema_version: 1, release: "v1" },
  { schema_version: 1, factory_id: "ab" },
  { schema_version: 1, factory_id: "a".repeat(21) },
  { schema_version: 1, factory_id: "bad-" },
  { schema_version: 1, name: " " },
  { schema_version: 1, aws: { account_id: "1234567890123" } },
  { schema_version: 1, aws: { region: "useast1" } },
  { schema_version: 1, state_backend: { bucket: "a" } },
  { schema_version: 1, network: { vpc_cidr: "256.0.0.0/8" } },
  { schema_version: 1, network: { vpc_cidr: "10.0.0.0/33" } },
  { schema_version: 1, network: { vpc_cidr: "10.0.0.0/08" } },
  { schema_version: 1, network: { vpc_cidr: "10.0.0.0/00" } },
  { schema_version: 1, network: { vpc_cidr: "0010.0.0.0/8" } },
  { schema_version: 1, network: { vpc_cidr: "10.0.0.0/032" } },
  { schema_version: 1, network: { availability_zone: "us-east-1" } },
  { schema_version: 1, tailscale: { tag: "tag:" } },
  { schema_version: 1, tailscale: { auth_key_secret: "tskey-auth-abc" } },
  { schema_version: 1, repositories: [{ key: "r" }] },
  { schema_version: 1, repositories: [{ ...repository, path: "../r" }] },
  { schema_version: 1, repositories: [{ ...repository, path: "a/./b" }] },
  { schema_version: 1, repositories: [{ ...repository, remote: "https://gitlab.com/a/b" }] },
  { schema_version: 1, hosts: [{}] },
  { schema_version: 1, hosts: [{ key: "a", root_volume_gib: 8.5 }] },
  { schema_version: 1, hosts: [{ key: "a", paseo_password_secret: "hunter2" }] },
  { schema_version: 1, hosts: [{ key: "a", dispatch: { enabled: 1 } }] },
  { schema_version: 1, hosts: [{ key: "a", dispatch: { cwd: "home/factory" } }] },
];

describe("schemas/factory.schema.json", () => {
  test.each(valid.map((document) => [JSON.stringify(document), document]))(
    "agrees %s is valid",
    (_label, document) => {
      expect(schemaAccepts(document)).toBe(true);
      expect(parseFactoryInstance(document).valid).toBe(true);
    },
  );

  test.each(invalid.map((document) => [JSON.stringify(document), document]))(
    "agrees %s is invalid",
    (_label, document) => {
      expect(schemaAccepts(document)).toBe(false);
      expect(parseFactoryInstance(document).valid).toBe(false);
    },
  );
});
