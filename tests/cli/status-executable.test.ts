/**
 * `fffactory status` as the spawned executable: stand-in `tailscale` and `ssh` on a private
 * PATH, STS and EC2 answered by local stubs. No test runs the host's own `ssh` or
 * `tailscale`, reaches a real worker or tailnet, or reads an AWS account.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostInspectionJson } from "../../src/domain/host-protocol";
import { dispatchInspectionJson } from "../../src/domain/dispatch-projection";
import type { SecretReference } from "../../src/domain/instance";
import { repositoryInspectionJson } from "../../src/domain/repository-placement";
import { isolatedAwsEnvironment } from "../support/aws-isolation";
import { HOST_KEY, readyWorker } from "../support/fake-workers";
import { spawnCli } from "../support/spawn-cli";
import { type StubEc2Instances, stubEc2Instances } from "../support/stub-ec2-instances";
import { EXAMPLE_CREDENTIALS, type StubSts, stubSts } from "../support/stub-sts";

const EXAMPLE = resolve(import.meta.dir, "../../examples/factory.json");
const WORKER = "example-builder-1";
const ACCOUNT = "123456789012";

let scratch: string;
let sts: StubSts | undefined;
let ec2: StubEc2Instances | undefined;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-status-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});
afterEach(() => {
  sts?.stop();
  ec2?.stop();
});

/** `tailscale.tag` in `examples/factory.json`. */
const TAG = "tag:software-factory";

function tailscaleStatus(online: boolean, tags: readonly string[] = [TAG]): string {
  return JSON.stringify({
    BackendState: "Running",
    Self: { HostName: "operator-laptop", DNSName: "operator-laptop.ts.net.", Online: true },
    Peer: {
      "nodekey:worker": {
        HostName: WORKER,
        DNSName: `${WORKER}.example-tailnet.ts.net.`,
        TailscaleIPs: ["100.64.0.10"],
        Online: online,
        sshHostKeys: [HOST_KEY],
        Tags: tags,
      },
    },
  });
}

/**
 * A private directory of stand-ins: `tailscale` prints `peerView`; `ssh` records its
 * arguments, environment and the known_hosts file it was given, then prints `answer` and
 * exits with `exit`, writing `stderr` to standard error.
 */
async function standIns(
  name: string,
  {
    peerView,
    answer = "",
    repositoryAnswer = "",
    dispatchAnswer = dispatchInspectionJson({
      protocol_version: 1,
      state: "not_requested",
      blockers: [],
      changed: false,
    }),
    exit = 0,
    stderr = "",
  }: {
    peerView: string;
    answer?: string;
    repositoryAnswer?: string;
    dispatchAnswer?: string;
    exit?: number;
    stderr?: string;
  },
) {
  const directory = join(scratch, name);
  const bin = join(directory, "bin");
  const log = join(directory, "log");
  await mkdir(bin, { recursive: true });
  await mkdir(log);
  await writeFile(join(directory, "peers.json"), peerView);
  await writeFile(join(directory, "answer"), answer);
  await writeFile(join(directory, "repository-answer"), repositoryAnswer);
  await writeFile(join(directory, "dispatch-answer"), dispatchAnswer);
  const scripts = {
    tailscale: `cat '${directory}/peers.json'`,
    ssh: [
      `case " $* " in *" host repositories --json ") suffix=-repositories; answer=repository-answer ;; *" dispatch inspect ") suffix=-dispatch; answer=dispatch-answer ;; *) suffix=; answer=answer ;; esac`,
      `printf '%s\\n' "$@" > '${log}/args'\${suffix}`,
      `env > '${log}/env'`,
      'for arg in "$@"; do',
      `  case "$arg" in UserKnownHostsFile=*) cp "\${arg#UserKnownHostsFile=}" '${log}/known_hosts' ;; esac`,
      "done",
      `cat '${directory}/'\${answer}`,
      `printf '%s' '${stderr}' >&2`,
      `exit ${exit}`,
    ].join("\n"),
  };
  for (const [tool, script] of Object.entries(scripts)) {
    await writeFile(join(bin, tool), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, tool), 0o755);
  }
  // Only the few real tools the stand-ins use: the host's own ssh and tailscale stay out.
  for (const tool of ["cat", "cp", "env"]) {
    const real = Bun.which(tool);
    if (!real) throw new Error(`${tool} is not on PATH`);
    await symlink(real, join(bin, tool));
  }
  const temporary = join(directory, "tmp");
  await mkdir(temporary);
  return { bin, log, temporary };
}

async function status(tools: Awaited<ReturnType<typeof standIns>>) {
  sts = stubSts({ kind: "caller", account: ACCOUNT, arn: `arn:aws:sts::${ACCOUNT}:user/op` });
  ec2 = stubEc2Instances({
    pages: [
      [
        {
          id: "i-0123456789abcdef0",
          state: "running",
          tags: { "fffactory:factory-id": "example", "fffactory:host-key": "builder-1" },
        },
      ],
    ],
  });
  const credentials = join(tools.temporary, "..", "credentials");
  await writeFile(
    credentials,
    `[default]\naws_access_key_id = ${EXAMPLE_CREDENTIALS.accessKeyId}\n` +
      `aws_secret_access_key = ${EXAMPLE_CREDENTIALS.secretAccessKey}\n`,
  );
  const env = {
    PATH: tools.bin,
    HOME: scratch,
    TMPDIR: tools.temporary,
    ...isolatedAwsEnvironment(scratch),
    AWS_SHARED_CREDENTIALS_FILE: credentials,
    AWS_ENDPOINT_URL_STS: sts.endpoint,
    AWS_ENDPOINT_URL_EC2: ec2.endpoint,
  };
  const result = await spawnCli(["status", "--json", "--instance", EXAMPLE], {
    cwd: scratch,
    env,
  });
  return { ...result, report: result.stdout ? JSON.parse(result.stdout) : undefined };
}

