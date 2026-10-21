import { describe, expect, test } from "bun:test";
import { isGeneratedFactoryId } from "../../src/domain/initialization";
import type { FactoryId, HostKey, SecretReference } from "../../src/domain/instance";
import { classifySecrets, type ListedSecret } from "../../src/domain/secrets";
import type { Machine } from "../../src/domain/status";
import type { TailnetDevice } from "../../src/domain/tailnet";
import {
  bucketRemains,
  bucketAppeared,
  bucketUnreachable,
  CHECK_LISTED_DEVICES,
  checkOutsideEc2,
  CHECK_UNCHECKED_DEVICES,
  DEVICES_NOT_CHECKED,
  destroyPlanMismatch,
  destroyPlanRefusal,
  destroyProjectionRefusal,
  dispatchLeftStopped,
  FACTORY_JSON_KEPT,
  interruptedTeardown,
  leftoversUnverified,
  machinesChanged,
  ranWithoutLock,
  remainingAt,
  stateStillRecords,
  stoppedPartWay,
  REVOKE_SOURCES,
  keptSecrets,
  selectFactoryDevices,
  shownDevices,
  shownMachines,
  TEARDOWN_UNCONFIRMABLE,
  teardownAdminClientGone,
  teardownAdminSecretUnreadable,
  teardownConfirmation,
  teardownConfirmMismatch,
  teardownGateActions,
  taggedWithoutBucket,
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

  test("a machine reviewed shutting down that has since terminated is no change", () => {
    const terminating: Machine[] = [machine(INSTANCE_1, "builder-1", "shutting-down")];
    expect(machinesChanged(ID, terminating, [])).toBeUndefined();
    // Any other machine gone, or one shutting down now, still invalidates the review.
    expect(machinesChanged(ID, reviewed, [reviewed[1] as Machine])?.details).toEqual([
      `EC2 instance ${INSTANCE_1} of ${ID}-builder-1: no longer listed`,
    ]);
    expect(
      machinesChanged(ID, reviewed, [
        { ...(reviewed[0] as Machine), state: "shutting-down" },
        reviewed[1] as Machine,
      ])?.details,
    ).toEqual([`EC2 instance ${INSTANCE_1} of ${ID}-builder-1: shutting-down, reviewed running`]);
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
        "Terraform destroyed the factory's resources, but nothing proves that none tagged with its ID remains.",
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
    // Reported only once the run returned, so teardown released whatever was left of the lock.
    expect(remains("unknown").at(-1)).toBe(
      "Deleting the factory lock's versions stopped part way: teardown released it by its version.",
    );
  });

  test("names the admin client's secret as one that may be pending deletion only when it is still found", () => {
    expect(
      teardownAdminSecretUnreadable("Reading failed: InvalidRequestException", true).details,
    ).toEqual([
      "Secrets Manager does not read a secret pending deletion either, as the admin client is for a while once teardown deleted it: rerun `fffactory teardown` once it is gone.",
    ]);
    expect(teardownAdminSecretUnreadable("Reading failed: AccessDeniedException", false)).toEqual({
      summary: "Reading failed: AccessDeniedException",
      details: [],
      nextAction:
        "Check that the credentials may call secretsmanager:GetSecretValue on the secret tailscale.admin_client_secret refers to, then rerun `fffactory teardown`.",
    });
  });

  test("an admin client gone while the factory's resources remain is refused", () => {
    expect(teardownAdminClientGone()).toEqual({
      summary:
        "The Tailscale admin client's secret no longer exists, but the factory's resources remain",
      details: [
        "Teardown deletes the admin client only once the factory's resources and tailnet devices are gone: without it, the devices cannot be deleted.",
      ],
      nextAction:
        "Store the admin client again with `fffactory secret set tailscale-admin-client`, then rerun `fffactory teardown`.",
    });
    expect(DEVICES_NOT_CHECKED).toBe(
      "not checked: teardown deletes the admin client only after the devices",
    );
    expect(CHECK_UNCHECKED_DEVICES).toBe(
      "The admin client's secret no longer exists, so the tailnet's devices were not listed: teardown deletes it only once they are gone. Check the devices at https://login.tailscale.com/admin/machines for any an earlier teardown listed but did not delete, and, if the secret was deleted otherwise, for the factory's own.",
    );
  });

  test("a state bucket S3 answers 403 for is never taken for the factory's", () => {
    expect(bucketUnreachable("fff-abcd1234-state", "123456789012")).toEqual({
      summary:
        "The state bucket fff-abcd1234-state cannot be reached in account 123456789012 (S3 answered 403)",
      details: [
        "S3 answers 403 when these credentials may not reach the bucket, and when its name belongs to another account, as it may once an earlier teardown deleted it: teardown cannot tell which, and never takes it for the factory's bucket.",
      ],
      nextAction:
        "Check that the credentials may reach the bucket (s3:ListBucket), then rerun `fffactory teardown`. If an earlier teardown reached the state bucket's deletion, it had removed everything else of the factory it could before: the name may since be another account's, and nothing of the factory is left in it.",
    });
  });

  test("host keys the state still records after the destroy are named, never a malformed one", () => {
    expect(stateStillRecords(["builder-1", "tskey-pasted Secret"])).toEqual({
      summary: "The factory's Terraform state still records hosts after the destroy",
      details: ["Host builder-1", "A host key that is not well-formed"],
      nextAction:
        "Rerun `fffactory teardown`: it plans the destroy again from what the state records.",
    });
  });
});

