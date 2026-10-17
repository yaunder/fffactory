import { describe, expect, test } from "bun:test";
import {
  controlPlaneProjection,
  type HostProjection,
  hostProjection,
  hostProjectionJson,
  hostProjectionSha256,
  MAX_PROJECTION_BYTES,
  parseHostProjection,
  projectHost,
  projectHosts,
} from "../../src/domain/host-projection";
import type {
  FactoryId,
  FactoryInstance,
  HostKey,
  Release,
  SecretReference,
} from "../../src/domain/instance";

const PROJECTION = hostProjection(
  "fff-abcd1234" as FactoryId,
  "builder-1" as HostKey,
  "0.3.0" as Release,
);
const TEXT = hostProjectionJson(PROJECTION);

function arn(name: string): SecretReference {
  return `arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/${name}-AbCdEf` as SecretReference;
}

describe("the host's non-secret projection (host protocol §apply)", () => {
  test("names the factory, the host and its namespaced hostname, and the release", () => {
    expect(TEXT).toBe(
      `${JSON.stringify(
        {
          protocol_version: 1,
          factory_id: "fff-abcd1234",
          host_key: "builder-1",
          hostname: "fff-abcd1234-builder-1",
          release: "0.3.0",
        },
        null,
        2,
      )}\n`,
    );
  });

  test("projects factory.json's host whole, so its secret reference is never dropped (#132)", () => {
    const arn =
      "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/paseo-AbCdEf" as SecretReference;
    const factoryId = "fff-abcd1234" as FactoryId;
    const release = "0.3.0" as Release;
    const host = {
      key: "builder-1" as HostKey,
      instance_type: "t3.large",
      repositories: ["product"],
      paseo_password_secret: arn,
    };
    const instance: FactoryInstance = { schema_version: 1, hosts: [host] };
    expect(projectHost(instance, factoryId, release, host)).toEqual(
      hostProjection(factoryId, host.key, release, arn),
    );
    expect(projectHost(instance, factoryId, release, { key: host.key })).toEqual(PROJECTION);
  });

  test("projects every host of factory.json, in its order, each whole (#132)", () => {
    const arn =
      "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/paseo-AbCdEf" as SecretReference;
    const factoryId = "fff-abcd1234" as FactoryId;
    const release = "0.3.0" as Release;
    const instance: FactoryInstance = {
      schema_version: 1,
      hosts: [
        { key: "builder-2" as HostKey, paseo_password_secret: arn },
        { key: "builder-1" as HostKey },
      ],
    };
    expect(projectHosts(instance, factoryId, release)).toEqual([
      hostProjection(factoryId, "builder-2" as HostKey, release, arn),
      PROJECTION,
    ]);
    expect(projectHosts({ schema_version: 1 }, factoryId, release)).toEqual([]);
  });

  test("never carries the factory-wide Tailscale references, the admin client's above all", () => {
    const factoryId = "fff-abcd1234" as FactoryId;
    const release = "0.3.0" as Release;
    const arn = (name: string) =>
      `arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/${name}-AbCdEf` as SecretReference;
    const instance: FactoryInstance = {
      schema_version: 1,
      tailscale: {
        tag: "tag:factory",
        auth_key_secret: arn("tailscale-auth-key"),
        admin_client_secret: arn("tailscale-admin-client"),
      },
      hosts: [{ key: "builder-1" as HostKey }],
    };
    const projections = projectHosts(instance, factoryId, release);
    expect(projections).toEqual([PROJECTION]);
    expect(projections.map(hostProjectionJson).join("")).not.toContain("tailscale");
  });

  test("carries the references delivered to the host only, in canonical order (D3)", () => {
    const factoryId = "fff-abcd1234" as FactoryId;
    const release = "0.3.0" as Release;
    const instance: FactoryInstance = {
      schema_version: 1,
      tailscale: { admin_client_secret: arn("tailscale-admin-client") },
      credentials: {
        openai_api_key_secret: arn("openai-api-key"),
        anthropic_api_key_secret: arn("anthropic-api-key"),
        github_token_secret: arn("github-token"),
      },
      hosts: [
        { key: "builder-1" as HostKey },
        { key: "builder-2" as HostKey, interactive_logins: ["anthropic"] },
        { key: "builder-3" as HostKey, interactive_logins: ["github", "openai", "anthropic"] },
      ],
    };
    const [all, optedOut, none] = projectHosts(instance, factoryId, release);
    expect(all?.credentials).toEqual({
      github_token_secret: arn("github-token"),
      anthropic_api_key_secret: arn("anthropic-api-key"),
      openai_api_key_secret: arn("openai-api-key"),
    });
    expect(optedOut?.credentials).toEqual({
      github_token_secret: arn("github-token"),
      openai_api_key_secret: arn("openai-api-key"),
    });
    expect(none).toEqual(hostProjection(factoryId, "builder-3" as HostKey, release));
    expect(none !== undefined && "credentials" in none).toBe(false);
    const text = hostProjectionJson(all as HostProjection);
    expect(text).toBe(
      `${JSON.stringify(
        {
          protocol_version: 1,
          factory_id: "fff-abcd1234",
          host_key: "builder-1",
          hostname: "fff-abcd1234-builder-1",
          release: "0.3.0",
          credentials: {
            github_token_secret: arn("github-token"),
            anthropic_api_key_secret: arn("anthropic-api-key"),
            openai_api_key_secret: arn("openai-api-key"),
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(text).not.toContain("tailscale");
    expect(parseHostProjection(text)).toEqual({ ok: true, document: all as HostProjection });
  });

  test("carries no credentials when factory.json references none", () => {
    const factoryId = "fff-abcd1234" as FactoryId;
    const release = "0.3.0" as Release;
    const instance: FactoryInstance = {
      schema_version: 1,
      credentials: {},
      hosts: [{ key: "builder-1" as HostKey, interactive_logins: ["github"] }],
    };
    expect(projectHosts(instance, factoryId, release)).toEqual([PROJECTION]);
  });

  test("its control-plane part is the projection without its credentials (D3)", () => {
    const paseo = arn("paseo");
    const withCredentials = hostProjection(
      "fff-abcd1234" as FactoryId,
      "builder-1" as HostKey,
      "0.3.0" as Release,
      paseo,
      { github_token_secret: arn("github-token") },
    );
    const without = hostProjection(
      "fff-abcd1234" as FactoryId,
      "builder-1" as HostKey,
      "0.3.0" as Release,
      paseo,
    );
    expect(controlPlaneProjection(withCredentials)).toEqual(without);
    expect(hostProjectionJson(controlPlaneProjection(withCredentials))).toBe(
      hostProjectionJson(without),
    );
    expect(controlPlaneProjection(without)).toEqual(without);
  });

  test("refuses credentials that are not canonical validated references", () => {
    const document = {
      ...JSON.parse(TEXT),
      credentials: {
        github_token_secret: arn("github-token"),
        openai_api_key_secret: arn("openai-api-key"),
      },
    };
    const canonical = `${JSON.stringify(document, null, 2)}\n`;
    expect(parseHostProjection(canonical).ok).toBe(true);
    const cases: [string, string][] = [
      [
        `${JSON.stringify({ ...document, credentials: { github_token_secret: "ghp_raw" } }, null, 2)}\n`,
        "credentials.github_token_secret is missing or malformed",
      ],
      [
        `${JSON.stringify({ ...document, credentials: "arn" }, null, 2)}\n`,
        "credentials must be an object",
      ],
      [
        `${JSON.stringify({ ...document, credentials: {} }, null, 2)}\n`,
        "the document is not in its canonical form",
      ],
      [
        `${JSON.stringify(
          {
            ...document,
            credentials: {
              openai_api_key_secret: arn("openai-api-key"),
              github_token_secret: arn("github-token"),
            },
          },
          null,
          2,
        )}\n`,
        "the document is not in its canonical form",
      ],
      [
        `${JSON.stringify(
          { ...document, credentials: { admin_client_secret: arn("tailscale-admin-client") } },
          null,
          2,
        )}\n`,
        "the document is not in its canonical form",
      ],
    ];
    for (const [text, problem] of cases)
      expect(parseHostProjection(text)).toEqual({ ok: false, kind: "invalid", problem });
  });

  test("digests the canonical text with the injected SHA-256", () => {
    expect(hostProjectionSha256(PROJECTION, (text) => `sha256 of ${text}`)).toBe(
      `sha256 of ${TEXT}`,
    );
  });

  test("the worker reads back exactly the canonical text", () => {
    expect(parseHostProjection(TEXT)).toEqual({ ok: true, document: PROJECTION });
  });

  test("carries only a validated Paseo secret reference, never secret material", () => {
    const arn =
      "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/paseo-AbCdEf" as SecretReference;
    const projection = hostProjection(
      "fff-abcd1234" as FactoryId,
      "builder-1" as HostKey,
      "0.3.0" as Release,
      arn,
    );
    const text = hostProjectionJson(projection);
    expect(text).toContain(arn);
    expect(text).not.toContain("raw-password");
    expect(parseHostProjection(text)).toEqual({ ok: true, document: projection });
    expect(
      parseHostProjection(
        `${JSON.stringify({ ...projection, paseo_password_secret: "raw-password" }, null, 2)}\n`,
      ),
    ).toEqual({
      ok: false,
      kind: "invalid",
      problem: "paseo_password_secret is missing or malformed",
    });
  });

  test("refuses text that is not the canonical projection, naming why", () => {
    const document = JSON.parse(TEXT);
    const cases: [string, string][] = [
      ["{", "the output is not JSON"],
      [JSON.stringify({ ...document, factory_id: "FFF" }), "factory_id is missing or malformed"],
      [JSON.stringify({ ...document, host_key: "-x" }), "host_key is missing or malformed"],
      [
        JSON.stringify({ ...document, hostname: "fff-abcd1234-builder-2" }),
        "hostname is not the factory ID and host key",
      ],
      [JSON.stringify({ ...document, release: "latest" }), "release is missing or malformed"],
      [JSON.stringify(document), "the document is not in its canonical form"],
      [
        `${JSON.stringify({ ...document, extra: 1 }, null, 2)}\n`,
        "the document is not in its canonical form",
      ],
      [" ".repeat(MAX_PROJECTION_BYTES + 1), "the document is larger than 65536 bytes"],
    ];
    for (const [text, problem] of cases)
      expect(parseHostProjection(text)).toEqual({ ok: false, kind: "invalid", problem });
  });
});
