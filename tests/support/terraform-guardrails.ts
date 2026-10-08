/**
 * The D5 guardrails, checked statically over a tree of Terraform modules without running
 * Terraform (docs/specs/provisioning.md §Guardrails):
 *
 * - every resource type is classified in `NAMED_RESOURCES`, and each of its names is a
 *   template starting with `${var.factory_id}-`;
 * - no resource or policy document holds a `dynamic` block, whose content the check cannot
 *   read, at any depth;
 * - every IAM policy is an `aws_iam_policy_document` the check can read, every allowed
 *   statement that can mutate anything is conditioned on the factory-ID resource tag, and a
 *   trust statement trusts only named AWS services;
 * - every root module, and only a root module, configures the AWS provider, always tagging
 *   every resource with the factory ID, and no resource overrides that tag at any depth;
 * - every module call is a local module in the checked tree, passed `var.factory_id`;
 * - root module variables have no defaults: factory.json is their only source;
 * - only allowlisted top-level blocks and data source types appear, and no resource holds a
 *   `provisioner` or `connection` block at any depth;
 * - the only provider is `hashicorp/aws`, the only backend `s3` in a root module, and there
 *   is no `cloud` block.
 *
 * Root modules are the directories holding a provider lockfile. Anything the check cannot
 * read, Terraform JSON configuration, override files, symbolic links and templated object
 * keys included, is a violation, so it fails closed.
 *
 * TODO(re-evaluate when a reference attribute such as `iam_instance_profile`, `role`,
 * `route_table_id`, `subnet_id` or `bucket` traces back to a literal, a root variable or a
 * data source rather than a resource the modules create, e.g. factory.json naming an
 * existing VPC or instance profile): allowed resources can point at resources the factory
 * does not own by ID or name. Add a plan-JSON rule that each such attribute is unknown at
 * plan time (so it comes from a resource being created) or carries the factory ID.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { NAMED_RESOURCES } from "../../src/infrastructure/terraform/resource-names";
import {
  type HclAttribute,
  type HclBlock,
  type HclBody,
  objectEntries,
  parseHcl,
  stringList,
  stringLiteral,
} from "./hcl";

export interface Violation {
  /** `<file>:<line>`, relative to the checked directory. */
  readonly at: string;
  readonly message: string;
}

interface ParsedFile {
  readonly path: string;
  readonly body: HclBody;
}

interface Module {
  /** Relative to the checked directory, which is `.`. */
  readonly directory: string;
  readonly root: boolean;
  readonly files: readonly ParsedFile[];
  /** Entries the check cannot read: JSON configuration, override files and symbolic links. */
  readonly unreadable: readonly { readonly path: string; readonly message: string }[];
}

const LOCKFILE = ".terraform.lock.hcl";
const NAME_TEMPLATE = /^"\$\{var\.factory_id\}-[^"]+"$/;
const TAG_CONDITIONS = new Set([
  "aws:ResourceTag/fffactory:factory-id",
  "ec2:ResourceTag/fffactory:factory-id",
]);
/**
 * Actions that only read: Get, List, Describe and BatchGet, possibly wildcarded after.
 *
 * TODO(re-evaluate when a shipped policy document allows a Get action other than
 * `secretsmanager:GetSecretValue`, the only one today): `Get` is not always a pure read (`sts:GetFederationToken` and `sts:GetSessionToken` mint
 * credentials). Replace the prefix rule with an explicit list of read actions.
 */
