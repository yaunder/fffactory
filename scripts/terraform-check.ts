#!/usr/bin/env bun
/**
 * Checks the shipped Terraform modules with the managed Terraform, never a system one:
 *
 *   bun scripts/terraform-check.ts
 *
 * 1. `terraform fmt -check` over `assets/terraform`;
 * 2. `init -backend=false -lockfile=readonly` and `validate` in each root module, so each
 *    shipped lockfile must already cover its providers;
 * 3. the namespacing check: plans every root module (`factory`, `backend`, `archive`) for two
 *    factory IDs, projected from `examples/factory.json`, and requires every name in each JSON
 *    plan to carry its factory ID and no name of one factory's plans to appear in the other's;
 * 4. the user data check: every planned host's user data, rendered by Terraform's
 *    `templatefile`, must equal the rendering the bootstrap tests run
 *    (`tests/support/user-data.ts`), so those tests exercise what hosts boot with; and the
 *    archive check: each archive plan only creates the log archive bucket fffactory derives,
 *    in S3's account-regional namespace, with exactly its settings (versioning, public access
 *    block, bucket-owner-enforced ownership, SSE-S3, ABAC, the TLS-only Deny) and nothing more;
 *    and the archive grant check: in each factory plan, the example enabling the log archive,
 *    the hosts' role holds exactly the secret-reading policy and one `<id>-write-archive`
 *    policy that is exactly the own-prefix PutObject Allow and the If-None-Match Deny on the
 *    bucket that factory ID's archive plan creates;
 * 5. the empty factory check: the factory root planned from the example without hosts, as
 *    `fffactory worker terminate` leaves a factory whose last host it removed, plans no
 *    instance and keeps the shared infrastructure, its hosts' policy allowing only the
 *    Tailscale enrollment key; and the credentials check: planned from the example with every
 *    `credentials.*_secret` set, the hosts' policy allows exactly the enrollment key, the
 *    host's Paseo password and the three credential references; and planned from the example
 *    with `log_archive` disabled, the hosts' role holds only its secret-reading policy;
 * 6. the removal plan check (`terraform-removal-check.ts`): `worker terminate`'s scoped
 *    removal rule, `removalPlanRefusal`, judges Terraform's real removal plans, each planned
 *    from a local state for several hosts or one that `terraform-state-fixture.ts`
 *    synthesizes from Terraform's own plans, with no AWS account and no factory state;
 * 7. the destroy plan check (`terraform-destroy-check.ts`): teardown's guarded destroy plan
 *    rule, `destroyPlanRefusal`, and its exit code check, `destroyPlanMismatch`, judge
 *    Terraform's real `plan -destroy` of the factory root from synthesized states with one host
 *    and with two, from an empty state, and from a state holding only the root outputs, each
 *    plan deleting every resource and root output the state holds and nothing else.
 *
 * The plans run against no AWS account. An override file, added only to this script's copy
 * of the modules, keeps state local and gives the AWS provider documentation example keys,
 * skips its account and credential checks, and points every endpoint it could call at a
 * local stand-in that answers only the Amazon Linux image parameter lookup. Terraform runs
 * with only the caller's PATH, HOME, TMPDIR and proxy settings, its AWS config and
 * credentials files set to /dev/null and the instance metadata service disabled. Downloads the
 * managed Terraform (into the FFFactory cache) and the AWS provider when they are not cached.
 * Spec: docs/specs/provisioning.md §Resources and namespacing; the removal plans,
 * docs/specs/worker-lifecycle.md §Terminate (remove); the destroy plans,
 * docs/specs/provisioning.md §Destroy plan.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cacheDirectoryPath } from "../src/application/cache-directory";
import { managedTerraformPaths } from "../src/application/managed-terraform";
import {
  projectArchiveVariables,
  projectBackendVariables,
  projectFactoryVariables,
} from "../src/application/project-terraform-inputs";
import { type FactoryId, type FactoryInstance, parseFactoryInstance } from "../src/domain/instance";
import { SUPPORTED_TERRAFORM } from "../src/domain/managed-terraform";
import { managedTerraform } from "../src/infrastructure/terraform/installer";
import {
  CLI_CONFIGURATION,
  terraformProvisioner,
} from "../src/infrastructure/terraform/provisioner";
import {
  namespaceProblems,
  plannedNames,
  sharedNames,
} from "../src/infrastructure/terraform/resource-names";
import { type TerraformSession, terraformRunner } from "../src/infrastructure/terraform/runner";
import { renderUserData } from "../tests/support/user-data";
import { destroyPlanProblems } from "./terraform-destroy-check";
import { removalPlanProblems } from "./terraform-removal-check";
import { resourceSchemas } from "./terraform-state-fixture";

const ROOT = resolve(import.meta.dir, "..");
const ROOT_MODULES = ["factory", "backend", "archive"] as const;
const FACTORY_IDS = ["fff-aaaa1111", "fff-bbbb2222"] as FactoryId[];
const MINUTES = 60 * 1000;
const EXAMPLE_KEYS = {
  access: "AKIAIOSFODNN7EXAMPLE",
  secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
/** Services the AWS provider could call for these modules; each goes to the stand-in. */
const ENDPOINTS = ["ec2", "iam", "s3", "ssm", "sts"];

