/**
 * The teardown use case (`docs/specs/teardown.md`): the happy path and its refusals, against
 * the in-memory state bucket, a factory whose Terraform state changes as plans apply, the
 * EC2 inventory that state backs, the tailnet, Secrets Manager and scripted workers.
 */
import { describe, expect, test } from "bun:test";
import type { ControlPlane } from "../../src/application/control-plane";
import { type AgentsObservation, OUTDATED_AGENTS } from "../../src/domain/control-plane";
import type { MachineInventorySource } from "../../src/application/machine-inventory";
import type { SecretListing } from "../../src/application/secret-store";
import {
  type TeardownDependencies,
  type TeardownProgress,
  type TeardownRequest,
  teardownFactory,
} from "../../src/application/teardown-factory";
import type { WorkflowQueue } from "../../src/application/workflow-queue";
import { inspectRemovability } from "../../src/application/worker-removability";
import { newLockRecord } from "../../src/domain/factory-lock";
import type {
  FactoryId,
  FactoryInstance,
  HostKey,
  SecretReference,
} from "../../src/domain/instance";
import {
  finishOperation,
  type OperationRecord,
  operationKey,
  serializeOperation,
  startOperation,
  withStage,
} from "../../src/domain/operation";
import type { ListedSecret } from "../../src/domain/secrets";
import type { Machine, MachineInventory, MachineState } from "../../src/domain/status";
import {
  CHECK_LISTED_DEVICES,
  CHECK_UNCHECKED_DEVICES,
  DEVICES_NOT_CHECKED,
  interruptedTeardown,
  ranWithoutLock,
  type TeardownStep,
  teardownQuestion,
  type VpcInventory,
} from "../../src/domain/teardown";
import type { PeerView, TailnetDevice } from "../../src/domain/tailnet";
import { FAKE_CALLER, fakeCallerIdentity } from "../support/doctor-fakes";
import { agentsIn, fakeControlPlane, fakeWorkflowQueue } from "../support/fake-control-plane";
import { fakeFactoryWorld, NETWORK_VPC } from "../support/fake-provisioner";
import { fakePrompt, fakeSecretStore, fakeSecretsManager } from "../support/fake-secrets";
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
import {
  ARCHIVE,
  BUCKET,
  declaring,
  FACTORY,
  NOW,
  PASEO_PASSWORD_ARN,
  RELEASE,
  WORKER_TAG,
} from "../support/factory-world";
import { MemoryLockStore, READY_BUCKET } from "../support/memory-lock-store";
import { MemoryPlanStore } from "../support/memory-plan-store";

const TERRAFORM = "/cache/releases/0.3.0/terraform";
const PATH = "/work/.fffactory/factory.json";
const hostname = (key: string) => `${FACTORY}-${key}`;
const arn = (name: string) =>
  `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${name}-AbCdEf` as SecretReference;

/** The auth key's reference, as `declaring` gives factory.json. */
const AUTH_ARN = arn(`${FACTORY}/tailscale-auth-key`);
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
/** Host `key`'s Paseo password, as `secret set` stores it and `declaring` refers to it. */
const password = (key: string) => secret(`${FACTORY}/${key}/paseo-password`);
/** The secrets a factory declaring `keys` owns: its own, and each host's Paseo password. */
const ownedBy = (keys: readonly string[]) => [...OWNED, ...keys.map(password)];

/** factory.json declaring `keys`, with the admin client and a harness credential source. */
function instanceOf(keys: readonly string[]): FactoryInstance {
  const base = declaring(...keys);
  return {
    ...base,
    tailscale: { ...base.tailscale, admin_client_secret: ADMIN_ARN },
    credentials: { github_token_secret: SOURCE_ARN },
  };
}

/** `instanceOf(keys)` with the log archive enabled, named `ARCHIVE`. */
const archivingOf = (keys: readonly string[]): FactoryInstance => ({
  ...instanceOf(keys),
  log_archive: { enabled: true },
});

interface WorldOptions {
  /** The declared workers and their machines' EC2 states; every one provisioned. */
  readonly workers?: Readonly<Record<string, MachineState>>;
  readonly agents?: AgentsObservation;
  readonly view?: PeerView;
  readonly worker?: (key: string) => Answer;
  readonly prompt?: ReturnType<typeof fakePrompt>;
  readonly devices?: readonly TailnetDevice[];
  readonly listing?: SecretListing;
  /** Replaces the EC2 instance listing, the VPC listing, or both. */
  readonly inventory?: MachineInventory;
  readonly vpcs?: VpcInventory;
  readonly dispatchFailure?: string;
  /** Instances tagged with the factory ID outside its Terraform state, listed with its own. */
  readonly strays?: Machine[];
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
        machines: [
          ...[...terraform.world.hosts].map(
            (key): Machine => ({
              instanceId: `i-${key}`,
              state: workers[key] ?? "running",
              hostKey: key,
            }),
          ),
          ...(options.strays ?? []),
        ],
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
  const control = fakeControlPlane("healthy", options.agents ?? agentsIn());
  const controlPlane: ControlPlane = {
    ...control.controlPlane,
    agents: async (worker) => {
      events.push(`activity ${worker.hostname}`);
      return control.controlPlane.agents(worker);
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
  // Secrets Manager as a world, so a rerun sees what the run before it deleted.
  const secrets = fakeSecretsManager({
    values: { [ADMIN_ARN]: ADMIN_SECRET },
    secrets: options.listing?.kind === "listed" ? options.listing.secrets : ownedBy(keys),
    ...(options.listing?.kind === "failed" ? { listing: options.listing } : {}),
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
  for (const { arn: owned } of ownedBy(w.keys)) {
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

/** Nothing the factory owns remains, as a rerun that finished leaves it. */
function expectNothingOwned(w: World, admin: ReturnType<typeof fakeTailnetAdmin> = w.admin) {
  expect(w.terraform.world.hosts.size).toBe(0);
  expect(w.terraform.world.network).toBe(false);
  expect(admin.devices().filter(({ hostName }) => hostName.startsWith(`${FACTORY}-`))).toEqual([]);
  expect(w.secrets.secrets()).toEqual([]);
  expect(w.planStore.directories.size).toBe(0);
  expect(w.lockStore.buckets.has(BUCKET)).toBe(false);
  expect(w.lockStore.locks.size).toBe(0);
}

/** The names of the secrets `w`'s factory owns, as its Secrets Manager lists them by default. */
const ownedNames = (w: World) => ownedBy(w.keys).map(({ name }) => name);

/** Why an admin client Secrets Manager still finds may not be readable: it is pending deletion. */
const PENDING_DELETION =
  "Secrets Manager does not read a secret pending deletion either, as the admin client is for a while once teardown deleted it: rerun `fffactory teardown` once it is gone.";

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
          removed: ownedNames(w),
          kept: { tagged: [], referenced: [SOURCE_ARN] },
        },
        bucket: { name: BUCKET, outcome: "deleted" },
        withoutLock: undefined,
      },
    });
    expectAllRemoved(w);
    expectNothingAfterBucket(w);
    const [plan] = w.terraform.calls.filter(({ call }) => call === "plan");
    expect(plan?.request).toMatchObject({ destroy: true, stateLock: true });
    expect(w.prompt.asked).toEqual([]);
  });

  test("removes a worker whose only agents are finished, its work pushed, without --force (#92)", async () => {
    // Finished dispatch and epic agents stay listed; by the busy rule they never refuse.
    const w = world({
      workers: { "builder-1": "running" },
      agents: agentsIn("finished", "finished", "failed", "stopped"),
    });
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({ kind: "done" });
    expectAllRemoved(w);
  });

  test("refuses a worker on a release from before agent states, checked by hand first", async () => {
    const w = world({ workers: { "builder-1": "running" }, agents: { kind: "outdated" } });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `${hostname("builder-1")} could not be inspected for busy agents: ${OUTDATED_AGENTS}`,
          nextAction: expect.stringContaining(
            "then terminate it with --force: `fffactory worker terminate builder-1 --force`, " +
              "and rerun `fffactory teardown`.",
          ),
        },
      ],
    });
    expectNothingRemoved(w);
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
    expect(w.control.calls).toEqual(["agents"]);
    // The record was written at each step until the bucket went, and went with it.
    expect(w.lockStore.operationWrites.map(({ stages }) => stages[0]?.status)).toEqual([
      "authorizing",
      "inventorying",
      "planning",
      "stopping_dispatch",
      // Each worker's dispatch, as stopping it ended.
      "stopping_dispatch",
      "inspecting",
      // Each running worker's inspection, once every one is inspected.
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
        bucket: { name: BUCKET, outcome: "deleted" },
        withoutLock: undefined,
      },
    });
    // The review comes before the question, and nothing was stopped before it was answered.
    expect(w.lockStore.operationWrites.map(({ stages }) => stages[0]?.status)).toContain(
      "awaiting_approval",
    );
  });

  test("names no log archive while factory.json does not enable one", async () => {
    const prompt = fakePrompt({ interactive: true, answers: [FACTORY] });
    const w = world({ prompt });
    const result = await teardownFactory(w.deps, request(w, { confirm: undefined }));
    expect(result.kind === "done" && result.report.archive).toBeUndefined();
    const review = w.progress.find((event) => event.kind === "review");
    expect(review?.kind === "review" && review.review.archive).toBeUndefined();
    expect(prompt.asked).toEqual([teardownQuestion(FACTORY)]);
  });

  test("keeps the log archive: reviewed, asked and reported by name, S3 never asked about it", async () => {
    const prompt = fakePrompt({ interactive: true, answers: [FACTORY] });
    const w = world({ workers: { "builder-1": "stopped" }, prompt });
    const result = await teardownFactory(
      w.deps,
      request(w, { confirm: undefined, instance: archivingOf(w.keys) }),
    );
    expect(result).toMatchObject({ kind: "done", report: { archive: ARCHIVE } });
    expect(w.progress.find((event) => event.kind === "review")).toMatchObject({
      review: { archive: ARCHIVE },
    });
    expect(prompt.asked).toEqual([teardownQuestion(FACTORY, false, ARCHIVE)]);
    expectAllRemoved(w);
    // Named from factory.json alone: nothing about the archive reached S3, and the destroy
    // planned only the factory root.
    expect(w.lockStore.calls.filter((call) => call.includes(ARCHIVE))).toEqual([]);
    expect(w.terraform.calls.map(({ request }) => request.configuration.root)).not.toContain(
      "archive",
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
    // An empty state: no resource, and no root output either.
    w.terraform.world.network = false;
    w.terraform.world.rootOutputs = false;
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "done",
      report: { infrastructure: "absent", changes: [] },
    });
    expect(destroyed(w)).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(false);
  });
});

/**
 * What `worker inspect --json` prints of each declared worker in a world made with `options`:
 * its own world, so teardown's is asked nothing by it.
 */
async function printedBy(options: WorldOptions) {
  const w = world(options);
  const removability = await inspectRemovability(w.deps, {
    instance: instanceOf(w.keys),
    key: undefined,
    credentials: { source: "--profile", profile: "factory" },
  });
  if (removability.kind !== "inspected") throw new Error(`not inspected: ${removability.kind}`);
  return removability.workers.map(({ inspection }) => inspection);
}

/** The first record written with inspections, and its stage's status then. */
const firstInspected = (w: World) => {
  const record = w.lockStore.operationWrites.find((written) => written.inspections !== undefined);
  return { status: record?.stages[0]?.status, inspections: record?.inspections };
};

