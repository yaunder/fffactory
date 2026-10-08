import { describe, expect, test } from "bun:test";
import type { FactoryId } from "../../../src/domain/instance";
import {
  NAMED_RESOURCES,
  namespaceProblems,
  plannedNames,
  sharedNames,
} from "../../../src/infrastructure/terraform/resource-names";

type Values = Record<string, unknown>;

function resource(address: string, type: string, values: Values, mode = "managed") {
  return { address, mode, type, name: address.split(".").at(-1), values };
}

/** A Terraform JSON plan whose root module holds `root` and one child module `nested`. */
function plan(root: unknown[], nested: unknown[] = []) {
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        resources: root,
        child_modules: [{ address: "module.hosts", resources: nested }],
      },
    },
  };
}

function factoryPlan(id: string) {
  return plan(
    [
      resource("aws_vpc.factory", "aws_vpc", { tags: { Name: `${id}-vpc` } }),
      resource("aws_route.public_internet", "aws_route", { destination_cidr_block: "0.0.0.0/0" }),
      resource("data.aws_ssm_parameter.al2023", "aws_ssm_parameter", { name: "/aws/x" }, "data"),
    ],
    [
      resource('module.hosts.aws_instance.host["b-1"]', "aws_instance", {
        tags: { Name: `${id}-b-1`, "fffactory:host-key": "b-1" },
        root_block_device: [{ tags: { Name: `${id}-b-1-root` } }],
      }),
    ],
  );
}

const A = "fff-aaaa1111" as FactoryId;
const B = "fff-bbbb2222" as FactoryId;

describe("names in a Terraform JSON plan (provisioning §Resources and namespacing)", () => {
  test("collects every classified name of every managed resource, in child modules too", () => {
    expect(plannedNames(factoryPlan(A))).toEqual({
      names: [
        { address: "aws_vpc.factory", path: "tags.Name", name: `${A}-vpc` },
        { address: 'module.hosts.aws_instance.host["b-1"]', path: "tags.Name", name: `${A}-b-1` },
        {
          address: 'module.hosts.aws_instance.host["b-1"]',
          path: "root_block_device.tags.Name",
          name: `${A}-b-1-root`,
        },
      ],
      problems: [],
    });
  });

  test("a plan whose names all carry the factory ID has no namespace problem", () => {
    expect(namespaceProblems(factoryPlan(A), A)).toEqual([]);
  });

  test("a name without the factory ID is a namespace problem", () => {
    const unprefixed = plan([
      resource("aws_iam_role.host", "aws_iam_role", { name: "factory-host" }),
    ]);
    expect(namespaceProblems(unprefixed, A)).toEqual([
      "aws_iam_role.host: name does not start with the factory ID",
    ]);
    expect(namespaceProblems(factoryPlan(A), B)).toHaveLength(3);
  });

  test("a resource type with no naming rule is a problem, so none escapes the check", () => {
    const unknown = plan([resource("aws_eip.x", "aws_eip", { tags: { Name: `${A}-eip` } })]);
    expect(plannedNames(unknown).problems).toEqual([
      "aws_eip.x: resource type aws_eip has no naming rule",
    ]);
    expect(namespaceProblems(unknown, A)).toEqual([
      "aws_eip.x: resource type aws_eip has no naming rule",
    ]);
  });

  test("a name not known at plan time is a problem", () => {
    const unknown = plan([resource("aws_iam_role.host", "aws_iam_role", {})]);
    expect(plannedNames(unknown).problems).toEqual([
      "aws_iam_role.host: name is not known when planning",
    ]);
  });

  test("two factory IDs produce no shared name", () => {
    expect(sharedNames(factoryPlan(A), factoryPlan(B))).toEqual([]);
    expect(sharedNames(factoryPlan(A), factoryPlan(A))).toEqual([
      `${A}-vpc`,
      `${A}-b-1`,
      `${A}-b-1-root`,
    ]);
  });

  test("a document that is not a plan has no names", () => {
    for (const document of [
      null,
      "plan",
      {},
      { planned_values: {} },
      { planned_values: { root_module: {} } },
    ])
      expect(plannedNames(document)).toEqual({ names: [], problems: [] });
  });

  test("every classified name path is a dotted attribute path", () => {
    for (const paths of Object.values(NAMED_RESOURCES))
      for (const path of paths) expect(path).toMatch(/^[a-z_]+(\.[A-Za-z_]+)*$/);
  });
});
