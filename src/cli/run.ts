import { diagnosticsFileOf } from "../application/provisioner";
import { applyCommand } from "./commands/apply";
import { assetsCommand } from "./commands/assets";
import { doctorCommand } from "./commands/doctor";
import { hostCommand } from "./commands/host";
import { initCommand } from "./commands/init";
import { lockCommand } from "./commands/lock";
import { planCommand } from "./commands/plan";
import { secretCommand } from "./commands/secret";
import { statusCommand } from "./commands/status";
import { upgradeCommand } from "./commands/upgrade";
import { validateCommand } from "./commands/validate";
import type { CliContext, Command } from "./context";
import { printDiagnostics } from "./diagnostics";

export type { CliContext } from "./context";

const COMMANDS: Readonly<Record<string, Command>> = {
  init: initCommand,
  validate: validateCommand,
  doctor: doctorCommand,
  plan: planCommand,
  apply: applyCommand,
  status: statusCommand,
  upgrade: upgradeCommand,
  assets: assetsCommand,
  secret: secretCommand,
  lock: lockCommand,
  host: hostCommand,
};

const HELP = new Set(["--help", "-h", "help"]);
const VERSION = "--version";

function usage(): string[] {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return [
    "Usage: fffactory <command> [options]",
    "",
    "       fffactory --version",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(
      ([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`,
    ),
    "",
    "Run `fffactory <command> --help` for command options.",
  ];
}

function print(lines: readonly string[], write: (line: string) => void): void {
  for (const line of lines) write(line);
}

async function dispatch(argv: readonly string[], context: CliContext): Promise<number> {
  const [name = "", ...args] = argv;
  if (HELP.has(name)) {
    print(usage(), context.out);
    return 0;
  }
  if (name === VERSION) {
    if (args.length > 0) {
      context.err(`fffactory: ${VERSION} takes no arguments`);
      return 1;
    }
    context.out(context.release);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    if (name) context.err(`fffactory: unknown command "${name}"`);
    print(usage(), context.err);
    return 1;
  }
  if (args.some((arg) => HELP.has(arg))) {
    print(command.usage, context.out);
    return 0;
  }
  return command.run(args, context);
}

/**
 * Whether `fffactory` waits, once interrupted, for this invocation's command to report what the
 * interrupt left (`Command.waitsOnInterrupt`). A subcommand, such as `host apply`, is judged by
 * its command, so it never waits unless that command does.
 */
export function waitsOnInterrupt(argv: readonly string[]): boolean {
  const [name = ""] = argv;
  return Object.hasOwn(COMMANDS, name) && COMMANDS[name]?.waitsOnInterrupt === true;
}

/**
 * Runs one CLI invocation and returns its exit code. Unexpected errors exit 1, with the
 * path of the diagnostics a failed Terraform command kept.
 */
export async function run(argv: readonly string[], context: CliContext): Promise<number> {
  try {
    return await dispatch(argv, context);
  } catch (error) {
    context.err(`fffactory: ${error instanceof Error ? error.message : String(error)}`);
    printDiagnostics(diagnosticsFileOf(error), context);
    return 1;
  }
}