describe("fffactory teardown: its record carries each inspection (teardown §Operation record)", () => {
  test("one per running worker, as worker inspect prints it, written with the inspecting step before the destroy", async () => {
    const options: WorldOptions = {
      workers: { "builder-1": "running", "builder-2": "running", "builder-3": "stopped" },
    };
    const w = world(options);
    expect((await teardownFactory(w.deps, request(w))).kind).toBe("done");
    // builder-3, stopped, passes uninspected: only the running workers are recorded.
    const documents = await printedBy(options);
    expect(documents.map(({ verdict }) => verdict)).toEqual([
      "removable",
      "removable",
      "not_inspected",
    ]);
    expect(firstInspected(w)).toEqual({
      status: "inspecting",
      inspections: documents.slice(0, 2).map((document) => ({ forced: false, document })),
    });
    const statuses = w.lockStore.operationWrites.map(({ stages }) => stages[0]?.status);
    const inspected = w.lockStore.operationWrites.findIndex(({ inspections }) => inspections);
    expect(statuses.indexOf("applying")).toBeGreaterThan(inspected);
  });

  test("a refusal among them is recorded with the rest, to the record's end", async () => {
    const options: WorldOptions = {
      workers: { "builder-1": "running", "builder-2": "running" },
      worker: (key) =>
        statusAnswers(
          readyWorker(FACTORY, key, RELEASE),
          "synchronized",
          key === "builder-2" ? ["/workspace/repos/scratch"] : [],
        ),
    };
    const w = world(options);
    expect((await teardownFactory(w.deps, request(w))).kind).toBe("refused");
    const documents = await printedBy(options);
    expect(documents.map(({ verdict }) => verdict)).toEqual(["removable", "refused"]);
    const recorded = records(w)[0];
    expect(recorded).toMatchObject({ status: "refused" });
    // Byte for byte as `worker inspect --json` prints each.
    expect(JSON.stringify(recorded?.inspections, null, 2)).toBe(
      JSON.stringify(
        documents.map((document) => ({ forced: false, document })),
        null,
        2,
      ),
    );
  });

  test("none before every running worker is inspected: refused by changed machines, there are none", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    const machines = changingMachines(w.deps.machines, () => ({ kind: "machines", machines: [] }));
    expect((await teardownFactory({ ...w.deps, machines }, request(w))).kind).toBe("refused");
    for (const written of w.lockStore.operationWrites)
      expect(Object.keys(written)).not.toContain("inspections");
  });

  test("a final write that fails leaves the refusal as it was, the inspections already recorded", async () => {
    const w = world({ workers: { "builder-1": "running" }, agents: agentsIn("working") });
    const write = w.lockStore.writeOperation.bind(w.lockStore);
    w.lockStore.writeOperation = async (bucket, record) => {
      if (record.finished_at !== null) throw new Error("S3 PutObject failed: AccessDenied");
      await write(bucket, record);
    };
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "refused",
      recordFailure: "S3 PutObject failed: AccessDenied",
    });
    expect(records(w)[0]).toMatchObject({
      status: "running",
      inspections: [{ forced: false, document: { verdict: "refused" } }],
    });
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

  test("refuses busy agents, naming the worker and how many of each; dispatch is left stopped", async () => {
    const w = world({
      workers: { "builder-1": "running", "builder-2": "running" },
      agents: agentsIn("working", "needs_input", "finished"),
    });
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `1 agent is working and 1 needs input on ${hostname("builder-1")}: terminating it would end them`,
          nextAction:
            "Wait until no agent there is working or needs input, then rerun `fffactory teardown`. " +
            "To remove the worker anyway, run `fffactory worker terminate builder-1 --force` first.",
        },
        {
          summary: `1 agent is working and 1 needs input on ${hostname("builder-2")}: terminating it would end them`,
        },
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
            "Terraform's destroy plan reports changes, but its JSON plan changes no resource or output",
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

  test.each([
    {
      // DescribeSecret still finds it: it is not gone, only unreadable, perhaps pending deletion.
      found: "still found",
      presence: { kind: "present" },
      details: [PENDING_DELETION],
    },
    {
      found: "its look failed",
      presence: { kind: "failed", reason: "Secrets Manager DescribeSecret failed: AccessDenied" },
      details: [],
    },
  ] as const)(
    "refuses an admin client whose secret cannot be read ($found)",
    async ({ presence, details }) => {
      const w = world({ workers: { "builder-1": "running" } });
      const secrets = fakeSecretStore({
        readFailsWith: new Error(
          "Reading the secret from Secrets Manager failed: AccessDeniedException",
        ),
        presence: [presence],
      });
      const result = await teardownFactory({ ...w.deps, secrets: secrets.store }, request(w));
      expect(result).toMatchObject({
        kind: "refused",
        refusals: [
          {
            summary: "Reading the secret from Secrets Manager failed: AccessDeniedException",
            details,
            nextAction:
              "Check that the credentials may call secretsmanager:GetSecretValue on the secret " +
              "tailscale.admin_client_secret refers to, then rerun `fffactory teardown`.",
          },
        ],
      });
      expect(w.admin.calls).toEqual([]);
      expectNothingRemoved(w);
    },
  );
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
          "Remains: tailnet devices n0CNTRL",
          `Remains: owned secrets ${ownedNames(w).join(", ")}`,
          "Remains: the local saved plans",
          `Remains: the state bucket ${BUCKET}`,
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
          "The admin client was kept, so a rerun can delete them.",
          "Remains: tailnet devices n0CNTRL",
          `Remains: owned secrets ${ownedNames(w).join(", ")}`,
          "Remains: the local saved plans",
          `Remains: the state bucket ${BUCKET}`,
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
          `Remains: owned secrets ${ownedNames(w).join(", ")}`,
          "Remains: the local saved plans",
          `Remains: the state bucket ${BUCKET}`,
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
          "Deleting the factory lock's versions stopped part way: teardown released it by its version.",
          `Remains: the state bucket ${BUCKET}`,
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

describe("fffactory teardown: each failure point lists what remains, and a rerun finishes it (teardown §Partial failure, §Rerun)", () => {
  test("the destroy failing part way: the state still holds resources and no root output, and the rerun destroys them", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    // The root outputs go first, then the host: it fails before the network.
    w.terraform.world.beforeChange = (applied) => {
      if (applied === 2) throw new Error("`terraform apply` exited with status 1");
    };
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "destroy",
      remaining: {
        state: true,
        devices: ["n0CNTRL"],
        secrets: ownedNames(w),
        plans: true,
        bucket: BUCKET,
      },
      refusal: {
        summary:
          "Destroying the factory's resources failed: `terraform apply` exited with status 1",
        nextAction: "Rerun `fffactory teardown`: it plans the destroy again from what exists now.",
      },
    });
    expect(w.terraform.world.hosts.size).toBe(0);
    expect(w.terraform.world.network).toBe(true);
    // As Terraform leaves a destroy stopped part way: resources, and no root output.
    expect(w.terraform.world.rootOutputs).toBe(false);
    expect(w.lockStore.locks.size).toBe(0);
    w.terraform.world.beforeChange = undefined;
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      report: {
        infrastructure: "destroyed",
        devices: { removed: ["n0CNTRL"] },
        secrets: { removed: ownedNames(w), absent: [] },
      },
    });
    expectNothingOwned(w);
  });

  test("tagged resources left after the destroy stop the run until removed by hand (D12)", async () => {
    const strays: Machine[] = [{ instanceId: "i-0stray", state: "running", hostKey: undefined }];
    const w = world({ workers: { "builder-1": "stopped" }, strays });
    const leftover = {
      kind: "partial",
      stoppedAt: "leftovers",
      remaining: { state: false, devices: ["n0CNTRL"], secrets: ownedNames(w), plans: true },
      refusal: {
        nextAction:
          "Check them in the EC2 console and remove those that are this factory's yourself, then rerun `fffactory teardown`.",
      },
    };
    expect(await teardownFactory(w.deps, request(w))).toMatchObject(leftover);
    // The rerun finds the factory's root already destroyed, and the stray still there.
    expect(await teardownFactory(w.deps, request(w))).toMatchObject(leftover);
    expect(w.admin.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    strays.length = 0;
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      report: { infrastructure: "absent", devices: { removed: ["n0CNTRL"] } },
    });
    expectNothingOwned(w);
  });

  /**
   * `provisioner`, whose `output` once the destroy applied answers `outputs` once: what a state
   * read after the destroy finds. Only a stub can make a state that still records a host EC2 no
   * longer lists (D12's defence in depth): a real one would list the instance, which the leftover
   * check finds first, or drop the record when its refresh finds the instance gone.
   */
  function stateAfterDestroy(w: World, outputs: Readonly<Record<string, unknown>>) {
    const { provisioner } = w.terraform;
    let answered = false;
    return {
      ...provisioner,
      output: async (target: Parameters<typeof provisioner.output>[0]) => {
        if (destroyed(w).length === 0 || answered) return provisioner.output(target);
        answered = true;
        return outputs;
      },
    };
  }

  test("a state still recording hosts after the destroy stops the run (D12); a rerun reading a state that records none finishes", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    const provisioner = stateAfterDestroy(w, { host_keys: ["builder-1"] });
    expect(await teardownFactory({ ...w.deps, provisioner }, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "leftovers",
      refusal: {
        summary: "The factory's Terraform state still records hosts after the destroy",
        details: expect.arrayContaining(["Host builder-1"]),
        nextAction:
          "Rerun `fffactory teardown`: it plans the destroy again from what the state records.",
      },
    });
    expect(w.admin.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    // The rerun reads the state the destroy left, which records nothing: nothing to destroy.
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      report: { infrastructure: "absent", devices: { removed: ["n0CNTRL"] } },
    });
    expect(destroyed(w)).toHaveLength(1);
    expectNothingOwned(w);
  });

  /**
   * `w` with its state stripped of every resource but still recording its root outputs, as the
   * PR #89 review reproduced it: a state that records root outputs but no resource.
   */
  function outputsOnly(w: World) {
    w.terraform.world.hosts.clear();
    w.terraform.world.network = false;
    expect(w.terraform.world.rootOutputs).toBe(true);
  }

  test("a state recording only root outputs: the rerun applies the output-only plan and ends `done` with nothing owned", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    outputsOnly(w);
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      // The plan changes no resource: the state records none.
      report: {
        infrastructure: "absent",
        changes: [],
        devices: { removed: ["n0CNTRL"] },
        secrets: { removed: ownedNames(w), absent: [] },
      },
    });
    // The output-only plan was applied, its outputs deleted, and nothing left recorded.
    expect(destroyed(w)).toHaveLength(1);
    expect(w.terraform.world.rootOutputs).toBe(false);
    expectNothingOwned(w);
  });

  test("an output-only plan's apply is checked too: a state still recording hosts after it stops the run (D12)", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    outputsOnly(w);
    // The state is read once the plan applied, though it destroyed no resource.
    const provisioner = stateAfterDestroy(w, { host_keys: ["builder-1"] });
    expect(await teardownFactory({ ...w.deps, provisioner }, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "leftovers",
      refusal: {
        summary: "The factory's Terraform state still records hosts after the destroy",
        details: expect.arrayContaining(["Host builder-1"]),
      },
    });
    expect(destroyed(w)).toHaveLength(1);
    expect(w.admin.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(w.secrets.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  test("a state holding only root outputs, the admin client gone: no resource remains, so it finishes", async () => {
    const w = world({ listing: { kind: "listed", secrets: [OWNED[0] as ListedSecret] } });
    // No resource left, the state still recording its outputs: not a resource that remains.
    w.terraform.world.network = false;
    expect(w.terraform.world.rootOutputs).toBe(true);
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      report: {
        infrastructure: "absent",
        changes: [],
        devicesUnchecked: DEVICES_NOT_CHECKED,
        secrets: { removed: [`${FACTORY}/tailscale-auth-key`] },
      },
    });
    const [plan] = w.terraform.calls.filter(({ call }) => call === "plan");
    expect(plan?.request).toMatchObject({ destroy: true });
    expect(destroyed(w)).toHaveLength(1);
    expect(w.terraform.world.rootOutputs).toBe(false);
    expectNothingOwned(w);
  });

  test("a state whose host keys cannot be read after the destroy stops the run, naming fffactory plan", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    const provisioner = stateAfterDestroy(w, { host_keys: "builder-1" });
    expect(await teardownFactory({ ...w.deps, provisioner }, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "leftovers",
      refusal: {
        summary: "The host keys the factory's Terraform state records could not be read",
        nextAction:
          "Check the factory's Terraform state with `fffactory plan`, then rerun `fffactory teardown`.",
      },
    });
    expect((await teardownFactory(w.deps, request(w))).kind).toBe("done");
    expectNothingOwned(w);
  });

  test("a device not deleted keeps the secrets, the admin client among them, for the rerun", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    const failing: Record<string, string> = { n0CNTRL: "Tailscale answered HTTP 500" };
    const admin = fakeTailnetAdmin({
      devices: [tailnetDevice("n0CNTRL", hostname("builder-1"), [WORKER_TAG])],
      failing,
    });
    const deps = { ...w.deps, tailnetAdmin: admin.admin };
    expect(await teardownFactory(deps, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "devices",
      remaining: { devices: ["n0CNTRL"], secrets: ownedNames(w), plans: true, bucket: BUCKET },
    });
    expect(w.secrets.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    delete failing.n0CNTRL;
    expect(await teardownFactory(deps, request(w))).toMatchObject({
      kind: "done",
      report: {
        infrastructure: "absent",
        devices: { removed: ["n0CNTRL"] },
        devicesUnchecked: undefined,
      },
    });
    expectNothingOwned(w, admin);
  });

  const DENIED = {
    kind: "failed",
    reason: "Secrets Manager DeleteSecret failed: AccessDeniedException",
  } as const;

  test.each([
    {
      case: "denied",
      fail: (w: World) => w.secrets.removeFails.set(AUTH_ARN, DENIED),
      reason: "Secrets Manager DeleteSecret failed: AccessDeniedException",
      listing: ownedBy(["builder-1"]),
    },
    {
      case: "still pending, its restore refused",
      fail: (w: World) =>
        w.secrets.restoreFails.set(AUTH_ARN, {
          kind: "failed",
          reason: "Secrets Manager RestoreSecret failed: AccessDeniedException",
        }),
      reason: "Secrets Manager RestoreSecret failed: AccessDeniedException",
      listing: [
        { ...(OWNED[0] as ListedSecret), pendingDeletion: true },
        OWNED[1] as ListedSecret,
        password("builder-1"),
      ],
    },
    {
      case: "still found at the deadline",
      fail: (w: World) => w.secrets.lingering.add(AUTH_ARN),
      reason: "Secrets Manager still finds it 60 s after its deletion",
      listing: ownedBy(["builder-1"]),
    },
  ])(
    "a secret that remains ($case) keeps the bucket; the rerun, its admin client gone, finishes",
    async ({ fail, reason, listing }) => {
      const w = world({
        workers: { "builder-1": "stopped" },
        listing: { kind: "listed", secrets: listing },
      });
      fail(w);
      expect(await teardownFactory(w.deps, request(w))).toMatchObject({
        kind: "partial",
        stoppedAt: "secrets",
        remaining: {
          devices: [],
          secrets: [`${FACTORY}/tailscale-auth-key`],
          plans: true,
          bucket: BUCKET,
        },
        refusal: {
          summary: "Not every secret the factory owns is gone",
          details: expect.arrayContaining([`${FACTORY}/tailscale-auth-key: ${reason}`]),
        },
      });
      // The admin client was deleted after the devices; the rerun cannot list them again.
      expect(w.secrets.secrets().map(({ arn: left }) => left)).toEqual([AUTH_ARN]);
      w.secrets.removeFails.clear();
      w.secrets.restoreFails.clear();
      w.secrets.lingering.clear();
      const progress = w.progress.length;
      expect(await teardownFactory(w.deps, request(w))).toMatchObject({
        kind: "done",
        report: {
          infrastructure: "absent",
          devices: { removed: [], possible: [], untagged: [] },
          devicesUnchecked: DEVICES_NOT_CHECKED,
          secrets: {
            removed: [`${FACTORY}/tailscale-auth-key`],
            absent: [ADMIN_ARN, PASEO_PASSWORD_ARN],
          },
        },
      });
      expect(w.progress.slice(progress)).toContainEqual(
        expect.objectContaining({
          kind: "review",
          review: expect.objectContaining({ devicesUnchecked: DEVICES_NOT_CHECKED }),
        }),
      );
      expectNothingOwned(w);
    },
  );

  test("devices listed but kept stay reported past the devices step; reruns without the admin client say they were not checked", async () => {
    const devices = [
      tailnetDevice("n0CNTRL", hostname("builder-1"), [WORKER_TAG]),
      tailnetDevice("nU", hostname("builder-1"), []),
    ];
    const w = world({ workers: { "builder-1": "stopped" }, devices });
    const late = [tailnetDevice("nL", hostname("late"), [WORKER_TAG])];
    const tailnetAdmin = withLateDevices(w.admin, late);
    const deps = { ...w.deps, tailnetAdmin };
    w.secrets.removeFails.set(AUTH_ARN, DENIED);
    const listedDevices = {
      possible: [{ id: "nL", hostname: hostname("late") }],
      untagged: [{ id: "nU", hostname: hostname("builder-1") }],
    };
    expect(await teardownFactory(deps, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "secrets",
      remaining: { devices: [], listedDevices, secrets: [`${FACTORY}/tailscale-auth-key`] },
      refusal: {
        details: expect.arrayContaining([
          `Listed, not deleted: tailnet devices nL (${hostname("late")}), nU (${hostname("builder-1")})`,
          CHECK_LISTED_DEVICES,
        ]),
      },
    });
    // The admin client went after the devices: no rerun can list them again.
    expect(w.secrets.secrets().map(({ arn: left }) => left)).toEqual([AUTH_ARN]);
    const unchecked = {
      kind: "partial",
      stoppedAt: "secrets",
      remaining: { devices: "unchecked", listedDevices: { possible: [], untagged: [] } },
      refusal: {
        details: expect.arrayContaining([
          `Tailnet devices: ${DEVICES_NOT_CHECKED}`,
          CHECK_UNCHECKED_DEVICES,
        ]),
      },
    };
    expect(await teardownFactory(deps, request(w))).toMatchObject(unchecked);
    w.secrets.removeFails.clear();
    expect(await teardownFactory(deps, request(w))).toMatchObject({
      kind: "done",
      report: { devicesUnchecked: DEVICES_NOT_CHECKED },
    });
    expect(w.admin.devices().map(({ id }) => id)).toEqual(["nU"]);
  });

  test("the admin client still found after its deletion: the rerun is refused until it is gone, then finishes", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    w.secrets.lingering.add(ADMIN_ARN);
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "secrets",
      remaining: { devices: [], secrets: [`${FACTORY}/tailscale-admin-client`] },
      refusal: {
        details: expect.arrayContaining([
          `${FACTORY}/tailscale-admin-client: Secrets Manager still finds it 60 s after its deletion`,
        ]),
      },
    });
    // Pending deletion, it cannot be read, and DescribeSecret still finds it: never taken for gone.
    const calls = w.secrets.calls.length;
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: "Reading the secret from Secrets Manager failed: InvalidRequestException",
          details: [PENDING_DELETION],
        },
      ],
    });
    expect(w.secrets.calls.slice(calls)).toEqual([`exists ${ADMIN_ARN}`]);
    expect(w.lockStore.locks.size).toBe(0);
    w.secrets.finishDeletion(ADMIN_ARN);
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      report: {
        infrastructure: "absent",
        devicesUnchecked: DEVICES_NOT_CHECKED,
        secrets: { removed: [], absent: [AUTH_ARN, ADMIN_ARN, PASEO_PASSWORD_ARN] },
      },
    });
    expectNothingOwned(w);
  });

  test("the admin client not deleted keeps it readable: the rerun lists and deletes devices as the first would", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    w.secrets.removeFails.set(ADMIN_ARN, DENIED);
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "secrets",
      remaining: { secrets: [`${FACTORY}/tailscale-admin-client`] },
    });
    w.secrets.removeFails.clear();
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      report: {
        devicesUnchecked: undefined,
        secrets: {
          removed: [`${FACTORY}/tailscale-admin-client`],
          absent: [AUTH_ARN, PASEO_PASSWORD_ARN],
        },
      },
    });
    expect(w.admin.calls.filter((call) => call === "devices").length).toBeGreaterThan(2);
    expectNothingOwned(w);
  });

  test("a secret listed as pending deletion is restored, then deleted for good", async () => {
    const pending = { ...(OWNED[0] as ListedSecret), pendingDeletion: true };
    const w = world({ listing: { kind: "listed", secrets: [pending, OWNED[1] as ListedSecret] } });
    expect((await teardownFactory(w.deps, request(w))).kind).toBe("done");
    expect(w.secrets.calls).toContain(`restore ${AUTH_ARN}`);
    expectNothingOwned(w);
  });

  test.each(["held", "unknown", "deleted"] as const)(
    "a bucket that remains (its lock %s) is all that is left; the rerun deletes it",
    async (lock) => {
      const w = world({ workers: { "builder-1": "stopped" } });
      w.lockStore.deletionLeaves = {
        kind: "remains",
        versions: 1,
        codes: ["AccessDenied"],
        failure: undefined,
        lock,
      };
      expect(await teardownFactory(w.deps, request(w))).toMatchObject({
        kind: "partial",
        stoppedAt: "bucket",
        remaining: { state: false, devices: [], secrets: [], plans: false, bucket: BUCKET },
        refusal: { summary: `The state bucket ${BUCKET} remains` },
      });
      expect(w.lockStore.locks.size).toBe(0);
      w.lockStore.deletionLeaves = undefined;
      expect(await teardownFactory(w.deps, request(w))).toMatchObject({
        kind: "done",
        report: {
          infrastructure: "absent",
          devicesUnchecked: DEVICES_NOT_CHECKED,
          secrets: { removed: [], absent: [AUTH_ARN, ADMIN_ARN, PASEO_PASSWORD_ARN] },
        },
      });
      expectNothingOwned(w);
    },
  );

  test("an error once the destroy started says how far it got and what remains; the rerun finishes", async () => {
    const w = world();
    const removeAll = w.planStore.removeAll.bind(w.planStore);
    w.planStore.removeAll = async () => {
      throw new Error("the local plans could not be removed (EACCES)");
    };
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "plans",
      remaining: { devices: [], secrets: [], plans: true, bucket: BUCKET },
      refusal: {
        summary: "the local plans could not be removed (EACCES)",
        details: ["Remains: the local saved plans", `Remains: the state bucket ${BUCKET}`],
        nextAction: "Check the factory with `fffactory status`, then rerun `fffactory teardown`.",
      },
    });
    w.planStore.removeAll = removeAll;
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      report: {
        infrastructure: "absent",
        devicesUnchecked: DEVICES_NOT_CHECKED,
        secrets: { removed: [], absent: [AUTH_ARN, ADMIN_ARN] },
      },
    });
    expectNothingOwned(w);
  });
});

