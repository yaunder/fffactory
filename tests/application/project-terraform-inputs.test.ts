import { describe, expect, test } from "bun:test";
import example from "../../examples/factory.json";
import {
  projectBackendVariables,
  projectFactoryVariables,
} from "../../src/application/project-terraform-inputs";
import { type FactoryInstance, parseFactoryInstance } from "../../src/domain/instance";

const TAILSCALE = example.tailscale.auth_key_secret;
const PASEO = "arn:aws:secretsmanager:us-east-1:123456789012:secret:example/b-2/paseo-AbCdEf";

function instance(document: unknown = example): FactoryInstance {
  const parsed = parseFactoryInstance(document);
  if (!parsed.valid) throw new Error(JSON.stringify(parsed.issues));
  return parsed.instance;
}

function withHosts(hosts: unknown[]): FactoryInstance {
  return instance({ ...example, hosts });
}

describe("factory.json projected into the factory root module's variables", () => {
  test("a complete instance projects every variable the factory root module declares", () => {
    expect(projectFactoryVariables(instance(), [])).toEqual({
      ok: true,
      variables: {
        factory_id: "example",
        account_id: "123456789012",
        region: "us-east-1",
        availability_zone: "us-east-1a",
        vpc_cidr: "10.78.0.0/16",
        public_subnet_cidr: "10.78.1.0/24",
        tailscale_auth_key_secret_arn: TAILSCALE,
        tailscale_tag: "tag:software-factory",
        paseo_password_secret_arns: {
          "builder-1": example.hosts[0]?.paseo_password_secret as string,
        },
        hosts: { "builder-1": { instance_type: "m7i.xlarge", root_volume_gib: 200 } },
      },
    });
  });

  test("the Tailscale enrollment key is the factory's own reference from factory.json", () => {
    const own = "arn:aws:secretsmanager:us-east-1:123456789012:secret:mine/tailscale-XyZ123";
    const projection = projectFactoryVariables(
      instance({ ...example, tailscale: { ...example.tailscale, auth_key_secret: own } }),
      [],
    );
    expect(projection.ok && projection.variables.tailscale_auth_key_secret_arn).toBe(own);
  });

  test("the Tailscale tag every host advertises is factory.json's tailscale.tag", () => {
    const projection = projectFactoryVariables(
      instance({ ...example, tailscale: { ...example.tailscale, tag: "tag:lab-workers" } }),
      [],
    );
    expect(projection.ok && projection.variables.tailscale_tag).toBe("tag:lab-workers");
  });

  test("hosts are keyed by host key; only hosts with a Paseo password reference list one", () => {
    const projection = projectFactoryVariables(
      withHosts([
        { key: "a-1", instance_type: "t3.large", root_volume_gib: 50 },
        {
          key: "b-2",
          instance_type: "m7i.xlarge",
          root_volume_gib: 200,
          paseo_password_secret: PASEO,
        },
      ]),
      [],
    );
    expect(projection.ok && projection.variables.hosts).toEqual({
      "a-1": { instance_type: "t3.large", root_volume_gib: 50 },
      "b-2": { instance_type: "m7i.xlarge", root_volume_gib: 200 },
    });
    expect(projection.ok && projection.variables.paseo_password_secret_arns).toEqual({
      "b-2": PASEO,
    });
  });

  test("an incomplete instance is refused with every missing field", () => {
    expect(
      projectFactoryVariables(instance({ schema_version: 1, factory_id: "example" }), []),
    ).toEqual({
      ok: false,
      issues: [
        "release",
        "name",
        "aws.account_id",
        "aws.region",
        "state_backend.bucket",
        "network.vpc_cidr",
        "network.public_subnet_cidr",
        "network.availability_zone",
        "tailscale.tag",
        "tailscale.auth_key_secret",
        "hosts",
      ].map((path) => ({ path, message: "is required to plan" })),
    });
  });

  test("a host without its machine declaration is refused by field path", () => {
    expect(projectFactoryVariables(withHosts([{ key: "a" }]), [])).toEqual({
      ok: false,
      issues: [
        { path: "hosts[0].instance_type", message: "is required to plan" },
        { path: "hosts[0].root_volume_gib", message: "is required to plan" },
      ],
    });
  });

  test("renaming a host key is refused before any variable exists", () => {
    const renamed = withHosts([
      { key: "builder-one", instance_type: "m7i.xlarge", root_volume_gib: 200 },
    ]);
    expect(projectFactoryVariables(renamed, ["builder-1"])).toEqual({
      ok: false,
      issues: [{ path: "hosts", message: expect.stringContaining('host key "builder-1"') }],
    });
  });

  test("keeping every recorded host key and adding another is projected", () => {
    const grown = withHosts([
      { key: "builder-1", instance_type: "m7i.xlarge", root_volume_gib: 200 },
      { key: "builder-2", instance_type: "m7i.xlarge", root_volume_gib: 200 },
    ]);
    const projection = projectFactoryVariables(grown, ["builder-1"]);
    expect(projection.ok && Object.keys(projection.variables.hosts)).toEqual([
      "builder-1",
      "builder-2",
    ]);
  });
});

describe("factory.json projected into the backend root module's variables", () => {
  test("the state bucket is projected as its suffix after the factory ID", () => {
    expect(projectBackendVariables(instance())).toEqual({
      ok: true,
      variables: {
        factory_id: "example",
        account_id: "123456789012",
        region: "us-east-1",
        state_bucket_suffix: "fffactory-state-123456789012",
      },
    });
  });

  test("an instance without its account, Region or bucket is refused", () => {
    expect(projectBackendVariables(instance({ schema_version: 1, factory_id: "example" }))).toEqual(
      {
        ok: false,
        issues: ["aws.account_id", "aws.region", "state_backend.bucket"].map((path) => ({
          path,
          message: "is required to plan",
        })),
      },
    );
  });

  test("a factory ID is required", () => {
    expect(projectBackendVariables(instance({ schema_version: 1 }))).toEqual({
      ok: false,
      issues: ["factory_id", "aws.account_id", "aws.region", "state_backend.bucket"].map(
        (path) => ({ path, message: "is required to plan" }),
      ),
    });
  });

  test("a bucket that does not carry the factory ID is refused, even unvalidated", () => {
    const unvalidated = {
      ...instance(),
      state_backend: { bucket: "shared-state" },
    } as FactoryInstance;
    expect(projectBackendVariables(unvalidated)).toEqual({
      ok: false,
      issues: [
        {
          path: "state_backend.bucket",
          message:
            "must start with the factory ID and a hyphen, so its name carries the factory ID",
        },
      ],
    });
  });
});
