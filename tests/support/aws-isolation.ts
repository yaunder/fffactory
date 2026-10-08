/**
 * Keeps every test away from real AWS. CI reads no AWS account, and a developer or factory
 * host may hold credentials or sit on EC2 with an instance role reachable through IMDS.
 *
 * `tests/support/aws-isolation-preload.ts` seals the test process itself, and every spawned
 * `fffactory` gets `isolatedAwsEnvironment` instead of the inherited environment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A local port nothing listens on: any request sent there is refused, never answered. */
export const CLOSED_ENDPOINT = "http://127.0.0.1:1";

/**
 * Environment for the AWS SDK with no credentials and no route to AWS: instance metadata
 * is disabled and also pointed at a closed local port, every service endpoint is a closed
 * local port, and the shared config and credentials files are empty files in `directory`.
 * Add stub credentials or endpoints on top of it; never start from `process.env`.
 */
export function isolatedAwsEnvironment(directory: string): Record<string, string> {
  const aws = join(directory, "isolated-aws");
  mkdirSync(aws, { recursive: true });
  const config = join(aws, "config");
  const credentials = join(aws, "credentials");
  writeFileSync(config, "");
  writeFileSync(credentials, "");
  return {
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_EC2_METADATA_SERVICE_ENDPOINT: CLOSED_ENDPOINT,
    AWS_ENDPOINT_URL: CLOSED_ENDPOINT,
    AWS_CONFIG_FILE: config,
    AWS_SHARED_CREDENTIALS_FILE: credentials,
  };
}

/** Replaces every `AWS_*` variable in `env` with the isolated environment. */
export function sealAwsEnvironment(env: Record<string, string | undefined>, directory: string) {
  for (const name of Object.keys(env)) if (name.startsWith("AWS_")) delete env[name];
  Object.assign(env, isolatedAwsEnvironment(directory));
}
