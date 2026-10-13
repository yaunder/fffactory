/**
 * A realistic Terraform state for the factory root module, synthesized without AWS for
 * `terraform-check.ts`'s removal plans: what Terraform's state would hold after an apply of
 * `variables`, its computed values (instance and network IDs, ARNs, addresses) fake but
 * well formed.
 *
 * Terraform plans the variables against the state so far (`-refresh=false`, so nothing is read
 * from AWS); every resource it would create, update or replace takes the plan's `after`
 * values, each value unknown until apply filled by its type in the provider's schema, and its
 * resource identity. That repeats until the plan changes no resource, references between
 * resources (a subnet's VPC ID, say) resolving to the values already in the state; the last
 * plan, which changes only outputs, is applied, which writes the outputs and calls no
 * provider API. The stand-in endpoint refuses any call that would.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SUPPORTED_TERRAFORM } from "../src/domain/managed-terraform";
import type { TerraformRunner, TerraformSession } from "../src/infrastructure/terraform/runner";

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MINUTES = 60 * 1000;
/** More rounds than the factory root's longest chain of references between resources. */
const MAX_ROUNDS = 8;
const AWS_PROVIDER = "registry.terraform.io/hashicorp/aws";

/** The provider's resource schemas, by resource type. */
export type ResourceSchemas = Readonly<Record<string, { readonly block: Json }>>;

export interface StateFixtureContext {
  readonly run: TerraformRunner;
  /** An initialized session in a root module whose local backend keeps state at `statePath`. */
  readonly session: TerraformSession;
  readonly statePath: string;
  /** A private directory for the fixture's inputs and plan files. */
  readonly work: string;
  readonly schemas: ResourceSchemas;
  readonly accountId: string;
  readonly region: string;
}

/** The AWS provider's resource schemas, from `terraform providers schema -json` in `session`. */
export async function resourceSchemas(
  run: TerraformRunner,
  session: TerraformSession,
): Promise<ResourceSchemas> {
  const { stdout } = await run(session, ["providers", "schema", "-json"], {
    timeoutMs: 5 * MINUTES,
  });
  const schemas = JSON.parse(stdout).provider_schemas?.[AWS_PROVIDER]?.resource_schemas;
  if (!isJson(schemas)) throw new Error("terraform providers schema printed no AWS schemas");
  return schemas as ResourceSchemas;
}

/** By resource type: the prefix of its fake IDs and the resource kind in its ARN. */
const EC2_KINDS: Readonly<Record<string, readonly [string, string]>> = {
  aws_instance: ["i", "instance"],
  aws_internet_gateway: ["igw", "internet-gateway"],
  aws_route_table: ["rtb", "route-table"],
  aws_route_table_association: ["rtbassoc", "route-table-association"],
  aws_security_group: ["sg", "security-group"],
  aws_subnet: ["subnet", "subnet"],
  aws_vpc: ["vpc", "vpc"],
};
const IAM_KINDS: Readonly<Record<string, string>> = {
  aws_iam_instance_profile: "instance-profile",
  aws_iam_role: "role",
};

const digest = (seed: string, length: number) =>
  createHash("sha256").update(seed).digest("hex").slice(0, length);
const octet = (seed: string) => 10 + (Number.parseInt(digest(seed, 2), 16) % 200);

interface Resource {
  readonly type: string;
  readonly address: string;
}

/** An ID as AWS would assign it, derived from the resource's address so every round agrees. */
function fakeId({ type, address }: Resource, values: Json): unknown {
  if (type in IAM_KINDS) return values.name;
  if (type === "aws_iam_role_policy")
    return values.role == null ? null : `${values.role}:${values.name}`;
  if (type === "aws_route")
    return values.route_table_id == null ? null : `r-${values.route_table_id}1080289494`;
  return `${EC2_KINDS[type]?.[0] ?? "res"}-0${digest(address, 16)}`;
}

function fakeArn(resource: Resource, values: Json, context: StateFixtureContext): unknown {
  const iam = IAM_KINDS[resource.type];
  if (iam !== undefined) return `arn:aws:iam::${context.accountId}:${iam}/${values.name}`;
  const kind = EC2_KINDS[resource.type]?.[1] ?? resource.type;
  const id = values.id ?? fakeId(resource, values);
  return `arn:aws:ec2:${context.region}:${context.accountId}:${kind}/${id}`;
}

