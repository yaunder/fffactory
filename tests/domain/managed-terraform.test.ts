import { describe, expect, test } from "bun:test";
import { isSha256 } from "../../src/domain/release-assets";
import { managedTerraformCheck, SUPPORTED_TERRAFORM } from "../../src/domain/managed-terraform";

const PATH = "/home/operator/.cache/fffactory/terraform/1.16.4/terraform";

describe("supported Terraform", () => {
  test("pins one exact version and the digest of its published SHA256SUMS", () => {
    expect(SUPPORTED_TERRAFORM.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(isSha256(SUPPORTED_TERRAFORM.sha256sums)).toBe(true);
  });
});

describe("managed Terraform check", () => {
  test("an installed Terraform is ready and named with its path", () => {
    expect(managedTerraformCheck(PATH, "1.16.4", "installed")).toMatchObject({
      id: "terraform",
      title: "Managed Terraform",
      status: "ready",
      summary: `Terraform 1.16.4 is installed at ${PATH}`,
      nextAction: null,
    });
  });

  test("an absent Terraform is ready: FFFactory downloads it when first needed", () => {
    const check = managedTerraformCheck(PATH, "1.16.4", "absent");
    expect(check.status).toBe("ready");
    expect(check.summary).toBe(
      `Terraform 1.16.4 is not downloaded yet; FFFactory downloads it into ${PATH} from ` +
        "releases.hashicorp.com when first needed",
    );
  });

  test("a damaged copy is ready: FFFactory replaces it when next needed", () => {
    const check = managedTerraformCheck(PATH, "1.16.4", "damaged");
    expect(check.status).toBe("ready");
    expect(check.summary).toBe(
      `${PATH} is not a usable Terraform 1.16.4; FFFactory downloads it again when next needed`,
    );
  });

  test("a platform HashiCorp builds no supported Terraform for is not ready", () => {
    const check = managedTerraformCheck(PATH, "1.16.4", "unsupported_platform");
    expect(check.status).toBe("not_ready");
    expect(check.summary).toBe("FFFactory has no Terraform 1.16.4 build for this platform");
    expect(check.nextAction).toBe(
      "Run fffactory on macOS or Linux, on x86-64 or arm64, then rerun `fffactory doctor`.",
    );
  });
});
