import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import example from "../../../examples/factory.json";
import {
  projectBackendVariables,
  projectFactoryVariables,
} from "../../../src/application/project-terraform-inputs";
import { parseFactoryInstance } from "../../../src/domain/instance";
import { FACTORY_STATE_KEY } from "../../../src/domain/plan";
import { HOST_KEYS_OUTPUT } from "../../../src/domain/stable-host-keys";
import { objectEntries, parseHcl, stringList, stringLiteral } from "../../support/hcl";
import { checkTerraformGuardrails } from "../../support/terraform-guardrails";

const MODULES = join(import.meta.dir, "../../../assets/terraform");
const FIXTURES = join(import.meta.dir, "fixtures");

async function violations(fixture: string) {
  return (await checkTerraformGuardrails(join(FIXTURES, fixture))).violations;
}

async function variablesOf(root: string): Promise<string[]> {
  const path = join(MODULES, root, "variables.tf");
  return parseHcl(await readFile(path, "utf8"), path)
    .blocks.filter((block) => block.type === "variable")
    .map((block) => block.labels[0] as string)
    .sort();
}

describe("guardrails over the shipped Terraform modules (provisioning §Guardrails)", () => {
  test("the modules pass every guardrail", async () => {
    const report = await checkTerraformGuardrails(MODULES);
    expect(report.violations).toEqual([]);
    expect(report.resources).toContain("aws_iam_role.host");
    expect(report.resources).toContain("aws_instance.host");
    expect(report.resources).toContain("aws_s3_bucket.state");
    expect(report.resources.length).toBeGreaterThanOrEqual(17);
  });

  test("a deliberately unprefixed fixture fails on every unprefixed name", async () => {
    expect(await violations("unprefixed")).toEqual([
      { at: "main.tf:3", message: "aws_iam_role.host: name does not start with the factory ID" },
      { at: "main.tf:8", message: "aws_vpc.factory: tags.Name does not start with the factory ID" },
      {
        at: "main.tf:13",
        message: "aws_security_group.hosts: name_prefix does not start with the factory ID",
      },
      {
        at: "main.tf:13",
        message: "aws_security_group.hosts: tags.Name does not start with the factory ID",
      },
      {
        at: "main.tf:18",
        message:
          "aws_instance.host: root_block_device.tags.Name does not start with the factory ID",
      },
      { at: "main.tf:26", message: "aws_instance.host: tags overrides the factory-ID tag" },
      {
        at: "main.tf:29",
        message: "aws_s3_bucket.state: bucket does not start with the factory ID",
      },
      { at: "main.tf:33", message: "aws_subnet.public: has no tags.Name" },
      { at: "main.tf:37", message: "aws_eip.host: resource type has no naming rule" },
    ]);
  });

  test("mutating IAM statements not conditioned on the factory-ID tag fail", async () => {
    const statement = (line: number, problem: string) => ({
      at: `main.tf:${line}`,
      message: `data.aws_iam_policy_document.hosts: statement ${problem}`,
    });
    const untagged = (action: string) =>
      `allows ${action} without a StringEquals condition on the factory-ID resource tag`;
    expect(await violations("untagged-iam")).toEqual([
      statement(4, untagged("ec2:TerminateInstances")),
      statement(10, untagged("ec2:StopInstances")),
      statement(23, untagged("ec2:RebootInstances")),
      statement(35, untagged("*")),
      statement(41, "is a resource policy statement allowing more than sts:AssumeRole"),
      statement(50, "uses not_actions, which the guardrail cannot read"),
      statement(56, "has actions that are not a list of literal strings"),
      statement(62, "trusts principals other than named AWS services"),
      statement(72, "trusts principals other than named AWS services"),
      statement(82, "uses not_principals, which the guardrail cannot read"),
    ]);
  });

  test("tag-conditioned, read-only, trust and deny statements pass", async () => {
    expect(await violations("tagged-iam")).toEqual([]);
  });

  test("a policy the guardrail cannot read fails rather than being trusted", async () => {
    expect(await violations("unreadable")).toEqual([
      {
        at: "extra.tf.json:1",
        message: "Terraform JSON configuration cannot be read by the guardrail",
      },
      {
        at: "main.tf:5",
        message:
          "aws_iam_role.host: assume_role_policy is not an aws_iam_policy_document the guardrail can read",
      },
      {
        at: "main.tf:13",
        message:
          "aws_iam_role_policy.inline: policy is not an aws_iam_policy_document the guardrail can read",
      },
      {
        at: "main.tf:19",
        message:
          "data.aws_iam_policy_document.merged: source_policy_documents cannot be read by the guardrail",
      },
      {
        at: "main.tf:21",
        message:
          'data.aws_iam_policy_document.merged: dynamic "statement" cannot be read by the guardrail',
      },
      {
        at: "main.tf:28",
        message:
          "data.aws_iam_policy_document.merged: statement has an effect that is not a literal",
      },
      {
        at: "main.tf:34",
        message: "aws_iam_role_policy_attachment.admin: resource type has no naming rule",
      },
      // Flagged as a policy in its own right, so classifying the attachment's type in
      // NAMED_RESOURCES would not let an attached policy through.
      {
        at: "main.tf:36",
        message:
          "aws_iam_role_policy_attachment.admin: policy_arn is a policy the guardrail cannot read",
      },
    ]);
  });

  test("a dynamic block, in a resource or a policy document at any depth, fails", async () => {
    expect(await violations("dynamic")).toEqual([
      {
        at: "main.tf:7",
        message: 'aws_iam_role.host: dynamic "inline_policy" cannot be read by the guardrail',
      },
      {
        at: "main.tf:21",
        message:
          'data.aws_iam_policy_document.trust: dynamic "principals" cannot be read by the guardrail',
      },
      {
        at: "main.tf:40",
        message:
          'data.aws_iam_policy_document.trust: dynamic "not_principals" cannot be read by the guardrail',
      },
    ]);
  });

  test("a resource setting the factory-ID tag to anything else, at any depth, fails", async () => {
    expect(await violations("tag-override")).toEqual([
      {
        at: "main.tf:8",
        message: "aws_instance.host: root_block_device.tags overrides the factory-ID tag",
      },
      { at: "main.tf:11", message: "aws_instance.host: volume_tags overrides the factory-ID tag" },
      {
        at: "main.tf:18",
        message: "aws_instance.merged: volume_tags is not an object the guardrail can read",
      },
      // A templated key could name the factory-ID tag, so the whole object is unreadable, its
      // Name included; an escaped `$${` is a plain literal.
      { at: "main.tf:27", message: "aws_instance.templated: has no root_block_device.tags.Name" },
      {
        at: "main.tf:29",
        message: "aws_instance.templated: volume_tags is not an object the guardrail can read",
      },
      {
        at: "main.tf:32",
        message:
          "aws_instance.templated: root_block_device.tags is not an object the guardrail can read",
      },
    ]);
  });

  test("top-level blocks, data sources and provisioners outside the allowlist fail", async () => {
    expect(await violations("escape-hatches")).toEqual([
      { at: "main.tf:4", message: "import blocks are not allowed by the guardrail" },
      { at: "main.tf:9", message: "moved blocks are not allowed by the guardrail" },
      { at: "main.tf:14", message: "removed blocks are not allowed by the guardrail" },
      { at: "main.tf:18", message: "check blocks are not allowed by the guardrail" },
      {
        at: "main.tf:29",
        message: "data.aws_iam_role.admin: data source type is not allowed by the guardrail",
      },
      {
        at: "main.tf:40",
        message: "aws_instance.host: provisioner blocks are not allowed by the guardrail",
      },
      {
        at: "main.tf:43",
        message: "aws_instance.host: connection blocks are not allowed by the guardrail",
      },
      {
        at: "main.tf:48",
        message: "aws_instance.host: connection blocks are not allowed by the guardrail",
      },
    ]);
  });

  test("a symbolic link anywhere in the checked tree fails, since Terraform follows it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fffactory-guardrails-"));
    try {
      const outside = join(scratch, "outside");
      const tree = join(scratch, "modules");
      await mkdir(outside);
      await mkdir(join(tree, "child"), { recursive: true });
      await writeFile(join(outside, "evil.tf"), 'resource "aws_eip" "x" {}\n');
      await writeFile(join(tree, "child", "main.tf"), "");
      await symlink(join(outside, "evil.tf"), join(tree, "child", "evil.tf"));
      await symlink(join(outside, "evil.tf"), join(tree, "child", "evil.tf.json"));
      await symlink(outside, join(tree, "linked"));
      const link = "is a symbolic link, which the guardrail does not follow";
      expect((await checkTerraformGuardrails(tree)).violations).toEqual([
        { at: "child/evil.tf:1", message: link },
        { at: "child/evil.tf.json:1", message: link },
        { at: "linked:1", message: link },
      ]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("module calls must be local modules the check reads, passed the factory ID", async () => {
    const local = "is not a local module the guardrail checks";
    const passes = "does not pass factory_id = var.factory_id";
    expect(await violations("module-calls")).toEqual([
      { at: "main.tf:3", message: `module.registry: source ${local}` },
      { at: "main.tf:8", message: `module.git: source ${local}` },
      { at: "main.tf:13", message: `module.outside: source ${local}` },
      { at: "main.tf:18", message: `module.missing: source ${local}` },
      { at: "main.tf:23", message: `module.no_factory_id: ${passes}` },
      { at: "main.tf:27", message: `module.other_factory_id: ${passes}` },
    ]);
  });

  test("only root modules configure the provider, each tagging with the factory ID, and root variables have no default", async () => {
    expect(await violations("root")).toEqual([
      {
        at: "empty/.terraform.lock.hcl:1",
        message: "the root module does not configure the AWS provider",
      },
      { at: "main.tf:4", message: "the provider does not tag every resource with the factory ID" },
      {
        at: "main.tf:14",
        message: "variable region has a default; factory.json must be its only source",
      },
      { at: "modules/child/main.tf:1", message: "only a root module may configure a provider" },
      {
        at: "no-provider/.terraform.lock.hcl:1",
        message: "the root module does not configure the AWS provider",
      },
    ]);
  });

  test("Terraform override files fail, since Terraform merges them into other blocks", async () => {
    const override = "is a Terraform override file, which the guardrail does not merge";
    expect(await violations("overrides")).toEqual([
      { at: "iam_override.tf:1", message: override },
      { at: "iam_override.tf.json:1", message: override },
      { at: "override.tf:1", message: override },
      { at: "override.tf.json:1", message: override },
    ]);
  });

  test("only the AWS provider, and only an S3 backend in a root module, are allowed", async () => {
    expect(await violations("providers")).toEqual([
      {
        at: "main.tf:6",
        message: 'backend "local": only an s3 backend is allowed by the guardrail',
      },
      { at: "main.tf:8", message: "cloud blocks are not allowed by the guardrail" },
      {
        at: "main.tf:16",
        message: "required provider null: only hashicorp/aws is allowed by the guardrail",
      },
      {
        at: "main.tf:24",
        message: "required provider aws: only hashicorp/aws is allowed by the guardrail",
      },
      { at: "main.tf:36", message: 'provider "null": only aws is allowed by the guardrail' },
      {
        at: "modules/child/main.tf:2",
        message: 'backend "s3": only a root module may configure a backend',
      },
    ]);
  });

  test("each root module's lockfile pins the provider version its configuration requires", async () => {
    for (const root of ["factory", "backend"]) {
      const versions = await readFile(join(MODULES, root, "versions.tf"), "utf8");
      const lockfile = await readFile(join(MODULES, root, ".terraform.lock.hcl"), "utf8");
      const required = /version\s*=\s*"([0-9.]+)"/.exec(versions)?.[1];
      expect(required).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lockfile).toContain(`version     = "${required}"`);
      expect(lockfile).toContain(`constraints = "${required}"`);
    }
  });

  test("the factory root keeps its state where plan freshness reads its revision", async () => {
    const versions = parseHcl(
      await readFile(join(MODULES, "factory", "versions.tf"), "utf8"),
      "factory/versions.tf",
    );
    const terraform = versions.blocks.find((block) => block.type === "terraform");
    const backend = terraform?.body.blocks.find((block) => block.type === "backend");
    expect(backend?.labels).toEqual(["s3"]);
    const key = backend?.body.attributes.find((attribute) => attribute.name === "key");
    expect(stringLiteral(key?.expression ?? "")).toBe(FACTORY_STATE_KEY);
  });

  test("the factory root outputs the host keys its state records", async () => {
    const outputs = parseHcl(
      await readFile(join(MODULES, "factory", "outputs.tf"), "utf8"),
      "factory/outputs.tf",
    );
    expect(
      outputs.blocks.some(
        (block) => block.type === "output" && block.labels[0] === HOST_KEYS_OUTPUT,
      ),
    ).toBe(true);
  });

  test("the projection supplies exactly each root module's variables", async () => {
    const parsed = parseFactoryInstance(example);
    if (!parsed.valid) throw new Error("the example instance is invalid");
    const factory = projectFactoryVariables(parsed.instance, []);
    const backend = projectBackendVariables(parsed.instance);
    expect(factory.ok && Object.keys(factory.variables).sort()).toEqual(
      await variablesOf("factory"),
    );
    expect(backend.ok && Object.keys(backend.variables).sort()).toEqual(
      await variablesOf("backend"),
    );
  });
});

