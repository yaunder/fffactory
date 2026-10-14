/**
 * The style roles human output is written in, plain or in color, and the line writer that
 * carries an output stream's style (`docs/specs/cli-output.md` §Style roles, §Plain output).
 * Whether a stream is colored is `color.ts`'s; `styleText` is told not to check the stream or
 * the environment itself, so that rule alone decides.
 */
import { styleText } from "node:util";

/** The statuses a glyph shows: readiness, and the changes a plan makes. */
export const STATUSES = ["ready", "attention", "error", "create", "update", "delete"] as const;
export type Status = (typeof STATUSES)[number];

/** Each status's glyph, shown in plain output and in color: color is never the only signal. */
export const GLYPHS: Readonly<Record<Status, string>> = {
  ready: "✔",
  attention: "!",
  error: "✖",
  create: "+",
  update: "~",
  delete: "-",
};

type Format = Parameters<typeof styleText>[0];
type Color = "green" | "yellow" | "red";

const COLORS: Readonly<Record<Status, Color>> = {
  ready: "green",
  attention: "yellow",
  error: "red",
  create: "green",
  update: "yellow",
  delete: "red",
};

/** The roles text takes in human output. Each returns `text` as a terminal shows it. */
export interface Style {
  /** A section's title. */
  readonly heading: (text: string) => string;
  /** A section's rule characters. */
  readonly rule: (text: string) => string;
  /** A row's label or key. */
  readonly label: (text: string) => string;
  /** Notes. */
  readonly muted: (text: string) => string;
  /** Inline code: the backticks are kept in plain output and dropped in color. */
  readonly code: (text: string) => string;
  /** A standalone line to type: `$ ` and the command. */
  readonly command: (command: string) => string;
  /** `status`'s glyph. */
  readonly glyph: (status: Status) => string;
  /** Text marked with `status`, in its color. */
  readonly status: (status: Status, text: string) => string;
  /** An outcome's statement, strong and in `status`'s color. */
  readonly verdict: (status: Status, text: string) => string;
}

/** A style whose roles paint text with `paint`, and quote inline code with `quote`. */
function style(
  paint: (format: Format, text: string) => string,
  quote: (code: string) => string,
): Style {
  return {
    heading: (text) => paint("bold", text),
    rule: (text) => paint("dim", text),
    label: (text) => paint("bold", text),
    muted: (text) => paint("dim", text),
    code: (text) => paint("cyan", quote(text)),
    command: (command) => paint("dim", "$ ") + paint(["bold", "cyan"], command),
    glyph: (status) => paint(COLORS[status], GLYPHS[status]),
    status: (status, text) => paint(COLORS[status], text),
    verdict: (status, text) => paint(["bold", COLORS[status]], text),
  };
}

/** Plain output: no escape sequence; inline code keeps its backticks. */
export const plainStyle: Style = style(
  (_format, text) => text,
  (code) => `\`${code}\``,
);

/** Color: ANSI escape sequences, whatever the stream or environment; never a background. */
export const ansiStyle: Style = style(
  (format, text) => (text === "" ? "" : styleText(format, text, { validateStream: false })),
  (code) => code,
);

/** An output stream's line writer, carrying the style of that stream. */
export interface Writer {
  (line: string): void;
  readonly style: Style;
}

/**
 * Writes each line with `write`, as given: a writer never styles a line itself, so a JSON
 * document goes out as serialized (`docs/specs/cli-output.md` §JSON).
 */
export function writer(write: (line: string) => void, style: Style): Writer {
  return Object.assign((line: string) => write(line), { style });
}
