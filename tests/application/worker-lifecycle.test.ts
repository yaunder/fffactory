import { describe, expect, test } from "bun:test";
import type { AgentActivity } from "../../src/application/control-plane";
import { INSPECT_TIMEOUT_MS } from "../../src/application/inspect-worker";
import type { MachineRequest } from "../../src/application/machine-control";
import {
  startWorker,
  stopWorker,
  type WorkerLifecycleDependencies,
  type WorkerLifecycleRequest,
} from "../../src/application/worker-lifecycle";
import type { CallerObservation } from "../../src/domain/aws-account";
import { newLockRecord } from "../../src/domain/factory-lock";
import { INSPECT_COMMAND } from "../../src/domain/host-protocol";
import type { FactoryInstance, Release } from "../../src/domain/instance";
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
import { fakePrompt } from "../support/fake-secrets";
import {
  type Answer,
  answers,
  fakeMachineControl,
  fakeMachineInventory,
  fakeTailnet,
  fakeTime,
  fakeTransport,
  machine,
  peer,
  peers,
  readyWorker,
} from "../support/fake-workers";
import { BUCKET, declaring, FACTORY, NOW, RELEASE, WORKER_TAG } from "../support/factory-world";
import { MemoryLockStore } from "../support/memory-lock-store";

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
  const progress: unknown[] = [];
  let interrupted = false;
  const time = fakeTime(NOW, (slept) => options.onSleep?.(slept));
  const deps: WorkerLifecycleDependencies = {
    identity: identity.identity,
    lockStore,
    machines: inventory.machines,
    control: control.control,
    peers: tailnet.tailnet,
    transport: transport.transport,
    controlPlane: options.noControlPlane ? undefined : controlPlane.controlPlane,
    prompt: prompt.prompt,
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
    progress,
    time,
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
      expect(w.progress).toContainEqual({ kind: "forced" });
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
