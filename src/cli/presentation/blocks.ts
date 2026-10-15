/**
 * The layout blocks human output is built from, and `render`, which lays them out as lines in a
 * stream's style (`docs/specs/cli-output.md` §Layout blocks). Widths are terminal columns,
 * measured with `Bun.stringWidth`, which skips escape sequences, so columns align plain and in
 * color.
 */
import { GLYPHS, type Status, type Style } from "./style";

/** The role a marked span of text takes: a style role, or a status's color. */
export type Tone = "heading" | "label" | "muted" | "code" | Status;
/**
 * Text, in which a matched pair of backticks marks inline code; text marked with a tone; or,
 * without a tone, text shown verbatim in the role around it, never read for inline code.
 */
export type Span = string | { readonly text: string; readonly tone?: Tone };
/** A line's text: one span, or several in a row. */
export type Inline = string | readonly Span[];

/**
 * Data, such as a configuration value or a lock's holder, shown verbatim: its backticks are
 * never inline code, which marks only fffactory's own words (`docs/specs/cli-output.md`
 * §Layout blocks).
 */
export const verbatim = (text: string): Span => ({ text });

/** A label and its value; a status puts its glyph before the label; details go under it. */
export interface Row {
  readonly status?: Status;
  readonly label: Inline;
  readonly value?: Inline;
  readonly details?: readonly Block[];
}

export type Block =
  /** Lines printed as they are. */
  | { readonly kind: "text"; readonly lines: readonly Inline[] }
  /** A rule with the title, then the blocks indented. */
  | { readonly kind: "section"; readonly title: Inline; readonly blocks: readonly Block[] }
  /**
   * Aligned rows; `labelWidth` pads labels to at least that many columns, so rows rendered one
   * at a time, such as progress, align.
   */
  | { readonly kind: "rows"; readonly rows: readonly Row[]; readonly labelWidth?: number }
  /** The outcome: its status's glyph and text, then any details. */
  | {
      readonly kind: "verdict";
      readonly status: Status;
      readonly text: Inline;
      readonly details?: readonly Block[];
    };

/** Numbered in a Next block: a title, then the command lines that do it. */
export interface NextGroup {
  readonly title: Inline;
  readonly commands: readonly string[];
}

export type NextPart =
  /** Text, then the command lines it asks for, such as a shared login or a closing confirmation. */
  | { readonly kind: "step"; readonly text: Inline; readonly commands?: readonly string[] }
  | { readonly kind: "numbered"; readonly groups: readonly NextGroup[] }
  /** Muted text. */
  | { readonly kind: "note"; readonly text: Inline };

/** What the operator does next, in order: paragraphs of steps, numbered groups and notes. */
export interface Next {
  /** Shown after `Next: `. */
  readonly title?: Inline;
  readonly paragraphs: readonly (readonly NextPart[])[];
}

/** A step: its text, then any command lines it asks for. */
export const step = (text: Inline, commands?: readonly string[]): NextPart =>
  commands === undefined ? { kind: "step", text } : { kind: "step", text, commands };

/** A Next block of one paragraph. */
export const nextSteps = (...parts: NextPart[]): Next => ({ paragraphs: [parts] });

/** What a command prints of an outcome: its blocks, then at most one Next block. */
export interface Report {
  readonly blocks: readonly Block[];
  readonly next?: Next;
}

const RULE_WIDTH = 53;
const INDENT = "  ";
const GAP = "   ";

const width = (text: string): number => Bun.stringWidth(text);
const padded = (text: string, columns: number): string =>
  text + " ".repeat(Math.max(0, columns - width(text)));

/** `text` after `indent`, or a blank line, never ending in spaces. */
const indented = (indent: string, text: string): string => (text === "" ? "" : indent + text);

/** Groups of lines, a blank line between each two that are not empty. */
function separated(groups: readonly (readonly string[])[]): string[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? [...group] : ["", ...group]));
}

function toned(style: Style, tone: Tone, text: string): string {
  switch (tone) {
    case "heading":
      return style.heading(text);
    case "label":
      return style.label(text);
    case "muted":
      return style.muted(text);
    case "code":
      return style.code(text);
    default:
      return style.status(tone, text);
  }
}

/**
 * Text with its inline code: each matched pair of backticks is code, the rest `plain`'s. With
 * an odd number of backticks, the last is printed as it is.
 */
function marked(style: Style, text: string, plain: (text: string) => string): string {
  const parts = text.split("`");
  if (parts.length % 2 === 0) parts.splice(-2, 2, `${parts.at(-2)}\`${parts.at(-1)}`);
  return parts
    .map((part, index) => (index % 2 === 1 ? style.code(part) : part === "" ? "" : plain(part)))
    .join("");
}