/** A top-level attribute's fake value once applied; undefined for one its type decides. */
function fakeValue(
  resource: Resource,
  attribute: string,
  values: Json,
  context: StateFixtureContext,
): unknown {
  const seed = `${resource.address}.${attribute}`;
  const instance = resource.type === "aws_instance";
  const fakes: Readonly<Record<string, () => unknown>> = {
    id: () => fakeId(resource, values),
    arn: () => fakeArn(resource, values, context),
    owner_id: () => context.accountId,
    unique_id: () => `AROA${digest(seed, 17).toUpperCase()}`,
    create_date: () => "2026-10-01T12:00:00Z",
    private_ip: () => `10.78.1.${octet(seed)}`,
    public_ip: () => `198.51.100.${octet(seed)}`,
    instance_state: () => (instance ? "running" : undefined),
    availability_zone: () => (instance ? `${context.region}a` : undefined),
    name: () =>
      resource.type === "aws_security_group"
        ? `${values.name_prefix}20261001120000000000000001`
        : undefined,
  };
  return Object.hasOwn(fakes, attribute) ? fakes[attribute]?.() : undefined;
}

/** What an unknown value of `type` holds once applied when nothing sets it: empty or null. */
function emptyOf(type: unknown): unknown {
  if (!Array.isArray(type)) return null;
  if (type[0] === "list" || type[0] === "set") return [];
  return type[0] === "map" ? {} : null;
}

/** An unknown nested block once applied: no blocks, or null for a single one. */
function emptyBlock(nested: Json | undefined): unknown {
  const mode = nested?.nesting_mode;
  return mode === "list" || mode === "set" ? [] : null;
}

interface Top {
  readonly resource: Resource;
  readonly context: StateFixtureContext;
}