describe("fffactory teardown: a rerun (teardown §Rerun)", () => {
  test.each<{
    case: string;
    workers: Readonly<Record<string, MachineState>>;
    vpcs: VpcInventory | undefined;
  }>([
    { case: "EC2 still lists its machines", workers: { "builder-1": "running" }, vpcs: undefined },
    { case: "its state still holds resources", workers: {}, vpcs: { kind: "vpcs", vpcIds: [] } },
  ])(
    "refuses an admin client gone while the factory's resources remain ($case), removing nothing",
    async ({ workers, vpcs }) => {
      const w = world({
        workers,
        ...(vpcs === undefined ? {} : { vpcs }),
        listing: { kind: "listed", secrets: [OWNED[0] as ListedSecret] },
      });
      expect(await teardownFactory(w.deps, request(w))).toMatchObject({
        kind: "refused",
        refusals: [
          {
            summary:
              "The Tailscale admin client's secret no longer exists, but the factory's resources remain",
          },
        ],
        dispatchStopped: [],
      });
      expect(w.queue.reconcile).toEqual([]);
      expectNothingRemoved(w);
    },
  );

  test("an admin client outside the factory's names that cannot be read is refused, never taken for gone", async () => {
    const w = world();
    const elsewhere = arn("fffv/tailscale-admin-client");
    const base = instanceOf([]);
    const instance = { ...base, tailscale: { ...base.tailscale, admin_client_secret: elsewhere } };
    expect(await teardownFactory(w.deps, request(w, { instance }))).toMatchObject({
      kind: "refused",
      refusals: [
        { summary: "Reading the secret from Secrets Manager failed: ResourceNotFoundException" },
      ],
    });
    expect(w.secrets.calls).not.toContain(`exists ${elsewhere}`);
    expectNothingRemoved(w);
  });

  test("an admin client in another Region than the factory's is looked for in its own Region", async () => {
    const elsewhere =
      `arn:aws:secretsmanager:us-east-1:123456789012:secret:${FACTORY}/tailscale-admin-client-AbCdEf` as SecretReference;
    // Pending deletion in us-east-1: asked about in the factory's Region, it would be absent.
    const pending: ListedSecret = {
      ...secret(`${FACTORY}/tailscale-admin-client`),
      arn: elsewhere,
    };
    const w = world({
      listing: {
        kind: "listed",
        secrets: [OWNED[0] as ListedSecret, { ...pending, pendingDeletion: true }],
      },
    });
    // Nothing else of the factory is left: an admin client taken for gone would finish.
    w.terraform.world.network = false;
    const base = instanceOf([]);
    const instance = { ...base, tailscale: { ...base.tailscale, admin_client_secret: elsewhere } };
    expect(await teardownFactory(w.deps, request(w, { instance }))).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: "Reading the secret from Secrets Manager failed: ResourceNotFoundException",
          details: [PENDING_DELETION],
        },
      ],
    });
    expect(w.secrets.calls).toEqual([`exists ${elsewhere}`]);
    expectNothingRemoved(w);
  });

  test("a state bucket S3 answers 403 for is refused before any lock, never taken for the factory's", async () => {
    const w = world();
    w.lockStore.unreachable.add(BUCKET);
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `The state bucket ${BUCKET} cannot be reached in account 123456789012 (S3 answered 403)`,
        },
      ],
      operation: undefined,
    });
    expect(w.lockStore.calls.filter((call) => !call.startsWith("bucketExists"))).toEqual([]);
    expect(w.terraform.calls).toEqual([]);
  });

  test("a machine reviewed shutting down that terminates meanwhile is no change", async () => {
    const w = world({
      strays: [{ instanceId: "i-0old", state: "shutting-down", hostKey: "old" }],
    });
    const machines = changingMachines(w.deps.machines, (listed) => ({
      kind: "machines",
      machines: listed.filter(({ instanceId }) => instanceId !== "i-0old"),
    }));
    expect((await teardownFactory({ ...w.deps, machines }, request(w))).kind).toBe("done");
  });

  test("an error after dispatch was stopped fails it, naming where dispatch is stopped", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    const controlPlane: ControlPlane = {
      ...w.control.controlPlane,
      agents: async () => {
        throw new Error("the worker answered something fffactory cannot read");
      },
    };
    expect(await teardownFactory({ ...w.deps, controlPlane }, request(w))).toMatchObject({
      kind: "failed",
      refusal: { summary: "the worker answered something fffactory cannot read" },
      dispatchStopped: [hostname("builder-1")],
    });
    expectNothingRemoved(w);
  });

  test("a plan directory that cannot be removed never turns a finished refusal into a failure", async () => {
    const w = world({
      workers: { "builder-1": "running" },
      agents: agentsIn("working"),
    });
    w.planStore.remove = async () => {
      throw new Error("ENOENT: the plan directory is gone");
    };
    expect((await teardownFactory(w.deps, request(w))).kind).toBe("refused");
    expect(records(w)[0]).toMatchObject({ status: "refused" });
    expect(w.lockStore.locks.size).toBe(0);
  });
});

