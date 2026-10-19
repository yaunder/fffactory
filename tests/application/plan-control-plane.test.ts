import { describe, expect, test } from "bun:test";
import { planControlPlane } from "../../src/application/plan-control-plane";
import type { ConfigurationState } from "../../src/domain/host-protocol";
import {
  hostProjection,
  hostProjectionJson,
  type HostProjection,
  projectHost,
} from "../../src/domain/host-projection";
import {
  type FactoryId,
  type FactoryInstance,
  parseFactoryInstance,
  type Release,
  type SecretReference,
} from "../../src/domain/instance";
import { sha256Text } from "../../src/infrastructure/release-tarball";
import { hostName } from "../../src/domain/resource-naming";
import {
  answers,
  fakeTailnet,
  fakeTransport,
  inspection,
  peer,
  TAG,
} from "../support/fake-workers";

const EXAMPLE = JSON.parse(await Bun.file("examples/factory.json").text());
const parsed = parseFactoryInstance(EXAMPLE);
if (!parsed.valid) throw new Error("example factory must be valid");
const INSTANCE = parsed.instance;
const HOST = INSTANCE.hosts?.[0];
if (HOST === undefined) throw new Error("example factory must declare a host");
const TARGET = {
  instancePath: "/work/factory.json",
  factoryId: "example" as FactoryId,
  accountId: "123456789012",
  region: "us-east-1",
  release: "0.1.0" as Release,
};
const HOSTNAME = hostName(TARGET.factoryId, HOST.key);
const ASSETS_SHA256 = "a".repeat(64);
const CONFIGURATION_SHA256 = "b".repeat(64);

function dependencies(
  answer: ReturnType<typeof answers>,
  sha256: (text: string) => string = () => CONFIGURATION_SHA256,
) {
  const transport = fakeTransport({ [HOSTNAME]: answer });
  return {
    deps: {
      peers: fakeTailnet({ kind: "peers", peers: [peer(HOSTNAME)] }).tailnet,
      transport: transport.transport,
      sha256,
    },
    transport,
  };
}

function credentialArn(name: string): SecretReference {
  return `arn:aws:secretsmanager:us-east-1:123456789012:secret:example/${name}-AbCdEf` as SecretReference;
}

/** The example factory with `credentials` as given. */
function withCredentials(credentials: FactoryInstance["credentials"]): FactoryInstance {
  return { ...INSTANCE, credentials };
}

/** What a worker keeping `projection` as host.json reports, by the release it runs. */
function keeping(projection: HostProjection, reportsControlPlane: boolean): ConfigurationState {
  const sha256 = sha256Text(hostProjectionJson(projection));
  if (!reportsControlPlane) return { state: "present", sha256 };
  const part = hostProjection(
    projection.factory_id,
    projection.host_key,
    projection.release,
    projection.paseo_password_secret,
  );
  return { state: "present", sha256, control_plane_sha256: sha256Text(hostProjectionJson(part)) };
}

async function planKeeping(configuration: ConfigurationState, instance: FactoryInstance) {
  const worker = inspection(
    HOSTNAME,
    {
      release: { state: "active", version: TARGET.release, sha256: ASSETS_SHA256 },
      configuration,
    },
    TARGET.release,
  );
  const { deps } = dependencies(answers(worker), sha256Text);
  return planControlPlane(deps, TARGET, TAG, instance, ASSETS_SHA256);
}

describe("control-plane planning", () => {
  test("plans no live change when the active release and projected configuration match", async () => {
    const current = inspection(
      HOSTNAME,
      {
        release: { state: "active", version: TARGET.release, sha256: ASSETS_SHA256 },
        configuration: { state: "present", sha256: CONFIGURATION_SHA256 },
      },
      TARGET.release,
    );
    const { deps } = dependencies(answers(current));

    expect(await planControlPlane(deps, TARGET, TAG, INSTANCE, ASSETS_SHA256)).toEqual([
      {
        key: HOST.key,
        hostname: HOSTNAME,
        observation: JSON.stringify({
          release: current.release,
          configuration: current.configuration,
        }),
        changes: [],
      },
    ]);
  });

  test("plans every configuration input when the worker holds another projection", async () => {
    const stale = inspection(
      HOSTNAME,
      {
        release: { state: "active", version: TARGET.release, sha256: ASSETS_SHA256 },
        configuration: { state: "present", sha256: "c".repeat(64) },
      },
      TARGET.release,
    );
    const { deps } = dependencies(answers(stale));

    const [plan] = await planControlPlane(deps, TARGET, TAG, INSTANCE, ASSETS_SHA256);
    expect(plan?.changes).toEqual(["listen-address", "password"]);
    expect(
      hostProjectionJson(
        hostProjection(TARGET.factoryId, HOST.key, TARGET.release, HOST.paseo_password_secret),
      ),
    ).toContain(HOSTNAME);
  });

  test("fails closed and plans a complete repair when inspection is unreadable", async () => {
    const { deps } = dependencies({ kind: "completed", exitCode: 1, stdout: "" });

    expect(await planControlPlane(deps, TARGET, TAG, INSTANCE, ASSETS_SHA256)).toEqual([
      {
        key: HOST.key,
        hostname: HOSTNAME,
        observation: "unavailable:failed",
        changes: ["paseo-package", "service-definition", "listen-address", "password"],
      },
    ]);
  });

  test("a credential reference added to factory.json plans no Paseo change on a worker from before credentials (D3)", async () => {
    const before = projectHost(INSTANCE, TARGET.factoryId, TARGET.release, HOST);
    const instance = withCredentials({ github_token_secret: credentialArn("github-token") });
    const [plan] = await planKeeping(keeping(before, false), instance);
    expect(plan?.changes).toEqual([]);
  });

  test("a credential reference changed or removed plans no Paseo change (D3)", async () => {
    const kept = projectHost(
      withCredentials({ github_token_secret: credentialArn("github-token") }),
      TARGET.factoryId,
      TARGET.release,
      HOST,
    );
    expect(kept.credentials).toBeDefined();
    for (const instance of [
      withCredentials({ github_token_secret: credentialArn("github-token-2") }),
      withCredentials({ openai_api_key_secret: credentialArn("openai-api-key") }),
      INSTANCE,
    ]) {
      const [plan] = await planKeeping(keeping(kept, true), instance);
      expect(plan?.changes).toEqual([]);
    }
  });

  test("still plans the Paseo settings when the control plane's own part changed", async () => {
    const kept = projectHost(
      withCredentials({ github_token_secret: credentialArn("github-token") }),
      TARGET.factoryId,
      TARGET.release,
      { key: HOST.key },
    );
    const [plan] = await planKeeping(keeping(kept, true), INSTANCE);
    expect(plan?.changes).toEqual(["listen-address", "password"]);
  });
});
