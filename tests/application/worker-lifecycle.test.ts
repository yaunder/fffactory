import { describe, expect, test } from "bun:test";
import type { AgentActivity } from "../../src/application/control-plane";
import { INSPECT_TIMEOUT_MS } from "../../src/application/inspect-worker";
import type { MachineRequest } from "../../src/application/machine-control";
import { factoryStatus } from "../../src/application/status";
import {
  startWorker,
  stopWorker,
  terminateWorker,
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
} from "../support/fake-workers";
import { BUCKET, declaring, FACTORY, NOW, RELEASE, WORKER_TAG } from "../support/factory-world";
import type { SecretReference } from "../../src/domain/instance";
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
  readonly admin?: Parameters<typeof fakeTailnetAdmin>[0];
  readonly secretReadFails?: Error;
}

/** The admin client's reference, and the client secret Secrets Manager holds for it. */
const ADMIN_ARN =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/tailscale-admin-client-AbCdEf" as SecretReference;
const ADMIN_SECRET = "tskey-client-kExample1CNTRL-0123456789abcdef";

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

/** A terminate request: keep mode, confirmed in advance with `--confirm builder-1`. */
function terminating(
  w: World,
  overrides: Partial<Omit<WorkerLifecycleRequest, "action">> = {},
): Omit<WorkerLifecycleRequest, "action"> {
  return request(w, { instance: withAdmin(), yes: false, confirm: KEY, ...overrides });
}

/** The worker answering its inspection, its repository result and its dispatch state. */
const CLEAN = statusAnswers(readyWorker(FACTORY, KEY, RELEASE));
const TERMINATING = { states: ["shutting-down", "terminated"] as const, worker: CLEAN };

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
    expect(w.transport.calls.map(({ command }) => command.join(" "))).toEqual([
      expect.stringContaining("repositories"),
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

  test("a machine already being terminated is only waited for, then its devices deleted", async () => {
    const w = world({
      ...TERMINATING,
      inventory: { kind: "machines", machines: [machine(KEY, "shutting-down", ID)] },
      states: ["absent"],
      prompt: fakePrompt({ interactive: true }),
    });
    expect(await terminateWorker(w.deps, terminating(w, { confirm: undefined }))).toMatchObject({
      kind: "done",
      changed: false,
      awaited: true,
      devices: { removed: ["nWorker1CNTRL"] },
    });
    expect(w.control.mutations()).toEqual([]);
    expect(w.controlPlane.calls).toEqual([]);
    expect(w.prompt.asked).toEqual([]);
    expect(records(w)[0]).toMatchObject({
      status: "succeeded",
      stages: [{ name: "terminate", status: "unchanged" }],
    });
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