/**
 * Only what Terraform needs to run and download; no AWS or Terraform settings of the caller.
 * The AWS config and credentials files point at /dev/null and the instance metadata service is
 * off, so the provider can read no local profile or credential even through `HOME`.
 */
const operator = {
  ...Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"].flatMap(
      (name) => (process.env[name] === undefined ? [] : [[name, process.env[name] as string]]),
    ),
  ),
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
  AWS_EC2_METADATA_DISABLED: "true",
};
const run = terraformRunner(operator);

/** Answers the SSM lookup of the Amazon Linux image; refuses every other request. */
function standIn() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.headers.get("x-amz-target") !== "AmazonSSM.GetParameter")
        return new Response("not served by the terraform-check stand-in", { status: 400 });
      const { Name } = (await request.json()) as { Name: string };
      return Response.json(
        { Parameter: { Name, Type: "String", Value: "ami-0123456789abcdef0", Version: 1 } },
        { headers: { "content-type": "application/x-amz-json-1.1" } },
      );
    },
  });
}

/** The override of the check's copy; its local state at `statePath` when given. */
function override(endpoint: string, statePath?: string): string {
  const endpoints = ENDPOINTS.map((service) => `    ${service} = "${endpoint}"`).join("\n");
  const backend =
    statePath === undefined ? "{}" : `{\n    path = ${JSON.stringify(statePath)}\n  }`;
  return `# Written by scripts/terraform-check.ts into its own copy; never shipped.
terraform {
  backend "local" ${backend}
}

provider "aws" {
  access_key                  = "${EXAMPLE_KEYS.access}"
  secret_key                  = "${EXAMPLE_KEYS.secret}"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  allowed_account_ids         = null

  endpoints {
${endpoints}
  }
}
`;
}

type RootModule = (typeof ROOT_MODULES)[number];

/** How a check varies the example before projecting it. */
interface ExampleVariation {
  /** Without hosts, as `fffactory worker terminate` leaves a factory whose last host it removed. */
  readonly empty?: boolean;
  /** These `credentials` references. */
  readonly credentials?: Record<string, string>;
  /** With `log_archive` disabled. */
  readonly withoutArchive?: boolean;
}

/** The example's projection for `factoryId`, varied as `variation` says. */
async function exampleVariables(
  factoryId: FactoryId,
  root: RootModule,
  { empty = false, credentials, withoutArchive = false }: ExampleVariation = {},
) {
  const example = JSON.parse(await readFile(join(ROOT, "examples/factory.json"), "utf8"));
  const bucket = `${factoryId}-${example.state_backend.bucket.slice(example.factory_id.length + 1)}`;
  const parsed = parseFactoryInstance({
    ...example,
    factory_id: factoryId,
    state_backend: { bucket },
    ...(empty ? { hosts: [] } : {}),
    ...(credentials === undefined ? {} : { credentials }),
    ...(withoutArchive ? { log_archive: { enabled: false } } : {}),
  });
  if (!parsed.valid) throw new Error("examples/factory.json is not a valid instance");
  const projection = project(root, parsed.instance);
  if (!projection.ok)
    throw new Error(`examples/factory.json does not project to the ${root} variables`);
  return projection.variables;
}

