import type { CompletenessReport } from "../../domain/instance";

/** Prints `Complete` or the fields a valid instance still needs, by path. */
export function printCompleteness(report: CompletenessReport, out: (line: string) => void): void {
  if (report.missing.length === 0) {
    out("Complete: nothing further is needed.");
    return;
  }
  out(`Incomplete: ${report.missing.length} fields still needed:`);
  for (const path of report.missing) out(`  ${path}`);
}