const READ_ONLY_ACTION = /^[a-z0-9-]+:(Get|List|Describe|BatchGet)[A-Za-z0-9*]*$/;
const POLICY_REFERENCE = /^data\.aws_iam_policy_document\.[A-Za-z0-9_-]+\.json$/;
const POLICY_ATTRIBUTES = new Set(["policy", "assume_role_policy"]);
/** Policies held elsewhere, by ARN or inline block, which the check cannot read. */
const OPAQUE_POLICIES = ["inline_policy", "managed_policy_arns", "policy_arn", "policy_arns"];
const TAG_ATTRIBUTES = new Set(["tags", "tags_all", "volume_tags"]);
const FACTORY_ID_TAG = "fffactory:factory-id";
const LOCAL_SOURCE = /^\.\.?\//;
/** Top-level blocks the shipped modules use; `import`, `moved`, `removed` and `check` fail. */
const TOP_LEVEL_BLOCKS = new Set([
  "terraform",
  "provider",
  "variable",
  "output",
  "locals",
  "module",
  "resource",
  "data",
]);
/** Data sources the shipped modules use; any other could read what the factory does not own. */
const DATA_SOURCES = new Set(["aws_iam_policy_document", "aws_ssm_parameter"]);
/** Blocks that run commands, outside any plan the check can read, at any depth. */
const COMMAND_BLOCKS = new Set(["provisioner", "connection"]);
const SYMLINK = "is a symbolic link, which the guardrail does not follow";
const JSON_CONFIGURATION = "Terraform JSON configuration cannot be read by the guardrail";
/** Terraform merges these into the blocks they name, after reading every other file. */
const OVERRIDE_FILE = /^(.*_)?override\.tf(\.json)?$/;
const OVERRIDE = "is a Terraform override file, which the guardrail does not merge";
const AWS_SOURCE = '"hashicorp/aws"';

/** Why the check cannot read a directory entry, or undefined when it can. */
function unreadableEntry(entry: Dirent): string | undefined {
  if (entry.isSymbolicLink()) return SYMLINK;
  if (!entry.isFile()) return undefined;
  if (OVERRIDE_FILE.test(entry.name)) return OVERRIDE;
  return entry.name.endsWith(".tf.json") ? JSON_CONFIGURATION : undefined;
}

async function modulesIn(directory: string, top = directory): Promise<Module[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  // Terraform follows symbolic links, so the check refuses them rather than skipping them.
  const unreadable = entries.flatMap((entry) => {
    const message = unreadableEntry(entry);
    return message ? [{ path: relative(top, join(directory, entry.name)), message }] : [];
  });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tf"))
      .filter((entry) => unreadableEntry(entry) === undefined)
      .map(async (entry) => {
        const path = join(directory, entry.name);
        return { path: relative(top, path), body: parseHcl(await readFile(path, "utf8"), path) };
      }),
  );
  const root = entries.some((entry) => entry.isFile() && entry.name === LOCKFILE);
  const children = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => modulesIn(join(directory, entry.name), top)),
  );
  const own =
    root || files.length + unreadable.length > 0
      ? [{ directory: posix.join(".", relative(top, directory)), root, files, unreadable }]
      : [];
  return [...own, ...children.flat()];
}

class Findings {
  private readonly found: { path: string; line: number; message: string }[] = [];

  add(file: ParsedFile | string, line: number, message: string): void {
    this.found.push({ path: typeof file === "string" ? file : file.path, line, message });
  }

  /** By file, then line; findings on one line keep the order they were found in. */
  get violations(): Violation[] {
    return [...this.found]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
      .map(({ path, line, message }) => ({ at: `${path}:${line}`, message }));
  }
}

const attribute = (body: HclBody, name: string): HclAttribute | undefined =>
  body.attributes.find((item) => item.name === name);

const blocksOf = (body: HclBody, type: string): HclBlock[] =>
  body.blocks.filter((block) => block.type === type);

function address(block: HclBlock): string {
  return block.labels.join(".");
}

/** The expressions at a dotted name path: attributes, object keys and nested blocks. */
function expressionsAt(body: HclBody, segments: readonly string[]): (string | undefined)[] {
  const [first, ...rest] = segments;
  if (first === undefined) return [];
  const found = attribute(body, first);
  if (found !== undefined) {
    if (rest.length === 0) return [found.expression];
    const entries = objectEntries(found.expression);
    return rest.length === 1 ? [entries?.get(rest[0] as string)] : [undefined];
  }
  const nested = blocksOf(body, first);
  if (nested.length === 0) return [undefined];
  return nested.flatMap((block) => expressionsAt(block.body, rest));
}

/** Why a name expression breaks the naming guardrail, or undefined when it does not. */
function nameProblem(path: string, expression: string | undefined): string | undefined {
  if (expression === undefined) return `has no ${path}`;
  return NAME_TEMPLATE.test(expression) ? undefined : `${path} does not start with the factory ID`;
}