/** An inline as a terminal shows it; text not marked with a tone takes `plain`'s role. */
function inline(style: Style, text: Inline, plain: (text: string) => string = (t) => t): string {
  const spans: readonly Span[] = typeof text === "string" ? [text] : text;
  return spans
    .map((span) => {
      if (typeof span === "string") return marked(style, span, plain);
      return span.tone === undefined ? plain(span.text) : toned(style, span.tone, span.text);
    })
    .join("");
}

/** `── TITLE ───…`, 53 columns wide, or longer, with two rule characters, for a long title. */
function ruleLine(style: Style, title: Inline): string {
  const heading = inline(style, title, style.heading);
  const rest = Math.max(2, RULE_WIDTH - width(heading) - 4);
  return `${style.rule("──")} ${heading} ${style.rule("─".repeat(rest))}`;
}

function rowsLines(
  style: Style,
  block: Extract<Block, { kind: "rows" }>,
  indent: string,
): string[] {
  const labels = block.rows.map((row) => inline(style, row.label, style.label));
  const labelWidth = Math.max(block.labelWidth ?? 0, ...labels.map(width));
  const glyphs = block.rows.map((row) => (row.status ? style.glyph(row.status) : ""));
  const glyphWidth = Math.max(...glyphs.map(width));
  return block.rows.flatMap((row, index) => {
    const glyph = glyphWidth > 0 ? `${padded(glyphs[index] ?? "", glyphWidth)} ` : "";
    const label = labels[index] ?? "";
    const value = row.value === undefined ? "" : inline(style, row.value);
    const line = value === "" ? label : `${padded(label, labelWidth)}${GAP}${value}`;
    const text = line === "" ? glyph.trimEnd() : glyph + line;
    return [indented(indent, text), ...detailLines(style, row.details, indent)];
  });
}

function detailLines(
  style: Style,
  details: readonly Block[] | undefined,
  indent: string,
): string[] {
  return details === undefined ? [] : blockLines(style, details, indent + INDENT);
}

function blockLines(style: Style, blocks: readonly Block[], indent: string): string[] {
  return separated(blocks.map((block) => lines(style, block, indent)));
}

function lines(style: Style, block: Block, indent: string): string[] {
  switch (block.kind) {
    case "text":
      return block.lines.map((line) => indented(indent, inline(style, line)));
    case "section":
      return [
        indent + ruleLine(style, block.title),
        ...blockLines(style, block.blocks, indent + INDENT),
      ];
    case "rows":
      return rowsLines(style, block, indent);
    case "verdict": {
      const strong = (text: string) => style.verdict(block.status, text);
      const glyph = strong(GLYPHS[block.status]);
      const text = inline(style, block.text, strong);
      return [
        indent + (text === "" ? glyph : `${glyph} ${text}`),
        ...detailLines(style, block.details, indent),
      ];
    }
  }
}

const commandLines = (style: Style, commands: readonly string[], indent: string): string[] =>
  commands.map((command) => indent + style.command(command));

function partLines(style: Style, part: NextPart): string[] {
  switch (part.kind) {
    case "step":
      return [
        INDENT + inline(style, part.text),
        ...commandLines(style, part.commands ?? [], INDENT + INDENT),
      ];
    case "note":
      return [INDENT + inline(style, part.text, style.muted)];
    case "numbered": {
      const numberWidth = `${part.groups.length}.`.length;
      const under = INDENT + " ".repeat(numberWidth + 1);
      return part.groups.flatMap((group, index) => [
        `${INDENT}${`${index + 1}.`.padStart(numberWidth)} ${inline(style, group.title)}`,
        ...commandLines(style, group.commands, under),
      ]);
    }
  }
}

function nextLines(style: Style, next: Next): string[] {
  const title: Inline =
    next.title === undefined
      ? "Next"
      : typeof next.title === "string"
        ? `Next: ${next.title}`
        : ["Next: ", ...next.title];
  return [
    ruleLine(style, title),
    ...separated(
      next.paragraphs.map((paragraph) => paragraph.flatMap((part) => partLines(style, part))),
    ),
  ];
}

/**
 * `blocks` as lines in `style`, a blank line between each two, then `next`, if any: a render
 * prints at most one Next block, and always last (`docs/specs/cli-output.md` §The Next-block
 * contract).
 */
export function render(style: Style, blocks: readonly Block[], next?: Next): string[] {
  return separated([
    blockLines(style, blocks, ""),
    next === undefined ? [] : nextLines(style, next),
  ]);
}

/**
 * `blocks` as lines inside a section, indented as the section's own blocks are: a section
 * streamed a block at a time, such as apply's progress rows, renders its rule as a section with
 * no blocks, then each block with this as it comes (`docs/specs/cli-output.md` §Rows).
 */
export function renderInSection(style: Style, blocks: readonly Block[]): string[] {
  return blockLines(style, blocks, INDENT);
}
