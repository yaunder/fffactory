import { describe, expect, test } from "bun:test";
import { ready } from "../../src/domain/check-result";
import type { HostInspection } from "../../src/domain/host-protocol";
import type { HostKey } from "../../src/domain/instance";
import {
  ec2InventoryCheck,
  inspectedFacts,
  inspectionVerdict,
  locateWorker,
  MIN_AVAILABLE_BYTES,
  machineFacts,
  machineVerdict,
  readinessVerdict,
  statusReport,
  tailnetCheck,
  type WorkerInspection,
  type WorkerStatus,
} from "../../src/domain/status";
import {
  CONFIGURATION_SHA256,
  inspection,
  installed,
  machine,
  peer,
  peers,
  TAG,
  verification,
} from "../support/fake-workers";

const HOSTNAME = "fff-aaaa1111-builder-1";
const KEY = "builder-1" as HostKey;
const EXPECTED = {
  hostname: HOSTNAME,
  release: "0.3.0",
  configurationSha256: CONFIGURATION_SHA256,
};
const RERUN = ", then rerun `fffactory status`.";

describe("readiness from a worker's inspection", () => {
  test("a worker on the pinned release with its configuration and services is ready", () => {
    expect(readinessVerdict(inspection(HOSTNAME), EXPECTED)).toEqual({
      status: "ready",
      summary: "Ready on release 0.3.0",
      details: [],
      nextAction: null,
    });
  });

  test("each finding is not ready; the first names the next action, the rest are details", () => {
    const verdict = readinessVerdict(
      inspection(HOSTNAME, {
        hostname: "someone-else",
        release: { state: "none" },
        configuration: { state: "none" },
        services: [{ name: "tailscaled", state: "failed" }],
        evidence: {
          bootstrap_complete: false,
          os: { id: "ubuntu", version_id: "24.04" },
          architecture: "aarch64",
          available_bytes: MIN_AVAILABLE_BYTES - 1,
        },
      }),
      EXPECTED,
    );
    expect(verdict.status).toBe("not_ready");
    expect(verdict.summary).toBe("The worker reports another hostname than its Tailscale name");
    expect(verdict.nextAction).toBe(
      `Check at https://login.tailscale.com/admin/machines that the device ${HOSTNAME} is this factory's worker${RERUN}`,
    );
    expect(verdict.details).toEqual([
      "Its bootstrap has not finished",
      "It is not Amazon Linux 2023 on x86-64, the only base workers run",
      "Less than 2 GiB is free under /opt/fffactory/releases",
      "No release is active",
      "It has no host configuration",
      "Service tailscaled is failed",
    ]);
  });

  test("hostnames compare without case", () => {
    expect(readinessVerdict(inspection(HOSTNAME.toUpperCase()), EXPECTED).status).toBe("ready");
  });

  test("an unknown base or free space is judged only on what is known", () => {
    const unknownOs = inspection(HOSTNAME, {
      evidence: { ...inspection(HOSTNAME).evidence, os: null, available_bytes: null },
    });
    expect(readinessVerdict(unknownOs, EXPECTED).summary).toBe(
      "It is not Amazon Linux 2023 on x86-64, the only base workers run",
    );
  });

  test("another release, a damaged one or an unreadable configuration need apply", () => {
    const drifted = readinessVerdict(inspection(HOSTNAME, {}, "0.2.0"), EXPECTED);
    expect(drifted.summary).toBe("It runs release 0.2.0; factory.json pins 0.3.0");
    expect(drifted.nextAction).toBe(`Install release 0.3.0 with \`fffactory apply\`${RERUN}`);
    expect(
      readinessVerdict(inspection(HOSTNAME, { release: { state: "broken" } }), EXPECTED).summary,
    ).toBe("Its active release is damaged");
    const unreadable = readinessVerdict(
      inspection(HOSTNAME, { configuration: { state: "unreadable" } }),
      EXPECTED,
    );
    expect(unreadable.summary).toBe("fffactory-admin cannot read its host configuration");
    expect(unreadable.nextAction).toBe(`Repair the worker with \`fffactory apply\`${RERUN}`);
  });

  test("a host configuration other than factory.json's projection needs apply", () => {
    const drifted = readinessVerdict(
      inspection(HOSTNAME, { configuration: { state: "present", sha256: "e".repeat(64) } }),
      EXPECTED,
    );
    expect(drifted).toMatchObject({
      status: "not_ready",
      summary: "Its host configuration is not the one factory.json projects for it",
      nextAction: `Repair the worker with \`fffactory apply\`${RERUN}`,
    });
  });

  test("an install that failed, did not finish or failed verification leaves it unhealthy", () => {
    const summaryOf = (installation: HostInspection["installation"]) =>
      readinessVerdict(inspection(HOSTNAME, { installation }), EXPECTED);
    const base = installed("0.3.0", null);
    expect(summaryOf({ ...base, state: "failed", failed_step: "harness" })).toMatchObject({
      summary: "Its install of release 0.3.0 failed at step harness",
      nextAction: `Repair the worker with \`fffactory apply\`${RERUN}`,
    });
    // It may still be running: only once apply's wait is over is a rerun the repair.
    expect(summaryOf({ ...base, state: "running", finished_at: null })).toMatchObject({
      summary:
        "An install of release 0.3.0 started at 2026-09-30T10:55:00.000Z has not finished; it may still be running",
      nextAction:
        "If it started more than 72 min ago (apply's activation timeout), repair the worker " +
        `with \`fffactory apply\`; otherwise wait for it to finish${RERUN}`,
    });
    expect(
      summaryOf({
        ...base,
        state: "failed",
        failure: "host apply failed while making release 0.3.0 active (EISDIR)",
      }).summary,
    ).toBe(
      "Its install of release 0.3.0 failed: host apply failed while making release 0.3.0 active (EISDIR)",
    );
    const unhealthy = verification(HOSTNAME, "enrolled", {
      checks: [{ id: "agents", status: "failed", summary: "Codex does not match its pin" }],
    });
    expect(summaryOf({ ...base, state: "failed", verification: unhealthy }).summary).toBe(
      "Release 0.3.0 failed verification: Codex does not match its pin",
    );
    expect(summaryOf({ state: "unreadable" }).summary).toBe("Its install record cannot be read");
    expect(summaryOf({ state: "none" }).summary).toBe(
      "No install of release 0.3.0 by `fffactory apply` is recorded",
    );
    expect(summaryOf(installed("0.2.0", verification(HOSTNAME))).summary).toBe(
      "Its active release 0.3.0 is not the one its last install recorded, 0.2.0",
    );
  });

  test("software ready with enrollment pending names the exact steps for each account", () => {
    const pending = inspection(HOSTNAME, {
      installation: installed("0.3.0", verification(HOSTNAME, "pending")),
    });
    const verdict = readinessVerdict(pending, EXPECTED);
    const policy = "(tailnet SSH policy must let you log in as `factory`)";
    expect(verdict).toEqual({
      status: "not_ready",
      summary:
        "Software ready on release 0.3.0; enrollment pending: GitHub, OpenAI Codex, Claude Code",
      nextAction:
        `Enroll each pending account on ${HOSTNAME} as listed (tailnet SSH policy must let you ` +
        "log in there as `factory`), then verify the enrollment with `fffactory apply` and " +
        "rerun `fffactory status`.",
      details: [
        `GitHub: Authenticate GitHub as factory on ${HOSTNAME} ${policy}: run \`tailscale ssh factory@${HOSTNAME}\`, then \`gh auth login --hostname github.com --git-protocol https --web\`, then \`gh auth status\``,
        `OpenAI Codex: Log in to OpenAI Codex as factory on ${HOSTNAME} ${policy}: run \`tailscale ssh factory@${HOSTNAME}\`, then \`codex login --device-auth\`, then \`codex login status\``,
        `Claude Code: Log in to Claude Code as factory on ${HOSTNAME} ${policy}: run \`tailscale ssh factory@${HOSTNAME}\`, then \`claude auth login\`, then \`claude auth status\``,
        "Paseo clients: enrollment is checked from each client, not the worker",
        "Enrollment as `fffactory apply` last verified it, at 2026-09-30T11:00:00.000Z",
      ],
    });
  });

  test("Paseo clients never keep a worker whose accounts are all enrolled from being ready", () => {
    const enrolled = inspection(HOSTNAME, {
      installation: installed("0.3.0", verification(HOSTNAME, "enrolled")),
    });
    expect(readinessVerdict(enrolled, EXPECTED).status).toBe("ready");
  });

  test("names the steps for the hostname status resolved, never one the worker reported", () => {
    const pending = inspection(HOSTNAME, {
      installation: installed("0.3.0", verification("impostor", "pending")),
    });
    const verdict = readinessVerdict(pending, EXPECTED);
    expect(verdict.details.join("\n")).not.toContain("impostor");
    expect(inspectedFacts(pending, HOSTNAME).enrollment?.[0]?.next_action?.login).toBe(
      `tailscale ssh factory@${HOSTNAME}`,
    );
  });

  test("reports the install and enrollment facts it read", () => {
    const pending = inspection(HOSTNAME, {
      installation: installed("0.3.0", verification(HOSTNAME, "pending")),
    });
    const facts = inspectedFacts(pending, HOSTNAME);
    expect(facts.installation).toBe("succeeded");
    expect(facts.enrollment?.map(({ id, state }) => `${id}:${state}`)).toEqual([
      "github:pending",
      "openai:pending",
      "anthropic:pending",
    ]);
    expect(
      inspectedFacts(inspection(HOSTNAME, { installation: { state: "none" } }), HOSTNAME),
    ).toMatchObject({ installation: "none", enrollment: null });
  });
});