/** Secrets Manager refusing to describe a secret: its ownership cannot be told. */
const DESCRIBE_DENIED = {
  kind: "failed",
  reason: "Secrets Manager DescribeSecret failed: AccessDeniedException",
} as const;

/** The refusal of a reference ListSecrets did not list and DescribeSecret could not be asked about. */
const unresolved = (reference: SecretReference) => ({
  summary: `The secret ${reference} could not be looked up: ${DESCRIBE_DENIED.reason}`,
  nextAction:
    "Check your network connection and that the credentials may call secretsmanager:DescribeSecret, then rerun `fffactory teardown`.",
});

/** The finished report's secrets. */
function reportedSecrets(result: Awaited<ReturnType<typeof teardownFactory>>) {
  if (result.kind !== "done") throw new Error(`teardown ended ${result.kind}`);
  return result.report.secrets;
}

describe("fffactory teardown: a rerun remembers the host keys an earlier run knew (teardown §Devices, §Rerun)", () => {
  /** A hand-chosen factory ID (D9): its tagged namespace devices of no known key are only listed. */
  const HAND = "acme" as FactoryId;
  const GHOST_DEVICE = { id: "nG", hostname: `${HAND}-ghost` };

  /** Each run's own random bytes, so each takes its own lock ID and writes its own record. */
  let runs = 0;
  const ownRun = () => {
    runs += 1;
    const fill = runs;
    return (count: number) => new Uint8Array(count).fill(fill);
  };

  /**
   * A hand-chosen factory declaring `builder-1`, and `ghost`, which EC2 lists in `ghostState`
   * outside the factory's Terraform state, as `worker terminate` leaves a host it removed while
   * its machine shuts down: known only by its host key tag. A machine shutting down finishes
   * terminating as the destroy runs. Each has a tagged device; `failing` names those whose
   * deletion fails.
   */
  function ghostWorld(
    failing: Record<string, string> = {},
    ghostState: MachineState = "shutting-down",
  ) {
    const strays: Machine[] = [{ instanceId: "i-ghost", state: ghostState, hostKey: "ghost" }];
    const w = world({ workers: { "builder-1": "stopped" }, strays });
    const admin = fakeTailnetAdmin({
      devices: [
        tailnetDevice("n1", `${HAND}-builder-1`, [WORKER_TAG]),
        tailnetDevice("nG", `${HAND}-ghost`, [WORKER_TAG]),
      ],
      failing,
    });
    if (ghostState === "shutting-down")
      w.terraform.world.beforeChange = () => {
        strays.length = 0;
      };
    const deps: TeardownDependencies = { ...w.deps, tailnetAdmin: admin.admin };
    const instance = { ...instanceOf(["builder-1"]), factory_id: HAND };
    const run = (overrides: Partial<TeardownRequest> = {}) =>
      request(w, { confirm: HAND, instance, randomBytes: ownRun(), ...overrides });
    return { w, admin, deps, run, strays };
  }

  /** The devices the last review showed deleted. */
  const reviewedDeleted = (w: World) =>
    w.progress
      .flatMap((event) => (event.kind === "review" ? [event.review.devices.deleted] : []))
      .at(-1);

  test("a device of a key EC2 alone named, not deleted once the destroy completed, is deleted by the rerun", async () => {
    const failing: Record<string, string> = { nG: "Tailscale answered HTTP 500" };
    const g = ghostWorld(failing);
    expect(await teardownFactory(g.deps, g.run())).toMatchObject({
      kind: "partial",
      stoppedAt: "devices",
      remaining: { devices: ["nG"], bucket: BUCKET },
    });
    // EC2 no longer lists it, the state records nothing and factory.json never declared it.
    expect(g.strays).toEqual([]);
    expect(g.w.terraform.world.hosts.size).toBe(0);
    delete failing.nG;
    expect(await teardownFactory(g.deps, g.run())).toMatchObject({
      kind: "done",
      report: { devices: { removed: ["nG"], possible: [], untagged: [] } },
    });
    // Shown deleted in the review like any other known key's device: devices shown are deleted.
    expect(reviewedDeleted(g.w)).toEqual([GHOST_DEVICE]);
    expect(g.admin.devices()).toEqual([]);
  });

  test("an interrupt once the destroy completed, then a rerun, deletes the device", async () => {
    const g = ghostWorld();
    let interrupted = false;
    const { provisioner } = g.w.terraform;
    const destroying: TeardownDependencies = {
      ...g.deps,
      provisioner: {
        ...provisioner,
        applyPlan: async (plan) => {
          await provisioner.applyPlan(plan);
          interrupted = true;
        },
      },
      interrupted: () => interrupted,
    };
    expect(await teardownFactory(destroying, g.run())).toMatchObject({
      kind: "interrupted",
      locked: true,
      removing: true,
    });
    expect(g.admin.devices().map(({ id }) => id)).toEqual(["n1", "nG"]);
    // Once fffactory has exited, the operator breaks the lock it kept.
    g.w.lockStore.locks.clear();
    expect(await teardownFactory(g.deps, g.run())).toMatchObject({
      kind: "done",
      report: { devices: { removed: ["n1", "nG"], possible: [] } },
    });
    expect(g.admin.devices()).toEqual([]);
  });

  test("tagged leftovers removed by hand after the destroy, then a rerun, deletes the device", async () => {
    const g = ghostWorld({}, "stopped");
    expect(await teardownFactory(g.deps, g.run())).toMatchObject({
      kind: "partial",
      stoppedAt: "leftovers",
    });
    // The operator terminates the leftover instance in the EC2 console, as the next action says.
    g.strays.length = 0;
    expect(await teardownFactory(g.deps, g.run())).toMatchObject({
      kind: "done",
      report: { devices: { removed: ["n1", "nG"], possible: [] } },
    });
  });

  test("a chain of reruns carries the remembered keys forward, each in its own record", async () => {
    const failing: Record<string, string> = { nG: "Tailscale answered HTTP 500" };
    const g = ghostWorld(failing);
    const stillThere = { kind: "partial", stoppedAt: "devices", remaining: { devices: ["nG"] } };
    expect(await teardownFactory(g.deps, g.run())).toMatchObject(stillThere);
    const first = [...g.w.lockStore.operations.keys()];
    expect(await teardownFactory(g.deps, g.run())).toMatchObject(stillThere);
    const second = [...g.w.lockStore.operations.entries()].filter(([key]) => !first.includes(key));
    expect(second.map(([, record]) => record.host_keys)).toEqual([
      ["builder-1", "ghost"] as HostKey[],
    ]);
    // Even without the first run's record, the second's remembers what the first knew.
    for (const key of first) g.w.lockStore.operations.delete(key);
    delete failing.nG;
    expect(await teardownFactory(g.deps, g.run())).toMatchObject({
      kind: "done",
      report: { devices: { removed: ["nG"], possible: [] } },
    });
  });

  test("remembers every well-formed known key with the step that starts its destroy, and none before", async () => {
    const g = ghostWorld();
    g.strays.push({ instanceId: "i-odd", state: "shutting-down", hostKey: "Not A Key" });
    const { provisioner } = g.w.terraform;
    let writesAtDestroy = 0;
    const deps: TeardownDependencies = {
      ...g.deps,
      provisioner: {
        ...provisioner,
        applyPlan: async (plan) => {
          writesAtDestroy = g.w.lockStore.operationWrites.length;
          return provisioner.applyPlan(plan);
        },
      },
    };
    expect(await teardownFactory(deps, g.run())).toMatchObject({ kind: "done" });
    const beforeDestroy = g.w.lockStore.operationWrites.slice(0, writesAtDestroy);
    // Declared, recorded in the state, tagged in EC2: each well-formed key once, written with
    // the applying step, the last before the destroy; no earlier step remembers any.
    expect(beforeDestroy.at(-1)).toMatchObject({
      operation: "teardown",
      stages: [{ name: "teardown", status: "applying" }],
      host_keys: ["builder-1", "ghost"],
    });
    expect(beforeDestroy.slice(0, -1).map(({ host_keys }) => host_keys)).toEqual(
      beforeDestroy.slice(0, -1).map(() => []),
    );
  });

  test.each(["declined", "refused at the gates"] as const)(
    "a teardown %s remembers no key: a host removed since is no known key of the next one",
    async (ending) => {
      const g = ghostWorld({}, "stopped");
      const list = g.deps.machines.list;
      let listings = 0;
      const deps: TeardownDependencies = {
        ...g.deps,
        prompt: fakePrompt({ interactive: true, answers: ["no"] }).prompt,
        machines: {
          ...g.deps.machines,
          // EC2 lists another instance once dispatch is stopped: the review no longer holds.
          list: async (...args) => {
            listings += 1;
            const listed = await list(...args);
            if (ending !== "refused at the gates" || listings !== 2 || listed.kind !== "machines")
              return listed;
            const late: Machine = { instanceId: "i-late", state: "stopped", hostKey: "late" };
            return { ...listed, machines: [...listed.machines, late] };
          },
        },
      };
      const first = ending === "declined" ? g.run({ confirm: undefined }) : g.run();
      expect(await teardownFactory(deps, first)).toMatchObject({
        kind: ending === "declined" ? "declined" : "refused",
      });
      expect(g.w.lockStore.operationWrites.map(({ host_keys }) => host_keys)).toEqual(
        g.w.lockStore.operationWrites.map(() => []),
      );
      // The ghost host is removed after all, as `worker terminate` removes one: EC2 no longer
      // lists it, and its device's name may be another factory's by now.
      g.strays.length = 0;
      expect(await teardownFactory(g.deps, g.run())).toMatchObject({
        kind: "done",
        report: { devices: { removed: ["n1"], possible: [GHOST_DEVICE] } },
      });
      expect(g.admin.devices()).toMatchObject([{ id: "nG" }]);
    },
  );

  /** A record of an apply started a minute after the teardowns, its infrastructure stage at `status`. */
  function laterApply(status: "applied" | "declined"): OperationRecord {
    const lock = newLockRecord({
      factoryId: HAND,
      operation: "apply",
      holder: { principal: "arn:aws:sts::123456789012:assumed-role/Admin/op", host: "laptop" },
      now: new Date(NOW.getTime() + 60_000),
      release: RELEASE,
      randomBytes: (count) => new Uint8Array(count).fill(9),
    });
    const started = withStage(startOperation(lock, undefined), "infrastructure", status, NOW);
    return finishOperation(started, status === "applied" ? "succeeded" : "declined", NOW);
  }

  test.each([
    { apply: "applied", ghost: "listed" },
    { apply: "declined", ghost: "deleted" },
  ] as const)(
    "after an apply $apply since the destroy began, the remembered device is $ghost",
    async ({ apply, ghost }) => {
      const failing: Record<string, string> = { nG: "Tailscale answered HTTP 500" };
      const g = ghostWorld(failing);
      expect(await teardownFactory(g.deps, g.run())).toMatchObject({
        kind: "partial",
        stoppedAt: "devices",
      });
      const record = laterApply(apply);
      g.w.lockStore.store(BUCKET, operationKey(record), serializeOperation(record));
      delete failing.nG;
      const rerun = g.run({ clock: () => new Date(NOW.getTime() + 120_000) });
      expect(await teardownFactory(g.deps, rerun)).toMatchObject({
        kind: "done",
        report: {
          devices:
            ghost === "listed"
              ? { removed: [], possible: [GHOST_DEVICE] }
              : { removed: ["nG"], possible: [] },
        },
      });
    },
  );

  test("an earlier record it cannot read refuses before anything is removed; once restored, the rerun finishes", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    const key = `${FACTORY}-operations/2026-09-30T09:00:00.000Z-cccccccc.json`;
    w.lockStore.store(BUCKET, key, "{not json");
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: "An earlier operation record of the factory could not be read",
          details: expect.arrayContaining([`Operation record s3://${BUCKET}/${key}`]),
        },
      ],
      operation: { bucket: BUCKET },
    });
    expectNothingRemoved(w);
    const [refused] = records(w);
    const restored = { ...(refused as OperationRecord), host_keys: ["builder-1" as HostKey] };
    w.lockStore.store(BUCKET, key, serializeOperation(restored));
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({ kind: "done" });
    expectNothingOwned(w);
  });

  test.each([
    "authorizing",
    "inventorying",
    "planning",
    "stopping_dispatch",
    "inspecting",
    "applying",
  ] as const)(
    "a record write that fails at %s fails the teardown before its destroy",
    async (step) => {
      const w = world({ workers: { "builder-1": "running" } });
      const write = w.lockStore.writeOperation.bind(w.lockStore);
      let failed = false;
      w.lockStore.writeOperation = async (bucket, record) => {
        if (!failed && record.status === "running" && record.stages[0]?.status === step) {
          failed = true;
          throw new Error("S3 PutObject failed: SlowDown");
        }
        await write(bucket, record);
      };
      expect(await teardownFactory(w.deps, request(w))).toMatchObject({
        kind: "failed",
        refusal: { summary: expect.stringContaining("S3 PutObject failed: SlowDown") },
      });
      expect(failed).toBe(true);
      expectNothingRemoved(w);
      expect(w.terraform.world.hosts.size).toBe(1);
      expect(w.lockStore.operationWrites.at(-1)).toMatchObject({
        status: "failed",
        host_keys: [],
      });
    },
  );

  test("an interrupt as the records are read starts nothing more", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    let interrupted = false;
    const read = w.lockStore.readOperations.bind(w.lockStore);
    w.lockStore.readOperations = async (bucket) => {
      const stored = await read(bucket);
      interrupted = true;
      return stored;
    };
    const result = await teardownFactory({ ...w.deps, interrupted: () => interrupted }, request(w));
    expect(result).toMatchObject({
      kind: "interrupted",
      locked: true,
      reached: "inventorying",
      removing: false,
      lock: "held",
      dispatchStopped: [],
    });
    expect(w.lockStore.operationWrites.at(-1)?.stages[0]?.status).toBe("inventorying");
    expect(w.terraform.calls).toEqual([]);
    expect(w.planStore.calls).toEqual([]);
    expect(w.queue.reconcile).toEqual([]);
  });

  test("operation records that cannot be read refuse, never taken for none", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    w.lockStore.readOperations = async () => {
      throw new Error("S3 ListObjectsV2 on the state bucket failed: AccessDenied");
    };
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary:
            "The operation records in the state bucket could not be read: S3 ListObjectsV2 on the state bucket failed: AccessDenied",
        },
      ],
    });
    expectNothingRemoved(w);
  });
});

