/**
 * The host protocol's contract: one set of fixtures, produced by the worker side and read by
 * the CLI side. A change that breaks either side against the fixtures breaks the protocol.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWorker } from "../../src/application/inspect-worker";
import {
  HOST_PROTOCOL_VERSION,
  hostInspectionJson,
  INSPECT_COMMAND,
  parseHostInspection,
} from "../../src/domain/host-protocol";
import { hostApplyJson, parseHostApply, readActivation } from "../../src/domain/installation";
import type { HostKey } from "../../src/domain/instance";
import { enrollmentReport, parseVerification, verificationJson } from "../../src/domain/readiness";
import { activationOutcome } from "../../src/domain/rollout";
import { inspectionVerdict } from "../../src/domain/status";
import { resolveWorker } from "../../src/domain/tailnet";
import { workerApplier } from "../../src/host/apply";
import { workerInspector } from "../../src/host/inspect";
import { flockExclusive } from "../../src/host/install-lock";
import { workerVerifier } from "../../src/host/verify";
import { fakeTransport, peer, TAG } from "../support/fake-workers";
import {
  applyingSystem,
  HOST_CONFIGURATION_SHA256,
  installedTools,
  SCENARIOS,
  unpackedWorker,
  WORKER_HOSTNAME,
} from "./worker-scenarios";

const FIXTURES = join(import.meta.dir, "fixtures");

function fixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text();
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-worker-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("host inspect, worker side", () => {
  for (const scenario of SCENARIOS)
    test(`produces ${scenario.fixture} for ${scenario.description}`, async () => {
      const document = await workerInspector(await scenario.build(root)).inspect();
      expect(`${hostInspectionJson(document)}\n`).toBe(await fixture(scenario.fixture));
    });
});

describe("host inspect, CLI side", () => {
  for (const scenario of SCENARIOS)
    test(`reads ${scenario.fixture} without losing anything`, async () => {
      const text = await fixture(scenario.fixture);
      const parsed = parseHostInspection(text);
      if (!parsed.ok) throw new Error(`rejected: ${JSON.stringify(parsed)}`);
      expect(`${hostInspectionJson(parsed.inspection)}\n`).toBe(text);
    });

  test("reads each fixture as the worker's answer over the transport", async () => {
    const resolution = resolveWorker([peer(WORKER_HOSTNAME)], WORKER_HOSTNAME, TAG);
    if (resolution.kind !== "found") throw new Error("not found");
    const expected = {
      hostname: WORKER_HOSTNAME,
      release: "0.3.0",
      configurationSha256: HOST_CONFIGURATION_SHA256,
    };
    const verdicts: Record<string, unknown> = {};
    for (const { fixture: name } of SCENARIOS) {
      const stdout = await fixture(name);
      const { transport, calls } = fakeTransport({
        [WORKER_HOSTNAME]: { kind: "completed", exitCode: 0, stdout },
      });
      const inspection = await inspectWorker(transport, resolution.worker);
      expect(calls.map((call) => call.command)).toEqual([[...INSPECT_COMMAND]]);
      const { verdict, release, configuration, installation } = inspectionVerdict(
        inspection,
        expected,
      );
      verdicts[name] = {
        release,
        configuration,
        installation,
        status: verdict.status,
        summary: verdict.summary,
      };
    }
    expect(verdicts).toEqual({
      "inspect-ready.json": {
        release: "0.3.0",
        configuration: HOST_CONFIGURATION_SHA256,
        installation: "succeeded",
        status: "not_ready",
        summary:
          "Software ready on release 0.3.0; enrollment pending: GitHub, OpenAI Codex, Claude Code",
      },
      "inspect-failed-install.json": {
        release: "0.3.0",
        configuration: HOST_CONFIGURATION_SHA256,
        installation: "failed",
        status: "not_ready",
        summary: "Its install of release 0.3.0 failed at step harness",
      },
      "inspect-no-release.json": {
        release: "none",
        configuration: "none",
        installation: "none",
        status: "not_ready",
        summary: "No release is active",
      },
      "inspect-damaged.json": {
        release: "broken",
        configuration: "unreadable",
        installation: "unreadable",
        status: "not_ready",
        summary: "Its bootstrap has not finished",
      },
    });
  });

  test("the worker speaks the version the CLI reads, and the CLI rejects any other major", async () => {
    const text = await fixture("inspect-ready.json");
    const document = JSON.parse(text);
    expect(document.protocol_version).toBe(HOST_PROTOCOL_VERSION);
    for (const version of [HOST_PROTOCOL_VERSION + 1, 0, 99])
      expect(
        parseHostInspection(JSON.stringify({ ...document, protocol_version: version })),
      ).toEqual({ ok: false, kind: "unsupported_version", version });
  });

  test("a worker from before installs were recorded reports none", async () => {
    const { installation: _, ...older } = JSON.parse(await fixture("inspect-no-release.json"));
    const parsed = parseHostInspection(JSON.stringify(older));
    expect(parsed.ok && parsed.inspection.installation).toEqual({ state: "none" });
  });

  test("an addition within the major version is ignored", async () => {
    const document = JSON.parse(await fixture("inspect-ready.json"));
    const extended = {
      ...document,
      repositories: [],
      evidence: { ...document.evidence, kernel: "6.1" },
      installation: { ...document.installation, duration_ms: 1200 },
      release: { ...document.release, activated_at: "2026-09-30T12:00:00Z" },
    };
    const parsed = parseHostInspection(JSON.stringify(extended));
    expect(parsed.ok && hostInspectionJson(parsed.inspection)).toBe(
      (await fixture("inspect-ready.json")).trimEnd(),
    );
  });
});

/** What `host apply` answers, and how the CLI reads each answer for builder-1 on 0.3.0. */
const APPLY_SCENARIOS = [
  {
    fixture: "apply-succeeded.json",
    description: "an install whose steps and checks all pass, GitHub alone enrolled",
    exitCode: 0,
    build: async (root: string) => {
      await unpackedWorker(root);
      return installedTools();
    },
    hold: false,
  },
  {
    fixture: "apply-failed.json",
    description: "an install whose harness step fails",
    exitCode: 1,
    build: async (root: string) => {
      await unpackedWorker(root);
      return installedTools(["harness"]);
    },
    hold: false,
  },
  {
    fixture: "apply-busy.json",
    description: "an install refused while another holds the install lock",
    exitCode: 1,
    build: async (root: string) => {
      await unpackedWorker(root);
      return installedTools();
    },
    hold: true,
  },
] as const;

