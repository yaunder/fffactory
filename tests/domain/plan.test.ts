import { describe, expect, test } from "bun:test";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import {
  archiveStaleness,
  bootstrapStaleness,
  changeKind,
  changeTally,
  createdWorkers,
  declaredWorkers,
  factoryPlanReview,
  hostKeyRemovalRefusal,
  hostMachineRefusal,
  isPlanId,
  newPlanId,
  newSavedBootstrapPlan,
  newSavedPlan,
  outputChanges,
  PLAN_SCHEMA_VERSION,
  PLAN_TTL_MS,
  type PlanCircumstances,
  type PlannedWorker,
  type ResourceChange,
  parseSavedPlan,
  pinRefusal,
  planStaleness,
  type ResizeGuard,
  resizedStoppedWorkers,
  resizeRefusal,
  resourceChanges,
  sameChanges,
  type SavedBootstrapPlan,
  type SavedFactoryPlan,
  type SavedPlan,
  serializeSavedPlan,
  type StaleReason,
  stateStaleness,
  stoppedStaleness,
} from "../../src/domain/plan";

const TARGET = {
  instancePath: "/work/.fffactory/factory.json",
  name: "Test factory",
  factoryId: "fff-abcd1234" as FactoryId,
  accountId: "123456789012",
  region: "eu-west-2",
  release: "0.3.0" as Release,
};
const HOST = 'module.hosts.aws_instance.host["builder-1"]';
const NOW = new Date("2026-09-30T12:00:00.000Z");

function change(address: string, actions: string[], type?: string): ResourceChange {
  return type === undefined ? { address, actions } : { address, type, actions };
}

describe("changes and their tally (plan-apply §Layer mapping)", () => {
  test("each change is of one kind, by its actions", () => {
    expect(
      [
        ["create"],
        ["update"],
        ["delete"],
        ["delete", "create"],
        ["create", "delete"],
        ["forget"],
        ["read"],
      ].map((actions) => changeKind(change(HOST, actions))),
    ).toEqual(["create", "update", "delete", "replace", "replace", "other", "other"]);
  });

  test("counts what changes: additions, in-place changes and destructions, reads and no-ops left out", () => {
    expect(
      changeTally([
        change(HOST, ["create"]),
        change("module.network.aws_vpc.this", ["update"]),
        change("module.network.aws_subnet.public", ["delete", "create"]),
        change("module.network.aws_route_table.public", ["create", "delete"]),
        change("module.host_identity.aws_iam_role_policy.read_secrets", ["delete"]),
        change("module.x.aws_thing.gone", ["forget"]),
        change("data.aws_ssm_parameter.al2023", ["read"]),
        change("module.network.aws_internet_gateway.this", ["no-op"]),
      ]),
    ).toEqual({ changing: 6, add: 3, change: 1, destroy: 3 });
    expect(changeTally([change("data.aws_ssm_parameter.al2023", ["read"])])).toEqual({
      changing: 0,
      add: 0,
      change: 0,
      destroy: 0,
    });
  });
});

describe("root output changes (provisioning §Destroy plan)", () => {
  test("reads each root output's change by name, in the plan's order; none without output_changes", () => {
    expect(
      outputChanges({
        output_changes: {
          host_keys: { actions: ["delete"], before: [], after: null },
          network: { actions: ["no-op"], before: {}, after: {} },
        },
      }),
    ).toEqual([
      { name: "host_keys", actions: ["delete"] },
      { name: "network", actions: ["no-op"] },
    ]);
    expect(outputChanges({ format_version: "1.2" })).toEqual([]);
    expect(outputChanges({ output_changes: {} })).toEqual([]);
  });

  test("a plan or output change it cannot read is unreadable, failing closed", () => {
    for (const plan of [
      undefined,
      [],
      { output_changes: [] },
      { output_changes: "host_keys" },
      { output_changes: null },
      { output_changes: { host_keys: null } },
      { output_changes: { host_keys: {} } },
      { output_changes: { host_keys: { actions: [] } } },
      { output_changes: { host_keys: { actions: "delete" } } },
      { output_changes: { host_keys: { actions: [7] } } },
      { output_changes: { "host\u0007keys": { actions: ["delete"] } } },
    ])
      expect(outputChanges(plan)).toBeUndefined();
  });
});

describe("plan IDs", () => {
  test("are eight random lowercase letters or digits", () => {
    expect(newPlanId((count) => new Uint8Array(count))).toBe("aaaaaaaa");
    expect(isPlanId(newPlanId((count) => new Uint8Array(count).fill(35)))).toBe(true);
  });

  test("anything else is not a plan ID, so it can never name another path", () => {
    for (const value of ["", "ABCDEFGH", "abcdefg", "abcdefghi", "../../x", "abcd/efg", "abcdefg "])
      expect(isPlanId(value)).toBe(false);
  });
});