describe("fffactory teardown: a reference ListSecrets does not list (secrets §Listing)", () => {
  test("an owned secret the listing leaves out is described, judged owned, and deleted for good", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    // ListSecrets lags behind a change: it lists the admin client, not the auth key.
    w.secrets.unlisted.add(AUTH_ARN);
    const result = await teardownFactory(w.deps, request(w));
    expect(reportedSecrets(result)).toEqual({
      removed: [
        `${FACTORY}/tailscale-admin-client`,
        `${FACTORY}/builder-1/paseo-password`,
        `${FACTORY}/tailscale-auth-key`,
      ],
      absent: [],
      kept: { tagged: [], referenced: [SOURCE_ARN] },
    });
    const review = w.progress.find((event) => event.kind === "review");
    expect(review).toMatchObject({
      review: {
        secrets: {
          owned: [
            { name: `${FACTORY}/tailscale-admin-client`, arn: ADMIN_ARN },
            { name: `${FACTORY}/builder-1/paseo-password`, arn: PASEO_PASSWORD_ARN },
            { name: `${FACTORY}/tailscale-auth-key`, arn: AUTH_ARN },
          ],
        },
      },
    });
    expect(w.secrets.calls).toContain(`describe ${AUTH_ARN}`);
    expectAllRemoved(w);
    expectNothingOwned(w);
  });

  test("a reference the listing leaves out that the factory does not own is kept, never deleted", async () => {
    // Under the factory's names, but made by hand, or tagged without the managed-by tag.
    const handMade = secret(`${FACTORY}/github-token`, {});
    const tagged = secret(`${FACTORY}/anthropic-api-key`, { "fffactory:factory-id": FACTORY });
    const w = world({ listing: { kind: "listed", secrets: [...OWNED, handMade, tagged] } });
    w.secrets.unlisted.add(handMade.arn);
    w.secrets.unlisted.add(tagged.arn);
    const base = instanceOf([]);
    const instance = {
      ...base,
      credentials: { github_token_secret: handMade.arn, anthropic_api_key_secret: tagged.arn },
    };
    const result = await teardownFactory(w.deps, request(w, { instance }));
    expect(reportedSecrets(result)).toEqual({
      removed: ownedNames(w),
      absent: [],
      kept: { tagged: [{ name: tagged.name, arn: tagged.arn }], referenced: [handMade.arn] },
    });
    expect(w.secrets.calls.filter((call) => /^(remove|restore)/.test(call))).toEqual(
      OWNED.map(({ arn: owned }) => `remove ${owned}`),
    );
    expect(w.secrets.secrets()).toEqual([handMade, tagged]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(false);
  });

  test("a reference the listing leaves out and DescribeSecret no longer finds is already absent", async () => {
    const w = world({ listing: { kind: "listed", secrets: [OWNED[1] as ListedSecret] } });
    const result = await teardownFactory(w.deps, request(w));
    expect(reportedSecrets(result)).toEqual({
      removed: [`${FACTORY}/tailscale-admin-client`],
      absent: [AUTH_ARN],
      kept: { tagged: [], referenced: [SOURCE_ARN] },
    });
  });

  test("one that cannot be described refuses, removing nothing; the rerun finishes once it can", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    w.secrets.unlisted.add(AUTH_ARN);
    w.secrets.describeFails.set(AUTH_ARN, DESCRIBE_DENIED);
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusals: [unresolved(AUTH_ARN)],
      dispatchStopped: [],
    });
    expectNothingRemoved(w);
    expect(records(w)[0]).toMatchObject({ status: "refused" });
    w.secrets.describeFails.clear();
    expect((await teardownFactory(w.deps, request(w))).kind).toBe("done");
    expectNothingOwned(w);
  });

  test("a description of another secret than the reference names refuses: never judged for it", async () => {
    const w = world();
    const other = secret(`${FACTORY}/github-token`);
    const secrets = fakeSecretStore({
      values: { [ADMIN_ARN]: ADMIN_SECRET },
      listing: { kind: "listed", secrets: [OWNED[1] as ListedSecret] },
      described: { kind: "found", secret: other },
    });
    expect(await teardownFactory({ ...w.deps, secrets: secrets.store }, request(w))).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `Secrets Manager described ${other.arn}, another secret than ${AUTH_ARN} names`,
          nextAction:
            "Check that factory.json names the secret by its full ARN, as the Secrets Manager console shows it, then rerun `fffactory teardown`.",
        },
      ],
    });
    expect(secrets.calls.filter((call) => /^(remove|restore)/.test(call))).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  test("a description without a usable name or ARN refuses, worded as no network or permission problem", async () => {
    const w = world();
    const secrets = fakeSecretStore({
      values: { [ADMIN_ARN]: ADMIN_SECRET },
      listing: { kind: "listed", secrets: [OWNED[1] as ListedSecret] },
      described: { kind: "unusable" },
    });
    expect(await teardownFactory({ ...w.deps, secrets: secrets.store }, request(w))).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `Secrets Manager described the secret ${AUTH_ARN} without a usable name or ARN`,
          nextAction:
            "Rerun `fffactory teardown`; if Secrets Manager answers the same again, check the secret in the Secrets Manager console.",
        },
      ],
    });
    expect(secrets.calls.filter((call) => /^(remove|restore)/.test(call))).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  test("two references naming one unlisted secret, by its full and partial ARN, delete it once", async () => {
    const w = world();
    w.secrets.unlisted.add(AUTH_ARN);
    const partial = AUTH_ARN.slice(0, -"-AbCdEf".length) as SecretReference;
    const base = instanceOf([]);
    const instance = {
      ...base,
      credentials: { ...base.credentials, anthropic_api_key_secret: partial },
    };
    const result = await teardownFactory(w.deps, request(w, { instance }));
    expect(reportedSecrets(result)).toEqual({
      removed: [`${FACTORY}/tailscale-admin-client`, `${FACTORY}/tailscale-auth-key`],
      absent: [],
      kept: { tagged: [], referenced: [SOURCE_ARN] },
    });
    expect(w.secrets.calls.filter((call) => call.startsWith("describe")).sort()).toEqual([
      `describe ${partial}`,
      `describe ${AUTH_ARN}`,
    ]);
    expect(w.secrets.calls.filter((call) => call === `remove ${AUTH_ARN}`)).toHaveLength(1);
    expectNothingOwned(w);
  });

  test("an owned secret the listing leaves out while pending deletion is restored, deleted and gone", async () => {
    const pending = { ...(OWNED[0] as ListedSecret), pendingDeletion: true };
    const w = world({ listing: { kind: "listed", secrets: [pending, OWNED[1] as ListedSecret] } });
    w.secrets.unlisted.add(AUTH_ARN);
    const result = await teardownFactory(w.deps, request(w));
    expect(reportedSecrets(result)).toEqual({
      removed: [`${FACTORY}/tailscale-admin-client`, `${FACTORY}/tailscale-auth-key`],
      absent: [],
      kept: { tagged: [], referenced: [SOURCE_ARN] },
    });
    const auth = w.secrets.calls.filter((call) => call.endsWith(` ${AUTH_ARN}`));
    expect(auth.slice(0, 3)).toEqual([
      `describe ${AUTH_ARN}`,
      `restore ${AUTH_ARN}`,
      `remove ${AUTH_ARN}`,
    ]);
    expect(auth.at(-1)).toBe(`exists ${AUTH_ARN}`);
    expectNothingOwned(w);
  });

  test("a rerun after the admin client was deleted refuses one that cannot be described, keeping the bucket", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    w.secrets.removeFails.set(AUTH_ARN, {
      kind: "failed",
      reason: "Secrets Manager DeleteSecret failed: AccessDeniedException",
    });
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "secrets",
      remaining: { secrets: [`${FACTORY}/tailscale-auth-key`] },
    });
    w.secrets.removeFails.clear();
    w.secrets.unlisted.add(AUTH_ARN);
    w.secrets.describeFails.set(AUTH_ARN, DESCRIBE_DENIED);
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusals: [unresolved(AUTH_ARN)],
    });
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
    expect(w.secrets.secrets().map(({ arn: left }) => left)).toEqual([AUTH_ARN]);
    w.secrets.describeFails.clear();
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      report: {
        devicesUnchecked: DEVICES_NOT_CHECKED,
        secrets: {
          removed: [`${FACTORY}/tailscale-auth-key`],
          absent: [ADMIN_ARN, PASEO_PASSWORD_ARN],
        },
      },
    });
    expectNothingOwned(w);
  });
});

