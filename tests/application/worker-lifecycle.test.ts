import { describe, expect, test } from "bun:test";
import type { AgentActivity } from "../../src/application/control-plane";
import type { HostCommandOutcome } from "../../src/application/host-transport";
import { INSPECT_TIMEOUT_MS } from "../../src/application/inspect-worker";
import type { MachineRequest } from "../../src/application/machine-control";
import { factoryStatus } from "../../src/application/status";
import { stateBucketOf } from "../../src/application/factory-lock";
import { applyFactory } from "../../src/application/apply-factory";
import { planFactory, planInfrastructure } from "../../src/application/plan-factory";
import { ProvisioningFailed } from "../../src/application/provisioner";
import { withoutHost } from "../../src/domain/host-removal";
import { changeTally, type PlanReview } from "../../src/domain/plan";
import {
  type PowerProgress,
  startWorker,
  stopWorker,
  type TerminateRequest,
  terminateWorker,
  type WorkerLifecycleDependencies,
  type WorkerLifecycleRequest,
} from "../../src/application/worker-lifecycle";
import type { CallerObservation } from "../../src/domain/aws-account";
import { newLockRecord } from "../../src/domain/factory-lock";
import { INSPECT_COMMAND } from "../../src/domain/host-protocol";
import { INSPECT_WORK_COMMAND, type RepositoryWork } from "../../src/domain/work-inspection";
import {
  assessCompleteness,
  type FactoryInstance,
  type HostKey,
  parseFactoryInstance,
  type Release,
  serializeInstance,
} from "../../src/domain/instance";
import type { MachineInventory } from "../../src/domain/status";
import type { PeerView } from "../../src/domain/tailnet";
import {
  ONLINE_DEADLINE_MS,
  ONLINE_POLL_MS,
  type ObservedMachineState,
  POWER_DEADLINE_MS,
  POWER_POLL_MS,
} from "../../src/domain/worker-lifecycle";
import { sha256Text } from "../../src/infrastructure/release-tarball";
import { FAKE_CALLER, fakeCallerIdentity } from "../support/doctor-fakes";
import { fakeControlPlane } from "../support/fake-control-plane";
import { fakePrompt, fakeSecretStore } from "../support/fake-secrets";
import {
  type Answer,
  answers,
  fakeMachineControl,
  fakeMachineInventory,
  fakeTailnet,
  fakeTailnetAdmin,
  fakeTime,
  fakeTransport,
  machine,
  peer,
  peers,
  readyWorker,
  statusAnswers,
  tailnetDevice,
  workAnswer,
} from "../support/fake-workers";
import {
  BUCKET,
  declaring,
  FACTORY,
  NOW,
  RELEASE,
  WORKER_TAG,
  workerFleet,
} from "../support/factory-world";
import type { SecretReference } from "../../src/domain/instance";
import { MemoryLockStore } from "../support/memory-lock-store";
import { fakeFactoryWorld, SECRETS_POLICY } from "../support/fake-provisioner";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { MemoryPlanStore } from "../support/memory-plan-store";

const KEY = "builder-1";
const HOSTNAME = `${FACTORY}-${KEY}`;
const ID = "i-0123456789abcdef0";
const ONLINE = peers(peer(HOSTNAME, { tags: [WORKER_TAG] }));
const OFFLINE = peers(peer(HOSTNAME, { tags: [WORKER_TAG], online: false }));

interface WorldOptions {
  readonly inventory?: MachineInventory;
  readonly states?: readonly (ObservedMachineState | undefined)[];
  readonly request?: MachineRequest;
  readonly activity?: AgentActivity;
  readonly noControlPlane?: boolean;
  readonly view?: PeerView | ((read: number) => PeerView);
  readonly worker?: Answer;
  readonly caller?: CallerObservation;
  readonly prompt?: ReturnType<typeof fakePrompt>;
  readonly onSleep?: (slept: number) => void;
  readonly admin?: Parameters<typeof fakeTailnetAdmin>[0];
  readonly secretReadFails?: Error;
  /** The host keys the factory's Terraform state has provisioned. */
  readonly provisioned?: readonly string[];
  /** factory.json's text in the instance store. */
  readonly configuration?: string;
  /** The secrets the state's secret-reading policy allows; not modeled unless set. */
  readonly secretArns?: readonly string[];
}

/** Where the instance store holds factory.json. */
const PATH = "/work/.fffactory/factory.json";
const TERRAFORM = "/cache/releases/0.3.0/terraform";

/** The admin client's reference, and the client secret Secrets Manager holds for it. */
const ADMIN_ARN =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/tailscale-admin-client-AbCdEf" as SecretReference;
const ADMIN_SECRET = "tskey-client-kExample1CNTRL-0123456789abcdef";

/** What terminate's removal reaches: the factory's Terraform, the plan store and factory.json. */
function removalPorts(lockStore: MemoryLockStore, options: WorldOptions) {
  return {
    terraform: fakeFactoryWorld({
      store: lockStore,
      bucket: BUCKET,
      hosts: options.provisioned ?? [KEY, "builder-2"],
      instanceIds: { [KEY]: ID },
      ...(options.secretArns === undefined ? {} : { secretArns: options.secretArns }),
    }),
    planStore: new MemoryPlanStore(),
    store: new MemoryInstanceStore({
      [PATH]: options.configuration ?? serializeInstance(withAdmin()),
    }),
  };
}

/** One declared worker, `builder-1`, its machine and the ports a power command reaches. */
function world(options: WorldOptions = {}) {
  const lockStore = new MemoryLockStore([BUCKET]);
  const identity = fakeCallerIdentity(options.caller);
  const inventory = fakeMachineInventory(
    options.inventory ?? { kind: "machines", machines: [machine(KEY, "running", ID)] },
  );
  const control = fakeMachineControl({
    states: options.states ?? ["stopped"],
    ...(options.request ? { request: options.request } : {}),
  });
  const controlPlane = fakeControlPlane("healthy", options.activity ?? { kind: "idle" });
  const tailnet = fakeTailnet(options.view ?? ONLINE);
  const transport = fakeTransport({
    [HOSTNAME]: options.worker ?? answers(readyWorker(FACTORY, KEY, RELEASE)),
  });
  const prompt = options.prompt ?? fakePrompt();
  const secrets = fakeSecretStore({
    values: { [ADMIN_ARN]: ADMIN_SECRET },
    ...(options.secretReadFails ? { readFailsWith: options.secretReadFails } : {}),
  });
  const admin = fakeTailnetAdmin(
    options.admin ?? { devices: [tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG])] },
  );
  const progress: unknown[] = [];
  let interrupted = false;
  const time = fakeTime(NOW, (slept) => options.onSleep?.(slept));
  const { terraform, planStore, store } = removalPorts(lockStore, options);
  let materialized = 0;
  const deps: WorkerLifecycleDependencies = {
    identity: identity.identity,
    lockStore,
    machines: inventory.machines,
    control: control.control,
    peers: tailnet.tailnet,
    transport: transport.transport,
    controlPlane: options.noControlPlane ? undefined : controlPlane.controlPlane,
    prompt: prompt.prompt,
    secrets: secrets.store,
    tailnetAdmin: admin.admin,
    provisioner: terraform.provisioner,
    planStore,
    store,
    terraformDirectory: async () => {
      materialized += 1;
      return TERRAFORM;
    },
    interrupted: () => interrupted,
    sleep: time.sleep,
    sha256: sha256Text,
    progress: (event) => progress.push(event),
  };
  return {
    deps,
    lockStore,
    identity,
    inventory,
    control,
    controlPlane,
    tailnet,
    transport,
    prompt,
    secrets,
    admin,
    progress,
    time,
    terraform,
    planStore,
    store,
    materialized: () => materialized,
    interrupt: () => {
      interrupted = true;
    },
  };
}

type World = ReturnType<typeof world>;

function request(
  w: World,
  overrides: Partial<Omit<WorkerLifecycleRequest, "action">> = {},
): Omit<WorkerLifecycleRequest, "action"> {
  return {
    instance: declaring(KEY, "builder-2"),
    key: KEY,
    credentials: { source: "--profile", profile: "factory" },
    release: RELEASE,
    force: false,
    yes: true,
    host: "operator-laptop",
    clock: w.time.clock,
    randomBytes: (count) => new Uint8Array(count),
    ...overrides,
  };
}

const records = (w: World) => [...w.lockStore.operations.values()];
const stages = (w: World) =>
  w.lockStore.operationWrites.map((record) => record.stages.map((stage) => stage.status).join());