describe("the HCL reader the guardrails use", () => {
  test("reads blocks, labels, attributes and one-line blocks", () => {
    const body = parseHcl(
      'resource "aws_vpc" "x" {\n  cidr_block = "10.0.0.0/16" # comment\n  lifecycle { prevent_destroy = true }\n}\n',
      "x.tf",
    );
    expect(body.blocks[0]?.labels).toEqual(["aws_vpc", "x"]);
    expect(body.blocks[0]?.body.attributes).toEqual([
      { name: "cidr_block", expression: '"10.0.0.0/16"', line: 2 },
    ]);
    expect(body.blocks[0]?.body.blocks[0]?.body.attributes[0]?.expression).toBe("true");
  });

  test("keeps multi-line expressions, templates, heredocs and comments whole", () => {
    const source = [
      "a = {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL template syntax, deliberately
      '  Name = "${var.x}-${lookup(var.m, "k", "}")}" // not a close',
      "}",
      "b = <<-EOT",
      "  } not a close",
      "  EOT",
      '/* c = "skipped" */',
      'd = "$${literal}"',
      "",
    ].join("\n");
    const names = parseHcl(source, "x.tf").attributes.map((item) => item.name);
    expect(names).toEqual(["a", "b", "d"]);
  });

  test("throws on syntax it cannot read, naming the file and line", () => {
    expect(() => parseHcl('a = "open\n', "x.tf")).toThrow("x.tf:1: unterminated string");
    expect(() => parseHcl("block {\n", "x.tf")).toThrow("missing }");
    expect(() => parseHcl("a = )\n", "x.tf")).toThrow("unexpected )");
    expect(() => parseHcl("= 1\n", "x.tf")).toThrow("expected an attribute or block");
  });

  test("reads object constructors, string literals and literal lists", () => {
    expect(objectEntries('{ Name = "x", "a:b" = var.y }')).toEqual(
      new Map([
        ["Name", '"x"'],
        ["a:b", "var.y"],
      ]),
    );
    expect(objectEntries("merge(a, b)")).toBeUndefined();
    // Templated keys are not literals, nor is a template after an escaped backslash, an
    // ambiguous run of `$` before `{`, or an escape HCL does not have.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL template syntax, deliberately
    expect(objectEntries('{ "a:${var.k}" = "x" }')).toBeUndefined();
    expect(objectEntries('{ "a:%{if true}b%{endif}" = "x" }')).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL template syntax, deliberately
    expect(objectEntries('{ "\\\\${x}" = "x" }')).toBeUndefined();
    expect(objectEntries('{ "$$$${x}" = "x" }')).toBeUndefined();
    expect(objectEntries('{ "\\/" = "x" }')).toBeUndefined();
    expect(objectEntries('{ "$${x}" = "a", "%%{y}" = "b", "\\u0041" = "c" }')).toEqual(
      new Map([
        // biome-ignore lint/suspicious/noTemplateCurlyInString: an escaped HCL template
        ["${x}", '"a"'],
        ["%{y}", '"b"'],
        ["A", '"c"'],
      ]),
    );
    expect(stringLiteral('"plain"')).toBe("plain");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL template syntax, deliberately
    expect(stringLiteral('"${var.x}"')).toBeUndefined();
    expect(stringList('["a", "b"]')).toEqual(["a", "b"]);
    expect(stringList("var.actions")).toBeUndefined();
    expect(stringList('["a", var.b]')).toBeUndefined();
  });
});
