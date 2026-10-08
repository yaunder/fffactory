import type { CliContext } from "./context";

/**
 * Says where a failed Terraform command's diagnostics are kept: the private file's path only,
 * never its text, which may quote configuration.
 */
export function printDiagnostics(file: string | undefined, context: CliContext): void {
  if (file !== undefined) context.err(`Terraform's diagnostics: ${file}`);
}
