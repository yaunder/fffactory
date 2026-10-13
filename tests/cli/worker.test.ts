import { describe, expect, test } from "bun:test";
import type { AgentActivity } from "../../src/application/control-plane";
import type { MachineControl } from "../../src/application/machine-control";
import { ProvisioningFailed } from "../../src/application/provisioner";
import { run, waitsOnInterrupt } from "../../src/cli/run";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { FactoryInstance, Release, SecretReference } from "../../src/domain/instance";
import type { Machine } from "../../src/domain/status";
import type { PeerView } from "../../src/domain/tailnet";
import type { AwsSession } from "../../src/infrastructure/aws-session";
import {
  type Ec2ControlCalls,
  ec2MachineControl,
} from "../../src/infrastructure/ec2-machine-control";
import { harness, TEST_NOW } from "../support/cli-harness";
import { FAKE_CALLER, fakeCallerIdentity } from "../support/doctor-fakes";
import { fakeControlPlane } from "../support/fake-control-plane";
import { fakePrompt, fakeSecretStore } from "../support/fake-secrets";
import {
  fakeMachineControl,
  fakeMachineInventory,
  fakeTailnet,
  fakeTailnetAdmin,
  fakeTransport,
  machine,
  peer,
  peers,
  readyWorker,
  statusAnswers,
  tailnetDevice,
} from "../support/fake-workers";
import { BUCKET, declaring, FACTORY, RELEASE, WORKER_TAG } from "../support/factory-world";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { MemoryLockStore } from "../support/memory-lock-store";
import { fakeFactoryWorld } from "../support/fake-provisioner";

const PATH = "/work/repo/.fffactory/factory.json";
const KEY = "builder-1";
const HOSTNAME = `${FACTORY}-${KEY}`;
const ID = "i-0123456789abcdef0";
const ONLINE = peers(peer(HOSTNAME, { tags: [WORKER_TAG] }));

interface Setup {
  readonly instance?: FactoryInstance;
  readonly state?: Machine["state"];
  readonly states?: readonly (
    | "stopping"
    | "stopped"
    | "pending"
    | "running"
    | "shutting-down"
    | "terminated"
  )[];
  readonly activity?: AgentActivity;
  readonly view?: PeerView;
  readonly control?: MachineControl;
  readonly identity?: ReturnType<typeof fakeCallerIdentity>;
  readonly prompt?: ReturnType<typeof fakePrompt>;
  readonly interruptOnSleep?: boolean;
  readonly worker?: ReturnType<typeof readyWorker>;
  readonly repositories?: "synchronized" | "unresolved";
  readonly admin?: Parameters<typeof fakeTailnetAdmin>[0];
  /** The EC2 inventory: the one machine carrying builder-1's key, unless given. */
  readonly machines?: readonly Machine[];
  /** The host keys the factory's Terraform state has provisioned. */
  readonly provisioned?: readonly string[];
}

const ADMIN_ARN =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/tailscale-admin-client-AbCdEf" as SecretReference;
const ADMIN_SECRET = "tskey-client-kExample1CNTRL-0123456789abcdef";

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

/** builder-1 answering its inspection, its repository result and its dispatch state. */
function workerTransport(options: Setup) {
  return fakeTransport({
    [HOSTNAME]: statusAnswers(
      options.worker ?? readyWorker(FACTORY, KEY, RELEASE),
      options.repositories ?? "synchronized",
    ),
  });
}

/** The EC2 inventory's machines: builder-1's, in the state given, unless the setup lists them. */
function machinesOf(options: Setup): readonly Machine[] {
  return options.machines ?? [machine(KEY, options.state ?? "running", ID)];
}

function setup(options: Setup = {}) {
  const store = new MemoryInstanceStore({
    [PATH]: JSON.stringify(options.instance ?? declaring(KEY, "builder-2")),
  });
  const lockStore = new MemoryLockStore([BUCKET]);
  const terraform = fakeFactoryWorld({
    store: lockStore,
    bucket: BUCKET,
    hosts: options.provisioned ?? [KEY, "builder-2"],
    instanceIds: { [KEY]: ID },
  });
  const control = fakeMachineControl({ states: options.states ?? ["stopped"] });
  const controlPlane = fakeControlPlane("healthy", options.activity ?? { kind: "idle" });
  const identity = options.identity ?? fakeCallerIdentity();
  const transport = workerTransport(options);
  const admin = fakeTailnetAdmin(
    options.admin ?? { devices: [tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG])] },
  );
  let interrupted = false;
  const cli = harness(
    store,
    {},
    {
      lockStore,
      identity: identity.identity,
      machines: fakeMachineInventory({ kind: "machines", machines: machinesOf(options) }).machines,
      provisioner: terraform.provisioner,
      machineControl: options.control ?? control.control,
      controlPlane: controlPlane.controlPlane,
      tailnet: fakeTailnet(options.view ?? ONLINE).tailnet,
      transport: transport.transport,
      prompt: (options.prompt ?? fakePrompt()).prompt,
      secrets: fakeSecretStore({ values: { [ADMIN_ARN]: ADMIN_SECRET } }).store,
      tailnetAdmin: admin.admin,
      interrupted: () => interrupted,
      sleep: async () => {
        if (options.interruptOnSleep) interrupted = true;
      },
    },
  );
  return { ...cli, store, lockStore, terraform, control, controlPlane, identity, transport, admin };
}