describe("a worker that could not be inspected", () => {
  function verdictOf(outcome: WorkerInspection) {
    const { verdict, ...facts } = inspectionVerdict(outcome, EXPECTED);
    return { ...facts, status: verdict.status, summary: verdict.summary, next: verdict.nextAction };
  }

  test("has an unknown release, except one with none installed", () => {
    expect(verdictOf({ kind: "no_release" })).toEqual({
      release: "none",
      configuration: "unknown",
      installation: "unknown",
      enrollment: null,
      status: "not_ready",
      summary: "No release is installed",
      next: `Install release 0.3.0 with \`fffactory apply\`${RERUN}`,
    });
    expect(verdictOf({ kind: "unreachable", reason: "the connection timed out" })).toEqual({
      release: "unknown",
      configuration: "unknown",
      installation: "unknown",
      enrollment: null,
      status: "not_ready",
      summary: "SSH could not reach it: the connection timed out",
      next: `Check that the worker is up and reachable with \`tailscale ping ${HOSTNAME}\`${RERUN}`,
    });
  });

  test("names the tailnet policy step when the login is refused", () => {
    const denied = verdictOf({ kind: "access_denied" });
    expect(denied.status).toBe("not_ready");
    expect(denied.summary).toBe("Tailnet SSH policy does not let you log in as fffactory-admin");
    expect(denied.next).toContain('SSH rule with action "accept"');
    // Enrolling accounts logs in as factory, which tailnet policy must allow too.
    expect(denied.next).toContain("enrolling a worker's accounts also needs one for factory");
  });

  test("never bypasses a host key mismatch", () => {
    const mismatch = verdictOf({ kind: "host_key_mismatch" });
    expect(mismatch.status).toBe("not_ready");
    expect(mismatch.next).toStartWith("Do not bypass this");
  });

  test("a missing ssh is not ready; a protocol it cannot read or a failure is an error", () => {
    expect(verdictOf({ kind: "client_missing" }).status).toBe("not_ready");
    expect(verdictOf({ kind: "unsupported_protocol", version: 2 })).toMatchObject({
      status: "error",
      summary: "It speaks host protocol version 2; this fffactory speaks version 1",
      next: `Use fffactory 0.3.0, the release factory.json pins${RERUN}`,
    });
    expect(
      verdictOf({ kind: "failed", reason: "host inspect exited with status 1" }),
    ).toMatchObject({
      status: "error",
      summary: "Inspecting it failed: host inspect exited with status 1",
      next: `If it fails again, run \`tailscale ssh fffactory-admin@${HOSTNAME} /opt/fffactory/current/bin/fffactory host inspect --json\` to see why${RERUN}`,
    });
  });
});

