/**
 * Which attributes name each AWS resource type the shipped Terraform modules use, and the
 * namespacing check over a Terraform JSON plan: every such name must be known when planning
 * and carry the factory ID. The same table drives the static guardrail test over the
 * modules' HCL (`tests/assets/terraform/guardrails.test.ts`), so a resource type the table
 * does not classify fails both.
 */
import type { FactoryId } from "../../domain/instance";
import { carriesFactoryId } from "../../domain/resource-naming";

/**
 * Name attributes by resource type, as dotted paths into the resource's attributes (a nested
 * block is followed into each of its instances). An empty list classifies a resource with no
 * name of its own: it is not taggable, or it is part of a named resource.
 */
export const NAMED_RESOURCES: Readonly<Record<string, readonly string[]>> = {
  aws_vpc: ["tags.Name"],
  aws_internet_gateway: ["tags.Name"],
  aws_subnet: ["tags.Name"],
  aws_route_table: ["tags.Name"],
  aws_route: [],
  aws_route_table_association: [],
  aws_security_group: ["name_prefix", "tags.Name"],
  aws_iam_role: ["name"],
  aws_iam_role_policy: ["name"],
  aws_iam_instance_profile: ["name"],
  // TODO(re-evaluate when a module adds an `ebs_block_device` to aws_instance): extra EBS
  // volumes are named by `ebs_block_device.tags.Name`, which no rule here covers; add it.
  aws_instance: ["tags.Name", "root_block_device.tags.Name"],
  aws_s3_bucket: ["bucket"],
  aws_s3_bucket_public_access_block: [],
  aws_s3_bucket_ownership_controls: [],
  aws_s3_bucket_server_side_encryption_configuration: [],
  aws_s3_bucket_versioning: [],
  aws_s3_bucket_policy: [],
};

export interface PlannedName {
  /** The resource instance's address, such as `module.hosts.aws_instance.host["b-1"]`. */
  readonly address: string;
  /** The name attribute's path from `NAMED_RESOURCES`. */
  readonly path: string;
  readonly name: string;
}

export interface PlannedNames {
  readonly names: readonly PlannedName[];
  /** Resources the check cannot vouch for: unclassified types and names unknown at plan. */
  readonly problems: readonly string[];
}

interface PlannedResource {
  readonly address: string;
  readonly type: string;
  readonly values: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Every managed resource in `module` and its child modules, depth first. */
function managedResources(module: unknown): PlannedResource[] {
  if (!isObject(module)) return [];
  const own = listOf(module.resources).filter(
    (resource): resource is PlannedResource =>
      isObject(resource) && resource.mode === "managed" && typeof resource.type === "string",
  );
  return [...own, ...listOf(module.child_modules).flatMap(managedResources)];
}

/** The values at a dotted path, following nested block lists into each instance. */
function valuesAt(value: unknown, segments: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => valuesAt(item, segments));
  const [first, ...rest] = segments;
  if (first === undefined) return [value];
  return isObject(value) && Object.hasOwn(value, first) ? valuesAt(value[first], rest) : [];
}

function namesOf(resource: PlannedResource, paths: readonly string[]): PlannedNames {
  const names: PlannedName[] = [];
  const problems: string[] = [];
  for (const path of paths) {
    const found = valuesAt(resource.values, path.split(".")).filter(
      (name): name is string => typeof name === "string",
    );
    if (found.length === 0)
      problems.push(`${resource.address}: ${path} is not known when planning`);
    for (const name of found) names.push({ address: resource.address, path, name });
  }
  return { names, problems };
}

/** Every name in a Terraform JSON plan's planned values, and what the check cannot vouch for. */
export function plannedNames(plan: unknown): PlannedNames {
  const root =
    isObject(plan) && isObject(plan.planned_values) ? plan.planned_values.root_module : undefined;
  const results = managedResources(root).map((resource) =>
    Object.hasOwn(NAMED_RESOURCES, resource.type)
      ? namesOf(resource, NAMED_RESOURCES[resource.type] as readonly string[])
      : {
          names: [],
          problems: [`${resource.address}: resource type ${resource.type} has no naming rule`],
        },
  );
  return {
    names: results.flatMap((result) => result.names),
    problems: results.flatMap((result) => result.problems),
  };
}

/** Everything wrong with a plan's names for `factoryId`; empty when every name carries it. */
export function namespaceProblems(plan: unknown, factoryId: FactoryId): string[] {
  const { names, problems } = plannedNames(plan);
  return [
    ...problems,
    ...names
      .filter(({ name }) => !carriesFactoryId(name, factoryId))
      .map(({ address, path }) => `${address}: ${path} does not start with the factory ID`),
  ];
}

/** Names two plans have in common, in the first plan's order. */
export function sharedNames(first: unknown, second: unknown): string[] {
  const others = new Set(plannedNames(second).names.map(({ name }) => name));
  return plannedNames(first)
    .names.map(({ name }) => name)
    .filter((name) => others.has(name));
}
