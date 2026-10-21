import { describe, expect, test } from "bun:test";
import { isGeneratedFactoryId } from "../../src/domain/initialization";
import type { FactoryId, HostKey, SecretReference } from "../../src/domain/instance";
import { classifySecrets, type ListedSecret } from "../../src/domain/secrets";
import type { Machine } from "../../src/domain/status";
import type { TailnetDevice } from "../../src/domain/tailnet";
import {
  bucketRemains,
  CHECK_LISTED_DEVICES,
  destroyPlanMismatch,
  destroyPlanRefusal,
  destroyProjectionRefusal,
  dispatchLeftStopped,
  FACTORY_JSON_KEPT,
  leftoversUnverified,
  machinesChanged,
  REVOKE_SOURCES,
  keptSecrets,
  selectFactoryDevices,
  shownDevices,
  shownMachines,
  TEARDOWN_UNCONFIRMABLE,
  teardownConfirmation,
  teardownConfirmMismatch,
  teardownGateActions,
  teardownQuestion,
  typedIdConfirms,
} from "../../src/domain/teardown";
import { removalGate } from "../../src/domain/worker-lifecycle";

const HOST_1 = 'module.hosts.aws_instance.host["builder-1"]';
const HOST_2 = 'module.hosts.aws_instance.host["builder-2"]';
const VPC = "module.network.aws_vpc.this";
const INSTANCE_1 = "i-0123456789abcdef0";
const INSTANCE_2 = "i-0fedcba9876543210";

/** A change as `terraform show -json` gives it. */
function change(
  address: string,
  actions: readonly string[],
  extra: Record<string, unknown> = {},
  type = address.includes("aws_instance") ? "aws_instance" : "aws_vpc",
  mode = "managed",
) {
  return { address, mode, type, change: { actions, ...extra } };
}

const plan = (...changes: unknown[]) => ({ format_version: "1.2", resource_changes: changes });

/** An instance destroyed, as `terraform show -json` gives it: the instance in `before`. */
const destroying = (address: string, id: unknown) =>
  change(address, ["delete"], { before: { id, instance_type: "t3.large" }, after: null });

const machine = (
  instanceId: string,
  hostKey: string | undefined,
  state: Machine["state"] = "running",
): Machine => ({ instanceId, state, hostKey });

/** What EC2 lists for the factory: both hosts' instances. */
const LISTED = [machine(INSTANCE_1, "builder-1"), machine(INSTANCE_2, "builder-2", "stopped")];

/** Every resource of a two-host factory destroyed. */
const WHOLE = plan(
  destroying(HOST_1, INSTANCE_1),
  destroying(HOST_2, INSTANCE_2),
  change(VPC, ["delete"], { before: { id: "vpc-0123456789abcdef0" }, after: null }),
  change("module.host_identity.aws_iam_role.host", ["delete"], {}, "aws_iam_role"),
);

const RERUN =
  "Check the factory's Terraform state with `fffactory plan`, then rerun `fffactory teardown`.";
const EC2_CHECK =
  "Check the factory's instances in the EC2 console, then rerun `fffactory teardown`.";