describe("the EC2 inventory", () => {
  test("finds the host's one instance by its host key tag", () => {
    const inventory = {
      kind: "machines" as const,
      machines: [machine("other", "running", "i-1111111111111111a"), machine(KEY, "stopped")],
    };
    expect(machineFacts(inventory, KEY)).toEqual({
      machine: "stopped",
      instanceId: "i-0123456789abcdef0",
      instanceIds: ["i-0123456789abcdef0"],
    });
  });

  test("absent, duplicate, stopped and stopping machines are not inspected", () => {
    const verdict = (machines: ReturnType<typeof machine>[]) =>
      machineVerdict(machineFacts({ kind: "machines", machines }, KEY));
    expect(verdict([])?.nextAction).toBe(`Provision it with \`fffactory apply\`${RERUN}`);
    const duplicate = verdict([machine(KEY), machine(KEY, "running", "i-0fedcba9876543210")]);
    expect(duplicate?.summary).toBe("2 EC2 instances carry this host key");
    expect(duplicate?.details).toEqual([
      "Instance: i-0123456789abcdef0",
      "Instance: i-0fedcba9876543210",
    ]);
    expect(verdict([machine(KEY, "stopped")])?.nextAction).toBe(
      `Start instance i-0123456789abcdef0 in the EC2 console${RERUN}`,
    );
    for (const state of ["stopping", "shutting-down"] as const)
      expect(verdict([machine(KEY, state)])?.summary).toBe(
        `EC2 instance i-0123456789abcdef0 is ${state}`,
      );
    expect(verdict([machine(KEY, "running")])).toBeUndefined();
    expect(verdict([machine(KEY, "pending")])).toBeUndefined();
  });

  test("an unavailable inventory leaves the machine unknown and still inspects it", () => {
    const facts = machineFacts({ kind: "unavailable", reason: "x" }, KEY);
    expect(facts.machine).toBe("unknown");
    expect(machineVerdict(facts)).toBeUndefined();
  });

  test("is a check: ready with a count, or an error naming the failure", () => {
    expect(ec2InventoryCheck({ kind: "machines", machines: [machine(KEY)] }).summary).toBe(
      "1 instance carries the factory ID",
    );
    expect(ec2InventoryCheck({ kind: "machines", machines: [] }).summary).toBe(
      "0 instances carry the factory ID",
    );
    const failed = ec2InventoryCheck({
      kind: "unavailable",
      reason: "EC2 DescribeInstances failed: network error (ECONNREFUSED)",
    });
    expect(failed.status).toBe("error");
    expect(failed.summary).toBe("EC2 DescribeInstances failed: network error (ECONNREFUSED)");
  });
});

