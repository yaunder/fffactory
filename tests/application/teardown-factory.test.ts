/**
 * The teardown use case (`docs/specs/teardown.md`): the happy path and its refusals, against
 * the in-memory state bucket, a factory whose Terraform state changes as plans apply, the
 * EC2 inventory that state backs, the tailnet, Secrets Manager and scripted workers.
 */
import { describe, expect, test } from "bun:test";
import type { AgentActivity, ControlPlane } from "../../src/application/control-plane";
import type { MachineInventorySource } from "../../src/application/machine-inventory";
import type { SecretListing } from "../../src/application/secret-store";
import {
  type TeardownDependencies,
  type TeardownProgress,
  type TeardownRequest,
  teardownFactory,
} from "../../src/application/teardown-factory";
import type { WorkflowQueue } from "../../src/application/workflow-queue";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { FactoryInstance, SecretReference } from "../../src/domain/instance";
import type { ListedSecret } from "../../src/domain/secrets";
import type { Machine, MachineInventory, MachineState } from "../../src/domain/status";
import type { VpcInventory } from "../../src/domain/teardown";
import type { PeerView, TailnetDevice } from "../../src/domain/tailnet";
import { FAKE_CALLER, fakeCallerIdentity } from "../support/doctor-fakes";
import { fakeControlPlane, fakeWorkflowQueue } from "../support/fake-control-plane";
import { fakeFactoryWorld, NETWORK_VPC } from "../support/fake-provisioner";
import { fakePrompt, fakeSecretStore } from "../support/fake-secrets";
import {
  type Answer,
  fakeTailnet,
  fakeTailnetAdmin,
  fakeTime,
  fakeTransport,
  peer,
  peers,
  readyWorker,
  statusAnswers,
  tailnetDevice,
} from "../support/fake-workers";
import { BUCKET, declaring, FACTORY, NOW, RELEASE, WORKER_TAG } from "../support/factory-world";
import { MemoryLockStore, READY_BUCKET } from "../support/memory-lock-store";
import { MemoryPlanStore } from "../support/memory-plan-store";

const TERRAFORM = "/cache/releases/0.3.0/terraform";
const PATH = "/work/.fffactory/factory.json";
const hostname = (key: string) => `${FACTORY}-${key}`;
const arn = (name: string) =>
  `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${name}-AbCdEf` as SecretReference;

/** The admin client's reference, and the client secret Secrets Manager holds for it. */
const ADMIN_ARN = arn(`${FACTORY}/tailscale-admin-client`);
const ADMIN_SECRET = "tskey-client-kExample1CNTRL-0123456789abcdef";
/** A harness credential source the factory only refers to: never the factory's to delete. */
const SOURCE_ARN = arn("fffv/github-token");

const OWNED_TAGS = { "fffactory:factory-id": FACTORY, "fffactory:managed-by": "fffactory" };
const secret = (name: string, tags: Record<string, string> = OWNED_TAGS): ListedSecret => ({
  name,
  arn: arn(name),
  tags,
  pendingDeletion: false,
});
/** The factory's owned secrets: its auth key and admin client, as `secret set` stores them. */
const OWNED = [
  secret(`${FACTORY}/tailscale-auth-key`),
  secret(`${FACTORY}/tailscale-admin-client`),
];

/** factory.json declaring `keys`, with the admin client and a harness credential source. */
function instanceOf(keys: readonly string[]): FactoryInstance {
  const base = declaring(...keys);
  return {
    ...base,
    tailscale: { ...base.tailscale, admin_client_secret: ADMIN_ARN },
    credentials: { github_token_secret: SOURCE_ARN },
  };
}

interface WorldOptions {
  /** The declared workers and their machines' EC2 states; every one provisioned. */
  readonly workers?: Readonly<Record<string, MachineState>>;
  readonly activity?: AgentActivity;
  readonly view?: PeerView;
  readonly worker?: (key: string) => Answer;
  readonly prompt?: ReturnType<typeof fakePrompt>;
  readonly devices?: readonly TailnetDevice[];
  readonly listing?: SecretListing;
  /** Replaces the EC2 instance listing, the VPC listing, or both. */
  readonly inventory?: MachineInventory;
  readonly vpcs?: VpcInventory;
  readonly dispatchFailure?: string;
}

/**
 * A factory with `workers`, provisioned, in the tailnet with one device each, whose EC2
 * inventory lists the instances and VPC its Terraform state holds, and the ports teardown
 * reaches. `events` orders what was asked of the workers.
 */
