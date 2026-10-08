/**
 * The operator's view of the tailnet and the hostname-match rule: a worker is reached only
 * when exactly one device in that view carries its namespaced hostname, and that device
 * carries the factory's tag. A missing or duplicate name, or an untagged device, is refused,
 * never guessed (design §Machine identity and connectivity).
 */

/** One device in the local Tailscale client's view, as `tailscale status --json` reports it. */
export interface TailnetPeer {
  /** The hostname the device reported; not unique. */
  readonly hostName: string;
  /** Its MagicDNS name, such as `fff-a-b-1.example.ts.net.`; Tailscale suffixes duplicates. */
  readonly dnsName: string;
  readonly addresses: readonly string[];
  readonly online: boolean;
  /** The OpenSSH host keys its Tailscale SSH server presents, as the tailnet distributes them. */
  readonly sshHostKeys: readonly string[];
  /** Its ACL tags, such as `tag:factory`; the tailnet's control plane assigns them. */
  readonly tags: readonly string[];
}

/** What asking the local Tailscale client for its peers showed. */
export type PeerView =
  | { readonly kind: "peers"; readonly peers: readonly TailnetPeer[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "daemon_unreachable" }
  /** The client runs but is not connected: any `BackendState` other than `Running`. */
  | { readonly kind: "not_running"; readonly backendState: string }
  /** Output the CLI cannot interpret, a non-zero exit or a timeout. Never quotes the output. */
  | { readonly kind: "unusable"; readonly reason: string };

declare const workerBrand: unique symbol;

/**
 * Where to reach one worker: its one matching peer's address and host keys. Only
 * `resolveWorker` makes one, so a transport can only connect after the match rule passed.
 */
export interface WorkerAddress {
  readonly hostname: string;
  readonly address: string;
  /** Validated single-line `<type> <base64>` OpenSSH public keys; never empty. */
  readonly hostKeys: readonly string[];
  readonly [workerBrand]: "WorkerAddress";
}

export type WorkerResolution =
  | { readonly kind: "found"; readonly worker: WorkerAddress }
  | { readonly kind: "missing" }
  | { readonly kind: "duplicate"; readonly count: number }
  /** The one match does not carry the factory's tag: any tailnet member can take a name. */
  | { readonly kind: "untagged" }
  | { readonly kind: "offline" }
  /** The one match has no usable Tailscale SSH host key or no usable address. */
  | { readonly kind: "no_ssh" };

const HOST_KEY =
  /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

/** The first label of a MagicDNS name, lowercased. */
function dnsLabel(dnsName: string): string {
  return (dnsName.split(".")[0] ?? "").toLowerCase();
}

/**
 * The match rule: a device carries `hostname` when its reported hostname or the first label
 * of its MagicDNS name equals it, ignoring case. Nothing else matches: `name-1` is not `name`.
 * A stale device keeps its reported hostname when Tailscale renames its DNS label, so both
 * copies still match and the name is a duplicate.
 */
export function carriesHostname(peer: TailnetPeer, hostname: string): boolean {
  const wanted = hostname.toLowerCase();
  return peer.hostName.toLowerCase() === wanted || dnsLabel(peer.dnsName) === wanted;
}

/** An IPv4 address first, since Tailscale always gives one; else an IPv6 address. */
function addressOf(peer: TailnetPeer): string | undefined {
  return peer.addresses.find((a) => IPV4.test(a)) ?? peer.addresses.find((a) => IPV6.test(a));
}

/**
 * Finds the one device carrying `hostname`, refusing a missing or duplicate name, and then
 * one without the factory's `tag`, compared exactly. Tags do not narrow the match: a
 * duplicate name is refused even when only one copy carries the tag.
 */
export function resolveWorker(
  peers: readonly TailnetPeer[],
  hostname: string,
  tag: string,
): WorkerResolution {
  const matches = peers.filter((peer) => carriesHostname(peer, hostname));
  const [peer] = matches;
  if (peer === undefined) return { kind: "missing" };
  if (matches.length > 1) return { kind: "duplicate", count: matches.length };
  if (!peer.tags.includes(tag)) return { kind: "untagged" };
  if (!peer.online) return { kind: "offline" };
  const hostKeys = peer.sshHostKeys.map((key) => key.trim()).filter((key) => HOST_KEY.test(key));
  const address = addressOf(peer);
  if (hostKeys.length === 0 || address === undefined) return { kind: "no_ssh" };
  return { kind: "found", worker: { hostname, address, hostKeys } as unknown as WorkerAddress };
}

/**
 * The private known_hosts file for one connection: each of the worker's host keys under its
 * hostname, which the connection names as its `HostKeyAlias`.
 */
export function knownHostsFor(worker: WorkerAddress): string {
  return worker.hostKeys.map((key) => `${worker.hostname} ${key}\n`).join("");
}
