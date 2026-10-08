import { describe, expect, test } from "bun:test";
import {
  applyWorkers,
  UPLOAD_TIMEOUT_MS,
  type WorkerProgress,
  type WorkersStageDependencies,
  type WorkersStageRequest,
} from "../../src/application/apply-workers";
import type { WorkerRelease } from "../../src/application/asset-bundle";
import type { HostCommandOutcome } from "../../src/application/host-transport";
import { hostProjection, hostProjectionJson, projectHost } from "../../src/domain/host-projection";
import { ACTIVATION_TIMEOUT_MS, pendingSteps, withStep } from "../../src/domain/installation";
import type { FactoryId, HostKey, Release, SecretReference } from "../../src/domain/instance";
import {
  FIRST_BOOT_POLL_MS,
  firstBootTimedOut,
  type WorkerOutcome,
} from "../../src/domain/rollout";
import type { PeerView } from "../../src/domain/tailnet";
import { FAKE_WORKER_RELEASE } from "../support/doctor-fakes";
import {
  type Answer,
  appliedRecord,
  fakeTailnet,
  fakeTime,
  fakeTransport,
  installableWorker,
  peer,
  peers,
  TAG,
  verification,
} from "../support/fake-workers";

const FACTORY = "fff-abcd1234" as FactoryId;
const B1 = "fff-abcd1234-builder-1";
const B2 = "fff-abcd1234-builder-2";
const B3 = "fff-abcd1234-builder-3";
const RELEASE = "0.3.0" as Release;
const THEN = ", then rerun `fffactory apply`.";

const T0 = new Date("2026-09-30T12:00:00.000Z");

function request(...keys: string[]): WorkersStageRequest {
  return {
    tag: TAG,
    release: RELEASE,
    projections: keys.map((key) => projectHost(FACTORY, RELEASE, { key: key as HostKey })),
    created: [],
  };
}

/** The request, with `created` the workers whose machine this apply's infrastructure created. */
function creating(base: WorkersStageRequest, ...created: string[]): WorkersStageRequest {
  return { ...base, created: created.map((key) => key as HostKey) };
}

function projection(key: string): string {
  return hostProjectionJson(hostProjection(FACTORY, key as HostKey, RELEASE));
}

function stage(
  options: {
    view?: PeerView | ((read: number) => PeerView);
    script?: Record<string, Answer>;
    worker?: WorkerRelease | undefined;
    interruptAfter?: number;
    /** Interrupts once apply has slept this many times. */
    interruptAfterSleeps?: number;
  } = {},
) {
  const tailnet = fakeTailnet(options.view ?? peers(peer(B1), peer(B2), peer(B3)));
  const transport = fakeTransport(options.script ?? {});
  const progress: WorkerProgress[] = [];
  const recorded: (readonly WorkerOutcome[])[] = [];
  const worker = "worker" in options ? options.worker : FAKE_WORKER_RELEASE;
  const signal = { interrupted: false };
  const time = fakeTime(T0, (slept) => {
    if (slept === options.interruptAfterSleeps) signal.interrupted = true;
  });
  const deps: WorkersStageDependencies = {
    peers: tailnet.tailnet,
    transport: transport.transport,
    assets: { workerRelease: async () => worker },
    interrupted: () =>
      signal.interrupted ||
      (options.interruptAfter !== undefined && transport.calls.length >= options.interruptAfter),
    progress: (event) => progress.push(event),
    clock: time.clock,
    sleep: time.sleep,
  };
  const record = async (outcomes: readonly WorkerOutcome[]) => {
    recorded.push(outcomes);
  };
  return { deps, record, tailnet, transport, progress, recorded, time };
}

const installs = (hostname: string) => installableWorker(appliedRecord(hostname));

