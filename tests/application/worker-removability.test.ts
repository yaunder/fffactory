import { describe, expect, test } from "bun:test";
import {
  inspectRemovability,
  type Removability,
  type RemovabilityDependencies,
} from "../../src/application/worker-removability";
import type { CallerObservation } from "../../src/domain/aws-account";
import type { AgentsObservation } from "../../src/domain/control-plane";
import type { FactoryInstance } from "../../src/domain/instance";
import type { MachineInventory } from "../../src/domain/status";
import type { PeerView } from "../../src/domain/tailnet";
import { INSPECT_WORK_COMMAND } from "../../src/domain/work-inspection";
import { fakeCallerIdentity } from "../support/doctor-fakes";
import { agentsIn, fakeControlPlane } from "../support/fake-control-plane";
import {
  type Answer,
  fakeMachineInventory,
  fakeTailnet,
  fakeTransport,
  machine,
  peer,
  peers,
  readyWorker,
  statusAnswers,
  workAnswer,
} from "../support/fake-workers";
import {
  declaring,
  FACTORY,
  paseoPasswordArn,
  RELEASE,
  requestingDispatch,
  WORKER_TAG,
} from "../support/factory-world";

const B1 = `${FACTORY}-builder-1`;
const B2 = `${FACTORY}-builder-2`;
const ONLINE = peers(peer(B1, { tags: [WORKER_TAG] }), peer(B2, { tags: [WORKER_TAG] }));

/** A worker answering status's commands and terminate's work inspection with `work`. */
function worker(key: string, work?: Answer) {
  const hostname = `${FACTORY}-${key}`;
  const answers = statusAnswers(
    readyWorker(FACTORY, key, RELEASE, paseoPasswordArn(key)),
    "synchronized",
    [],
    undefined,
    workAnswer(hostname),
  );
  if (work === undefined) return answers;
  return (command: readonly string[], stdin: Uint8Array | undefined) =>
    command.includes("work")
      ? typeof work === "function"
        ? work(command, stdin)
        : work
      : typeof answers === "function"
        ? answers(command, stdin)
        : answers;
}

interface WorldOptions {
  readonly inventory?: MachineInventory;
  readonly agents?: AgentsObservation;
  readonly noControlPlane?: boolean;
  readonly view?: PeerView;
  readonly script?: Record<string, Answer>;
  readonly caller?: CallerObservation;
  readonly interruptAfter?: number;
}

function world(options: WorldOptions = {}) {
  const identity = fakeCallerIdentity(options.caller);
  const machines = fakeMachineInventory(
    options.inventory ?? {
      kind: "machines",
      machines: [
        machine("builder-1", "running", "i-0000000000000000a"),
        machine("builder-2", "stopped", "i-0000000000000000b"),
      ],
    },
  );
  const tailnet = fakeTailnet(options.view ?? ONLINE);
  const transport = fakeTransport(
    options.script ?? { [B1]: worker("builder-1"), [B2]: worker("builder-2") },
  );
  const controlPlane = fakeControlPlane("healthy", options.agents ?? agentsIn("finished"));
  let reads = 0;
  const deps: RemovabilityDependencies = {
    identity: identity.identity,
    machines: machines.machines,
    peers: tailnet.tailnet,
    transport: transport.transport,
    controlPlane: options.noControlPlane ? undefined : controlPlane.controlPlane,
    interrupted: () => {
      reads += 1;
      return options.interruptAfter !== undefined && reads > options.interruptAfter;
    },
  };
  return { deps, identity, machines, transport, controlPlane };
}

const INSTANCE: FactoryInstance = declaring("builder-1", "builder-2");

function inspect(deps: RemovabilityDependencies, key?: string, instance = INSTANCE) {
  return inspectRemovability(deps, { instance, key, credentials: { source: "chain" } });
}

/** Each worker's inspection document, without the next action inspect gives with it. */
function documents(outcome: Extract<Removability, { readonly kind: "inspected" }>) {
  return outcome.workers.map(({ inspection }) => inspection);
}

