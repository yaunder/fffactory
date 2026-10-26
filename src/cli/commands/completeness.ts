import type { CompletenessReport } from "../../domain/instance";

/**
 * Prints `Complete` or the fields a valid instance still needs, by path, each with the command
 * that fills it when one does.
 */
export function printCompleteness(report: CompletenessReport, out: (line: string) => void): void {
  const count = report.missing.length;
  if (count === 0) {
    out("Complete: nothing further is needed.");
    return;
  }
  out(`Incomplete: ${count} ${count === 1 ? "field" : "fields"} still needed:`);
  for (const path of report.missing) {
    const command = report.commands[path];
    out(command === undefined ? `  ${path}` : `  ${path}: store it with \`${command}\``);
  }
}
