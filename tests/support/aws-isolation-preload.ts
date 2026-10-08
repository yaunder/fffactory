/**
 * Preloaded by `bunfig.toml` before any test file: removes the operator's AWS credentials,
 * profile and endpoints from the test process and cuts it off from IMDS and AWS, so an
 * in-process use of the real AWS SDK can read no account. See `aws-isolation.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealAwsEnvironment } from "./aws-isolation";

const directory = mkdtempSync(join(tmpdir(), "fffactory-aws-isolation-"));
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
sealAwsEnvironment(process.env, directory);
