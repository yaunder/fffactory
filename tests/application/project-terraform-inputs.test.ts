import { describe, expect, test } from "bun:test";
import example from "../../examples/factory.json";
import {
  projectArchiveVariables,
  projectBackendVariables,
  projectFactoryVariables,
} from "../../src/application/project-terraform-inputs";
import { type FactoryInstance, parseFactoryInstance } from "../../src/domain/instance";

const TAILSCALE = example.tailscale.auth_key_secret;
const paseo = (key: string) =>
  `arn:aws:secretsmanager:us-east-1:123456789012:secret:example/${key}/paseo-AbCdEf`;

/** A host with its machine declaration and Paseo password, as completeness requires. */
function host(key: string, instance_type = "m7i.xlarge", root_volume_gib = 200) {
  return { key, instance_type, root_volume_gib, paseo_password_secret: paseo(key) };
}

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
        credential_secret_arns: {},
        hosts: { "builder-1": { instance_type: "m7i.xlarge", root_volume_gib: 200 } },
        archive_bucket: "example-logs-123456789012-us-east-1-an",
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

  test("the Tailscale admin client never reaches Terraform, so no worker may read it", () => {
    const admin = "arn:aws:secretsmanager:us-east-1:123456789012:secret:example/ts-admin-XyZ123";
    const projection = projectFactoryVariables(
      instance({ ...example, tailscale: { ...example.tailscale, admin_client_secret: admin } }),
      [],
    );
    expect(projection).toEqual(projectFactoryVariables(instance(), []));
    expect(JSON.stringify(projection)).not.toContain("ts-admin");
  });

  test("hosts may write only to the log archive factory.json enables: no bucket when it does not", () => {
    const disabled = { ...example, log_archive: { enabled: false } };
    const { log_archive: _, ...absent } = example;
    for (const document of [disabled, absent]) {
      const projection = projectFactoryVariables(instance(document), []);
      expect(projection.ok && projection.variables.archive_bucket).toBeNull();
    }
  });

  test("every credential reference reaches the hosts' role, whatever a host keeps on login (D2)", () => {
    const arn = (name: string) =>
      `arn:aws:secretsmanager:us-east-1:123456789012:secret:example/${name}-AbCdEf`;
    const admin = arn("ts-admin");
    const projection = projectFactoryVariables(
      instance({
        ...example,
        tailscale: { ...example.tailscale, admin_client_secret: admin },
        credentials: {
          openai_api_key_secret: arn("openai-api-key"),
          github_token_secret: arn("github-token"),
          anthropic_api_key_secret: arn("anthropic-api-key"),
        },
        hosts: example.hosts.map((host) => ({
          ...host,
          interactive_logins: ["github", "openai", "anthropic"],
        })),
      }),
      [],
    );
    expect(projection.ok && projection.variables.credential_secret_arns).toEqual({
      github_token_secret: arn("github-token"),
      anthropic_api_key_secret: arn("anthropic-api-key"),
      openai_api_key_secret: arn("openai-api-key"),
    });
    expect(JSON.stringify(projection)).not.toContain("ts-admin");
  });

  test("the Tailscale tag every host advertises is factory.json's tailscale.tag", () => {
    const projection = projectFactoryVariables(
      instance({ ...example, tailscale: { ...example.tailscale, tag: "tag:lab-workers" } }),
      [],
    );
    expect(projection.ok && projection.variables.tailscale_tag).toBe("tag:lab-workers");
  });

  test("hosts are keyed by host key, each with its Paseo password reference", () => {
    const projection = projectFactoryVariables(
      withHosts([host("a-1", "t3.large", 50), host("b-2")]),
      [],
    );
    expect(projection.ok && projection.variables.hosts).toEqual({
      "a-1": { instance_type: "t3.large", root_volume_gib: 50 },
      "b-2": { instance_type: "m7i.xlarge", root_volume_gib: 200 },
    });
    expect(projection.ok && projection.variables.paseo_password_secret_arns).toEqual({
      "a-1": paseo("a-1"),
      "b-2": paseo("b-2"),
    });
  });

  test("an empty factory projects no hosts and no Paseo passwords: only the shared infrastructure", () => {
    const projection = projectFactoryVariables(withHosts([]), []);
    expect(projection).toEqual({
      ok: true,
      variables: expect.objectContaining({
        tailscale_auth_key_secret_arn: TAILSCALE,
        paseo_password_secret_arns: {},
        credential_secret_arns: {},
        hosts: {},
      }),
    });
  });

  test("an empty factory whose state still records a host is refused (D11)", () => {
    expect(projectFactoryVariables(withHosts([]), ["builder-1"])).toEqual({
      ok: false,
      issues: [{ path: "hosts", message: expect.stringContaining('host key "builder-1"') }],
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

  test("a host without its machine declaration or Paseo password is refused by field path", () => {
    expect(projectFactoryVariables(withHosts([{ key: "a" }]), [])).toEqual({
      ok: false,
      issues: [
        { path: "hosts[0].instance_type", message: "is required to plan" },
        { path: "hosts[0].root_volume_gib", message: "is required to plan" },
        { path: "hosts[0].paseo_password_secret", message: "is required to plan" },
      ],
    });
  });

  test("renaming a host key is refused before any variable exists", () => {
    const renamed = withHosts([host("builder-one")]);
    expect(projectFactoryVariables(renamed, ["builder-1"])).toEqual({
      ok: false,
      issues: [{ path: "hosts", message: expect.stringContaining('host key "builder-1"') }],
    });
  });

  test("keeping every recorded host key and adding another is projected", () => {
    const grown = withHosts([host("builder-1"), host("builder-2")]);
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

describe("factory.json projected into the archive root module's variables", () => {
  test("the log archive's derived bucket is projected as its suffix after the factory ID", () => {
    expect(projectArchiveVariables(instance())).toEqual({
      ok: true,
      variables: {
        factory_id: "example",
        account_id: "123456789012",
        region: "us-east-1",
        archive_bucket_suffix: "logs-123456789012-us-east-1-an",
      },
    });
  });

  test("an instance that does not enable the log archive is refused", () => {
    const disabled = { ...example, log_archive: { enabled: false } };
    const { log_archive: _, ...absent } = example;
    for (const document of [disabled, absent])
      expect(projectArchiveVariables(instance(document))).toEqual({
        ok: false,
        issues: [{ path: "log_archive.enabled", message: "must be true to plan the log archive" }],
      });
  });

  test("an instance without its factory ID, account or Region is refused", () => {
    expect(
      projectArchiveVariables(instance({ schema_version: 1, log_archive: { enabled: true } })),
    ).toEqual({
      ok: false,
      issues: ["factory_id", "aws.account_id", "aws.region"].map((path) => ({
        path,
        message: "is required to plan",
      })),
    });
  });
});