describe("fffactory worker stop (worker-lifecycle §Stop)", () => {
  test("stops an idle running worker under the lock, waits for stopped and records each step", async () => {
    const w = world({ states: ["stopping", "stopping", "stopped"] });
    const result = await stopWorker(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      worker: { key: KEY, hostname: HOSTNAME },
      instanceId: ID,
      changed: true,
    });
    expect(w.controlPlane.calls).toEqual(["activeAgents"]);
    expect(w.control.calls).toEqual([`stop ${ID}`, `state ${ID}`, `state ${ID}`, `state ${ID}`]);
    expect(w.control.targets[0]).toEqual({
      credentials: { source: "--profile", profile: "factory" },
      region: "eu-west-2",
      factoryId: FACTORY,
      instanceId: ID,
    });
    expect(w.time.sleeps).toEqual([POWER_POLL_MS, POWER_POLL_MS]);
    expect(w.lockStore.locks.size).toBe(0);
    const [record] = records(w);
    expect(record).toMatchObject({
      operation: "worker-stop",
      status: "succeeded",
      stages: [{ name: "stop", status: "stopped" }],
      machine: { key: KEY, hostname: HOSTNAME, instance_id: ID, state: "stopped" },
      failure: null,
    });
    expect(stages(w)).toEqual([
      "locating",
      "locating",
      "inspecting",
      "stopping",
      "stopping",
      "stopped",
    ]);
    expect(w.progress).toEqual([
      { kind: "located", key: KEY, hostname: HOSTNAME, instanceId: ID, state: "running" },
      { kind: "requested", action: "stop", instanceId: ID },
    ]);
  });

  test("refuses while agents are active, before any EC2 mutation", async () => {
    const w = world({ activity: { kind: "active", count: 2 } });
    const result = await stopWorker(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusal: { summary: `2 agents are active on ${HOSTNAME}: stopping it would end them` },
    });
    expect(w.control.calls).toEqual([]);
    expect(records(w)[0]).toMatchObject({
      status: "refused",
      stages: [{ name: "stop", status: "refused" }],
    });
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("refuses a running worker it cannot inspect: offline, unreachable or with no control plane", async () => {
    const offline = world({ view: OFFLINE });
    expect(await stopWorker(offline.deps, request(offline))).toMatchObject({
      kind: "refused",
      refusal: {
        summary: `${HOSTNAME} could not be inspected: Offline in the tailnet`,
        nextAction:
          "Check that the instance is running and that Tailscale is up on it, then rerun " +
          "`fffactory worker stop builder-1`. --force stops it uninspected.",
      },
    });
    expect(offline.controlPlane.calls).toEqual([]);
    const unreachable = world({
      activity: { kind: "unknown", reason: "Paseo activity could not be read" },
    });
    expect(await stopWorker(unreachable.deps, request(unreachable))).toMatchObject({
      kind: "refused",
      refusal: {
        summary: `${HOSTNAME} could not be inspected for active agents: Paseo activity could not be read`,
      },
    });
    const none = world({ noControlPlane: true });
    expect(await stopWorker(none.deps, request(none))).toMatchObject({
      kind: "refused",
      refusal: {
        summary: `${HOSTNAME} could not be inspected for active agents: this fffactory cannot reach the worker's control plane`,
      },
    });
    for (const w of [offline, unreachable, none]) expect(w.control.calls).toEqual([]);
  });

  test("--force skips the gates, never the account check, the lock or the record", async () => {
    for (const options of [
      { activity: { kind: "active", count: 3 } as const },
      { view: OFFLINE },
    ]) {
      const w = world(options);
      const result = await stopWorker(w.deps, request(w, { force: true }));
      expect(result).toMatchObject({ kind: "done", changed: true });
      expect(w.controlPlane.calls).toEqual([]);
      expect(w.tailnet.reads()).toBe(0);
      expect(w.control.mutations()).toEqual([`stop ${ID}`]);
      expect(w.identity.requests).toHaveLength(1);
      expect(stages(w)).not.toContain("inspecting");
      expect(w.progress).toContainEqual({ kind: "forced", action: "stop" });
    }
  });

  test("an already stopped worker is a no-op success: EC2 is never asked to change it", async () => {
    const w = world({ inventory: { kind: "machines", machines: [machine(KEY, "stopped", ID)] } });
    expect(await stopWorker(w.deps, request(w))).toMatchObject({
      kind: "done",
      changed: false,
      awaited: false,
    });
    expect(w.control.calls).toEqual([]);
    expect(w.controlPlane.calls).toEqual([]);
    expect(records(w)[0]).toMatchObject({
      status: "succeeded",
      stages: [{ name: "stop", status: "unchanged" }],
    });
  });

  test("a stopping worker is waited for, never asked again", async () => {
    const w = world({
      inventory: { kind: "machines", machines: [machine(KEY, "stopping", ID)] },
      states: ["stopping", "stopped"],
    });
    expect(await stopWorker(w.deps, request(w))).toMatchObject({
      kind: "done",
      changed: false,
      awaited: true,
    });
    expect(w.control.mutations()).toEqual([]);
    expect(w.controlPlane.calls).toEqual([]);
    expect(w.progress).toContainEqual({ kind: "awaiting", action: "stop", instanceId: ID });
  });

  test("a pending or terminating machine is refused, recorded and unlocked", async () => {
    const w = world({ inventory: { kind: "machines", machines: [machine(KEY, "pending", ID)] } });
    expect(await stopWorker(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusal: { summary: `EC2 instance ${ID} is pending` },
    });
    expect(w.control.calls).toEqual([]);
    expect(records(w)[0]?.machine?.state).toBe("pending");
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("a failed request fails, by error name, and the lock is released", async () => {
    const w = world({
      request: { kind: "failed", reason: "EC2 StopInstances failed: UnauthorizedOperation" },
    });
    expect(await stopWorker(w.deps, request(w))).toMatchObject({
      kind: "failed",
      refusal: {
        summary: "EC2 StopInstances failed: UnauthorizedOperation",
        nextAction:
          `Check that the credentials may call ec2:StopInstances on instance ${ID}, then rerun ` +
          "`fffactory worker stop builder-1`.",
      },
    });
    expect(records(w)[0]).toMatchObject({
      status: "failed",
      stages: [{ name: "stop", status: "failed" }],
      failure: "EC2 StopInstances failed: UnauthorizedOperation",
    });
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("a machine that never stops fails at the deadline; one that vanishes fails at once", async () => {
    const slow = world({ states: ["stopping"] });
    expect(await stopWorker(slow.deps, request(slow))).toMatchObject({
      kind: "failed",
      refusal: {
        summary: `EC2 instance ${ID} did not reach stopped within 10 min (last seen: stopping)`,
      },
    });
    expect(slow.time.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(POWER_DEADLINE_MS);
    expect(records(slow)[0]?.machine?.state).toBe("stopping");
    const lagging = world({ states: ["stopping", undefined] });
    expect(await stopWorker(lagging.deps, request(lagging))).toMatchObject({
      refusal: {
        summary: `EC2 instance ${ID} did not reach stopped within 10 min (last seen: stopping)`,
      },
    });
    expect(records(lagging)[0]?.machine?.state).toBe("stopping");
    const gone = world({ states: [undefined, "terminated"] });
    expect(await stopWorker(gone.deps, request(gone))).toMatchObject({
      kind: "failed",
      refusal: {
        summary: `EC2 instance ${ID} is terminated while fffactory waited for it to be stopped`,
      },
    });
    expect(gone.time.sleeps).toEqual([POWER_POLL_MS]);
    expect(records(gone)[0]?.machine?.state).toBe("terminated");
  });

  test("a request EC2 did not answer in time fails, saying it may have reached EC2", async () => {
    const w = world({
      request: { kind: "unanswered", reason: "EC2 StopInstances failed: timed out after 15 s" },
    });
    expect(await stopWorker(w.deps, request(w))).toMatchObject({
      kind: "failed",
      refusal: {
        summary: "EC2 StopInstances failed: timed out after 15 s",
        details: [`The request may have reached EC2: instance ${ID} may be stopping.`],
        nextAction:
          "Check the worker with `fffactory status`, then rerun `fffactory worker stop builder-1`.",
      },
    });
    expect(w.control.calls).toEqual([`stop ${ID}`]);
    expect(records(w)[0]).toMatchObject({
      status: "failed",
      failure: "EC2 StopInstances failed: timed out after 15 s",
    });
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("an error under the lock fails the operation and releases the lock", async () => {
    const w = world();
    w.deps = {
      ...w.deps,
      machines: {
        ...w.deps.machines,
        list: async () => {
          throw new Error("S3 PutObject on the state bucket failed: SlowDown");
        },
      },
    } as WorkerLifecycleDependencies;
    const result = await stopWorker(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "failed",
      refusal: { summary: "S3 PutObject on the state bucket failed: SlowDown" },
      recordFailure: undefined,
    });
    expect(w.lockStore.locks.size).toBe(0);
  });
});

describe("refusals before any EC2 mutation (worker-lifecycle §Order)", () => {
  test("an undeclared key and an incomplete factory.json are refused before AWS", async () => {
    const w = world();
    expect(await stopWorker(w.deps, request(w, { key: "builder-9" }))).toMatchObject({
      kind: "refused",
      refusal: { summary: "factory.json declares no host builder-9" },
      operation: undefined,
    });
    const incomplete: FactoryInstance = { ...declaring(KEY), tailscale: undefined };
    expect(await startWorker(w.deps, request(w, { instance: incomplete }))).toEqual({
      kind: "incomplete",
      missing: ["tailscale.tag", "tailscale.auth_key_secret"],
    });
    expect(w.identity.requests).toEqual([]);
    expect(w.lockStore.calls).toEqual([]);
  });

  test("another account is refused before the pin guard, the lock and EC2", async () => {
    const w = world({
      caller: { kind: "caller", caller: { ...FAKE_CALLER, account: "999999999999" } },
    });
    expect(await startWorker(w.deps, request(w, { release: "0.2.0" as Release }))).toMatchObject({
      kind: "account_refused",
    });
    expect(w.lockStore.calls).toEqual([]);
    expect(w.inventory.requests).toEqual([]);
  });

  test("a pin mismatch is refused before the lock", async () => {
    const w = world();
    const result = await stopWorker(w.deps, request(w, { release: "0.4.0" as Release }));
    expect(result).toMatchObject({ kind: "release_mismatch" });
    expect(w.lockStore.calls).toEqual([]);
  });

  test("a held lock is refused, showing its holder, before the machine is looked for", async () => {
    const w = world();
    const held = w.lockStore.hold(
      BUCKET,
      newLockRecord({
        factoryId: FACTORY,
        operation: "apply",
        holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
        now: NOW,
        release: RELEASE,
        randomBytes: (count) => new Uint8Array(count).fill(5),
      }),
    );
    expect(await stopWorker(w.deps, request(w))).toEqual({ kind: "locked", held });
    expect(w.inventory.requests).toEqual([]);
    expect(w.lockStore.locks.get(BUCKET)).toBe(held);
  });

  test("no instance, or several, is refused under the lock and recorded", async () => {
    for (const machines of [
      [],
      [machine(KEY, "running", ID), machine(KEY, "stopped", "i-0fedcba9876543210")],
    ]) {
      const w = world({ inventory: { kind: "machines", machines } });
      const result = await startWorker(w.deps, request(w));
      expect(result.kind).toBe("refused");
      expect(w.control.calls).toEqual([]);
      expect(records(w)[0]).toMatchObject({ operation: "worker-start", status: "refused" });
      expect(w.lockStore.locks.size).toBe(0);
    }
  });

  test("the instances are listed by the factory ID tag in the factory Region", async () => {
    const w = world({ inventory: { kind: "machines", machines: [machine(KEY, "stopped", ID)] } });
    await stopWorker(w.deps, request(w));
    expect(w.inventory.requests).toEqual([
      {
        credentials: { source: "--profile", profile: "factory" },
        region: "eu-west-2",
        factoryId: FACTORY,
      },
    ]);
  });
});

describe("confirmation (worker-lifecycle §Confirmation)", () => {
  test("without a terminal or --yes the command is refused before anything else", async () => {
    const w = world();
    expect(await stopWorker(w.deps, request(w, { yes: false }))).toEqual({
      kind: "unconfirmable",
    });
    expect(w.identity.requests).toEqual([]);
  });

  test("at a terminal, y confirms and anything else declines, changing nothing", async () => {
    const yes = world({ prompt: fakePrompt({ interactive: true, answers: ["y"] }) });
    expect(await stopWorker(yes.deps, request(yes, { yes: false }))).toMatchObject({
      kind: "done",
    });
    expect(yes.prompt.asked).toEqual([
      `Stop worker ${KEY} (${HOSTNAME}), EC2 instance ${ID}? [y/N] `,
    ]);
    expect(stages(yes)).toContain("awaiting_approval");
    const no = world({ prompt: fakePrompt({ interactive: true, answers: [""] }) });
    expect(await stopWorker(no.deps, request(no, { yes: false }))).toMatchObject({
      kind: "declined",
    });
    expect(no.control.calls).toEqual([]);
    expect(records(no)[0]).toMatchObject({
      status: "declined",
      stages: [{ name: "stop", status: "declined" }],
    });
    expect(no.lockStore.locks.size).toBe(0);
  });

  test("--yes is never asked; a no-op is never asked", async () => {
    const w = world({ prompt: fakePrompt({ interactive: true }) });
    await stopWorker(w.deps, request(w));
    expect(w.prompt.asked).toEqual([]);
    const noop = world({
      prompt: fakePrompt({ interactive: true }),
      inventory: { kind: "machines", machines: [machine(KEY, "stopped", ID)] },
    });
    await stopWorker(noop.deps, request(noop, { yes: false }));
    expect(noop.prompt.asked).toEqual([]);
  });
});

describe("fffactory worker start (worker-lifecycle §Start)", () => {
  const STOPPED = { kind: "machines" as const, machines: [machine(KEY, "stopped", ID)] };

  test("starts a stopped worker, waits for running and the tailnet, then reports its verdict", async () => {
    const w = world({
      inventory: STOPPED,
      states: ["pending", "running"],
      view: (read) => (read < 3 ? OFFLINE : ONLINE),
    });
    const result = await startWorker(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      changed: true,
      verdict: { status: "ready", summary: `Ready on release ${RELEASE}`, nextAction: null },
    });
    expect(w.control.mutations()).toEqual([`start ${ID}`]);
    expect(w.controlPlane.calls).toEqual([]);
    expect(w.time.sleeps).toEqual([POWER_POLL_MS, ONLINE_POLL_MS, ONLINE_POLL_MS]);
    expect(w.transport.calls.map(({ command, timeoutMs }) => ({ command, timeoutMs }))).toEqual([
      { command: [...INSPECT_COMMAND], timeoutMs: INSPECT_TIMEOUT_MS },
    ]);
    expect(stages(w)).toEqual([
      "locating",
      "locating",
      "starting",
      "starting",
      "waiting",
      "started",
    ]);
    expect(records(w)[0]).toMatchObject({
      operation: "worker-start",
      status: "succeeded",
      machine: { state: "running" },
    });
    expect(w.progress).toContainEqual({ kind: "waiting_online", hostname: HOSTNAME });
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("a stale release or configuration names `fffactory apply`", async () => {
    const stale = readyWorker(FACTORY, KEY, "0.2.0");
    const w = world({ inventory: STOPPED, states: ["running"], worker: answers(stale) });
    const result = await startWorker(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      verdict: {
        status: "not_ready",
        summary: `It runs release 0.2.0; factory.json pins ${RELEASE}`,
        nextAction: `Install release ${RELEASE} with \`fffactory apply\`, then rerun \`fffactory status\`.`,
      },
    });
  });

  test("a worker that does not come online in time is reported with status's tailnet next action", async () => {
    const w = world({ inventory: STOPPED, states: ["running"], view: OFFLINE });
    const result = await startWorker(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      changed: true,
      verdict: {
        status: "not_ready",
        summary: "Offline in the tailnet",
        nextAction:
          "Check that the instance is running and that Tailscale is up on it, then rerun `fffactory status`.",
      },
    });
    expect(w.time.sleeps.filter((ms) => ms === ONLINE_POLL_MS)).toHaveLength(
      ONLINE_DEADLINE_MS / ONLINE_POLL_MS,
    );
    expect(w.transport.calls).toEqual([]);
    expect(records(w)[0]).toMatchObject({ status: "succeeded" });
  });

  test("a tailnet refusal is reported at once, never waited out", async () => {
    const w = world({
      inventory: STOPPED,
      states: ["running"],
      view: peers(peer(HOSTNAME, { tags: [WORKER_TAG] }), peer(HOSTNAME, { tags: [WORKER_TAG] })),
    });
    const result = await startWorker(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      verdict: { summary: expect.stringContaining("2 Tailscale devices") },
    });
    expect(w.time.sleeps).toEqual([]);
  });

  test("an already running worker is a no-op success that still reports its verdict", async () => {
    const w = world();
    const result = await startWorker(w.deps, request(w));
    expect(result).toMatchObject({ kind: "done", changed: false, verdict: { status: "ready" } });
    expect(w.control.calls).toEqual([]);
    expect(records(w)[0]).toMatchObject({
      status: "succeeded",
      stages: [{ name: "start", status: "unchanged" }],
    });
  });

  test("a stopping machine is refused until it has stopped", async () => {
    const w = world({ inventory: { kind: "machines", machines: [machine(KEY, "stopping", ID)] } });
    expect(await startWorker(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusal: { summary: `EC2 instance ${ID} is stopping` },
    });
    expect(w.control.calls).toEqual([]);
  });
});

describe("interruption (worker-lifecycle §Interruption)", () => {
  test("before the lock: nothing is locked or asked", async () => {
    const w = world();
    w.interrupt();
    expect(await stopWorker(w.deps, request(w))).toEqual({ kind: "interrupted", locked: false });
    expect(w.lockStore.calls.filter((call) => call.startsWith("create"))).toEqual([]);
  });

  test("during the wait for the target state: stops at once, keeps the lock and the record", async () => {
    let w: World | undefined;
    w = world({ states: ["stopping"], onSleep: () => w?.interrupt() });
    const result = await stopWorker(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "interrupted",
      locked: true,
      requested: true,
      record: { bucket: BUCKET },
    });
    expect(w.time.sleeps).toEqual([POWER_POLL_MS]);
    expect(w.lockStore.locks.size).toBe(1);
    const [record] = records(w);
    expect(record).toMatchObject({
      status: "running",
      stages: [{ name: "stop", status: "stopping" }],
    });
  });

  test("during start's wait for the tailnet: the lock stays and nothing more is written", async () => {
    let w: World | undefined;
    w = world({
      inventory: { kind: "machines", machines: [machine(KEY, "stopped", ID)] },
      states: ["running"],
      view: OFFLINE,
      onSleep: () => w?.interrupt(),
    });
    const result = await startWorker(w.deps, request(w));
    expect(result).toMatchObject({ kind: "interrupted", locked: true, requested: true });
    expect(w.lockStore.locks.size).toBe(1);
    expect(records(w)[0]).toMatchObject({
      status: "running",
      stages: [{ name: "start", status: "waiting" }],
    });
    expect(w.transport.calls).toEqual([]);
  });

  test("at the confirmation question: the interrupt wins over the answer", async () => {
    let w: World | undefined;
    const prompt = fakePrompt({ interactive: true, answers: ["y"] });
    const ask = prompt.prompt.ask;
    w = world({
      prompt: {
        ...prompt,
        prompt: {
          ...prompt.prompt,
          ask: async (question) => {
            w?.interrupt();
            return ask(question);
          },
        },
      },
    });
    const result = await stopWorker(w.deps, request(w, { yes: false }));
    expect(result).toMatchObject({ kind: "interrupted", locked: true, requested: false });
    expect(w.control.calls).toEqual([]);
    expect(w.lockStore.locks.size).toBe(1);
  });

  test("while the request's stage is written: EC2 is never asked", async () => {
    const w = world();
    const write = w.lockStore.writeOperation.bind(w.lockStore);
    w.lockStore.writeOperation = async (bucket, record) => {
      await write(bucket, record);
      if (record.stages.at(-1)?.status === "stopping") w.interrupt();
    };
    expect(await stopWorker(w.deps, request(w))).toEqual({
      kind: "interrupted",
      locked: true,
      record: { bucket: BUCKET, key: expect.any(String) },
      requested: false,
    });
    expect(w.control.mutations()).toEqual([]);
    expect(records(w)[0]).toMatchObject({
      status: "running",
      stages: [{ name: "stop", status: "stopping" }],
    });
    expect(w.lockStore.locks.size).toBe(1);
  });

  test("while the final record is written: reported interrupted, since the lock stays", async () => {
    const ending = [
      { options: {}, outcome: "succeeded" },
      {
        options: { inventory: { kind: "machines", machines: [machine(KEY, "pending", ID)] } },
        outcome: "refused",
      },
      {
        options: { request: { kind: "failed", reason: "UnauthorizedOperation" } },
        outcome: "failed",
      },
    ] as const;
    for (const { options, outcome } of ending) {
      const w = world(options);
      const write = w.lockStore.writeOperation.bind(w.lockStore);
      w.lockStore.writeOperation = async (bucket, record) => {
        await write(bucket, record);
        if (record.status !== "running") w.interrupt();
      };
      expect(await stopWorker(w.deps, request(w))).toMatchObject({
        kind: "interrupted",
        locked: true,
        record: { bucket: BUCKET },
      });
      expect(records(w)[0]?.status).toBe(outcome);
      expect(w.lockStore.locks.size).toBe(1);
    }
  });

  test("right after the lock is taken: kept, with no record", async () => {
    const w = world();
    const create = w.lockStore.create.bind(w.lockStore);
    w.lockStore.create = async (bucket, record) => {
      const created = await create(bucket, record);
      w.interrupt();
      return created;
    };
    expect(await stopWorker(w.deps, request(w))).toEqual({
      kind: "interrupted",
      locked: true,
      record: undefined,
      requested: false,
    });
    expect(w.lockStore.locks.size).toBe(1);
    expect(w.lockStore.operationWrites).toEqual([]);
  });
});

/** factory.json declaring builder-1 and builder-2, with the Tailscale admin client. */
function withAdmin(): FactoryInstance {
  const instance = declaring(KEY, "builder-2");
  return {
    ...instance,
    tailscale: {
      tag: WORKER_TAG,
      auth_key_secret: instance.tailscale?.auth_key_secret as SecretReference,
      admin_client_secret: ADMIN_ARN,
    },
  };
}

/** The Tailscale auth key's reference, and Paseo password references in the test account. */
const AUTH = declaring(KEY).tailscale?.auth_key_secret as string;
const paseoPassword = (name: string) =>
  `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${FACTORY}/${name}-AbCdEf` as SecretReference;
const PASEO_1 = paseoPassword("builder-1-paseo-password");
const PASEO_2 = paseoPassword("builder-2-paseo-password");
const OLD_PASEO_1 = paseoPassword("builder-1-paseo-password-old");

/** withAdmin's factory.json, builder-1 and builder-2 each with its own Paseo password. */
function withPasswords(first: SecretReference, second: SecretReference): FactoryInstance {
  const instance = withAdmin();
  const passwords = [first, second];
  return {
    ...instance,
    hosts: (instance.hosts ?? []).map((host, index) => ({
      ...host,
      paseo_password_secret: passwords[index],
    })),
  };
}

/** A terminate request: keep mode, confirmed in advance with `--confirm builder-1`. */
function terminating(
  w: World,
  overrides: Partial<Omit<WorkerLifecycleRequest, "action">> = {},
): TerminateRequest {
  return {
    ...request(w, { instance: withAdmin(), yes: false, confirm: KEY, ...overrides }),
    keep: true,
  } as TerminateRequest;
}

/**
 * A terminate request removing the host, confirmed in advance with `--confirm builder-1`,
 * factory.json read as the text of its instance.
 */
function removing(
  w: World,
  overrides: Partial<Omit<WorkerLifecycleRequest, "action">> = {},
): TerminateRequest {
  const instance = overrides.instance ?? withAdmin();
  return {
    ...request(w, { instance, yes: false, confirm: KEY, ...overrides }),
    keep: false,
    configuration: { path: PATH, text: serializeInstance(instance) },
  } as TerminateRequest;
}

/** The worker answering its inspection, its repository result and its dispatch state. */
const CLEAN = statusAnswers(readyWorker(FACTORY, KEY, RELEASE));
const TERMINATING = { states: ["shutting-down", "terminated"] as const, worker: CLEAN };
/** The typed-key question for a `--keep` whose machine is already being terminated. */
const SHUTTING_DOWN_QUESTION =
  `Wait for EC2 instance ${ID}, already being terminated, then delete the Tailscale devices of ` +
  `worker ${KEY} (${HOSTNAME})? Type the host key to confirm: `;

describe("fffactory worker terminate --keep (worker-lifecycle §Terminate (keep))", () => {
  test("terminates an idle running worker, waits for terminated, then deletes its tailnet device", async () => {
    const w = world({
      ...TERMINATING,
      admin: {
        devices: [
          tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG]),
          tailnetDevice("nOther1CNTRL", `${FACTORY}-builder-2`, [WORKER_TAG]),
        ],
      },
    });
    const result = await terminateWorker(w.deps, terminating(w));
    expect(result).toMatchObject({
      kind: "done",
      action: "terminate",
      worker: { key: KEY, hostname: HOSTNAME },
      instanceId: ID,
      changed: true,
      devices: { kind: "listed", removed: ["nWorker1CNTRL"], failed: [], untagged: [] },
      leftover: undefined,
    });
    expect(w.controlPlane.calls).toEqual(["activeAgents"]);
    // The last synchronization's result, then the work in every checkout as it is now.
    expect(w.transport.calls.map(({ command }) => command.join(" "))).toEqual([
      expect.stringContaining("repositories"),
      INSPECT_WORK_COMMAND.join(" "),
    ]);
    expect(w.control.calls).toEqual([`terminate ${ID}`, `state ${ID}`, `state ${ID}`]);
    expect(w.secrets.reads).toEqual([
      {
        reference: ADMIN_ARN,
        region: "eu-west-2",
        credentials: { source: "--profile", profile: "factory" },
      },
    ]);
    expect(w.admin.secrets).toEqual([ADMIN_SECRET]);
    expect(w.admin.calls).toEqual(["open", "devices", "remove nWorker1CNTRL"]);
    expect(w.admin.devices().map((device) => device.id)).toEqual(["nOther1CNTRL"]);
    expect(w.lockStore.locks.size).toBe(0);
    expect(records(w)[0]).toMatchObject({
      operation: "worker-terminate",
      status: "succeeded",
      stages: [{ name: "terminate", status: "terminated" }],
      machine: { key: KEY, hostname: HOSTNAME, instance_id: ID, state: "terminated" },
      failure: null,
    });
    expect(stages(w)).toEqual([
      "locating",
      "locating",
      "inspecting",
      "authorizing",
      "terminating",
      "terminating",
      "removing_devices",
      "terminated",
    ]);
    expect(w.progress).toEqual([
      { kind: "located", key: KEY, hostname: HOSTNAME, instanceId: ID, state: "running" },
      { kind: "requested", action: "terminate", instanceId: ID },
      { kind: "removing_devices", hostname: HOSTNAME },
    ]);
  });

  test("the secret reaches nothing but the admin client: no record, progress or result", async () => {
    const w = world(TERMINATING);
    const result = await terminateWorker(w.deps, terminating(w));
    for (const text of [
      JSON.stringify(result),
      JSON.stringify(w.progress),
      ...w.lockStore.operationWrites.map((record) => JSON.stringify(record)),
    ])
      expect(text).not.toContain(ADMIN_SECRET);
  });

  test("a stopped worker passes the gates uninspected, without --force", async () => {
    const w = world({
      ...TERMINATING,
      inventory: { kind: "machines", machines: [machine(KEY, "stopped", ID)] },
      view: OFFLINE,
    });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
      kind: "done",
      changed: true,
    });
    expect(w.controlPlane.calls).toEqual([]);
    expect(w.transport.calls).toEqual([]);
    expect(w.tailnet.reads()).toBe(0);
    expect(stages(w)).not.toContain("inspecting");
    expect(w.progress).toContainEqual({ kind: "uninspected_stopped" });
    expect(w.control.mutations()).toEqual([`terminate ${ID}`]);
  });

  test("a machine already being terminated is waited for, then its devices deleted, once the host key is typed", async () => {
    const w = world({
      ...TERMINATING,
      inventory: { kind: "machines", machines: [machine(KEY, "shutting-down", ID)] },
      states: ["absent"],
      prompt: fakePrompt({ interactive: true, answers: [KEY] }),
    });
    expect(await terminateWorker(w.deps, terminating(w, { confirm: undefined }))).toMatchObject({
      kind: "done",
      changed: false,
      awaited: true,
      devices: { removed: ["nWorker1CNTRL"] },
    });
    expect(w.control.mutations()).toEqual([]);
    expect(w.controlPlane.calls).toEqual([]);
    expect(w.prompt.asked).toEqual([SHUTTING_DOWN_QUESTION]);
    // Asked before the wait: the operator is not left waiting for the question.
    expect(stages(w)).toEqual([
      "locating",
      "locating",
      "authorizing",
      "awaiting_approval",
      "terminating",
      "terminating",
      "removing_devices",
      "unchanged",
    ]);
    expect(w.control.calls).toEqual([`state ${ID}`]);
    expect(records(w)[0]).toMatchObject({
      status: "succeeded",
      stages: [{ name: "terminate", status: "unchanged" }],
    });
  });

  test("a machine already being terminated: declining, or a wrong key, deletes no device", async () => {
    for (const answer of ["y", "yes", "builder-2", ""]) {
      const w = world({
        ...TERMINATING,
        inventory: { kind: "machines", machines: [machine(KEY, "shutting-down", ID)] },
        prompt: fakePrompt({ interactive: true, answers: [answer] }),
      });
      expect(await terminateWorker(w.deps, terminating(w, { confirm: undefined }))).toEqual({
        kind: "declined",
        terminating: ID,
        operation: expect.anything(),
        recordFailure: undefined,
      });
      expect(w.prompt.asked).toEqual([SHUTTING_DOWN_QUESTION]);
      expect(w.control.calls).toEqual([]);
      expect(w.admin.calls).toEqual(["open"]);
      expect(w.admin.devices().map((device) => device.id)).toEqual(["nWorker1CNTRL"]);
      expect(records(w)[0]).toMatchObject({ status: "declined" });
      expect(w.lockStore.locks.size).toBe(0);
    }
  });

  test("a machine already being terminated: --confirm KEY deletes its devices unasked", async () => {
    const w = world({
      ...TERMINATING,
      inventory: { kind: "machines", machines: [machine(KEY, "shutting-down", ID)] },
      states: ["terminated"],
      prompt: fakePrompt({ interactive: true }),
    });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
      kind: "done",
      awaited: true,
      devices: { removed: ["nWorker1CNTRL"] },
    });
    expect(w.prompt.asked).toEqual([]);
    expect(w.control.mutations()).toEqual([]);
  });

  test("a machine already being terminated: no terminal and no --confirm is refused before AWS", async () => {
    const w = world({
      ...TERMINATING,
      inventory: { kind: "machines", machines: [machine(KEY, "shutting-down", ID)] },
    });
    expect(await terminateWorker(w.deps, terminating(w, { confirm: undefined }))).toEqual({
      kind: "unconfirmable",
    });
    expect(w.identity.requests).toEqual([]);
    expect(w.control.calls).toEqual([]);
    expect(w.admin.calls).toEqual([]);
  });

  test("a pending or stopping machine is refused before EC2 is asked anything", async () => {
    for (const state of ["pending", "stopping"] as const) {
      const w = world({ inventory: { kind: "machines", machines: [machine(KEY, state, ID)] } });
      expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
        kind: "refused",
        refusal: { summary: `EC2 instance ${ID} is ${state}` },
      });
      expect(w.control.mutations()).toEqual([]);
      expect(w.admin.calls).toEqual([]);
    }
  });

  test("a failed TerminateInstances fails by error name, and no device is deleted", async () => {
    const w = world({
      ...TERMINATING,
      request: { kind: "failed", reason: "EC2 TerminateInstances failed: UnauthorizedOperation" },
    });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
      kind: "failed",
      refusal: {
        summary: "EC2 TerminateInstances failed: UnauthorizedOperation",
        nextAction: expect.stringContaining("ec2:TerminateInstances"),
      },
    });
    expect(w.admin.calls).toEqual(["open"]);
    expect(w.lockStore.locks.size).toBe(0);
  });
});