function checkNames(file: ParsedFile, resource: HclBlock, findings: Findings): void {
  const [type] = resource.labels;
  if (type === undefined || !Object.hasOwn(NAMED_RESOURCES, type)) {
    findings.add(file, resource.line, `${address(resource)}: resource type has no naming rule`);
    return;
  }
  const problems = (NAMED_RESOURCES[type] as readonly string[]).flatMap((path) =>
    expressionsAt(resource.body, path.split(".")).map((expression) =>
      nameProblem(path, expression),
    ),
  );
  for (const problem of problems)
    if (problem) findings.add(file, resource.line, `${address(resource)}: ${problem}`);
}

function checkPolicyAttributes(file: ParsedFile, resource: HclBlock, findings: Findings): void {
  for (const item of resource.body.attributes) {
    if (POLICY_ATTRIBUTES.has(item.name) && !POLICY_REFERENCE.test(item.expression))
      findings.add(
        file,
        item.line,
        `${address(resource)}: ${item.name} is not an aws_iam_policy_document the guardrail can read`,
      );
  }
  for (const name of OPAQUE_POLICIES) {
    const line = attribute(resource.body, name)?.line ?? blocksOf(resource.body, name)[0]?.line;
    if (line !== undefined)
      findings.add(
        file,
        line,
        `${address(resource)}: ${name} is a policy the guardrail cannot read`,
      );
  }
}

/** Every `dynamic` block in a body and its nested blocks; one inside another is not repeated. */
function dynamicBlocks(body: HclBody): HclBlock[] {
  return body.blocks.flatMap((block) =>
    block.type === "dynamic" ? [block] : dynamicBlocks(block.body),
  );
}

function checkDynamicBlocks(file: ParsedFile, name: string, block: HclBlock, findings: Findings) {
  for (const dynamic of dynamicBlocks(block.body))
    findings.add(
      file,
      dynamic.line,
      `${name}: dynamic "${address(dynamic)}" cannot be read by the guardrail`,
    );
}

/** Every tag attribute in a body and its nested blocks, by dotted path. */
function tagAttributes(body: HclBody, prefix = ""): { path: string; item: HclAttribute }[] {
  return [
    ...body.attributes
      .filter((item) => TAG_ATTRIBUTES.has(item.name))
      .map((item) => ({ path: `${prefix}${item.name}`, item })),
    ...body.blocks.flatMap((block) => tagAttributes(block.body, `${prefix}${block.type}.`)),
  ];
}

function checkTagOverride(file: ParsedFile, resource: HclBlock, findings: Findings): void {
  for (const { path, item } of tagAttributes(resource.body)) {
    const entries = objectEntries(item.expression);
    const value = entries?.get(FACTORY_ID_TAG);
    if (entries === undefined)
      findings.add(
        file,
        item.line,
        `${address(resource)}: ${path} is not an object the guardrail can read`,
      );
    else if (value !== undefined && value !== "var.factory_id")
      findings.add(file, item.line, `${address(resource)}: ${path} overrides the factory-ID tag`);
  }
}

function checkModuleCall(
  module: Module,
  file: ParsedFile,
  call: HclBlock,
  checked: ReadonlySet<string>,
  findings: Findings,
): void {
  const name = `module.${address(call)}`;
  const source = stringLiteral(attribute(call.body, "source")?.expression ?? "");
  const target =
    source !== undefined && LOCAL_SOURCE.test(source)
      ? posix.join(module.directory, source).replace(/(.)\/+$/, "$1")
      : undefined;
  if (target === undefined || !checked.has(target))
    findings.add(file, call.line, `${name}: source is not a local module the guardrail checks`);
  if (attribute(call.body, "factory_id")?.expression !== "var.factory_id")
    findings.add(file, call.line, `${name}: does not pass factory_id = var.factory_id`);
}

function isFactoryTagCondition(condition: HclBlock): boolean {
  const test = stringLiteral(attribute(condition.body, "test")?.expression ?? "");
  const variable = stringLiteral(attribute(condition.body, "variable")?.expression ?? "");
  const values = attribute(condition.body, "values")?.expression.replace(/\s/g, "");
  return (
    test === "StringEquals" &&
    variable !== undefined &&
    TAG_CONDITIONS.has(variable) &&
    values === "[var.factory_id]"
  );
}

