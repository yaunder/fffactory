/**
 * Whether each output stream is colored (`docs/specs/cli-output.md` §Color). Pure: `cli/main.ts`,
 * the one place reading the process, gives it each stream's terminal status and the
 * environment.
 */
import { ansiStyle, plainStyle, type Style } from "./style";

type Environment = Readonly<Record<string, string | undefined>>;

const set = (value: string | undefined): boolean => value !== undefined && value !== "";

/**
 * Whether one stream's human output is colored: a non-empty `NO_COLOR` or `TERM=dumb` says
 * no; then `FORCE_COLOR=0` says no and any other non-empty `FORCE_COLOR` yes, even
 * redirected; otherwise only a terminal is colored. An absent or empty variable says nothing.
 */
export function colorEnabled({
  isTTY,
  env,
}: {
  isTTY: boolean | undefined;
  env: Environment;
}): boolean {
  if (set(env.NO_COLOR) || env.TERM === "dumb") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (set(env.FORCE_COLOR)) return true;
  return isTTY === true;
}

/** The style of standard output and of standard error, each decided on its own. */
export function streamStyles({
  stdoutIsTTY,
  stderrIsTTY,
  env,
}: {
  stdoutIsTTY: boolean | undefined;
  stderrIsTTY: boolean | undefined;
  env: Environment;
}): { readonly out: Style; readonly err: Style } {
  const styleOf = (isTTY: boolean | undefined) =>
    colorEnabled({ isTTY, env }) ? ansiStyle : plainStyle;
  return { out: styleOf(stdoutIsTTY), err: styleOf(stderrIsTTY) };
}
