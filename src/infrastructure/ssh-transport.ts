/**
 * HostTransport over the system OpenSSH client, logging in as `fffactory-admin` to the one
 * tailnet device the hostname-match rule found (`docs/specs/host-protocol.md` §Transport).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCommandOutcome, HostTransport } from "../application/host-transport";
import { WORKER_ADMIN } from "../domain/host-protocol";
import { knownHostsFor, type WorkerAddress } from "../domain/tailnet";
import { bunProcessRunner, type ProcessRunner } from "./local-tool-probe";

/** Seconds to establish the connection; the command's own timeout bounds the rest. */
export const CONNECT_TIMEOUT_S = 10;

/**
 * Everything the client does, given on the command line with `-F /dev/null` so neither the
 * operator's nor the system's ssh_config can redirect, proxy, multiplex or forward it.
 * The host key must be one the tailnet lists for the worker: the private known_hosts file
 * holds exactly those, under the worker's hostname as `HostKeyAlias`, and nothing is learned
 * or updated. No agent is offered or forwarded, and nothing prompts.
 */
export function sshArguments(worker: WorkerAddress, knownHosts: string): string[] {
  const options = {
    BatchMode: "yes",
    ConnectTimeout: String(CONNECT_TIMEOUT_S),
    StrictHostKeyChecking: "yes",
    UserKnownHostsFile: knownHosts,
    GlobalKnownHostsFile: "/dev/null",
    HostKeyAlias: worker.hostname,
    CheckHostIP: "no",
    UpdateHostKeys: "no",
    CanonicalizeHostname: "no",
    ProxyCommand: "none",
    ProxyJump: "none",
    ControlMaster: "no",
    ControlPath: "none",
    IdentityAgent: "none",
    ForwardAgent: "no",
    ForwardX11: "no",
    ClearAllForwardings: "yes",
    PermitLocalCommand: "no",
    RequestTTY: "no",
    ServerAliveInterval: "5",
    ServerAliveCountMax: "3",
    LogLevel: "ERROR",
    Port: "22",
  };
  return [
    "ssh",
    "-F",
    "/dev/null",
    ...Object.entries(options).flatMap(([name, value]) => ["-o", `${name}=${value}`]),
    "-l",
    WORKER_ADMIN,
    "--",
    worker.address,
  ];
}

/** OpenSSH's own failures exit 255; the remote command's status passes through otherwise. */
const SSH_FAILURE = 255;
const HOST_KEY_FAILED = /host key verification failed|remote host identification has changed/i;
const DENIED = /permission denied|tailnet policy does not permit/i;
const CONNECTION_REASONS: readonly (readonly [RegExp, string])[] = [
  [/connection timed out|operation timed out/i, "the connection timed out"],
  [/connection refused/i, "the connection was refused"],
  [/no route to host|network is unreachable/i, "there is no route to it"],
  [/connection (closed|reset)|broken pipe|timeout, server/i, "the connection dropped"],
];

/** Classifies OpenSSH's failure by its standard error, which is never echoed. */
function sshFailure(stderr: string): HostCommandOutcome {
  if (HOST_KEY_FAILED.test(stderr)) return { kind: "host_key_mismatch" };
  if (DENIED.test(stderr)) return { kind: "access_denied" };
  const reason = CONNECTION_REASONS.find(([pattern]) => pattern.test(stderr))?.[1];
  return { kind: "unreachable", reason: reason ?? "ssh could not connect" };
}

export interface SshTransportOptions {
  readonly run?: ProcessRunner;
  /** Where each connection's private directory is made; the system's by default. */
  readonly temporaryDirectory?: string;
  /** The client's whole environment; only these variables of the operator's reach it. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The variables `ssh` needs to find itself and a home; no agent socket, no askpass. */
function clientEnvironment(env: SshTransportOptions["env"]): Record<string, string> {
  return Object.fromEntries(
    (["PATH", "HOME"] as const).flatMap((name) => {
      const value = env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

/**
 * Writes the worker's host keys to a known_hosts file in a fresh private directory, runs
 * `ssh` with it, and removes the directory whatever happens.
 */
export function sshTransport({
  run = bunProcessRunner,
  temporaryDirectory = tmpdir(),
  env,
}: SshTransportOptions): HostTransport {
  return {
    async run(worker, command, { timeoutMs, stdin }) {
      const directory = await mkdtemp(join(temporaryDirectory, "fffactory-ssh-"));
      try {
        const knownHosts = join(directory, "known_hosts");
        await writeFile(knownHosts, knownHostsFor(worker), { mode: 0o600 });
        const argv = [...sshArguments(worker, knownHosts), ...command];
        const outcome = await run(argv, timeoutMs, {
          env: clientEnvironment(env),
          ...(stdin === undefined ? {} : { stdin }),
        });
        switch (outcome.kind) {
          case "not_found":
            return { kind: "client_missing" };
          case "timed_out":
          case "not_started":
            return outcome;
        }
        if (outcome.exitCode === SSH_FAILURE) return sshFailure(outcome.stderr);
        return { kind: "completed", exitCode: outcome.exitCode, stdout: outcome.stdout };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