/** Whether a `principals` block names only AWS services, with no wildcard. */
function isNamedService(principals: HclBlock): boolean {
  const type = stringLiteral(attribute(principals.body, "type")?.expression ?? "");
  const identifiers = stringList(attribute(principals.body, "identifiers")?.expression ?? "");
  return (
    type === "Service" &&
    identifiers !== undefined &&
    identifiers.length > 0 &&
    identifiers.every((identifier) => !identifier.includes("*"))
  );
}

/** Why an allowed statement with principals breaks a guardrail, or undefined. */
function trustProblem(actions: readonly string[], principals: HclBlock[]): string | undefined {
  if (!actions.every((action) => action === "sts:AssumeRole"))
    return "is a resource policy statement allowing more than sts:AssumeRole";
  return principals.every(isNamedService)
    ? undefined
    : "trusts principals other than named AWS services";
}

/** Why an allowed statement breaks a guardrail, or undefined when it does not. */
function statementProblem(statement: HclBlock): string | undefined {
  for (const name of ["not_actions", "not_resources", "not_principals"])
    if (attribute(statement.body, name) || blocksOf(statement.body, name).length > 0)
      return `uses ${name}, which the guardrail cannot read`;
  const actions = stringList(attribute(statement.body, "actions")?.expression ?? "");
  if (actions === undefined) return "has actions that are not a list of literal strings";
  const principals = blocksOf(statement.body, "principals");
  if (principals.length > 0) return trustProblem(actions, principals);
  const mutating = actions.filter((action) => !READ_ONLY_ACTION.test(action));
  if (mutating.length === 0 || blocksOf(statement.body, "condition").some(isFactoryTagCondition))
    return undefined;
  return `allows ${mutating.join(", ")} without a StringEquals condition on the factory-ID resource tag`;
}

/** Why a policy document statement breaks a guardrail, or undefined when it does not. */
function effectProblem(statement: HclBlock): string | undefined {
  const effect = attribute(statement.body, "effect")?.expression ?? '"Allow"';
  if (effect === '"Deny"') return undefined;
  return effect === '"Allow"' ? statementProblem(statement) : "has an effect that is not a literal";
}

function checkPolicyDocument(file: ParsedFile, document: HclBlock, findings: Findings): void {
  const name = `data.${address(document)}`;
  for (const item of ["source_policy_documents", "override_policy_documents"]) {
    const found = attribute(document.body, item);
    if (found) findings.add(file, found.line, `${name}: ${item} cannot be read by the guardrail`);
  }
  checkDynamicBlocks(file, name, document, findings);
  for (const statement of blocksOf(document.body, "statement")) {
    const problem = effectProblem(statement);
    if (problem) findings.add(file, statement.line, `${name}: statement ${problem}`);
  }
}

function checkProvider(module: Module, file: ParsedFile, provider: HclBlock, findings: Findings) {
  if (provider.labels[0] !== "aws") {
    const name = `provider "${address(provider)}"`;
    findings.add(file, provider.line, `${name}: only aws is allowed by the guardrail`);
    return;
  }
  if (!module.root) {
    findings.add(file, provider.line, "only a root module may configure a provider");
    return;
  }
  const tags = blocksOf(provider.body, "default_tags").map((block) =>
    objectEntries(attribute(block.body, "tags")?.expression ?? "")?.get("fffactory:factory-id"),
  );
  if (!tags.includes("var.factory_id"))
    findings.add(
      file,
      provider.line,
      "the provider does not tag every resource with the factory ID",
    );
}

/** Why a block in a `terraform` block breaks a guardrail, or undefined when it does not. */
function settingsProblem(module: Module, block: HclBlock): string | undefined {
  if (block.type === "cloud") return "cloud blocks are not allowed by the guardrail";
  if (block.type !== "backend") return undefined;
  const name = `backend "${address(block)}"`;
  if (block.labels[0] !== "s3") return `${name}: only an s3 backend is allowed by the guardrail`;
  return module.root ? undefined : `${name}: only a root module may configure a backend`;
}

