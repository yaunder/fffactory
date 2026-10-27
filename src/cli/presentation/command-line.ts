/**
 * The `fffactory` commands human output asks the operator to run, written for a POSIX shell
 * with the instance and profile the running command was given (`docs/specs/cli-output.md`
 * §Next), so a command run as told acts on the same factory.json and credentials.
 */
import type { Inline, Span } from "./blocks";

/** The instance and profile a command was given explicitly, if any. */
export interface Selection {
  readonly instance?: string | undefined;
  readonly profile?: string | undefined;
}

/** A word for a POSIX shell: as is when it is plainly safe, else single-quoted. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** `fffactory WORDS`, then the `--instance` and `--profile` of `selection`, shell-quoted. */
export function fffactoryCommand(words: readonly string[], selection: Selection = {}): string {
  const all = ["fffactory", ...words];
  if (selection.instance !== undefined) all.push("--instance", selection.instance);
  if (selection.profile !== undefined) all.push("--profile", selection.profile);
  return all.map(shellWord).join(" ");
}

/**
 * fffactory's own words with every `fffactory` command they name in backticks as inline code,
 * repeating the instance and profile in `selection`; any other backticks stay inline code.
 */
export function withCommands(text: string, selection: Selection): Inline {
  const spans: Span[] = [];
  let from = 0;
  for (const match of text.matchAll(/`fffactory ([^`]+)`/g)) {
    spans.push(text.slice(from, match.index));
    const words = (match[1] as string).split(" ");
    spans.push({ text: fffactoryCommand(words, selection), tone: "code" });
    from = match.index + match[0].length;
  }
  spans.push(text.slice(from));
  return spans.filter((span) => span !== "");
}
