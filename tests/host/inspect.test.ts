import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlPlaneProjection,
  hostProjection,
  hostProjectionJson,
} from "../../src/domain/host-projection";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import type { FactoryId, HostKey, Release, SecretReference } from "../../src/domain/instance";
import { sha256Text } from "../../src/infrastructure/release-tarball";
import { localWorkerSystem, workerInspector } from "../../src/host/inspect";
import type { ProcessOutcome, ProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { activate, system } from "./worker-scenarios";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-worker-"));
  await mkdir(join(root, WORKER_PATHS.releases), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function inspect(overrides: Parameters<typeof system>[1] = {}) {
  return workerInspector(system(root, overrides)).inspect();
}

describe("host inspect's active release", () => {
  test("is broken when current is not a symbolic link", async () => {
    await mkdir(join(root, WORKER_PATHS.activeRelease));
    expect((await inspect()).release).toEqual({ state: "broken" });
  });

  test("is broken when the link does not name releases/<version>", async () => {
    // A well-formed release 0.3.0 exists, so each target is broken by its shape alone.
    await activate(root, "0.3.0");
    for (const target of [
      "/opt/fffactory/releases/0.3.0",
      "../x/releases/0.3.0",
      "releases/../etc",
      "elsewhere",
    ]) {
      await rm(join(root, WORKER_PATHS.activeRelease), { force: true });
      await symlink(target, join(root, WORKER_PATHS.activeRelease));
      expect((await inspect()).release).toEqual({ state: "broken" });
    }
  });

  test("is broken when the release's marker records another release or is not JSON", async () => {
    await activate(root, "0.3.0");
    const marker = join(root, WORKER_PATHS.releases, "0.3.0/.fffactory-assets.json");
    for (const text of [
      JSON.stringify({ release: "0.2.0", sha256: "c".repeat(64) }),
      JSON.stringify({ release: "0.3.0", sha256: "short" }),
      "null",
      "not json",
    ]) {
      await writeFile(marker, text);
      expect((await inspect()).release).toEqual({ state: "broken" });
    }
  });

  test("is active for a prerelease version", async () => {
    await activate(root, "0.4.0-rc.1");
    expect((await inspect()).release).toEqual({
      state: "active",
      version: "0.4.0-rc.1",
      sha256: "c".repeat(64),
    });
  });
});

describe("host inspect's configuration (host protocol §inspect)", () => {
  const plain = hostProjection(
    "fff-aaaa1111" as FactoryId,
    "builder-1" as HostKey,
    "0.3.0" as Release,
  );
  const delivered = hostProjection(
    "fff-aaaa1111" as FactoryId,
    "builder-1" as HostKey,
    "0.3.0" as Release,
    undefined,
    {
      github_token_secret:
        "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-aaaa1111/github-token-AbCdEf" as SecretReference,
    },
  );

  async function holding(text: string) {
    await mkdir(join(root, "var/lib/fffactory"), { recursive: true });
    await writeFile(join(root, WORKER_PATHS.configuration), text);
    return (await inspect()).configuration;
  }

  test("digests the control plane's part apart when the file carries credential references", async () => {
    const text = hostProjectionJson(delivered);
    expect(await holding(text)).toEqual({
      state: "present",
      sha256: sha256Text(text),
      control_plane_sha256: sha256Text(hostProjectionJson(controlPlaneProjection(delivered))),
    });
    expect(sha256Text(hostProjectionJson(controlPlaneProjection(delivered)))).toBe(
      sha256Text(hostProjectionJson(plain)),
    );
  });

  test("reports the file's digest alone when it carries none, or is no projection", async () => {
    for (const text of [hostProjectionJson(plain), "not a projection", JSON.stringify(delivered)])
      expect(await holding(text)).toEqual({ state: "present", sha256: sha256Text(text) });
  });
});

describe("host inspect's evidence", () => {
  test("reads unquoted os-release values, and needs both ID and VERSION_ID", async () => {
    await mkdir(join(root, "etc"));
    await writeFile(join(root, "etc/os-release"), "ID=amzn\nVERSION_ID=2023\n");
    expect((await inspect()).evidence.os).toEqual({ id: "amzn", version_id: "2023" });
    await writeFile(join(root, "etc/os-release"), "ID=amzn\n");
    expect((await inspect()).evidence.os).toBeNull();
    await writeFile(join(root, "etc/os-release"), 'ID="amzn linux"\nVERSION_ID=2023\n');
    expect((await inspect()).evidence.os).toBeNull();
  });

  test("reports a hostname or architecture it cannot vouch for as unknown", async () => {
    const document = await inspect({ hostname: () => "bad host;name", machine: () => "" });
    expect(document.hostname).toBe("unknown");
    expect(document.evidence.architecture).toBe("unknown");
  });

  test("reports free space it cannot trust as null", async () => {
    for (const bytes of [Number.NaN, -1, 2 ** 60])
      expect((await inspect({ availableBytes: async () => bytes })).evidence.available_bytes).toBe(
        null,
      );
  });

  test("asks for free space under the releases directory", async () => {
    const asked: string[] = [];
    await inspect({
      availableBytes: async (path) => {
        asked.push(path);
        return 1;
      },
    });
    expect(asked).toEqual([join(root, WORKER_PATHS.releases)]);
  });
});

describe("host inspect's free space before bootstrap", () => {
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });

  test("is measured on the releases directory's nearest existing parent", async () => {
    const asked: string[] = [];
    const document = await inspect({
      availableBytes: async (path) => {
        asked.push(path);
        if (asked.length < 3) throw missing();
        return 7;
      },
    });
    expect(document.evidence.available_bytes).toBe(7);
    expect(asked).toEqual([
      join(root, "opt/fffactory/releases"),
      join(root, "opt/fffactory"),
      join(root, "opt"),
    ]);
  });

  test("is null when nothing up to the root exists, or on another error", async () => {
    expect(
      (
        await inspect({
          availableBytes: async () => {
            throw missing();
          },
        })
      ).evidence.available_bytes,
    ).toBeNull();
    let calls = 0;
    const denied = await inspect({
      availableBytes: async () => {
        calls += 1;
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });
    expect(denied.evidence.available_bytes).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("host inspect's services", () => {
  function runner(outcome: ProcessOutcome) {
    const calls: { argv: readonly string[]; env: unknown }[] = [];
    const run: ProcessRunner = async (argv, _timeoutMs, options) => {
      calls.push({ argv, env: options?.env });
      return outcome;
    };
    return { run, calls };
  }

  test("runs systemctl is-active with the system's own PATH", async () => {
    const { run, calls } = runner({
      kind: "exited",
      exitCode: 3,
      stdout: "inactive\n",
      stderr: "",
    });
    expect((await inspect({ run })).services).toEqual([{ name: "tailscaled", state: "inactive" }]);
    expect(calls).toEqual([
      {
        argv: ["systemctl", "is-active", "tailscaled.service"],
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
      },
    ]);
  });

  test("a state it cannot read is unknown", async () => {
    for (const outcome of [
      { kind: "not_found" },
      { kind: "timed_out" },
      { kind: "not_started", code: "EACCES" },
      { kind: "exited", exitCode: 1, stdout: "something else\n", stderr: "" },
    ] as ProcessOutcome[]) {
      const { run } = runner(outcome);
      expect((await inspect({ run })).services).toEqual([{ name: "tailscaled", state: "unknown" }]);
    }
  });
});

describe("the local worker system", () => {
  test("reads the real root, and measures free space with statfs", async () => {
    const local = localWorkerSystem();
    expect(local.root).toBe("/");
    expect(local.hostname()).toBeString();
    expect(local.machine()).toBeString();
    expect(await local.availableBytes(root)).toBeGreaterThan(0);
  });
});
