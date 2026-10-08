import { describe, expect, test } from "bun:test";
import { INSPECT_TIMEOUT_MS } from "../../src/application/inspect-worker";
import { factoryStatus, type StatusDependencies } from "../../src/application/status";
import type { CallerObservation } from "../../src/domain/aws-account";
import { INSPECT_COMMAND } from "../../src/domain/host-protocol";
import { INSPECT_DISPATCH_COMMAND } from "../../src/domain/dispatch-projection";
import { INSPECT_REPOSITORIES_COMMAND } from "../../src/domain/repository-placement";
import { INSPECT_REPOSITORIES_TIMEOUT_MS } from "../../src/application/inspect-repositories";
import {
  type FactoryId,
  type FactoryInstance,
  parseFactoryInstance,
  type Release,
} from "../../src/domain/instance";
import type { MachineInventory, WorkerStatus } from "../../src/domain/status";
import type { PeerView } from "../../src/domain/tailnet";
import { fakeCallerIdentity } from "../support/doctor-fakes";
import {
  type Answer,
  statusAnswers,
  CONFIGURATION_SHA256,
  FAKE_SHA256,
  fakeMachineInventory,
  fakeTailnet,
  fakeTransport,
  inspection,
  installed,
  machine,
  peer,
  peers,
  verification,
} from "../support/fake-workers";

const EXAMPLE = JSON.parse(await Bun.file("examples/factory.json").text());
const B1 = "example-builder-1";
const B2 = "example-builder-2";

function instance(overrides: Record<string, unknown> = {}): FactoryInstance {
  const document = {
    ...EXAMPLE,
    hosts: [
      EXAMPLE.hosts[0],
      { key: "builder-2", instance_type: "m7i.large", root_volume_gib: 100 },
    ],
    ...overrides,
  };
  const parsed = parseFactoryInstance(document);
  if (!parsed.valid) throw new Error(JSON.stringify(parsed.issues));
  return parsed.instance;
}

const BOTH_RUNNING: MachineInventory = {
  kind: "machines",
  machines: [
    machine("builder-1", "running", "i-0000000000000000a"),
    machine("builder-2", "running", "i-0000000000000000b"),
  ],
};

function world({
  inventory = BOTH_RUNNING,
  view = peers(peer(B1), peer(B2)),
  script = {
    [B1]: statusAnswers(inspection(B1, {}, "0.1.0")),
    [B2]: statusAnswers(inspection(B2, {}, "0.1.0")),
  },
  caller,
  sha256 = FAKE_SHA256,
}: {
  inventory?: MachineInventory;
  view?: PeerView;
  script?: Record<string, Answer>;
  caller?: CallerObservation;
  sha256?: (text: string) => string;
} = {}) {
  const identity = fakeCallerIdentity(caller);
  const machines = fakeMachineInventory(inventory);
  const tailnet = fakeTailnet(view);
  const transport = fakeTransport(script);
  const deps: StatusDependencies = {
    identity: identity.identity,
    machines: machines.machines,
    peers: tailnet.tailnet,
    transport: transport.transport,
    sha256,
  };
  return { deps, identity, machines, tailnet, transport };
}

async function report(deps: StatusDependencies, of: FactoryInstance = instance()) {
  const outcome = await factoryStatus(deps, { instance: of, credentials: { source: "chain" } });
  if (outcome.kind !== "report") throw new Error(`no report: ${outcome.kind}`);
  return outcome;
}

function byKey(workers: readonly WorkerStatus[]) {
  return Object.fromEntries(workers.map((worker) => [worker.key, worker]));
}