function project(root: RootModule, instance: FactoryInstance) {
  if (root === "factory") return projectFactoryVariables(instance, []);
  return root === "backend" ? projectBackendVariables(instance) : projectArchiveVariables(instance);
}

interface Plan {
  readonly factoryId: FactoryId;
  readonly root: RootModule;
  readonly variables: Record<string, unknown>;
  readonly json: unknown;
}

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The planned resources of a plan's modules of `type` named `name`, depth first. */
function plannedResources(module: unknown, type: string, name: string): Json[] {
  if (!isJson(module)) return [];
  const own = (Array.isArray(module.resources) ? module.resources : []).filter(
    (resource): resource is Json =>
      isJson(resource) && resource.type === type && resource.name === name,
  );
  const children = Array.isArray(module.child_modules) ? module.child_modules : [];
  return [...own, ...children.flatMap((child) => plannedResources(child, type, name))];
}

/** The planned `aws_instance.host` resources of a plan's modules, depth first. */
function plannedHosts(module: unknown): Json[] {
  return plannedResources(module, "aws_instance", "host");
}

/** The root module of a JSON plan's planned values. */
function plannedRoot(json: unknown): unknown {
  return isJson(json) && isJson(json.planned_values) ? json.planned_values.root_module : undefined;
}

/**
 * What is wrong with the empty factory's plan: a host planned, the shared infrastructure
 * missing, or a secret-reading policy allowing anything but the Tailscale enrollment key.
 */
function emptyFactoryProblems(json: unknown, variables: Record<string, unknown>): string[] {
  const root = plannedRoot(json);
  const problems: string[] = [];
  if (plannedHosts(root).length > 0) problems.push("the plan holds a host");
  for (const [type, name] of [
    ["aws_vpc", "factory"],
    ["aws_iam_role", "host"],
    ["aws_iam_instance_profile", "host"],
  ])
    if (plannedResources(root, type as string, name as string).length !== 1)
      problems.push(`the plan does not keep ${type}.${name}`);
  const resources = policyResources(root);
  const auth = variables.tailscale_auth_key_secret_arn;
  if (resources === undefined || resources.length !== 1 || resources[0] !== auth)
    problems.push("the hosts' policy does not allow exactly the Tailscale enrollment key");
  return problems;
}

/** The resources the planned hosts' secret-reading policy allows, or undefined if unread. */
function policyResources(root: unknown): unknown[] | undefined {
  const [policy] = plannedResources(root, "aws_iam_role_policy", "read_secrets");
  const document = isJson(policy?.values) ? policy.values.policy : undefined;
  const statements =
    typeof document === "string" ? [JSON.parse(document).Statement].flat() : undefined;
  return statements?.flatMap((statement: Json) => [statement.Resource].flat());
}

/** The example's credential references, in its factory's Region and account. */
const EXAMPLE_CREDENTIALS = Object.fromEntries(
  ["github_token_secret", "anthropic_api_key_secret", "openai_api_key_secret"].map((field) => [
    field,
    `arn:aws:secretsmanager:us-east-1:123456789012:secret:example/${field}-AbCdEf`,
  ]),
);

/**
 * What is wrong with the plan of a factory with credential references: a policy allowing
 * anything but the enrollment key, the hosts' Paseo passwords and those references.
 */
function credentialProblems(json: unknown, variables: Record<string, unknown>): string[] {
  const expected = [
    variables.tailscale_auth_key_secret_arn,
    ...Object.values(variables.paseo_password_secret_arns as Record<string, string>),
    ...Object.values(EXAMPLE_CREDENTIALS),
  ].sort();
  const resources = policyResources(plannedRoot(json));
  return resources !== undefined &&
    JSON.stringify([...resources].sort()) === JSON.stringify(expected)
    ? []
    : [
        "the hosts' policy does not allow exactly the enrollment key, Paseo passwords and credentials",
      ];
}