describe("terminate --keep with the machine already gone (worker-lifecycle §Terminate (keep))", () => {
  const GONE = { inventory: { kind: "machines", machines: [] }, view: OFFLINE } as const;

  test("no gates and no EC2 call: its tagged devices are deleted, and it succeeds unchanged", async () => {
    const w = world({
      ...GONE,
      admin: {
        devices: [
          tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG]),
          tailnetDevice("nOther1CNTRL", `${FACTORY}-builder-2`, [WORKER_TAG]),
        ],
      },
    });
    const result = await terminateWorker(w.deps, terminating(w));
    expect(result).toMatchObject({
      kind: "done",
      action: "terminate",
      instanceId: undefined,
      changed: false,
      awaited: false,
      devices: { kind: "listed", removed: ["nWorker1CNTRL"], failed: [], untagged: [] },
      leftover: undefined,
    });
    expect(result).not.toHaveProperty("removed");
    expect(w.control.calls).toEqual([]);
    expect(w.controlPlane.calls).toEqual([]);
    expect(w.transport.calls).toEqual([]);
    expect(w.tailnet.reads()).toBe(0);
    expect(calls(w)).toEqual([]);
    expect(w.store.writes).toEqual([]);
    expect(w.admin.calls).toEqual(["open", "devices", "remove nWorker1CNTRL"]);
    expect(w.admin.devices().map((device) => device.id)).toEqual(["nOther1CNTRL"]);
    expect(w.progress).toEqual([
      { kind: "absent", key: KEY, hostname: HOSTNAME },
      { kind: "removing_devices", hostname: HOSTNAME },
    ]);
    expect(stages(w)).toEqual(["locating", "authorizing", "removing_devices", "unchanged"]);
    expect(records(w)[0]).toMatchObject({
      operation: "worker-terminate",
      status: "succeeded",
      failure: null,
    });
    expect(records(w)[0]).not.toHaveProperty("machine");
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("a device it could not delete leaves it partial, naming the apply that follows", async () => {
    const w = world({
      ...GONE,
      admin: {
        devices: [tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG])],
        failing: { nWorker1CNTRL: "Tailscale answered HTTP 500" },
      },
    });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
      kind: "done",
      instanceId: undefined,
      leftover: {
        summary: `Not every Tailscale device named ${HOSTNAME} was deleted`,
        nextAction: expect.stringContaining("then run `fffactory apply`"),
      },
    });
    expect(records(w)[0]).toMatchObject({ status: "partial" });
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("at a terminal it asks for the host key before deleting anything; anything else declines", async () => {
    const w = world({ ...GONE, prompt: fakePrompt({ interactive: true, answers: ["yes"] }) });
    expect(await terminateWorker(w.deps, terminating(w, { confirm: undefined }))).toMatchObject({
      kind: "declined",
    });
    expect(w.prompt.asked).toEqual([
      `Delete the Tailscale devices of worker ${KEY} (${HOSTNAME})? No EC2 instance carries ` +
        "its key: its machine is already gone. Type the host key to confirm: ",
    ]);
    expect(w.admin.calls).toEqual(["open"]);
    expect(records(w)[0]).toMatchObject({ status: "declined" });
  });

  test("the admin client is still required, and still opened before anything is deleted", async () => {
    const w = world({ ...GONE, secretReadFails: new Error("AccessDeniedException") });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({ kind: "refused" });
    expect(w.admin.calls).toEqual([]);
    expect(records(w)[0]).toMatchObject({ status: "refused" });
  });

  test("an EC2 inventory that cannot be read is refused, never taken for a machine gone", async () => {
    const w = world({
      inventory: { kind: "unavailable", reason: "EC2 DescribeInstances failed: AccessDenied" },
    });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
      kind: "refused",
      refusal: { summary: "EC2 DescribeInstances failed: AccessDenied" },
    });
    expect(w.secrets.reads).toEqual([]);
    expect(w.admin.calls).toEqual([]);
  });

  test("an interrupted terminate --keep is finished by its rerun, which deletes the devices", async () => {
    let w: World | undefined;
    w = world({ ...TERMINATING, states: ["shutting-down"], onSleep: () => w?.interrupt() });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
      kind: "interrupted",
      requested: true,
    });
    expect(w.admin.devices().map((device) => device.id)).toEqual(["nWorker1CNTRL"]);
    // `fffactory lock break`; EC2 has since terminated the instance, which it no longer lists.
    w.lockStore.locks.clear();
    const rerun: WorkerLifecycleDependencies = {
      ...w.deps,
      interrupted: () => false,
      machines: fakeMachineInventory({ kind: "machines", machines: [] }).machines,
    };
    expect(await terminateWorker(rerun, terminating(w))).toMatchObject({
      kind: "done",
      instanceId: undefined,
      devices: { removed: ["nWorker1CNTRL"] },
      leftover: undefined,
    });
    expect(w.admin.devices()).toEqual([]);
    expect(w.lockStore.locks.size).toBe(0);
  });
});