describe("the guarded destroy plan (provisioning §Destroy plan)", () => {
  test("passes a plan that only destroys, each instance one EC2 lists for its host", () => {
    expect(destroyPlanRefusal(WHOLE, LISTED)).toBeUndefined();
  });

  test("passes reads and no-ops beside the deletes", () => {
    expect(
      destroyPlanRefusal(
        plan(
          destroying(HOST_1, INSTANCE_1),
          change(VPC, ["no-op"]),
          change("data.aws_ssm_parameter.ami", ["read"], {}, "aws_ssm_parameter", "data"),
        ),
        LISTED,
      ),
    ).toBeUndefined();
  });

  test("passes a plan with no changes: an empty state, the factory already absent", () => {
    expect(destroyPlanRefusal({ format_version: "1.2" }, [])).toBeUndefined();
    expect(destroyPlanRefusal(plan(), [])).toBeUndefined();
  });

  test("refuses a plan it cannot read", () => {
    const unreadable = {
      summary: "Terraform's destroy plan could not be read",
      details: [],
      nextAction: "Rerun `fffactory teardown`.",
    };
    for (const shown of [
      undefined,
      "plan",
      [],
      { resource_changes: "none" },
      plan({ address: VPC }),
      plan(change(VPC, [])),
      plan(change("module.network.aws_vpc.\u0007", ["delete"])),
    ])
      expect(destroyPlanRefusal(shown, LISTED)).toEqual(unreadable);
  });

  test("refuses any change but a delete, listing each as ADDRESS (ACTIONS)", () => {
    const offending = [
      [change(VPC, ["update"]), `${VPC} (update)`],
      [change(VPC, ["create"]), `${VPC} (create)`],
      [change(VPC, ["delete", "create"]), `${VPC} (delete, create)`],
      [change(VPC, ["create", "delete"]), `${VPC} (create, delete)`],
      [change(VPC, ["forget"]), `${VPC} (forget)`],
      [change(VPC, ["mystery"]), `${VPC} (mystery)`],
      [change(VPC, ["read", "delete"]), `${VPC} (read, delete)`],
      [change(HOST_1, ["delete", "create"]), `${HOST_1} (delete, create)`],
    ] as const;
    for (const [other, line] of offending)
      expect(destroyPlanRefusal(plan(destroying(HOST_2, INSTANCE_2), other), LISTED)).toEqual({
        summary: "Terraform's destroy plan does more than destroy the factory's resources",
        details: [line],
        nextAction: RERUN,
      });
  });

  test("lists every offending change, in the plan's order", () => {
    const refusal = destroyPlanRefusal(
      plan(
        change(VPC, ["update"]),
        destroying(HOST_1, INSTANCE_1),
        change("module.network.aws_subnet.public", ["create"], {}, "aws_subnet"),
      ),
      LISTED,
    );
    expect(refusal?.details).toEqual([
      `${VPC} (update)`,
      "module.network.aws_subnet.public (create)",
    ]);
  });

  test("refuses deleting an instance EC2 does not list for the factory", () => {
    expect(destroyPlanRefusal(plan(destroying(HOST_1, "i-0aaaaaaaaaaaaaaaa")), LISTED)).toEqual({
      summary: "Terraform's destroy plan destroys an instance EC2 does not list for the factory",
      details: [
        `${HOST_1} (delete): instance i-0aaaaaaaaaaaaaaaa, which EC2 does not list with the factory's tags`,
      ],
      nextAction: EC2_CHECK,
    });
    // An empty or unreadable inventory lists nothing: every instance delete is refused.
    expect(destroyPlanRefusal(WHOLE, [])?.details).toEqual([
      `${HOST_1} (delete): instance ${INSTANCE_1}, which EC2 does not list with the factory's tags`,
      `${HOST_2} (delete): instance ${INSTANCE_2}, which EC2 does not list with the factory's tags`,
    ]);
  });

  test("refuses deleting a listed instance at another host's address, or one without a host key", () => {
    expect(destroyPlanRefusal(plan(destroying(HOST_1, INSTANCE_2)), LISTED)?.details).toEqual([
      `${HOST_1} (delete): instance ${INSTANCE_2}, which EC2 lists for host builder-2`,
    ]);
    // A tag that is not a well-formed host key is never echoed.
    for (const hostKey of [undefined, "", "Builder 1 sk-secret"])
      expect(
        destroyPlanRefusal(plan(destroying(HOST_1, INSTANCE_1)), [machine(INSTANCE_1, hostKey)])
          ?.details,
      ).toEqual([
        `${HOST_1} (delete): instance ${INSTANCE_1}, which EC2 lists without a well-formed host key tag`,
      ]);
  });

  test("refuses an instance delete that does not name the instance it destroys", () => {
    for (const id of [undefined, "", 42])
      expect(destroyPlanRefusal(plan(destroying(HOST_1, id)), LISTED)?.details).toEqual([
        `${HOST_1} (delete): the plan does not name the instance it destroys`,
      ]);
    expect(
      destroyPlanRefusal(plan(change(HOST_1, ["delete"], { before: null })), LISTED)?.details,
    ).toEqual([`${HOST_1} (delete): the plan does not name the instance it destroys`]);
  });

  test("judges an instance by type and mode, or by address when the plan names neither", () => {
    const unnamed = { address: HOST_1, change: { actions: ["delete"], before: { id: "i-0bad" } } };
    expect(destroyPlanRefusal(plan(unnamed), LISTED)?.summary).toBe(
      "Terraform's destroy plan destroys an instance EC2 does not list for the factory",
    );
    // A data source is never a machine, whatever its type.
    expect(
      destroyPlanRefusal(
        plan(change("data.aws_instance.peer", ["delete"], {}, "aws_instance", "data")),
        LISTED,
      ),
    ).toBeUndefined();
  });

  test("refuses the other changes before an instance EC2 does not list", () => {
    expect(
      destroyPlanRefusal(
        plan(change(VPC, ["update"]), destroying(HOST_1, "i-0aaaaaaaaaaaaaaaa")),
        LISTED,
      )?.summary,
    ).toBe("Terraform's destroy plan does more than destroy the factory's resources");
  });
});