const records = (value: unknown): Json => (isJson(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The value `name` holds once applied, given its `mark` in `after_unknown`: a top-level
 * attribute's fake value when it has one, any other unknown one by its type in `block`, and
 * nested blocks filled element by element. Undefined to leave it as planned.
 */
function filledValue(block: Json, name: string, mark: unknown, values: Json, top?: Top): unknown {
  const nested = isJson(records(block.block_types)[name])
    ? (records(block.block_types)[name] as Json)
    : undefined;
  if (mark === true) {
    const fake = top && fakeValue(top.resource, name, values, top.context);
    const attribute = records(block.attributes)[name];
    return fake ?? (isJson(attribute) ? emptyOf(attribute.type) : emptyBlock(nested));
  }
  if (!Array.isArray(mark) || !Array.isArray(values[name]) || !isJson(nested?.block))
    return undefined;
  const inner = nested.block;
  return values[name].map((element, index) => filledBlock(inner, element, mark[index]));
}

/** `after` with every value its `unknown` marks filled (`filledValue`). */
function filledBlock(block: Json, after: unknown, unknown: unknown, top?: Top): Json {
  const values: Json = { ...records(after) };
  // An ARN names the ID, so it is filled last.
  const names = Object.keys(records(unknown)).sort(
    (a, b) => Number(a === "arn") - Number(b === "arn"),
  );
  for (const name of names) {
    const value = filledValue(block, name, records(unknown)[name], values, top);
    if (value !== undefined) values[name] = value;
  }
  return values;
}

/** One resource instance of the state, with where it belongs. */
interface StateInstance {
  readonly address: string;
  readonly module?: string;
  readonly type: string;
  readonly name: string;
  readonly provider: string;
  readonly index?: unknown;
  readonly instance: Json;
}

/** A JSON plan module's resources and its child modules', depth first. */
function moduleResources(module: unknown): Json[] {
  const own = list(records(module).resources).filter(isJson);
  return [...own, ...list(records(module).child_modules).flatMap(moduleResources)];
}

/** The planned values' resources (schema and identity versions), by address. */
function plannedByAddress(json: Json): Map<string, Json> {
  const resources = moduleResources(records(json.planned_values).root_module);
  return new Map(resources.map((resource) => [String(resource.address), resource]));
}

/** The resource identity AWS reports for the applied values, as the plan shapes it. */
function identityOf(planned: Json, attributes: Json, context: StateFixtureContext): Json {
  if (planned.identity_schema_version == null || !isJson(planned.identity)) return {};
  const fill = (key: string) =>
    key === "account_id" ? context.accountId : key === "region" ? context.region : attributes[key];
  return {
    identity_schema_version: planned.identity_schema_version,
    identity: Object.fromEntries(
      Object.keys(planned.identity).map((key) => [key, fill(key) ?? null]),
    ),
  };
}

/** The state instance a planned change leaves once applied. */
function applied(
  change: Json,
  planned: Json,
  context: StateFixtureContext,
): StateInstance | undefined {
  const type = String(change.type);
  const address = String(change.address);
  const schema = context.schemas[type];
  const { after, after_unknown } = change.change as Json;
  if (schema === undefined || after === null) return undefined;
  const attributes = filledBlock(schema.block, after, after_unknown, {
    resource: { type, address },
    context,
  });
  return {
    address,
    ...(typeof change.module_address === "string" ? { module: change.module_address } : {}),
    type,
    name: String(change.name),
    provider: `provider["${change.provider_name}"]`,
    ...(change.index === undefined ? {} : { index: change.index }),
    instance: {
      schema_version: planned.schema_version,
      attributes,
      sensitive_attributes: [],
      ...identityOf(planned, attributes, context),
    },
  };
}

/** The managed resource changes that change something, from a JSON plan. */
function changing(json: Json): Json[] {
  const changes = Array.isArray(json.resource_changes) ? json.resource_changes : [];
  return changes.filter(
    (change): change is Json =>
      isJson(change) &&
      change.mode === "managed" &&
      isJson(change.change) &&
      (change.change.actions as string[]).some((action) => action !== "no-op"),
  );
}

/** A state version 4 document of `instances`, grouped by resource. */
function stateDocument(instances: Iterable<StateInstance>, lineage: string, serial: number): Json {
  const resources = new Map<string, Json & { instances: Json[] }>();
  for (const { module, type, name, provider, index, instance } of instances) {
    const key = `${module ?? ""} ${type} ${name}`;
    const resource = resources.get(key) ?? {
      ...(module === undefined ? {} : { module }),
      mode: "managed",
      type,
      name,
      provider,
      instances: [],
    };
    resource.instances.push({ ...(index === undefined ? {} : { index_key: index }), ...instance });
    resources.set(key, resource);
  }
  return {
    version: 4,
    terraform_version: SUPPORTED_TERRAFORM.version,
    serial,
    lineage,
    outputs: {},
    resources: [...resources.values()],
    check_results: null,
  };
}

/** Plans `inputs` against the state so far without refreshing it; its JSON plan. */
async function planned(context: StateFixtureContext, inputs: string, planFile: string) {
  const { run, session } = context;
  const timeout = { timeoutMs: 10 * MINUTES };
  await run(
    session,
    [
      "plan",
      "-input=false",
      "-no-color",
      "-refresh=false",
      "-detailed-exitcode",
      `-var-file=${inputs}`,
      `-out=${planFile}`,
    ],
    { ...timeout, exitCodes: [0, 2] },
  );
  const { stdout } = await run(session, ["show", "-json", "-no-color", planFile], timeout);
  return JSON.parse(stdout) as Json;
}

/**
 * The state text an apply of `variables` would leave, at `context.statePath` too. Throws when
 * the plans do not settle within `MAX_ROUNDS`, naming the resources still changing.
 */
export async function synthesizedState(
  context: StateFixtureContext,
  label: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<string> {
  const inputs = join(context.work, `${label}.tfvars.json`);
  const planFile = join(context.work, `${label}.tfplan`);
  await writeFile(inputs, JSON.stringify(variables), { mode: 0o600 });
  const lineage = randomUUID();
  const instances = new Map<string, StateInstance>();
  let pending: string[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    await writeFile(
      context.statePath,
      JSON.stringify(stateDocument(instances.values(), lineage, round)),
    );
    const json = await planned(context, inputs, planFile);
    const changes = changing(json);
    if (changes.length === 0) {
      await context.run(context.session, ["apply", "-input=false", "-no-color", planFile], {
        timeoutMs: 10 * MINUTES,
      });
      return readFile(context.statePath, "utf8");
    }
    const resources = plannedByAddress(json);
    for (const change of changes) {
      const address = String(change.address);
      const state = applied(change, resources.get(address) ?? {}, context);
      if (state === undefined) instances.delete(address);
      else instances.set(address, state);
    }
    pending = changes.map((change) => String(change.address));
  }
  throw new Error(
    `The ${label} state fixture did not settle in ${MAX_ROUNDS} plans; still changing: ${pending.join(", ")}`,
  );
}
