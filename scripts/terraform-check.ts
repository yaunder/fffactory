#!/usr/bin/env bun
/**
 * Checks the shipped Terraform modules with the managed Terraform, never a system one:
 *
 *   bun scripts/terraform-check.ts
 *
 * 1. `terraform fmt -check` over `assets/terraform`;
 * 2. `init -backend=false -lockfile=readonly` and `validate` in each root module, so each
 *    shipped lockfile must already cover its providers;
 * 3. the namespacing check: plans both root modules for two factory IDs, projected from
 *    `examples/factory.json`, and requires every name in each JSON plan to carry its
 *    factory ID and no name of one factory's plans to appear in the other's;
 * 4. the user data check: every planned host's user data, rendered by Terraform's
 *    `templatefile`, must equal the rendering the bootstrap tests run
 *    (`tests/support/user-data.ts`), so those tests exercise what hosts boot with;
 * 5. the empty factory check: the factory root planned from the example without hosts, as
 *    `fffactory worker terminate` leaves a factory whose last host it removed, plans no
 *    instance and keeps the shared infrastructure, its hosts' policy allowing only the
 *    Tailscale enrollment key; and the credentials check: planned from the example with every
 *    `credentials.*_secret` set, the hosts' policy allows exactly the enrollment key, the
 *    host's Paseo password and the three credential references;
 * 6. the removal plan check (`terraform-removal-check.ts`): `worker terminate`'s scoped
 *    removal rule, `removalPlanRefusal`, judges Terraform's real removal plans, each planned
 *    from a local state for several hosts or one that `terraform-state-fixture.ts`
 *    synthesizes from Terraform's own plans, with no AWS account and no factory state.
 *
 * The plans run against no AWS account. An override file, added only to this script's copy
 * of the modules, keeps state local and gives the AWS provider documentation example keys,
 * skips its account and credential checks, and points every endpoint it could call at a
 * local stand-in that answers only the Amazon Linux image parameter lookup. Terraform runs
 * with only the caller's PATH, HOME, TMPDIR and proxy settings, its AWS config and
 * credentials files set to /dev/null and the instance metadata service disabled. Downloads the
 * managed Terraform (into the FFFactory cache) and the AWS provider when they are not cached.
 * Spec: docs/specs/provisioning.md §Resources and namespacing; the removal plans,
 * docs/specs/worker-lifecycle.md §Terminate (remove).
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cacheDirectoryPath } from "../src/application/cache-directory";
import { managedTerraformPaths } from "../src/application/managed-terraform";
import {
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
import { removalPlanProblems } from "./terraform-removal-check";
import { resourceSchemas } from "./terraform-state-fixture";

const ROOT = resolve(import.meta.dir, "..");
const ROOT_MODULES = ["factory", "backend"] as const;
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

/** The example's projection for `factoryId`, or, with `empty`, that of the example without hosts. */
async function exampleVariables(
  factoryId: FactoryId,
  root: RootModule,
  empty = false,
  credentials?: Record<string, string>,
) {
  const example = JSON.parse(await readFile(join(ROOT, "examples/factory.json"), "utf8"));
  const bucket = `${factoryId}-${example.state_backend.bucket.slice(example.factory_id.length + 1)}`;
  const parsed = parseFactoryInstance({
    ...example,
    factory_id: factoryId,
    state_backend: { bucket },
    ...(empty ? { hosts: [] } : {}),
    ...(credentials === undefined ? {} : { credentials }),
  });
  if (!parsed.valid) throw new Error("examples/factory.json is not a valid instance");
  const projection = project(root, parsed.instance);
  if (!projection.ok)
    throw new Error(`examples/factory.json does not project to the ${root} variables`);
  return projection.variables;
}

function project(root: RootModule, instance: FactoryInstance) {
  return root === "factory"
    ? projectFactoryVariables(instance, [])
    : projectBackendVariables(instance);
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
 * The removal plan check (`terraform-removal-check.ts`) in a copy of its own, whose factory
 * root keeps its synthesized state locally; true when every case holds.
 */
async function removalCheck(
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
  const { report, problems } = await removalPlanProblems({
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
  });
  for (const line of report) console.log(line);
  if (problems.length === 0) return true;
  console.error(`Removal plan check failed:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  return false;
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
    const userData = userDataProblems(plans);
    if (userData.length > 0) {
      console.error(`User data check failed:\n${userData.map((p) => `  ${p}`).join("\n")}`);
      return 1;
    }
    console.log("user data: every planned host boots with the bootstrap tests' rendering");

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
    const variables = await exampleVariables(factoryId, "factory", true);
    const empty = emptyFactoryProblems(await planned("empty", variables), { ...variables });
    if (empty.length > 0) {
      console.error(`Empty factory check failed:\n${empty.map((p) => `  ${p}`).join("\n")}`);
      return 1;
    }
    console.log(
      "empty factory: no host is planned; the network and host identity stay, its policy allowing only the enrollment key",
    );
    const delivering = await exampleVariables(factoryId, "factory", false, EXAMPLE_CREDENTIALS);
    const credentials = credentialProblems(await planned("credentials", delivering), {
      ...delivering,
    });
    if (credentials.length > 0) {
      console.error(`Credentials check failed:\n${credentials.map((p) => `  ${p}`).join("\n")}`);
      return 1;
    }
    console.log(
      "credentials: the hosts' policy allows the enrollment key, the Paseo passwords and every credential reference",
    );
    if (!(await removalCheck(work, `http://127.0.0.1:${server.port}`, session, cache))) return 1;
    console.log(
      "removal plans: Terraform's plans of each removal are exactly the removal's, and removalPlanRefusal allows and refuses them as fffactory must",
    );
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