describe("the CLI/pin match guard", () => {
  test("the pinned release may plan and apply", () => {
    expect(pinRefusal("0.3.0", "0.3.0" as Release)).toBeUndefined();
  });

  test("a missing pin is left to the completeness check", () => {
    expect(pinRefusal(undefined, "0.3.0" as Release)).toBeUndefined();
  });

  test("an earlier pin is refused, naming the running release and `fffactory upgrade` but never echoing the pin", () => {
    const refusal = pinRefusal("0.2.9-SECRETLIKE", "0.3.0" as Release);
    expect(refusal).toBe(
      "factory.json pins another fffactory release than this one, 0.3.0: only the pinned " +
        "release may plan or change this factory. Install the release factory.json pins, or " +
        "move the pin to 0.3.0 with `fffactory upgrade`.",
    );
    expect(refusal).not.toContain("SECRETLIKE");
  });

  test("a later pin is refused without offering to move it back", () => {
    expect(pinRefusal("0.3.1", "0.3.0" as Release)).toBe(
      "factory.json pins another fffactory release than this one, 0.3.0: only the pinned " +
        "release may plan or change this factory. Install the release factory.json pins: " +
        "fffactory never moves a pin back to an earlier release.",
    );
  });
});

describe("the plan's workers and review (plan-apply §Layer mapping)", () => {
  test("a factory review carries every approved stage: workers, their repositories, control plane, dispatch and stopped workers", () => {
    const instance = {
      schema_version: 1 as const,
      hosts: [
        { key: "builder-1" as HostKey, repositories: ["factory", "tools"] },
        { key: "builder-2" as HostKey },
      ],
    };
    const [builder1, builder2] = declaredWorkers(instance, TARGET.factoryId) as [
      PlannedWorker,
      PlannedWorker,
    ];
    const workers = [builder1, builder2];
    const controlPlane = workers.map((worker) => ({
      ...worker,
      observation: "no-release",
      changes: ["listen-address" as const],
    }));
    const dispatch = workers.map((worker) => ({ ...worker, requested: false, schedule: null }));
    const changes = [change(HOST, ["create"])];
    const stopped = ["builder-2" as HostKey];
    expect(
      factoryPlanReview({ target: TARGET, changes, instance, controlPlane, dispatch, stopped }),
    ).toEqual({
      kind: "factory",
      target: TARGET,
      changes,
      workers,
      repositories: [
        { ...builder1, placed: ["factory", "tools"] },
        { ...builder2, placed: [] },
      ],
      controlPlane,
      dispatch,
      stopped,
    });
    const move = { from: "0.2.0" as Release, to: TARGET.release };
    expect(
      factoryPlanReview({
        target: TARGET,
        changes: [],
        instance: { schema_version: 1 },
        controlPlane: [],
        dispatch: [],
        stopped: [],
        pinMove: move,
      }),
    ).toMatchObject({ workers: [], repositories: [], pinMove: move });
  });

  test("the workers a factory.json declares, by their namespaced hostnames", () => {
    const instance = {
      schema_version: 1 as const,
      hosts: [{ key: "builder-1" as HostKey }, { key: "b" as HostKey }],
    };
    expect(
      declaredWorkers(instance, "fff-abcd1234" as FactoryId).map((w) => [w.key, w.hostname]),
    ).toEqual([
      ["builder-1", "fff-abcd1234-builder-1"],
      ["b", "fff-abcd1234-b"],
    ]);
    expect(declaredWorkers({ schema_version: 1 }, "fff-abcd1234" as FactoryId)).toEqual([]);
  });

  test("the workers whose machine the plan creates, whose first boot apply waits for", () => {
    const workers = [
      { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" },
      { key: "builder-2" as HostKey, hostname: "fff-abcd1234-builder-2" },
      { key: "b" as HostKey, hostname: "fff-abcd1234-b" },
    ];
    const changes: ResourceChange[] = [
      { address: "module.network.aws_vpc.this", type: "aws_vpc", actions: ["create"] },
      {
        address: 'module.hosts.aws_instance.host["builder-2"]',
        type: "aws_instance",
        mode: "managed",
        actions: ["create"],
      },
      {
        address: 'module.hosts.aws_instance.host["b"]',
        type: "aws_instance",
        actions: ["update"],
      },
      // Another resource of the same name is not the host's machine.
      { address: 'module.hosts.aws_eip.host["builder-1"]', type: "aws_eip", actions: ["create"] },
    ];
    expect(createdWorkers(changes, workers)).toEqual(["builder-2" as HostKey]);
    expect(createdWorkers([], workers)).toEqual([]);
  });
});

describe("D11 refusals", () => {
  test("destroying or replacing a host machine is refused, naming the missing capability", () => {
    const refusal = hostMachineRefusal([
      change(HOST, ["delete", "create"], "aws_instance"),
      change('module.hosts.aws_instance.host["old"]', ["delete"], "aws_instance"),
      change('module.hosts.aws_instance.host["x"]', ["create", "delete"]),
      change('module.hosts.aws_instance.host["y"]', ["forget"]),
      change('module.hosts.aws_instance.host["new"]', ["create"], "aws_instance"),
      change('module.hosts.aws_instance.host["grown"]', ["update"], "aws_instance"),
      change("module.network.aws_subnet.public", ["delete", "create"], "aws_subnet"),
    ]);
    expect(refusal).toEqual({
      capability: "host replacement",
      reasons: [
        `${HOST} would be replaced`,
        'module.hosts.aws_instance.host["old"] would be destroyed',
        'module.hosts.aws_instance.host["x"] would be replaced',
        'module.hosts.aws_instance.host["y"] would be forgotten by Terraform',
      ],
      instead: "Change factory.json so the plan keeps every host machine, then plan again.",
    });
  });

  test("a worker terminated outside fffactory plans as a create, which is not refused", () => {
    // Refresh drops a terminated instance from state: Terraform reports the deletion as drift
    // and plans the host again as a plain create (worker-bootstrap §Failed first boot).
    const address = 'module.hosts.aws_instance.host["builder-1"]';
    const changes = resourceChanges({
      resource_drift: [
        { address, mode: "managed", type: "aws_instance", change: { actions: ["delete"] } },
      ],
      resource_changes: [
        { address, mode: "managed", type: "aws_instance", change: { actions: ["create"] } },
      ],
    });
    expect(changes).toEqual([
      { address, mode: "managed", type: "aws_instance", actions: ["create"] },
    ]);
    expect(hostMachineRefusal(changes ?? [])).toBeUndefined();
  });

  test("a host machine is a managed aws_instance, whatever its module is called", () => {
    const managed = (address: string, mode: string) => ({
      address,
      type: "aws_instance",
      mode,
      actions: ["delete"],
    });
    expect(hostMachineRefusal([managed("module.data.aws_instance.x", "managed")])?.reasons).toEqual(
      ["module.data.aws_instance.x would be destroyed"],
    );
    expect(hostMachineRefusal([managed("module.m.data.aws_instance.x", "data")])).toBeUndefined();
    expect(
      hostMachineRefusal([change("module.data.aws_instance.x", ["delete"])])?.reasons,
    ).toHaveLength(1);
    // Without a mode the address alone decides, failing closed.
    expect(
      hostMachineRefusal([change("module.m.data.aws_instance.x", ["delete"])])?.reasons,
    ).toHaveLength(1);
    expect(
      hostMachineRefusal([change("module.m.aws_instance.x", ["delete"], "aws_subnet")]),
    ).toBeUndefined();
  });

  test.each([[["frobnicate"]], [["update", "frobnicate"]], [["create", "forget"]]])(
    "any other action on a host machine, %p, is refused, failing closed",
    (actions) => {
      const refusal = hostMachineRefusal([change(HOST, actions, "aws_instance")]);
      expect(refusal?.capability).toBe("host replacement");
      expect(refusal?.reasons).toHaveLength(1);
      expect(hostMachineRefusal([change(HOST, actions)])?.reasons).toHaveLength(1);
    },
  );

  test("an action fffactory does not know is named in the refusal", () => {
    expect(hostMachineRefusal([change(HOST, ["frobnicate"], "aws_instance")])?.reasons).toEqual([
      `${HOST} would be changed by an action fffactory does not know (frobnicate)`,
    ]);
  });

  test("a plan that keeps every host machine is not refused", () => {
    expect(
      hostMachineRefusal([
        change(HOST, ["create"], "aws_instance"),
        change("module.network.aws_subnet.public", ["delete"], "aws_subnet"),
        change("data.aws_instance.lookup", ["read"], "aws_instance"),
        change('module.hosts.aws_instance.host["same"]', ["no-op"], "aws_instance"),
        change('module.hosts.aws_instance.host["grown"]', ["update"], "aws_instance"),
      ]),
    ).toBeUndefined();
  });

  test("removing a provisioned host key by hand is refused, naming the command that removes one", () => {
    const refusal = hostKeyRemovalRefusal([
      { path: "hosts", message: 'host key "builder-1" is provisioned but no longer declared' },
    ]);
    expect(refusal).toEqual({
      capability: "host removal",
      command: "fffactory worker terminate KEY",
      reasons: ['hosts: host key "builder-1" is provisioned but no longer declared'],
      instead:
        "Declare every provisioned host key in factory.json again, then remove a host with " +
        "`fffactory worker terminate KEY`.",
    });
    expect(hostKeyRemovalRefusal([])).toBeUndefined();
  });
});

describe("an instance type change on a stopped worker (plan-apply §Stopped workers)", () => {
  const BUILDER_1 = { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" };
  const STOPPED = [BUILDER_1];
  const update = (address: string, change: Record<string, unknown>) => ({
    address,
    mode: "managed",
    type: "aws_instance",
    change: { actions: ["update"], ...change },
  });
  const resize = (address: string) =>
    update(address, {
      before: { instance_type: "m7i.large", tags: {} },
      after: { instance_type: "m7i.xlarge", tags: {} },
    });

  test("is refused: Terraform starts a stopped instance to change its type", () => {
    const plan = { resource_changes: [resize(HOST)] };
    expect(resizedStoppedWorkers(plan, STOPPED)).toEqual(STOPPED);
    const stopped = { ...BUILDER_1, machine: "stopped" as const };
    expect(resizeRefusal(plan, { inventory: "read", workers: [stopped] })).toEqual({
      inventory: "read",
      workers: [stopped],
    });
  });

  test("an update it cannot read is taken as one, failing closed", () => {
    for (const change of [{}, { before: null, after: {} }, { before: {}, after: 3 }])
      expect(resizedStoppedWorkers({ resource_changes: [update(HOST, change)] }, STOPPED)).toEqual(
        STOPPED,
      );
    const unknown = update(HOST, {
      before: { instance_type: "m7i.large" },
      after: {},
      after_unknown: { instance_type: true },
    });
    expect(resizedStoppedWorkers({ resource_changes: [unknown] }, STOPPED)).toEqual(STOPPED);
  });

  test("a running worker's resize, a stopped worker's other updates and other resources are not", () => {
    const plan = {
      resource_changes: [
        resize('module.hosts.aws_instance.host["builder-2"]'),
        update(HOST, {
          before: { instance_type: "m7i.large", tags: { a: "1" } },
          after: { instance_type: "m7i.large", tags: { a: "2" } },
        }),
        {
          address: "module.network.aws_vpc.this",
          type: "aws_vpc",
          change: { actions: ["update"] },
        },
      ],
    };
    expect(resizedStoppedWorkers(plan, STOPPED)).toEqual([]);
    expect(resizedStoppedWorkers({ resource_changes: [resize(HOST)] }, [])).toEqual([]);
    expect(resizedStoppedWorkers({}, STOPPED)).toEqual([]);
    expect(resizedStoppedWorkers("unreadable", STOPPED)).toEqual([]);
  });

  test("several stopped workers are each named", () => {
    const both: ResizeGuard = {
      inventory: "read",
      workers: [
        { ...BUILDER_1, machine: "stopped" },
        { key: "b" as HostKey, hostname: "fff-abcd1234-b", machine: "stopped" },
      ],
    };
    const plan = {
      resource_changes: [resize(HOST), resize('module.hosts.aws_instance.host["b"]')],
    };
    expect(resizeRefusal(plan, both)).toEqual(both);
  });

  test("a stopping worker is refused as a stopped one: the provider waits for it to stop, then starts it", () => {
    const stopping = { ...BUILDER_1, machine: "stopping" as const };
    const guard: ResizeGuard = {
      inventory: "read",
      workers: [stopping, { key: "b" as HostKey, hostname: "fff-abcd1234-b", machine: "stopped" }],
    };
    const plan = { resource_changes: [resize(HOST)] };
    const refusal = resizeRefusal(plan, guard);
    expect(refusal).toEqual({ inventory: "read", workers: [stopping] });
  });

  test("with the EC2 inventory unreadable, any worker's resize is refused, failing closed", () => {
    const guard: ResizeGuard = {
      inventory: "unreadable",
      workers: [...STOPPED, { key: "b" as HostKey, hostname: "fff-abcd1234-b" }],
    };
    const refusal = resizeRefusal({ resource_changes: [resize(HOST)] }, guard);
    expect(refusal).toEqual({ inventory: "unreadable", workers: STOPPED });
    // Without a resize nothing is refused, whatever the inventory.
    const other = update(HOST, {
      before: { instance_type: "m7i.large", tags: { a: "1" } },
      after: { instance_type: "m7i.large", tags: { a: "2" } },
    });
    expect(resizeRefusal({ resource_changes: [other] }, guard)).toBeUndefined();
    expect(
      resizeRefusal({ resource_changes: [resize(HOST)] }, { inventory: "read", workers: [] }),
    ).toBeUndefined();
  });
});

const SAVED: SavedFactoryPlan = newSavedPlan({
  planId: "k3x9q2ab",
  factoryId: "fff-abcd1234" as FactoryId,
  instancePath: "/work/.fffactory/factory.json",
  configurationSha256: "a".repeat(64),
  release: "0.3.0" as Release,
  assetsSha256: "b".repeat(64),
  accountId: "123456789012",
  stateRevision: "state-v1",
  now: NOW,
  changes: [change(HOST, ["create"])],
  controlPlane: [
    {
      key: "builder-1" as HostKey,
      hostname: "fff-abcd1234-builder-1",
      observation: "no-release",
      changes: ["paseo-package", "listen-address"],
    },
  ],
  stopped: ["builder-1" as HostKey],
});

const CURRENT: PlanCircumstances = {
  factoryId: "fff-abcd1234" as FactoryId,
  instancePath: "/work/.fffactory/factory.json",
  configurationSha256: "a".repeat(64),
  release: "0.3.0" as Release,
  assetsSha256: "b".repeat(64),
  accountId: "123456789012",
  now: new Date(NOW.getTime() + 60_000),
};

describe("saved plans", () => {
  test("record what the plan is bound to, and expire after the plan lifetime", () => {
    expect(SAVED).toEqual({
      schema_version: 1,
      plan_id: "k3x9q2ab",
      factory_id: "fff-abcd1234" as FactoryId,
      instance_path: "/work/.fffactory/factory.json",
      configuration_sha256: "a".repeat(64),
      release: "0.3.0" as Release,
      assets_sha256: "b".repeat(64),
      account_id: "123456789012",
      state_revision: "state-v1",
      created_at: "2026-09-30T12:00:00.000Z",
      expires_at: new Date(NOW.getTime() + PLAN_TTL_MS).toISOString(),
      changes: [{ address: HOST, actions: ["create"] }],
      control_plane: [
        {
          key: "builder-1" as HostKey,
          hostname: "fff-abcd1234-builder-1",
          observation: "no-release",
          changes: ["paseo-package", "listen-address"],
        },
      ],
      dispatch: [],
      stopped_workers: ["builder-1" as HostKey],
    });
    expect(PLAN_TTL_MS).toBe(60 * 60 * 1000);
  });

  test("round-trip through their text, and anything else reads as no plan", () => {
    expect(parseSavedPlan(serializeSavedPlan(SAVED), SAVED.factory_id, SAVED.plan_id)).toEqual(
      SAVED,
    );
    const first = newSavedPlan({
      ...CURRENT,
      planId: "aaaaaaaa",
      stateRevision: undefined,
      now: NOW,
      changes: [],
    });
    expect(first.state_revision).toBeNull();
    expect(parseSavedPlan(serializeSavedPlan(first), first.factory_id, "aaaaaaaa")).toEqual(first);
    const text = serializeSavedPlan(SAVED);
    for (const broken of [
      "not json",
      "[]",
      text.replace('"schema_version": 1', '"schema_version": 2'),
      text.replace('"release": "0.3.0"', '"release": "nope"'),
      text.replace('"created_at": "2026-09-30T12:00:00.000Z"', '"created_at": "yesterday"'),
      text.replace('"account_id": "123456789012"', '"account_id": 1'),
      text.replace('"actions": [\n        "create"\n      ]', '"actions": "create"'),
      text.replace('"actions": [\n        "create"\n      ]', '"actions": []'),
      text.replace('"state_revision": "state-v1"', '"state_revision": 3'),
      text.replace('"hostname": "fff-abcd1234-builder-1"', '"hostname": "other"'),
      text.replace('"observation": "no-release"', '"observation": 3'),
      text.replace('"paseo-package",', '"unknown-change",'),
      text.replace(',\n  "dispatch": []', ""),
      text.replace(
        '"stopped_workers": [\n    "builder-1"',
        '"stopped_workers": [\n    "Builder 1"',
      ),
      text.replace('"stopped_workers": [\n    "builder-1"', '"stopped_workers": [\n    "b", "b"'),
      text.replace('"stopped_workers": [\n    "builder-1"\n  ]', '"stopped_workers": "builder-1"'),
    ])
      expect(parseSavedPlan(broken, SAVED.factory_id, SAVED.plan_id)).toBeUndefined();
    expect(parseSavedPlan(text, "fff-other000" as FactoryId, SAVED.plan_id)).toBeUndefined();
    expect(parseSavedPlan(text, SAVED.factory_id, "zzzzzzzz")).toBeUndefined();
    // A record from before stopped workers were planned skips none.
    const { stopped_workers: _, ...older } = SAVED;
    expect(parseSavedPlan(JSON.stringify(older), SAVED.factory_id, SAVED.plan_id)).toEqual({
      ...SAVED,
      stopped_workers: [],
    });
    const duplicate = JSON.parse(text) as { control_plane: unknown[] };
    duplicate.control_plane.push(duplicate.control_plane[0]);
    expect(
      parseSavedPlan(JSON.stringify(duplicate), SAVED.factory_id, SAVED.plan_id),
    ).toBeUndefined();
  });

  test("round-trips requested and disabled dispatch without accepting incomplete schedules", () => {
    const requested = {
      key: "builder-1" as HostKey,
      hostname: "fff-abcd1234-builder-1",
      requested: true,
      schedule: {
        cron: "*/15 * * * *",
        timezone: "UTC",
        provider: "codex",
        model: "configured-model",
        mode: "workspace-write",
        cwd: "/home/factory",
      },
    };
    const disabled = {
      key: "builder-2" as HostKey,
      hostname: "fff-abcd1234-builder-2",
      requested: false,
      schedule: null,
    };
    const plan: SavedFactoryPlan = { ...SAVED, dispatch: [requested, disabled] };
    expect(parseSavedPlan(serializeSavedPlan(plan), plan.factory_id, plan.plan_id)).toEqual(plan);

    const brokenItems: unknown[] = [
      { ...requested, key: "NOT A KEY" },
      { ...requested, hostname: "another-worker" },
      { ...requested, requested: "yes" },
      { ...disabled, schedule: requested.schedule },
      { ...requested, schedule: null },
      { ...requested, schedule: { ...requested.schedule, model: 42 } },
      { ...requested, schedule: { ...requested.schedule, cwd: "relative/path" } },
      { ...requested, schedule: { ...requested.schedule, cwd: "/home/factory\nelsewhere" } },
    ];
    for (const item of brokenItems) {
      expect(
        parseSavedPlan(
          JSON.stringify({ ...plan, dispatch: [item] }),
          plan.factory_id,
          plan.plan_id,
        ),
      ).toBeUndefined();
    }
    expect(
      parseSavedPlan(
        JSON.stringify({ ...plan, dispatch: [requested, requested] }),
        plan.factory_id,
        plan.plan_id,
      ),
    ).toBeUndefined();
  });

  test("a plan applied in the circumstances it was planned in is fresh", () => {
    expect(planStaleness(SAVED, CURRENT)).toEqual([]);
    expect(stateStaleness(SAVED, "state-v1")).toBeUndefined();
  });

  test("changed configuration, release identity, account or age each make it stale", () => {
    expect(
      planStaleness(SAVED, {
        ...CURRENT,
        instancePath: "/elsewhere/factory.json",
        configurationSha256: "c".repeat(64),
        release: "0.3.1" as Release,
        assetsSha256: "d".repeat(64),
        accountId: "210987654321",
        now: new Date(Date.parse(SAVED.expires_at) + 1),
      }),
    ).toEqual([
      { kind: "expired", expiresAt: SAVED.expires_at },
      { kind: "other_instance", instancePath: "/work/.fffactory/factory.json" },
      { kind: "configuration_changed" },
      { kind: "other_release", release: "0.3.0" as Release },
      { kind: "other_account", accountId: "123456789012" },
    ]);
    expect(planStaleness(SAVED, { ...CURRENT, assetsSha256: "d".repeat(64) })).toEqual([
      { kind: "other_assets" },
    ]);
    expect(planStaleness(SAVED, { ...CURRENT, now: new Date(SAVED.expires_at) })).toEqual([]);
  });

  test("a changed Terraform state makes it stale, and so does state appearing or vanishing", () => {
    const changed: StaleReason = { kind: "state_changed" };
    expect(stateStaleness(SAVED, "state-v2")).toEqual(changed);
    expect(stateStaleness(SAVED, undefined)).toEqual(changed);
    const first = { ...SAVED, state_revision: null };
    expect(stateStaleness(first, undefined)).toBeUndefined();
    expect(stateStaleness(first, "state-v1")).toEqual(changed);
  });

  test("a worker stopped or started since it was planned makes it stale (plan-apply §Stopped workers)", () => {
    // SAVED was planned with builder-1 stopped.
    const b1 = "builder-1" as HostKey;
    const b2 = "builder-2" as HostKey;
    expect(stoppedStaleness(SAVED, [b1])).toEqual([]);
    expect(stoppedStaleness(SAVED, [])).toEqual([{ kind: "worker_started", key: b1 }]);
    expect(stoppedStaleness(SAVED, [b1, b2])).toEqual([{ kind: "worker_stopped", key: b2 }]);
    expect(stoppedStaleness(SAVED, [b2])).toEqual([
      { kind: "worker_started", key: b1 },
      { kind: "worker_stopped", key: b2 },
    ]);
    expect(stoppedStaleness(SAVED, undefined)).toEqual([{ kind: "inventory_unreadable", key: b1 }]);
    const none = { ...SAVED, stopped_workers: [] };
    expect(stoppedStaleness(none, undefined)).toEqual([]);
  });
});

const BUCKET = "module.state_bucket.aws_s3_bucket.state";
const VERSIONING = "module.state_bucket.aws_s3_bucket_versioning.state";

const BOOTSTRAP: SavedBootstrapPlan = newSavedBootstrapPlan({
  planId: "b00tstr4",
  factoryId: "fff-abcd1234" as FactoryId,
  instancePath: "/work/.fffactory/factory.json",
  configurationSha256: "a".repeat(64),
  release: "0.3.0" as Release,
  assetsSha256: "b".repeat(64),
  accountId: "123456789012",
  now: NOW,
  changes: [change(BUCKET, ["create"], "aws_s3_bucket"), change(VERSIONING, ["create"])],
});

describe("the log archive in a saved factory plan (plan-apply §Saved plans)", () => {
  const ARCHIVE = "fff-abcd1234-logs-123456789012-eu-west-2-an";
  const creating = newSavedPlan({
    ...CURRENT,
    planId: "k3x9q2ab",
    stateRevision: "state-v1",
    now: NOW,
    changes: [],
    archive: { bucket: ARCHIVE, creates: true },
  });

  test("records whether it creates the archive, and nothing of it without one", () => {
    expect(creating.creates_archive).toBe(true);
    expect("creates_archive" in SAVED).toBe(false);
    const present = newSavedPlan({
      ...CURRENT,
      planId: "k3x9q2ab",
      stateRevision: "state-v1",
      now: NOW,
      changes: [],
      archive: { bucket: ARCHIVE, creates: false },
    });
    expect(present.creates_archive).toBe(false);
    // The bucket's name is factory.json's, bound by its SHA-256: the record holds none.
    expect(serializeSavedPlan(present)).not.toContain(ARCHIVE);
  });

  test("round-trips through its text; anything but a boolean is unreadable", () => {
    expect(parseSavedPlan(serializeSavedPlan(creating), creating.factory_id, "k3x9q2ab")).toEqual(
      creating,
    );
    const record = JSON.parse(serializeSavedPlan(creating)) as Record<string, unknown>;
    for (const creates of ["yes", 1, null, {}])
      expect(
        parseSavedPlan(
          JSON.stringify({ ...record, creates_archive: creates }),
          creating.factory_id,
          "k3x9q2ab",
        ),
      ).toBeUndefined();
  });

  test("a factory record's unknown fields never reach the plan read from it", () => {
    const record = JSON.parse(serializeSavedPlan(creating)) as Record<string, unknown>;
    const read = parseSavedPlan(
      JSON.stringify({ ...record, archive_bucket: "elsewhere", kind: undefined, extra: [1] }),
      creating.factory_id,
      "k3x9q2ab",
    );
    expect(read).toEqual(creating);
    expect(Object.keys(read ?? {})).not.toContain("archive_bucket");
    expect(Object.keys(read ?? {})).not.toContain("extra");
  });

  test("a bootstrap record recording the archive is unreadable", () => {
    const bootstrap = newSavedBootstrapPlan({
      ...CURRENT,
      planId: "b00tstr4",
      now: NOW,
      changes: [{ address: "module.state_bucket.aws_s3_bucket.state", actions: ["create"] }],
    });
    const record = JSON.parse(serializeSavedPlan(bootstrap)) as Record<string, unknown>;
    expect(
      parseSavedPlan(
        JSON.stringify({ ...record, creates_archive: false }),
        bootstrap.factory_id,
        "b00tstr4",
      ),
    ).toBeUndefined();
  });

  test("is stale once the archive it creates exists, or the one it found is gone", () => {
    expect(archiveStaleness(creating, false)).toBeUndefined();
    expect(archiveStaleness(creating, true)).toEqual({ kind: "archive_created" });
    const present = { ...creating, creates_archive: false };
    expect(archiveStaleness(present, true)).toBeUndefined();
    expect(archiveStaleness(present, false)).toEqual({ kind: "archive_missing" });
    // A plan of a factory without the archive is never stale for it.
    expect(archiveStaleness(SAVED, true)).toBeUndefined();
    expect(archiveStaleness(SAVED, false)).toBeUndefined();
  });

  test("the review shows the archive only when factory.json enables it", () => {
    const input = {
      target: {
        instancePath: "/work/.fffactory/factory.json",
        factoryId: "fff-abcd1234" as FactoryId,
        accountId: "123456789012",
        region: "eu-west-2",
        release: "0.3.0" as Release,
      },
      changes: [],
      instance: { schema_version: 1 as const, factory_id: "fff-abcd1234" as FactoryId, hosts: [] },
      controlPlane: [],
      dispatch: [],
      stopped: [],
    };
    expect("archive" in factoryPlanReview(input)).toBe(false);
    expect(
      factoryPlanReview({ ...input, archive: { bucket: ARCHIVE, creates: true } }).archive,
    ).toEqual({ bucket: ARCHIVE, creates: true });
  });
});

describe("comparing a plan's changes with its record (plan-apply §Freshness)", () => {
  const bucket = { address: "a.bucket", type: "aws_s3_bucket", actions: ["create"] };
  const versioning = { address: "a.versioning", actions: ["create"] };

  test("the same addresses and actions, in order, are the same changes", () => {
    expect(sameChanges([bucket, versioning], [{ ...bucket, type: undefined }, versioning])).toBe(
      true,
    );
    expect(sameChanges([], [])).toBe(true);
  });

  test("another action, another resource, another order or one more is not", () => {
    expect(sameChanges([bucket], [{ ...bucket, actions: ["delete", "create"] }])).toBe(false);
    expect(sameChanges([bucket], [versioning])).toBe(false);
    expect(sameChanges([bucket, versioning], [versioning, bucket])).toBe(false);
    expect(sameChanges([bucket], [bucket, versioning])).toBe(false);
  });
});

describe("saved bootstrap plans (plan-apply §Saved plans)", () => {
  test("record the kind and what they are bound to, and no factory state", () => {
    expect(BOOTSTRAP).toEqual({
      schema_version: 1,
      kind: "bootstrap",
      plan_id: "b00tstr4",
      factory_id: "fff-abcd1234" as FactoryId,
      instance_path: "/work/.fffactory/factory.json",
      configuration_sha256: "a".repeat(64),
      release: "0.3.0" as Release,
      assets_sha256: "b".repeat(64),
      account_id: "123456789012",
      created_at: "2026-09-30T12:00:00.000Z",
      expires_at: new Date(NOW.getTime() + PLAN_TTL_MS).toISOString(),
      changes: [
        { address: BUCKET, type: "aws_s3_bucket", actions: ["create"] },
        { address: VERSIONING, actions: ["create"] },
      ],
    });
    expect(PLAN_SCHEMA_VERSION).toBe(1);
  });

  test("only ever create", () => {
    for (const changes of [
      [],
      [change(BUCKET, ["update"])],
      [change(BUCKET, ["delete", "create"])],
    ])
      expect(() => newSavedBootstrapPlan({ ...CURRENT, planId: "b00tstr4", changes })).toThrow();
  });

  test("round-trip through their text, beside factory records without a kind", () => {
    const text = serializeSavedPlan(BOOTSTRAP);
    expect(text).toContain('"kind": "bootstrap"');
    const read: SavedPlan | undefined = parseSavedPlan(text, BOOTSTRAP.factory_id, "b00tstr4");
    expect(read).toEqual(BOOTSTRAP);
    expect(read?.kind).toBe("bootstrap");
    expect(serializeSavedPlan(SAVED)).not.toContain('"kind"');
    const factory = parseSavedPlan(serializeSavedPlan(SAVED), SAVED.factory_id, SAVED.plan_id);
    expect(factory).toEqual(SAVED);
    expect(factory?.kind).toBeUndefined();
  });

  test("a bootstrap record with a factory plan's fields, or anything not create, is unreadable", () => {
    const record = JSON.parse(serializeSavedPlan(BOOTSTRAP)) as Record<string, unknown>;
    const broken: Record<string, unknown>[] = [
      { ...record, state_revision: null },
      { ...record, state_revision: "state-v1" },
      { ...record, control_plane: [] },
      { ...record, dispatch: [] },
      { ...record, stopped_workers: [] },
      { ...record, kind: "backend" },
      { ...record, kind: null },
      { ...record, changes: [] },
      { ...record, changes: [{ address: BUCKET, actions: ["update"] }] },
      { ...record, changes: [{ address: BUCKET, actions: ["create", "delete"] }] },
      { ...record, changes: [{ address: BUCKET, actions: ["create"] }, { address: BUCKET }] },
      { ...record, release: "nope" },
      { ...record, account_id: 1 },
      { ...record, created_at: "yesterday" },
      { ...record, expires_at: undefined },
      { ...record, schema_version: 2 },
    ];
    for (const document of broken)
      expect(
        parseSavedPlan(JSON.stringify(document), BOOTSTRAP.factory_id, "b00tstr4"),
      ).toBeUndefined();
    const text = serializeSavedPlan(BOOTSTRAP);
    expect(parseSavedPlan(text, "fff-other000" as FactoryId, "b00tstr4")).toBeUndefined();
    expect(parseSavedPlan(text, BOOTSTRAP.factory_id, "zzzzzzzz")).toBeUndefined();
  });

  test("a factory record that names another kind, or lacks its factory fields, is unreadable", () => {
    const record = JSON.parse(serializeSavedPlan(SAVED)) as Record<string, unknown>;
    const { dispatch: _dispatch, ...noDispatch } = record;
    const { state_revision: _revision, ...noRevision } = record;
    for (const document of [{ ...record, kind: "factory" }, noDispatch, noRevision])
      expect(
        parseSavedPlan(JSON.stringify(document), SAVED.factory_id, SAVED.plan_id),
      ).toBeUndefined();
  });

  test("a bootstrap plan applied in the circumstances it was planned in, no bucket yet, is fresh", () => {
    expect(bootstrapStaleness(BOOTSTRAP, CURRENT, false)).toEqual([]);
    expect(
      bootstrapStaleness(BOOTSTRAP, { ...CURRENT, now: new Date(BOOTSTRAP.expires_at) }, false),
    ).toEqual([]);
  });

  test("every factory-plan reason but the state revision makes it stale, and so does the bucket", () => {
    expect(
      bootstrapStaleness(
        BOOTSTRAP,
        {
          ...CURRENT,
          instancePath: "/elsewhere/factory.json",
          configurationSha256: "c".repeat(64),
          release: "0.3.1" as Release,
          assetsSha256: "d".repeat(64),
          accountId: "210987654321",
          now: new Date(Date.parse(BOOTSTRAP.expires_at) + 1),
        },
        true,
      ),
    ).toEqual([
      { kind: "expired", expiresAt: BOOTSTRAP.expires_at },
      { kind: "other_instance", instancePath: "/work/.fffactory/factory.json" },
      { kind: "configuration_changed" },
      { kind: "other_release", release: "0.3.0" as Release },
      { kind: "other_account", accountId: "123456789012" },
      { kind: "state_bucket_created" },
    ]);
    expect(
      bootstrapStaleness(BOOTSTRAP, { ...CURRENT, assetsSha256: "d".repeat(64) }, false),
    ).toEqual([{ kind: "other_assets" }]);
    expect(bootstrapStaleness(BOOTSTRAP, CURRENT, true)).toEqual([
      { kind: "state_bucket_created" },
    ]);
  });
});
