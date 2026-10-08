/**
 * A stand-in `terraform` executable, so no test downloads or runs real Terraform. It is a
 * `/bin/sh` script that runs `fake-terraform-main.ts` with the Bun running the tests, by
 * absolute path, so it needs no PATH. Each run appends what it saw to a log: arguments,
 * working directory, entire environment, and what its data directory already held. Like
 * Terraform, it stops on SIGINT, recording the signal in a second log first.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAIN = resolve(import.meta.dir, "fake-terraform-main.ts");

/** What `show -json` prints unless told otherwise. */
export const FAKE_PLAN_JSON = { format_version: "1.2", resource_changes: [] };
/** What `output -json` prints unless told otherwise. */
export const FAKE_OUTPUTS = {
  vpc_id: { sensitive: false, type: "string", value: "vpc-0123456789abcdef0" },
};

/** What one run of the stand-in saw. */
export interface Invocation {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Entries of `TF_DATA_DIR` when the run started; null when it did not exist. */
  readonly dataDirectoryBefore: readonly string[] | null;
  /** Whether the working directory held `.terraform.lock.hcl`. */
  readonly lockfile: boolean;
}

/** How the stand-in answers one subcommand, such as `plan`. */
export interface Behavior {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** Sleeps this long before answering, to outlive a timeout. */
  readonly sleepMs?: number;
}

/** A signal one run of the stand-in received. */
export interface ReceivedSignal {
  readonly subcommand: string;
  readonly signal: string;
}

export interface FakeTerraform {
  readonly executable: string;
  /** Every run so far, in order. */
  invocations(): Promise<Invocation[]>;
  /** Every signal a run received so far, in order. */
  signals(): Promise<ReceivedSignal[]>;
  /** Replaces how each subcommand answers; unlisted ones use the defaults. */
  behave(behaviors: Readonly<Record<string, Behavior>>): Promise<void>;
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The records in a JSON Lines log; none when it does not exist yet. */
async function jsonLines<T>(file: string): Promise<T[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

/** Writes a stand-in `terraform` into `directory`, which must exist. */
export async function fakeTerraform(directory: string): Promise<FakeTerraform> {
  const executable = join(directory, "terraform");
  const log = join(directory, "invocations.jsonl");
  const signals = join(directory, "signals.jsonl");
  const behaviors = join(directory, "behaviors.json");
  await writeFile(behaviors, "{}");
  const command = [process.execPath, MAIN, log, signals, behaviors].map(quoted).join(" ");
  await writeFile(executable, `#!/bin/sh\nexec ${command} "$@"\n`);
  await chmod(executable, 0o755);
  return {
    executable,
    invocations: () => jsonLines<Invocation>(log),
    signals: () => jsonLines<ReceivedSignal>(signals),
    behave: (next) => writeFile(behaviors, JSON.stringify(next)),
  };
}
