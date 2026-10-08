import { parseArgs } from "node:util";
import {
  describeSource,
  INSTANCE_ENVIRONMENT_VARIABLE,
  resolveInstance,
} from "../../application/resolve-instance";
import { validateInstance } from "../../application/validate-instance";
import { SCHEMA_VERSION } from "../../domain/instance";
import type { CliContext, Command } from "../context";
import { printCompleteness } from "./completeness";

async function validate(args: readonly string[], context: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { instance: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  const resolution = await resolveInstance(context.store, {
    flag: values.instance,
    environment: context.env[INSTANCE_ENVIRONMENT_VARIABLE],
    cwd: context.cwd,
    home: context.home,
  });
  if (!resolution.found) {
    context.err(resolution.message);
    return 1;
  }
  const result = await validateInstance(context.store, resolution.path);
  const heading = `Instance: ${resolution.path} (${describeSource(resolution.source)})`;
  if (!result.valid) {
    context.err(heading);
    context.err("Invalid factory.json:");
    for (const issue of result.issues) context.err(`  ${issue.path}: ${issue.message}`);
    return 1;
  }
  context.out(heading);
  context.out(`Valid factory.json (schema version ${SCHEMA_VERSION}).`);
  printCompleteness(result.completeness, context.out);
  return 0;
}

export const validateCommand: Command = {
  summary: "Validate the selected factory.json and report what is still missing",
  usage: [
    "Usage: fffactory validate [--instance PATH]",
    "",
    "Selects the instance from --instance PATH, FFFACTORY_INSTANCE, the nearest",
    ".fffactory/factory.json upward from the current directory, or",
    "~/.fffactory/factory.json. Exits 0 when the document is valid, even if",
    "incomplete, and 1 when it is invalid or cannot be found.",
  ],
  run: validate,
};