const ID = "fff-abcd1234" as FactoryId;
const TAG = "tag:factory";

const device = (id: string, hostName: string, tags: readonly string[] = [TAG]): TailnetDevice => ({
  id,
  hostName,
  dnsName: `${hostName.toLowerCase()}.example-tailnet.ts.net`,
  tags,
});

const ids = (devices: readonly TailnetDevice[]) => devices.map(({ id }) => id);

describe("the devices teardown deletes (teardown §Devices)", () => {
  test("deletes the tagged devices of every known key, exactly and ignoring case", () => {
    const selection = selectFactoryDevices(
      [
        device("n1", `${ID}-builder-1`),
        device("n2", `FFF-ABCD1234-Builder-2`),
        device("n3", `${ID}-old-1`),
        device("n4", `${ID}-builder-1`),
      ],
      ID,
      ["builder-1", "builder-2", "old-1", "builder-1"],
      TAG,
    );
    expect(ids(selection.deleted)).toEqual(["n1", "n4", "n2", "n3"]);
    expect(selection.possible).toEqual([]);
    expect(selection.untagged).toEqual([]);
  });

  test("never deletes an untagged look-alike, of a known key or not: it is listed", () => {
    const selection = selectFactoryDevices(
      [
        device("n1", `${ID}-builder-1`, []),
        device("n2", `${ID}-stray`, ["tag:other"]),
        device("n3", `${ID}-builder-1`),
      ],
      ID,
      ["builder-1"],
      TAG,
    );
    expect(ids(selection.deleted)).toEqual(["n3"]);
    expect(ids(selection.untagged)).toEqual(["n1", "n2"]);
  });

  test("deletes every other tagged device in a generated ID's namespace", () => {
    const selection = selectFactoryDevices(
      [
        device("n1", `${ID}-stray`),
        device("n2", `${ID}-builder-9`),
        device("n3", "fff-abcd12345-builder-1"),
        device("n4", "other-builder-1"),
        device(`n5`, ID),
        device("n6", `${ID}-`),
      ],
      ID,
      [],
      TAG,
    );
    expect(ids(selection.deleted)).toEqual(["n1", "n2"]);
    expect(selection.possible).toEqual([]);
    expect(selection.untagged).toEqual([]);
  });

  test("only lists the other tagged devices of a hand-chosen ID: acme-lab's are not acme's", () => {
    const acme = "acme" as FactoryId;
    const selection = selectFactoryDevices(
      [
        device("n1", "acme-builder-1"),
        device("n2", "ACME-Builder-1"),
        device("n3", "acme-lab-builder-1"),
        device("n4", "acme-lab-builder-1", []),
        device("n5", "acmelab-builder-1"),
      ],
      acme,
      ["builder-1"],
      TAG,
    );
    expect(ids(selection.deleted)).toEqual(["n1", "n2"]);
    expect(ids(selection.possible)).toEqual(["n3"]);
    expect(ids(selection.untagged)).toEqual(["n4"]);
  });

  test("once reviewed, deletes another tagged device of a generated ID only if it was shown deleted", () => {
    const devices = [
      device("n1", `${ID}-builder-1`),
      device("n2", `${ID}-stray`),
      device("n3", `${ID}-late`),
    ];
    // n1 matches a known key exactly: deleted whether shown or not. n3 appeared after the review.
    const selection = selectFactoryDevices(devices, ID, ["builder-1"], TAG, ["n2"]);
    expect(ids(selection.deleted)).toEqual(["n1", "n2"]);
    expect(ids(selection.possible)).toEqual(["n3"]);
    expect(selection.untagged).toEqual([]);
  });

  test("ignores a key that is not a well-formed host key", () => {
    const selection = selectFactoryDevices(
      [device("n1", "acme-Bad Key")],
      "acme" as FactoryId,
      ["Bad Key"],
      TAG,
    );
    expect(selection.deleted).toEqual([]);
    expect(ids(selection.possible)).toEqual(["n1"]);
  });

  test("a generated ID is fff- and eight lowercase letters or digits, nothing else", () => {
    expect(isGeneratedFactoryId(ID)).toBe(true);
    for (const other of [
      "acme",
      "fff-abcd123",
      "fff-abcd12345",
      "fff-abcd1234-lab",
      "fff-ABCD1234",
    ])
      expect(isGeneratedFactoryId(other as FactoryId)).toBe(false);
  });
});

