import { describe, expect, test } from "bun:test";
import {
  describeRemovalPlan,
  failedAfterRemoval,
  HOST_SECRETS_POLICY,
  type HostRemoval,
  recordedKeysUnreadable,
  removalApplyFailed,
  removalConfigurationChanged,
  removalPlanningFailed,
  removalPlanRefusal,
  removalProjectionRefusal,
  removalStillRecorded,
  removalUnwritten,
  withoutHost,
} from "../../src/domain/host-removal";
import {
  assessCompleteness,
  type FactoryId,
  type FactoryInstance,
  type HostKey,
  parseFactoryInstance,
  type SecretReference,
  serializeInstance,
} from "../../src/domain/instance";
import type { PlanTarget, ResourceChange } from "../../src/domain/plan";
import type { Release } from "../../src/domain/instance";

const KEY = "builder-1" as HostKey;
const WORKER = { key: KEY, hostname: "fff-abcd1234-builder-1" };
const HOST = `module.hosts.aws_instance.host["${KEY}"]`;
const AUTH =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/tailscale-auth-key-AbCdEf";
const PASEO_1 =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/builder-1/paseo-password-AbCdEf" as SecretReference;
const PASEO_2 =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/builder-2/paseo-password-AbCdEf";

/** A change as `terraform show -json` gives it. */
function change(
  address: string,
  actions: readonly string[],
  extra: Record<string, unknown> = {},
  type = address.includes("aws_instance") ? "aws_instance" : "aws_vpc",
) {
  return { address, mode: "managed", type, change: { actions, ...extra } };
}

const plan = (...changes: unknown[]) => ({ format_version: "1.2", resource_changes: changes });

/** The instance EC2 lists for the host, which the gates inspected and the question names. */
const INSTANCE = "i-0123456789abcdef0";

/** The host's machine destroyed, as `terraform show -json` gives it: the instance in `before`. */
const destroying = (id: unknown = INSTANCE) =>
  change(HOST, ["delete"], { before: { id, instance_type: "t3.large" }, after: null });

const REMOVING: HostRemoval = { key: KEY, instanceId: INSTANCE };

/** The hosts' secret-reading policy document as Terraform renders it. */
function policy(resources: readonly string[] | string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadFactorySecrets",
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
        Resource: resources,
      },
    ],
  });
}

function policyUpdate(before: string, after: string, extra: Record<string, unknown> = {}) {
  const attributes = {
    id: "fff-abcd1234-host:fff-abcd1234-read-secrets",
    role: "fff-abcd1234-host",
  };
  return change(
    HOST_SECRETS_POLICY,
    ["update"],
    {
      before: { ...attributes, policy: before },
      after: { ...attributes, policy: after },
      after_unknown: {},
      ...extra,
    },
    "aws_iam_role_policy",
  );
}

describe("removing one host from factory.json (worker-lifecycle §Terminate (remove))", () => {
  test("drops exactly that host, by own entries, leaving the document and the rest as they were", () => {
    const instance: FactoryInstance = {
      schema_version: 1,
      release: "0.3.0",
      factory_id: "fff-abcd1234" as FactoryId,
      hosts: [{ key: KEY }, { key: "builder-2" as HostKey }],
    };
    const removed = withoutHost(instance, KEY);
    expect(removed as unknown).toEqual({
      schema_version: 1,
      release: "0.3.0",
      factory_id: "fff-abcd1234",
      hosts: [{ key: "builder-2" }],
    });
    expect(Object.keys(removed)).toEqual(Object.keys(instance));
    expect(instance.hosts).toHaveLength(2);
  });

  test("the last host leaves an empty factory: valid, complete, its repositories still declared", () => {
    const instance = {
      schema_version: 1,
      release: "0.3.0",
      factory_id: "fff-abcd1234",
      name: "Test factory",
      aws: { account_id: "123456789012", region: "eu-west-2" },
      state_backend: { bucket: "fff-abcd1234-state" },
      network: {
        vpc_cidr: "10.42.0.0/16",
        public_subnet_cidr: "10.42.1.0/24",
        availability_zone: "eu-west-2a",
      },
      tailscale: { tag: "tag:factory", auth_key_secret: AUTH },
      repositories: [
        { key: "product", remote: "https://github.com/yaunder/product", path: "p", branch: "main" },
      ],
      hosts: [
        {
          key: KEY,
          instance_type: "t3.large",
          root_volume_gib: 64,
          paseo_password_secret: PASEO_1,
          repositories: ["product"],
          dispatch: { enabled: false },
        },
      ],
    } as unknown as FactoryInstance;
    const removed = withoutHost(instance, KEY);
    // The host's placements and dispatch settings are its own entry's: they go with it.
    expect(removed.hosts).toEqual([]);
    expect(removed.repositories).toEqual(instance.repositories);
    const parsed = parseFactoryInstance(JSON.parse(serializeInstance(removed)));
    expect(parsed.valid).toBe(true);
    expect(assessCompleteness(removed)).toEqual({ complete: true, missing: [] });
  });
});

