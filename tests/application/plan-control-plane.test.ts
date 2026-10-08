import { describe, expect, test } from "bun:test";
import { planControlPlane } from "../../src/application/plan-control-plane";
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import { type FactoryId, parseFactoryInstance, type Release } from "../../src/domain/instance";
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
const HOST = parsed.instance.hosts?.[0];
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

function dependencies(answer: ReturnType<typeof answers>) {
  const transport = fakeTransport({ [HOSTNAME]: answer });
  return {
    deps: {
      peers: fakeTailnet({ kind: "peers", peers: [peer(HOSTNAME)] }).tailnet,
      transport: transport.transport,
      sha256: () => CONFIGURATION_SHA256,
    },
    transport,
  };
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

    expect(await planControlPlane(deps, TARGET, TAG, [HOST], ASSETS_SHA256)).toEqual([
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

    const [plan] = await planControlPlane(deps, TARGET, TAG, [HOST], ASSETS_SHA256);
    expect(plan?.changes).toEqual(["listen-address", "password"]);
    expect(
      hostProjectionJson(
        hostProjection(TARGET.factoryId, HOST.key, TARGET.release, HOST.paseo_password_secret),
      ),
    ).toContain(HOSTNAME);
  });

  test("fails closed and plans a complete repair when inspection is unreadable", async () => {
    const { deps } = dependencies({ kind: "completed", exitCode: 1, stdout: "" });

    expect(await planControlPlane(deps, TARGET, TAG, [HOST], ASSETS_SHA256)).toEqual([
      {
        key: HOST.key,
        hostname: HOSTNAME,
        observation: "unavailable:failed",
        changes: ["paseo-package", "service-definition", "listen-address", "password"],
      },
    ]);
  });
});
