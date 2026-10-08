import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import type { FactoryId, HostKey, Release, SecretReference } from "../../src/domain/instance";
import type { ApplySystem } from "../../src/host/apply";
import { workerControlPlane } from "../../src/host/control-plane";
import type { ProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { system } from "./worker-scenarios";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-control-plane-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:fff-aaaa1111/paseo-AbCdEf" as SecretReference;
const PROJECTION = hostProjectionJson(
  hostProjection("fff-aaaa1111" as FactoryId, "builder-1" as HostKey, "0.3.0" as Release, ARN),
);

function endpoint(
  run: ProcessRunner,
  input = PROJECTION,
  isRoot = true,
  hostname = "fff-aaaa1111-builder-1",
) {
  const worker: ApplySystem = {
    ...system(root),
    run,
    now: () => new Date(),
    isRoot: () => isRoot,
    hostname: () => hostname,
    readInput: async () => input,
    release: "0.3.0" as Release,
    lock: async () => ({ release: () => {} }),
  };
  return workerControlPlane(worker);
}

describe("the worker control-plane endpoint", () => {
  test("reads activity by dropping to factory and using the active release auth wrapper", async () => {
    const calls: readonly string[][] = [];
    const run: ProcessRunner = async (argv) => {
      (calls as string[][]).push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: '{"agents":[{"id":"one"}]}', stderr: "" };
    };
    expect(await endpoint(run).activity()).toEqual({ kind: "active", count: 1 });
    expect(calls[0]).toContain("/usr/sbin/runuser");
    expect(calls[0]).toContain(
      join(root, "/opt/fffactory/current/steps/control-plane/paseo-auth.sh"),
    );
    expect(calls[0]).toContain("factory");
  });

  test.each([
    ["[]", { kind: "idle" as const }],
    ['{"agents":[]}', { kind: "idle" as const }],
    [
      '{"agents":"not-an-array"}',
      { kind: "unknown" as const, reason: "Paseo activity was invalid" },
    ],
    ["not json", { kind: "unknown" as const, reason: "Paseo activity was invalid" }],
  ])("conservatively interprets Paseo activity %s", async (stdout, expected) => {
    const run: ProcessRunner = async () => ({ kind: "exited", exitCode: 0, stdout, stderr: "" });
    expect(await endpoint(run).activity()).toEqual(expected);
  });

  test("treats a failed Paseo activity command as unknown", async () => {
    const run: ProcessRunner = async () => ({ kind: "timed_out" });
    expect(await endpoint(run).activity()).toEqual({
      kind: "unknown",
      reason: "Paseo activity could not be read",
    });
  });

  test("streams only the validated secret reference to the active release setup step", async () => {
    let seen: { argv: readonly string[]; stdin?: Uint8Array } | undefined;
    const run: ProcessRunner = async (argv, _timeout, options) => {
      seen = { argv, ...(options?.stdin ? { stdin: options.stdin } : {}) };
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await endpoint(run).install()).toEqual({ kind: "done" });
    expect(seen?.argv).toEqual([
      "/bin/bash",
      join(root, "/opt/fffactory/current/steps/control-plane/setup-host.sh"),
    ]);
    expect(new TextDecoder().decode(seen?.stdin)).toBe(`${ARN}\n`);
    expect(PROJECTION).toContain(ARN);
    expect(PROJECTION).not.toContain("raw-password");
  });

  test("restarts only through the fixed systemd action", async () => {
    const calls: readonly string[][] = [];
    const run: ProcessRunner = async (argv) => {
      (calls as string[][]).push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await endpoint(run).restart()).toEqual({ kind: "done" });
    expect(calls).toEqual([["/usr/bin/systemctl", "restart", "paseo.service"]]);
  });

  test("reloads through the active release authentication wrapper", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await endpoint(run).reload()).toEqual({ kind: "done" });
    expect(calls[0]).toContain(
      join(root, "/opt/fffactory/current/steps/control-plane/paseo-auth.sh"),
    );
    expect(calls[0]?.slice(-2)).toEqual(["daemon", "reload"]);
  });

  test("reports process failures without exposing process output", async () => {
    const exited: ProcessRunner = async () => ({
      kind: "exited",
      exitCode: 7,
      stdout: "secret output",
      stderr: "secret error",
    });
    expect(await endpoint(exited).restart()).toEqual({
      kind: "failed",
      reason: "Paseo restart exited 7",
    });
    const timedOut: ProcessRunner = async () => ({ kind: "timed_out" });
    expect(await endpoint(timedOut).reload()).toEqual({
      kind: "failed",
      reason: "Paseo reload timed_out",
    });
  });

  test("refuses an invalid projection before setup runs", async () => {
    let ran = false;
    const result = await endpoint(async () => {
      ran = true;
      return { kind: "not_found" };
    }, "{}\n").install();
    expect(result).toEqual({ kind: "failed", reason: "invalid host projection" });
    expect(ran).toBe(false);
  });

  test("refuses a projection addressed to another worker before setup runs", async () => {
    let ran = false;
    const result = await endpoint(
      async () => {
        ran = true;
        return { kind: "not_found" };
      },
      PROJECTION,
      true,
      "fff-aaaa1111-builder-2",
    ).install();
    expect(result).toEqual({ kind: "failed", reason: "host projection is for another worker" });
    expect(ran).toBe(false);
  });

  test("refuses every privileged control-plane action outside the root activator", async () => {
    let ran = false;
    const controlPlane = endpoint(
      async () => {
        ran = true;
        return { kind: "not_found" };
      },
      PROJECTION,
      false,
    );
    expect(await controlPlane.activity()).toEqual({ kind: "unknown", reason: "not root" });
    expect(await controlPlane.install()).toEqual({ kind: "failed", reason: "not root" });
    expect(await controlPlane.reload()).toEqual({ kind: "failed", reason: "not root" });
    expect(await controlPlane.restart()).toEqual({ kind: "failed", reason: "not root" });
    expect(ran).toBe(false);
  });
});