/**
 * The hosts' archive-writing policy as AWS receives it, for `factoryId` writing to `bucket`
 * (D2): PutObject only under the worker incarnation's own prefix (`aws:userid`, the role ID and
 * instance ID), on a bucket carrying the factory-ID tag, and never without If-None-Match, so
 * no write replaces an object. No read, list, delete, ACL or lifecycle action.
 */
function writeArchivePolicy(factoryId: string, bucket: string): Json {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "WriteOwnArchivePrefix",
        Effect: "Allow",
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::${bucket}/archive/1/${factoryId}/workers/\${aws:userid}/*`,
        Condition: { StringEquals: { "aws:ResourceTag/fffactory:factory-id": factoryId } },
      },
      {
        Sid: "DenyWritesWithoutIfNoneMatch",
        Effect: "Deny",
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::${bucket}/*`,
        Condition: { Null: { "s3:if-none-match": "true" } },
      },
    ],
  };
}

/** The planned inline policy resources (`aws_iam_role_policy`) of the hosts' role. */
function rolePolicies(json: unknown): Json[] {
  return plannedAll(plannedRoot(json)).filter(
    (resource) => resource.mode === "managed" && resource.type === "aws_iam_role_policy",
  );
}

/**
 * What is wrong with the hosts' role in a factory plan whose factory.json enables the log
 * archive: inline policies other than exactly the secret-reading and archive-writing ones, so
 * no other policy grants anything of the archive; or an archive-writing policy misnamed, or
 * other than exactly `writeArchivePolicy` for the bucket the same factory ID's archive plan
 * creates.
 */
function writeArchiveProblems(factoryId: FactoryId, json: unknown, bucket: unknown): string[] {
  const all = rolePolicies(json);
  const names = all.map((resource) => String(resource.name)).sort();
  if (!isDeepStrictEqual(names, ["read_secrets", "write_archive"]))
    return [
      `the hosts' role holds ${names.join(", ")}, not exactly the secret-reading and archive-writing policies`,
    ];
  const policy = all.find((resource) => resource.name === "write_archive");
  const values = isJson(policy?.values) ? policy.values : {};
  const problems: string[] = [];
  if (values.name !== `${factoryId}-write-archive`)
    problems.push(`the archive-writing policy is not named ${factoryId}-write-archive`);
  const document = typeof values.policy === "string" ? JSON.parse(values.policy) : undefined;
  if (
    typeof bucket !== "string" ||
    !isDeepStrictEqual(document, writeArchivePolicy(factoryId, bucket))
  )
    problems.push(
      "the archive-writing policy is not exactly the own-prefix PutObject Allow and the If-None-Match Deny on the archive bucket",
    );
  return problems;
}

/**
 * The archive root's settings, by resource type: each dotted path into the planned values
 * (a nested block followed into its first instance) and the value it must have. The plan
 * holds exactly these types, one of each, so a lifecycle rule, Object Lock configuration or
 * KMS key fails too.
 */
const ARCHIVE_SETTINGS: Readonly<Record<string, readonly (readonly [string, unknown])[]>> = {
  aws_s3_bucket: [
    ["bucket_namespace", "account-regional"],
    ["force_destroy", false],
  ],
  aws_s3_bucket_abac: [["abac_status.status", "Enabled"]],
  aws_s3_bucket_public_access_block: [
    ["block_public_acls", true],
    ["block_public_policy", true],
    ["ignore_public_acls", true],
    ["restrict_public_buckets", true],
  ],
  aws_s3_bucket_ownership_controls: [["rule.object_ownership", "BucketOwnerEnforced"]],
  aws_s3_bucket_server_side_encryption_configuration: [
    ["rule.apply_server_side_encryption_by_default.sse_algorithm", "AES256"],
  ],
  aws_s3_bucket_versioning: [["versioning_configuration.status", "Enabled"]],
  aws_s3_bucket_policy: [],
};

/** The bucket policy's one statement as planned; its resources, the bucket's ARN, are unknown. */
const TLS_ONLY_STATEMENT = {
  actions: ["s3:*"],
  condition: [{ test: "Bool", values: ["false"], variable: "aws:SecureTransport" }],
  effect: "Deny",
  principals: [{ identifiers: ["*"], type: "*" }],
};

/** The value at a dotted path, following a nested block list into its first instance. */
function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((at, segment) => {
    const object = Array.isArray(at) ? at[0] : at;
    return isJson(object) ? object[segment] : undefined;
  }, value);
}

