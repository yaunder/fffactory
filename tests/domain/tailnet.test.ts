import { describe, expect, test } from "bun:test";
import { carriesHostname, knownHostsFor, resolveWorker } from "../../src/domain/tailnet";
import { HOST_KEY, peer, TAG } from "../support/fake-workers";

const NAME = "fff-aaaa1111-builder-1";

describe("the hostname-match rule", () => {
  test("a device matches by its reported hostname or its MagicDNS label, ignoring case", () => {
    expect(carriesHostname(peer(NAME), NAME)).toBe(true);
    expect(carriesHostname(peer("other", { dnsName: `${NAME}.tail.ts.net.` }), NAME)).toBe(true);
    expect(carriesHostname(peer(NAME.toUpperCase(), { dnsName: "" }), NAME)).toBe(true);
  });

  test("a suffixed, prefixed or longer name is not the same name", () => {
    for (const other of [`${NAME}-1`, `x${NAME}`, "fff-aaaa1111-builder"])
      expect(carriesHostname(peer(other, { dnsName: `${other}.tail.ts.net.` }), NAME)).toBe(false);
  });

  test("the one online device with a host key is found, with its IPv4 address", () => {
    const resolution = resolveWorker([peer("elsewhere"), peer(NAME)], NAME, TAG);
    expect(resolution.kind).toBe("found");
    if (resolution.kind !== "found") return;
    expect(resolution.worker.hostname).toBe(NAME);
    expect(resolution.worker.address).toBe("100.64.0.10");
    expect(resolution.worker.hostKeys).toEqual([HOST_KEY]);
  });

  test("an IPv6 address is used when the device has no IPv4 address", () => {
    const resolution = resolveWorker([peer(NAME, { addresses: ["fd7a:115c:a1e0::a"] })], NAME, TAG);
    expect(resolution.kind === "found" && resolution.worker.address).toBe("fd7a:115c:a1e0::a");
  });

  test("no device with the name is missing", () => {
    expect(resolveWorker([peer(`${NAME}-1`), peer("other")], NAME, TAG)).toEqual({
      kind: "missing",
    });
    expect(resolveWorker([], NAME, TAG)).toEqual({ kind: "missing" });
  });

  test("two devices with the name are a duplicate, even when Tailscale suffixed one's DNS name", () => {
    const stale = peer(NAME, { dnsName: `${NAME}-1.example-tailnet.ts.net.`, online: false });
    expect(resolveWorker([peer(NAME), stale], NAME, TAG)).toEqual({ kind: "duplicate", count: 2 });
    expect(resolveWorker([peer(NAME), peer(NAME), peer(NAME)], NAME, TAG)).toEqual({
      kind: "duplicate",
      count: 3,
    });
  });

  test("a device that renamed its DNS label into the name makes it a duplicate", () => {
    const renamed = peer("fff-aaaa1111-builder", { dnsName: `${NAME}.example-tailnet.ts.net.` });
    expect(resolveWorker([peer(NAME), renamed], NAME, TAG).kind).toBe("duplicate");
  });

  test("the one match without the factory's tag is untagged, and never reached", () => {
    for (const tags of [[], ["tag:other"], [`${TAG}-x`], [TAG.toUpperCase()], ["software-factory"]])
      expect(resolveWorker([peer(NAME, { tags })], NAME, TAG)).toEqual({ kind: "untagged" });
    expect(resolveWorker([peer(NAME, { tags: [], online: false })], NAME, TAG)).toEqual({
      kind: "untagged",
    });
  });

  test("the one match is found when the factory's tag is among its tags", () => {
    const resolution = resolveWorker([peer(NAME, { tags: ["tag:other", TAG] })], NAME, TAG);
    expect(resolution.kind).toBe("found");
  });

  test("a duplicate name stays a duplicate even when only one copy carries the tag", () => {
    expect(resolveWorker([peer(NAME), peer(NAME, { tags: [] })], NAME, TAG)).toEqual({
      kind: "duplicate",
      count: 2,
    });
  });

  test("the one match offline is offline", () => {
    expect(resolveWorker([peer(NAME, { online: false })], NAME, TAG)).toEqual({ kind: "offline" });
  });

  test("without a well-formed host key or a usable address there is no SSH", () => {
    for (const overrides of [
      { sshHostKeys: [] },
      { sshHostKeys: ["ssh-ed25519 AAAA\nevil.example ssh-ed25519 AAAA"] },
      { sshHostKeys: ["ssh-dss AAAAB3NzaC1kc3M="] },
      { sshHostKeys: ["* ssh-ed25519 AAAAC3Nz"] },
      { addresses: [] },
      { addresses: ["not-an-address", "300.1.2.3"] },
    ])
      expect(resolveWorker([peer(NAME, overrides)], NAME, TAG)).toEqual({ kind: "no_ssh" });
  });

  test("only the well-formed host keys are kept, trimmed", () => {
    const resolution = resolveWorker(
      [peer(NAME, { sshHostKeys: [` ${HOST_KEY} `, "garbage", "ecdsa-sha2-nistp256 AAAAE2Vj="] })],
      NAME,
      TAG,
    );
    expect(resolution.kind === "found" && resolution.worker.hostKeys).toEqual([
      HOST_KEY,
      "ecdsa-sha2-nistp256 AAAAE2Vj=",
    ]);
  });

  test("the private known_hosts file lists each host key under the hostname alias", () => {
    const resolution = resolveWorker(
      [peer(NAME, { sshHostKeys: [HOST_KEY, "ssh-rsa AAAAB3NzaC1yc2E="] })],
      NAME,
      TAG,
    );
    if (resolution.kind !== "found") throw new Error("not found");
    expect(knownHostsFor(resolution.worker)).toBe(
      `${NAME} ${HOST_KEY}\n${NAME} ssh-rsa AAAAB3NzaC1yc2E=\n`,
    );
  });
});