const all = (cli: { out: string[]; err: string[] }) => [...cli.out, ...cli.err].join("\n");

describe("fffactory worker stop (worker-lifecycle §Stop)", () => {
  test("stops an idle worker with --yes, under the lock, and names its record", async () => {
    const cli = setup({ states: ["stopping", "stopped"] });
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(0);
    expect(cli.err).toEqual([]);
    expect(cli.out[0]).toBe(`Instance: ${PATH} (nearest .fffactory/factory.json)`);
    expect(cli.out).toContain(`Worker ${KEY} (${HOSTNAME}): EC2 instance ${ID} is running.`);
    expect(cli.out).toContain(
      `Stopping EC2 instance ${ID}; waiting for it to be stopped (up to 10 min).`,
    );
    expect(cli.out).toContain(
      `Stopped worker ${KEY} (${HOSTNAME}). Its instance, volume, tailnet device and ` +
        `factory.json entry stay; \`fffactory worker start ${KEY}\` brings it back.`,
    );
    expect(cli.out.at(-1)).toMatch(
      new RegExp(`^Operation record: s3://${BUCKET}/fff-abcd1234-operations/.+\\.json$`),
    );
    expect(cli.control.mutations()).toEqual([`stop ${ID}`]);
    expect(cli.lockStore.locks.size).toBe(0);
  });

  test("refuses with active agents, naming the way on; --force overrides", async () => {
    const refused = setup({ activity: { kind: "active", count: 1 } });
    expect(await run(["worker", "stop", KEY, "--yes"], refused.context)).toBe(1);
    expect(refused.err).toEqual([
      `Refusing to stop the worker: 1 agent is active on ${HOSTNAME}: stopping it would end it`,
      `Next: Wait until no agent is active there, then rerun \`fffactory worker stop ${KEY}\`, or pass --force to stop it anyway.`,
    ]);
    expect(refused.control.mutations()).toEqual([]);
    const forced = setup({ activity: { kind: "active", count: 1 } });
    expect(await run(["worker", "stop", KEY, "--yes", "--force"], forced.context)).toBe(0);
    expect(forced.out).toContain("--force: the worker is not inspected for active agents.");
    expect(forced.control.mutations()).toEqual([`stop ${ID}`]);
  });

  test("refuses a running worker it cannot inspect", async () => {
    const cli = setup({ view: peers(peer(HOSTNAME, { tags: [WORKER_TAG], online: false })) });
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(1);
    expect(cli.err[0]).toBe(
      `Refusing to stop the worker: ${HOSTNAME} could not be inspected: Offline in the tailnet`,
    );
  });

  test("refuses a running worker missing from the tailnet, naming status, never terminate", async () => {
    const cli = setup({ view: peers() });
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(1);
    expect(cli.err).toEqual([
      `Refusing to stop the worker: ${HOSTNAME} could not be inspected: No Tailscale device named ${HOSTNAME} is visible from this machine`,
      `Next: Check the worker with \`fffactory status\`, then rerun \`fffactory worker stop ${KEY}\`. --force stops it uninspected.`,
    ]);
    expect(cli.control.mutations()).toEqual([]);
  });

  test("an already stopped worker is a no-op success", async () => {
    const cli = setup({ state: "stopped" });
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(0);
    expect(cli.out).toContain(`Worker ${KEY} (${HOSTNAME}) is already stopped: nothing to do.`);
    expect(cli.control.calls).toEqual([]);
  });

  test("a stopping worker is waited for", async () => {
    const cli = setup({ state: "stopping" });
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(0);
    expect(cli.out).toContain(
      `EC2 instance ${ID} is already on its way; waiting for it to be stopped (up to 10 min).`,
    );
    expect(cli.out).toContain(
      `Worker ${KEY} (${HOSTNAME}) is now stopped: it was already on its way, and fffactory waited for it.`,
    );
    expect(all(cli)).not.toContain("nothing to do");
    expect(cli.control.mutations()).toEqual([]);
  });

  test("asks y/N at a terminal; declining changes nothing", async () => {
    const prompt = fakePrompt({ interactive: true, answers: ["n"] });
    const cli = setup({ prompt });
    expect(await run(["worker", "stop", KEY], cli.context)).toBe(1);
    expect(prompt.asked).toEqual([`Stop worker ${KEY} (${HOSTNAME}), EC2 instance ${ID}? [y/N] `]);
    expect(cli.err[0]).toBe("Not confirmed: the worker was not stopped.");
    expect(cli.control.mutations()).toEqual([]);
  });

  test("without a terminal and without --yes, refuses before anything reaches AWS", async () => {
    const cli = setup();
    expect(await run(["worker", "stop", KEY], cli.context)).toBe(1);
    expect(cli.err).toEqual([
      "Stopping a worker needs your confirmation: rerun at a terminal, or pass --yes.",
    ]);
    expect(cli.identity.requests).toEqual([]);
  });

  test("a failed EC2 call is reported by error name, never AWS's message", async () => {
    const denied = Object.assign(new Error("AWS says wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"), {
      name: "UnauthorizedOperation",
      $fault: "client",
    });
    const open = async (_session: AwsSession): Promise<Ec2ControlCalls> => ({
      stopInstances: async () => {
        throw denied;
      },
      startInstances: async () => {
        throw denied;
      },
      terminateInstances: async () => {
        throw denied;
      },
      describeInstances: async () => {
        throw denied;
      },
      close: () => {},
    });
    const cli = setup({ control: ec2MachineControl(open) });
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(1);
    expect(cli.err[0]).toBe(
      "Stopping the worker failed: EC2 StopInstances failed: UnauthorizedOperation",
    );
    expect(all(cli)).not.toContain("wJalrXUtnFEMI");
    expect(cli.lockStore.locks.size).toBe(0);
  });
});