describe("a teardown stopped part way (teardown §Partial failure)", () => {
  const left = {
    devices: ["n0CNTRL", "n1CNTRL"],
    listedDevices: { possible: [], untagged: [] },
    secrets: [`${ID}/tailscale-auth-key`, `${ID}/tailscale-admin-client`],
    bucket: "fff-abcd1234-state",
  };
  const listedDevices = {
    possible: [{ id: "nL", hostname: `${ID}-late` }],
    untagged: [{ id: "nU", hostname: undefined }],
  };

  test("what remains is every kind from where it stopped on, in D6's order", () => {
    expect(remainingAt("destroy", left)).toEqual({ state: true, ...left, plans: true });
    expect(remainingAt("leftovers", left)).toEqual({ state: false, ...left, plans: true });
    expect(remainingAt("devices", left)).toEqual({ state: false, ...left, plans: true });
    expect(remainingAt("secrets", left)).toEqual({
      state: false,
      devices: [],
      listedDevices: left.listedDevices,
      secrets: left.secrets,
      plans: true,
      bucket: left.bucket,
    });
    expect(remainingAt("plans", left)).toEqual({
      state: false,
      devices: [],
      listedDevices: left.listedDevices,
      secrets: [],
      plans: true,
      bucket: left.bucket,
    });
    expect(remainingAt("bucket", left)).toEqual({
      state: false,
      devices: [],
      listedDevices: left.listedDevices,
      secrets: [],
      plans: false,
      bucket: left.bucket,
    });
  });

  test("lists what remains after what failed, keeping the summary and next action", () => {
    const failed = { summary: "It failed", details: ["Why"], nextAction: "Rerun it." };
    expect(stoppedPartWay(failed, remainingAt("destroy", left))).toEqual({
      summary: "It failed",
      details: [
        "Why",
        "Remains: whatever the factory's Terraform state still holds",
        "Remains: tailnet devices n0CNTRL, n1CNTRL",
        `Remains: owned secrets ${ID}/tailscale-auth-key, ${ID}/tailscale-admin-client`,
        "Remains: the local saved plans",
        "Remains: the state bucket fff-abcd1234-state",
      ],
      nextAction: "Rerun it.",
    });
    expect(
      stoppedPartWay(failed, remainingAt("leftovers", { ...left, devices: "unchecked" })).details,
    ).toContain(`Tailnet devices: ${DEVICES_NOT_CHECKED}`);
    expect(stoppedPartWay(failed, remainingAt("bucket", left)).details).toEqual([
      "Why",
      "Remains: the state bucket fff-abcd1234-state",
    ]);
  });

  test("devices not checked stay so past the devices step, with the advice to check them", () => {
    const unchecked = { ...left, devices: "unchecked" as const };
    for (const stop of ["leftovers", "secrets", "plans", "bucket"] as const) {
      expect(remainingAt(stop, unchecked).devices).toBe("unchecked");
      const { details } = stoppedPartWay(
        { summary: "It failed", details: [], nextAction: "Rerun it." },
        remainingAt(stop, unchecked),
      );
      expect(details.slice(0, 2)).toEqual([
        `Tailnet devices: ${DEVICES_NOT_CHECKED}`,
        CHECK_UNCHECKED_DEVICES,
      ]);
    }
  });

  test("devices listed but kept stay reported past the devices step, with the advice to check them", () => {
    const remaining = remainingAt("bucket", { ...left, listedDevices });
    expect(remaining.listedDevices).toEqual(listedDevices);
    expect(
      stoppedPartWay({ summary: "It failed", details: [], nextAction: "Rerun it." }, remaining)
        .details,
    ).toEqual([
      `Listed, not deleted: tailnet devices nL (${ID}-late), nU`,
      CHECK_LISTED_DEVICES,
      "Remains: the state bucket fff-abcd1234-state",
    ]);
  });
});