/** Every managed and data resource of a JSON plan's planned values, depth first. */
function plannedAll(module: unknown): Json[] {
  if (!isJson(module)) return [];
  const own = (Array.isArray(module.resources) ? module.resources : []).filter(isJson);
  const children = Array.isArray(module.child_modules) ? module.child_modules : [];
  return [...own, ...children.flatMap(plannedAll)];
}

/** Every change in a JSON plan other than a create, or a data source's read. */
function nonCreates(json: unknown): string[] {
  const changes = isJson(json) && Array.isArray(json.resource_changes) ? json.resource_changes : [];
  return changes.filter(isJson).flatMap((change) => {
    const actions = isJson(change.change) ? change.change.actions : undefined;
    const allowed = change.mode === "data" ? "read" : "create";
    return JSON.stringify(actions) === JSON.stringify([allowed])
      ? []
      : [`${String(change.address)} is planned to ${JSON.stringify(actions)}`];
  });
}

/** Every planned resource of a type other than `ARCHIVE_SETTINGS`', or a setting it lacks. */
function settingProblems(managed: readonly Json[]): string[] {
  const types = managed.map((resource) => String(resource.type)).sort();
  const problems =
    JSON.stringify(types) === JSON.stringify(Object.keys(ARCHIVE_SETTINGS).sort())
      ? []
      : [`the plan holds ${types.join(", ")}, not the bucket and its settings alone`];
  for (const resource of managed)
    for (const [path, expected] of ARCHIVE_SETTINGS[String(resource.type)] ?? [])
      if (valueAt(resource.values, path) !== expected)
        problems.push(`${String(resource.address)}: ${path} is not ${JSON.stringify(expected)}`);
  return problems;
}

/** Whether the planned policy documents hold exactly the TLS-only Deny. */
function tlsOnly(documents: readonly Json[]): boolean {
  const statements = documents.flatMap((document) => {
    const planned = isJson(document.values) ? document.values.statement : undefined;
    return Array.isArray(planned) ? planned.filter(isJson) : [];
  });
  if (statements.length !== 1) return false;
  const [{ actions, condition, effect, principals }] = statements as [Json];
  return (
    JSON.stringify({ actions, condition, effect, principals }) ===
    JSON.stringify(TLS_ONLY_STATEMENT)
  );
}

/**
 * What is wrong with the archive root's plan for its factory ID: a change other than a create
 * (or the policy document's read), a resource type other than the bucket and its settings, a
 * setting other than the ones it must have, a name other than the projected one, no
 * factory-ID tag, or a bucket policy other than the TLS-only Deny.
 */
function archiveProblems({ factoryId, variables, json }: Plan): string[] {
  const resources = plannedAll(plannedRoot(json));
  const managed = resources.filter((resource) => resource.mode === "managed");
  const problems = [...nonCreates(json), ...settingProblems(managed)];
  const bucket = managed.find((resource) => resource.type === "aws_s3_bucket")?.values;
  const name = `${factoryId}-${String(variables.archive_bucket_suffix)}`;
  if (valueAt(bucket, "bucket") !== name)
    problems.push(`the bucket is not named ${name}, as fffactory derives it`);
  if (valueAt(bucket, "tags_all.fffactory:factory-id") !== factoryId)
    problems.push("the bucket does not carry the factory-ID tag");
  if (!tlsOnly(resources.filter((resource) => resource.mode === "data")))
    problems.push("the bucket policy is not the TLS-only Deny alone");
  return problems;
}