describe("refusals before any EC2 mutation (worker-lifecycle §Order)", () => {
  test("an undeclared key, never reaching AWS", async () => {
    const cli = setup();
    expect(await run(["worker", "start", "builder-9", "--yes"], cli.context)).toBe(1);
    expect(cli.err).toEqual([
      "Refusing to start the worker: factory.json declares no host builder-9",
      "  Declared hosts: builder-1, builder-2",
      "Next: Name a host factory.json declares (hosts[].key)",
    ]);
    expect(cli.identity.requests).toEqual([]);
  });

  test("an argument that is not a host key is never echoed", async () => {
    const cli = setup();
    const pasted = "tskey-auth-kExample1CNTRL-secretvalue";
    expect(await run(["worker", "stop", pasted, "--yes"], cli.context)).toBe(1);
    expect(cli.err[0]).toBe("Refusing to stop the worker: The KEY argument is not a host key");
    expect(all(cli)).not.toContain(pasted);
  });

  test("another account", async () => {
    const identity = fakeCallerIdentity({
      kind: "caller",
      caller: { ...FAKE_CALLER, account: "999999999999" },
    });
    const cli = setup({ identity });
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(1);
    expect(cli.err[0]).toStartWith("Refusing to stop the worker: ");
    expect(cli.lockStore.calls).toEqual([]);
    expect(cli.control.calls).toEqual([]);
  });

  test("a pin mismatch", async () => {
    const cli = setup({ instance: { ...declaring(KEY), release: "0.2.0" as Release } });
    expect(await run(["worker", "start", KEY, "--yes"], cli.context)).toBe(1);
    expect(cli.err[0]).toStartWith(
      "Refusing to start the worker: factory.json pins another fffactory release than this one",
    );
    expect(cli.lockStore.calls).toEqual([]);
  });

  test("an incomplete factory.json", async () => {
    const cli = setup({ instance: { ...declaring(KEY), state_backend: undefined } });
    expect(await run(["worker", "start", KEY, "--yes"], cli.context)).toBe(1);
    expect(cli.err).toEqual([
      "Refusing to start the worker: factory.json is not ready:",
      "  state_backend.bucket: is required to start a worker",
    ]);
  });

  test("a held lock, showing its holder", async () => {
    const cli = setup();
    cli.lockStore.hold(
      BUCKET,
      newLockRecord({
        factoryId: FACTORY,
        operation: "apply",
        holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
        now: TEST_NOW,
        release: RELEASE,
        randomBytes: (count) => new Uint8Array(count).fill(5),
      }),
    );
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(1);
    expect(cli.err[0]).toBe("The factory is locked by another operation:");
    expect(cli.control.calls).toEqual([]);
  });

  test("no instance carrying the key, named with its record", async () => {
    const cli = setup();
    const context = {
      ...cli.context,
      machines: fakeMachineInventory({ kind: "machines", machines: [] }).machines,
    };
    expect(await run(["worker", "stop", KEY, "--yes"], context)).toBe(1);
    expect(cli.err).toEqual([
      `Refusing to stop the worker: No EC2 instance carries the host key ${KEY}`,
      `Next: Provision it with \`fffactory apply\`, then rerun \`fffactory worker stop ${KEY}\`.`,
    ]);
    expect(cli.out.at(-1)).toStartWith("Operation record: s3://");
  });
});

