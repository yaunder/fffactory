/**
 * The worker side of `host verify` (readiness §Verification, §Enrollment): the TypeScript
 * verifiers over a worker laid out in a temporary directory, with every command answered by
 * a scripted runner. Nothing runs as another user or reaches a network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTOR_CONFIGURATION } from "../../src/domain/collector";
import { COLLECTOR_UNITS } from "../../src/domain/collector-installation";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import {
  ANTHROPIC_KEY_FILE,
  CLAUDE_MANAGED_SETTINGS,
  claudeManagedSettingsJson,
} from "../../src/domain/installation";
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
  await writeFile(
    join(steps, "plugins.json"),
    '{"schema":1,"providers":{"claude":{"plugins":[]},"codex":{"plugins":[]}}}',
  );
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
  "claude plugin list --json": exited(0, "[]"),
  "claude plugin marketplace list --json": exited(0, "[]"),
  "id -u factory": exited(0, `${UID}\n`),
  "node --version": exited(0, "v22.12.0\n"),
  "codex --version": exited(0, "codex-cli 0.156.1\n"),
  "claude --version": exited(0, "2.1.280 (Claude Code)\n"),
  "systemctl is-active tailscaled.service": exited(0, "active\n"),
  "gh auth status --hostname github.com --active": exited(
    0,
    "Logged in to github.com account octocat\n",
  ),
  "codex login status": exited(0, "Logged in using ChatGPT\n"),
  "claude auth status": exited(0, "Logged in as someone@example.com\n"),
};

/** A runner answering from `HEALTHY` and `overrides`, and exit 0 for anything else. */
function runner(overrides: Record<string, ProcessOutcome> = {}) {
  const calls: { argv: readonly string[]; timeoutMs: number; cwd?: string; env: unknown }[] = [];
  const run: ProcessRunner = async (argv, timeoutMs, options) => {
    calls.push({ argv, timeoutMs, cwd: options?.cwd, env: options?.env });
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

  test("just and pnpm run as factory, in the agents' environment, for the toolchain to pass", async () => {
    const { verification, calls } = await verify();
    expect(statusOf(verification).toolchain).toBe("passed");
    for (const tool of ["just", "pnpm"]) {
      expect(calls).toContainEqual({
        argv: [...AS_FACTORY, tool, "--version"],
        timeoutMs: CHECK_TIMEOUT_MS,
        cwd: join(root, "home/factory"),
        env: {},
      });
    }
  });

  test.each([
    ["just", "missing", exited(127)],
    ["just", "failing", exited(1)],
    ["pnpm", "missing", exited(127)],
    ["pnpm", "failing", exited(1)],
  ])("names %s when it is %s", async (tool, _how, outcome) => {
    const { verification } = await verify({ [`${tool} --version`]: outcome });
    expect(verification.checks.find((check) => check.id === "toolchain")).toEqual({
      id: "toolchain",
      status: "failed",
      summary: `Missing, failing or the wrong version: ${tool}`,
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
      "claude plugin list --json": exited(1),
      "systemctl is-active tailscaled.service": exited(3, "inactive\n"),
    });
    expect(statusOf(verification)).toMatchObject({ plugins: "failed", tailscaled: "failed" });
    const plugins = calls.find(({ argv }) => argv.includes("plugin"));
    expect(plugins?.argv).toEqual([...AS_FACTORY, "claude", "plugin", "list", "--json"]);
    expect(plugins?.timeoutMs).toBeLessThanOrEqual(PLUGINS_TIMEOUT_MS);
    expect(plugins?.timeoutMs).toBeGreaterThan(0);
    expect(PLUGINS_TIMEOUT_MS).toBe(120_000);
  });
});

