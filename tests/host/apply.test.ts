/**
 * The worker side of `host apply` (host protocol §apply) over worker filesystems laid out in
 * temporary directories, with fake steps: real bash scripts in the release's `steps/`, run
 * by the real process runner, or a scripted runner. The verifier is a fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import { type HostApplyRecord, INSTALL_STEPS, parseHostApply } from "../../src/domain/installation";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import { ENROLLMENTS, type Verification } from "../../src/domain/readiness";
import { type ApplySystem, readLimited, workerApplier } from "../../src/host/apply";
import { workerEndpoint } from "../../src/host/endpoint";
import { flockExclusive } from "../../src/host/install-lock";
import type { HostVerifier } from "../../src/host/verify";
import {
  bunProcessRunner,
  type ProcessOutcome,
  type ProcessRunner,
} from "../../src/infrastructure/local-tool-probe";
import { sha256Text } from "../../src/infrastructure/release-tarball";
import { activate, system, WORKER_HOSTNAME } from "./worker-scenarios";

const RELEASE = "0.3.0" as Release;
const PROJECTION = hostProjectionJson(
  hostProjection("fff-aaaa1111" as FactoryId, "builder-1" as HostKey, RELEASE),
);
const STEP_NAMES = INSTALL_STEPS.map((step) => step.name);
const NOW = new Date("2026-09-30T12:00:00.000Z");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-apply-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function at(path: string): string {
  return join(root, path);
}

const RELEASE_DIRECTORY = () => at(join(WORKER_PATHS.releases, RELEASE));

/**
 * A bootstrapped worker with release 0.3.0 unpacked (not active) whose steps are fake: each
 * appends its name to `ran.log`, and fails when `fail-<name>` exists.
 */
async function worker(options: { os?: string; bootstrapped?: boolean } = {}) {
  await mkdir(at(WORKER_PATHS.releases), { recursive: true });
  await mkdir(at("/run"), { recursive: true });
  await mkdir(at("/etc"), { recursive: true });
  await writeFile(at("/etc/os-release"), options.os ?? 'ID="amzn"\nVERSION_ID="2023"\n');
  await mkdir(at(WORKER_PATHS.state), { recursive: true });
  if (options.bootstrapped !== false) await writeFile(at(WORKER_PATHS.bootstrapComplete), "");
  await activate(root, RELEASE);
  // `activate` also points `current` at it; an unpacked release is not yet active.
  await rm(at(WORKER_PATHS.activeRelease));
  const steps = join(RELEASE_DIRECTORY(), "steps");
  await mkdir(steps, { recursive: true });
  for (const name of STEP_NAMES)
    await writeFile(
      join(steps, `${name}.sh`),
      [
        "set -euo pipefail",
        `echo "${name}" >>"${at("ran.log")}"`,
        `echo "output of ${name}"`,
        `echo "errors of ${name}" >&2`,
        `if [[ -e "${at(`fail-${name}`)}" ]]; then exit 3; fi`,
        "",
      ].join("\n"),
    );
}

function verification(): Verification {
  return {
    protocol_version: 1,
    hostname: WORKER_HOSTNAME,
    verified_at: NOW.toISOString(),
    checks: [{ id: "toolchain", status: "passed", summary: "Every tool runs" }],
    enrollment: ENROLLMENTS.map(({ id }) => ({ id, state: "pending" })),
  };
}

function fakeVerifier(result: Verification = verification()) {
  let runs = 0;
  const verifier: HostVerifier = {
    verify: async () => {
      runs += 1;
      return result;
    },
  };
  return { verifier, runs: () => runs };
}

function applySystem(overrides: Partial<ApplySystem> = {}): ApplySystem {
  return {
    ...system(root, { run: bunProcessRunner }),
    now: () => NOW,
    isRoot: () => true,
    readInput: async () => PROJECTION,
    release: RELEASE,
    lock: flockExclusive,
    ...overrides,
  };
}

