import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSPECT_COMMAND, remoteCommand } from "../../src/domain/host-protocol";
import { resolveWorker, type WorkerAddress } from "../../src/domain/tailnet";
import type { ProcessOutcome, ProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { sshArguments, sshTransport } from "../../src/infrastructure/ssh-transport";
import { HOST_KEY, peer, TAG } from "../support/fake-workers";

const NAME = "fff-aaaa1111-builder-1";

function worker(): WorkerAddress {
  const resolution = resolveWorker([peer(NAME)], NAME, TAG);
  if (resolution.kind !== "found") throw new Error("not found");
  return resolution.worker;
}

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-ssh-test-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Call {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly env: unknown;
  readonly stdin: Uint8Array | undefined;
  readonly knownHosts: string;
  readonly knownHostsMode: number;
}

/** A runner answering `outcome`, recording the call and the known_hosts file it was given. */
function recording(outcome: ProcessOutcome) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (argv, timeoutMs, options) => {
    const option = argv.find((arg) => arg.startsWith("UserKnownHostsFile=")) ?? "";
    const path = option.slice("UserKnownHostsFile=".length);
    calls.push({
      argv,
      timeoutMs,
      env: options?.env,
      stdin: options?.stdin,
      knownHosts: await readFile(path, "utf8"),
      knownHostsMode: (await stat(path)).mode & 0o777,
    });
    return outcome;
  };
  return { run, calls };
}

function transport(outcome: ProcessOutcome, env: Record<string, string | undefined> = {}) {
  const runner = recording(outcome);
  return {
    ...runner,
    transport: sshTransport({ run: runner.run, temporaryDirectory: scratch, env }),
  };
}

const exited = (exitCode: number, stdout = "", stderr = ""): ProcessOutcome => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr,
});

