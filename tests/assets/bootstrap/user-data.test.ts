import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { objectEntries, parseHcl } from "../../support/hcl";
import { templateVariables } from "../../support/templatefile";
import {
  ACTIVATOR,
  BOOTSTRAP,
  renderUserData,
  SAMPLE_INPUTS,
  USER_DATA_TEMPLATE,
} from "../../support/user-data";

const TERRAFORM = join(import.meta.dir, "../../../assets/terraform");
const HOSTS_MODULE = join(TERRAFORM, "modules/hosts/main.tf");
/** EC2 refuses user data over 16 KB before base64 encoding. */
const USER_DATA_LIMIT = 16 * 1024;

/** The hosts module's `user_data`: `templatefile(<path>, <object>)`, split apart. */
function userDataCall(): { path: string; variables: ReadonlyMap<string, string> } {
  const body = parseHcl(readFileSync(HOSTS_MODULE, "utf8"), HOSTS_MODULE);
  const host = body.blocks.find(
    (block) => block.type === "resource" && block.labels.join(".") === "aws_instance.host",
  );
  const expression = host?.body.attributes.find((a) => a.name === "user_data")?.expression;
  const call = /^templatefile\(\s*"([^"]+)"\s*,\s*(\{[\s\S]*\})\s*\)$/.exec(expression ?? "");
  const variables = call?.[2] === undefined ? undefined : objectEntries(call[2]);
  if (!call?.[1] || !variables) throw new Error(`user_data is not a templatefile call`);
  return { path: call[1], variables };
}

function bashSyntaxErrors(script: string): string {
  const result = Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(script) });
  return result.exitCode === 0 ? "" : result.stderr.toString();
}

function rendered(): string {
  return renderUserData(SAMPLE_INPUTS);
}

/** The value a rendered line `readonly NAME='value'` assigns. */
function assigned(script: string, name: string): string | undefined {
  return new RegExp(`^readonly ${name}='([^']*)'$`, "m").exec(script)?.[1];
}

describe("the bootstrap user data template (worker-bootstrap §User data)", () => {
  test("the hosts module renders it with exactly the variables it uses", () => {
    const { path, variables } = userDataCall();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL template syntax, deliberately
    expect(path).toBe("${path.module}/../../bootstrap/user-data.sh.tftpl");
    const template = readFileSync(USER_DATA_TEMPLATE, "utf8");
    expect([...variables.keys()].sort()).toEqual(templateVariables(template).sort());
    expect(Object.fromEntries(variables)).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL template syntax, deliberately
      hostname: '"${var.factory_id}-${each.key}"',
      region: "var.region",
      tailscale_auth_key_secret_arn: "var.tailscale_auth_key_secret_arn",
      tailscale_tag: "var.tailscale_tag",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL template syntax, deliberately
      activator_base64: 'filebase64("${path.module}/../../bootstrap/fffactory-activate")',
    });
  });

  test("renders a bash script that parses", () => {
    const script = rendered();
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    expect(bashSyntaxErrors(script)).toBe("");
  });

  test("each host's namespaced hostname, the Region, key reference and tag are single-quoted literals", () => {
    const script = rendered();
    expect(assigned(script, "HOST_NAME")).toBe("fff-aaaa1111-builder-1");
    expect(assigned(script, "REGION")).toBe("us-east-1");
    expect(assigned(script, "TAILSCALE_AUTH_KEY_SECRET_ARN")).toBe(
      SAMPLE_INPUTS.tailscale_auth_key_secret_arn,
    );
    expect(assigned(script, "TAILSCALE_TAG")).toBe("tag:software-factory");
  });

  test("embeds the activator byte for byte", () => {
    const embedded = assigned(rendered(), "ACTIVATOR_BASE64") ?? "";
    expect(Buffer.from(embedded, "base64").equals(readFileSync(ACTIVATOR))).toBe(true);
  });

  test("fits EC2's 16 KB user data limit with the longest factory ID, host key and reference", () => {
    const longest = renderUserData({
      hostname: `${"f".repeat(20)}-${"h".repeat(32)}`,
      region: "ap-southeast-4",
      tailscale_auth_key_secret_arn: `arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:${"s".repeat(512)}`,
      tailscale_tag: `tag:${"t".repeat(64)}`,
    });
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(USER_DATA_LIMIT);
  });

  test("the activator is executable in the checkout, so the bundle ships it 0755", () => {
    expect(statSync(ACTIVATOR).mode & 0o111).toBe(0o111);
    expect(readFileSync(ACTIVATOR, "utf8").startsWith("#!/bin/bash\n")).toBe(true);
    expect(bashSyntaxErrors(readFileSync(ACTIVATOR, "utf8"))).toBe("");
  });
});

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith(".") ? [] : filesUnder(path);
    return entry.isFile() && entry.name !== "CLAUDE.md" ? [path] : [];
  });
}

describe("bootstrap without SSM (worker-bootstrap §No SSM)", () => {
  test("the bootstrap files never mention SSM", () => {
    for (const file of filesUnder(BOOTSTRAP))
      expect({
        file: relative(BOOTSTRAP, file),
        ssm: /ssm/i.test(readFileSync(file, "utf8")),
      }).toEqual({ file: relative(BOOTSTRAP, file), ssm: false });
  });

  test("the only SSM the Terraform modules use is the public Amazon Linux image parameter", () => {
    const mentions = filesUnder(TERRAFORM)
      .filter((file) => file.endsWith(".tf"))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          // Comments configure nothing; every other line counts.
          .filter((line) => /ssm|ec2messages/i.test(line) && !/^\s*(#|\/\/)/.test(line))
          .map((line) => `${relative(TERRAFORM, file)}: ${line.trim().replace(/\s+/g, " ")}`),
      );
    expect(mentions).toEqual([
      'factory/main.tf: data "aws_ssm_parameter" "al2023" {',
      "factory/main.tf: ami_id = data.aws_ssm_parameter.al2023.insecure_value",
    ]);
  });
});