describe("refusals before any mutation (worker-lifecycle §Terminate (keep))", () => {
  test("without the admin client, before anything reaches AWS", async () => {
    const w = world();
    expect(await terminateWorker(w.deps, terminating(w, { instance: declaring(KEY) }))).toEqual({
      kind: "refused",
      refusal: expect.objectContaining({
        summary: expect.stringContaining("tailscale.admin_client_secret"),
        nextAction: expect.stringContaining("`fffactory secret set tailscale-admin-client`"),
      }),
      operation: undefined,
    });
    expect(w.identity.requests).toEqual([]);
    expect(w.lockStore.calls).toEqual([]);
  });

  test("an undeclared key, another account, a pin mismatch and a held lock", async () => {
    const undeclared = world();
    expect(
      await terminateWorker(undeclared.deps, terminating(undeclared, { key: "builder-9" })),
    ).toMatchObject({ kind: "refused", operation: undefined });
    const other = world({
      caller: { kind: "caller", caller: { ...FAKE_CALLER, account: "999999999999" } },
    });
    expect(await terminateWorker(other.deps, terminating(other))).toMatchObject({
      kind: "account_refused",
    });
    const pinned = world();
    expect(
      await terminateWorker(pinned.deps, terminating(pinned, { release: "0.4.0" as Release })),
    ).toMatchObject({ kind: "release_mismatch" });
    const locked = world();
    const held = locked.lockStore.hold(
      BUCKET,
      newLockRecord({
        factoryId: FACTORY,
        operation: "apply",
        holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
        now: NOW,
        release: RELEASE,
        randomBytes: (count) => new Uint8Array(count).fill(5),
      }),
    );
    expect(await terminateWorker(locked.deps, terminating(locked))).toEqual({
      kind: "locked",
      held,
    });
    for (const w of [undeclared, other, pinned, locked]) {
      expect(w.control.mutations()).toEqual([]);
      expect(w.admin.calls).toEqual([]);
      expect(w.secrets.reads).toEqual([]);
    }
  });

  test("--confirm naming another key is refused before AWS, never echoing it", async () => {
    const w = world();
    const result = await terminateWorker(
      w.deps,
      terminating(w, { confirm: "AKIAIOSFODNN7EXAMPLE" }),
    );
    expect(result).toMatchObject({
      kind: "refused",
      refusal: { summary: `--confirm does not name the host ${KEY}` },
      operation: undefined,
    });
    expect(JSON.stringify(result)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(w.identity.requests).toEqual([]);
  });

  test("--yes does not confirm a terminate: without a terminal it needs --confirm", async () => {
    const w = world();
    expect(
      await terminateWorker(w.deps, terminating(w, { confirm: undefined, yes: true })),
    ).toEqual({ kind: "unconfirmable" });
    expect(w.identity.requests).toEqual([]);
  });

  test("at a terminal the host key must be typed: anything else declines, changing nothing", async () => {
    for (const answer of ["y", "yes", "builder-2", ""]) {
      const w = world({
        ...TERMINATING,
        prompt: fakePrompt({ interactive: true, answers: [answer] }),
      });
      expect(await terminateWorker(w.deps, terminating(w, { confirm: undefined }))).toMatchObject({
        kind: "declined",
      });
      expect(w.prompt.asked).toEqual([
        `Terminate worker ${KEY} (${HOSTNAME}), EC2 instance ${ID}? Its machine and root ` +
          "volume are destroyed. Type the host key to confirm: ",
      ]);
      expect(w.control.mutations()).toEqual([]);
      expect(w.admin.calls).toEqual(["open"]);
      expect(records(w)[0]).toMatchObject({ status: "declined" });
    }
    const typed = world({
      ...TERMINATING,
      prompt: fakePrompt({ interactive: true, answers: [KEY] }),
    });
    expect(
      await terminateWorker(typed.deps, terminating(typed, { confirm: undefined })),
    ).toMatchObject({
      kind: "done",
    });
    expect(typed.control.mutations()).toEqual([`terminate ${ID}`]);
  });

  test("an admin client secret that cannot be read, or that Tailscale refuses, refuses the terminate", async () => {
    const unreadable = world({
      ...TERMINATING,
      secretReadFails: new Error(
        "Reading the secret from Secrets Manager failed: AccessDeniedException",
      ),
    });
    expect(await terminateWorker(unreadable.deps, terminating(unreadable))).toMatchObject({
      kind: "refused",
      refusal: {
        summary: "Reading the secret from Secrets Manager failed: AccessDeniedException",
        nextAction: expect.stringContaining("secretsmanager:GetSecretValue"),
      },
    });
    const refused = world({
      ...TERMINATING,
      admin: { open: { kind: "failed", reason: "Tailscale refused the admin client (HTTP 401)" } },
    });
    expect(await terminateWorker(refused.deps, terminating(refused))).toMatchObject({
      kind: "refused",
      refusal: {
        summary:
          "The Tailscale admin client could not be used: Tailscale refused the admin client (HTTP 401)",
      },
    });
    for (const w of [unreadable, refused]) {
      expect(w.control.mutations()).toEqual([]);
      expect(records(w)[0]).toMatchObject({ status: "refused" });
      expect(w.lockStore.locks.size).toBe(0);
    }
  });
});

describe("terminate's gates (worker-lifecycle §Gates (terminate))", () => {
  test("active agents, unresolved or unmanaged checkouts, or a worker it cannot inspect refuse it", async () => {
    const cases: WorldOptions[] = [
      { activity: { kind: "active", count: 1 }, worker: CLEAN },
      { worker: statusAnswers(readyWorker(FACTORY, KEY, RELEASE), "unresolved") },
      { worker: statusAnswers(readyWorker(FACTORY, KEY, RELEASE), "synchronized", ["acme/old"]) },
      { worker: statusAnswers(readyWorker(FACTORY, KEY, RELEASE), "unreadable") },
      { worker: { kind: "unreachable", reason: "the connection timed out" } },
      { view: OFFLINE },
      { noControlPlane: true, worker: CLEAN },
    ];
    for (const options of cases) {
      const w = world({ ...TERMINATING, ...options });
      const result = await terminateWorker(w.deps, terminating(w));
      expect(result).toMatchObject({ kind: "refused" });
      expect(w.control.mutations()).toEqual([]);
      expect(w.admin.calls).toEqual([]);
      expect(records(w)[0]).toMatchObject({
        status: "refused",
        stages: [{ name: "terminate", status: "refused" }],
      });
    }
  });

  test("--force overrides them, never the confirmation, the lock or the record", async () => {
    for (const options of [
      { activity: { kind: "active", count: 3 } as const },
      { view: OFFLINE },
      { worker: statusAnswers(readyWorker(FACTORY, KEY, RELEASE), "unresolved") },
    ]) {
      const w = world({ ...TERMINATING, ...options });
      expect(await terminateWorker(w.deps, terminating(w, { force: true }))).toMatchObject({
        kind: "done",
        changed: true,
      });
      expect(w.controlPlane.calls).toEqual([]);
      expect(w.transport.calls).toEqual([]);
      expect(w.progress).toContainEqual({ kind: "forced", action: "terminate" });
      expect(records(w)[0]).toMatchObject({ status: "succeeded" });
    }
  });
});

/** builder-1's placed checkout, in step with its remote but for `overrides` of its worktree. */
function widget(overrides: Partial<RepositoryWork["worktrees"][number]> = {}): RepositoryWork {
  return {
    path: "/workspace/repos/acme/widget",
    state: "inspected",
    unpushed_commits: 0,
    unpushed_branches: [],
    stashes: 0,
    worktrees: [
      {
        path: "/workspace/repos/acme/widget",
        branch: "main",
        state: "inspected",
        tracked_changes: 0,
        untracked_files: 0,
        unpushed_commits: 0,
        operation: null,
        ...overrides,
      },
    ],
  };
}

/** builder-1 synchronized at its last apply, whose work inspection answers `work`. */
function synchronizedButAnswering(work: HostCommandOutcome): Answer {
  return statusAnswers(readyWorker(FACTORY, KEY, RELEASE), "synchronized", [], undefined, work);
}

/** The reviewer's worker: synchronized, then `?? uncommitted-work.txt` in its checkout. */
const DIRTIED_SINCE = synchronizedButAnswering(
  workAnswer(HOSTNAME, [widget({ untracked_files: 1 })]),
);

describe("terminate's work inspection (worker-lifecycle §Gates (terminate))", () => {
  test("work made after the last synchronization refuses it without --force", async () => {
    for (const command of ["keep", "remove"] as const) {
      const w = world({ ...TERMINATING, worker: DIRTIED_SINCE });
      const result = await terminateWorker(
        w.deps,
        command === "keep" ? terminating(w) : removing(w),
      );
      expect(result).toMatchObject({
        kind: "refused",
        refusal: {
          summary: `${HOSTNAME} holds work not pushed to any remote: terminating it would lose it`,
          details: ["/workspace/repos/acme/widget (branch main): 1 untracked file"],
        },
      });
      expect(w.control.mutations()).toEqual([]);
      expect(w.terraform.calls).toEqual([]);
      expect(w.admin.calls).toEqual([]);
      expect(records(w)[0]).toMatchObject({ status: "refused" });
    }
  });

  test("--force terminates it all the same, uninspected", async () => {
    const w = world({ ...TERMINATING, worker: DIRTIED_SINCE });
    expect(await terminateWorker(w.deps, terminating(w, { force: true }))).toMatchObject({
      kind: "done",
      changed: true,
    });
    expect(w.transport.calls).toEqual([]);
    expect(w.control.mutations()).toEqual([`terminate ${ID}`]);
  });

  test("work that cannot be inspected refuses it: an older activator, a timeout, a malformed answer", async () => {
    const cases: [HostCommandOutcome, string][] = [
      [
        { kind: "completed", exitCode: 64, stdout: "" },
        `${HOSTNAME} could not be inspected for unpushed work: its activator predates the work inspection`,
      ],
      [
        { kind: "timed_out" },
        `${HOSTNAME} could not be inspected for unpushed work: no answer within 2 min`,
      ],
      [
        { kind: "completed", exitCode: 0, stdout: "{}" },
        `${HOSTNAME} could not be inspected for unpushed work: its answer is not a work inspection: protocol_version must be an integer`,
      ],
      [
        workAnswer(HOSTNAME, [widget({ state: "unreadable" })]),
        `${HOSTNAME} could not be fully inspected for unpushed work`,
      ],
    ];
    for (const [answer, summary] of cases) {
      const w = world({ ...TERMINATING, worker: synchronizedButAnswering(answer) });
      expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
        kind: "refused",
        refusal: { summary },
      });
      expect(w.control.mutations()).toEqual([]);
    }
  });

  test("clean, pushed checkouts and worktrees let it go on", async () => {
    const w = world({
      ...TERMINATING,
      worker: synchronizedButAnswering(workAnswer(HOSTNAME, [widget()])),
    });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({ kind: "done" });
  });

  test("is asked only once the activator is free: after the agent activity has been read", async () => {
    const w = world({ ...TERMINATING, worker: CLEAN });
    const order: string[] = [];
    const answer = CLEAN as Exclude<Answer, HostCommandOutcome>;
    const deps: WorkerLifecycleDependencies = {
      ...w.deps,
      controlPlane: {
        ...w.controlPlane.controlPlane,
        activeAgents: async () => {
          order.push("activity started");
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push("activity read");
          return { kind: "idle" };
        },
      },
      transport: {
        run: async (worker, command, options) => {
          order.push(command.includes("work") ? "work" : "repositories");
          return w.transport.transport
            .run(worker, command, options)
            .then(() => answer(command, undefined));
        },
      },
    };
    expect(await terminateWorker(deps, terminating(w))).toMatchObject({ kind: "done" });
    expect(order.indexOf("work")).toBeGreaterThan(order.indexOf("activity read"));
  });

  test("is never asked while the agent activity already refuses: the activator stays free", async () => {
    const cases: [Partial<WorldOptions>, string][] = [
      [
        { activity: { kind: "active", count: 1 } },
        `1 agent is active on ${HOSTNAME}: terminating it would end it`,
      ],
      [
        { noControlPlane: true },
        `${HOSTNAME} could not be inspected for active agents: this fffactory cannot reach the worker's control plane`,
      ],
    ];
    for (const [options, summary] of cases) {
      const w = world({ ...TERMINATING, worker: DIRTIED_SINCE, ...options });
      expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
        kind: "refused",
        refusal: { summary },
      });
      expect(w.transport.calls.map(({ command }) => command.join(" "))).toEqual([
        expect.stringContaining("repositories"),
      ]);
      expect(w.control.mutations()).toEqual([]);
    }
  });

  test("a checkout factory.json places on it that the inspection does not report refuses it", async () => {
    // Deeper than the worker looks, its work would otherwise read as no work at all.
    const placing = (path: string): FactoryInstance => {
      const instance = withAdmin();
      return {
        ...instance,
        repositories: [
          { key: "deep", remote: "https://github.com/acme/deep", path, branch: "main" },
        ],
        hosts: (instance.hosts ?? []).map((host) =>
          host.key === KEY ? { ...host, repositories: ["deep"] } : host,
        ),
      };
    };
    const answering = synchronizedButAnswering(workAnswer(HOSTNAME, [widget()]));
    const w = world({ ...TERMINATING, worker: answering });
    expect(
      await terminateWorker(w.deps, terminating(w, { instance: placing("a/b/c/d/e") })),
    ).toMatchObject({
      kind: "refused",
      refusal: {
        summary: `${HOSTNAME} could not be fully inspected for unpushed work`,
        details: [
          "/workspace/repos/a/b/c/d/e: placed on this worker, but the work inspection did not report it",
        ],
      },
    });
    expect(w.control.mutations()).toEqual([]);
    const reported = world({ ...TERMINATING, worker: answering });
    expect(
      await terminateWorker(
        reported.deps,
        terminating(reported, { instance: placing("acme/widget") }),
      ),
    ).toMatchObject({ kind: "done" });
  });

  test("an interrupt while the worker is inspected asks it nothing more", async () => {
    const w = world({ ...TERMINATING, worker: CLEAN });
    const answer = CLEAN as Exclude<Answer, HostCommandOutcome>;
    const deps: WorkerLifecycleDependencies = {
      ...w.deps,
      transport: {
        run: async (worker, command, options) => {
          w.interrupt();
          return w.transport.transport
            .run(worker, command, options)
            .then(() => answer(command, undefined));
        },
      },
    };
    expect(await terminateWorker(deps, terminating(w))).toMatchObject({ kind: "interrupted" });
    expect(w.transport.calls.map(({ command }) => command.join(" "))).toEqual([
      expect.stringContaining("repositories"),
    ]);
    expect(w.control.mutations()).toEqual([]);
  });
});