describe("the workers stage (plan-apply §The workers stage)", () => {
  test("uploads the release tarball, then activates it with its digest and the host's projection", async () => {
    const { deps, record, transport, progress } = stage({ script: { [B1]: installs(B1) } });
    const result = await applyWorkers(deps, request("builder-1"), record);
    expect(result).toEqual({
      kind: "done",
      outcomes: [
        {
          key: "builder-1" as HostKey,
          hostname: B1,
          kind: "installed",
          release: RELEASE,
          verification: verification(B1, "pending"),
        },
      ],
    });
    expect(transport.calls.map(({ command, timeoutMs }) => [command, timeoutMs])).toEqual([
      [
        ["dd", "of=/home/fffactory-admin/fffactory-release.tar.gz", "bs=1M", "status=none"],
        UPLOAD_TIMEOUT_MS,
      ],
      [
        [
          "sudo",
          "-n",
          "/usr/local/libexec/fffactory-activate",
          "/home/fffactory-admin/fffactory-release.tar.gz",
          FAKE_WORKER_RELEASE.sha256,
        ],
        ACTIVATION_TIMEOUT_MS,
      ],
    ]);
    expect(transport.calls[0]?.stdin).toEqual(FAKE_WORKER_RELEASE.tarball);
    expect(new TextDecoder().decode(transport.calls[1]?.stdin)).toBe(projection("builder-1"));
    expect(transport.calls[0]?.worker).toMatchObject({ hostname: B1, address: "100.64.0.10" });
    expect(progress).toEqual([
      {
        kind: "uploading",
        key: "builder-1" as HostKey,
        hostname: B1,
        bytes: FAKE_WORKER_RELEASE.tarball.length,
      },
      { kind: "installing", key: "builder-1" as HostKey, hostname: B1 },
    ]);
  });

  test("streams each worker the projection it was given, Paseo secret reference included", async () => {
    const arn =
      "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/paseo-AbCdEf" as SecretReference;
    const projected = projectHost(FACTORY, RELEASE, {
      key: "builder-1" as HostKey,
      paseo_password_secret: arn,
    });
    const { deps, record, transport } = stage({ script: { [B1]: installs(B1) } });
    await applyWorkers(deps, { ...request(), projections: [projected] }, record);
    const sent = new TextDecoder().decode(transport.calls[1]?.stdin);
    expect(sent).toBe(hostProjectionJson(projected));
    expect(sent).toContain(arn);
  });

  test("updates workers one at a time, recording each outcome as it ends", async () => {
    const { deps, record, recorded } = stage({
      script: { [B1]: installs(B1), [B2]: installs(B2) },
    });
    const result = await applyWorkers(deps, request("builder-1", "builder-2"), record);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(["installed", "installed"]);
    expect(recorded.map((outcomes) => outcomes.map((outcome) => outcome.kind))).toEqual([
      ["installed"],
      ["installed", "installed"],
    ]);
  });

  test("a worker it cannot find or reach is skipped; the others are still installed", async () => {
    const { deps, record, transport } = stage({
      view: peers(peer(B1, { online: false }), peer(B2), peer(B3)),
      script: {
        [B2]: installableWorker(appliedRecord(B2), {
          upload: { kind: "unreachable", reason: "the connection timed out" },
        }),
        [B3]: installs(B3),
      },
    });
    const result = await applyWorkers(deps, request("builder-1", "builder-2", "builder-3"), record);
    expect(result.outcomes).toEqual([
      {
        key: "builder-1" as HostKey,
        hostname: B1,
        kind: "skipped",
        summary: "Offline in the tailnet",
        nextAction: `Check that the instance is running and that Tailscale is up on it${THEN}`,
      },
      {
        key: "builder-2" as HostKey,
        hostname: B2,
        kind: "skipped",
        summary: "SSH could not reach it: the connection timed out",
        nextAction: `Check that the worker is up and reachable with \`tailscale ping ${B2}\`${THEN}`,
      },
      expect.objectContaining({ key: "builder-3", kind: "installed" }),
    ]);
    expect(transport.calls.some(({ worker }) => worker.hostname === B1)).toBe(false);
  });

  test("an install failure stops the rollout before later workers are touched", async () => {
    const failing = appliedRecord(B1, "0.3.0", {
      state: "failed",
      steps: withStep(pendingSteps(), "packages", "failed", "exited with status 1"),
      verification: null,
    });
    const { deps, record, transport } = stage({
      script: { [B1]: installableWorker(failing), [B2]: installs(B2) },
    });
    const result = await applyWorkers(deps, request("builder-1", "builder-2"), record);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(["failed", "not_attempted"]);
    expect(result.outcomes[0]).toMatchObject({
      summary: "Step packages failed: exited with status 1; release 0.3.0 is active but unhealthy",
    });
    expect(transport.calls.some(({ worker }) => worker.hostname === B2)).toBe(false);
  });

  test("a failed upload, a lost connection or no answer during the install are failures", async () => {
    const cases: [Answer, string][] = [
      [
        installableWorker(appliedRecord(B1), {
          upload: { kind: "completed", exitCode: 1, stdout: "" },
        }),
        "Uploading the release failed: dd exited with status 1",
      ],
      [
        installableWorker(appliedRecord(B1), {
          activation: { kind: "unreachable", reason: "the connection dropped" },
        }),
        "The connection dropped during the install (the connection dropped); the worker may still be installing",
      ],
      [
        installableWorker(appliedRecord(B1), { activation: { kind: "timed_out" } }),
        `host apply did not answer within ${ACTIVATION_TIMEOUT_MS / 60_000} min; the worker may still be installing`,
      ],
      [
        installableWorker(appliedRecord(B1), {
          activation: { kind: "completed", exitCode: 75, stdout: "" },
        }),
        "Installing failed: another activation is running on the worker",
      ],
      [
        installableWorker(appliedRecord(B1), { upload: { kind: "not_started", code: "EMFILE" } }),
        "ssh could not be started (EMFILE)",
      ],
      [
        installableWorker(appliedRecord(B1), { activation: { kind: "host_key_mismatch" } }),
        "Its SSH host key is not one the tailnet lists for it, so fffactory did not log in",
      ],
    ];
    for (const [answer, summary] of cases) {
      const { deps, record } = stage({ script: { [B1]: answer } });
      const [outcome] = (await applyWorkers(deps, request("builder-1"), record)).outcomes;
      expect(outcome).toMatchObject({ kind: "failed", summary });
    }
  });

  test("a worker still finishing its bootstrap is skipped", async () => {
    const waiting = installableWorker({
      protocol_version: 1,
      hostname: B1,
      state: "refused",
      reason: "bootstrap_incomplete",
      message: "Bootstrap has not finished on this worker",
    });
    const { deps, record } = stage({ script: { [B1]: waiting, [B2]: installs(B2) } });
    const result = await applyWorkers(deps, request("builder-1", "builder-2"), record);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(["skipped", "installed"]);
  });

  test("without a worker executable, as run from source, every worker is skipped untouched", async () => {
    const { deps, record, tailnet, transport } = stage({ worker: undefined });
    const result = await applyWorkers(deps, request("builder-1", "builder-2"), record);
    expect(result.outcomes).toEqual(
      ["builder-1", "builder-2"].map((key) => ({
        key: key as HostKey,
        hostname: `fff-abcd1234-${key}`,
        kind: "skipped",
        summary:
          "This fffactory carries no worker executable: it runs from source, not from a built release",
        nextAction: `Install the workers with a built fffactory (\`just build\`)${THEN}`,
      })),
    );
    expect(tailnet.reads()).toBe(0);
    expect(transport.calls).toEqual([]);
  });

  test("a lost connection or no answer says the worker may still be installing, and to wait", async () => {
    for (const activation of [
      { kind: "timed_out" as const },
      { kind: "unreachable" as const, reason: "the connection dropped" },
    ]) {
      const { deps, record } = stage({
        script: { [B1]: installableWorker(appliedRecord(B1), { activation }) },
      });
      const [outcome] = (await applyWorkers(deps, request("builder-1"), record)).outcomes;
      expect(outcome).toMatchObject({
        kind: "failed",
        nextAction:
          "Wait for the install that may still be running on it to finish (`fffactory status` " +
          `shows its record), then rerun \`fffactory apply\`.`,
      });
    }
  });

  test("a worker another install is still running on is skipped, and the rollout goes on", async () => {
    const busy = installableWorker({
      protocol_version: 1,
      hostname: B1,
      state: "refused",
      reason: "busy",
      message: "Another host apply is installing on this worker; wait for it to finish",
    });
    const { deps, record } = stage({ script: { [B1]: busy, [B2]: installs(B2) } });
    const result = await applyWorkers(deps, request("builder-1", "builder-2"), record);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(["skipped", "installed"]);
    expect(result.outcomes[0]).toMatchObject({
      summary: `An install is still running on ${B1}`,
    });
  });

  test("an answer for another worker is a failure", async () => {
    const { deps, record } = stage({ script: { [B1]: installs(B2) } });
    const [outcome] = (await applyWorkers(deps, request("builder-1"), record)).outcomes;
    expect(outcome).toMatchObject({
      kind: "failed",
      summary: `host apply answered as ${B2}, not ${B1}; nothing it reported is trusted`,
    });
  });

  test("an interrupt while host apply runs names the worker it may still be installing", async () => {
    const { deps, record } = stage({
      script: { [B1]: installs(B1), [B2]: installs(B2) },
      interruptAfter: 2,
    });
    const result = await applyWorkers(deps, request("builder-1", "builder-2"), record);
    expect(result).toEqual({
      kind: "interrupted",
      outcomes: [],
      installing: { key: "builder-1" as HostKey, hostname: B1 },
    });
  });

  test("an interrupt starts nothing more", async () => {
    const { deps, record, transport } = stage({
      script: { [B1]: installs(B1), [B2]: installs(B2) },
      interruptAfter: 1,
    });
    const result = await applyWorkers(deps, request("builder-1", "builder-2"), record);
    expect(result).toEqual({ kind: "interrupted", outcomes: [], installing: undefined });
    expect(transport.calls).toHaveLength(1);
  });
});