/** Every host whose planned user data differs from the bootstrap tests' rendering. */
function userDataProblems(plans: readonly Plan[]): string[] {
  return plans
    .filter((plan) => plan.root === "factory")
    .flatMap(({ factoryId, variables, json }) => {
      const hosts = plannedHosts(plannedRoot(json));
      if (hosts.length === 0) return [`${factoryId}: the plan holds no hosts`];
      return hosts.flatMap((host) => {
        const values = isJson(host.values) ? host.values : {};
        const expected = renderUserData({
          hostname: `${factoryId}-${String(host.index)}`,
          region: variables.region as string,
          tailscale_auth_key_secret_arn: variables.tailscale_auth_key_secret_arn as string,
          tailscale_tag: variables.tailscale_tag as string,
        });
        return values.user_data === expected
          ? []
          : [`${factoryId} ${String(host.address)}: user_data differs from the tests' rendering`];
      });
    });
}

/** The archive bucket each archive plan creates, by factory ID. */
function archiveBuckets(plans: readonly Plan[]): Map<FactoryId, unknown> {
  return new Map(
    plans
      .filter((plan) => plan.root === "archive")
      .map(({ factoryId, json }) => {
        const resources = plannedAll(plannedRoot(json));
        const bucket = resources.find((resource) => resource.type === "aws_s3_bucket")?.values;
        return [factoryId, valueAt(bucket, "bucket")];
      }),
  );
}

/**
 * The user data check, the archive check, then the archive grant check, over the namespacing
 * plans; true when all hold.
 */
function plannedRootChecks(plans: readonly Plan[]): boolean {
  const userData = userDataProblems(plans);
  if (userData.length > 0) {
    console.error(`User data check failed:\n${userData.map((p) => `  ${p}`).join("\n")}`);
    return false;
  }
  console.log("user data: every planned host boots with the bootstrap tests' rendering");
  const archive = plans
    .filter((plan) => plan.root === "archive")
    .flatMap((plan) => archiveProblems(plan).map((problem) => `${plan.factoryId}: ${problem}`));
  if (archive.length > 0) {
    console.error(`Archive check failed:\n${archive.map((p) => `  ${p}`).join("\n")}`);
    return false;
  }
  console.log(
    "archive: the archive root only creates the account-regional bucket, versioned, private, SSE-S3, with ABAC and the TLS-only Deny, and no lifecycle rule, Object Lock or KMS",
  );
  const buckets = archiveBuckets(plans);
  const grant = plans
    .filter((plan) => plan.root === "factory")
    .flatMap(({ factoryId, json }) =>
      writeArchiveProblems(factoryId, json, buckets.get(factoryId)).map(
        (problem) => `${factoryId}: ${problem}`,
      ),
    );
  if (grant.length > 0) {
    console.error(`Archive grant check failed:\n${grant.map((p) => `  ${p}`).join("\n")}`);
    return false;
  }
  console.log(
    "archive grant: the hosts' role holds only the secret-reading and archive-writing policies, which let hosts only PutObject under their own prefix of their factory's archive, with If-None-Match",
  );
  return true;
}

/** Every namespacing problem across the plans of both factory IDs. */
function namespacingProblems(plans: readonly Plan[]): string[] {
  const problems = plans.flatMap(({ factoryId, root, json }) => [
    ...namespaceProblems(json, factoryId).map((problem) => `${factoryId} ${root}: ${problem}`),
    ...(plannedNames(json).names.length === 0
      ? [`${factoryId} ${root}: the plan holds no names, so the check proved nothing`]
      : []),
  ]);
  const [first, second] = FACTORY_IDS;
  for (const ours of plans.filter((plan) => plan.factoryId === first))
    for (const theirs of plans.filter((plan) => plan.factoryId === second))
      problems.push(
        ...sharedNames(ours.json, theirs.json).map(
          (name) => `${first} ${ours.root} and ${second} ${theirs.root} both plan the name ${name}`,
        ),
      );
  return problems;
}

/**
 * The removal plan check (`terraform-removal-check.ts`), then the destroy plan check
 * (`terraform-destroy-check.ts`), in a copy of their own, whose factory root keeps its
 * synthesized state locally; true when every case of both holds.
 */