function world(options: WorldOptions = {}) {
  const workers = options.workers ?? {};
  const keys = Object.keys(workers);
  const lockStore = new MemoryLockStore([BUCKET]);
  const terraform = fakeFactoryWorld({
    store: lockStore,
    bucket: BUCKET,
    hosts: keys,
    network: true,
  });
  const events: string[] = [];
  const machines: MachineInventorySource = {
    list: async () =>
      options.inventory ?? {
        kind: "machines",
        machines: [...terraform.world.hosts].map(
          (key): Machine => ({
            instanceId: `i-${key}`,
            state: workers[key] ?? "running",
            hostKey: key,
          }),
        ),
      },
    listVpcs: async () =>
      options.vpcs ?? { kind: "vpcs", vpcIds: terraform.world.network ? [NETWORK_VPC] : [] },
  };
  const running = keys.filter((key) => workers[key] === "running");
  const tailnet = fakeTailnet(
    options.view ?? peers(...running.map((key) => peer(hostname(key), { tags: [WORKER_TAG] }))),
  );
  const transport = fakeTransport(
    Object.fromEntries(
      running.map((key) => [
        hostname(key),
        options.worker?.(key) ?? statusAnswers(readyWorker(FACTORY, key, RELEASE)),
      ]),
    ),
  );
  const control = fakeControlPlane("healthy", options.activity ?? { kind: "idle" });
  const controlPlane: ControlPlane = {
    ...control.controlPlane,
    activeAgents: async (worker) => {
      events.push(`activity ${worker.hostname}`);
      return control.controlPlane.activeAgents(worker);
    },
  };
  const queue = fakeWorkflowQueue(
    options.dispatchFailure === undefined ? {} : { failure: options.dispatchFailure },
  );
  const workflowQueue: WorkflowQueue = {
    ...queue.queue,
    reconcileDispatch: async (worker, projection) => {
      events.push(`dispatch ${worker.hostname}`);
      return queue.queue.reconcileDispatch(worker, projection);
    },
  };
  const secrets = fakeSecretStore({
    values: { [ADMIN_ARN]: ADMIN_SECRET },
    listing: options.listing ?? { kind: "listed", secrets: OWNED },
  });
  const admin = fakeTailnetAdmin({
    devices:
      options.devices ??
      keys.map((key, index) => tailnetDevice(`n${index}CNTRL`, hostname(key), [WORKER_TAG])),
  });
  const prompt = options.prompt ?? fakePrompt();
  const planStore = new MemoryPlanStore();
  const identity = fakeCallerIdentity();
  const time = fakeTime(NOW);
  const progress: TeardownProgress[] = [];
  const deps: TeardownDependencies = {
    identity: identity.identity,
    lockStore,
    machines,
    peers: tailnet.tailnet,
    transport: transport.transport,
    controlPlane,
    workflowQueue,
    prompt: prompt.prompt,
    secrets: secrets.store,
    tailnetAdmin: admin.admin,
    provisioner: terraform.provisioner,
    planStore,
    terraformDirectory: async () => TERRAFORM,
    interrupted: () => false,
    sleep: time.sleep,
    progress: (event) => progress.push(event),
  };
  return {
    deps,
    keys,
    lockStore,
    terraform,
    tailnet,
    transport,
    control,
    queue,
    secrets,
    admin,
    prompt,
    planStore,
    identity,
    time,
    events,
    progress,
  };
}

type World = ReturnType<typeof world>;

function request(w: World, overrides: Partial<TeardownRequest> = {}): TeardownRequest {
  return {
    instance: instanceOf(w.keys),
    instancePath: PATH,
    credentials: { source: "--profile", profile: "factory" },
    release: RELEASE,
    confirm: FACTORY,
    host: "operator-laptop",
    clock: w.time.clock,
    randomBytes: (count) => new Uint8Array(count),
    ...overrides,
  };
}

const records = (w: World) => [...w.lockStore.operations.values()];
const destroyed = (w: World) => w.terraform.calls.filter(({ call }) => call === "applyPlan");

