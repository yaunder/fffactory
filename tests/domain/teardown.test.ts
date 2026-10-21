import { describe, expect, test } from "bun:test";
import type { Machine } from "../../src/domain/status";
import { destroyPlanRefusal } from "../../src/domain/teardown";

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