async function stateChecks(
  work: string,
  endpoint: string,
  session: (directory: string, data: string) => TerraformSession,
  cache: string,
): Promise<boolean> {
  const tree = join(work, "removal-terraform");
  const statePath = join(work, "removal.tfstate");
  await cp(join(ROOT, "assets/terraform"), tree, { recursive: true });
  await writeFile(join(tree, "factory/fffactory_check_override.tf"), override(endpoint, statePath));
  const at = session(join(tree, "factory"), "removal");
  await run(at, ["init", "-input=false", "-no-color", "-lockfile=readonly"], {
    timeoutMs: 10 * MINUTES,
  });
  const example = JSON.parse(await readFile(join(ROOT, "examples/factory.json"), "utf8"));
  const context = {
    run,
    provisioner: terraformProvisioner({
      cacheDirectory: cache,
      terraform: managedTerraform(),
      run,
    }),
    tree,
    statePath,
    session: at,
    work,
    fixture: {
      schemas: await resourceSchemas(run, at),
      accountId: example.aws.account_id,
      region: example.aws.region,
    },
    example,
    factoryId: FACTORY_IDS[0] as FactoryId,
  };
  const removal = await removalPlanProblems(context);
  for (const line of removal.report) console.log(line);
  if (removal.problems.length > 0) {
    console.error(
      `Removal plan check failed:\n${removal.problems.map((p) => `  ${p}`).join("\n")}`,
    );
    return false;
  }
  console.log(
    "removal plans: Terraform's plans of each removal are exactly the removal's, and removalPlanRefusal allows and refuses them as fffactory must",
  );
  const destroy = await destroyPlanProblems(context);
  for (const line of destroy.report) console.log(line);
  if (destroy.problems.length > 0) {
    console.error(
      `Destroy plan check failed:\n${destroy.problems.map((p) => `  ${p}`).join("\n")}`,
    );
    return false;
  }
  console.log(
    "destroy plans: Terraform's destroy plans delete every resource and root output of the factory root and nothing else, and destroyPlanRefusal and the exit code check allow them, destroyPlanRefusal refusing every tampered one",
  );
  return true;
}

/**
 * The factory root planned from variations of the example, each with `planned`: the empty
 * factory check, the credentials check, then the archive grant check without the log archive;
 * true when all hold.
 */
async function variationChecks(
  factoryId: FactoryId,
  planned: (label: string, variables: object) => Promise<unknown>,
): Promise<boolean> {
  const variables = await exampleVariables(factoryId, "factory", { empty: true });
  const empty = emptyFactoryProblems(await planned("empty", variables), { ...variables });
  if (empty.length > 0) {
    console.error(`Empty factory check failed:\n${empty.map((p) => `  ${p}`).join("\n")}`);
    return false;
  }
  console.log(
    "empty factory: no host is planned; the network and host identity stay, its policy allowing only the enrollment key",
  );
  const delivering = await exampleVariables(factoryId, "factory", {
    credentials: EXAMPLE_CREDENTIALS,
  });
  const credentials = credentialProblems(await planned("credentials", delivering), {
    ...delivering,
  });
  if (credentials.length > 0) {
    console.error(`Credentials check failed:\n${credentials.map((p) => `  ${p}`).join("\n")}`);
    return false;
  }
  console.log(
    "credentials: the hosts' policy allows the enrollment key, the Paseo passwords and every credential reference",
  );
  const withoutArchive = await exampleVariables(factoryId, "factory", { withoutArchive: true });
  const policies = rolePolicies(await planned("without-archive", withoutArchive)).map((resource) =>
    String(resource.name),
  );
  if (JSON.stringify(policies) !== JSON.stringify(["read_secrets"])) {
    console.error(
      `Archive grant check failed:\n  without log_archive the hosts' role holds ${policies.join(", ")}, not the secret-reading policy alone`,
    );
    return false;
  }
  console.log("archive grant: without log_archive the hosts' role may only read its secrets");
  return true;
}