/** Nothing the factory owns was removed, and the lock is released. */
function expectNothingRemoved(w: World) {
  expect(destroyed(w)).toEqual([]);
  expect(w.admin.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
  expect(w.secrets.calls.filter((call) => /^(remove|restore)/.test(call))).toEqual([]);
  expect(w.planStore.calls.filter((call) => call.startsWith("removeAll"))).toEqual([]);
  expect(w.lockStore.calls.filter((call) => call.startsWith("deleteBucket"))).toEqual([]);
  expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  expect(w.lockStore.locks.size).toBe(0);
}

/** Everything the factory owns is gone; its referenced sources were never touched. */
function expectAllRemoved(w: World) {
  expect(w.terraform.world.hosts.size).toBe(0);
  expect(w.terraform.world.network).toBe(false);
  expect(w.admin.devices().filter(({ hostName }) => hostName.startsWith(`${FACTORY}-`))).toEqual(
    [],
  );
  for (const { arn: owned } of OWNED) {
    expect(w.secrets.calls).toContain(`remove ${owned}`);
    expect(w.secrets.calls).toContain(`exists ${owned}`);
  }
  expect(w.secrets.calls.filter((call) => call.includes(SOURCE_ARN))).toEqual([]);
  expect(w.planStore.calls).toContain(`removeAll ${FACTORY}`);
  expect(w.planStore.directories.size).toBe(0);
  expect(w.lockStore.buckets.has(BUCKET)).toBe(false);
  expect(w.lockStore.locks.size).toBe(0);
  expect(w.lockStore.operations.size).toBe(0);
}

/**
 * Nothing reaches the bucket once it is deleted: no lock release and no record, either of
 * which would answer NoSuchBucket.
 */
function expectNothingAfterBucket(w: World) {
  const calls = w.lockStore.calls;
  const deletion = calls.findIndex((call) => call.startsWith("deleteBucket"));
  expect(deletion).toBeGreaterThan(-1);
  expect(calls.slice(deletion + 1)).toEqual([]);
}

/** `admin`, whose tailnet lists `late` too from its second listing on: after the review. */
function withLateDevices(
  admin: ReturnType<typeof fakeTailnetAdmin>,
  late: readonly TailnetDevice[],
): TeardownDependencies["tailnetAdmin"] {
  let listings = 0;
  return {
    open: async (secret) => {
      const opening = await admin.admin.open(secret);
      if (opening.kind !== "open") return opening;
      const { session } = opening;
      return {
        kind: "open",
        session: {
          ...session,
          devices: async () => {
            listings += 1;
            const listing = await session.devices();
            return listings === 1 || listing.kind !== "devices"
              ? listing
              : { kind: "devices", devices: [...listing.devices, ...late] };
          },
        },
      };
    },
  };
}

/** `machines`, whose second EC2 instance listing on is `changed`'s answer: after the review. */
function changingMachines(
  machines: MachineInventorySource,
  changed: (listed: readonly Machine[]) => MachineInventory,
): MachineInventorySource {
  let lists = 0;
  return {
    ...machines,
    list: async (...args) => {
      lists += 1;
      const listed = await machines.list(...args);
      return lists === 1 || listed.kind !== "machines" ? listed : changed(listed.machines);
    },
  };
}

describe("fffactory teardown: the happy path (teardown §Order)", () => {
  test("removes a factory without workers: network, state, owned secrets, plans and the bucket", async () => {
    const w = world();
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      report: {
        infrastructure: "destroyed",
        machines: [],
        devices: { removed: [], possible: [], untagged: [] },
        secrets: {
          removed: OWNED.map(({ name }) => name),
          kept: { tagged: [], referenced: [SOURCE_ARN], unlisted: [] },
        },
        bucket: BUCKET,
      },
    });
    expectAllRemoved(w);
    expectNothingAfterBucket(w);
    const [plan] = w.terraform.calls.filter(({ call }) => call === "plan");
    expect(plan?.request).toMatchObject({ destroy: true, stateLock: true });
    expect(w.prompt.asked).toEqual([]);
  });

  test("removes one running worker: dispatch stopped, inspected, destroyed, its device deleted", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      report: {
        machines: [{ instanceId: "i-builder-1", state: "running", hostKey: "builder-1" }],
        devices: { removed: ["n0CNTRL"] },
      },
    });
    expectAllRemoved(w);
    expectNothingAfterBucket(w);
    expect(w.queue.reconcile).toEqual([false]);
    expect(w.control.calls).toEqual(["activeAgents"]);
    // The record was written at each step until the bucket went, and went with it.
    expect(w.lockStore.operationWrites.map(({ stages }) => stages[0]?.status)).toEqual([
      "authorizing",
      "inventorying",
      "planning",
      "stopping_dispatch",
      // Each worker's dispatch, as stopping it ended.
      "stopping_dispatch",
      "inspecting",
      "applying",
      "verifying",
      "removing_devices",
      "removing_secrets",
      "removing_plans",
      "deleting_bucket",
    ]);
    expect(w.lockStore.operationWrites[4]?.dispatch).toEqual([
      {
        key: "builder-1",
        hostname: hostname("builder-1"),
        status: "not_requested",
        blockers: [],
        summary: null,
      },
    ]);
    expect(w.lockStore.operationWrites[0]).toMatchObject({
      operation: "teardown",
      stages: [{ name: "teardown" }],
      holder: { principal: FAKE_CALLER.arn, host: "operator-laptop" },
    });
  });

  test("removes two workers, one stopped: only the running one is inspected", async () => {
    const w = world({ workers: { "builder-1": "running", "builder-2": "stopped" } });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      report: { devices: { removed: ["n0CNTRL", "n1CNTRL"] } },
    });
    expectAllRemoved(w);
    expect(w.events).toEqual([
      `dispatch ${hostname("builder-1")}`,
      `activity ${hostname("builder-1")}`,
    ]);
    expect(w.transport.calls.every(({ worker }) => worker.hostname === hostname("builder-1"))).toBe(
      true,
    );
    expect(w.progress).toContainEqual({
      kind: "uninspected_stopped",
      hostname: hostname("builder-2"),
    });
  });

  test("shows what it removes and keeps, then asks for the typed factory ID at a terminal", async () => {
    const prompt = fakePrompt({ interactive: true, answers: [` ${FACTORY} `] });
    const w = world({ workers: { "builder-1": "running" }, prompt });
    const result = await teardownFactory(w.deps, request(w, { confirm: undefined }));
    expect(result.kind).toBe("done");
    expect(prompt.asked).toHaveLength(1);
    expect(prompt.asked[0]).toContain("Type the factory ID to confirm: ");
    const review = w.progress.find((event) => event.kind === "review");
    expect(review).toMatchObject({
      kind: "review",
      review: {
        target: { instancePath: PATH, factoryId: FACTORY, accountId: "123456789012" },
        changes: [
          { address: 'module.hosts.aws_instance.host["builder-1"]', actions: ["delete"] },
          { address: "module.network.aws_vpc.this", actions: ["delete"] },
        ],
        vpcIds: [NETWORK_VPC],
        secrets: { kept: { referenced: [SOURCE_ARN] } },
        bucket: BUCKET,
      },
    });
    // The review comes before the question, and nothing was stopped before it was answered.
    expect(w.lockStore.operationWrites.map(({ stages }) => stages[0]?.status)).toContain(
      "awaiting_approval",
    );
  });

  test("stops dispatch on every running worker before the first inspection", async () => {
    const w = world({ workers: { "builder-1": "running", "builder-2": "running" } });
    expect((await teardownFactory(w.deps, request(w))).kind).toBe("done");
    expect(w.events).toEqual([
      `dispatch ${hostname("builder-1")}`,
      `dispatch ${hostname("builder-2")}`,
      `activity ${hostname("builder-1")}`,
      `activity ${hostname("builder-2")}`,
    ]);
  });

  test("keeps a referenced fffv/* source and tagged secrets it does not own, listing them", async () => {
    const tagged = secret(`${FACTORY}/github-token`, { "fffactory:factory-id": FACTORY });
    const w = world({ listing: { kind: "listed", secrets: [...OWNED, tagged] } });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      report: {
        secrets: {
          kept: {
            tagged: [{ name: tagged.name, arn: tagged.arn }],
            referenced: [SOURCE_ARN],
            unlisted: [],
          },
        },
      },
    });
    expect(w.secrets.calls.filter((call) => call.includes(tagged.arn))).toEqual([]);
    expect(w.secrets.calls.filter((call) => call.includes(SOURCE_ARN))).toEqual([]);
  });

  test("deletes devices by D9: known keys and any tagged one of a generated ID, untagged ones only listed", async () => {
    const devices = [
      tailnetDevice("nA", hostname("builder-1"), [WORKER_TAG]),
      tailnetDevice("nB", hostname("stray"), [WORKER_TAG]),
      tailnetDevice("nC", hostname("builder-1"), []),
      tailnetDevice("nD", "other-builder-1", [WORKER_TAG]),
    ];
    const w = world({ workers: { "builder-1": "stopped" }, devices });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      report: {
        devices: {
          removed: ["nA", "nB"],
          possible: [],
          untagged: [{ id: "nC", hostname: hostname("builder-1") }],
        },
      },
    });
    expect(w.admin.devices().map(({ id }) => id)).toEqual(["nC", "nD"]);
  });

  test("deletes only the devices it showed: a tagged one that appears later is listed, not deleted", async () => {
    const devices = [
      tailnetDevice("nA", hostname("builder-1"), [WORKER_TAG]),
      tailnetDevice("nB", hostname("stray"), [WORKER_TAG]),
    ];
    const late = [
      tailnetDevice("nL", hostname("late"), [WORKER_TAG]),
      // A known key's exact name is the factory's whenever it appears.
      tailnetDevice("nK", hostname("builder-1"), [WORKER_TAG]),
    ];
    const w = world({ workers: { "builder-1": "stopped" }, devices });
    const tailnetAdmin = withLateDevices(w.admin, late);
    const result = await teardownFactory({ ...w.deps, tailnetAdmin }, request(w));
    expect(result).toMatchObject({
      kind: "done",
      report: {
        devices: {
          removed: ["nA", "nK", "nB"],
          possible: [{ id: "nL", hostname: hostname("late") }],
          untagged: [],
        },
      },
    });
    expect(w.admin.calls.filter((call) => call.startsWith("remove"))).not.toContain("remove nL");
  });

  test("carries no device tag and no malformed host key tag in what it shows and reports", async () => {
    const devices = [
      tailnetDevice("nA", hostname("builder-1"), [WORKER_TAG]),
      tailnetDevice("nU", hostname("builder-1"), ["tag:pasted-secret"]),
    ];
    const w = world({ workers: { "builder-1": "stopped" }, devices });
    const result = await teardownFactory(w.deps, request(w));
    const review = w.progress.find((event) => event.kind === "review");
    expect(review).toMatchObject({
      review: {
        machines: [
          {
            instanceId: "i-builder-1",
            state: "stopped",
            hostKey: "builder-1",
            malformedHostKey: false,
          },
        ],
        devices: {
          deleted: [{ id: "nA", hostname: hostname("builder-1") }],
          untagged: [{ id: "nU", hostname: hostname("builder-1") }],
        },
      },
    });
    expect(result).toMatchObject({
      kind: "done",
      report: { devices: { untagged: [{ id: "nU", hostname: hostname("builder-1") }] } },
    });
    for (const shown of [JSON.stringify(review), JSON.stringify(result)]) {
      expect(shown).not.toContain(WORKER_TAG);
      expect(shown).not.toContain("pasted-secret");
      expect(shown).not.toContain('"tags"');
    }
  });

  test("marks an EC2 host key tag that is not a well-formed key, never carrying it", async () => {
    const w = world({
      inventory: {
        kind: "machines",
        machines: [{ instanceId: "i-0stray", state: "stopped", hostKey: "tskey-pasted Secret" }],
      },
    });
    await teardownFactory(w.deps, request(w));
    const review = w.progress.find((event) => event.kind === "review");
    expect(review).toMatchObject({
      review: {
        machines: [
          { instanceId: "i-0stray", state: "stopped", hostKey: undefined, malformedHostKey: true },
        ],
      },
    });
    expect(JSON.stringify(review)).not.toContain("tskey");
  });

  test("a local plan that cannot be removed once the bucket is gone never fails the teardown", async () => {
    const w = world();
    const store = w.planStore;
    const remove = store.remove.bind(store);
    store.remove = async (factoryId, planId) => {
      if (!w.lockStore.buckets.has(BUCKET)) throw new Error("ENOENT: the plan directory is gone");
      return remove(factoryId, planId);
    };
    const result = await teardownFactory(w.deps, request(w));
    expect(result.kind).toBe("done");
    expectAllRemoved(w);
    expectNothingAfterBucket(w);
  });

  test("reports the factory's root already absent when the destroy plan changes nothing", async () => {
    const w = world();
    w.terraform.world.network = false;
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      report: { infrastructure: "absent", changes: [] },
    });
    expect(destroyed(w)).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(false);
  });
});