describe("an interrupted teardown (teardown §Interruption)", () => {
  const at = {
    reached: "inspecting" as const,
    removing: false,
    record: true,
    dispatchStopped: [] as string[],
    listedDevices: { possible: [], untagged: [] },
    lock: "held" as const,
  };

  test("before anything is removed: locked, nothing removed, the lock broken once fffactory exited", () => {
    expect(interruptedTeardown({ ...at, dispatchStopped: [`${ID}-builder-1`] })).toEqual({
      summary: "Interrupted: the factory stays locked, with a record of this teardown",
      details: [
        "Nothing was removed.",
        `Dispatch is stopped on ${ID}-builder-1: \`fffactory apply\` restarts it.`,
      ],
      nextAction:
        "Once fffactory has exited, break the lock with `fffactory lock break`, then rerun `fffactory teardown`.",
    });
    expect(interruptedTeardown({ ...at, record: false }).summary).toBe(
      "Interrupted: the factory stays locked by this teardown, which may have no operation record",
    );
  });

  test("once removing: how far it got, in words, and the rerun finishing from what remains", () => {
    expect(
      interruptedTeardown({ ...at, reached: "removing_secrets", removing: true }).details,
    ).toEqual([
      "Teardown had begun removing the factory, and was deleting the owned secrets: a rerun inventories again and finishes from what remains.",
    ]);
    const words = {
      applying: "destroying the factory's resources",
      verifying: "checking that nothing tagged with the factory ID remains",
      removing_devices: "deleting the tailnet devices",
      removing_plans: "removing the local saved plans",
      deleting_bucket: "deleting the state bucket",
    } as const;
    for (const [reached, doing] of Object.entries(words))
      expect(
        interruptedTeardown({ ...at, reached: reached as keyof typeof words, removing: true })
          .details[0],
      ).toContain(`and was ${doing}: `);
  });

  test("once removing, the devices listed but kept are reported, with the advice to check them", () => {
    expect(
      interruptedTeardown({
        ...at,
        reached: "removing_secrets",
        removing: true,
        listedDevices: {
          possible: [],
          untagged: [{ id: "nU", hostname: `${ID}-builder-1` }],
        },
      }).details.slice(1),
    ).toEqual([`Listed, not deleted: tailnet devices nU (${ID}-builder-1)`, CHECK_LISTED_DEVICES]);
  });

  test("once the bucket's deletion reached the lock, it may be gone, and is broken only if found", () => {
    const deleting = {
      ...at,
      reached: "deleting_bucket" as const,
      removing: true,
      record: false,
    };
    expect(interruptedTeardown({ ...deleting, lock: "unknown" })).toMatchObject({
      summary:
        "Interrupted while the state bucket was being deleted: the factory lock may already be gone with it",
      nextAction:
        "Once fffactory has exited, rerun `fffactory teardown`. If it finds the factory locked by this teardown, break that lock with `fffactory lock break`, then rerun it.",
    });
    const gone = interruptedTeardown({ ...deleting, lock: "deleted" });
    expect(gone).toMatchObject({
      summary:
        "Interrupted while the state bucket was being deleted: the factory lock is already gone with it",
      nextAction: "Once fffactory has exited, rerun `fffactory teardown`.",
    });
    expect(gone.nextAction).not.toContain("lock break");
  });
});