describe("what the review and report carry (teardown §What it never prints)", () => {
  test("a machine carries its host key only when well-formed, a malformed one only marked", () => {
    const machines: Machine[] = [
      { instanceId: INSTANCE_1, state: "running", hostKey: "builder-1" },
      { instanceId: INSTANCE_2, state: "stopped", hostKey: "tskey-pasted Secret" },
      { instanceId: "i-0stray", state: "running", hostKey: undefined },
    ];
    const shown = shownMachines(machines);
    expect(shown).toEqual([
      {
        instanceId: INSTANCE_1,
        state: "running",
        hostKey: "builder-1" as HostKey,
        malformedHostKey: false,
      },
      { instanceId: INSTANCE_2, state: "stopped", hostKey: undefined, malformedHostKey: true },
      { instanceId: "i-0stray", state: "running", hostKey: undefined, malformedHostKey: false },
    ]);
    expect(JSON.stringify(shown)).not.toContain("tskey");
  });

  test("a device carries its ID and a hostname it derived, never its tags", () => {
    const shown = shownDevices(ID, {
      deleted: [device("n1", "FFF-ABCD1234-Builder-1", ["tag:pasted-secret"])],
      possible: [],
      untagged: [device("n2", `${ID}-Not A Key!`, ["tag:pasted-secret"])],
    });
    expect(shown).toEqual({
      deleted: [{ id: "n1", hostname: `${ID}-builder-1` }],
      possible: [],
      untagged: [{ id: "n2", hostname: undefined }],
    });
    expect(JSON.stringify(shown)).not.toContain("pasted");
    expect(JSON.stringify(shown)).not.toContain("Not A Key");
  });
});

describe("changed live state invalidates the review (teardown §Gates)", () => {
  const reviewed: Machine[] = [
    { instanceId: INSTANCE_1, state: "running", hostKey: "builder-1" },
    { instanceId: INSTANCE_2, state: "stopped", hostKey: "builder-2" },
  ];

  test("passes the machines as reviewed, in any order", () => {
    expect(machinesChanged(ID, reviewed, [...reviewed].reverse())).toBeUndefined();
    expect(machinesChanged(ID, [], [])).toBeUndefined();
  });

  test("lists each machine started, stopped, gone, retagged or new, never a malformed tag", () => {
    const refusal = machinesChanged(ID, reviewed, [
      { instanceId: INSTANCE_2, state: "running", hostKey: "builder-2" },
      { instanceId: "i-0new", state: "pending", hostKey: "tskey-pasted Secret" },
      { instanceId: "i-0other", state: "running", hostKey: "builder-3" },
    ]);
    expect(refusal).toEqual({
      summary: "The factory's EC2 instances changed after they were reviewed",
      details: [
        `EC2 instance ${INSTANCE_1} of ${ID}-builder-1: no longer listed`,
        `EC2 instance ${INSTANCE_2} of ${ID}-builder-2: running, reviewed stopped`,
        "EC2 instance i-0new (pending): not reviewed",
        `EC2 instance i-0other of ${ID}-builder-3 (running): not reviewed`,
      ],
      nextAction: "Rerun `fffactory teardown` to review the factory as it is now.",
    });
    expect(
      machinesChanged(ID, reviewed, [
        { ...reviewed[0], hostKey: "builder-9" } as Machine,
        reviewed[1] as Machine,
      ])?.details,
    ).toEqual([`EC2 instance ${INSTANCE_1} of ${ID}-builder-1: its host key tag changed`]);
  });
});