describe("fffactory teardown: refusals delete nothing (teardown §Refusals)", () => {
  test("refuses a held lock, showing its holder, never breaking it", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    const held = w.lockStore.hold(
      BUCKET,
      newLockRecord({
        factoryId: FACTORY,
        operation: "apply",
        holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
        release: RELEASE,
        now: NOW,
        randomBytes: (count) => new Uint8Array(count).fill(7),
      }),
    );
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toEqual({ kind: "locked", held });
    expect(w.lockStore.locks.get(BUCKET)).toEqual(held);
    expect(w.terraform.calls).toEqual([]);
    expect(w.admin.calls).toEqual([]);
    expect(w.queue.reconcile).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  test("refuses active agents, naming the worker; dispatch is left stopped", async () => {
    const w = world({
      workers: { "builder-1": "running", "builder-2": "running" },
      activity: { kind: "active", count: 1 },
    });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `1 agent is active on ${hostname("builder-1")}: terminating it would end it`,
          nextAction:
            "Wait until no agent is active there, then rerun `fffactory teardown`. To remove " +
            "the worker anyway, run `fffactory worker terminate builder-1 --force` first.",
        },
        { summary: `1 agent is active on ${hostname("builder-2")}: terminating it would end it` },
      ],
      dispatchStopped: [hostname("builder-1"), hostname("builder-2")],
    });
    expectNothingRemoved(w);
    expect(records(w)[0]).toMatchObject({
      status: "refused",
      stages: [{ name: "teardown", status: "refused" }],
      dispatch: [
        { hostname: hostname("builder-1"), status: "not_requested" },
        { hostname: hostname("builder-2"), status: "not_requested" },
      ],
    });
  });

  test("refuses unmanaged checkouts found by the fresh inspection", async () => {
    const w = world({
      workers: { "builder-1": "running" },
      worker: (key) =>
        statusAnswers(readyWorker(FACTORY, key, RELEASE), "synchronized", [
          "/workspace/repos/scratch",
        ]),
    });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `${hostname("builder-1")} holds unmanaged checkouts: terminating it would lose them`,
          nextAction:
            "Copy what you need off them, then terminate it with --force: `fffactory worker " +
            "terminate builder-1 --force`, and rerun `fffactory teardown`.",
        },
      ],
    });
    expectNothingRemoved(w);
  });

  test("refuses a running worker the tailnet does not locate: terminate it with --force first", async () => {
    const w = world({ workers: { "builder-1": "running" }, view: peers() });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `${hostname("builder-1")} could not be inspected: No Tailscale device named ${hostname("builder-1")} is visible from this machine`,
          nextAction:
            "Check the worker with `fffactory status`, then rerun `fffactory teardown`. If it " +
            "cannot be inspected, remove it uninspected: run `fffactory worker terminate " +
            "builder-1 --force`, then rerun `fffactory teardown`.",
        },
      ],
      dispatchStopped: [],
    });
    expect(w.queue.reconcile).toEqual([]);
    expectNothingRemoved(w);
  });

  test("refuses when dispatch cannot be stopped on a worker", async () => {
    const w = world({ workers: { "builder-1": "running" }, dispatchFailure: "unreachable" });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        { summary: `Dispatch could not be stopped on ${hostname("builder-1")}: unreachable` },
      ],
    });
    expect(w.control.calls).toEqual([]);
    expectNothingRemoved(w);
  });

  test.each([
    {
      case: "a stopped worker started",
      changed: (listed: readonly Machine[]): MachineInventory => ({
        kind: "machines",
        machines: listed.map((machine) =>
          machine.hostKey === "builder-2" ? { ...machine, state: "running" } : machine,
        ),
      }),
      details: [`EC2 instance i-builder-2 of ${hostname("builder-2")}: running, reviewed stopped`],
    },
    {
      case: "a new instance",
      changed: (listed: readonly Machine[]): MachineInventory => ({
        kind: "machines",
        machines: [...listed, { instanceId: "i-0new", state: "running", hostKey: undefined }],
      }),
      details: ["EC2 instance i-0new (running): not reviewed"],
    },
    {
      case: "an instance gone",
      changed: (listed: readonly Machine[]): MachineInventory => ({
        kind: "machines",
        machines: listed.filter(({ hostKey }) => hostKey !== "builder-2"),
      }),
      details: [`EC2 instance i-builder-2 of ${hostname("builder-2")}: no longer listed`],
    },
  ])(
    "refuses when the factory's machines changed after the review ($case), dispatch left stopped",
    async ({ changed, details }) => {
      const w = world({ workers: { "builder-1": "running", "builder-2": "stopped" } });
      const machines = changingMachines(w.deps.machines, changed);
      const result = await teardownFactory({ ...w.deps, machines }, request(w));
      expect(result).toMatchObject({
        kind: "refused",
        refusals: [
          {
            summary: "The factory's EC2 instances changed after they were reviewed",
            details,
            nextAction: "Rerun `fffactory teardown` to review the factory as it is now.",
          },
        ],
        dispatchStopped: [hostname("builder-1")],
      });
      expect(w.queue.reconcile).toEqual([false]);
      expect(w.control.calls).toEqual([]);
      expectNothingRemoved(w);
      expect(records(w)[0]).toMatchObject({ status: "refused" });
    },
  );

  test("refuses when the factory's machines cannot be listed again after the review", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    const machines = changingMachines(w.deps.machines, () => ({
      kind: "unavailable",
      reason: "EC2 DescribeInstances failed: timed out after 15 s",
    }));
    const result = await teardownFactory({ ...w.deps, machines }, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [{ summary: "EC2 DescribeInstances failed: timed out after 15 s" }],
      dispatchStopped: [hostname("builder-1")],
    });
    expect(w.control.calls).toEqual([]);
    expectNothingRemoved(w);
  });

  test("refuses the guarded destroy plan before it is shown or confirmed", async () => {
    const prompt = fakePrompt({ interactive: true, answers: [FACTORY] });
    const w = world({ workers: { "builder-1": "running" }, prompt });
    w.terraform.world.shown = {
      resource_changes: [
        {
          address: "module.network.aws_vpc.this",
          type: "aws_vpc",
          change: { actions: ["update"] },
        },
      ],
    };
    const result = await teardownFactory(w.deps, request(w, { confirm: undefined }));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: "Terraform's destroy plan does more than destroy the factory's resources",
          details: ["module.network.aws_vpc.this (update)"],
        },
      ],
    });
    expect(prompt.asked).toEqual([]);
    expect(w.progress.filter(({ kind }) => kind === "review")).toEqual([]);
    expect(w.queue.reconcile).toEqual([]);
    expectNothingRemoved(w);
    expect(w.planStore.directories.size).toBe(0);
  });

  test("refuses a destroy plan whose exit code reports changes its JSON plan does not hold", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    w.terraform.world.shown = { resource_changes: [] };
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary:
            "Terraform's destroy plan reports changes, but its JSON plan changes no resource",
        },
      ],
    });
    expectNothingRemoved(w);
  });

  test.each([
    {
      case: "EC2 instances",
      options: {
        inventory: {
          kind: "unavailable",
          reason: "EC2 DescribeInstances failed: timed out after 15 s",
        },
      } as WorldOptions,
      summary: "EC2 DescribeInstances failed: timed out after 15 s",
    },
    {
      case: "VPCs",
      options: {
        vpcs: { kind: "unavailable", reason: "EC2 DescribeVpcs failed: UnauthorizedOperation" },
      } as WorldOptions,
      summary: "EC2 DescribeVpcs failed: UnauthorizedOperation",
    },
    {
      case: "secrets",
      options: {
        listing: {
          kind: "failed",
          reason: "Secrets Manager ListSecrets failed: AccessDeniedException",
        },
      } as WorldOptions,
      summary: "Secrets Manager ListSecrets failed: AccessDeniedException",
    },
  ])(
    "refuses when the factory's $case cannot be listed, never taking that for none",
    async ({ options, summary }) => {
      const w = world({ workers: { "builder-1": "running" }, ...options });
      const result = await teardownFactory(w.deps, request(w));
      expect(result).toMatchObject({
        kind: "refused",
        refusals: [
          {
            summary,
            details: [
              "Nothing was removed: a listing that failed is never taken for one that found nothing.",
            ],
          },
        ],
      });
      expect(w.terraform.calls.filter(({ call }) => call === "plan")).toEqual([]);
      expectNothingRemoved(w);
    },
  );

  test("refuses when the tailnet's devices cannot be listed", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    const admin = fakeTailnetAdmin({
      listing: { kind: "failed", reason: "Tailscale answered HTTP 500" },
    });
    const result = await teardownFactory({ ...w.deps, tailnetAdmin: admin.admin }, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        { summary: "The tailnet's devices could not be listed: Tailscale answered HTTP 500" },
      ],
    });
    expectNothingRemoved(w);
  });

  test("refuses an admin client Tailscale does not accept, before anything is listed", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    const admin = fakeTailnetAdmin({
      open: { kind: "failed", reason: "Tailscale answered HTTP 401" },
    });
    const result = await teardownFactory({ ...w.deps, tailnetAdmin: admin.admin }, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        { summary: "The Tailscale admin client could not be used: Tailscale answered HTTP 401" },
      ],
    });
    expect(w.terraform.calls).toEqual([]);
    expectNothingRemoved(w);
  });

  test("refuses a worker whose machine is on its way to running, before asking", async () => {
    const prompt = fakePrompt({ interactive: true, answers: [FACTORY] });
    const w = world({ workers: { "builder-1": "pending" }, prompt });
    const result = await teardownFactory(w.deps, request(w, { confirm: undefined }));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `EC2 instance i-builder-1 of ${hostname("builder-1")} is pending`,
          nextAction: "Wait until it is running, then rerun `fffactory teardown`.",
        },
      ],
    });
    expect(prompt.asked).toEqual([]);
    expectNothingRemoved(w);
  });

  test("declined: a wrong typed ID removes nothing and stops no dispatch", async () => {
    const prompt = fakePrompt({ interactive: true, answers: ["fff-abcd1235"] });
    const w = world({ workers: { "builder-1": "running" }, prompt });
    const result = await teardownFactory(w.deps, request(w, { confirm: undefined }));
    expect(result).toMatchObject({ kind: "declined" });
    expect(JSON.stringify(result)).not.toContain("fff-abcd1235");
    expect(w.queue.reconcile).toEqual([]);
    expectNothingRemoved(w);
    expect(records(w)[0]).toMatchObject({
      status: "declined",
      stages: [{ name: "teardown", status: "declined" }],
    });
  });

  test("refuses a wrong --confirm before anything reaches AWS, never echoing it", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    const result = await teardownFactory(w.deps, request(w, { confirm: "tskey-pasted-secret" }));
    expect(result).toEqual({
      kind: "refused",
      refusals: [
        {
          summary: `--confirm does not name the factory ${FACTORY}`,
          details: [],
          nextAction: `Pass --confirm ${FACTORY} to remove it, or type the factory ID when asked at a terminal.`,
        },
      ],
      operation: undefined,
      dispatchStopped: [],
    });
    expect(w.identity.requests).toEqual([]);
    expect(w.lockStore.calls).toEqual([]);
  });

  test("refuses without a terminal and without --confirm, before anything reaches AWS", async () => {
    const w = world();
    expect(await teardownFactory(w.deps, request(w, { confirm: undefined }))).toEqual({
      kind: "unconfirmable",
    });
    expect(w.identity.requests).toEqual([]);
  });

  test("refuses factory.json without the admin client, and an incomplete one, before AWS", async () => {
    const w = world();
    const { admin_client_secret: _, ...tailscale } = instanceOf([]).tailscale ?? {};
    const without = { ...instanceOf([]), tailscale };
    expect(await teardownFactory(w.deps, request(w, { instance: without }))).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary:
            "factory.json has no Tailscale admin client (tailscale.admin_client_secret): teardown deletes the factory's tailnet devices with it",
        },
      ],
    });
    const { state_backend: __, ...incomplete } = instanceOf([]);
    expect(await teardownFactory(w.deps, request(w, { instance: incomplete }))).toMatchObject({
      kind: "incomplete",
      missing: ["state_backend.bucket"],
    });
    expect(w.identity.requests).toEqual([]);
  });

  test("refuses another account and a release factory.json does not pin, taking no lock", async () => {
    const w = world();
    const other = await teardownFactory(
      {
        ...w.deps,
        identity: fakeCallerIdentity({
          kind: "caller",
          caller: { ...FAKE_CALLER, account: "210987654321" },
        }).identity,
      },
      request(w),
    );
    expect(other.kind).toBe("account_refused");
    const pinned = await teardownFactory(w.deps, request(w, { release: "0.4.0" as never }));
    expect(pinned.kind).toBe("release_mismatch");
    expect(w.lockStore.calls.filter((call) => call.startsWith("create"))).toEqual([]);
  });

  test("refuses an unready state bucket, as plan does, taking no lock", async () => {
    const w = world();
    w.lockStore.readiness.set(BUCKET, { ...READY_BUCKET, tlsOnly: false });
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "unready_bucket",
      bucket: { missing: ["tls_only_policy"] },
    });
    expect(w.lockStore.calls.filter((call) => call.startsWith("create"))).toEqual([]);
  });

  test("refuses an admin client whose secret cannot be read", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    const secrets = fakeSecretStore({
      readFailsWith: new Error(
        "Reading the secret from Secrets Manager failed: AccessDeniedException",
      ),
    });
    const result = await teardownFactory({ ...w.deps, secrets: secrets.store }, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: "Reading the secret from Secrets Manager failed: AccessDeniedException",
          nextAction:
            "Check that the credentials may call secretsmanager:GetSecretValue on the secret " +
            "tailscale.admin_client_secret refers to, then rerun `fffactory teardown`.",
        },
      ],
    });
    expect(w.admin.calls).toEqual([]);
    expectNothingRemoved(w);
  });

  test("leaves a factory without a state bucket to its own mode (T7)", async () => {
    const w = world();
    w.lockStore.buckets.delete(BUCKET);
    expect(await teardownFactory(w.deps, request(w))).toEqual({ kind: "no_bucket" });
    expect(w.terraform.calls).toEqual([]);
  });
});