describe("the tailnet", () => {
  test("is a check like doctor's", () => {
    expect(tailnetCheck(peers(peer("a"), peer("b"))).summary).toBe(
      "Logged in and running; 2 devices visible",
    );
    expect(tailnetCheck(peers(peer("a"))).summary).toBe("Logged in and running; 1 device visible");
    expect(tailnetCheck({ kind: "not_running", backendState: "NeedsLogin" }).status).toBe(
      "not_ready",
    );
    expect(tailnetCheck({ kind: "not_found" }).status).toBe("not_ready");
    expect(tailnetCheck({ kind: "unusable", reason: "x" }).status).toBe("error");
  });

  test("refuses a missing or duplicate hostname with the next action, never guessing", () => {
    const missing = locateWorker(peers(peer(`${HOSTNAME}-1`)), HOSTNAME, TAG);
    expect(missing).toMatchObject({ kind: "blocked", tailnet: "missing" });
    expect(missing.kind === "blocked" && missing.verdict.summary).toBe(
      `No Tailscale device named ${HOSTNAME} is visible from this machine`,
    );
    expect(missing.kind === "blocked" && missing.verdict.nextAction).toBe(
      "If the worker has just started, wait for it to join the tailnet. Otherwise check that " +
        "tailnet policy lets this device see the factory's tag, and the bootstrap in the " +
        "instance's EC2 console output: if it failed, terminate the instance in the EC2 console; " +
        `once it is terminated, the next \`fffactory apply\` creates it again${RERUN}`,
    );
    const duplicate = locateWorker(peers(peer(HOSTNAME), peer(HOSTNAME)), HOSTNAME, TAG);
    expect(duplicate).toMatchObject({ kind: "blocked", tailnet: "duplicate" });
    expect(duplicate.kind === "blocked" && duplicate.verdict.nextAction).toBe(
      `Remove the stale devices named ${HOSTNAME} at https://login.tailscale.com/admin/machines, keeping the worker's${RERUN}`,
    );
  });

  test("refuses the one device with the name when it lacks the factory's tag, never echoing the tag", () => {
    const untagged = locateWorker(peers(peer(HOSTNAME, { tags: ["tag:intruder"] })), HOSTNAME, TAG);
    expect(untagged).toMatchObject({
      kind: "blocked",
      tailnet: "untagged",
      verdict: {
        status: "not_ready",
        summary: `The Tailscale device named ${HOSTNAME} does not carry the factory's tag (tailscale.tag in factory.json)`,
        nextAction: `Check the tailnet at https://login.tailscale.com/admin/machines: the device named ${HOSTNAME} must be this factory's worker and carry the factory's tag; remove it if it is not the worker${RERUN}`,
      },
    });
    expect(JSON.stringify(untagged)).not.toContain(TAG);
  });

  test("an offline worker or one without Tailscale SSH is not ready", () => {
    expect(locateWorker(peers(peer(HOSTNAME, { online: false })), HOSTNAME, TAG)).toMatchObject({
      tailnet: "offline",
      verdict: { status: "not_ready", summary: "Offline in the tailnet" },
    });
    expect(locateWorker(peers(peer(HOSTNAME, { sshHostKeys: [] })), HOSTNAME, TAG)).toMatchObject({
      tailnet: "no_ssh",
      verdict: { status: "not_ready" },
    });
  });

  test("an unavailable view leaves every worker unknown", () => {
    expect(locateWorker({ kind: "daemon_unreachable" }, HOSTNAME, TAG)).toMatchObject({
      tailnet: "unknown",
      verdict: { status: "not_ready", details: ["See the Tailscale client check."] },
    });
    expect(locateWorker({ kind: "unusable", reason: "x" }, HOSTNAME, TAG)).toMatchObject({
      tailnet: "unknown",
      verdict: { status: "error" },
    });
  });

  test("the one match is found", () => {
    expect(locateWorker(peers(peer(HOSTNAME)), HOSTNAME, TAG).kind).toBe("found");
  });
});

describe("the report", () => {
  test("takes the worst status of its inventories and workers", () => {
    const check = ready({ id: "x", title: "X" }, "fine");
    const worker = (status: WorkerStatus["status"]) => ({ status }) as WorkerStatus;
    expect(statusReport([check], []).status).toBe("ready");
    expect(statusReport([check], [worker("ready"), worker("not_ready")]).status).toBe("not_ready");
    expect(statusReport([check], [worker("error"), worker("not_ready")]).status).toBe("error");
  });
});