describe("fffactory worker start (worker-lifecycle §Start)", () => {
  test("starts a stopped worker and reports its status verdict", async () => {
    const cli = setup({ state: "stopped", states: ["running"] });
    expect(await run(["worker", "start", KEY, "--yes"], cli.context)).toBe(0);
    expect(cli.out).toContain(
      `Starting EC2 instance ${ID}; waiting for it to be running (up to 10 min).`,
    );
    expect(cli.out).toContain(`Started worker ${KEY} (${HOSTNAME}).`);
    expect(cli.out).toContain(`  ready  Ready on release ${RELEASE}`);
    expect(cli.control.mutations()).toEqual([`start ${ID}`]);
  });

  test("a stale release names `fffactory apply`, and still exits 0", async () => {
    const cli = setup({
      state: "stopped",
      states: ["running"],
      worker: readyWorker(FACTORY, KEY, "0.2.0"),
    });
    expect(await run(["worker", "start", KEY, "--yes"], cli.context)).toBe(0);
    expect(cli.out).toContain(`  not ready  It runs release 0.2.0; factory.json pins ${RELEASE}`);
    expect(cli.out).toContain(
      `  Next: Install release ${RELEASE} with \`fffactory apply\`, then rerun \`fffactory status\`.`,
    );
  });

  test("a worker that does not come online names status's tailnet next action", async () => {
    const cli = setup({
      state: "stopped",
      states: ["running"],
      view: peers(peer(HOSTNAME, { tags: [WORKER_TAG], online: false })),
    });
    expect(await run(["worker", "start", KEY, "--yes"], cli.context)).toBe(0);
    expect(cli.out).toContain(
      `Waiting for ${HOSTNAME} to come online in the tailnet (up to 5 min).`,
    );
    expect(cli.out).toContain("  not ready  Offline in the tailnet");
  });

  test("an already running worker is a no-op success that reports its verdict", async () => {
    const cli = setup();
    expect(await run(["worker", "start", KEY, "--yes"], cli.context)).toBe(0);
    expect(cli.out).toContain(`Worker ${KEY} (${HOSTNAME}) is already running.`);
    expect(cli.out).toContain(`  ready  Ready on release ${RELEASE}`);
    expect(cli.control.calls).toEqual([]);
  });

  test("a pending worker is waited for, and said to have been", async () => {
    const cli = setup({ state: "pending", states: ["running"] });
    expect(await run(["worker", "start", KEY, "--yes"], cli.context)).toBe(0);
    expect(cli.out).toContain(
      `Worker ${KEY} (${HOSTNAME}) is now running: it was already on its way, and fffactory waited for it.`,
    );
    expect(all(cli)).not.toContain("already running");
    expect(cli.control.mutations()).toEqual([]);
  });
});

describe("interruption (worker-lifecycle §Interruption)", () => {
  test("during the wait: the lock stays, with the record, and the rerun is named", async () => {
    const cli = setup({ states: ["stopping"], interruptOnSleep: true });
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(1);
    expect(cli.err).toEqual([
      "EC2 was asked to change the instance and may still be doing so.",
      "Interrupted: the factory stays locked, with a record of this operation. Once fffactory " +
        `has exited, break the lock with \`fffactory lock break\`, then rerun \`fffactory worker stop ${KEY}\`.`,
    ]);
    expect(cli.out.at(-1)).toStartWith("Operation record: s3://");
    expect(cli.lockStore.locks.size).toBe(1);
  });

  test("with the lock but no record: says it may have none", async () => {
    const cli = setup();
    let interrupted = false;
    const create = cli.lockStore.create.bind(cli.lockStore);
    cli.lockStore.create = async (bucket, record) => {
      const created = await create(bucket, record);
      interrupted = true;
      return created;
    };
    const context = { ...cli.context, interrupted: () => interrupted };
    expect(await run(["worker", "stop", KEY, "--yes"], context)).toBe(1);
    expect(cli.err).toEqual([
      "Interrupted: the factory stays locked by this operation, which may have no operation " +
        "record. Once fffactory has exited, break the lock with `fffactory lock break`, then " +
        `rerun \`fffactory worker stop ${KEY}\`.`,
    ]);
    expect(all(cli)).not.toContain("Operation record:");
  });

  test("before the lock: nothing is locked", async () => {
    const cli = setup();
    const context = { ...cli.context, interrupted: () => true };
    expect(await run(["worker", "stop", KEY, "--yes"], context)).toBe(1);
    expect(cli.err).toEqual([
      "Interrupted before the factory was locked: it is not locked, and nothing was asked of EC2.",
    ]);
  });

  test("waits on an interrupt, since it reports what the interrupt left", () => {
    expect(waitsOnInterrupt(["worker", "stop", KEY])).toBe(true);
  });
});