describe("the SSH outcomes of an upload", () => {
  test("an upload that does not finish in time is a skip", async () => {
    const { deps, record } = stage({
      script: { [B1]: installableWorker(appliedRecord(B1), { upload: { kind: "timed_out" } }) },
    });
    const [outcome] = (await applyWorkers(deps, request("builder-1"), record)).outcomes;
    expect(outcome).toEqual({
      key: "builder-1" as HostKey,
      hostname: B1,
      kind: "skipped",
      summary: "The upload did not finish within 15 min",
      nextAction: `Check the connection to the worker with \`tailscale ping ${B1}\`${THEN}`,
    });
  });

  test("a login tailnet policy refuses is a skip naming the policy step", async () => {
    const denied: HostCommandOutcome = { kind: "access_denied" };
    const { deps, record } = stage({
      script: { [B1]: installableWorker(appliedRecord(B1), { upload: denied }) },
    });
    const [outcome] = (await applyWorkers(deps, request("builder-1"), record)).outcomes;
    expect(outcome).toMatchObject({
      kind: "skipped",
      summary: "Tailnet SSH policy does not let you log in as fffactory-admin",
    });
  });
});

describe("a worker this apply created (plan-apply §Waiting for a new worker)", () => {
  const W1 = { key: "builder-1" as HostKey, hostname: B1 };
  const refusedBootstrap = installableWorker({
    protocol_version: 1,
    hostname: B1,
    state: "refused",
    reason: "bootstrap_incomplete",
    message: "Bootstrap has not finished on this worker",
  });
  const commands = (calls: readonly { command: readonly string[] }[]) =>
    calls.map(({ command }) => command[0]);

  test("waits for it to join the tailnet, then installs and verifies it", async () => {
    // Not there, then offline, then without a Tailscale SSH host key yet, then ready.
    const views = [
      peers(),
      peers(peer(B1, { online: false })),
      peers(peer(B1, { sshHostKeys: [] })),
      peers(peer(B1)),
    ];
    const { deps, record, tailnet, transport, progress, time } = stage({
      view: (read) => views[Math.min(read, views.length) - 1] ?? peers(),
      script: { [B1]: installs(B1) },
    });
    const result = await applyWorkers(deps, creating(request("builder-1"), "builder-1"), record);
    expect(result.outcomes).toEqual([expect.objectContaining({ ...W1, kind: "installed" })]);
    expect(time.sleeps).toEqual([FIRST_BOOT_POLL_MS, FIRST_BOOT_POLL_MS, FIRST_BOOT_POLL_MS]);
    expect(tailnet.reads()).toBe(4);
    expect(commands(transport.calls)).toEqual(["dd", "sudo"]);
    expect(progress.map(({ kind }) => kind)).toEqual(["waiting", "uploading", "installing"]);
    expect(progress[0]).toEqual({ kind: "waiting", ...W1 });
  });

  test("waits while its bootstrap finishes, uploading the release once", async () => {
    let activations = 0;
    const { deps, record, transport, time } = stage({
      script: {
        [B1]: (command, stdin) => {
          const answer =
            command[0] === "sudo" && ++activations <= 2 ? refusedBootstrap : installs(B1);
          return typeof answer === "function" ? answer(command, stdin) : answer;
        },
      },
    });
    const result = await applyWorkers(deps, creating(request("builder-1"), "builder-1"), record);
    expect(result.outcomes).toEqual([expect.objectContaining({ ...W1, kind: "installed" })]);
    expect(commands(transport.calls)).toEqual(["dd", "sudo", "sudo", "sudo"]);
    expect(time.sleeps).toHaveLength(2);
  });

  test("one that never finishes its first boot fails after 15 minutes; the rollout goes on", async () => {
    const { deps, record, recorded, time } = stage({
      view: peers(peer(B2)),
      script: { [B2]: installs(B2) },
    });
    const result = await applyWorkers(
      deps,
      creating(request("builder-1", "builder-2"), "builder-1"),
      record,
    );
    expect(result.outcomes).toEqual([
      firstBootTimedOut(W1, `No Tailscale device named ${B1} is visible from this machine`),
      expect.objectContaining({ key: "builder-2", kind: "installed" }),
    ]);
    expect(time.sleeps).toHaveLength((15 * 60_000) / FIRST_BOOT_POLL_MS);
    expect(recorded.map((outcomes) => outcomes.length)).toEqual([1, 2]);
  });

  test("a bootstrap that never finishes fails the same way, naming what it saw last", async () => {
    const { deps, record } = stage({ script: { [B1]: refusedBootstrap } });
    const [outcome] = (
      await applyWorkers(deps, creating(request("builder-1"), "builder-1"), record)
    ).outcomes;
    expect(outcome).toEqual(firstBootTimedOut(W1, "Its bootstrap has not finished"));
  });

  test("says every minute that it is still waiting, and what it sees", async () => {
    const { deps, record, progress } = stage({ view: peers() });
    await applyWorkers(deps, creating(request("builder-1"), "builder-1"), record);
    const still = progress.filter(({ kind }) => kind === "still_waiting");
    expect(still).toHaveLength(14);
    expect(still[0]).toEqual({
      kind: "still_waiting",
      ...W1,
      waitedMs: 60_000,
      lastSeen: `No Tailscale device named ${B1} is visible from this machine`,
    });
    expect(still.at(-1)).toMatchObject({ waitedMs: 14 * 60_000 });
  });

  test("a stalled clock cannot stretch the wait past its polls", async () => {
    const { deps, record, time } = stage({ view: peers() });
    const stalled = { ...deps, clock: () => T0 };
    const [outcome] = (
      await applyWorkers(stalled, creating(request("builder-1"), "builder-1"), record)
    ).outcomes;
    expect(outcome).toMatchObject({ kind: "failed", beforeInstall: true });
    expect(time.sleeps).toHaveLength((15 * 60_000) / FIRST_BOOT_POLL_MS);
  });

  test("a duplicate or untagged device appearing while it waits is refused at once", async () => {
    for (const [device, summary] of [
      [
        [peer(B1), peer(B1, { dnsName: `${B1}-1.example-tailnet.ts.net.` })],
        `2 Tailscale devices are named ${B1}; fffactory never guesses which is the worker`,
      ],
      [
        [peer(B1, { tags: [] })],
        `The Tailscale device named ${B1} does not carry the factory's tag (tailscale.tag in factory.json)`,
      ],
    ] as const) {
      const { deps, record, transport, time } = stage({
        view: (read) => (read === 1 ? peers() : peers(...device)),
        script: { [B1]: installs(B1) },
      });
      const [outcome] = (
        await applyWorkers(deps, creating(request("builder-1"), "builder-1"), record)
      ).outcomes;
      expect(outcome).toMatchObject({ ...W1, kind: "skipped", summary });
      expect(time.sleeps).toHaveLength(1);
      expect(transport.calls).toEqual([]);
    }
  });

  test("an interrupt while it waits stops at once, before any install step ran on it", async () => {
    const { deps, record, recorded, tailnet, transport } = stage({
      view: (read) => (read <= 2 ? peers() : peers(peer(B1))),
      script: { [B1]: installs(B1), [B2]: installs(B2) },
      interruptAfterSleeps: 2,
    });
    const result = await applyWorkers(
      deps,
      creating(request("builder-1", "builder-2"), "builder-1"),
      record,
    );
    expect(result).toEqual({
      kind: "interrupted",
      outcomes: [],
      installing: undefined,
      waiting: W1,
    });
    expect(tailnet.reads()).toBe(2);
    expect(transport.calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test("a worker this apply did not create is skipped without waiting", async () => {
    const { deps, record, time, progress } = stage({
      view: peers(),
      script: { [B2]: refusedBootstrap },
    });
    const result = await applyWorkers(
      deps,
      creating(request("builder-1", "builder-2"), "builder-3"),
      record,
    );
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(["skipped", "skipped"]);
    expect(time.sleeps).toEqual([]);
    expect(progress.some(({ kind }) => kind === "waiting")).toBe(false);
  });
});