describe("tailnet device removal (worker-lifecycle §Tailnet device removal)", () => {
  test("only tagged devices with the worker's hostname are deleted; an untagged one is reported", async () => {
    const w = world({
      ...TERMINATING,
      admin: {
        devices: [
          tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG]),
          tailnetDevice(
            "nStale1CNTRL",
            HOSTNAME,
            [WORKER_TAG],
            `${HOSTNAME}-1.example-tailnet.ts.net`,
          ),
          tailnetDevice("nIntruder1CNTRL", HOSTNAME, ["tag:other"]),
          tailnetDevice("nSuffix1CNTRL", `${HOSTNAME}-1`, [WORKER_TAG]),
        ],
      },
    });
    const result = await terminateWorker(w.deps, terminating(w));
    expect(result).toMatchObject({
      kind: "done",
      devices: {
        kind: "listed",
        removed: ["nWorker1CNTRL", "nStale1CNTRL"],
        failed: [],
        untagged: ["nIntruder1CNTRL"],
      },
      leftover: { summary: `Not every Tailscale device named ${HOSTNAME} was deleted` },
    });
    expect(w.admin.calls).toEqual([
      "open",
      "devices",
      "remove nWorker1CNTRL",
      "remove nStale1CNTRL",
    ]);
    expect(JSON.stringify(result)).not.toContain("tag:other");
    expect(records(w)[0]).toMatchObject({
      status: "partial",
      stages: [{ name: "terminate", status: "partial" }],
      failure: `Not every Tailscale device named ${HOSTNAME} was deleted`,
    });
  });

  test("a device that could not be deleted, or a listing that failed, leaves the terminate partial", async () => {
    const failing = world({
      ...TERMINATING,
      admin: {
        devices: [tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG])],
        failing: { nWorker1CNTRL: "Tailscale answered HTTP 500" },
      },
    });
    expect(await terminateWorker(failing.deps, terminating(failing))).toMatchObject({
      kind: "done",
      changed: true,
      devices: { failed: [{ id: "nWorker1CNTRL", reason: "Tailscale answered HTTP 500" }] },
      leftover: { details: ["Deleting device nWorker1CNTRL failed: Tailscale answered HTTP 500"] },
    });
    const unlisted = world({
      ...TERMINATING,
      admin: { listing: { kind: "failed", reason: "Tailscale answered HTTP 503" } },
    });
    expect(await terminateWorker(unlisted.deps, terminating(unlisted))).toMatchObject({
      kind: "done",
      devices: { kind: "unlisted" },
      leftover: {
        summary: "The tailnet's devices could not be listed: Tailscale answered HTTP 503",
      },
    });
    for (const w of [failing, unlisted]) {
      expect(w.control.mutations()).toEqual([`terminate ${ID}`]);
      expect(records(w)[0]).toMatchObject({ status: "partial" });
      expect(w.lockStore.locks.size).toBe(0);
    }
  });

  test("no device with the name is nothing to delete, and complete", async () => {
    const w = world({ ...TERMINATING, admin: { devices: [] } });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
      kind: "done",
      devices: { kind: "listed", removed: [], failed: [], untagged: [] },
      leftover: undefined,
    });
  });
});