describe("fffactory worker arguments", () => {
  test("needs a subcommand", async () => {
    const cli = setup();
    expect(await run(["worker"], cli.context)).toBe(1);
    expect(cli.err[0]).toBe("fffactory worker: expected a subcommand: stop, start, terminate");
  });

  test("needs exactly one KEY", async () => {
    const cli = setup();
    expect(await run(["worker", "stop", "--yes"], cli.context)).toBe(1);
    expect(cli.err[0]).toBe("fffactory worker stop: expected one host KEY");
    expect(await run(["worker", "start", "a", "b"], cli.context)).toBe(1);
    expect(cli.err.at(-1)).toBe("fffactory worker start: expected one host KEY");
  });

  test("--profile needs a name; start takes no --force", async () => {
    const cli = setup();
    expect(await run(["worker", "stop", KEY, "--profile", ""], cli.context)).toBe(1);
    expect(cli.err[0]).toBe("fffactory worker stop: --profile needs a profile name");
    expect(await run(["worker", "start", KEY, "--force"], cli.context)).toBe(1);
    expect(cli.err.at(-1)).toContain("--force");
  });

  test("is listed in help, and --help prints its usage", async () => {
    const cli = setup();
    expect(await run(["--help"], cli.context)).toBe(0);
    expect(cli.out.some((line) => line.startsWith("  worker "))).toBe(true);
    expect(await run(["worker", "--help"], cli.context)).toBe(0);
    expect(cli.out).toContain(
      "Usage: fffactory worker stop KEY [--force] [--yes] [--instance PATH] [--profile NAME]",
    );
  });

  test("an invalid factory.json is refused", async () => {
    const cli = harness(
      new MemoryInstanceStore({ [PATH]: '{"schema_version": 1, "factory_id": "X"}' }),
    );
    expect(await run(["worker", "stop", KEY, "--yes"], cli.context)).toBe(1);
    expect(cli.err[0]).toBe("Invalid factory.json:");
  });
});

/** `worker terminate KEY --keep`, confirmed with `--confirm KEY`, plus `more`. */
const TERMINATE = (...more: string[]) => [
  "worker",
  "terminate",
  KEY,
  "--keep",
  "--confirm",
  KEY,
  ...more,
];
const TERMINATING = { instance: withAdmin(), states: ["shutting-down", "terminated"] } as const;