describe("the scoped removal plan (worker-lifecycle §Terminate (remove))", () => {
  const OTHER = `Apply factory.json's other changes first with \`fffactory apply\`, or undo them, then rerun \`fffactory worker terminate builder-1\`.`;

  test("passes when its only change destroys the named host's machine", () => {
    expect(removalPlanRefusal(plan(destroying()), REMOVING)).toBeUndefined();
    expect(
      removalPlanRefusal(
        plan(
          destroying(),
          change("module.network.aws_vpc.this", ["no-op"]),
          change(
            "data.aws_iam_policy_document.read_secrets",
            ["read"],
            {},
            "aws_iam_policy_document",
          ),
        ),
        REMOVING,
      ),
    ).toBeUndefined();
  });

  test("refuses any other change: extra creates, updates, other deletes and replaces fail closed", () => {
    const others = [
      [
        change("module.network.aws_vpc.this", ["create"]),
        "module.network.aws_vpc.this would be created",
      ],
      [
        change("module.network.aws_vpc.this", ["update"]),
        "module.network.aws_vpc.this would be updated in place",
      ],
      [
        change('module.hosts.aws_instance.host["builder-2"]', ["delete"]),
        'module.hosts.aws_instance.host["builder-2"] would be destroyed',
      ],
      [
        change('module.hosts.aws_instance.host["builder-2"]', ["delete", "create"]),
        'module.hosts.aws_instance.host["builder-2"] would be replaced',
      ],
      [
        change("module.network.aws_vpc.this", ["forget"]),
        "module.network.aws_vpc.this would be forgotten by Terraform",
      ],
      [
        change("module.network.aws_vpc.this", ["mystery"]),
        "module.network.aws_vpc.this would be changed by an action fffactory does not know (mystery)",
      ],
    ] as const;
    for (const [other, reason] of others)
      expect(removalPlanRefusal(plan(destroying(), other), REMOVING)).toEqual({
        summary:
          "The removal plan changes more than host builder-1's machine: apply factory.json's other changes first",
        details: [reason],
        nextAction: OTHER,
      });
  });

  test("refuses replacing the named host, or deleting it as anything but its machine", () => {
    for (const named of [
      change(HOST, ["delete", "create"]),
      change(HOST, ["create", "delete"]),
      change(HOST, ["delete"], {}, "aws_vpc"),
      { ...destroying(), mode: "data" },
    ])
      expect(removalPlanRefusal(plan(named), REMOVING)?.summary).toStartWith(
        "The removal plan changes more than host builder-1's machine",
      );
  });

  test("refuses a plan that does not destroy the machine EC2 lists", () => {
    expect(removalPlanRefusal(plan(), REMOVING)).toEqual({
      summary:
        "Terraform's plan does not destroy host builder-1's machine: its state does not hold the instance EC2 lists for it",
      details: [],
      nextAction:
        "Check the instance carrying the host key builder-1 in the EC2 console, then rerun " +
        "`fffactory worker terminate builder-1`.",
    });
  });

  test("refuses destroying any instance but the one EC2 lists, the gates inspected and the question names", () => {
    const check =
      "Check the instances carrying the host key builder-1 in the EC2 console, then rerun " +
      "`fffactory worker terminate builder-1`.";
    // The state holds another instance, say one whose tags were stripped by hand.
    expect(removalPlanRefusal(plan(destroying("i-0aaaaaaaaaaaaaaaa")), REMOVING)).toEqual({
      summary:
        "Terraform's plan destroys instance i-0aaaaaaaaaaaaaaaa for host builder-1, not " +
        "i-0123456789abcdef0, the instance EC2 lists for it",
      details: [],
      nextAction:
        "Check instances i-0aaaaaaaaaaaaaaaa and i-0123456789abcdef0 in the EC2 console, then rerun " +
        "`fffactory worker terminate builder-1`.",
    });
    // Every change of the machine is checked, should a plan hold several.
    expect(
      removalPlanRefusal(plan(destroying(), destroying("i-0aaaaaaaaaaaaaaaa")), REMOVING)?.summary,
    ).toStartWith("Terraform's plan destroys instance i-0aaaaaaaaaaaaaaaa for host builder-1");
    // An instance it cannot identify fails closed.
    for (const unidentified of [
      change(HOST, ["delete"], { before: { instance_type: "t3.large" }, after: null }),
      destroying(""),
      destroying(42),
      change(HOST, ["delete"], { before: null, after: null }),
      change(HOST, ["delete"]),
    ])
      expect(removalPlanRefusal(plan(unidentified), REMOVING)).toEqual({
        summary:
          "Terraform's plan does not identify the instance it destroys for host builder-1: " +
          "only i-0123456789abcdef0, the instance EC2 lists for it, may be destroyed",
        details: [],
        nextAction: check,
      });
  });

  test("with the machine already gone, passes no change, and refuses destroying one EC2 does not list", () => {
    const gone: HostRemoval = { key: KEY };
    expect(removalPlanRefusal(plan(), gone)).toBeUndefined();
    expect(removalPlanRefusal({ format_version: "1.2" }, gone)).toBeUndefined();
    expect(removalPlanRefusal(plan(destroying()), gone)).toEqual({
      summary:
        "Terraform's state holds a machine for host builder-1 that EC2 does not list with the factory's tags",
      details: [],
      nextAction:
        "Check the factory's instances in the EC2 console, then rerun " +
        "`fffactory worker terminate builder-1`.",
    });
  });

  test("a plan that cannot be read is refused", () => {
    for (const unreadable of [undefined, plan({ address: HOST }), { resource_changes: "x" }])
      expect(removalPlanRefusal(unreadable, REMOVING)?.summary).toBe(
        "Terraform's removal plan could not be read",
      );
  });

  describe("the hosts' secret-reading policy", () => {
    const withSecret: HostRemoval = { key: KEY, instanceId: INSTANCE, secret: PASEO_1 };

    test("may drop exactly the removed host's Paseo password, and nothing else", () => {
      expect(
        removalPlanRefusal(
          plan(
            destroying(),
            policyUpdate(policy([AUTH, PASEO_1, PASEO_2]), policy([AUTH, PASEO_2])),
          ),
          withSecret,
        ),
      ).toBeUndefined();
      // A one-element list renders as a string; the order of the list is not a change.
      expect(
        removalPlanRefusal(
          plan(destroying(), policyUpdate(policy([PASEO_1, AUTH]), policy(AUTH))),
          withSecret,
        ),
      ).toBeUndefined();
    });

    test("any other policy change fails closed", () => {
      const refused = [
        // Without a secret of the removed host's to drop.
        [policyUpdate(policy([AUTH, PASEO_1]), policy(AUTH)), REMOVING],
        // Dropping another host's secret, or keeping the removed one.
        [policyUpdate(policy([AUTH, PASEO_1, PASEO_2]), policy([AUTH, PASEO_1])), withSecret],
        // Adding one.
        [policyUpdate(policy([AUTH, PASEO_1]), policy([AUTH, PASEO_2])), withSecret],
        // Another action.
        [
          policyUpdate(
            policy([AUTH, PASEO_1]),
            policy([AUTH]).replace("GetSecretValue", "PutSecretValue"),
          ),
          withSecret,
        ],
        // Another attribute.
        [
          policyUpdate(policy([AUTH, PASEO_1]), policy(AUTH), {
            after: { id: "x", role: "another-role", policy: policy(AUTH) },
          }),
          withSecret,
        ],
        // Not known until apply.
        [
          policyUpdate(policy([AUTH, PASEO_1]), policy(AUTH), { after_unknown: { policy: true } }),
          withSecret,
        ],
        // Unreadable.
        [policyUpdate(policy([AUTH, PASEO_1]), "{not json"), withSecret],
      ] as const;
      for (const [update, removal] of refused)
        expect(removalPlanRefusal(plan(destroying(), update), removal)).toMatchObject({
          details: [`${HOST_SECRETS_POLICY} would be updated in place`],
        });
    });
  });
});

