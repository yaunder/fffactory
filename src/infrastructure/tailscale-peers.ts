import type { TailnetPeers } from "../application/tailnet-peers";
import type { PeerView, TailnetPeer } from "../domain/tailnet";
import { bunProcessRunner, type ProcessRunner } from "./local-tool-probe";

/** The whole peer view: status needs every device's names, tags, addresses and host keys. */
const TAILSCALE = ["tailscale", "status", "--json"] as const;
const COMMAND = TAILSCALE.join(" ");
export const PEERS_TIMEOUT_MS = 10_000;
/** Linux: "local tailscaled"; macOS and others: "local Tailscale service" or "daemon". */
const DAEMON_UNREACHABLE = /failed to connect to local tailscale/i;

type Fields = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** One device; a field of the wrong type reads as absent, so it can never match. */
function peerOf(value: unknown): TailnetPeer | undefined {
  if (!isRecord(value)) return undefined;
  return {
    hostName: typeof value.HostName === "string" ? value.HostName : "",
    dnsName: typeof value.DNSName === "string" ? value.DNSName : "",
    addresses: strings(value.TailscaleIPs),
    online: value.Online === true,
    sshHostKeys: strings(value.sshHostKeys),
    tags: strings(value.Tags),
  };
}

/** This device and every peer: a worker named like this device is a duplicate too. */
function viewOf(stdout: string): PeerView {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    return { kind: "unusable", reason: `\`${COMMAND}\` printed output that is not JSON` };
  }
  if (!isRecord(status) || typeof status.BackendState !== "string")
    return { kind: "unusable", reason: `\`${COMMAND}\` reported no BackendState` };
  if (status.BackendState !== "Running")
    return { kind: "not_running", backendState: status.BackendState };
  const devices = [status.Self, ...(isRecord(status.Peer) ? Object.values(status.Peer) : [])];
  return {
    kind: "peers",
    peers: devices.map(peerOf).filter((peer) => peer !== undefined),
  };
}

/**
 * TailnetPeers over the local `tailscale status --json`. Its output is never echoed: it
 * describes other people's devices.
 */
export function tailscalePeers(
  run: ProcessRunner = bunProcessRunner,
  timeoutMs: number = PEERS_TIMEOUT_MS,
): TailnetPeers {
  return {
    async view() {
      const outcome = await run(TAILSCALE, timeoutMs);
      switch (outcome.kind) {
        case "not_found":
          return { kind: "not_found" };
        case "timed_out":
          return {
            kind: "unusable",
            reason: `\`${COMMAND}\` did not finish within ${timeoutMs / 1000} s`,
          };
        case "not_started":
          return {
            kind: "unusable",
            reason: `\`${COMMAND}\` could not be started (${outcome.code})`,
          };
      }
      if (outcome.exitCode === 0) return viewOf(outcome.stdout);
      if (DAEMON_UNREACHABLE.test(`${outcome.stderr}\n${outcome.stdout}`))
        return { kind: "daemon_unreachable" };
      return { kind: "unusable", reason: `\`${COMMAND}\` exited with status ${outcome.exitCode}` };
    },
  };
}