describe("fffactory worker terminate --keep (worker-lifecycle §Terminate (keep))", () => {
  test("terminates the worker, deletes its tailnet device and keeps the host", async () => {
    const cli = setup(TERMINATING);
    expect(await run(TERMINATE(), cli.context)).toBe(0);
    expect(cli.err).toEqual([]);
    expect(cli.out).toEqual([
      `Instance: ${PATH} (nearest .fffactory/factory.json)`,
      `Worker ${KEY} (${HOSTNAME}): EC2 instance ${ID} is running.`,
      `Terminating EC2 instance ${ID}; waiting for it to be terminated (up to 10 min).`,
      `Deleting the Tailscale devices named ${HOSTNAME}.`,
      `Terminated worker ${KEY} (${HOSTNAME}): its EC2 instance and root volume are gone. ` +
        "factory.json keeps the host, so `fffactory apply` creates it afresh.",
      `Deleted Tailscale device nWorker1CNTRL (${HOSTNAME}).`,
      expect.stringMatching(/^Operation record: s3:\/\/fff-abcd1234-state\/.+\.json$/),
    ]);
    expect(cli.control.mutations()).toEqual([`terminate ${ID}`]);
    expect(cli.admin.calls).toEqual(["open", "devices", "remove nWorker1CNTRL"]);
    expect(all(cli)).not.toContain(ADMIN_SECRET);
    expect(cli.lockStore.locks.size).toBe(0);
  });

  test("a running worker that never joined the tailnet is refused, naming --force for a failed bootstrap", async () => {
    const missing = setup({ ...TERMINATING, view: peers(), admin: { devices: [] } });
    expect(await run(TERMINATE(), missing.context)).toBe(1);
    expect(missing.err).toEqual([
      `Refusing to terminate the worker: ${HOSTNAME} could not be inspected: No Tailscale device named ${HOSTNAME} is visible from this machine`,
      `Next: Check the worker with \`fffactory status\`, then rerun \`fffactory worker terminate ${KEY} --keep\`. ` +
        "If the instance's EC2 console output shows its bootstrap failed, it never joined the " +
        "tailnet: rerun with --force, which terminates it uninspected.",
    ]);
    expect(missing.control.mutations()).toEqual([]);
    const forced = setup({ ...TERMINATING, view: peers(), admin: { devices: [] } });
    expect(await run(TERMINATE("--force"), forced.context)).toBe(0);
    expect(forced.control.mutations()).toEqual([`terminate ${ID}`]);
  });

  test("a stopped worker is terminated uninspected, and says what that leaves unreported", async () => {
    const cli = setup({ ...TERMINATING, state: "stopped" });
    expect(await run(TERMINATE(), cli.context)).toBe(0);
    expect(cli.out).toContain(
      "The machine is stopped: the worker is not inspected, and unpushed work on its disk is not reported.",
    );
    expect(cli.transport.calls).toEqual([]);
  });

  test("no device left to delete says so", async () => {
    const cli = setup({ ...TERMINATING, admin: { devices: [] } });
    expect(await run(TERMINATE(), cli.context)).toBe(0);
    expect(cli.out).toContain(`No Tailscale device named ${HOSTNAME} remained to delete.`);
  });

  test("a device-deletion failure exits 2, naming the admin console; the terminate stands", async () => {
    const cli = setup({
      ...TERMINATING,
      admin: {
        devices: [
          tailnetDevice("nWorker1CNTRL", HOSTNAME, [WORKER_TAG]),
          tailnetDevice("nIntruder1CNTRL", HOSTNAME, ["tag:other"]),
        ],
        failing: { nWorker1CNTRL: "Tailscale answered HTTP 500" },
      },
    });
    expect(await run(TERMINATE(), cli.context)).toBe(2);
    expect(cli.out).toContain(
      `Terminated worker ${KEY} (${HOSTNAME}): its EC2 instance and root volume are gone. ` +
        "factory.json keeps the host, so `fffactory apply` creates it afresh.",
    );
    expect(cli.err).toEqual([
      `Deleting the worker's tailnet devices was not complete: Not every Tailscale device named ${HOSTNAME} was deleted`,
      "  Deleting device nWorker1CNTRL failed: Tailscale answered HTTP 500",
      "  Device nIntruder1CNTRL does not carry the factory's tag (tailscale.tag in factory.json): not deleted",
      `Next: Remove the remaining devices named ${HOSTNAME} at https://login.tailscale.com/admin/machines ` +
        "yourself (one without the factory's tag only if it was this worker), then run " +
        "`fffactory apply`, which creates the worker afresh.",
    ]);
    expect(all(cli)).not.toContain("tag:other");
    expect(cli.out.at(-1)).toStartWith("Operation record: s3://");
  });

  test("active agents or unresolved checkouts refuse it; --force overrides", async () => {
    const busy = setup({ ...TERMINATING, activity: { kind: "active", count: 1 } });
    expect(await run(TERMINATE(), busy.context)).toBe(1);
    expect(busy.err).toEqual([
      `Refusing to terminate the worker: 1 agent is active on ${HOSTNAME}: terminating it would end it`,
      `Next: Wait until no agent is active there, then rerun \`fffactory worker terminate ${KEY} --keep\`, or pass --force to terminate it anyway.`,
    ]);
    const dirty = setup({ ...TERMINATING, repositories: "unresolved" });
    expect(await run(TERMINATE(), dirty.context)).toBe(1);
    expect(dirty.err[0]).toBe(
      `Refusing to terminate the worker: Placed repositories on ${HOSTNAME} are unresolved: terminating it would lose their work`,
    );
    for (const cli of [busy, dirty]) expect(cli.control.mutations()).toEqual([]);
    const forced = setup({ ...TERMINATING, activity: { kind: "active", count: 1 } });
    expect(await run(TERMINATE("--force"), forced.context)).toBe(0);
    expect(forced.out).toContain(
      "--force: the worker is not inspected for active agents or checkouts.",
    );
    expect(forced.control.mutations()).toEqual([`terminate ${ID}`]);
  });

  test("at a terminal, the host key is typed; anything else declines", async () => {
    const asked = fakePrompt({ interactive: true, answers: ["yes"] });
    const cli = setup({ ...TERMINATING, prompt: asked });
    expect(await run(["worker", "terminate", KEY, "--keep"], cli.context)).toBe(1);
    expect(asked.asked).toEqual([
      `Terminate worker ${KEY} (${HOSTNAME}), EC2 instance ${ID}? Its machine and root volume ` +
        "are destroyed. Type the host key to confirm: ",
    ]);
    expect(cli.err).toEqual(["Not confirmed: the worker was not terminated."]);
    expect(cli.control.mutations()).toEqual([]);
  });
});

