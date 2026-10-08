import { describe, expect, test } from "bun:test";
import type { FactoryInstance, HostKey } from "../../src/domain/instance";
import { checkStableHostKeys, recordedHostKeys } from "../../src/domain/stable-host-keys";

function declaring(...keys: string[]): FactoryInstance {
  return { schema_version: 1, hosts: keys.map((key) => ({ key: key as HostKey })) };
}

const RENAMED =
  "is provisioned but no longer declared: host keys cannot be renamed or removed. " +
  "Restore it, and declare any new host under a new key beside it";

describe("stable host keys (provisioning §Stable host keys)", () => {
  test("renaming a host key is rejected", () => {
    expect(checkStableHostKeys(["builder-1"], declaring("builder-one"))).toEqual([
      { path: "hosts", message: `host key "builder-1" ${RENAMED}` },
    ]);
  });

  test("removing a provisioned host key is rejected", () => {
    expect(checkStableHostKeys(["a", "b"], declaring("a"))).toEqual([
      { path: "hosts", message: `host key "b" ${RENAMED}` },
    ]);
    expect(checkStableHostKeys(["a"], { schema_version: 1 })).toEqual([
      { path: "hosts", message: `host key "a" ${RENAMED}` },
    ]);
  });

  test("keeping every provisioned key and adding new ones is accepted", () => {
    expect(checkStableHostKeys(["a"], declaring("a", "b"))).toEqual([]);
    expect(checkStableHostKeys([], declaring("a"))).toEqual([]);
  });

  test("reports every missing key, in the recorded order", () => {
    const messages = checkStableHostKeys(["c", "a", "b"], declaring("b")).map(
      (issue) => issue.message,
    );
    expect(messages).toEqual([`host key "c" ${RENAMED}`, `host key "a" ${RENAMED}`]);
  });

  test("never echoes a recorded key that is not a well-formed host key", () => {
    expect(checkStableHostKeys(["Not A Key"], declaring("a"))).toEqual([
      { path: "hosts", message: `a provisioned host key ${RENAMED}` },
    ]);
  });
});

describe("recorded host keys (provisioning §Stable host keys)", () => {
  test("are the factory root's host_keys output", () => {
    expect(recordedHostKeys({ host_keys: ["a", "b"], hosts: {} })).toEqual(["a", "b"]);
  });

  test("are none before the first apply, when the state has no outputs", () => {
    expect(recordedHostKeys({})).toEqual([]);
  });

  test("an output that is not a list of strings cannot be read", () => {
    for (const host_keys of ["a", [1], null, {}, [["a"]]])
      expect(recordedHostKeys({ host_keys })).toBeUndefined();
  });
});
