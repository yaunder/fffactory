import { describe, expect, test } from "bun:test";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import {
  createdWorkers,
  declaredWorkers,
  describeD11Refusal,
  describeInfrastructure,
  describePlan,
  describeRepositories,
  describeWorkers,
  describeTarget,
  hostKeyRemovalRefusal,
  hostMachineRefusal,
  isPlanId,
  newPlanId,
  newSavedPlan,
  PLAN_TTL_MS,
  type PlanCircumstances,
  type ResourceChange,
  parseSavedPlan,
  pinRefusal,
  planStaleness,
  resourceChanges,
  type SavedPlan,
  serializeSavedPlan,
  staleRefusal,
  stateStaleness,
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

describe("the plan's presentation", () => {
  test("the target shows the configuration path, factory, account, Region and release", () => {
    expect(describeTarget(TARGET)).toEqual([
      "  Configuration: /work/.fffactory/factory.json",
      "  Factory: Test factory (fff-abcd1234)",
      "  AWS account: 123456789012, Region: eu-west-2",
      "  Release: 0.3.0",
    ]);
    const { name: _, ...unnamed } = TARGET;
    expect(describeTarget(unnamed)[1]).toBe("  Factory: fff-abcd1234");
  });

  test("each change is shown with its action, and reads and no-ops are left out", () => {
    expect(
      describeInfrastructure([
        change(HOST, ["create"]),
        change("module.network.aws_vpc.this", ["update"]),
        change("module.network.aws_subnet.public", ["delete", "create"]),
        change("module.network.aws_route_table.public", ["create", "delete"]),
        change("module.host_identity.aws_iam_role_policy.read_secrets", ["delete"]),
        change("module.x.aws_thing.gone", ["forget"]),
        change("data.aws_ssm_parameter.al2023", ["read"]),
        change("module.network.aws_internet_gateway.this", ["no-op"]),
      ]),
    ).toEqual([
      "Infrastructure changes:",
      `  + ${HOST}`,
      "  ~ module.network.aws_vpc.this",
      "  -/+ module.network.aws_subnet.public",
      "  +/- module.network.aws_route_table.public",
      "  - module.host_identity.aws_iam_role_policy.read_secrets",
      "  module.x.aws_thing.gone (forget)",
      "  3 to add, 1 to change, 3 to destroy.",
    ]);
  });

  test("a plan that changes nothing says so", () => {
    expect(describeInfrastructure([change("data.aws_ssm_parameter.al2023", ["read"])])).toEqual([
      "Infrastructure: no changes.",
    ]);
  });

  test("the whole plan is its title, target and infrastructure changes", () => {
    expect(describePlan(TARGET, [change(HOST, ["create"])])).toEqual([
      "Factory plan:",
      ...describeTarget(TARGET),
      "Infrastructure changes:",
      `  + ${HOST}`,
      "  1 to add, 0 to change, 0 to destroy.",
    ]);
  });

  test("then each worker's install of the release, in the order they are updated", () => {
    const workers = [
      { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" },
      { key: "builder-2" as HostKey, hostname: "fff-abcd1234-builder-2" },
    ];
    expect(describePlan(TARGET, [], workers)).toEqual([
      "Factory plan:",
      ...describeTarget(TARGET),
      "Infrastructure: no changes.",
      "Worker changes, one worker at a time:",
      "  ~ builder-1 (fff-abcd1234-builder-1): install release 0.3.0 and its host configuration, then verify it",
      "  ~ builder-2 (fff-abcd1234-builder-2): install release 0.3.0 and its host configuration, then verify it",
    ]);
    expect(describeWorkers([], "0.3.0" as Release)).toEqual([]);
    expect(
      describeRepositories(workers, {
        schema_version: 1,
        hosts: [
          { key: "builder-1" as HostKey, repositories: ["factory"] },
          { key: "builder-2" as HostKey, repositories: [] },
        ],
      }),
    ).toEqual([
      "Repository changes, one worker at a time:",
      "  ~ builder-1 (fff-abcd1234-builder-1): reconcile 1 placed repository as factory; preserve and report unmanaged checkouts",
      "  ~ builder-2 (fff-abcd1234-builder-2): reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
    ]);
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
      capability: "host retirement and replacement",
      reasons: [
        `${HOST} would be replaced`,
        'module.hosts.aws_instance.host["old"] would be destroyed',
        'module.hosts.aws_instance.host["x"] would be replaced',
        'module.hosts.aws_instance.host["y"] would be forgotten by Terraform',
      ],
      instead: "Change factory.json so the plan keeps every host machine, then plan again.",
    });
    expect(describeD11Refusal(refusal as NonNullable<typeof refusal>)).toEqual([
      "Refusing: this change needs host retirement and replacement, which fffactory does not " +
        "have yet (D11; it arrives in milestone M3):",
      `  ${HOST} would be replaced`,
      '  module.hosts.aws_instance.host["old"] would be destroyed',
      '  module.hosts.aws_instance.host["x"] would be replaced',
      '  module.hosts.aws_instance.host["y"] would be forgotten by Terraform',
      "Nothing was applied. Change factory.json so the plan keeps every host machine, then plan again.",
    ]);
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
      expect(refusal?.capability).toBe("host retirement and replacement");
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

  test("removing a provisioned host key is refused, naming the missing capability", () => {
    const refusal = hostKeyRemovalRefusal([
      { path: "hosts", message: 'host key "builder-1" is provisioned but no longer declared' },
    ]);
    expect(refusal).toEqual({
      capability: "host retirement",
      reasons: ['hosts: host key "builder-1" is provisioned but no longer declared'],
      instead: "Declare every provisioned host key in factory.json again, then plan again.",
    });
    expect(hostKeyRemovalRefusal([])).toBeUndefined();
  });
});

const SAVED: SavedPlan = newSavedPlan({
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
    ])
      expect(parseSavedPlan(broken, SAVED.factory_id, SAVED.plan_id)).toBeUndefined();
    expect(parseSavedPlan(text, "fff-other000" as FactoryId, SAVED.plan_id)).toBeUndefined();
    expect(parseSavedPlan(text, SAVED.factory_id, "zzzzzzzz")).toBeUndefined();
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
    const plan: SavedPlan = { ...SAVED, dispatch: [requested, disabled] };
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
      `it expired at ${SAVED.expires_at}`,
      "it was planned for another factory.json, /work/.fffactory/factory.json",
      "factory.json changed after it was planned",
      "it was planned by fffactory 0.3.0, not this release",
      "it was planned in AWS account 123456789012, not this one",
    ]);
    expect(planStaleness(SAVED, { ...CURRENT, assetsSha256: "d".repeat(64) })).toEqual([
      "it was planned with other release assets than this fffactory's",
    ]);
    expect(planStaleness(SAVED, { ...CURRENT, now: new Date(SAVED.expires_at) })).toEqual([]);
  });

  test("a changed Terraform state makes it stale, and so does state appearing or vanishing", () => {
    const changed = "the factory's Terraform state changed after it was planned";
    expect(stateStaleness(SAVED, "state-v2")).toBe(changed);
    expect(stateStaleness(SAVED, undefined)).toBe(changed);
    const first = { ...SAVED, state_revision: null };
    expect(stateStaleness(first, undefined)).toBeUndefined();
    expect(stateStaleness(first, "state-v1")).toBe(changed);
  });

  test("a stale plan is refused with every reason and the way forward", () => {
    expect(staleRefusal("k3x9q2ab", ["factory.json changed after it was planned"])).toEqual([
      "Refusing to apply plan k3x9q2ab: it is no longer the plan to apply:",
      "  factory.json changed after it was planned",
      "Nothing was applied. Review a new plan with `fffactory plan`.",
    ]);
  });
});