/** The work inspections the worker was asked for. */
function workCalls(transport: ReturnType<typeof fakeTransport>) {
  return transport.calls.filter(({ command }) =>
    INSPECT_WORK_COMMAND.every((word, index) => command[index] === word),
  );
}

describe("worker inspect (worker-lifecycle §Inspect)", () => {
  test("judges every declared worker in factory.json's order by terminate's own inspection", async () => {
    const { deps, transport, controlPlane, machines } = world();
    const outcome = await inspect(deps);
    if (outcome.kind !== "inspected") throw new Error(outcome.kind);
    expect(outcome.target).toEqual({
      factoryId: FACTORY,
      accountId: "123456789012",
      region: "eu-west-2",
      release: RELEASE,
    });
    expect(
      documents(outcome).map(({ key, verdict, not_inspected }) => [
        `${key}`,
        verdict,
        not_inspected,
      ]),
    ).toEqual([
      ["builder-1", "removable", null],
      ["builder-2", "not_inspected", "stopped"],
    ]);
    expect(outcome.workers[0]?.inspection?.activity).toEqual({
      state: "idle",
      reason: null,
      agents: [{ id: "agent-1", state: "finished", dispatched: true }],
    });
    // The running worker's agents and work are read; the stopped one is never asked anything.
    expect(controlPlane.calls).toEqual(["agents"]);
    expect(workCalls(transport).map(({ worker }) => worker.hostname)).toEqual([B1]);
    expect(transport.calls.every(({ worker }) => worker.hostname === B1)).toBe(true);
    expect(machines.requests).toHaveLength(1);
  });

  test("with KEY, judges only that worker", async () => {
    const { deps } = world();
    const outcome = await inspect(deps, "builder-2");
    if (outcome.kind !== "inspected") throw new Error(outcome.kind);
    expect(documents(outcome).map(({ key }) => `${key}`)).toEqual(["builder-2"]);
  });

  test("busy agents refuse it with every agent listed, and the work is never asked for", async () => {
    const { deps, transport } = world({ agents: agentsIn("working", "finished") });
    const outcome = await inspect(deps, "builder-1");
    if (outcome.kind !== "inspected") throw new Error(outcome.kind);
    const [only] = documents(outcome);
    expect(only).toMatchObject({
      verdict: "refused",
      summary: `1 agent is working on ${B1}: terminating it would end it`,
      activity: {
        state: "busy",
        agents: [
          { id: "agent-1", state: "working", dispatched: true },
          { id: "agent-2", state: "finished", dispatched: false },
        ],
      },
    });
    expect(workCalls(transport)).toEqual([]);
  });

  test("unpushed work refuses it, naming where", async () => {
    const dirty = workAnswer(B1, [
      {
        path: "/workspace/repos/acme/widget",
        state: "inspected",
        unpushed_commits: 2,
        unpushed_branches: ["feature"],
        stashes: 0,
        worktrees: [],
      },
    ]);
    const { deps } = world({ script: { [B1]: worker("builder-1", dirty) } });
    const outcome = await inspect(deps, "builder-1");
    if (outcome.kind !== "inspected") throw new Error(outcome.kind);
    expect(outcome.workers[0]?.inspection).toMatchObject({
      verdict: "refused",
      summary: `${B1} holds work not pushed to any remote: terminating it would lose it`,
    });
  });

  test("a checkout factory.json places there that the work inspection does not report refuses it", async () => {
    const { deps } = world();
    const outcome = await inspect(deps, "builder-1", requestingDispatch("builder-1"));
    if (outcome.kind !== "inspected") throw new Error(outcome.kind);
    expect(outcome.workers[0]?.inspection).toMatchObject({
      verdict: "refused",
      summary: `${B1} could not be fully inspected for unpushed work`,
      details: [
        "/workspace/repos/product: placed on this worker, but the work inspection did not report it",
      ],
    });
  });

  test("a worker it cannot inspect is refused: no control plane, or missing from the tailnet", async () => {
    const unreached = world({ noControlPlane: true });
    const outcome = await inspect(unreached.deps, "builder-1");
    if (outcome.kind !== "inspected") throw new Error(outcome.kind);
    expect(outcome.workers[0]?.inspection).toMatchObject({
      verdict: "refused",
      activity: {
        state: "unknown",
        reason: "this fffactory cannot reach the worker's control plane",
      },
    });
    const missing = world({ view: peers() });
    const unlocated = await inspect(missing.deps, "builder-1");
    if (unlocated.kind !== "inspected") throw new Error(unlocated.kind);
    expect(unlocated.workers[0]?.inspection).toMatchObject({
      verdict: "refused",
      activity: { state: "unknown", reason: null, agents: null },
    });
    expect(missing.controlPlane.calls).toEqual([]);
  });

  test("the machine decides first, as for terminate: shutting down or gone is not inspected, pending is refused", async () => {
    const { deps, controlPlane } = world({
      inventory: {
        kind: "machines",
        machines: [
          machine("builder-1", "shutting-down"),
          machine("builder-3", "pending", "i-0000000000000000c"),
        ],
      },
    });
    const outcome = await inspect(
      deps,
      undefined,
      declaring("builder-1", "builder-2", "builder-3"),
    );
    if (outcome.kind !== "inspected") throw new Error(outcome.kind);
    expect(
      outcome.workers.map(({ inspection: { verdict, not_inspected }, next_action }) => [
        verdict,
        not_inspected,
        next_action,
      ]),
    ).toEqual([
      ["not_inspected", "shutting_down", null],
      ["not_inspected", "absent", null],
      [
        "refused",
        null,
        "Wait until it is running, then rerun `fffactory worker inspect builder-3`.",
      ],
    ]);
    expect(controlPlane.calls).toEqual([]);
  });

  test("an EC2 inventory it cannot read refuses every worker, never taken for machines gone", async () => {
    const { deps } = world({
      inventory: {
        kind: "unavailable",
        reason: "EC2 DescribeInstances failed: UnauthorizedOperation",
      },
    });
    const outcome = await inspect(deps);
    if (outcome.kind !== "inspected") throw new Error(outcome.kind);
    expect(documents(outcome).map(({ verdict, summary }) => [verdict, summary])).toEqual([
      ["refused", "EC2 DescribeInstances failed: UnauthorizedOperation"],
      ["refused", "EC2 DescribeInstances failed: UnauthorizedOperation"],
    ]);
  });
});