describe("fffactory teardown: an interrupt keeps the lock at every step (teardown §Interruption)", () => {
  const STEPS: readonly TeardownStep[] = [
    "authorizing",
    "inventorying",
    "planning",
    "stopping_dispatch",
    "inspecting",
    "applying",
    "verifying",
    "removing_devices",
    "removing_secrets",
    "removing_plans",
    "deleting_bucket",
  ];
  const after = (step: TeardownStep, later: TeardownStep) =>
    STEPS.indexOf(step) >= STEPS.indexOf(later);

  test.each([...STEPS])("interrupted once %s is recorded, it starts nothing more", async (step) => {
    const w = world({ workers: { "builder-1": "running" } });
    let interrupted = false;
    const write = w.lockStore.writeOperation.bind(w.lockStore);
    w.lockStore.writeOperation = async (bucket, record) => {
      await write(bucket, record);
      if (record.stages[0]?.status === step) interrupted = true;
    };
    const result = await teardownFactory({ ...w.deps, interrupted: () => interrupted }, request(w));
    expect(result).toMatchObject({
      kind: "interrupted",
      locked: true,
      record: { bucket: BUCKET },
      reached: step,
      removing: after(step, "verifying"),
      lock: "held",
      dispatchStopped: after(step, "inspecting") ? [hostname("builder-1")] : [],
    });
    expect(w.lockStore.locks.size).toBe(1);
    expect(w.lockStore.operationWrites.at(-1)?.stages[0]?.status).toBe(step);
    expect(destroyed(w).length).toBe(after(step, "verifying") ? 1 : 0);
    if (!after(step, "verifying")) expect(w.terraform.world.hosts.size).toBe(1);
    const removes = (calls: readonly string[]) => calls.filter((call) => call.startsWith("remove"));
    expect(removes(w.admin.calls).length).toBe(after(step, "removing_secrets") ? 1 : 0);
    expect(removes(w.secrets.calls).length).toBe(
      after(step, "removing_plans") ? ownedNames(w).length : 0,
    );
    expect(w.planStore.calls.some((call) => call.startsWith("removeAll"))).toBe(
      after(step, "deleting_bucket"),
    );
    expect(w.lockStore.calls.some((call) => call.startsWith("deleteBucket"))).toBe(false);
  });

  test("interrupted while the bucket is emptied, before its lock: the lock is held, its record may be gone", async () => {
    const w = world();
    let interrupted = false;
    w.lockStore.beforeLock = () => {
      interrupted = true;
    };
    const result = await teardownFactory({ ...w.deps, interrupted: () => interrupted }, request(w));
    expect(result).toMatchObject({
      kind: "interrupted",
      reached: "deleting_bucket",
      removing: true,
      lock: "held",
      record: undefined,
    });
    expect(w.lockStore.locks.size).toBe(1);
    expectNothingAfterBucket(w);
  });

  test.each(["unknown", "deleted"] as const)(
    "interrupted once the bucket's deletion reached the lock (%s): it says so, and writes nothing more",
    async (lock) => {
      const w = world();
      let interrupted = false;
      w.lockStore.deletionLeaves = {
        kind: "remains",
        versions: undefined,
        codes: [],
        failure: undefined,
        lock,
      };
      const remove = w.lockStore.deleteBucket.bind(w.lockStore);
      w.lockStore.deleteBucket = async (bucket, stop) => {
        const left = await remove(bucket, stop);
        interrupted = true;
        return left;
      };
      const result = await teardownFactory(
        { ...w.deps, interrupted: () => interrupted },
        request(w),
      );
      expect(result).toMatchObject({
        kind: "interrupted",
        reached: "deleting_bucket",
        lock,
        record: undefined,
      });
      expectNothingAfterBucket(w);
    },
  );

  test("interrupted as the bucket is deleted, it is done: the lock went with the bucket", async () => {
    const w = world();
    let interrupted = false;
    const remove = w.lockStore.deleteBucket.bind(w.lockStore);
    w.lockStore.deleteBucket = async (bucket, stop) => {
      const left = await remove(bucket, stop);
      interrupted = true;
      return left;
    };
    const result = await teardownFactory({ ...w.deps, interrupted: () => interrupted }, request(w));
    expect(result.kind).toBe("done");
    expectNothingAfterBucket(w);
  });

  test.each([
    {
      ending: "refused",
      options: { workers: { "builder-1": "running" }, agents: agentsIn("working") },
      confirm: FACTORY,
    },
    {
      ending: "declined",
      options: {
        workers: { "builder-1": "running" },
        prompt: fakePrompt({ interactive: true, answers: ["no"] }),
      },
      confirm: undefined,
    },
    { ending: "failed", options: { workers: { "builder-1": "running" } }, confirm: FACTORY },
    { ending: "partial", options: { workers: { "builder-1": "stopped" } }, confirm: FACTORY },
  ] as const)(
    "interrupted while its $ending record is written, it reports the interrupt and keeps the lock",
    async ({ ending, options, confirm }) => {
      const w = world(options as WorldOptions);
      if (ending === "failed") w.terraform.world.failNext = "plan";
      if (ending === "partial") w.terraform.world.failNext = "applyPlan";
      let interrupted = false;
      const write = w.lockStore.writeOperation.bind(w.lockStore);
      w.lockStore.writeOperation = async (bucket, record) => {
        await write(bucket, record);
        if (record.status !== "running") interrupted = true;
      };
      const result = await teardownFactory(
        { ...w.deps, interrupted: () => interrupted },
        request(w, { confirm }),
      );
      expect(result).toMatchObject({ kind: "interrupted", locked: true, lock: "held" });
      expect(records(w)[0]).toMatchObject({ status: ending });
      expect(w.lockStore.locks.size).toBe(1);
    },
  );

  test.each([
    { during: "terraformDirectory", ran: [] },
    { during: "output", ran: ["output"] },
    { during: "plan", ran: ["output", "plan"] },
  ] as const)(
    "interrupted during the destroy plan's $during, it starts no further Terraform command",
    async ({ during, ran }) => {
      const w = world({ workers: { "builder-1": "running" } });
      let interrupted = false;
      const { provisioner } = w.terraform;
      const interrupting = {
        ...provisioner,
        output: async (target: Parameters<typeof provisioner.output>[0]) => {
          const outputs = await provisioner.output(target);
          if (during === "output") interrupted = true;
          return outputs;
        },
        plan: async (planRequest: Parameters<typeof provisioner.plan>[0]) => {
          const planned = await provisioner.plan(planRequest);
          if (during === "plan") interrupted = true;
          return planned;
        },
      };
      const terraformDirectory = async () => {
        if (during === "terraformDirectory") interrupted = true;
        return TERRAFORM;
      };
      const result = await teardownFactory(
        {
          ...w.deps,
          provisioner: interrupting,
          terraformDirectory,
          interrupted: () => interrupted,
        },
        request(w),
      );
      expect(result).toMatchObject({ kind: "interrupted", reached: "planning", removing: false });
      expect(w.terraform.calls.map(({ call }) => call)).toEqual([...ran]);
      expect(w.lockStore.locks.size).toBe(1);
    },
  );

  test("interrupted while EC2 is listed after the destroy, it reads no Terraform state", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    let interrupted = false;
    const machines = changingMachines(w.deps.machines, (listed) => {
      // The inventory's listing is the first, the recheck before the gates the second.
      if (destroyed(w).length > 0) interrupted = true;
      return { kind: "machines", machines: listed };
    });
    const result = await teardownFactory(
      { ...w.deps, machines, interrupted: () => interrupted },
      request(w),
    );
    expect(result).toMatchObject({ kind: "interrupted", reached: "verifying", removing: true });
    const calls = w.terraform.calls.map(({ call }) => call);
    expect(calls.slice(calls.indexOf("applyPlan") + 1)).toEqual([]);
  });

  test("interrupted during a destroy that then succeeds, it reports the step it was at, not the next", async () => {
    const w = world({ workers: { "builder-1": "stopped" } });
    let interrupted = false;
    w.terraform.world.beforeChange = () => {
      interrupted = true;
    };
    const result = await teardownFactory({ ...w.deps, interrupted: () => interrupted }, request(w));
    expect(result).toMatchObject({ kind: "interrupted", reached: "applying", removing: true });
    expect(w.terraform.world.hosts.size).toBe(0);
    expect(w.lockStore.operationWrites.at(-1)?.stages[0]?.status).toBe("applying");
  });

  test("interrupted past the devices step, it reports the devices listed but kept", async () => {
    const devices = [
      tailnetDevice("n0CNTRL", hostname("builder-1"), [WORKER_TAG]),
      tailnetDevice("nU", hostname("builder-1"), []),
    ];
    const w = world({ workers: { "builder-1": "stopped" }, devices });
    let interrupted = false;
    const remove = w.secrets.store.remove;
    const secrets = {
      ...w.secrets.store,
      remove: async (lookup: Parameters<typeof remove>[0]) => {
        interrupted = true;
        return remove(lookup);
      },
    };
    const result = await teardownFactory(
      { ...w.deps, secrets, interrupted: () => interrupted },
      request(w),
    );
    expect(result).toMatchObject({
      kind: "interrupted",
      reached: "removing_secrets",
      listedDevices: { possible: [], untagged: [{ id: "nU", hostname: hostname("builder-1") }] },
    });
  });

  test.each(["restore", "remove"] as const)(
    "interrupted during one secret's %s, it starts no Secrets Manager call for it or the next",
    async (operation) => {
      const [first, second] = OWNED;
      if (first === undefined || second === undefined) throw new Error("two owned secrets");
      const listing: SecretListing = {
        kind: "listed",
        secrets: [{ ...first, pendingDeletion: true }, second],
      };
      const w = world({ listing });
      let interrupted = false;
      const store = w.secrets.store;
      const secrets = {
        ...store,
        restore: async (lookup: Parameters<typeof store.restore>[0]) => {
          if (operation === "restore") interrupted = true;
          return store.restore(lookup);
        },
        remove: async (lookup: Parameters<typeof store.remove>[0]) => {
          if (operation === "remove") interrupted = true;
          return store.remove(lookup);
        },
      };
      const result = await teardownFactory(
        { ...w.deps, secrets, interrupted: () => interrupted },
        request(w),
      );
      expect(result).toMatchObject({
        kind: "interrupted",
        locked: true,
        reached: "removing_secrets",
        removing: true,
        lock: "held",
      });
      const deleting = w.secrets.calls.filter((call) => /^(restore|remove|exists)/.test(call));
      expect(deleting).toEqual(
        operation === "restore"
          ? [`restore ${first.arn}`]
          : [`restore ${first.arn}`, `remove ${first.arn}`],
      );
      expect(w.secrets.secrets().map(({ arn }) => arn)).toContain(second.arn);
      expect(w.lockStore.locks.size).toBe(1);
    },
  );

  test("an interrupt after dispatch was stopped names where it is stopped", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    let interrupted = false;
    const controlPlane: ControlPlane = {
      ...w.control.controlPlane,
      agents: async () => {
        interrupted = true;
        throw new Error("interrupted while reading the activity");
      },
    };
    const result = await teardownFactory(
      { ...w.deps, controlPlane, interrupted: () => interrupted },
      request(w),
    );
    expect(result).toMatchObject({
      kind: "interrupted",
      removing: false,
      dispatchStopped: [hostname("builder-1")],
    });
    expect(w.lockStore.locks.size).toBe(1);
  });
});