describe("the removal plan shown for approval (worker-lifecycle §Terminate (remove))", () => {
  const target: PlanTarget = {
    instancePath: "/work/.fffactory/factory.json",
    name: "Test factory",
    factoryId: "fff-abcd1234" as FactoryId,
    accountId: "123456789012",
    region: "eu-west-2",
    release: "0.3.0" as Release,
  };
  const deleting: ResourceChange[] = [{ address: HOST, type: "aws_instance", actions: ["delete"] }];

  test("names the factory, Terraform's changes, the factory.json edit and the devices", () => {
    expect(describeRemovalPlan(target, deleting, WORKER)).toEqual([
      "Removal plan:",
      "  Configuration: /work/.fffactory/factory.json",
      "  Factory: Test factory (fff-abcd1234)",
      "  AWS account: 123456789012, Region: eu-west-2",
      "  Release: 0.3.0",
      "Infrastructure changes:",
      `  - ${HOST}`,
      "  0 to add, 0 to change, 1 to destroy.",
      "factory.json: remove host builder-1.",
      "Tailnet: delete the devices named fff-abcd1234-builder-1 that carry the factory's tag.",
    ]);
    expect(describeRemovalPlan(target, [], WORKER)).toContain("Infrastructure: no changes.");
  });
});

describe("the removal's refusals (worker-lifecycle §Terminate (remove))", () => {
  test("recorded host keys that cannot be read, or a factory.json without the host that cannot be planned", () => {
    expect(recordedKeysUnreadable(KEY)).toEqual({
      summary: "The factory's Terraform state records host keys that cannot be read",
      details: [],
      nextAction:
        "Check the factory's Terraform state with `fffactory plan`, then rerun " +
        "`fffactory worker terminate builder-1`.",
    });
    expect(
      removalProjectionRefusal(KEY, [{ path: "hosts", message: 'host key "b" is provisioned' }]),
    ).toEqual({
      summary: "factory.json without host builder-1 cannot be planned",
      details: ['hosts: host key "b" is provisioned'],
      nextAction: "Correct factory.json, then rerun `fffactory worker terminate builder-1`.",
    });
  });

  test("factory.json no longer the text read: nothing was applied", () => {
    expect(removalConfigurationChanged(KEY, "changed after fffactory read it")).toEqual({
      summary: "factory.json changed after fffactory read it: nothing was applied",
      details: [],
      nextAction: "Rerun `fffactory worker terminate builder-1`.",
    });
  });
});