describe("the OpenSSH transport", () => {
  test("logs in as fffactory-admin to the peer's address with a private, fixed configuration", async () => {
    const { transport: ssh, calls } = transport(exited(0, "{}"));
    expect(await ssh.run(worker(), INSPECT_COMMAND, { timeoutMs: 1234 })).toEqual({
      kind: "completed",
      exitCode: 0,
      stdout: "{}",
    });
    const [call] = calls;
    if (!call) throw new Error("no call");
    const knownHostsOption = call.argv.find((arg) => arg.startsWith("UserKnownHostsFile="));
    expect(call.argv).toEqual([
      "ssh",
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      knownHostsOption ?? "",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      `HostKeyAlias=${NAME}`,
      "-o",
      "CheckHostIP=no",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "CanonicalizeHostname=no",
      "-o",
      "ProxyCommand=none",
      "-o",
      "ProxyJump=none",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "IdentityAgent=none",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "RequestTTY=no",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "Port=22",
      "-l",
      "fffactory-admin",
      "--",
      "100.64.0.10",
      ...INSPECT_COMMAND,
    ]);
    expect(knownHostsOption?.startsWith(`UserKnownHostsFile=${scratch}/fffactory-ssh-`)).toBe(true);
    expect(call.timeoutMs).toBe(1234);
  });

  test("trusts exactly the tailnet's host keys for the worker, in a private file it removes", async () => {
    const { transport: ssh, calls } = transport(exited(0));
    await ssh.run(worker(), INSPECT_COMMAND, { timeoutMs: 1000 });
    expect(calls[0]?.knownHosts).toBe(`${NAME} ${HOST_KEY}\n`);
    expect(calls[0]?.knownHostsMode).toBe(0o600);
    expect(await readdir(scratch)).toEqual([]);
  });

  test("removes its directory when running ssh throws", async () => {
    const ssh = sshTransport({
      run: async () => {
        throw new Error("boom");
      },
      temporaryDirectory: scratch,
      env: {},
    });
    await expect(ssh.run(worker(), INSPECT_COMMAND, { timeoutMs: 1000 })).rejects.toThrow("boom");
    expect(await readdir(scratch)).toEqual([]);
  });

  test("passes ssh only PATH and HOME: no agent socket, askpass or other variables", async () => {
    const { transport: ssh, calls } = transport(exited(0), {
      PATH: "/usr/bin",
      HOME: "/home/operator",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      SSH_ASKPASS: "/usr/bin/askpass",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    await ssh.run(worker(), INSPECT_COMMAND, { timeoutMs: 1000 });
    expect(calls[0]?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/operator" });
  });

  test("streams given bytes to the remote command's standard input, and none otherwise", async () => {
    const { transport: ssh, calls } = transport(exited(0));
    const bytes = new TextEncoder().encode("the release tarball");
    await ssh.run(worker(), remoteCommand(["dd", "of=/tmp/x"]), { timeoutMs: 1000, stdin: bytes });
    await ssh.run(worker(), remoteCommand(["true"]), { timeoutMs: 1000 });
    expect(calls.map((call) => call.stdin)).toEqual([bytes, undefined]);
  });

  test("passes the remote command's own exit status and output through", async () => {
    const { transport: ssh } = transport(exited(127, "", "bash: fffactory: No such file"));
    expect(await ssh.run(worker(), INSPECT_COMMAND, { timeoutMs: 1000 })).toEqual({
      kind: "completed",
      exitCode: 127,
      stdout: "",
    });
  });

  test("classifies OpenSSH's own failures without echoing them", async () => {
    const cases: [string, unknown][] = [
      ["Host key verification failed.", { kind: "host_key_mismatch" }],
      ["@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @", { kind: "host_key_mismatch" }],
      ["fffactory-admin@100.64.0.10: Permission denied (publickey).", { kind: "access_denied" }],
      [
        "tailscale: tailnet policy does not permit you to SSH to this node",
        { kind: "access_denied" },
      ],
      [
        "ssh: connect to host 100.64.0.10 port 22: Connection timed out",
        { kind: "unreachable", reason: "the connection timed out" },
      ],
      [
        "ssh: connect to host 100.64.0.10 port 22: Connection refused",
        { kind: "unreachable", reason: "the connection was refused" },
      ],
      [
        "ssh: connect to host 100.64.0.10 port 22: No route to host",
        { kind: "unreachable", reason: "there is no route to it" },
      ],
      [
        "Connection closed by 100.64.0.10 port 22",
        { kind: "unreachable", reason: "the connection dropped" },
      ],
      [
        "Timeout, server 100.64.0.10 not responding.",
        { kind: "unreachable", reason: "the connection dropped" },
      ],
      ["something new", { kind: "unreachable", reason: "ssh could not connect" }],
    ];
    for (const [stderr, expected] of cases) {
      const { transport: ssh } = transport(exited(255, "", stderr));
      expect(await ssh.run(worker(), INSPECT_COMMAND, { timeoutMs: 1000 })).toEqual(
        expected as never,
      );
    }
  });

  test("reports a missing client, a timeout and a failed start", async () => {
    const cases: [ProcessOutcome, unknown][] = [
      [{ kind: "not_found" }, { kind: "client_missing" }],
      [{ kind: "timed_out" }, { kind: "timed_out" }],
      [
        { kind: "not_started", code: "EACCES" },
        { kind: "not_started", code: "EACCES" },
      ],
    ];
    for (const [outcome, expected] of cases) {
      const { transport: ssh } = transport(outcome);
      expect(await ssh.run(worker(), INSPECT_COMMAND, { timeoutMs: 1000 })).toEqual(
        expected as never,
      );
    }
  });

  test("the arguments name the worker by address and host key alias only", () => {
    const argv = sshArguments(worker(), "/private/known_hosts");
    expect(argv.slice(-2)).toEqual(["--", "100.64.0.10"]);
    expect(argv).toContain(`HostKeyAlias=${NAME}`);
    expect(argv).toContain("UserKnownHostsFile=/private/known_hosts");
  });
});
