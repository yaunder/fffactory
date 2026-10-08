import { describe, expect, test } from "bun:test";
import type { ProcessOutcome, ProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { PEERS_TIMEOUT_MS, tailscalePeers } from "../../src/infrastructure/tailscale-peers";
import { HOST_KEY } from "../support/fake-workers";

function answering(outcome: ProcessOutcome) {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = [];
  const run: ProcessRunner = async (argv, timeoutMs) => {
    calls.push({ argv, timeoutMs });
    return outcome;
  };
  return { peers: tailscalePeers(run), calls };
}

const exited = (exitCode: number, stdout = "", stderr = ""): ProcessOutcome => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr,
});

const STATUS = {
  BackendState: "Running",
  Self: {
    HostName: "operator-laptop",
    DNSName: "operator-laptop.example-tailnet.ts.net.",
    TailscaleIPs: ["100.64.0.1"],
    Online: true,
  },
  Peer: {
    "nodekey:1": {
      HostName: "fff-aaaa1111-builder-1",
      DNSName: "fff-aaaa1111-builder-1.example-tailnet.ts.net.",
      TailscaleIPs: ["100.64.0.10", "fd7a:115c:a1e0::a"],
      Online: true,
      sshHostKeys: [HOST_KEY],
      Tags: ["tag:software-factory", 7],
    },
    "nodekey:2": { HostName: 42, DNSName: null, TailscaleIPs: "no", Online: "yes", Tags: "tag:x" },
    "nodekey:3": "not a device",
  },
};

describe("the Tailscale peer view", () => {
  test("reads this device and every peer, with its tags, from `tailscale status --json`", async () => {
    const { peers, calls } = answering(exited(0, JSON.stringify(STATUS)));
    expect(await peers.view()).toEqual({
      kind: "peers",
      peers: [
        {
          hostName: "operator-laptop",
          dnsName: "operator-laptop.example-tailnet.ts.net.",
          addresses: ["100.64.0.1"],
          online: true,
          sshHostKeys: [],
          tags: [],
        },
        {
          hostName: "fff-aaaa1111-builder-1",
          dnsName: "fff-aaaa1111-builder-1.example-tailnet.ts.net.",
          addresses: ["100.64.0.10", "fd7a:115c:a1e0::a"],
          online: true,
          sshHostKeys: [HOST_KEY],
          tags: ["tag:software-factory"],
        },
        { hostName: "", dnsName: "", addresses: [], online: false, sshHostKeys: [], tags: [] },
      ],
    });
    expect(calls).toEqual([
      { argv: ["tailscale", "status", "--json"], timeoutMs: PEERS_TIMEOUT_MS },
    ]);
  });

  test("a view without peers has only this device", async () => {
    const { peers } = answering(exited(0, JSON.stringify({ BackendState: "Running" })));
    expect(await peers.view()).toEqual({ kind: "peers", peers: [] });
  });

  test("a client that is not connected reports its backend state", async () => {
    const { peers } = answering(exited(0, JSON.stringify({ BackendState: "NeedsLogin" })));
    expect(await peers.view()).toEqual({ kind: "not_running", backendState: "NeedsLogin" });
  });

  test("a missing client or daemon", async () => {
    expect(await answering({ kind: "not_found" }).peers.view()).toEqual({ kind: "not_found" });
    const daemon = answering(
      exited(1, "", "failed to connect to local tailscaled; it doesn't appear to be running"),
    );
    expect(await daemon.peers.view()).toEqual({ kind: "daemon_unreachable" });
  });

  test("anything else is unusable, and the output is never quoted", async () => {
    const cases: [ProcessOutcome, string][] = [
      [exited(0, "not json {secret}"), "`tailscale status --json` printed output that is not JSON"],
      [exited(0, "[]"), "`tailscale status --json` reported no BackendState"],
      [exited(3, "", "weird {secret}"), "`tailscale status --json` exited with status 3"],
      [{ kind: "timed_out" }, "`tailscale status --json` did not finish within 10 s"],
      [
        { kind: "not_started", code: "EACCES" },
        "`tailscale status --json` could not be started (EACCES)",
      ],
    ];
    for (const [outcome, reason] of cases)
      expect(await answering(outcome).peers.view()).toEqual({ kind: "unusable", reason });
  });
});
