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
 *    (`tests/support/user-data.ts`), so those tests exercise what hosts boot with.
 *
 * The plans run against no AWS account. An override file, added only to this script's copy
 * of the modules, keeps state local and gives the AWS provider documentation example keys,
 * skips its account and credential checks, and points every endpoint it could call at a
 * local stand-in that answers only the Amazon Linux image parameter lookup. Downloads the
 * managed Terraform (into the FFFactory cache) and the AWS provider when they are not cached.
 * Spec: docs/specs/provisioning.md §Resources and namespacing.
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
import { CLI_CONFIGURATION } from "../src/infrastructure/terraform/provisioner";
import {
  namespaceProblems,
  plannedNames,
  sharedNames,
} from "../src/infrastructure/terraform/resource-names";
import { type TerraformSession, terraformRunner } from "../src/infrastructure/terraform/runner";
import { renderUserData } from "../tests/support/user-data";

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

/** Only what Terraform needs to run and download; no AWS or Terraform settings of the caller. */
const operator = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"].flatMap(
    (name) => (process.env[name] === undefined ? [] : [[name, process.env[name] as string]]),
  ),
);
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

function override(endpoint: string): string {
  const endpoints = ENDPOINTS.map((service) => `    ${service} = "${endpoint}"`).join("\n");
  return `# Written by scripts/terraform-check.ts into its own copy; never shipped.
terraform {
  backend "local" {}
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

async function exampleVariables(factoryId: FactoryId, root: RootModule) {
  const example = JSON.parse(await readFile(join(ROOT, "examples/factory.json"), "utf8"));
  const bucket = `${factoryId}-${example.state_backend.bucket.slice(example.factory_id.length + 1)}`;
  const parsed = parseFactoryInstance({
    ...example,
    factory_id: factoryId,
    state_backend: { bucket },
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

/** The planned `aws_instance.host` resources of a plan's modules, depth first. */
function plannedHosts(module: unknown): Json[] {
  if (!isJson(module)) return [];
  const own = (Array.isArray(module.resources) ? module.resources : []).filter(
    (resource): resource is Json =>
      isJson(resource) && resource.type === "aws_instance" && resource.name === "host",
  );
  const children = Array.isArray(module.child_modules) ? module.child_modules : [];
  return [...own, ...children.flatMap(plannedHosts)];
}

/** Every host whose planned user data differs from the bootstrap tests' rendering. */
function userDataProblems(plans: readonly Plan[]): string[] {
  return plans
    .filter((plan) => plan.root === "factory")
    .flatMap(({ factoryId, variables, json }) => {
      const root = isJson(json) && isJson(json.planned_values) ? json.planned_values : {};
      const hosts = plannedHosts(root.root_module);
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
