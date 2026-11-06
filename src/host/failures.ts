/**
 * Failures said in fffactory's words: a system error's code at most, never a message, and a
 * command's end, never its output. Shared by the install steps and the Paseo adapter.
 */
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";

const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

/** A system error's code, such as EACCES, as fffactory may say it; anything else is unexpected. */
export function systemCode(code: unknown): string {
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unexpected error";
}

/** An error's code, such as EISDIR, in a form a document can carry. */
export function errorCode(error: unknown): string {
  return systemCode((error as NodeJS.ErrnoException | null | undefined)?.code);
}

/** How a command that did not succeed ended, as `<what> ...`; undefined when it succeeded. */
export function ended(what: string, outcome: ProcessOutcome): string | undefined {
  switch (outcome.kind) {
    case "exited":
      return outcome.exitCode === 0 ? undefined : `${what} exited with status ${outcome.exitCode}`;
    case "timed_out":
      return `${what} timed out`;
    case "not_found":
      return `${what} could not be started (ENOENT)`;
    case "not_started":
      return `${what} could not be started (${systemCode(outcome.code)})`;
  }
}