describe("after terminate --keep (worker-lifecycle §Terminate (keep))", () => {
  test("status reports the host not provisioned, and factory.json still declares it", async () => {
    let terminated = false;
    const w = world(TERMINATING);
    const instance = withAdmin();
    const machines = {
      ...w.deps.machines,
      list: async () =>
        ({
          kind: "machines",
          machines: terminated ? [] : [machine(KEY, "running", ID)],
        }) as const,
    };
    const deps: WorkerLifecycleDependencies = {
      ...w.deps,
      machines,
      control: {
        ...w.deps.control,
        terminate: async (target) => {
          terminated = true;
          return w.deps.control.terminate(target);
        },
      },
    };
    expect(await terminateWorker(deps, terminating(w, { instance }))).toMatchObject({
      kind: "done",
    });
    expect(instance.hosts?.map((host): string => host.key)).toEqual([KEY, "builder-2"]);
    const status = await factoryStatus(
      {
        identity: w.deps.identity,
        machines,
        peers: w.deps.peers,
        transport: w.deps.transport,
        sha256: sha256Text,
      },
      { instance, credentials: { source: "chain" } },
    );
    expect(status.kind === "report" && status.report.workers[0]).toMatchObject({
      key: KEY,
      status: "not_ready",
      summary: "Not provisioned: no EC2 instance carries this host key",
    });
  });
});

describe("terminate's interruption (worker-lifecycle §Interruption)", () => {
  test("during the wait for terminated: the lock and the record stay, and no device is deleted", async () => {
    let w: World | undefined;
    w = world({ ...TERMINATING, states: ["shutting-down"], onSleep: () => w?.interrupt() });
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
      kind: "interrupted",
      locked: true,
      requested: true,
    });
    expect(w.admin.calls).toEqual(["open"]);
    expect(w.lockStore.locks.size).toBe(1);
    expect(records(w)[0]).toMatchObject({
      status: "running",
      stages: [{ name: "terminate", status: "terminating" }],
    });
  });

  test("between two device deletions: nothing more is deleted", async () => {
    let w: World | undefined;
    w = world({
      ...TERMINATING,
      admin: {
        devices: [
          tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG]),
          tailnetDevice("nStale1CNTRL", HOSTNAME, [WORKER_TAG]),
        ],
      },
    });
    const remove = w.deps.tailnetAdmin.open;
    w.deps = {
      ...w.deps,
      tailnetAdmin: {
        open: async (secret) => {
          const opening = await remove(secret);
          if (opening.kind !== "open") return opening;
          return {
            kind: "open",
            session: {
              ...opening.session,
              remove: async (id) => {
                const removed = await opening.session.remove(id);
                w?.interrupt();
                return removed;
              },
            },
          };
        },
      },
    };
    expect(await terminateWorker(w.deps, terminating(w))).toMatchObject({
      kind: "interrupted",
      locked: true,
    });
    expect(w.admin.calls.filter((call) => call.startsWith("remove"))).toEqual([
      "remove nWorker1CNTRL",
    ]);
  });
});

/** factory.json as terminate writes it: `withAdmin()` without builder-1. */
const WITHOUT_KEY = serializeInstance(withoutHost(withAdmin(), KEY as HostKey));
const calls = (w: World) => w.terraform.calls.map(({ call }) => call);

/** A Paseo password reference of the only host. */
const PASEO_ONLY = paseoPassword("paseo-password-builder-1");

/**
 * factory.json declaring builder-1 alone, with its own Paseo password, a repository placed on
 * it and dispatch requested there: the standard single-worker factory.
 */
function onlyHost(): FactoryInstance {
  const both = withAdmin();
  const [host] = both.hosts ?? [];
  if (host === undefined) throw new Error("withAdmin declares builder-1");
  return {
    ...both,
    repositories: [
      {
        key: "widget",
        remote: "https://github.com/acme/widget",
        path: "acme/widget",
        branch: "main",
      },
    ],
    hosts: [
      {
        ...host,
        paseo_password_secret: PASEO_ONLY,
        repositories: ["widget"],
        dispatch: { enabled: false },
      },
    ],
  };
}

/** builder-1 with nothing unpushed in the one checkout placed on it. */
const CLEAN_PLACED = () => synchronizedButAnswering(workAnswer(HOSTNAME, [widget()]));

/** A world whose only host terminate has removed: an empty factory. */
async function emptied(): Promise<World> {
  const only = onlyHost();
  const w = world({
    worker: CLEAN_PLACED(),
    provisioned: [KEY],
    configuration: serializeInstance(only),
  });
  const result = await terminateWorker(w.deps, removing(w, { instance: only }));
  if (result.kind !== "done") throw new Error(`expected done, got ${result.kind}`);
  return w;
}

/** What plan reaches in `w`: its Terraform, state bucket and plan store, and no machine. */
function planPorts(w: World) {
  return {
    lockStore: w.lockStore,
    provisioner: w.terraform.provisioner,
    planStore: w.planStore,
    machines: fakeMachineInventory({ kind: "machines", machines: [] }).machines,
    peers: w.deps.peers,
    transport: w.deps.transport,
    sha256: sha256Text,
  };
}

function emptyPlanRequest(instance: FactoryInstance) {
  return {
    account: { allowed: true, verdict: { kind: "match", caller: FAKE_CALLER } } as const,
    instancePath: PATH,
    instance,
    configurationSha256: "a".repeat(64),
    credentials: { source: "chain" } as const,
    release: RELEASE,
    assetsSha256: "b".repeat(64),
    terraformDirectory: TERRAFORM,
    randomBytes: (count: number) => new Uint8Array(count),
  };
}

