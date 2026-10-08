/**
 * The worker bootstrap user data, rendered as the hosts module renders it
 * (`assets/terraform/modules/hosts/main.tf`): the template with the host's namespaced hostname,
 * the factory Region, Tailscale reference and tag, and the activator as base64
 * (Terraform's `filebase64`). Spec: docs/specs/worker-bootstrap.md.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate } from "./templatefile";

export const BOOTSTRAP = join(import.meta.dir, "../../assets/terraform/bootstrap");
export const USER_DATA_TEMPLATE = join(BOOTSTRAP, "user-data.sh.tftpl");
export const ACTIVATOR = join(BOOTSTRAP, "fffactory-activate");

/** The per-host inputs; the activator comes from the file beside the template. */
export interface UserDataInputs {
  readonly hostname: string;
  readonly region: string;
  readonly tailscale_auth_key_secret_arn: string;
  readonly tailscale_tag: string;
}

/** The inputs the container tests and terraform-check render with. */
export const SAMPLE_INPUTS: UserDataInputs = {
  hostname: "fff-aaaa1111-builder-1",
  region: "us-east-1",
  tailscale_auth_key_secret_arn:
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:example/tailscale-auth-key-AbCdEf",
  tailscale_tag: "tag:software-factory",
};

export function activatorBase64(): string {
  return readFileSync(ACTIVATOR).toString("base64");
}

export function renderUserData(inputs: UserDataInputs): string {
  return renderTemplate(readFileSync(USER_DATA_TEMPLATE, "utf8"), {
    ...inputs,
    activator_base64: activatorBase64(),
  });
}
