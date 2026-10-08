import { parseArgs } from "node:util";
import { initInstance, initTarget } from "../../application/init-instance";
import type { CliContext, Command } from "../context";
import { printCompleteness } from "./completeness";

const HEADINGS = { created: "Created", updated: "Updated", unchanged: "Unchanged" } as const;

async function init(args: readonly string[], context: CliContext): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1) {
    context.err("fffactory init: expected at most one PATH");
    return 1;
  }
  const path = initTarget(context.cwd, positionals[0]);
  const result = await initInstance(
    { store: context.store, randomBytes: context.randomBytes },
    { path, release: context.release },
  );
  if (!result.ok) {
    context.err(`Refusing to change ${path}: it is not a valid factory.json.`);
    for (const issue of result.issues) context.err(`  ${issue.path}: ${issue.message}`);
    return 1;
  }
  const { outcome, filled, instance } = result;
  context.out(`${HEADINGS[outcome]} ${path}${outcome === "unchanged" ? ": nothing to fill" : ""}.`);
  // Only values init itself just wrote are echoed; values already in the file never are.
  if (filled.includes("factory_id")) context.out(`  New factory ID: ${instance.factory_id}`);
  if (filled.includes("release")) context.out(`  Release pin: ${instance.release}`);
  printCompleteness(result.completeness, context.out);
  return 0;
}

export const initCommand: Command = {
  summary: "Create or fill in a partial factory.json without contacting AWS",
  usage: [
    "Usage: fffactory init [PATH]",
    "",
    "Creates PATH, or ./.fffactory/factory.json, as a valid partial factory.json",
    "with a new permanent factory ID and this CLI's release as the pin. PATH names",
    "the document file, as --instance does. Rerunning keeps every value already",
    "set and fills only missing fields; an invalid document is refused, not",
    "overwritten. init never contacts AWS or provisions anything. It lists the",
    "fields still needed; run `fffactory validate` after filling them in.",
  ],
  run: init,
};