describe("host verify and the log archive's collector (plan and apply §The workers stage)", () => {
  test("never checks the collector: a worker with it installed and failing verifies the same", async () => {
    const without = await verify();
    await mkdir(join(root, "etc/fffactory"), { recursive: true });
    await writeFile(join(root, COLLECTOR_CONFIGURATION), "{}");
    for (const unit of COLLECTOR_UNITS) {
      await mkdir(join(root, unit.path, ".."), { recursive: true });
      await writeFile(join(root, unit.path), unit.text);
    }
    const failing = exited(3, "failed\n");
    const installed = await verify({
      "systemctl is-active fffactory-collector.service": failing,
      "systemctl is-active fffactory-collector.timer": failing,
    });
    expect(verificationJson(installed.verification)).toBe(verificationJson(without.verification));
    // Checks run concurrently: compare the commands run, not the order they started in.
    const commands = (calls: typeof without.calls) =>
      calls.map(({ argv }) => argv.join(" ")).sort();
    expect(commands(installed.calls)).toEqual(commands(without.calls));
    for (const { argv } of installed.calls) expect(argv.join(" ")).not.toContain("collector");
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
      "gh auth status --hostname github.com --active": { kind: "timed_out" },
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
        "--active",
      ],
      timeoutMs: CHECK_TIMEOUT_MS,
      cwd: join(root, "home/factory"),
      env: {},
    });
    const asFactory = calls.filter(({ argv }) => argv[0] === AS_FACTORY[0]);
    // Every tool, both agents, three credentials and the two plugin lists.
    expect(asFactory.length).toBe(TOOLCHAIN.length + 2 + 3 + 2);
  });

  test("runs factory's commands in factory's home, never the directory verify started in", async () => {
    // pnpm reads the project in its working directory: one factory cannot read fails it,
    // and one pinning another package manager makes it fetch that.
    const { calls } = await verify();
    const asFactory = calls.filter(({ argv }) => argv[0] === AS_FACTORY[0]);
    expect(asFactory.length).toBeGreaterThan(0);
    for (const call of asFactory) expect(call.cwd).toBe(join(root, "home/factory"));
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
      delivered: [],
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

  describe("Anthropic delivered through fffactory's key helper (credential delivery §Verify)", () => {
    const KEY_CHECK = "test -r anthropic-api-key -a -s anthropic-api-key";

    async function helperConfigured(
      text = claudeManagedSettingsJson({ keyHelper: true, keepHistory: false }),
    ) {
      await mkdir(join(root, "/etc/claude-code"), { recursive: true });
      await writeFile(join(root, CLAUDE_MANAGED_SETTINGS), text);
    }

    test("is enrolled only while factory can read a non-empty key file", async () => {
      await helperConfigured();
      const { verification, calls } = await verify();
      expect(verification.enrollment[2]).toEqual({ id: "anthropic", state: "enrolled" });
      const check = calls.find(({ argv }) => argv.includes("-s"));
      expect(check?.argv).toEqual([
        ...AS_FACTORY,
        "/usr/bin/test",
        "-r",
        join(root, ANTHROPIC_KEY_FILE),
        "-a",
        "-s",
        join(root, ANTHROPIC_KEY_FILE),
      ]);
      expect(check?.timeoutMs).toBe(CHECK_TIMEOUT_MS);
    });

    test("accepts every form the credentials step composes", async () => {
      for (const [keyHelper, keepHistory] of [
        [true, false],
        [true, true],
        [false, true],
      ] as const) {
        await helperConfigured(claudeManagedSettingsJson({ keyHelper, keepHistory }) ?? "");
        const { verification, calls } = await verify();
        expect(verification.enrollment[2]).toEqual({ id: "anthropic", state: "enrolled" });
        expect(verification.checks.every(({ status }) => status === "passed")).toBe(true);
        // The key file is checked exactly while the settings name fffactory's helper.
        expect(calls.some(({ argv }) => argv.includes("-s"))).toBe(keyHelper);
      }
    });

    test("a key file missing or empty is pending, though claude auth status passes", async () => {
      await helperConfigured();
      const { verification } = await verify({ [KEY_CHECK]: exited(1) });
      expect(verification.enrollment[2]).toEqual({ id: "anthropic", state: "pending" });
    });

    test("a key check that cannot run is unknown", async () => {
      await helperConfigured();
      const { verification } = await verify({ [KEY_CHECK]: { kind: "timed_out" } });
      expect(verification.enrollment[2]).toEqual({ id: "anthropic", state: "unknown" });
    });

    test("without fffactory's helper, claude auth status alone decides", async () => {
      for (const settings of [undefined, '{"apiKeyHelper": "cat /elsewhere"}', "not json"]) {
        await rm(join(root, "/etc/claude-code"), { recursive: true, force: true });
        if (settings !== undefined) await helperConfigured(settings);
        const { verification, calls } = await verify({ [KEY_CHECK]: exited(1) });
        expect(verification.enrollment[2]).toEqual({ id: "anthropic", state: "enrolled" });
        expect(calls.some(({ argv }) => argv.includes("-s"))).toBe(false);
      }
    });

    test("claude auth status failing is pending whatever the key file holds", async () => {
      await helperConfigured();
      const { verification } = await verify({ "claude auth status": exited(1) });
      expect(verification.enrollment[2]).toEqual({ id: "anthropic", state: "pending" });
    });
  });
});