async function ran(): Promise<string[]> {
  try {
    return (await readFile(at("ran.log"), "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

async function kept(): Promise<HostApplyRecord> {
  const parsed = parseHostApply(await readFile(at(WORKER_PATHS.lastApply), "utf8"));
  if (!parsed.ok || parsed.document.state === "refused") throw new Error("no record");
  return parsed.document;
}

describe("host apply, installing (host protocol §apply)", () => {
  test("runs every step in order in one process, then verifies, on the now active release", async () => {
    await worker();
    const { verifier, runs } = fakeVerifier();
    const result = await workerApplier(applySystem(), verifier).apply();
    expect(await ran()).toEqual(STEP_NAMES);
    expect(runs()).toBe(1);
    expect(result).toEqual({
      protocol_version: 1,
      hostname: WORKER_HOSTNAME,
      state: "succeeded",
      release: RELEASE,
      configuration_sha256: sha256Text(PROJECTION),
      started_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
      steps: STEP_NAMES.map((name) => ({ name, status: "succeeded", reason: null })),
      verification: verification(),
      failure: null,
    });
    expect(await kept()).toEqual(result as HostApplyRecord);
    expect(await readlink(at(WORKER_PATHS.activeRelease))).toBe(`releases/${RELEASE}`);
    expect(await readFile(at(WORKER_PATHS.configuration), "utf8")).toBe(PROJECTION);
    expect((await stat(at(WORKER_PATHS.configuration))).mode & 0o777).toBe(0o644);
    expect((await stat(at(WORKER_PATHS.lastApply))).mode & 0o777).toBe(0o644);
  });

  test("keeps each step's output in its log, never in the document", async () => {
    await worker();
    const result = await workerApplier(applySystem(), fakeVerifier().verifier).apply();
    const log = await readFile(at(join(WORKER_PATHS.logs, "harness.log")), "utf8");
    expect(log).toBe(
      "output of harness\nerrors of harness\n--- fffactory: step harness succeeded\n",
    );
    expect((await stat(at(join(WORKER_PATHS.logs, "harness.log")))).mode & 0o777).toBe(0o644);
    expect(JSON.stringify(result)).not.toContain("output of");
  });

  test("streams a step's output to its log as it runs, so a step that hangs leaves it", async () => {
    await worker();
    const steps = join(RELEASE_DIRECTORY(), "steps");
    await writeFile(
      join(steps, "packages.sh"),
      'echo "fetched the first package"\necho "then stalled" >&2\nexec sleep 30\n',
    );
    const result = await workerApplier(applySystem(), fakeVerifier().verifier, [
      { name: "packages", timeoutMs: 500 },
    ]).apply();
    expect(result.state !== "refused" && result.steps[0]).toEqual({
      name: "packages",
      status: "failed",
      reason: "did not finish within 0.5 s",
    });
    expect(await readFile(at(join(WORKER_PATHS.logs, "packages.log")), "utf8")).toBe(
      "fetched the first package\nthen stalled\n" +
        "--- fffactory: step packages failed: did not finish within 0.5 s\n",
    );
  });

  test("a log it cannot open fails that step, and runs nothing", async () => {
    await worker();
    await mkdir(at(WORKER_PATHS.logs), { recursive: true });
    await mkdir(at(join(WORKER_PATHS.logs, "packages.log")));
    const result = await workerApplier(applySystem(), fakeVerifier().verifier).apply();
    expect(await ran()).toEqual([]);
    expect(result).toMatchObject({ state: "failed", verification: null, failure: null });
    expect(result.state !== "refused" && result.steps[0]).toEqual({
      name: "packages",
      status: "failed",
      reason: `its log ${WORKER_PATHS.logs}/packages.log could not be opened (EISDIR)`,
    });
  });

  test("a failing step stops the install on the active but unhealthy release", async () => {
    await worker();
    await writeFile(at("fail-harness"), "");
    const { verifier, runs } = fakeVerifier();
    const result = await workerApplier(applySystem(), verifier).apply();
    expect(await ran()).toEqual(["packages", "user", "systemd", "harness"]);
    expect(runs()).toBe(0);
    expect(result).toMatchObject({ state: "failed", verification: null });
    expect(result.state !== "refused" && result.steps).toEqual([
      { name: "packages", status: "succeeded", reason: null },
      { name: "user", status: "succeeded", reason: null },
      { name: "systemd", status: "succeeded", reason: null },
      { name: "harness", status: "failed", reason: "exited with status 3" },
      { name: "plugins", status: "not_run", reason: null },
    ]);
    expect(await readlink(at(WORKER_PATHS.activeRelease))).toBe(`releases/${RELEASE}`);
    expect((await kept()).state).toBe("failed");
  });

  test("a rerun after the failure repairs the worker", async () => {
    await worker();
    await writeFile(at("fail-user"), "");
    const first = await workerApplier(applySystem(), fakeVerifier().verifier).apply();
    expect(first.state).toBe("failed");
    await rm(at("fail-user"));
    await rm(at("ran.log"));
    const second = await workerApplier(applySystem(), fakeVerifier().verifier).apply();
    expect(second.state).toBe("succeeded");
    expect(await ran()).toEqual(STEP_NAMES);
    expect((await kept()).state).toBe("succeeded");
  });

  test("a verification with a failed check fails the install", async () => {
    await worker();
    const unhealthy = {
      ...verification(),
      checks: [{ id: "agents", status: "failed" as const, summary: "Codex is missing" }],
    };
    const result = await workerApplier(applySystem(), fakeVerifier(unhealthy).verifier).apply();
    expect(result).toMatchObject({ state: "failed", verification: unhealthy });
  });

  test("records the install as running before each step, with the steps so far", async () => {
    await worker();
    const seen: string[] = [];
    const run: ProcessRunner = async (argv) => {
      const record = await kept();
      const name = (argv[1] ?? "").split("/").at(-1)?.replace(".sh", "");
      seen.push(`${name}: ${record.state} ${record.steps.map((step) => step.status).join(",")}`);
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    await workerApplier(applySystem({ run }), fakeVerifier().verifier).apply();
    expect(seen).toEqual([
      "packages: running not_run,not_run,not_run,not_run,not_run",
      "user: running succeeded,not_run,not_run,not_run,not_run",
      "systemd: running succeeded,succeeded,not_run,not_run,not_run",
      "harness: running succeeded,succeeded,succeeded,not_run,not_run",
      "plugins: running succeeded,succeeded,succeeded,succeeded,not_run",
    ]);
  });

  test("runs each step with bash, its timeout and a fixed environment of its inputs", async () => {
    await worker();
    const calls: { argv: readonly string[]; timeoutMs: number; env: unknown }[] = [];
    const run: ProcessRunner = async (argv, timeoutMs, options) => {
      calls.push({ argv, timeoutMs, env: options?.env });
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    await workerApplier(applySystem({ run }), fakeVerifier().verifier).apply();
    const steps = join(RELEASE_DIRECTORY(), "steps");
    expect(calls.map(({ argv, timeoutMs }) => [argv, timeoutMs])).toEqual(
      INSTALL_STEPS.map(({ name, timeoutMs }) => [
        ["/bin/bash", join(steps, `${name}.sh`)],
        timeoutMs,
      ]),
    );
    expect(calls[0]?.env).toEqual({
      PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/root",
      LANG: "C.UTF-8",
      FFFACTORY_RELEASE: RELEASE,
      FFFACTORY_STEPS: steps,
      FFFACTORY_STATE: at(WORKER_PATHS.state),
      FFFACTORY_HOSTNAME: WORKER_HOSTNAME,
      FFFACTORY_FACTORY_ID: "fff-aaaa1111",
      FFFACTORY_HOST_KEY: "builder-1",
    });
  });

  test("names why a step failed in its own words", async () => {
    const cases: [ProcessOutcome, string][] = [
      [{ kind: "timed_out" }, "did not finish within 1200 s"],
      [{ kind: "not_found" }, "bash is not installed"],
      [{ kind: "not_started", code: "EACCES" }, "could not be started (EACCES)"],
    ];
    for (const [outcome, reason] of cases) {
      await rm(root, { recursive: true, force: true });
      await mkdir(root);
      await worker();
      const run: ProcessRunner = async () => outcome;
      const result = await workerApplier(applySystem({ run }), fakeVerifier().verifier).apply();
      expect(result.state !== "refused" && result.steps[0]).toEqual({
        name: "packages",
        status: "failed",
        reason,
      });
    }
  });
});

describe("host apply, failing outside its steps", () => {
  test("a release link it cannot replace fails the install, recorded and printed", async () => {
    await worker();
    await mkdir(at(WORKER_PATHS.activeRelease));
    const { verifier, runs } = fakeVerifier();
    const result = await workerApplier(applySystem(), verifier).apply();
    expect(await ran()).toEqual([]);
    expect(runs()).toBe(0);
    expect(result).toMatchObject({
      state: "failed",
      finished_at: NOW.toISOString(),
      verification: null,
      failure: "host apply failed while making release 0.3.0 active (EISDIR)",
    });
    expect(await kept()).toEqual(result as HostApplyRecord);
  });

  test("a record it cannot keep still ends with a failed record printed", async () => {
    await worker();
    let writes = 0;
    const run: ProcessRunner = async () => {
      // After the first step, make the record's directory unwritable by replacing it.
      writes += 1;
      if (writes === 1) {
        await rm(at(WORKER_PATHS.state), { recursive: true });
        await writeFile(at(WORKER_PATHS.state), "");
      }
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await workerApplier(applySystem({ run }), fakeVerifier().verifier).apply();
    expect(result).toMatchObject({ state: "failed", verification: null });
    expect(result.state !== "refused" && result.failure).toStartWith(
      "host apply failed while recording the install (",
    );
  });

  test("verification that does not finish in time fails the install", async () => {
    await worker();
    const verifier: HostVerifier = { verify: () => new Promise(() => {}) };
    const result = await workerApplier(applySystem(), verifier, INSTALL_STEPS, 50).apply();
    expect(result).toMatchObject({
      state: "failed",
      verification: null,
      failure: "verification did not finish within 0.05 s",
    });
  });
});

describe("host apply, one install at a time", () => {
  test("refuses, changing nothing, while another host apply holds the install lock", async () => {
    await worker();
    const held = await flockExclusive(at(WORKER_PATHS.applyLock));
    try {
      const { verifier, runs } = fakeVerifier();
      const result = await workerApplier(applySystem(), verifier).apply();
      expect(result).toEqual({
        protocol_version: 1,
        hostname: WORKER_HOSTNAME,
        state: "refused",
        reason: "busy",
        message: "Another host apply is installing on this worker; wait for it to finish",
      });
      expect(await ran()).toEqual([]);
      expect(runs()).toBe(0);
      for (const path of [WORKER_PATHS.activeRelease, WORKER_PATHS.lastApply])
        expect(await stat(at(path)).catch(() => "absent")).toBe("absent");
    } finally {
      held?.release();
    }
  });

  test("holds the lock while its steps run, never lets them inherit it, and releases it", async () => {
    await worker();
    const steps = join(RELEASE_DIRECTORY(), "steps");
    await writeFile(join(steps, "packages.sh"), `ls -l /proc/$$/fd >"${at("fds")}" 2>&1 || true\n`);
    let heldDuringStep: boolean | undefined;
    const run: ProcessRunner = async (argv, timeoutMs, options) => {
      const other = await flockExclusive(at(WORKER_PATHS.applyLock));
      heldDuringStep = other === undefined;
      other?.release();
      return bunProcessRunner(argv, timeoutMs, options);
    };
    await workerApplier(applySystem({ run }), fakeVerifier().verifier, [
      { name: "packages", timeoutMs: 5000 },
    ]).apply();
    expect(heldDuringStep).toBe(true);
    if (process.platform === "linux")
      expect(await readFile(at("fds"), "utf8")).not.toContain("host-apply.lock");
    const after = await flockExclusive(at(WORKER_PATHS.applyLock));
    expect(after).toBeDefined();
    after?.release();
  });
});

describe("host apply, refusing (it changes nothing)", () => {
  async function refused(overrides: Partial<ApplySystem>, setup: () => Promise<void> = worker) {
    await setup();
    const { verifier, runs } = fakeVerifier();
    const result = await workerApplier(applySystem(overrides), verifier).apply();
    expect(await ran()).toEqual([]);
    expect(runs()).toBe(0);
    for (const path of [
      WORKER_PATHS.activeRelease,
      WORKER_PATHS.configuration,
      WORKER_PATHS.lastApply,
    ])
      expect(await stat(at(path)).catch(() => "absent")).toBe("absent");
    if (result.state !== "refused") throw new Error(`not refused: ${result.state}`);
    return { reason: result.reason, message: result.message };
  }

  test("unless it runs as root", async () => {
    expect(await refused({ isRoot: () => false })).toEqual({
      reason: "not_root",
      message: "host apply must run as root, through the activator",
    });
  });

  test("a host configuration that is not the canonical projection", async () => {
    expect(await refused({ readInput: async () => "{}" })).toEqual({
      reason: "invalid_configuration",
      message:
        "The host configuration on standard input is invalid: protocol_version must be an integer",
    });
  });

  test("another worker's configuration", async () => {
    const other = hostProjectionJson(
      hostProjection("fff-aaaa1111" as FactoryId, "builder-2" as HostKey, RELEASE),
    );
    expect(await refused({ readInput: async () => other })).toEqual({
      reason: "other_host",
      message: `The host configuration is for fff-aaaa1111-builder-2, not this worker, ${WORKER_HOSTNAME}`,
    });
  });

  test("a configuration for another release than this executable's", async () => {
    expect(await refused({ release: "0.4.0" as Release })).toEqual({
      reason: "release_mismatch",
      message: "The host configuration is for release 0.3.0, not this release, 0.4.0",
    });
  });

  test("a release the activator did not unpack", async () => {
    const setup = async () => {
      await worker();
      await rm(RELEASE_DIRECTORY(), { recursive: true });
    };
    expect(await refused({}, setup)).toEqual({
      reason: "release_missing",
      message:
        "Release 0.3.0 is not unpacked under /opt/fffactory/releases; host apply runs only through the activator",
    });
  });

  test("before bootstrap has finished, or on another base than Amazon Linux 2023", async () => {
    expect(await refused({}, () => worker({ bootstrapped: false }))).toMatchObject({
      reason: "bootstrap_incomplete",
    });
    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    expect(await refused({}, () => worker({ os: "ID=ubuntu\nVERSION_ID=24.04\n" }))).toEqual({
      reason: "unsupported_base",
      message: "This worker is not Amazon Linux 2023",
    });
  });
});

describe("host apply's step scripts", () => {
  test("a fake step script is plain bash", async () => {
    await worker();
    const script = join(RELEASE_DIRECTORY(), "steps", "packages.sh");
    await chmod(script, 0o644);
    const result = await workerApplier(applySystem(), fakeVerifier().verifier).apply();
    // Run through bash, a step needs no execute bit.
    expect(result.state).toBe("succeeded");
  });
});

describe("reading standard input", () => {
  function stream(...chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
  }

  test("reads it whole, or stops just past the limit", async () => {
    expect(await readLimited(stream("ab", "cd"), 10)).toBe("abcd");
    expect(await readLimited(stream("abcd", "efgh", "ijkl"), 5)).toBe("abcdef");
  });
});

describe("the worker endpoint", () => {
  test("inspects, applies and verifies the same worker", async () => {
    await worker();
    const run: ProcessRunner = async () => ({
      kind: "exited",
      exitCode: 0,
      stdout: "active\n",
      stderr: "",
    });
    const endpoint = workerEndpoint(applySystem({ run }));
    expect(endpoint.isRoot()).toBe(true);
    expect((await endpoint.inspect()).release).toEqual({ state: "none" });
    expect((await endpoint.verify()).hostname).toBe(WORKER_HOSTNAME);
    const result = await endpoint.apply();
    // The real verifiers find nothing the fake steps would have installed.
    expect(result).toMatchObject({ state: "failed", release: RELEASE });
    expect((await endpoint.inspect()).installation.state).toBe("failed");
  });
});