describe("fffactory worker terminate's refusals (worker-lifecycle §Terminate (keep))", () => {
  test("without the admin client, naming how to store it", async () => {
    const cli = setup({ states: ["terminated"] });
    expect(await run(TERMINATE(), cli.context)).toBe(1);
    expect(cli.err).toEqual([
      "Refusing to terminate the worker: factory.json has no Tailscale admin client " +
        "(tailscale.admin_client_secret): terminate deletes the worker's tailnet device with it",
      "Next: Store it with `fffactory secret set tailscale-admin-client`, then rerun " +
        `\`fffactory worker terminate ${KEY} --keep\`.`,
    ]);
    expect(cli.identity.requests).toEqual([]);
  });

  test("--confirm naming another key, never echoed; no terminal and no --confirm", async () => {
    const pasted = "tskey-auth-kExample1CNTRL-secretvalue";
    const cli = setup(TERMINATING);
    expect(
      await run(["worker", "terminate", KEY, "--keep", "--confirm", pasted], cli.context),
    ).toBe(1);
    expect(cli.err[0]).toBe(
      `Refusing to terminate the worker: --confirm does not name the host ${KEY}`,
    );
    expect(all(cli)).not.toContain(pasted);
    expect(await run(["worker", "terminate", KEY, "--keep"], cli.context)).toBe(1);
    expect(cli.err.at(-1)).toBe(
      "Terminating a worker needs your confirmation: rerun at a terminal, or pass --confirm KEY.",
    );
    expect(cli.identity.requests).toEqual([]);
  });

  test("takes no --yes", async () => {
    const cli = setup(TERMINATING);
    expect(await run(["worker", "terminate", KEY, "--keep", "--yes"], cli.context)).toBe(1);
    expect(cli.err.at(-1)).toContain("--yes");
    expect(cli.control.calls).toEqual([]);
  });

  test("interrupted once EC2 was asked: the lock stays, and the device may remain", async () => {
    const cli = setup({ ...TERMINATING, states: ["shutting-down"], interruptOnSleep: true });
    expect(await run(TERMINATE(), cli.context)).toBe(1);
    expect(cli.err).toEqual([
      "EC2 was asked to terminate the instance and may still be doing so; its tailnet devices " +
        "may remain: check them at https://login.tailscale.com/admin/machines.",
      "Interrupted: the factory stays locked, with a record of this operation. Once fffactory " +
        "has exited, break the lock with `fffactory lock break`, then rerun " +
        `\`fffactory worker terminate ${KEY} --keep\`.`,
    ]);
  });

  test("its usage is printed with the others", async () => {
    const cli = setup();
    expect(await run(["worker", "--help"], cli.context)).toBe(0);
    expect(cli.out).toContain(
      "       fffactory worker terminate KEY [--keep] [--force] [--confirm KEY] [--instance PATH] [--profile NAME]",
    );
  });
});

const REMOVE = (...more: string[]) => ["worker", "terminate", KEY, "--confirm", KEY, ...more];