describe("fffactory worker terminate (worker-lifecycle §Terminate (remove))", () => {
  test("destroys the machine with a scoped Terraform plan, writes factory.json without the host and deletes its device, under one lock and record", async () => {
    const w = world({ worker: CLEAN });
    const result = await terminateWorker(w.deps, removing(w));
    expect(result).toMatchObject({
      kind: "done",
      action: "terminate",
      worker: { key: KEY, hostname: HOSTNAME },
      instanceId: ID,
      changed: true,
      removed: true,
      devices: { kind: "listed", removed: ["nWorker1CNTRL"], failed: [], untagged: [] },
      leftover: undefined,
    });
    // Terraform plans factory.json without the host, under its own state lock, then applies
    // exactly that plan file, and checks its state no longer records the key; EC2 is never
    // asked to terminate anything directly.
    expect(calls(w)).toEqual(["output", "plan", "showPlan", "applyPlan", "output"]);
    const [, plan, shown, applied] = w.terraform.calls;
    expect(plan?.call === "plan" && plan.request.stateLock).toBe(true);
    expect(plan?.call === "plan" && Object.keys(plan.request.variables.hosts as object)).toEqual([
      "builder-2",
    ]);
    expect(plan?.request.configuration).toEqual({ directory: TERRAFORM, root: "factory" });
    expect(shown?.request).toEqual(applied?.request);
    expect(applied?.call === "applyPlan" && applied.request.planFile).toMatch(/factory\.tfplan$/);
    expect(w.control.mutations()).toEqual([]);
    expect([...w.terraform.world.hosts]).toEqual(["builder-2"]);
    expect(w.store.files[PATH]).toBe(WITHOUT_KEY);
    expect(w.store.writes).toEqual([PATH]);
    expect(w.admin.calls).toEqual(["open", "devices", "remove nWorker1CNTRL"]);
    expect(w.planStore.directories.size).toBe(0);
    expect(w.materialized()).toBe(1);
    expect(w.lockStore.locks.size).toBe(0);
    expect(records(w)).toHaveLength(1);
    expect(records(w)[0]).toMatchObject({
      operation: "worker-terminate",
      status: "succeeded",
      stages: [{ name: "terminate", status: "removed" }],
      machine: { key: KEY, hostname: HOSTNAME, instance_id: ID, state: "terminated" },
      failure: null,
    });
    expect(stages(w)).toEqual([
      "locating",
      "locating",
      "inspecting",
      "authorizing",
      "planning",
      "applying",
      "applying",
      "writing",
      "removing_devices",
      "removed",
    ]);
    expect(w.progress).toEqual([
      { kind: "located", key: KEY, hostname: HOSTNAME, instanceId: ID, state: "running" },
      { kind: "planning_removal", key: KEY },
      {
        kind: "removal_plan",
        target: {
          instancePath: PATH,
          name: "Test factory",
          factoryId: FACTORY,
          accountId: "123456789012",
          region: "eu-west-2",
          release: RELEASE,
        },
        changes: [
          {
            address: `module.hosts.aws_instance.host["${KEY}"]`,
            type: "aws_instance",
            actions: ["delete"],
          },
        ],
        worker: { key: KEY, hostname: HOSTNAME },
      },
      { kind: "applying_removal" },
      { kind: "configuration_written", key: KEY, path: PATH },
      { kind: "removing_devices", hostname: HOSTNAME },
    ]);
  });

  test("afterwards plan shows no changes for the host, and status no longer lists it", async () => {
    const w = world({ worker: CLEAN });
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({ kind: "done" });
    const instance = JSON.parse(w.store.files[PATH] as string) as FactoryInstance;
    const location = stateBucketOf(instance, { source: "chain" });
    if (!location.ok) throw new Error("factory.json has no state bucket");
    const planned = await planInfrastructure(w.deps, {
      instance,
      bucket: location.bucket,
      terraformDirectory: TERRAFORM,
      planFile: "/plans/after/factory.tfplan",
      underFactoryLock: false,
      resizeGuard: { inventory: "read", workers: [] },
    });
    expect(planned).toMatchObject({ kind: "planned", changes: [] });
    const status = await factoryStatus(
      {
        identity: w.deps.identity,
        machines: fakeMachineInventory({ kind: "machines", machines: [] }).machines,
        peers: w.deps.peers,
        transport: w.deps.transport,
        sha256: sha256Text,
      },
      { instance, credentials: { source: "chain" } },
    );
    expect(status.kind === "report" && status.report.workers.map(({ key }): string => key)).toEqual(
      ["builder-2"],
    );
  });

  test("a plan with any other change is refused before the question, and nothing is applied", async () => {
    const pending = withAdmin();
    const instance = {
      ...pending,
      hosts: [...(pending.hosts ?? []), { ...(pending.hosts ?? [])[1], key: "builder-3" }],
    } as FactoryInstance;
    const w = world({ worker: CLEAN, prompt: fakePrompt({ interactive: true }) });
    const result = await terminateWorker(w.deps, removing(w, { instance, confirm: undefined }));
    expect(result).toMatchObject({
      kind: "refused",
      refusal: {
        summary: `The removal plan changes more than host ${KEY}'s machine: apply factory.json's other changes first`,
        details: ['module.hosts.aws_instance.host["builder-3"] would be created'],
      },
    });
    expect(w.prompt.asked).toEqual([]);
    expect(calls(w)).toEqual(["output", "plan", "showPlan"]);
    expect([...w.terraform.world.hosts]).toEqual([KEY, "builder-2"]);
    expect(w.store.writes).toEqual([]);
    expect(w.admin.calls).toEqual(["open"]);
    expect(w.lockStore.locks.size).toBe(0);
    expect(records(w)[0]).toMatchObject({ status: "refused" });
  });

  test("the last host is removed like any other, leaving an empty factory with its shared infrastructure", async () => {
    const only = onlyHost();
    const w = world({
      worker: CLEAN_PLACED(),
      provisioned: [KEY],
      configuration: serializeInstance(only),
      secretArns: [AUTH, PASEO_ONLY],
    });
    const result = await terminateWorker(w.deps, removing(w, { instance: only }));
    expect(result).toMatchObject({
      kind: "done",
      removed: true,
      devices: { kind: "listed", removed: ["nWorker1CNTRL"] },
    });
    // The scoped plan destroys the machine and leaves the hosts' policy the auth key alone.
    expect(calls(w)).toEqual(["output", "plan", "showPlan", "applyPlan", "output"]);
    const [, plan] = w.terraform.calls;
    expect(plan?.call === "plan" && plan.request.variables).toMatchObject({
      hosts: {},
      paseo_password_secret_arns: {},
    });
    expect([...w.terraform.world.hosts]).toEqual([]);
    expect(w.terraform.world.network).toBe(true);
    expect(w.terraform.world.secretArns).toEqual([AUTH]);
    expect(w.store.files[PATH]).toBe(serializeInstance(withoutHost(only, KEY as HostKey)));
    const written = JSON.parse(w.store.files[PATH] as string) as FactoryInstance;
    expect(written.hosts).toEqual([]);
    expect(written.repositories).toEqual(only.repositories);
    expect(parseFactoryInstance(written).valid).toBe(true);
    expect(assessCompleteness(written)).toEqual({ complete: true, missing: [] });
    expect(w.lockStore.locks.size).toBe(0);
    expect(records(w)[0]).toMatchObject({ status: "succeeded" });
  });

  test("an empty factory plans no hosts and no changes, and status lists no worker", async () => {
    const w = await emptied();
    const instance = JSON.parse(w.store.files[PATH] as string) as FactoryInstance;
    const planned = await planFactory(planPorts(w), {
      ...emptyPlanRequest(instance),
      now: NOW,
    });
    if (planned.kind !== "planned") throw new Error(`expected planned, got ${planned.kind}`);
    expect(planned.review).toMatchObject({
      kind: "factory",
      changes: [],
      workers: [],
      repositories: [],
      controlPlane: [],
      dispatch: [],
      stopped: [],
    });
    expect(planned.saved.changes).toEqual([]);
    const status = await factoryStatus(
      {
        identity: w.deps.identity,
        machines: fakeMachineInventory({ kind: "machines", machines: [] }).machines,
        peers: w.deps.peers,
        transport: w.deps.transport,
        sha256: sha256Text,
      },
      { instance, credentials: { source: "chain" } },
    );
    expect(status).toMatchObject({ kind: "report", report: { status: "ready", workers: [] } });
  });

  for (const key of ["builder-3", KEY])
    test(`a replacement declared afterwards (${key}) is a plain create of its own instance type, never D11`, async () => {
      const w = await emptied();
      const empty = JSON.parse(w.store.files[PATH] as string) as FactoryInstance;
      const instance: FactoryInstance = {
        ...empty,
        hosts: [{ key: key as HostKey, instance_type: "m7i.2xlarge", root_volume_gib: 128 }],
      };
      const fleet = workerFleet([key]);
      const approvals: PlanReview[] = [];
      const result = await applyFactory(
        {
          ...fleet.deps,
          lockStore: w.lockStore,
          provisioner: w.terraform.provisioner,
          planStore: w.planStore,
          approval: {
            approve: async (review) => {
              approvals.push(review);
              return true;
            },
          },
          interrupted: () => false,
        },
        { ...emptyPlanRequest(instance), host: "operator-laptop", clock: () => NOW },
      );
      expect(result).toMatchObject({ kind: "applied", infrastructure: "applied" });
      expect(result.kind === "applied" && result.workers.map((w) => `${w.key} ${w.kind}`)).toEqual([
        `${key} installed`,
      ]);
      const [approved] = approvals;
      if (approved?.kind !== "factory") throw new Error("expected a factory plan review");
      expect(approved.changes).toContainEqual(
        expect.objectContaining({
          address: `module.hosts.aws_instance.host["${key}"]`,
          actions: ["create"],
        }),
      );
      expect(changeTally(approved.changes)).toMatchObject({ add: 1, change: 0, destroy: 0 });
      const plans = w.terraform.calls.filter((call) => call.call === "plan");
      expect(plans.at(-1)?.request.variables.hosts).toEqual({
        [key]: { instance_type: "m7i.2xlarge", root_volume_gib: 128 },
      });
      expect([...w.terraform.world.hosts]).toEqual([key]);
    });

  test("the host key is typed after the plan is shown; anything else declines, applying nothing", async () => {
    const w = world({ worker: CLEAN, prompt: fakePrompt({ interactive: true, answers: ["yes"] }) });
    // One log of what the operator sees, in order: progress by kind, and the question.
    const seen: string[] = [];
    const { progress, prompt } = w.deps;
    w.deps = {
      ...w.deps,
      progress: (event) => {
        seen.push(event.kind);
        progress(event);
      },
      prompt: {
        ...prompt,
        ask: (question) => {
          seen.push("question");
          return prompt.ask(question);
        },
      },
    };
    expect(await terminateWorker(w.deps, removing(w, { confirm: undefined }))).toMatchObject({
      kind: "declined",
    });
    expect(w.prompt.asked).toEqual([
      `Terminate worker ${KEY} (${HOSTNAME}), EC2 instance ${ID}, and remove it from ` +
        "factory.json? Its machine and root volume are destroyed. Type the host key to confirm: ",
    ]);
    expect(seen).toEqual(["located", "planning_removal", "removal_plan", "question"]);
    expect(calls(w)).toEqual(["output", "plan", "showPlan"]);
    expect(w.store.writes).toEqual([]);
    expect(records(w)[0]).toMatchObject({ status: "declined" });
    const typed = world({
      worker: CLEAN,
      prompt: fakePrompt({ interactive: true, answers: [` ${KEY}\n`] }),
    });
    expect(
      await terminateWorker(typed.deps, removing(typed, { confirm: undefined })),
    ).toMatchObject({ kind: "done", removed: true });
  });

  test("factory.json changed after it was read: nothing is applied", async () => {
    const w = world({ worker: CLEAN, configuration: `${serializeInstance(withAdmin())} ` });
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "refused",
      refusal: {
        summary: "factory.json changed after fffactory read it: nothing was applied",
      },
    });
    expect(calls(w)).not.toContain("applyPlan");
    expect(w.store.writes).toEqual([]);
  });

  test("recorded keys that cannot be read, another host removed by hand, or an unreadable factory.json refuse it", async () => {
    const garbled = world({ worker: CLEAN });
    garbled.terraform.world.outputs = { host_keys: "builder-1" };
    expect(await terminateWorker(garbled.deps, removing(garbled))).toMatchObject({
      kind: "refused",
      refusal: { summary: "The factory's Terraform state records host keys that cannot be read" },
    });
    const handEdited = world({ worker: CLEAN, provisioned: [KEY, "builder-2", "builder-3"] });
    expect(await terminateWorker(handEdited.deps, removing(handEdited))).toMatchObject({
      kind: "refused",
      refusal: {
        summary: `factory.json without host ${KEY} cannot be planned`,
        details: [expect.stringContaining('host key "builder-3" is provisioned')],
      },
    });
    const unreadable = world({ worker: CLEAN });
    unreadable.store.read = async () => {
      throw new Error("EIO: i/o error");
    };
    expect(await terminateWorker(unreadable.deps, removing(unreadable))).toMatchObject({
      kind: "refused",
      refusal: {
        summary: "factory.json could not be read again (EIO: i/o error): nothing was applied",
      },
    });
    for (const w of [garbled, handEdited, unreadable]) {
      expect(calls(w)).not.toContain("applyPlan");
      expect(w.store.writes).toEqual([]);
    }
  });

  test("a failed Terraform plan or apply leaves factory.json untouched, keeping Terraform's diagnostics", async () => {
    const planning = world({ worker: CLEAN });
    planning.deps = {
      ...planning.deps,
      provisioner: {
        ...planning.deps.provisioner,
        plan: async () => {
          throw new ProvisioningFailed("`terraform plan` exited with status 1", "/diag/plan.log");
        },
      },
    };
    expect(await terminateWorker(planning.deps, removing(planning))).toMatchObject({
      kind: "failed",
      refusal: {
        summary: "Planning the removal failed: `terraform plan` exited with status 1",
        nextAction: `Rerun \`fffactory worker terminate ${KEY}\`.`,
      },
      diagnosticsFile: "/diag/plan.log",
    });
    expect(planning.planStore.directories.size).toBe(0);
    const applying = world({ worker: CLEAN });
    applying.deps = {
      ...applying.deps,
      provisioner: {
        ...applying.deps.provisioner,
        applyPlan: async () => {
          throw new ProvisioningFailed("`terraform apply` exited with status 1", "/diag/apply.log");
        },
      },
    };
    const result = await terminateWorker(applying.deps, removing(applying));
    expect(result).toMatchObject({
      kind: "failed",
      refusal: {
        summary: "Removing the host failed: `terraform apply` exited with status 1",
        details: [expect.stringContaining(`it still declares host ${KEY}`)],
      },
      diagnosticsFile: "/diag/apply.log",
    });
    for (const w of [planning, applying]) {
      expect(w.store.writes).toEqual([]);
      expect(w.admin.calls).toEqual(["open"]);
      expect(w.lockStore.locks.size).toBe(0);
      expect(records(w)[0]).toMatchObject({ status: "failed" });
      expect(JSON.stringify(records(w)[0])).not.toContain("/diag/");
    }
  });

  test("factory.json that cannot be written after Terraform removed the host says exactly what to remove; a rerun finishes", async () => {
    const w = world({ worker: CLEAN });
    const write = w.store.write.bind(w.store);
    w.store.write = async () => {
      throw new Error("EACCES: permission denied");
    };
    const summary =
      `Terraform destroyed host ${KEY}'s machine and no longer records it, but factory.json ` +
      "could not be written (EACCES: permission denied): it still declares the host";
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "failed",
      refusal: {
        summary,
        nextAction: expect.stringContaining(`Remove the host ${KEY} from hosts in ${PATH}`),
      },
    });
    expect([...w.terraform.world.hosts]).toEqual(["builder-2"]);
    expect(w.admin.calls).toEqual(["open"]);
    expect(records(w)[0]).toMatchObject({ status: "failed", failure: summary });
    expect(w.lockStore.locks.size).toBe(0);

    // The rerun finds no machine, plans nothing to destroy, writes factory.json and deletes the device.
    w.store.write = write;
    w.inventory.machines.list = async () => ({ kind: "machines", machines: [] });
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "done",
      instanceId: undefined,
      removed: true,
      devices: { removed: ["nWorker1CNTRL"] },
    });
    expect(w.store.files[PATH]).toBe(WITHOUT_KEY);
  });

  test("an error once factory.json no longer declares the host names the devices to remove, never a rerun", async () => {
    const w = world({ worker: CLEAN });
    const writeOperation = w.lockStore.writeOperation.bind(w.lockStore);
    w.lockStore.writeOperation = async (bucket, record) => {
      if (record.stages.at(-1)?.status === "removing_devices")
        throw new Error("S3 PutObject on the state bucket failed: SlowDown");
      await writeOperation(bucket, record);
    };
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "failed",
      refusal: {
        summary: "S3 PutObject on the state bucket failed: SlowDown",
        details: [
          `Terraform destroyed host ${KEY}'s machine and factory.json no longer declares it; ` +
            "its Tailscale devices may remain.",
        ],
        nextAction:
          `Remove the remaining devices named ${HOSTNAME} at https://login.tailscale.com/admin/machines ` +
          "yourself (one without the factory's tag only if it was this worker): factory.json no " +
          "longer declares the host.",
      },
    });
    expect(w.store.files[PATH]).toBe(WITHOUT_KEY);
    expect(w.admin.calls).toEqual(["open"]);
    expect(w.lockStore.locks.size).toBe(0);
    expect(records(w)[0]).toMatchObject({ status: "failed" });

    // An error before factory.json is written still names the rerun.
    const early = world({ worker: CLEAN });
    early.planStore.create = async () => {
      throw new Error("ENOSPC: no space left on device");
    };
    expect(await terminateWorker(early.deps, removing(early))).toMatchObject({
      kind: "failed",
      refusal: {
        summary: "ENOSPC: no space left on device",
        nextAction:
          "Check the worker with `fffactory status`, then rerun " +
          `\`fffactory worker terminate ${KEY}\`.`,
      },
    });
    expect(early.store.writes).toEqual([]);
  });

  test("a machine already gone is removed without gates; one Terraform still holds is refused", async () => {
    const gone = world({
      provisioned: ["builder-2"],
      inventory: { kind: "machines", machines: [] },
      view: OFFLINE,
      prompt: fakePrompt({ interactive: true, answers: [KEY] }),
    });
    expect(await terminateWorker(gone.deps, removing(gone, { confirm: undefined }))).toMatchObject({
      kind: "done",
      removed: true,
      instanceId: undefined,
    });
    expect(gone.prompt.asked).toEqual([
      `Remove worker ${KEY} (${HOSTNAME}) from factory.json? No EC2 instance carries its key: ` +
        "its machine is already gone. Type the host key to confirm: ",
    ]);
    expect(gone.progress[0]).toEqual({ kind: "absent", key: KEY, hostname: HOSTNAME });
    expect(gone.controlPlane.calls).toEqual([]);
    expect(calls(gone)).toEqual(["output", "plan", "showPlan"]);
    expect(gone.store.files[PATH]).toBe(WITHOUT_KEY);

    const held = world({ inventory: { kind: "machines", machines: [] } });
    expect(await terminateWorker(held.deps, removing(held))).toMatchObject({
      kind: "refused",
      refusal: {
        summary: `Terraform's state holds a machine for host ${KEY} that EC2 does not list with the factory's tags`,
      },
    });
    expect(calls(held)).not.toContain("applyPlan");
  });

  test("a plan destroying another instance than the one EC2 lists and the question names is refused, applying nothing", async () => {
    // Terraform's state holds i-0aaaaaaaaaaaaaaaa, its tags stripped by hand, while EC2 lists
    // the tagged ID, which the gates inspected and the operator approves.
    const w = world({ worker: CLEAN, prompt: fakePrompt({ interactive: true, answers: [KEY] }) });
    w.terraform.world.instanceIds.set(KEY, "i-0aaaaaaaaaaaaaaaa");
    expect(await terminateWorker(w.deps, removing(w, { confirm: undefined }))).toMatchObject({
      kind: "refused",
      refusal: {
        summary:
          `Terraform's plan destroys instance i-0aaaaaaaaaaaaaaaa for host ${KEY}, not ${ID}, ` +
          "the instance EC2 lists for it",
        nextAction:
          `Check instances i-0aaaaaaaaaaaaaaaa and ${ID} in the EC2 console, then rerun ` +
          `\`fffactory worker terminate ${KEY}\`.`,
      },
    });
    expect(w.prompt.asked).toEqual([]);
    expect(calls(w)).toEqual(["output", "plan", "showPlan"]);
    expect([...w.terraform.world.hosts]).toEqual([KEY, "builder-2"]);
    expect(w.store.writes).toEqual([]);
    expect(w.admin.calls).toEqual(["open"]);
    expect(w.lockStore.locks.size).toBe(0);
    expect(records(w)[0]).toMatchObject({ status: "refused", machine: { state: "running" } });
  });

  test("a host with its own Paseo password: the plan stops the hosts' policy allowing exactly that ARN, and the removal proceeds", async () => {
    const instance = withPasswords(PASEO_1, PASEO_2);
    const text = serializeInstance(instance);
    const w = world({ worker: CLEAN, configuration: text, secretArns: [AUTH, PASEO_1, PASEO_2] });
    const result = await terminateWorker(w.deps, removing(w, { instance }));
    expect(result).toMatchObject({ kind: "done", removed: true, instanceId: ID });
    const [, plan] = w.terraform.calls;
    expect(plan?.call === "plan" && plan.request.variables.paseo_password_secret_arns).toEqual({
      "builder-2": PASEO_2,
    });
    const shown = (w.progress as PowerProgress[]).find(({ kind }) => kind === "removal_plan");
    if (shown?.kind !== "removal_plan") throw new Error("expected the removal plan");
    expect(shown.changes.map(({ address, actions }) => `${actions.join()} ${address}`)).toEqual(
      expect.arrayContaining([
        `update ${SECRETS_POLICY}`,
        `delete module.hosts.aws_instance.host["${KEY}"]`,
      ]),
    );
    expect(changeTally(shown.changes)).toMatchObject({ add: 0, change: 1, destroy: 1 });
    expect(calls(w)).toEqual(["output", "plan", "showPlan", "applyPlan", "output"]);
    expect(w.terraform.world.secretArns).toEqual([AUTH, PASEO_2]);
    expect([...w.terraform.world.hosts]).toEqual(["builder-2"]);
    expect(w.store.files[PATH]).toBe(serializeInstance(withoutHost(instance, KEY as HostKey)));
  });

  test("factory-wide credential references stay readable: removing a host never changes them (D2)", async () => {
    const github = paseoPassword("github-token");
    const openai = paseoPassword("openai-api-key");
    const credentials = { github_token_secret: github, openai_api_key_secret: openai };
    for (const [instance, before, after] of [
      [
        { ...withPasswords(PASEO_1, PASEO_2), credentials },
        [AUTH, PASEO_1, PASEO_2, github, openai],
        [AUTH, PASEO_2, github, openai],
      ],
      [{ ...withAdmin(), credentials }, [AUTH, github, openai], [AUTH, github, openai]],
    ] as const) {
      const text = serializeInstance(instance);
      const w = world({ worker: CLEAN, configuration: text, secretArns: before });
      const result = await terminateWorker(w.deps, removing(w, { instance }));
      expect(result).toMatchObject({ kind: "done", removed: true, instanceId: ID });
      const [, plan] = w.terraform.calls;
      expect(plan?.call === "plan" && plan.request.variables.credential_secret_arns).toEqual(
        credentials,
      );
      expect(w.terraform.world.secretArns).toEqual(after);
      expect(w.store.files[PATH]).toBe(serializeInstance(withoutHost(instance, KEY as HostKey)));
    }
  });

  test("a policy update dropping another ARN than the removed host's password is refused, applying nothing", async () => {
    // factory.json now names a new password for builder-1, not yet applied: the state's policy
    // still allows the old one, which the removal plan would drop instead.
    const instance = withPasswords(PASEO_1, PASEO_2);
    const text = serializeInstance(instance);
    const w = world({
      worker: CLEAN,
      configuration: text,
      secretArns: [AUTH, OLD_PASEO_1, PASEO_2],
    });
    const result = await terminateWorker(w.deps, removing(w, { instance }));
    expect(result).toMatchObject({
      kind: "refused",
      refusal: {
        summary: `The removal plan changes more than host ${KEY}'s machine: apply factory.json's other changes first`,
        details: [`${SECRETS_POLICY} would be updated in place`],
      },
    });
    expect(calls(w)).toEqual(["output", "plan", "showPlan"]);
    expect(w.terraform.world.secretArns).toEqual([AUTH, OLD_PASEO_1, PASEO_2]);
    expect([...w.terraform.world.hosts]).toEqual([KEY, "builder-2"]);
    expect(w.store.writes).toEqual([]);
    expect(records(w)[0]).toMatchObject({ status: "refused" });
  });

  test("a state still recording the key is applied, so Terraform stops recording it, and checked afterwards", async () => {
    const w = world({
      provisioned: ["builder-2"],
      inventory: { kind: "machines", machines: [] },
    });
    // An earlier removal destroyed the machine but its apply never wrote the outputs.
    w.terraform.world.outputs = { host_keys: [KEY, "builder-2"] };
    const apply = w.deps.provisioner.applyPlan;
    w.deps = {
      ...w.deps,
      provisioner: {
        ...w.deps.provisioner,
        applyPlan: async (request) => {
          await apply(request);
          w.terraform.world.outputs = undefined;
        },
      },
    };
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "done",
      removed: true,
    });
    expect(calls(w)).toEqual(["output", "plan", "showPlan", "applyPlan", "output"]);
    expect(w.store.files[PATH]).toBe(WITHOUT_KEY);

    // Terraform still recording the key after its apply fails, writing nothing.
    const stuck = world({
      provisioned: ["builder-2"],
      inventory: { kind: "machines", machines: [] },
    });
    stuck.terraform.world.outputs = { host_keys: [KEY, "builder-2"] };
    expect(await terminateWorker(stuck.deps, removing(stuck))).toMatchObject({
      kind: "failed",
      refusal: {
        summary: `Terraform still records host ${KEY} after applying its removal`,
        nextAction: `Rerun \`fffactory worker terminate ${KEY}\`.`,
      },
    });
    expect(stuck.store.writes).toEqual([]);
    expect(stuck.admin.calls).toEqual(["open"]);
  });

  test("a machine already being terminated is waited for, then the host removed", async () => {
    const w = world({
      provisioned: ["builder-2"],
      inventory: { kind: "machines", machines: [machine(KEY, "shutting-down", ID)] },
      states: ["terminated"],
    });
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "done",
      awaited: true,
      removed: true,
      instanceId: ID,
    });
    expect(w.control.mutations()).toEqual([]);
    expect(w.store.files[PATH]).toBe(WITHOUT_KEY);
    // The wait is recorded as terminate's, as with --keep, before the removal is planned.
    const recorded = stages(w);
    expect(
      recorded.slice(recorded.indexOf("authorizing"), recorded.indexOf("planning") + 1),
    ).toEqual(["authorizing", "terminating", "terminating", "planning"]);
  });

  test("a machine already being terminated: the typed key is asked after the plan, saying so; declining changes nothing", async () => {
    const w = world({
      provisioned: ["builder-2"],
      inventory: { kind: "machines", machines: [machine(KEY, "shutting-down", ID)] },
      states: ["terminated"],
      prompt: fakePrompt({ interactive: true, answers: ["yes"] }),
    });
    expect(await terminateWorker(w.deps, removing(w, { confirm: undefined }))).toMatchObject({
      kind: "declined",
      terminating: ID,
    });
    expect(w.prompt.asked).toEqual([
      `Remove worker ${KEY} (${HOSTNAME}) from factory.json? Its EC2 instance ${ID} was ` +
        "already being terminated, and is now terminated. Type the host key to confirm: ",
    ]);
    expect(calls(w)).toEqual(["output", "plan", "showPlan"]);
    expect(w.store.writes).toEqual([]);
    expect(w.admin.calls).toEqual(["open"]);
    expect(records(w)[0]).toMatchObject({ status: "declined" });
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("its gates still refuse a busy running worker before anything is planned", async () => {
    const w = world({ worker: CLEAN, activity: { kind: "active", count: 1 } });
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "refused",
      refusal: {
        nextAction:
          `Wait until no agent is active there, then rerun \`fffactory worker terminate ${KEY}\`, ` +
          "or pass --force to terminate it anyway.",
      },
    });
    expect(calls(w)).toEqual([]);
  });

  test("a device left behind leaves the removal partial, naming only the device to remove", async () => {
    const w = world({
      worker: CLEAN,
      admin: {
        devices: [tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG])],
        failing: { nWorker1CNTRL: "Tailscale answered HTTP 500" },
      },
    });
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "done",
      removed: true,
      leftover: {
        nextAction:
          `Remove the remaining devices named ${HOSTNAME} at https://login.tailscale.com/admin/machines ` +
          "yourself (one without the factory's tag only if it was this worker): factory.json no " +
          "longer declares the host.",
      },
    });
    expect(w.store.files[PATH]).toBe(WITHOUT_KEY);
    expect(records(w)[0]).toMatchObject({ status: "partial" });
  });
});