describe("the confirmation (teardown §Confirmation)", () => {
  test("--confirm confirms only with the factory ID exactly; otherwise a terminal asks", () => {
    expect(teardownConfirmation(ID, false, ID)).toBe("confirmed");
    expect(teardownConfirmation(ID, true, ID)).toBe("confirmed");
    for (const wrong of ["fff-other123", ` ${ID}`, "FFF-ABCD1234", "", "y"])
      expect(teardownConfirmation(wrong, true, ID)).toBe("mismatch");
    expect(teardownConfirmation(undefined, true, ID)).toBe("ask");
    expect(teardownConfirmation(undefined, false, ID)).toBe("unavailable");
  });

  test("only the typed factory ID, blank space around it aside, confirms", () => {
    expect(typedIdConfirms(` ${ID}\n`, ID)).toBe(true);
    for (const answer of [undefined, "", "y", "yes", "FFF-ABCD1234", "fff-abcd1234x"])
      expect(typedIdConfirms(answer, ID)).toBe(false);
  });

  test("names the factory, never what --confirm was given", () => {
    expect(teardownConfirmMismatch(ID)).toEqual({
      summary: `--confirm does not name the factory ${ID}`,
      details: [],
      nextAction: `Pass --confirm ${ID} to remove it, or type the factory ID when asked at a terminal.`,
    });
    expect(TEARDOWN_UNCONFIRMABLE).toBe(
      "Removing a factory needs your confirmation: rerun at a terminal, or pass --confirm FACTORY_ID.",
    );
    expect(teardownQuestion(ID)).toBe(
      `Remove factory ${ID} and everything it owns? Its workers, network, IAM, Terraform ` +
        "state, tailnet devices, owned secrets and state bucket are deleted, and none can be " +
        "recovered. Type the factory ID to confirm: ",
    );
  });
});

describe("the gates teardown judges each running worker by (teardown §Gates)", () => {
  const worker = { key: "builder-1" as HostKey, hostname: `${ID}-builder-1` };
  const active = { kind: "activity", activity: { kind: "active", count: 2 } } as const;

  test("refuses as terminate does, its next actions rerunning teardown or terminating first", () => {
    expect(removalGate(active, worker, teardownGateActions(worker))).toEqual({
      summary: `2 agents are active on ${worker.hostname}: terminating it would end them`,
      details: [],
      nextAction:
        "Wait until no agent is active there, then rerun `fffactory teardown`. To remove the " +
        "worker anyway, run `fffactory worker terminate builder-1 --force` first.",
    });
    const unlocated = {
      kind: "unlocated",
      verdict: {
        status: "not_ready",
        summary: "Offline in the tailnet",
        details: [],
        nextAction: null,
      },
    } as const;
    expect(removalGate(unlocated, worker, teardownGateActions(worker))?.nextAction).toBe(
      "Check the worker with `fffactory status`, then rerun `fffactory teardown`. If it cannot " +
        "be inspected, remove it uninspected: run `fffactory worker terminate builder-1 --force`, " +
        "then rerun `fffactory teardown`.",
    );
  });

  test("a worker factory.json does not declare is removed in the EC2 console instead", () => {
    const actions = teardownGateActions(worker, "i-0123456789abcdef0");
    expect(removalGate(active, worker, actions)?.nextAction).toBe(
      "Wait until no agent is active there, then rerun `fffactory teardown`. To remove the " +
        "worker anyway, terminate EC2 instance i-0123456789abcdef0 in the EC2 console first.",
    );
    expect(actions.forced).toBe(
      "terminate EC2 instance i-0123456789abcdef0 in the EC2 console, and rerun `fffactory teardown`.",
    );
    expect(teardownGateActions(worker).forced).toBe(
      "terminate it with --force: `fffactory worker terminate builder-1 --force`, and rerun " +
        "`fffactory teardown`.",
    );
  });
});

const ARN = (name: string) =>
  `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${name}-AbCdEf` as SecretReference;
const listed = (name: string, tags: Record<string, string>): ListedSecret => ({
  name,
  arn: ARN(name),
  tags,
  pendingDeletion: false,
});
const BOTH = { "fffactory:factory-id": ID, "fffactory:managed-by": "fffactory" };

