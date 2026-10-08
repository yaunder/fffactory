/**
 * The worker side of `host verify` (readiness §Verification, §Enrollment): the TypeScript
 * verifiers over a worker laid out in a temporary directory, with every command answered by
 * a scripted runner. Nothing runs as another user or reaches a network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import type { Release } from "../../src/domain/instance";
import { verificationJson } from "../../src/domain/readiness";
import { readinessVerdict } from "../../src/domain/status";
import {
  AS_FACTORY,
  CHECK_TIMEOUT_MS,
  PLUGINS_TIMEOUT_MS,
  TOOLCHAIN,
  workerVerifier,
} from "../../src/host/verify";
import type { ProcessOutcome, ProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { CONFIGURATION_SHA256, inspection, installed } from "../support/fake-workers";
import { system, WORKER_HOSTNAME } from "./worker-scenarios";

const RELEASE = "0.3.0" as Release;
const NOW = new Date("2026-09-30T12:00:00.000Z");
const UID = process.getuid?.() ?? 1000;
const PINS = "# pins\nCODEX_VERSION=0.156.1\nCLAUDE_CODE_VERSION='2.1.280'\n";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-verify-"));
  const steps = join(root, WORKER_PATHS.releases, RELEASE, "steps");
  await mkdir(steps, { recursive: true });
  await writeFile(join(steps, "versions.env"), PINS);
  for (const directory of ["workspace/repos", "workspace/cache"])
    await mkdir(join(root, directory), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exited = (exitCode: number, stdout = ""): ProcessOutcome => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr: "",
});

/** What a healthy worker answers, by the command run as factory or as root. */
const HEALTHY: Record<string, ProcessOutcome> = {
  "id -u factory": exited(0, `${UID}\n`),
  "node --version": exited(0, "v22.12.0\n"),
  "codex --version": exited(0, "codex-cli 0.156.1\n"),
  "claude --version": exited(0, "2.1.280 (Claude Code)\n"),
  "systemctl is-active tailscaled.service": exited(0, "active\n"),
  "gh auth status --hostname github.com": exited(0, "Logged in to github.com account octocat\n"),
  "codex login status": exited(0, "Logged in using ChatGPT\n"),
  "claude auth status": exited(0, "Logged in as someone@example.com\n"),
};

/** A runner answering from `HEALTHY` and `overrides`, and exit 0 for anything else. */
function runner(overrides: Record<string, ProcessOutcome> = {}) {
  const calls: { argv: readonly string[]; timeoutMs: number; env: unknown }[] = [];
  const run: ProcessRunner = async (argv, timeoutMs, options) => {
    calls.push({ argv, timeoutMs, env: options?.env });
    const asFactory = AS_FACTORY.every((token, index) => argv[index] === token);
    const command = (asFactory ? argv.slice(AS_FACTORY.length) : argv)
      .map((token) => token.split("/").at(-1))
      .join(" ");
    return overrides[command] ?? HEALTHY[command] ?? exited(0);
  };
  return { run, calls };
}

async function verify(overrides: Record<string, ProcessOutcome> = {}) {
  const { run, calls } = runner(overrides);
  const verification = await workerVerifier({
    ...system(root, { run }),
    now: () => NOW,
    release: RELEASE,
  }).verify();
  return { verification, calls };
}

function statusOf(verification: { checks: readonly { id: string; status: string }[] }) {
  return Object.fromEntries(verification.checks.map((check) => [check.id, check.status]));
}

