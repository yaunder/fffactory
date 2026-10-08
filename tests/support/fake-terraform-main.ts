/**
 * The stand-in `terraform` itself; see `fake-terraform.ts`. Arguments: the log file, the
 * signals log, the behaviors file, then Terraform's own arguments. It records the run, then
 * answers like Terraform: `plan` writes the file named by `-out=`, `show -json` and
 * `output -json` print JSON. On SIGINT it records the signal and exits with status 1, as
 * Terraform does once it has stopped. It never contacts any network.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Behavior, FAKE_OUTPUTS, FAKE_PLAN_JSON } from "./fake-terraform";

const DEFAULTS: Readonly<Record<string, Behavior>> = {
  plan: { exitCode: 2 },
  show: { stdout: JSON.stringify(FAKE_PLAN_JSON) },
  output: { stdout: JSON.stringify(FAKE_OUTPUTS) },
};

const [log = "", signals = "", behaviorsFile = "", ...args] = process.argv.slice(2);
const subcommand = args[0] ?? "";
process.on("SIGINT", () => {
  appendFileSync(signals, `${JSON.stringify({ subcommand, signal: "SIGINT" })}\n`);
  process.exit(1);
});
const dataDirectory = process.env.TF_DATA_DIR;
/** Variables the `/bin/sh` wrapper sets itself; Terraform's caller never passed them. */
const SHELL_OWN = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !SHELL_OWN.has(name)),
);

appendFileSync(
  log,
  `${JSON.stringify({
    args,
    cwd: process.cwd(),
    env,
    dataDirectoryBefore:
      dataDirectory !== undefined && existsSync(dataDirectory) ? readdirSync(dataDirectory) : null,
    lockfile: existsSync(join(process.cwd(), ".terraform.lock.hcl")),
  })}\n`,
);

const configured = JSON.parse(readFileSync(behaviorsFile, "utf8")) as Record<string, Behavior>;
const behavior = configured[subcommand] ?? DEFAULTS[subcommand] ?? {};
if (behavior.sleepMs) await Bun.sleep(behavior.sleepMs);

// Like Terraform, init creates the data directory and records its working directory there.
if (subcommand === "init" && dataDirectory !== undefined) {
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(dataDirectory, "initialized"), process.cwd());
}
const out = args.find((arg) => arg.startsWith("-out="));
if (subcommand === "plan" && out) writeFileSync(out.slice("-out=".length), "saved plan\n");

if (behavior.stdout) process.stdout.write(behavior.stdout);
if (behavior.stderr) process.stderr.write(behavior.stderr);
process.exit(behavior.exitCode ?? 0);