describe("terminate's removal interrupted (worker-lifecycle §Interruption)", () => {
  test("while Terraform applies: factory.json is untouched, the lock stays, no device is deleted", async () => {
    let w: World | undefined;
    w = world({ worker: CLEAN });
    w.terraform.world.beforeChange = () => w?.interrupt();
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "interrupted",
      locked: true,
      removal: "applying",
    });
    expect(w.store.writes).toEqual([]);
    expect(w.admin.calls).toEqual(["open"]);
    expect(w.lockStore.locks.size).toBe(1);
    expect(records(w)[0]).toMatchObject({
      status: "running",
      stages: [{ name: "terminate", status: "applying" }],
    });
  });

  test("once factory.json is written: no device is deleted, and it says so", async () => {
    let w: World | undefined;
    w = world({ worker: CLEAN });
    const write = w.store.write.bind(w.store);
    w.store.write = async (path, contents) => {
      await write(path, contents);
      w?.interrupt();
    };
    expect(await terminateWorker(w.deps, removing(w))).toMatchObject({
      kind: "interrupted",
      locked: true,
      removal: "written",
    });
    expect(w.store.files[PATH]).toBe(WITHOUT_KEY);
    expect(w.admin.calls).toEqual(["open"]);
    expect(w.lockStore.locks.size).toBe(1);
  });
});