describe("worker inspect's refusals (worker-lifecycle §Inspect)", () => {
  test("a KEY factory.json does not declare, before anything reaches AWS", async () => {
    const { deps, identity } = world();
    const outcome = await inspect(deps, "builder-9");
    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { summary: "factory.json declares no host builder-9" },
    });
    expect(identity.requests).toEqual([]);
  });

  test("an incomplete factory.json, before anything reaches AWS", async () => {
    const { deps, identity } = world();
    const { aws: _aws, ...incomplete } = INSTANCE;
    const outcome = await inspect(deps, undefined, incomplete as FactoryInstance);
    expect(outcome).toMatchObject({ kind: "incomplete" });
    expect(identity.requests).toEqual([]);
  });

  test("another account, before any inventory is read", async () => {
    const { deps, machines } = world({
      caller: {
        kind: "caller",
        caller: { account: "210987654321", arn: "arn:aws:iam::210987654321:user/other" },
      },
    });
    const outcome = await inspect(deps);
    expect(outcome.kind).toBe("account_refused");
    expect(machines.requests).toEqual([]);
  });

  test("interrupted, it asks the workers nothing more and reports nothing", async () => {
    const { deps } = world({ interruptAfter: 0 });
    expect(await inspect(deps)).toEqual({ kind: "interrupted" });
  });
});