describe("fffactory teardown: what stops the run once the destroy applied", () => {
  test("stops before devices, secrets and the bucket when tagged resources remain (D12)", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    const stray: Machine = { instanceId: "i-0stray", state: "running", hostKey: undefined };
    const machines = w.deps.machines;
    let lists = 0;
    const result = await teardownFactory(
      {
        ...w.deps,
        machines: {
          ...machines,
          list: async (...args) => {
            lists += 1;
            const listed = await machines.list(...args);
            // The inventory, then its recheck before the gates, then the leftover check.
            return lists <= 2 || listed.kind !== "machines"
              ? listed
              : { kind: "machines", machines: [...listed.machines, stray] };
          },
        },
      },
      request(w),
    );
    expect(result).toMatchObject({
      kind: "partial",
      refusal: {
        summary:
          "Resources tagged with the factory's ID remain after the destroy, outside its Terraform state",
        details: [
          "EC2 instance i-0stray (running)",
          "Its tailnet devices, secrets and state bucket were kept.",
        ],
      },
    });
    expect(destroyed(w)).toHaveLength(1);
    expect(w.admin.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(w.secrets.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
    expect(w.lockStore.locks.size).toBe(0);
    expect(records(w)[0]).toMatchObject({ status: "partial" });
  });

  test("a bucket that remains with the lock held is recorded and the lock released", async () => {
    const w = world();
    w.lockStore.deletionLeaves = {
      kind: "remains",
      versions: 1,
      codes: ["AccessDenied"],
      failure: undefined,
      lock: "held",
    };
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "partial",
      refusal: { summary: `The state bucket ${BUCKET} remains` },
    });
    expect(records(w)[0]).toMatchObject({
      status: "partial",
      stages: [{ name: "teardown", status: "partial" }],
    });
    expect(w.lockStore.locks.size).toBe(0);
  });
});

