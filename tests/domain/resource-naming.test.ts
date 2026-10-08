import { describe, expect, test } from "bun:test";
import type { FactoryId, HostKey } from "../../src/domain/instance";
import {
  carriesFactoryId,
  FACTORY_ID_TAG,
  HOST_KEY_TAG,
  hostName,
  namespaced,
  stateBucketSuffix,
} from "../../src/domain/resource-naming";

const factory = (id: string) => id as FactoryId;
const host = (key: string) => key as HostKey;

describe("resource naming (provisioning §Resources and namespacing)", () => {
  test("a resource name is the factory ID, a hyphen and the resource's own name", () => {
    expect(namespaced(factory("fff-k3x9q2ab"), "host")).toBe("fff-k3x9q2ab-host");
  });

  test("a host's Tailscale hostname is the factory ID, a hyphen and the host key", () => {
    expect(hostName(factory("fff-k3x9q2ab"), host("builder-1"))).toBe("fff-k3x9q2ab-builder-1");
  });

  test("the longest factory ID and host key still make a DNS label", () => {
    const name = hostName(factory("a".repeat(20)), host("b".repeat(32)));
    expect(name.length).toBe(53);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("a name carries the factory ID only as its prefix, followed by a hyphen and more", () => {
    const id = factory("fff-k3x9q2ab");
    expect(carriesFactoryId("fff-k3x9q2ab-vpc", id)).toBe(true);
    expect(carriesFactoryId("fff-k3x9q2ab", id)).toBe(false);
    expect(carriesFactoryId("fff-k3x9q2ab-", id)).toBe(false);
    expect(carriesFactoryId("fff-k3x9q2abc-vpc", id)).toBe(false);
    expect(carriesFactoryId("software-factory-host", id)).toBe(false);
    expect(carriesFactoryId("vpc-fff-k3x9q2ab", id)).toBe(false);
  });

  test("two generated factory IDs never share a name", () => {
    const suffixes = ["vpc", "igw", "public", "hosts-", "host", "read-secrets", "builder-1"];
    const a = factory("fff-aaaa1111");
    const b = factory("fff-bbbb2222");
    const namesOf = (id: FactoryId) => new Set(suffixes.map((suffix) => namespaced(id, suffix)));
    const shared = [...namesOf(a)].filter((name) => namesOf(b).has(name));
    expect(shared).toEqual([]);
    for (const name of namesOf(a)) expect(carriesFactoryId(name, b)).toBe(false);
  });

  test("the state bucket's suffix is what follows the factory ID and a hyphen", () => {
    const id = factory("example");
    expect(stateBucketSuffix(id, "example-fffactory-state-123456789012")).toBe(
      "fffactory-state-123456789012",
    );
    expect(stateBucketSuffix(id, "fffactory-state")).toBeUndefined();
    expect(stateBucketSuffix(id, "examples-state")).toBeUndefined();
  });

  test("resources are tagged with the factory ID and host key under fffactory: keys", () => {
    expect(FACTORY_ID_TAG).toBe("fffactory:factory-id");
    expect(HOST_KEY_TAG).toBe("fffactory:host-key");
  });
});
