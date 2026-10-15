/**
 * The `fffactory` commands human output asks the operator to run, written for a POSIX shell
 * with the instance and profile the running command was given (`docs/specs/cli-output.md`
 * §Next), so a command run as told acts on the same factory.json and credentials.
 */

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