async function main(): Promise<number> {
  const cache = cacheDirectoryPath(process.env, homedir());
  const executable = await managedTerraform().install(cache);
  const { pluginCache } = managedTerraformPaths(cache, SUPPORTED_TERRAFORM.version);
  const work = await mkdtemp(join(tmpdir(), "fffactory-terraform-check-"));
  const server = standIn();
  try {
    const tree = join(work, "terraform");
    await cp(join(ROOT, "assets/terraform"), tree, { recursive: true });
    const cliConfigFile = join(work, "terraformrc");
    await writeFile(cliConfigFile, CLI_CONFIGURATION, { mode: 0o600 });
    const session = (directory: string, data: string): TerraformSession => ({
      executable,
      workingDirectory: directory,
      dataDirectory: join(work, data),
      pluginCache,
      cliConfigFile,
      credentials: { source: "chain" },
      region: "us-east-1",
    });
    const timeout = { timeoutMs: 10 * MINUTES };

    await run(session(tree, "fmt"), ["fmt", "-check", "-recursive", "-no-color"], timeout);
    console.log("terraform fmt: ok");
    for (const root of ROOT_MODULES) {
      const at = session(join(tree, root), `validate-${root}`);
      await run(
        at,
        ["init", "-input=false", "-no-color", "-backend=false", "-lockfile=readonly"],
        timeout,
      );
      await run(at, ["validate", "-no-color"], timeout);
      console.log(`terraform validate ${root}: ok`);
    }

    const plans: Plan[] = [];
    for (const root of ROOT_MODULES) {
      const directory = join(tree, root);
      await writeFile(
        join(directory, "fffactory_check_override.tf"),
        override(`http://127.0.0.1:${server.port}`),
      );
      for (const factoryId of FACTORY_IDS) {
        const at = session(directory, `plan-${root}-${factoryId}`);
        const inputs = join(work, `${root}-${factoryId}.tfvars.json`);
        const planFile = join(work, `${root}-${factoryId}.tfplan`);
        const variables = await exampleVariables(factoryId, root);
        await writeFile(inputs, JSON.stringify(variables), { mode: 0o600 });
        await run(at, ["init", "-input=false", "-no-color", "-lockfile=readonly"], timeout);
        await run(
          at,
          [
            "plan",
            "-input=false",
            "-no-color",
            "-refresh=false",
            `-var-file=${inputs}`,
            `-out=${planFile}`,
          ],
          timeout,
        );
        const { stdout } = await run(at, ["show", "-json", "-no-color", planFile], timeout);
        plans.push({ factoryId, root, variables: { ...variables }, json: JSON.parse(stdout) });
      }
    }

    const problems = namespacingProblems(plans);
    if (problems.length > 0) {
      console.error(`Namespacing check failed:\n${problems.map((p) => `  ${p}`).join("\n")}`);
      return 1;
    }
    const counts = plans
      .filter((plan) => plan.factoryId === FACTORY_IDS[0])
      .map(({ root, json }) => `${plannedNames(json).names.length} in ${root}`);
    console.log(
      `namespacing: every name (${counts.join(", ")}) carries its factory ID; none is shared between ${FACTORY_IDS.join(" and ")}`,
    );
    if (!plannedRootChecks(plans)) return 1;

    const [factoryId] = FACTORY_IDS as [FactoryId];
    const directory = join(tree, "factory");
    const at = session(directory, `plan-factory-${factoryId}`);
    /** The factory root planned once from `variables`, as `terraform show -json` gives it. */
    const planned = async (label: string, variables: object): Promise<unknown> => {
      const inputs = join(work, `factory-${factoryId}-${label}.tfvars.json`);
      const planFile = join(work, `factory-${factoryId}-${label}.tfplan`);
      await writeFile(inputs, JSON.stringify(variables), { mode: 0o600 });
      await run(
        at,
        [
          "plan",
          "-input=false",
          "-no-color",
          "-refresh=false",
          `-var-file=${inputs}`,
          `-out=${planFile}`,
        ],
        timeout,
      );
      const { stdout } = await run(at, ["show", "-json", "-no-color", planFile], timeout);
      return JSON.parse(stdout);
    };
    if (!(await variationChecks(factoryId, planned))) return 1;
    if (!(await stateChecks(work, `http://127.0.0.1:${server.port}`, session, cache))) return 1;
    return 0;
  } finally {
    server.stop(true);
    await rm(work, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  console.error(error instanceof Error ? error.message : String(error));
  if (typeof diagnostics === "string") console.error(diagnostics);
  process.exitCode = 1;
}