describe("the removal's failures (worker-lifecycle §Terminate (remove))", () => {
  test("planning: nothing was applied", () => {
    expect(removalPlanningFailed(KEY, "`terraform plan` exited with status 1")).toEqual({
      summary: "Planning the removal failed: `terraform plan` exited with status 1",
      details: ["Nothing was applied: the machine and factory.json are as they were."],
      nextAction: "Rerun `fffactory worker terminate builder-1`.",
    });
  });

  test("applying: factory.json still declares the host, and a rerun finishes the removal", () => {
    expect(removalApplyFailed(KEY, "`terraform apply` exited with status 1")).toEqual({
      summary: "Removing the host failed: `terraform apply` exited with status 1",
      details: [
        "Terraform may have destroyed the machine before it stopped. factory.json is unchanged: it still declares host builder-1.",
      ],
      nextAction:
        "Rerun `fffactory worker terminate builder-1`: it plans the removal again from what " +
        "exists now, and finishes it.",
    });
  });

  test("a key Terraform still records after the apply: factory.json is not written", () => {
    expect(removalStillRecorded(KEY)).toEqual({
      summary: "Terraform still records host builder-1 after applying its removal",
      details: ["factory.json is unchanged: it still declares host builder-1."],
      nextAction: "Rerun `fffactory worker terminate builder-1`.",
    });
  });

  test("writing factory.json: says exactly what to remove, and what apply would do until then", () => {
    expect(removalUnwritten(WORKER, "/work/.fffactory/factory.json", "EACCES")).toEqual({
      summary:
        "Terraform destroyed host builder-1's machine and no longer records it, but factory.json could not be written (EACCES): it still declares the host",
      details: [
        "Until the host is removed from factory.json, `fffactory apply` would create it afresh.",
      ],
      nextAction:
        "Remove the host builder-1 from hosts in /work/.fffactory/factory.json yourself and " +
        "delete the Tailscale devices named fff-abcd1234-builder-1 at " +
        "https://login.tailscale.com/admin/machines, or rerun " +
        "`fffactory worker terminate builder-1` once factory.json can be written: it finds the " +
        "machine gone and finishes the removal.",
    });
  });

  test("an error once factory.json is written: the devices to remove, nothing to rerun", () => {
    expect(failedAfterRemoval(WORKER, "SlowDown")).toEqual({
      summary: "SlowDown",
      details: [
        "Terraform destroyed host builder-1's machine and factory.json no longer declares it; " +
          "its Tailscale devices may remain.",
      ],
      nextAction:
        "Remove the remaining devices named fff-abcd1234-builder-1 at " +
        "https://login.tailscale.com/admin/machines yourself (one without the factory's tag " +
        "only if it was this worker): factory.json no longer declares the host.",
    });
  });
});