describe("fffactory worker terminate (worker-lifecycle §Terminate (remove))", () => {
  test("shows the removal plan, applies it, writes factory.json without the host and deletes its device", async () => {
    const cli = setup({ instance: withAdmin() });
    expect(await run(REMOVE(), cli.context)).toBe(0);
    expect(cli.err).toEqual([]);
    expect(cli.out).toEqual([
      `Instance: ${PATH} (nearest .fffactory/factory.json)`,
      `Worker ${KEY} (${HOSTNAME}): EC2 instance ${ID} is running.`,
      `Planning the removal of host ${KEY}. Terraform's output is not shown.`,
      "Removal plan:",
      `  Configuration: ${PATH}`,
      `  Factory: Test factory (${FACTORY})`,
      "  AWS account: 123456789012, Region: eu-west-2",
      `  Release: ${RELEASE}`,
      "Infrastructure changes:",
      `  - module.hosts.aws_instance.host["${KEY}"]`,
      "  0 to add, 0 to change, 1 to destroy.",
      `factory.json: remove host ${KEY}.`,
      `Tailnet: delete the devices named ${HOSTNAME} that carry the factory's tag.`,
      "Applying the removal plan. Terraform's output is not shown; this can take several minutes.",
      `factory.json no longer declares host ${KEY}: ${PATH}`,
      `Deleting the Tailscale devices named ${HOSTNAME}.`,
      `Removed worker ${KEY} (${HOSTNAME}): its EC2 instance and root volume are gone, and ` +
        "neither Terraform nor factory.json records it.",
      `Deleted Tailscale device nWorker1CNTRL (${HOSTNAME}).`,
      expect.stringMatching(/^Operation record: s3:\/\/fff-abcd1234-state\/.+\.json$/),
    ]);
    const written = JSON.parse(cli.store.files[PATH] as string) as FactoryInstance;
    expect(written.hosts?.map((host): string => host.key)).toEqual(["builder-2"]);
    expect([...cli.terraform.world.hosts]).toEqual(["builder-2"]);
    expect(cli.control.mutations()).toEqual([]);
    expect(all(cli)).not.toContain(ADMIN_SECRET);
    expect(cli.lockStore.locks.size).toBe(0);
  });

  test("a plan with any other change is refused before the question, applying nothing", async () => {
    const cli = setup({ instance: withAdmin(), provisioned: [KEY] });
    expect(await run(REMOVE(), cli.context)).toBe(1);
    expect(cli.err).toEqual([
      `Refusing to terminate the worker: The removal plan changes more than host ${KEY}'s ` +
        "machine: apply factory.json's other changes first",
      '  module.hosts.aws_instance.host["builder-2"] would be created',
      "Next: Apply factory.json's other changes first with `fffactory apply`, or undo them, " +
        `then rerun \`fffactory worker terminate ${KEY}\`.`,
    ]);
    expect(cli.terraform.calls.map(({ call }) => call)).not.toContain("applyPlan");
    expect(cli.store.writes).toEqual([]);
  });

  test("a failed Terraform apply prints where its diagnostics are, never their text", async () => {
    const cli = setup({ instance: withAdmin() });
    const failing = {
      ...cli.context,
      provisioner: {
        ...cli.context.provisioner,
        applyPlan: async () => {
          throw new ProvisioningFailed(
            "`terraform apply` exited with status 1",
            "/home/operator/.cache/fffactory/terraform/diagnostics/apply.log",
          );
        },
      },
    };
    expect(await run(REMOVE(), failing)).toBe(1);
    expect(cli.err).toEqual([
      "Terminating the worker failed: Removing the host failed: `terraform apply` exited with status 1",
      "  Terraform may have destroyed the machine before it stopped. factory.json is unchanged: " +
        `it still declares host ${KEY}.`,
      `Next: Rerun \`fffactory worker terminate ${KEY}\`: it plans the removal again from what ` +
        "exists now, and finishes it.",
      "Terraform's diagnostics: /home/operator/.cache/fffactory/terraform/diagnostics/apply.log",
    ]);
    expect(cli.out.at(-1)).toStartWith("Operation record: s3://");
    expect(cli.store.writes).toEqual([]);
  });

  test("a host whose machine is already gone is removed, saying so", async () => {
    const cli = setup({ instance: withAdmin(), machines: [], provisioned: ["builder-2"] });
    expect(await run(REMOVE(), cli.context)).toBe(0);
    expect(cli.out).toContain(
      `Worker ${KEY} (${HOSTNAME}): no EC2 instance carries its key; its machine is already gone.`,
    );
    expect(cli.out).toContain("Infrastructure: no changes.");
    expect(cli.out).not.toContain(
      "Applying the removal plan. Terraform's output is not shown; this can take several minutes.",
    );
  });

  test("the only declared host is refused before anything reaches AWS", async () => {
    const both = withAdmin();
    const cli = setup({ instance: { ...both, hosts: (both.hosts ?? []).slice(0, 1) } });
    expect(await run(REMOVE(), cli.context)).toBe(1);
    expect(cli.err[0]).toBe(
      `Refusing to terminate the worker: ${KEY} is the only host factory.json declares: a ` +
        "factory keeps at least one worker",
    );
    expect(cli.identity.requests).toEqual([]);
  });

  test("interrupted while Terraform applies: factory.json still declares the host, and the rerun finishes", async () => {
    const cli = setup({ instance: withAdmin() });
    let interrupted = false;
    cli.terraform.world.beforeChange = () => {
      interrupted = true;
    };
    expect(await run(REMOVE(), { ...cli.context, interrupted: () => interrupted })).toBe(1);
    expect(cli.err).toEqual([
      "Terraform was applying the removal and may have destroyed the machine; factory.json " +
        `still declares host ${KEY}, and the rerun finishes the removal.`,
      "Interrupted: the factory stays locked, with a record of this operation. Once fffactory " +
        "has exited, break the lock with `fffactory lock break`, then rerun " +
        `\`fffactory worker terminate ${KEY}\`.`,
    ]);
  });

  test("interrupted once factory.json is written: nothing to rerun, the devices may remain", async () => {
    const cli = setup({ instance: withAdmin() });
    let interrupted = false;
    const write = cli.store.write.bind(cli.store);
    cli.store.write = async (path, contents) => {
      await write(path, contents);
      interrupted = true;
    };
    expect(await run(REMOVE(), { ...cli.context, interrupted: () => interrupted })).toBe(1);
    expect(cli.err).toEqual([
      `factory.json no longer declares host ${KEY}, and Terraform destroyed its machine; its ` +
        "tailnet devices may remain: check them at https://login.tailscale.com/admin/machines.",
      "Interrupted: the factory stays locked, with a record of this operation. Once fffactory " +
        "has exited, break the lock with `fffactory lock break`.",
    ]);
  });
});