describe("the secrets teardown keeps (teardown §Report)", () => {
  test("keeps referenced sources and tagged secrets apart from references it did not find", () => {
    const secrets = [
      listed(`${ID}/tailscale-auth-key`, BOTH),
      listed(`${ID}/github-token`, { "fffactory:factory-id": ID }),
    ];
    const references = [
      `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${ID}/tailscale-auth-key` as SecretReference,
      ARN("fffv/anthropic-api-key"),
      ARN(`${ID}/github-token`),
      ARN(`${ID}/tailscale-admin-client`),
    ];
    const inventory = classifySecrets(ID, secrets, references);
    expect(keptSecrets(ID, inventory)).toEqual({
      // By name and ARN only: never its tags.
      tagged: [{ name: `${ID}/github-token`, arn: ARN(`${ID}/github-token`) }],
      referenced: [ARN("fffv/anthropic-api-key")],
      unlisted: [ARN(`${ID}/tailscale-admin-client`)],
    });
  });

  test("a reference under acme-lab/ is not under acme/", () => {
    const inventory = classifySecrets("acme" as FactoryId, [], [ARN("acme-lab/github-token")]);
    expect(keptSecrets("acme" as FactoryId, inventory)).toEqual({
      tagged: [],
      referenced: [ARN("acme-lab/github-token")],
      unlisted: [],
    });
  });
});

describe("the destroy plan's own consistency (teardown §Refusals)", () => {
  const deleting = [{ address: VPC, actions: ["delete"] }];
  const nothing = [{ address: VPC, actions: ["no-op"] }];

  test("passes when Terraform's exit code and the JSON plan agree", () => {
    expect(destroyPlanMismatch(true, deleting)).toBeUndefined();
    expect(destroyPlanMismatch(false, nothing)).toBeUndefined();
    expect(destroyPlanMismatch(false, [])).toBeUndefined();
  });

  test("refuses changes reported without a resource change, and the reverse", () => {
    expect(destroyPlanMismatch(true, nothing)).toEqual({
      summary: "Terraform's destroy plan reports changes, but its JSON plan changes no resource",
      details: [],
      nextAction: RERUN,
    });
    expect(destroyPlanMismatch(false, deleting)?.summary).toBe(
      "Terraform's destroy plan reports no change, but its JSON plan changes resources",
    );
  });
});

describe("teardown's words (teardown §Refusals, §Report)", () => {
  test("names where dispatch was left stopped, and apply restarting it", () => {
    expect(dispatchLeftStopped([`${ID}-builder-1`, `${ID}-builder-2`])).toBe(
      `Dispatch is stopped on ${ID}-builder-1, ${ID}-builder-2: \`fffactory apply\` restarts it.`,
    );
  });

  test("lists each issue that keeps factory.json from the destroy plan's inputs", () => {
    expect(destroyProjectionRefusal([{ path: "hosts[0].key", message: "is required" }])).toEqual({
      summary: "factory.json cannot be projected into the destroy plan's Terraform inputs",
      details: ["hosts[0].key: is required"],
      nextAction: "Fix factory.json, then rerun `fffactory teardown`.",
    });
  });

  test("a listing after the destroy that fails proves nothing gone", () => {
    expect(leftoversUnverified("instances", "EC2 DescribeInstances failed: Throttling")).toEqual({
      summary: "EC2 DescribeInstances failed: Throttling",
      details: [
        "Terraform destroyed the factory's resources, but nothing proves that none tagged with its ID remains: its tailnet devices, secrets and state bucket were kept.",
      ],
      nextAction:
        "Check your network connection and that the credentials may call ec2:DescribeInstances, then rerun `fffactory teardown`.",
    });
  });

  test("says what became of the lock when the bucket remains", () => {
    const remains = (lock: "held" | "unknown" | "deleted") =>
      bucketRemains("fff-abcd1234-state", {
        kind: "remains",
        versions: 3,
        codes: ["AccessDenied"],
        failure: undefined,
        lock,
      }).details;
    expect(remains("held")).toEqual([
      "S3 did not delete some versions: AccessDenied",
      "3 object versions and delete markers remain in it.",
      "The factory lock was not deleted: teardown released it.",
    ]);
    expect(remains("deleted").at(-1)).toBe(
      "The factory lock was deleted with the bucket's versions: the factory is unlocked.",
    );
  });

  test("leaves factory.json and every source it only refers to to the operator", () => {
    expect(FACTORY_JSON_KEPT).toContain("factory.json is left as it is");
    expect(REVOKE_SOURCES).toContain("revokes nothing it only refers to");
    expect(CHECK_LISTED_DEVICES).toContain("https://login.tailscale.com/admin/machines");
  });
});