/**
 * A factory whose state bucket S3 does not find, as a first bootstrap that failed after `secret
 * set` leaves it, or a bucket deleted by hand: no network, and no machine unless `machines`.
 */
function bucketless(options: WorldOptions & { readonly machines?: readonly Machine[] } = {}) {
  const w = world(options);
  w.lockStore.buckets.delete(BUCKET);
  w.terraform.world.hosts.clear();
  w.terraform.world.network = false;
  if (options.machines !== undefined)
    w.deps = {
      ...w.deps,
      machines: {
        ...w.deps.machines,
        list: async () => ({ kind: "machines", machines: [...(options.machines ?? [])] }),
      },
    };
  return w;
}

/**
 * Nothing reached the state bucket but asking whether it exists: no readiness asked of a bucket
 * S3 does not find, and no bucket, lock or record made.
 */
function expectNoBucketTouched(w: World) {
  expect(w.lockStore.calls.filter((call) => call !== `bucketExists ${BUCKET}`)).toEqual([]);
  expect(w.lockStore.buckets.has(BUCKET)).toBe(false);
  expect(w.lockStore.locks.size).toBe(0);
  expect(w.lockStore.operations.size).toBe(0);
  // No Terraform at all: neither a destroy nor a backend bootstrap was planned or applied.
  expect(w.terraform.calls).toEqual([]);
}