describe("factory status", () => {
  test("every worker ready on the pinned release is a ready report", async () => {
    const { deps, identity, machines, transport } = world();
    const outcome = await report(deps);
    expect(outcome.target).toEqual({
      factoryId: "example" as FactoryId,
      accountId: "123456789012",
      region: "us-east-1",
      release: "0.1.0" as Release,
    });
    expect(outcome.report.status).toBe("ready");
    expect(outcome.report.workers.map((w) => [w.key, w.status, w.release, w.tailnet])).toEqual([
      ["builder-1", "ready", "0.1.0", "online"],
      ["builder-2", "ready", "0.1.0", "online"],
    ]);
    expect(identity.requests).toEqual([{ credentials: { source: "chain" }, region: "us-east-1" }]);
    expect(machines.requests).toEqual([
      { credentials: { source: "chain" }, region: "us-east-1", factoryId: "example" as FactoryId },
    ]);
    expect(
      transport.calls.map((call) => [call.worker.hostname, call.command, call.timeoutMs]),
    ).toEqual([
      [B1, [...INSPECT_COMMAND], INSPECT_TIMEOUT_MS],
      [B2, [...INSPECT_COMMAND], INSPECT_TIMEOUT_MS],
      [B1, [...INSPECT_REPOSITORIES_COMMAND], INSPECT_REPOSITORIES_TIMEOUT_MS],
      [B1, [...INSPECT_DISPATCH_COMMAND], 120_000],
      [B2, [...INSPECT_REPOSITORIES_COMMAND], INSPECT_REPOSITORIES_TIMEOUT_MS],
      [B2, [...INSPECT_DISPATCH_COMMAND], 120_000],
    ]);
  });

  test("compares each worker's configuration with the projection apply would send it", async () => {
    const digested: string[] = [];
    const { deps } = world({
      sha256: (text) => {
        digested.push(text);
        return text.includes('"builder-2"') ? "e".repeat(64) : CONFIGURATION_SHA256;
      },
    });
    const outcome = await report(deps);
    expect(JSON.parse(digested[0] ?? "")).toEqual({
      protocol_version: 1,
      factory_id: "example",
      host_key: "builder-1",
      hostname: "example-builder-1",
      release: "0.1.0",
      paseo_password_secret:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:example/builder-1/paseo-password-AbCdEf",
    });
    const { "builder-1": one, "builder-2": two } = byKey(outcome.report.workers);
    expect(one?.status).toBe("ready");
    expect(two?.summary).toBe("Its host configuration is not the one factory.json projects for it");
  });

  test("reports requested dispatch active only from the worker's checked schedule state", async () => {
    const dispatch = {
      enabled: true,
      cron: "*/15 * * * *",
      timezone: "UTC",
      provider: "codex",
      model: "configured-model",
      mode: "workspace-write",
      cwd: "/home/factory",
    };
    const active = {
      protocol_version: 1 as const,
      state: "active" as const,
      blockers: [] as const,
      changed: false,
    };
    const { deps } = world({
      script: {
        [B1]: statusAnswers(inspection(B1, {}, "0.1.0"), "synchronized", [], active),
        [B2]: statusAnswers(inspection(B2, {}, "0.1.0")),
      },
    });
    const configured = instance({
      hosts: [
        { ...EXAMPLE.hosts[0], dispatch },
        { key: "builder-2", instance_type: "m7i.large", root_volume_gib: 100 },
      ],
    });
    const { report: result } = await report(deps, configured);
    expect(byKey(result.workers)["builder-1"]).toMatchObject({
      status: "ready",
      dispatch: "active",
    });
  });

  test("a requested schedule observed pending shows its independent blocker", async () => {
    const pending = {
      protocol_version: 1 as const,
      state: "pending" as const,
      blockers: ["github_credential" as const],
      changed: false,
    };
    const { deps } = world({
      script: {
        [B1]: statusAnswers(inspection(B1, {}, "0.1.0"), "synchronized", [], pending),
        [B2]: statusAnswers(inspection(B2, {}, "0.1.0")),
      },
    });
    const configured = instance({
      hosts: [
        {
          ...EXAMPLE.hosts[0],
          dispatch: {
            enabled: true,
            cron: "*/15 * * * *",
            timezone: "UTC",
            provider: "codex",
            model: "configured-model",
            mode: "workspace-write",
            cwd: "/home/factory",
          },
        },
        { key: "builder-2", instance_type: "m7i.large", root_volume_gib: 100 },
      ],
    });
    const { report: result } = await report(deps, configured);
    expect(byKey(result.workers)["builder-1"]).toMatchObject({
      status: "not_ready",
      dispatch: "pending",
      dispatchBlockers: ["github_credential"],
      summary: "Dispatch is pending",
    });
  });

  test("a worker whose enrollment is pending reports each account's exact steps", async () => {
    const pending = inspection(
      B1,
      {
        installation: installed("0.1.0", verification(B1, "pending")),
      },
      "0.1.0",
    );
    const { deps } = world({
      script: {
        [B1]: statusAnswers(pending),
        [B2]: statusAnswers(inspection(B2, {}, "0.1.0")),
      },
    });
    const outcome = await report(deps);
    const one = byKey(outcome.report.workers)["builder-1"];
    expect(outcome.report.status).toBe("not_ready");
    expect(one).toMatchObject({ status: "not_ready", installation: "succeeded" });
    expect(one?.summary).toStartWith("Software ready on release 0.1.0; enrollment pending");
    expect(one?.enrollment?.map((entry) => entry.state)).toEqual(["pending", "pending", "pending"]);
  });

  test("reports unresolved and unmanaged checkouts from the worker's persisted observation", async () => {
    const { deps } = world({
      script: {
        [B1]: statusAnswers(inspection(B1, {}, "0.1.0"), "unresolved", ["legacy/product"]),
        [B2]: statusAnswers(inspection(B2, {}, "0.1.0")),
      },
    });
    const outcome = await report(deps);
    const one = byKey(outcome.report.workers)["builder-1"];
    expect(one).toMatchObject({
      status: "not_ready",
      repositories: "unresolved",
      unmanagedRepositories: ["legacy/product"],
      summary: "One or more placed repositories are unresolved",
    });
    expect(one?.details).toContain("Unmanaged repository: legacy/product");
    expect(outcome.report.status).toBe("not_ready");
  });

  test.each([
    ["none" as const, "not_ready", "Repositories have not been synchronized"],
    ["unreadable" as const, "error", "The worker's repository result could not be read"],
  ])("reports repository state %s without guessing readiness", async (state, status, summary) => {
    const { deps } = world({
      script: {
        [B1]: statusAnswers(inspection(B1, {}, "0.1.0"), state),
        [B2]: statusAnswers(inspection(B2, {}, "0.1.0")),
      },
    });

    const outcome = await report(deps);

    expect(byKey(outcome.report.workers)["builder-1"]).toMatchObject({ status, summary });
  });

  test.each([
    [
      { protocol_version: 1 as const, state: "none" as const },
      "not_ready",
      "Dispatch has not been reconciled",
    ],
    [
      {
        protocol_version: 1 as const,
        state: "active" as const,
        blockers: [] as const,
        changed: false,
      },
      "error",
      "Dispatch does not match factory.json",
    ],
    [
      { protocol_version: 1 as const, state: "unreadable" as const },
      "error",
      "Dispatch state could not be verified",
    ],
  ])(
    "reports dispatch state $state when dispatch is not requested",
    async (dispatch, status, summary) => {
      const { deps } = world({
        script: {
          [B1]: statusAnswers(inspection(B1, {}, "0.1.0"), "synchronized", [], dispatch),
          [B2]: statusAnswers(inspection(B2, {}, "0.1.0")),
        },
      });

      const outcome = await report(deps);

      expect(byKey(outcome.report.workers)["builder-1"]).toMatchObject({ status, summary });
    },
  );

  test("a duplicate hostname is refused with the next action and never connected to", async () => {
    const stale = peer(B1, { dnsName: `${B1}-1.example-tailnet.ts.net.`, online: false });
    const { deps, transport } = world({ view: peers(peer(B1), stale, peer(B2)) });
    const { report: result } = await report(deps);
    const worker = byKey(result.workers)["builder-1"];
    expect(worker).toMatchObject({ status: "not_ready", tailnet: "duplicate", release: "unknown" });
    expect(worker?.summary).toBe(
      `2 Tailscale devices are named ${B1}; fffactory never guesses which is the worker`,
    );
    expect(worker?.nextAction).toBe(
      `Remove the stale devices named ${B1} at https://login.tailscale.com/admin/machines, keeping the worker's, then rerun \`fffactory status\`.`,
    );
    expect(transport.calls.map((call) => call.worker.hostname)).toEqual([B2, B2, B2]);
    expect(result.status).toBe("not_ready");
  });

  test("a missing hostname is refused with the next action and never connected to", async () => {
    const { deps, transport } = world({ view: peers(peer(`${B1}-1`), peer(B2)) });
    const { report: result } = await report(deps);
    const worker = byKey(result.workers)["builder-1"];
    expect(worker).toMatchObject({ status: "not_ready", tailnet: "missing", release: "unknown" });
    expect(worker?.nextAction).toContain("wait for it to join the tailnet");
    expect(worker?.nextAction).toContain(
      "if it failed, terminate the instance in the EC2 console; once it is terminated, the next `fffactory apply` creates it again",
    );
    expect(transport.calls.map((call) => call.worker.hostname)).toEqual([B2, B2, B2]);
  });

  test("a device with the name but not the factory's tag is refused and never connected to", async () => {
    const { deps, transport } = world({
      view: peers(peer(B1, { tags: ["tag:intruder"] }), peer(B2)),
    });
    const { report: result } = await report(deps);
    const worker = byKey(result.workers)["builder-1"];
    expect(worker).toMatchObject({ status: "not_ready", tailnet: "untagged", release: "unknown" });
    expect(worker?.nextAction).toContain(`the device named ${B1} must be this factory's worker`);
    expect(transport.calls.map((call) => call.worker.hostname)).toEqual([B2, B2, B2]);
    expect(result.status).toBe("not_ready");
  });

  test("the tag is factory.json's tailscale.tag", async () => {
    const { deps, transport } = world();
    const retagged = instance({ tailscale: { ...EXAMPLE.tailscale, tag: "tag:other-factory" } });
    const { report: result } = await report(deps, retagged);
    expect(result.workers.map((worker) => worker.tailnet)).toEqual(["untagged", "untagged"]);
    expect(transport.calls).toEqual([]);
  });

  test("an offline worker's release is unknown and the report is not ready", async () => {
    const { deps, transport } = world({ view: peers(peer(B1, { online: false }), peer(B2)) });
    const { report: result } = await report(deps);
    expect(byKey(result.workers)["builder-1"]).toMatchObject({
      status: "not_ready",
      tailnet: "offline",
      release: "unknown",
      configuration: "unknown",
      machine: "running",
      instanceId: "i-0000000000000000a",
    });
    expect(result.status).toBe("not_ready");
    expect(transport.calls).toHaveLength(3);
  });

  test("a worker SSH cannot reach has an unknown release", async () => {
    const { deps } = world({ script: { [B2]: statusAnswers(inspection(B2, {}, "0.1.0")) } });
    const { report: result } = await report(deps);
    expect(byKey(result.workers)["builder-1"]).toMatchObject({
      status: "not_ready",
      tailnet: "online",
      release: "unknown",
      summary: "SSH could not reach it: the connection timed out",
    });
  });

  test("a worker with no release reports none", async () => {
    const { deps } = world({
      script: {
        [B1]: { kind: "completed", exitCode: 127, stdout: "" },
        [B2]: statusAnswers(inspection(B2, {}, "0.1.0")),
      },
    });
    const { report: result } = await report(deps);
    expect(byKey(result.workers)["builder-1"]).toMatchObject({
      status: "not_ready",
      release: "none",
      nextAction: "Install release 0.1.0 with `fffactory apply`, then rerun `fffactory status`.",
    });
  });

  test("a worker that is not provisioned or is stopped is not connected to", async () => {
    const { deps, transport } = world({
      inventory: { kind: "machines", machines: [machine("builder-2", "stopped")] },
    });
    const { report: result } = await report(deps);
    const workers = byKey(result.workers);
    expect(workers["builder-1"]).toMatchObject({
      machine: "absent",
      tailnet: "not_checked",
      release: "unknown",
      status: "not_ready",
    });
    expect(workers["builder-2"]).toMatchObject({ machine: "stopped", tailnet: "not_checked" });
    expect(transport.calls).toEqual([]);
  });

  test("an EC2 inventory it cannot read is an error, and workers are still inspected", async () => {
    const { deps, transport } = world({
      inventory: { kind: "unavailable", reason: "EC2 DescribeInstances failed: AccessDenied" },
    });
    const { report: result } = await report(deps);
    expect(result.status).toBe("error");
    expect(result.inventories[0]).toMatchObject({ id: "ec2_instances", status: "error" });
    expect(result.workers.map((worker) => [worker.machine, worker.status])).toEqual([
      ["unknown", "ready"],
      ["unknown", "ready"],
    ]);
    expect(transport.calls).toHaveLength(6);
  });

  test("with Tailscale logged out no worker is connected to", async () => {
    const { deps, transport } = world({
      view: { kind: "not_running", backendState: "NeedsLogin" },
    });
    const { report: result } = await report(deps);
    expect(result.status).toBe("not_ready");
    expect(result.inventories[1]).toMatchObject({ id: "tailscale", status: "not_ready" });
    expect(result.workers.map((worker) => worker.tailnet)).toEqual(["unknown", "unknown"]);
    expect(transport.calls).toEqual([]);
  });

  test("checks the account before anything else, and refuses another account", async () => {
    const { deps, machines, tailnet, transport } = world({
      caller: {
        kind: "caller",
        caller: { account: "210987654321", arn: "arn:aws:iam::210987654321:user/other" },
      },
    });
    const outcome = await factoryStatus(deps, {
      instance: instance(),
      credentials: { source: "chain" },
    });
    expect(outcome.kind).toBe("account_refused");
    expect(machines.requests).toEqual([]);
    expect(tailnet.reads()).toBe(0);
    expect(transport.calls).toEqual([]);
  });

  test("refuses an incomplete factory.json before calling AWS", async () => {
    const { deps, identity } = world();
    const outcome = await factoryStatus(deps, {
      instance: instance({ hosts: undefined, release: undefined }),
      credentials: { source: "chain" },
    });
    expect(outcome).toEqual({ kind: "incomplete", missing: ["release", "hosts"] });
    expect(identity.requests).toEqual([]);
  });
});