/** Only `hashicorp/aws`, and only an S3 backend in a root module; no HCP Terraform. */
function checkSettings(module: Module, file: ParsedFile, settings: HclBlock, findings: Findings) {
  for (const block of settings.body.blocks) {
    const problem = settingsProblem(module, block);
    if (problem) findings.add(file, block.line, problem);
  }
  const required = blocksOf(settings.body, "required_providers").flatMap(
    (block) => block.body.attributes,
  );
  for (const item of required)
    if (item.name !== "aws" || objectEntries(item.expression)?.get("source") !== AWS_SOURCE)
      findings.add(
        file,
        item.line,
        `required provider ${item.name}: only hashicorp/aws is allowed by the guardrail`,
      );
}

const configuresAws = (module: Module): boolean =>
  module.files.some((file) =>
    blocksOf(file.body, "provider").some((provider) => provider.labels[0] === "aws"),
  );

function checkVariables(module: Module, file: ParsedFile, findings: Findings): void {
  if (!module.root) return;
  for (const variable of blocksOf(file.body, "variable")) {
    const found = attribute(variable.body, "default");
    if (found)
      findings.add(
        file,
        found.line,
        `variable ${address(variable)} has a default; factory.json must be its only source`,
      );
  }
}

/** Every block in a body and its nested blocks whose type runs commands. */
function commandBlocks(body: HclBody): HclBlock[] {
  return body.blocks.flatMap((block) => [
    ...(COMMAND_BLOCKS.has(block.type) ? [block] : []),
    ...commandBlocks(block.body),
  ]);
}

function checkCommandBlocks(file: ParsedFile, resource: HclBlock, findings: Findings): void {
  for (const block of commandBlocks(resource.body))
    findings.add(
      file,
      block.line,
      `${address(resource)}: ${block.type} blocks are not allowed by the guardrail`,
    );
}

function checkData(file: ParsedFile, data: HclBlock, findings: Findings): void {
  const [type] = data.labels;
  if (type === "aws_iam_policy_document") checkPolicyDocument(file, data, findings);
  else if (type === undefined || !DATA_SOURCES.has(type))
    findings.add(
      file,
      data.line,
      `data.${address(data)}: data source type is not allowed by the guardrail`,
    );
}

function checkFile(
  module: Module,
  file: ParsedFile,
  checked: ReadonlySet<string>,
  findings: Findings,
): void {
  for (const block of file.body.blocks)
    if (!TOP_LEVEL_BLOCKS.has(block.type))
      findings.add(file, block.line, `${block.type} blocks are not allowed by the guardrail`);
  for (const resource of blocksOf(file.body, "resource")) {
    checkNames(file, resource, findings);
    checkPolicyAttributes(file, resource, findings);
    checkTagOverride(file, resource, findings);
    checkDynamicBlocks(file, address(resource), resource, findings);
    checkCommandBlocks(file, resource, findings);
  }
  for (const data of blocksOf(file.body, "data")) checkData(file, data, findings);
  for (const settings of blocksOf(file.body, "terraform"))
    checkSettings(module, file, settings, findings);
  for (const provider of blocksOf(file.body, "provider"))
    checkProvider(module, file, provider, findings);
  for (const call of blocksOf(file.body, "module"))
    checkModuleCall(module, file, call, checked, findings);
  checkVariables(module, file, findings);
}

export interface GuardrailReport {
  readonly violations: readonly Violation[];
  /** Every resource checked, as `<type>.<name>`, so a test can see the check was not vacuous. */
  readonly resources: readonly string[];
}

/** Checks every module under `directory` against the guardrails. */
export async function checkTerraformGuardrails(directory: string): Promise<GuardrailReport> {
  const findings = new Findings();
  const modules = await modulesIn(directory);
  const checked = new Set(modules.map((module) => module.directory));
  for (const module of modules) {
    for (const { path, message } of module.unreadable) findings.add(path, 1, message);
    for (const file of module.files) checkFile(module, file, checked, findings);
    if (module.root && !configuresAws(module))
      findings.add(
        posix.join(module.directory, LOCKFILE),
        1,
        "the root module does not configure the AWS provider",
      );
  }
  const resources = modules.flatMap((module) =>
    module.files.flatMap((file) => blocksOf(file.body, "resource").map(address)),
  );
  return { violations: findings.violations, resources };
}