describe("a factory without a state bucket (teardown §No state bucket)", () => {
  const BUCKET = "fff-abcd1234-state";

  test("says why it runs without a lock, claiming only what it observed", () => {
    expect(ranWithoutLock(BUCKET)).toBe(
      `No factory lock: S3 does not find the state bucket ${BUCKET}, which would hold it, and ` +
        "EC2 lists no instance or VPC tagged with the factory ID; nothing outside EC2, such as " +
        "IAM, was looked for. Without a lock, teardown deletes only the factory's tailnet " +
        "devices, owned secrets and local saved plans, as `fffactory secret set` stores " +
        "secrets before a bucket exists.",
    );
  });

  test("leaves what it did not look for, outside EC2, to the operator: IAM", () => {
    expect(checkOutsideEc2(ID)).toBe(
      "Without the state bucket, teardown looked for nothing outside EC2: check IAM for the " +
        `role and instance profile ${ID}-host, which a failed first apply may have left, and ` +
        "delete them yourself if they are this factory's.",
    );
  });

  test("refuses resources tagged with the factory ID, naming each: their state is lost", () => {
    const machines: Machine[] = [
      { instanceId: INSTANCE_1, state: "stopped", hostKey: "builder-1" },
      { instanceId: INSTANCE_2, state: "running", hostKey: "tskey-pasted Secret" },
    ];
    const refused = taggedWithoutBucket(BUCKET, machines, ["vpc-0a1b2c3d"]);
    expect(refused).toEqual({
      summary: `The state bucket ${BUCKET} does not exist, but resources tagged with the factory's ID do`,
      details: [
        "Their Terraform state was kept in the state bucket: without it, teardown cannot destroy them, and nothing was removed.",
        `EC2 instance ${INSTANCE_1} (stopped)`,
        `EC2 instance ${INSTANCE_2} (running)`,
        "VPC vpc-0a1b2c3d",
      ],
      nextAction:
        "Check them in the EC2 console and remove those that are this factory's yourself, then rerun `fffactory teardown`.",
    });
    expect(JSON.stringify(refused)).not.toContain("tskey");
  });

  test("refuses a state bucket created after the review", () => {
    expect(bucketAppeared(BUCKET)).toEqual({
      summary: `The state bucket ${BUCKET} exists now, but did not when the factory was reviewed`,
      details: ["Nothing was removed."],
      nextAction: "Rerun `fffactory teardown` to review the factory as it is now.",
    });
  });

  test("asks about what is left: its tailnet devices and owned secrets", () => {
    expect(teardownQuestion(ID, true)).toBe(
      `Remove what is left of factory ${ID}? Its tailnet devices and owned secrets are ` +
        "deleted, and none can be recovered. Type the factory ID to confirm: ",
    );
  });

  test("names no state bucket among what remains: there is none", () => {
    const left = {
      devices: [],
      listedDevices: { possible: [], untagged: [] },
      secrets: [`${ID}/tailscale-auth-key`],
      bucket: undefined,
    };
    expect(remainingAt("secrets", left).bucket).toBeUndefined();
    expect(
      stoppedPartWay(
        { summary: "It failed", details: [], nextAction: "Rerun it." },
        remainingAt("secrets", left),
      ).details,
    ).toEqual([
      `Remains: owned secrets ${ID}/tailscale-auth-key`,
      "Remains: the local saved plans",
    ]);
  });

  test("interrupted, it kept no lock, and the rerun needs no lock break", () => {
    const at = {
      reached: "awaiting_approval" as const,
      removing: false,
      record: false,
      dispatchStopped: [],
      listedDevices: { possible: [], untagged: [] },
      lock: "none" as const,
    };
    expect(interruptedTeardown(at)).toEqual({
      summary:
        "Interrupted: the factory is not locked, since it has no state bucket to hold a lock",
      details: ["Nothing was removed."],
      nextAction: "Once fffactory has exited, rerun `fffactory teardown`.",
    });
    expect(
      interruptedTeardown({ ...at, reached: "removing_secrets", removing: true }).details,
    ).toEqual([
      "Teardown had begun removing the factory, and was deleting the owned secrets: a rerun inventories again and finishes from what remains.",
    ]);
  });
});

describe("teardown's advice (teardown §Report)", () => {
  test("leaves factory.json and every source it only refers to to the operator", () => {
    expect(FACTORY_JSON_KEPT).toBe(
      "factory.json is left as it is: teardown never changes it. It still describes the factory, so `fffactory apply` would create a new one. Remove it yourself once you no longer need it.",
    );
    expect(REVOKE_SOURCES).toBe(
      "Teardown revokes nothing it only refers to. Once nothing else uses them, revoke the Tailscale auth key and admin OAuth client (https://login.tailscale.com/admin/settings/trust-credentials), remove the tailnet policy entries made for the factory (its tag, grant and SSH rule), and revoke the API credentials kept above, with any grants given to them, at their providers.",
    );
    expect(CHECK_LISTED_DEVICES).toContain("https://login.tailscale.com/admin/machines");
  });
});
