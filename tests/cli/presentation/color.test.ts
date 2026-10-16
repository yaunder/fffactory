import { describe, expect, test } from "bun:test";
import { colorEnabled, streamStyles } from "../../../src/cli/presentation/color";
import { ansiStyle, plainStyle } from "../../../src/cli/presentation/style";

type Env = Record<string, string | undefined>;

const TTY = [true, false, undefined] as const;
const NO_COLOR = [undefined, "", "1"] as const;
const FORCE_COLOR = [undefined, "", "0", "1", "3", "false"] as const;
const TERM = [undefined, "", "xterm-256color", "dumb"] as const;

/** Every combination of a stream's terminal status and the four variables' values above. */
function matrix(): { isTTY: boolean | undefined; env: Env }[] {
  return TTY.flatMap((isTTY) =>
    NO_COLOR.flatMap((noColor) =>
      FORCE_COLOR.flatMap((forceColor) =>
        TERM.map((term) => ({
          isTTY,
          env: { NO_COLOR: noColor, FORCE_COLOR: forceColor, TERM: term },
        })),
      ),
    ),
  );
}

const disabledByNoColorOrDumb = ({ env }: { env: Env }) =>
  (env.NO_COLOR ?? "") !== "" || env.TERM === "dumb";

describe("each stream's color (cli output §Color)", () => {
  const cases = matrix();

  test("a non-empty NO_COLOR, or TERM=dumb, makes output plain, whatever else is set", () => {
    const disabled = cases.filter(disabledByNoColorOrDumb);
    expect(disabled.length).toBeGreaterThan(0);
    for (const input of disabled)
      expect({ input, color: colorEnabled(input) }).toEqual({ input, color: false });
  });

  test("otherwise FORCE_COLOR=0 makes output plain, even on a terminal", () => {
    const zero = cases.filter((c) => !disabledByNoColorOrDumb(c) && c.env.FORCE_COLOR === "0");
    expect(zero.some((c) => c.isTTY === true)).toBe(true);
    for (const input of zero)
      expect({ input, color: colorEnabled(input) }).toEqual({ input, color: false });
  });

  test("otherwise any other non-empty FORCE_COLOR colors output, even redirected", () => {
    const forced = cases.filter(
      (c) =>
        !disabledByNoColorOrDumb(c) &&
        (c.env.FORCE_COLOR ?? "") !== "" &&
        c.env.FORCE_COLOR !== "0",
    );
    expect(forced.some((c) => c.isTTY !== true)).toBe(true);
    for (const input of forced)
      expect({ input, color: colorEnabled(input) }).toEqual({ input, color: true });
  });

  test("otherwise output is colored only on a terminal; absent or empty variables change nothing", () => {
    const unforced = cases.filter(
      (c) => !disabledByNoColorOrDumb(c) && (c.env.FORCE_COLOR ?? "") === "",
    );
    for (const input of unforced)
      expect({ input, color: colorEnabled(input) }).toEqual({ input, color: input.isTTY === true });
  });

  test("conflicting variables resolve by precedence", () => {
    expect(colorEnabled({ isTTY: true, env: { NO_COLOR: "1", FORCE_COLOR: "1" } })).toBe(false);
    expect(colorEnabled({ isTTY: false, env: { TERM: "dumb", FORCE_COLOR: "3" } })).toBe(false);
    expect(colorEnabled({ isTTY: true, env: { NO_COLOR: "", FORCE_COLOR: "0" } })).toBe(false);
    expect(colorEnabled({ isTTY: false, env: { NO_COLOR: "", FORCE_COLOR: "1" } })).toBe(true);
    expect(colorEnabled({ isTTY: true, env: { FORCE_COLOR: "", TERM: "xterm" } })).toBe(true);
    expect(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "", TERM: "" } })).toBe(false);
  });

  test("an empty environment colors a terminal and leaves redirected output plain", () => {
    expect(colorEnabled({ isTTY: true, env: {} })).toBe(true);
    expect(colorEnabled({ isTTY: false, env: {} })).toBe(false);
    expect(colorEnabled({ isTTY: undefined, env: {} })).toBe(false);
  });
});

describe("the styles of standard output and error (cli output §Color)", () => {
  test("redirected standard output is plain while standard error on a terminal is colored", () => {
    const styles = streamStyles({ stdoutIsTTY: false, stderrIsTTY: true, env: {} });
    expect(styles.out).toBe(plainStyle);
    expect(styles.err).toBe(ansiStyle);
  });

  test("standard output on a terminal is colored while redirected standard error is plain", () => {
    const styles = streamStyles({ stdoutIsTTY: true, stderrIsTTY: undefined, env: {} });
    expect(styles.out).toBe(ansiStyle);
    expect(styles.err).toBe(plainStyle);
  });

  test("forced color colors both redirected streams; NO_COLOR makes both terminals plain", () => {
    const forced = streamStyles({
      stdoutIsTTY: false,
      stderrIsTTY: false,
      env: { FORCE_COLOR: "1" },
    });
    expect(forced.out).toBe(ansiStyle);
    expect(forced.err).toBe(ansiStyle);
    const none = streamStyles({ stdoutIsTTY: true, stderrIsTTY: true, env: { NO_COLOR: "1" } });
    expect(none.out).toBe(plainStyle);
    expect(none.err).toBe(plainStyle);
  });
});
