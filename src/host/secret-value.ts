/**
 * Reading a secret a worker is delivered by reference: `aws secretsmanager get-secret-value` as
 * root, with the instance role, in the secret's own Region (the factory Region: factory.json's
 * validation places it there). The value comes back as a `SecretMaterial`, never logged; a
 * failure is in fffactory's words only, the AWS error's name at most.
 */
import type { SecretReference } from "../domain/instance";
import { SecretMaterial } from "../domain/secrets";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";

/** The AWS CLI as root: the instance role, no pager. */
export const AWS_ENV = {
  PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
  AWS_PAGER: "",
};
const AWS_ERROR = /An error occurred \(([A-Za-z][A-Za-z0-9.]{0,63})\)/;
const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

/** Runs the AWS CLI's argv as root with `AWS_ENV`, within the caller's deadline. */
export type RunAsRoot = (argv: readonly string[]) => Promise<ProcessOutcome>;

/** The secret's `SecretString` as stored (null read as empty), or why it could not be read. */
export type SecretValue =
  | { readonly ok: true; readonly value: SecretMaterial }
  | { readonly ok: false; readonly reason: string };

/** Why reading a secret failed: the AWS error's name, an exit status, or its deadline. */
function readFailure(outcome: ProcessOutcome): string {
  switch (outcome.kind) {
    case "exited": {
      const name = AWS_ERROR.exec(outcome.stderr)?.[1];
      return `reading its secret failed (${name ?? `exit status ${outcome.exitCode}`})`;
    }
    case "timed_out":
      return "reading its secret timed out";
    case "not_found":
      return "reading its secret failed (the AWS CLI is not installed)";
    case "not_started":
      return `reading its secret failed (${ERROR_CODE.test(outcome.code) ? outcome.code : "unexpected error"})`;
  }
}

export async function readSecretValue(run: RunAsRoot, arn: SecretReference): Promise<SecretValue> {
  const region = arn.split(":")[3] ?? "";
  const outcome = await run([
    "/usr/bin/aws",
    "secretsmanager",
    "get-secret-value",
    "--region",
    region,
    "--secret-id",
    arn,
    "--query",
    "SecretString",
    "--output",
    "json",
  ]);
  if (outcome.kind !== "exited" || outcome.exitCode !== 0)
    return { ok: false, reason: readFailure(outcome) };
  let value: unknown;
  try {
    value = JSON.parse(outcome.stdout);
  } catch {
    return { ok: false, reason: "Secrets Manager's answer could not be read" };
  }
  if (value !== null && typeof value !== "string")
    return { ok: false, reason: "Secrets Manager's answer could not be read" };
  return { ok: true, value: new SecretMaterial(value ?? "") };
}