describe("host verify's software checks (readiness §Verification)", () => {
  test("a healthy worker passes every check", async () => {
    const { verification } = await verify();
    expect(verification).toMatchObject({
      protocol_version: 1,
      hostname: WORKER_HOSTNAME,
      verified_at: NOW.toISOString(),
    });
    expect(statusOf(verification)).toEqual({
      factory_account: "passed",
      toolchain: "passed",
      workspace: "passed",
      agents: "passed",
      plugins: "passed",
      tailscaled: "passed",
    });
  });

  test("names each tool that is missing, failing, or Node other than 22", async () => {
    const { verification } = await verify({
      "gh --version": exited(127),
      "rg --version": { kind: "timed_out" },
      "node --version": exited(0, "v18.20.0\n"),
    });
    expect(verification.checks.find((check) => check.id === "toolchain")).toEqual({
      id: "toolchain",
      status: "failed",
      summary: "Missing, failing or the wrong version: GitHub CLI, ripgrep, Node 22",
    });
  });

  test("the workspace must exist and belong to factory", async () => {
    await rm(join(root, "workspace/cache"), { recursive: true });
    const { verification } = await verify();
    expect(verification.checks.find((check) => check.id === "workspace")?.summary).toBe(
      "Missing or not owned by factory: /workspace/cache",
    );
    const other = await verify({ "id -u factory": exited(0, `${UID + 1}\n`) });
    expect(statusOf(other.verification).workspace).toBe("failed");
  });

  test("a missing factory account fails, and so does everything it owns", async () => {
    const { verification } = await verify({ "id -u factory": exited(1) });
    expect(statusOf(verification)).toMatchObject({
      factory_account: "failed",
      workspace: "failed",
    });
  });

  test("the agents must report the versions the release pins", async () => {
    const { verification } = await verify({ "codex --version": exited(0, "codex-cli 0.150.0\n") });
    expect(verification.checks.find((check) => check.id === "agents")?.summary).toBe(
      "Missing or not at its pin: Codex",
    );
    await rm(join(root, WORKER_PATHS.releases, RELEASE, "steps/versions.env"));
    expect(statusOf((await verify()).verification).agents).toBe("failed");
  });

  test("the plugins step verifies the plugins, and tailscaled must be active", async () => {
    const { verification, calls } = await verify({
      "bash plugins.sh verify": exited(1),
      "systemctl is-active tailscaled.service": exited(3, "inactive\n"),
    });
    expect(statusOf(verification)).toMatchObject({ plugins: "failed", tailscaled: "failed" });
    const plugins = calls.find(({ argv }) => argv.at(-1) === "verify");
    expect(plugins?.argv).toEqual([
      "/bin/bash",
      join(root, WORKER_PATHS.releases, RELEASE, "steps", "plugins.sh"),
      "verify",
    ]);
    // It reads every plugin checkout, so it has its own, longer deadline.
    expect(plugins?.timeoutMs).toBe(PLUGINS_TIMEOUT_MS);
    expect(PLUGINS_TIMEOUT_MS).toBe(120_000);
  });
});

describe("host verify's enrollment (readiness §Enrollment)", () => {
  test("checks each credential as factory: enrolled, pending, or unknown when it cannot tell", async () => {
    const { verification } = await verify({
      "codex login status": exited(1, "Not logged in\n"),
      "claude auth status": exited(127),
    });
    // States only: Paseo clients are not checked until phase 3, and the CLI names the steps.
    expect(verification.enrollment).toEqual([
      { id: "github", state: "enrolled" },
      { id: "openai", state: "pending" },
      { id: "anthropic", state: "unknown" },
    ]);
    const timedOut = await verify({
      "gh auth status --hostname github.com": { kind: "timed_out" },
    });
    expect(timedOut.verification.enrollment[0]?.state).toBe("unknown");
  });

  test("runs factory's commands through runuser and env -i, with nothing of root's environment", async () => {
    const { calls } = await verify();
    const credential = calls.find(({ argv }) => argv.includes("auth") && argv.includes("gh"));
    expect(credential).toEqual({
      argv: [
        "/usr/sbin/runuser",
        "-u",
        "factory",
        "--",
        "/usr/bin/env",
        "-i",
        "HOME=/home/factory",
        "PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "LANG=C.UTF-8",
        "DISABLE_UPDATES=1",
        "gh",
        "auth",
        "status",
        "--hostname",
        "github.com",
      ],
      timeoutMs: CHECK_TIMEOUT_MS,
      env: {},
    });
    const tools = calls.filter(({ argv }) => argv[0] === AS_FACTORY[0]).length;
    // Every tool, both agents and three credentials.
    expect(tools).toBe(TOOLCHAIN.length + 2 + 3);
  });

  test("a worker it finds healthy and fully enrolled is ready in status", async () => {
    const { verification } = await verify();
    const worker = inspection(WORKER_HOSTNAME, {
      installation: installed("0.3.0", verification),
    });
    const expected = {
      hostname: WORKER_HOSTNAME,
      release: "0.3.0",
      configurationSha256: CONFIGURATION_SHA256,
    };
    expect(readinessVerdict(worker, expected)).toEqual({
      status: "ready",
      summary: "Ready on release 0.3.0",
      details: [],
      nextAction: null,
    });
  });

  test("never puts what a tool printed in the document", async () => {
    const { verification } = await verify();
    const text = verificationJson(verification);
    for (const printed of ["octocat", "someone@example.com", "ChatGPT", "v22.12.0"])
      expect(text).not.toContain(printed);
  });
});