const WORKER = { key: "builder-1" as HostKey, hostname: WORKER_HOSTNAME };
const THEN = ", then rerun `fffactory apply`.";

describe("host apply and host verify, worker side", () => {
  for (const scenario of APPLY_SCENARIOS)
    test(`host apply produces ${scenario.fixture} for ${scenario.description}`, async () => {
      const run = await scenario.build(root);
      const system = applyingSystem(root, run);
      const held = scenario.hold
        ? await flockExclusive(join(root, "/run/fffactory-host-apply.lock"))
        : undefined;
      try {
        const result = await workerApplier(system, workerVerifier(system)).apply();
        expect(`${hostApplyJson(result)}\n`).toBe(await fixture(scenario.fixture));
      } finally {
        held?.release();
      }
    });

  test("host verify produces verify-pending.json for a worker with GitHub alone enrolled", async () => {
    await unpackedWorker(root);
    const verification = await workerVerifier(applyingSystem(root, installedTools())).verify();
    expect(`${verificationJson(verification)}\n`).toBe(await fixture("verify-pending.json"));
  });
});

describe("host apply and host verify, CLI side", () => {
  test("reads each apply fixture back without losing anything", async () => {
    for (const { fixture: name } of APPLY_SCENARIOS) {
      const text = await fixture(name);
      const parsed = parseHostApply(text);
      if (!parsed.ok) throw new Error(`rejected ${name}: ${JSON.stringify(parsed)}`);
      expect(`${hostApplyJson(parsed.document)}\n`).toBe(text);
    }
  });

  test("reads each activator answer into the worker's outcome", async () => {
    const outcomes: Record<string, unknown> = {};
    for (const { fixture: name, exitCode } of APPLY_SCENARIOS) {
      const outcome = activationOutcome(
        WORKER,
        "0.3.0",
        readActivation(exitCode, await fixture(name)),
      );
      outcomes[name] =
        outcome.kind === "installed"
          ? {
              kind: outcome.kind,
              release: outcome.release,
              enrollment: enrollmentReport(outcome.verification, WORKER.hostname).map(
                ({ id, state }) => `${id}:${state}`,
              ),
            }
          : outcome;
    }
    expect(outcomes).toEqual({
      "apply-succeeded.json": {
        kind: "installed",
        release: "0.3.0",
        enrollment: ["github:enrolled", "openai:pending", "anthropic:pending"],
      },
      "apply-failed.json": {
        ...WORKER,
        kind: "failed",
        summary: "Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
        nextAction:
          `Read its output with \`tailscale ssh fffactory-admin@${WORKER_HOSTNAME} cat /var/log/fffactory/harness.log\` ` +
          `and fix the cause; the steps are idempotent, so rerunning repairs the worker${THEN}`,
      },
      "apply-busy.json": {
        ...WORKER,
        kind: "skipped",
        summary: `An install is still running on ${WORKER_HOSTNAME}`,
        nextAction: `Wait for it to finish (\`fffactory status\` shows when it has)${THEN}`,
      },
    });
  });

  test("reads the verify fixture back without losing anything", async () => {
    const text = await fixture("verify-pending.json");
    const parsed = parseVerification(text);
    if (!parsed.ok) throw new Error(`rejected: ${JSON.stringify(parsed)}`);
    expect(`${verificationJson(parsed.document)}\n`).toBe(text);
    expect(
      enrollmentReport(parsed.document, WORKER_HOSTNAME).map(({ id, state }) => `${id}:${state}`),
    ).toEqual(["github:enrolled", "openai:pending", "anthropic:pending"]);
  });
});