describe("fffactory teardown: failures (teardown §Refusals)", () => {
  test("Terraform failing to plan the destroy fails it, nothing removed, lock released", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    w.terraform.world.failNext = "plan";
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "failed",
      refusal: {
        summary: "Planning the factory's destruction failed: `terraform plan` exited with status 1",
        details: ["Nothing was removed."],
      },
    });
    expectNothingRemoved(w);
    expect(records(w)[0]).toMatchObject({ status: "failed" });
    expect(w.planStore.directories.size).toBe(0);
  });

  test("refuses a state whose recorded host keys cannot be read", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    w.terraform.world.outputs = { host_keys: "builder-1" };
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        { summary: "The host keys the factory's Terraform state records could not be read" },
      ],
    });
    expectNothingRemoved(w);
  });

  test("an error under the lock fails it before the destroy, recorded, the lock released", async () => {
    const w = world();
    const failing = {
      ...w.deps,
      machines: {
        ...w.deps.machines,
        listVpcs: async () => {
          throw new Error("EC2 answered something fffactory cannot read");
        },
      },
    };
    const result = await teardownFactory(failing, request(w));
    expect(result).toMatchObject({
      kind: "failed",
      refusal: {
        summary: "EC2 answered something fffactory cannot read",
        nextAction: "Check the factory with `fffactory status`, then rerun `fffactory teardown`.",
      },
    });
    expectNothingRemoved(w);
  });

  test("Terraform failing to apply the destroy leaves it partial, devices, secrets and bucket kept", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    w.terraform.world.failNext = "applyPlan";
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "partial",
      refusal: {
        summary:
          "Destroying the factory's resources failed: `terraform apply` exited with status 1",
      },
    });
    expect(w.admin.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(w.secrets.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
    expect(w.lockStore.locks.size).toBe(0);
    expect(records(w)[0]).toMatchObject({ status: "partial" });
  });

  test("an error once the destroy started leaves it partial", async () => {
    const w = world();
    const store = w.planStore;
    store.removeAll = async () => {
      throw new Error("the local plans could not be removed (EACCES)");
    };
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "partial",
      refusal: { summary: "the local plans could not be removed (EACCES)" },
    });
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("a listing that fails after the destroy keeps devices, secrets and bucket", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    const machines = w.deps.machines;
    let lists = 0;
    const result = await teardownFactory(
      {
        ...w.deps,
        machines: {
          ...machines,
          listVpcs: async (...args) => {
            lists += 1;
            return lists === 1
              ? machines.listVpcs(...args)
              : { kind: "unavailable", reason: "EC2 DescribeVpcs failed: timed out after 15 s" };
          },
        },
      },
      request(w),
    );
    expect(result).toMatchObject({
      kind: "partial",
      refusal: { summary: "EC2 DescribeVpcs failed: timed out after 15 s" },
    });
    expect(w.admin.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  test("a device left behind stops the run before the secrets, the admin client kept", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    const admin = fakeTailnetAdmin({
      devices: [tailnetDevice("n0CNTRL", hostname("builder-1"), [WORKER_TAG])],
      failing: { n0CNTRL: "Tailscale answered HTTP 500" },
    });
    const result = await teardownFactory({ ...w.deps, tailnetAdmin: admin.admin }, request(w));
    expect(result).toMatchObject({
      kind: "partial",
      refusal: {
        summary: "Not every Tailscale device of the factory was deleted",
        details: [
          "Deleting device n0CNTRL failed: Tailscale answered HTTP 500",
          "Its secrets and state bucket were kept, the admin client among them.",
        ],
      },
    });
    expect(w.secrets.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  test("a device listing that fails after the destroy stops the run too", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    let listings = 0;
    const admin = fakeTailnetAdmin({ devices: [] });
    const tailnetAdmin = {
      open: async (secret: Parameters<typeof admin.admin.open>[0]) => {
        const opening = await admin.admin.open(secret);
        if (opening.kind !== "open") return opening;
        const { session } = opening;
        return {
          kind: "open" as const,
          session: {
            ...session,
            devices: async () => {
              listings += 1;
              return listings === 1
                ? session.devices()
                : { kind: "failed" as const, reason: "Tailscale answered HTTP 502" };
            },
          },
        };
      },
    };
    const result = await teardownFactory({ ...w.deps, tailnetAdmin }, request(w));
    expect(result).toMatchObject({
      kind: "partial",
      refusal: {
        summary: "The tailnet's devices could not be listed: Tailscale answered HTTP 502",
      },
    });
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  test("a secret not confirmed gone stops the run before the bucket", async () => {
    const w = world();
    const secrets = fakeSecretStore({
      values: { [ADMIN_ARN]: ADMIN_SECRET },
      listing: { kind: "listed", secrets: OWNED },
      removed: {
        kind: "failed",
        reason: "Secrets Manager DeleteSecret failed: AccessDeniedException",
      },
    });
    const result = await teardownFactory({ ...w.deps, secrets: secrets.store }, request(w));
    expect(result).toMatchObject({
      kind: "partial",
      refusal: {
        summary: "Not every secret the factory owns is gone",
        details: [
          `${FACTORY}/tailscale-auth-key: Secrets Manager DeleteSecret failed: AccessDeniedException`,
          `${FACTORY}/tailscale-admin-client: Secrets Manager DeleteSecret failed: AccessDeniedException`,
          "Its state bucket was kept.",
        ],
      },
    });
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
    expect(w.planStore.calls.filter((call) => call.startsWith("removeAll"))).toEqual([]);
  });

  test("a bucket left with its lock's versions touched gets no more writes", async () => {
    const w = world();
    w.lockStore.deletionLeaves = {
      kind: "remains",
      versions: undefined,
      codes: [],
      failure: "S3 DeleteObjects on the state bucket failed: timed out after 30 s",
      lock: "unknown",
    };
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "partial",
      refusal: {
        details: [
          "S3 DeleteObjects on the state bucket failed: timed out after 30 s",
          "An unknown number of object versions and delete markers remain in it.",
          "The factory lock may still be held, or be gone.",
        ],
      },
    });
    const calls = w.lockStore.calls;
    const after = calls.slice(calls.findIndex((call) => call.startsWith("deleteBucket")) + 1);
    expect(after.filter((call) => call.startsWith("writeOperation"))).toEqual([]);
  });
});

describe("fffactory teardown: an interrupt keeps the lock", () => {
  test("before the lock, nothing is locked", async () => {
    const w = world();
    const result = await teardownFactory({ ...w.deps, interrupted: () => true }, request(w));
    expect(result).toEqual({ kind: "interrupted", locked: false });
    expect(w.lockStore.locks.size).toBe(0);
  });

  test("at the question, the lock and its record stay, and nothing is removed", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    let interrupted = false;
    const prompt = {
      ...fakePrompt({ interactive: true }).prompt,
      ask: async () => {
        interrupted = true;
        return FACTORY;
      },
    };
    const result = await teardownFactory(
      { ...w.deps, prompt, interrupted: () => interrupted },
      request(w, { confirm: undefined }),
    );
    expect(result).toMatchObject({ kind: "interrupted", locked: true, record: { bucket: BUCKET } });
    expect(w.lockStore.locks.size).toBe(1);
    expect(w.queue.reconcile).toEqual([]);
    expect(destroyed(w)).toEqual([]);
  });
});