/** Nothing the factory owns was removed. */
function expectNothingDeleted(w: World) {
  expect(w.admin.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
  expect(w.secrets.calls.filter((call) => /^(remove|restore)/.test(call))).toEqual([]);
  expect(w.planStore.calls.filter((call) => call.startsWith("removeAll"))).toEqual([]);
}

describe("fffactory teardown: no state bucket (teardown §No state bucket)", () => {
  test("cleans up a factory with only secrets without a lock, and says so", async () => {
    const w = bucketless();
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toEqual({
      kind: "done",
      report: {
        infrastructure: "not_found_by_ec2",
        changes: [],
        machines: [],
        devices: { removed: [], possible: [], untagged: [] },
        devicesUnchecked: undefined,
        secrets: {
          removed: ownedNames(w),
          absent: [],
          kept: { tagged: [], referenced: [SOURCE_ARN] },
        },
        bucket: { name: BUCKET, outcome: "not_found" },
        withoutLock: ranWithoutLock(BUCKET),
        archive: undefined,
      },
    });
    expect(w.secrets.secrets()).toEqual([]);
    for (const { arn: owned } of OWNED) expect(w.secrets.calls).toContain(`exists ${owned}`);
    expect(w.secrets.calls.filter((call) => call.includes(SOURCE_ARN))).toEqual([]);
    expect(w.planStore.calls).toContain(`removeAll ${FACTORY}`);
    expect(w.progress.map(({ kind }) => kind)).toEqual([
      "review",
      "removing_devices",
      "removing_secrets",
    ]);
    expectNoBucketTouched(w);
  });

  test("deletes the devices and secrets after the same review and typed confirmation", async () => {
    const prompt = fakePrompt({ interactive: true, answers: [FACTORY] });
    const devices = [
      tailnetDevice("n0CNTRL", hostname("builder-1"), [WORKER_TAG]),
      tailnetDevice("nU", hostname("builder-1"), []),
    ];
    const w = bucketless({ workers: { "builder-1": "running" }, devices, prompt });
    const result = await teardownFactory(w.deps, request(w, { confirm: undefined }));
    expect(result).toMatchObject({
      kind: "done",
      report: {
        devices: {
          removed: ["n0CNTRL"],
          untagged: [{ id: "nU", hostname: hostname("builder-1") }],
        },
        secrets: { removed: ownedNames(w) },
        withoutLock: ranWithoutLock(BUCKET),
      },
    });
    expect(prompt.asked).toEqual([
      `Remove what is left of factory ${FACTORY}? Its tailnet devices and owned secrets are ` +
        "deleted, and none can be recovered. Type the factory ID to confirm: ",
    ]);
    expect(w.progress[0]).toEqual({
      kind: "review",
      review: expect.objectContaining({
        changes: [],
        machines: [],
        vpcIds: [],
        devices: {
          deleted: [{ id: "n0CNTRL", hostname: hostname("builder-1") }],
          possible: [],
          untagged: [{ id: "nU", hostname: hostname("builder-1") }],
        },
        secrets: expect.objectContaining({
          owned: ownedBy(w.keys).map(({ name, arn: a }) => ({ name, arn: a })),
        }),
        bucket: { name: BUCKET, outcome: "not_found" },
        withoutLock: ranWithoutLock(BUCKET),
      }),
    });
    expect(w.admin.devices().map(({ id }) => id)).toEqual(["nU"]);
    // No worker to stop dispatch on or inspect: nothing was asked of one.
    expect(w.queue.reconcile).toEqual([]);
    expect(w.control.calls).toEqual([]);
    expectNoBucketTouched(w);
  });

  test("names the log archive kept, without a state bucket too", async () => {
    const prompt = fakePrompt({ interactive: true, answers: [FACTORY] });
    const w = bucketless({ prompt });
    const result = await teardownFactory(
      w.deps,
      request(w, { confirm: undefined, instance: archivingOf(w.keys) }),
    );
    expect(result).toMatchObject({
      kind: "done",
      report: { withoutLock: ranWithoutLock(BUCKET), archive: ARCHIVE },
    });
    expect(w.progress[0]).toMatchObject({ kind: "review", review: { archive: ARCHIVE } });
    expect(prompt.asked).toEqual([teardownQuestion(FACTORY, true, ARCHIVE)]);
    expectNoBucketTouched(w);
  });

  test("declined, it removes nothing", async () => {
    const prompt = fakePrompt({ interactive: true, answers: ["no"] });
    const w = bucketless({ prompt });
    expect(await teardownFactory(w.deps, request(w, { confirm: undefined }))).toEqual({
      kind: "declined",
      operation: undefined,
      recordFailure: undefined,
    });
    expectNothingDeleted(w);
    expectNoBucketTouched(w);
  });

  test.each(["pending", "running", "stopping", "stopped", "shutting-down"] as const)(
    "refuses an instance tagged with the factory ID (%s), naming it, and deletes nothing",
    async (state) => {
      const machine: Machine = { instanceId: "i-0123456789abcdef0", state, hostKey: "builder-1" };
      const w = bucketless({ machines: [machine] });
      expect(await teardownFactory(w.deps, request(w))).toEqual({
        kind: "refused",
        refusals: [
          {
            summary: `The state bucket ${BUCKET} does not exist, but resources tagged with the factory's ID do`,
            details: [
              "Their Terraform state was kept in the state bucket: without it, teardown cannot destroy them, and nothing was removed.",
              `EC2 instance i-0123456789abcdef0 (${state})`,
            ],
            nextAction:
              "Check them in the EC2 console and remove those that are this factory's yourself, then rerun `fffactory teardown`.",
          },
        ],
        operation: undefined,
        dispatchStopped: [],
        recordFailure: undefined,
      });
      expect(w.progress).toEqual([]);
      expectNothingDeleted(w);
      expectNoBucketTouched(w);
    },
  );

  test("refuses a VPC tagged with the factory ID, even with the admin client gone", async () => {
    const w = bucketless({
      vpcs: { kind: "vpcs", vpcIds: [NETWORK_VPC] },
      listing: { kind: "listed", secrets: [OWNED[0] as ListedSecret] },
    });
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusals: [
        {
          summary: `The state bucket ${BUCKET} does not exist, but resources tagged with the factory's ID do`,
          details: expect.arrayContaining([`VPC ${NETWORK_VPC}`]),
        },
      ],
    });
    // The admin client's secret was looked for and not found: no admin session was opened.
    expect(w.secrets.calls).toContain(`exists ${ADMIN_ARN}`);
    expect(w.admin.calls).toEqual([]);
    expectNothingDeleted(w);
    expectNoBucketTouched(w);
  });

  test.each([
    {
      part: "instances",
      options: {
        inventory: {
          kind: "unavailable",
          reason: "EC2 DescribeInstances failed: UnauthorizedOperation",
        },
      },
      summary: "EC2 DescribeInstances failed: UnauthorizedOperation",
    },
    {
      part: "VPCs",
      options: {
        vpcs: { kind: "unavailable", reason: "EC2 DescribeVpcs failed: UnauthorizedOperation" },
      },
      summary: "EC2 DescribeVpcs failed: UnauthorizedOperation",
    },
  ] as const)(
    "refuses when EC2's $part cannot be listed: never taken for nothing tagged",
    async ({ options, summary }) => {
      const w = bucketless(options as WorldOptions);
      expect(await teardownFactory(w.deps, request(w))).toMatchObject({
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
      expectNothingDeleted(w);
      expectNoBucketTouched(w);
    },
  );

  const APPEARED = `The state bucket ${BUCKET} exists now, but did not when the factory was reviewed`;
  const TAGGED = `The state bucket ${BUCKET} does not exist, but resources tagged with the factory's ID do`;

  test.each<{
    case: string;
    meanwhile: (w: World) => void;
    machines?: MachineInventory;
    vpcs?: VpcInventory;
    summary: string;
  }>([
    {
      case: "a state bucket created",
      meanwhile: (w) => w.lockStore.buckets.add(BUCKET),
      summary: APPEARED,
    },
    {
      case: "the bucket's name answering 403",
      meanwhile: (w) => w.lockStore.unreachable.add(BUCKET),
      summary: `The state bucket ${BUCKET} cannot be reached in account 123456789012 (S3 answered 403)`,
    },
    {
      case: "a tagged instance launched",
      meanwhile: () => undefined,
      machines: {
        kind: "machines",
        machines: [{ instanceId: "i-0123456789abcdef0", state: "pending", hostKey: "builder-1" }],
      },
      summary: TAGGED,
    },
    {
      case: "a tagged VPC created",
      meanwhile: () => undefined,
      vpcs: { kind: "vpcs", vpcIds: [NETWORK_VPC] },
      summary: TAGGED,
    },
    {
      case: "EC2's instances not listed again",
      meanwhile: () => undefined,
      machines: {
        kind: "unavailable",
        reason: "EC2 DescribeInstances failed: RequestLimitExceeded",
      },
      summary: "EC2 DescribeInstances failed: RequestLimitExceeded",
    },
    {
      case: "EC2's VPCs not listed again",
      meanwhile: () => undefined,
      vpcs: { kind: "unavailable", reason: "EC2 DescribeVpcs failed: RequestLimitExceeded" },
      summary: "EC2 DescribeVpcs failed: RequestLimitExceeded",
    },
  ])(
    "refuses once confirmed with $case while the question waited, deleting nothing",
    async ({ meanwhile, machines, vpcs, summary }) => {
      const w = bucketless();
      // EC2 answers as the test says from its second listing on: after the review.
      let confirmed = false;
      const inventory: MachineInventorySource = {
        list: async (...args) =>
          confirmed && machines !== undefined ? machines : w.deps.machines.list(...args),
        listVpcs: async (...args) =>
          confirmed && vpcs !== undefined ? vpcs : w.deps.machines.listVpcs(...args),
      };
      const prompt = {
        ...fakePrompt({ interactive: true }).prompt,
        ask: async () => {
          confirmed = true;
          meanwhile(w);
          return FACTORY;
        },
      };
      const result = await teardownFactory(
        { ...w.deps, machines: inventory, prompt },
        request(w, { confirm: undefined }),
      );
      expect(result).toMatchObject({
        kind: "refused",
        refusals: [{ summary }],
        operation: undefined,
        dispatchStopped: [],
      });
      expectNothingDeleted(w);
      expect(w.lockStore.calls.filter((call) => call !== `bucketExists ${BUCKET}`)).toEqual([]);
      expect(w.lockStore.locks.size).toBe(0);
      expect(w.terraform.calls).toEqual([]);
    },
  );

  test("reruns after a teardown that deleted the bucket end done: devices not checked, secrets already absent", async () => {
    const w = world({ workers: { "builder-1": "running" } });
    expect((await teardownFactory(w.deps, request(w))).kind).toBe("done");
    const calls = w.lockStore.calls.length;
    const progress = w.progress.length;
    expect(await teardownFactory(w.deps, request(w))).toEqual({
      kind: "done",
      report: {
        infrastructure: "not_found_by_ec2",
        changes: [],
        machines: [],
        devices: { removed: [], possible: [], untagged: [] },
        devicesUnchecked: DEVICES_NOT_CHECKED,
        secrets: {
          removed: [],
          absent: [AUTH_ARN, ADMIN_ARN, PASEO_PASSWORD_ARN],
          kept: { tagged: [], referenced: [SOURCE_ARN] },
        },
        bucket: { name: BUCKET, outcome: "not_found" },
        withoutLock: ranWithoutLock(BUCKET),
        archive: undefined,
      },
    });
    expect(w.progress.slice(progress)).toContainEqual(
      expect.objectContaining({
        kind: "review",
        review: expect.objectContaining({ devicesUnchecked: DEVICES_NOT_CHECKED }),
      }),
    );
    expect(w.lockStore.calls.slice(calls)).toEqual([
      `bucketExists ${BUCKET}`,
      `bucketExists ${BUCKET}`,
    ]);
    expectNothingOwned(w);
  });

  test("a device not deleted stops it before the secrets, with no bucket among what remains; the rerun finishes", async () => {
    const failing: Record<string, string> = { n0CNTRL: "Tailscale answered HTTP 500" };
    const w = bucketless({ workers: { "builder-1": "running" } });
    const admin = fakeTailnetAdmin({
      devices: [tailnetDevice("n0CNTRL", hostname("builder-1"), [WORKER_TAG])],
      failing,
    });
    const deps = { ...w.deps, tailnetAdmin: admin.admin };
    const partial = await teardownFactory(deps, request(w));
    expect(partial).toMatchObject({
      kind: "partial",
      stoppedAt: "devices",
      remaining: { devices: ["n0CNTRL"], secrets: ownedNames(w), plans: true, bucket: undefined },
      operation: undefined,
      recordFailure: undefined,
    });
    if (partial.kind !== "partial") throw new Error("not partial");
    expect(partial.refusal.details.filter((line) => line.includes("state bucket"))).toEqual([]);
    expect(w.secrets.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    delete failing.n0CNTRL;
    expect(await teardownFactory(deps, request(w))).toMatchObject({
      kind: "done",
      report: { devices: { removed: ["n0CNTRL"] }, withoutLock: ranWithoutLock(BUCKET) },
    });
    expect(admin.devices()).toEqual([]);
    expect(w.secrets.secrets()).toEqual([]);
    expectNoBucketTouched(w);
  });

  test("an owned secret the listing leaves out is described and deleted; one not described refuses first", async () => {
    const w = bucketless();
    w.secrets.unlisted.add(AUTH_ARN);
    w.secrets.describeFails.set(AUTH_ARN, DESCRIBE_DENIED);
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "refused",
      refusals: [unresolved(AUTH_ARN)],
    });
    expectNothingDeleted(w);
    w.secrets.describeFails.clear();
    const result = await teardownFactory(w.deps, request(w));
    expect(result).toMatchObject({ kind: "done", report: { withoutLock: ranWithoutLock(BUCKET) } });
    expect(reportedSecrets(result)).toEqual({
      removed: [`${FACTORY}/tailscale-admin-client`, `${FACTORY}/tailscale-auth-key`],
      absent: [],
      kept: { tagged: [], referenced: [SOURCE_ARN] },
    });
    expect(w.secrets.secrets()).toEqual([]);
    expectNoBucketTouched(w);
  });

  test("a secret not confirmed gone leaves it partial; the rerun, its admin client gone, finishes", async () => {
    const w = bucketless();
    w.secrets.removeFails.set(AUTH_ARN, {
      kind: "failed",
      reason: "Secrets Manager DeleteSecret failed: AccessDeniedException",
    });
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "partial",
      stoppedAt: "secrets",
      remaining: { secrets: [`${FACTORY}/tailscale-auth-key`], plans: true, bucket: undefined },
      refusal: { summary: "Not every secret the factory owns is gone" },
      operation: undefined,
    });
    w.secrets.removeFails.clear();
    expect(await teardownFactory(w.deps, request(w))).toMatchObject({
      kind: "done",
      report: {
        devicesUnchecked: DEVICES_NOT_CHECKED,
        secrets: { removed: [`${FACTORY}/tailscale-auth-key`], absent: [ADMIN_ARN] },
        withoutLock: ranWithoutLock(BUCKET),
      },
    });
    expect(w.secrets.secrets()).toEqual([]);
    expectNoBucketTouched(w);
  });

  test("interrupted, it reports how far it got and that it kept no lock", async () => {
    const atQuestion = bucketless();
    let interrupted = false;
    const prompt = {
      ...fakePrompt({ interactive: true }).prompt,
      ask: async () => {
        interrupted = true;
        return FACTORY;
      },
    };
    expect(
      await teardownFactory(
        { ...atQuestion.deps, prompt, interrupted: () => interrupted },
        request(atQuestion, { confirm: undefined }),
      ),
    ).toEqual({
      kind: "interrupted",
      locked: false,
      withoutLock: {
        reached: "awaiting_approval",
        removing: false,
        record: false,
        dispatchStopped: [],
        listedDevices: { possible: [], untagged: [] },
        lock: "none",
      },
    });
    expectNothingDeleted(atQuestion);
    expectNoBucketTouched(atQuestion);

    const devices = [
      tailnetDevice("n0CNTRL", hostname("builder-1"), [WORKER_TAG]),
      tailnetDevice("nU", hostname("builder-1"), []),
    ];
    const removing = bucketless({ workers: { "builder-1": "running" }, devices });
    let removals = 0;
    const secrets = {
      ...removing.deps.secrets,
      remove: async (request: Parameters<typeof removing.deps.secrets.remove>[0]) => {
        removals += 1;
        return removing.deps.secrets.remove(request);
      },
    };
    const result = await teardownFactory(
      { ...removing.deps, secrets, interrupted: () => removals > 0 },
      request(removing),
    );
    expect(result).toEqual({
      kind: "interrupted",
      locked: false,
      withoutLock: {
        reached: "removing_secrets",
        removing: true,
        record: false,
        dispatchStopped: [],
        listedDevices: {
          possible: [],
          untagged: [{ id: "nU", hostname: hostname("builder-1") }],
        },
        lock: "none",
      },
    });
    // What it returns is what `interruptedTeardown` words, as it is.
    if (result.kind !== "interrupted" || result.locked || result.withoutLock === undefined)
      throw new Error("not interrupted without a lock");
    expect(interruptedTeardown(result.withoutLock)).toMatchObject({
      summary:
        "Interrupted: the factory is not locked, since it has no state bucket to hold a lock",
      nextAction: "Once fffactory has exited, rerun `fffactory teardown`.",
    });
    expect(removals).toBe(1);
    expect(removing.planStore.calls.filter((call) => call.startsWith("removeAll"))).toEqual([]);
    expectNoBucketTouched(removing);
  });

  test.each([
    { during: "asking S3 for the bucket", at: "bucketExists", listed: [] },
    { during: "listing EC2's instances", at: "list", listed: ["list"] },
    { during: "listing EC2's VPCs", at: "listVpcs", listed: ["list", "listVpcs"] },
  ] as const)(
    "interrupted once confirmed while $during, it starts no further call and removes nothing",
    async ({ at, listed }) => {
      const w = bucketless();
      let confirmed = false;
      let interrupted = false;
      // EC2's listings started once confirmed; the interrupt lands as the call `at` answers.
      const calls: string[] = [];
      const answered = (call: string) => {
        if (!confirmed) return;
        if (call !== "bucketExists") calls.push(call);
        if (call === at) interrupted = true;
      };
      const bucketExists = w.lockStore.bucketExists.bind(w.lockStore);
      w.lockStore.bucketExists = async (bucket) => {
        const exists = await bucketExists(bucket);
        answered("bucketExists");
        return exists;
      };
      const machines: MachineInventorySource = {
        list: async (...args) => {
          const listing = await w.deps.machines.list(...args);
          answered("list");
          return listing;
        },
        listVpcs: async (...args) => {
          const listing = await w.deps.machines.listVpcs(...args);
          answered("listVpcs");
          return listing;
        },
      };
      const prompt = {
        ...fakePrompt({ interactive: true }).prompt,
        ask: async () => {
          confirmed = true;
          return FACTORY;
        },
      };
      const result = await teardownFactory(
        { ...w.deps, machines, prompt, interrupted: () => interrupted },
        request(w, { confirm: undefined }),
      );
      expect(result).toEqual({
        kind: "interrupted",
        locked: false,
        withoutLock: {
          reached: "verifying",
          removing: false,
          record: false,
          dispatchStopped: [],
          listedDevices: { possible: [], untagged: [] },
          lock: "none",
        },
      });
      expect(calls).toEqual([...listed]);
      expectNothingDeleted(w);
      expectNoBucketTouched(w);
    },
  );

  test("a run that finished is done, even when the interrupt landed at its end", async () => {
    const w = bucketless();
    let interrupted = false;
    const removeAll = w.planStore.removeAll.bind(w.planStore);
    w.planStore.removeAll = async (factoryId) => {
      await removeAll(factoryId);
      interrupted = true;
    };
    const result = await teardownFactory({ ...w.deps, interrupted: () => interrupted }, request(w));
    expect(result).toMatchObject({
      kind: "done",
      report: { withoutLock: ranWithoutLock(BUCKET) },
    });
    expect(interrupted).toBe(true);
    expect(w.secrets.secrets()).toEqual([]);
    expectNoBucketTouched(w);
  });

  test("interrupted before anything is listed, nothing is locked", async () => {
    const w = bucketless();
    expect(await teardownFactory({ ...w.deps, interrupted: () => true }, request(w))).toEqual({
      kind: "interrupted",
      locked: false,
    });
    expect(w.admin.calls).toEqual([]);
    expectNoBucketTouched(w);
  });
});