describe("fffactory status executable", () => {
  test("an offline worker exits 2 with an unknown release, and is never connected to", async () => {
    const tools = await standIns("offline", { peerView: tailscaleStatus(false) });
    const result = await status(tools);
    expect(result.code).toBe(2);
    expect(result.report.workers).toEqual([
      expect.objectContaining({
        key: "builder-1",
        status: "not_ready",
        tailnet: "offline",
        release: "unknown",
        machine: { state: "running", instance_id: "i-0123456789abcdef0" },
      }),
    ]);
    expect(await readdir(tools.log)).toEqual([]);
  });

  test("a device named as the worker without the factory's tag exits 2 and is never connected to", async () => {
    const tools = await standIns("untagged", {
      peerView: tailscaleStatus(true, ["tag:intruder"]),
    });
    const result = await status(tools);
    expect(result.code).toBe(2);
    expect(result.report.workers[0]).toMatchObject({
      status: "not_ready",
      tailnet: "untagged",
      release: "unknown",
    });
    expect(await readdir(tools.log)).toEqual([]);
    for (const tag of [TAG, "tag:intruder"])
      expect(result.stdout + result.stderr).not.toContain(tag);
  });

  test("a worker SSH cannot reach exits 2 with an unknown release", async () => {
    const tools = await standIns("unreachable", {
      peerView: tailscaleStatus(true),
      exit: 255,
      stderr: "ssh: connect to host 100.64.0.10 port 22: Connection timed out",
    });
    const result = await status(tools);
    expect(result.code).toBe(2);
    expect(result.report.workers[0]).toMatchObject({
      tailnet: "online",
      release: "unknown",
      summary: "SSH could not reach it: the connection timed out",
    });
    expect(result.stdout + result.stderr).not.toContain("100.64.0.10 port 22");
  });

  test("a ready worker exits 0, reached as fffactory-admin with only the tailnet's host key", async () => {
    const tools = await standIns("ready", {
      peerView: tailscaleStatus(true),
      answer: hostInspectionJson(
        readyWorker(
          "example",
          "builder-1",
          "0.1.0",
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:example/builder-1/paseo-password-AbCdEf" as SecretReference,
        ),
      ),
      repositoryAnswer: repositoryInspectionJson({
        protocol_version: 1,
        state: "synchronized",
        unmanaged: [],
      }),
    });
    const result = await status(tools);
    expect(result.stderr).toBe(`Instance: ${EXAMPLE} (--instance)\n`);
    expect(result.code).toBe(0);
    expect(result.report.workers[0]).toMatchObject({ status: "ready", release: "0.1.0" });
    const args = (await readFile(join(tools.log, "args"), "utf8")).trimEnd().split("\n");
    expect(args.slice(0, 3)).toEqual(["-F", "/dev/null", "-o"]);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain(`HostKeyAlias=${WORKER}`);
    expect(args.slice(-7)).toEqual([
      "fffactory-admin",
      "--",
      "100.64.0.10",
      "/opt/fffactory/current/bin/fffactory",
      "host",
      "inspect",
      "--json",
    ]);
    const repositoryArgs = (await readFile(join(tools.log, "args-repositories"), "utf8"))
      .trimEnd()
      .split("\n");
    expect(repositoryArgs.slice(-7)).toEqual([
      "fffactory-admin",
      "--",
      "100.64.0.10",
      "/opt/fffactory/current/bin/fffactory",
      "host",
      "repositories",
      "--json",
    ]);
    const dispatchArgs = (await readFile(join(tools.log, "args-dispatch"), "utf8"))
      .trimEnd()
      .split("\n");
    expect(dispatchArgs.slice(-8)).toEqual([
      "fffactory-admin",
      "--",
      "100.64.0.10",
      "sudo",
      "-n",
      "/usr/local/libexec/fffactory-activate",
      "dispatch",
      "inspect",
    ]);
    expect(await readFile(join(tools.log, "known_hosts"), "utf8")).toBe(`${WORKER} ${HOST_KEY}\n`);
    const env = await readFile(join(tools.log, "env"), "utf8");
    expect(env).not.toContain("AWS_");
    expect(env).not.toContain(EXAMPLE_CREDENTIALS.secretAccessKey);
    // The private known_hosts directory is gone once ssh returns.
    expect(await readdir(tools.temporary)).toEqual([]);
  });

  test("a worker without a release reports none", async () => {
    const tools = await standIns("no-release", {
      peerView: tailscaleStatus(true),
      exit: 127,
      stderr: "bash: /opt/fffactory/current/bin/fffactory: No such file or directory",
    });
    const result = await status(tools);
    expect(result.code).toBe(2);
    expect(result.report.workers[0]).toMatchObject({ release: "none", status: "not_ready" });
  });
});
