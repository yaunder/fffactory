/**
 * A structural reader for the HCL native syntax the shipped Terraform modules use, for the
 * guardrail tests: blocks with their labels and nested bodies, and attributes with their
 * expressions kept as source text. It understands strings with template interpolation,
 * heredocs, comments and bracket nesting well enough to find where each expression ends,
 * and throws on anything it cannot read, so a guardrail over it fails closed.
 */

export interface HclAttribute {
  readonly name: string;
  /** The expression's source text, trimmed. */
  readonly expression: string;
  readonly line: number;
}

export interface HclBlock {
  readonly type: string;
  readonly labels: readonly string[];
  readonly body: HclBody;
  readonly line: number;
}

export interface HclBody {
  readonly attributes: readonly HclAttribute[];
  readonly blocks: readonly HclBlock[];
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_-]*/y;
const OPENERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

class Reader {
  position = 0;

  constructor(
    readonly source: string,
    readonly file: string,
  ) {}

  get done(): boolean {
    return this.position >= this.source.length;
  }

  peek(offset = 0): string {
    return this.source[this.position + offset] ?? "";
  }

  line(position = this.position): number {
    return this.source.slice(0, position).split("\n").length;
  }

  fail(message: string): never {
    throw new Error(`${this.file}:${this.line()}: ${message}`);
  }

  startsWith(text: string): boolean {
    return this.source.startsWith(text, this.position);
  }

  /** Skips spaces, tabs and comments; newlines too when `newlines`. */
  skipTrivia(newlines: boolean): void {
    while (this.skipOne(newlines)) {
      // Keep skipping.
    }
  }

  /** Skips one blank character or comment, reporting whether there was one. */
  private skipOne(newlines: boolean): boolean {
    const char = this.peek();
    if (char === " " || char === "\t" || char === "\r" || (newlines && char === "\n")) {
      this.position += 1;
    } else if (char === "#" || this.startsWith("//")) {
      this.skipLineComment();
    } else if (this.startsWith("/*")) {
      this.skipBlockComment();
    } else return false;
    return true;
  }

  skipLineComment(): void {
    const end = this.source.indexOf("\n", this.position);
    this.position = end === -1 ? this.source.length : end;
  }

  skipBlockComment(): void {
    const end = this.source.indexOf("*/", this.position + 2);
    if (end === -1) this.fail("unterminated comment");
    this.position = end + 2;
  }

  identifier(): string | undefined {
    IDENTIFIER.lastIndex = this.position;
    const match = IDENTIFIER.exec(this.source);
    if (!match) return undefined;
    this.position += match[0].length;
    return match[0];
  }

  /** Reads a quoted string, including any templates, and returns its source text. */
  quoted(): string {
    const start = this.position;
    this.position += 1;
    while (this.peek() !== '"') this.stringPart();
    this.position += 1;
    return this.source.slice(start, this.position);
  }

  /** Reads one part of a quoted string: an escape, a template, or a character. */
  private stringPart(): void {
    const char = this.peek();
    if (char === "" || char === "\n") this.fail("unterminated string");
    if (char === "\\") this.position += 2;
    else if (/^(\$\$|%%)\{/.test(this.source.slice(this.position, this.position + 3)))
      this.position += 3;
    else if ((char === "$" || char === "%") && this.peek(1) === "{") {
      this.position += 2;
      this.nested("}");
    } else this.position += 1;
  }

  /** Skips a heredoc, from `<<` to the line holding only its delimiter. */
  heredoc(): void {
    const header = /<<-?([A-Za-z_][A-Za-z0-9_]*)\n/y;
    header.lastIndex = this.position;
    const match = header.exec(this.source);
    if (!match) this.fail("unreadable heredoc");
    this.position += match[0].length;
    const delimiter = match[1] as string;
    for (;;) {
      const end = this.source.indexOf("\n", this.position);
      if (end === -1) this.fail("unterminated heredoc");
      const line = this.source.slice(this.position, end).trim();
      this.position = end + 1;
      if (line === delimiter) return;
    }
  }

  /** Reads an expression up to its closing `close`, which it consumes. */
  nested(close: string): void {
    for (;;) {
      this.skipTrivia(true);
      if (this.done) this.fail(`missing ${close}`);
      if (this.peek() === close) {
        this.position += 1;
        return;
      }
      this.token();
    }
  }

  /** Reads one token of an expression, a whole bracketed group or string at a time. */
  token(): void {
    const char = this.peek();
    const closer = OPENERS[char];
    if (closer !== undefined) {
      this.position += 1;
      this.nested(closer);
    } else if (char === '"') this.quoted();
    else if (this.startsWith("<<")) this.heredoc();
    else if (char === ")" || char === "]" || char === "}") this.fail(`unexpected ${char}`);
    else this.position += 1;
  }

  /**
   * Reads an expression that ends at a newline, or at `}` or `,` when `inline`, outside any
   * bracket, and returns its trimmed source text without any trailing comment.
   */
  expression(inline: boolean): string {
    const start = this.position;
    let end = start;
    for (;;) {
      this.skipTrivia(false);
      const char = this.peek();
      if (char === "" || char === "\n" || (inline && (char === "}" || char === ","))) break;
      this.token();
      end = this.position;
    }
    const text = this.source.slice(start, end).trim();
    if (text === "") this.fail("missing expression");
    return text;
  }
}

/** A label or object key: an identifier, or a quoted string literal without templates. */
function label(reader: Reader): string | undefined {
  if (reader.peek() === '"') return stringLiteral(reader.quoted());
  return reader.identifier();
}

/** Reads a body up to `close` (or the end of the source when undefined), consuming it. */
function body(reader: Reader, close: string | undefined): HclBody {
  const attributes: HclAttribute[] = [];
  const blocks: HclBlock[] = [];
  while (!atBodyEnd(reader, close)) {
    const line = reader.line();
    const name = reader.identifier() ?? reader.fail("expected an attribute or block");
    reader.skipTrivia(false);
    if (reader.peek() === "=" && reader.peek(1) !== "=") {
      reader.position += 1;
      attributes.push({ name, expression: reader.expression(true), line });
    } else blocks.push(block(reader, name, line));
  }
  return { attributes, blocks };
}

/** Whether the body ends here, consuming its `close`. */
function atBodyEnd(reader: Reader, close: string | undefined): boolean {
  reader.skipTrivia(true);
  if (reader.done) {
    if (close !== undefined) reader.fail(`missing ${close}`);
    return true;
  }
  if (reader.peek() !== close) return false;
  reader.position += 1;
  return true;
}

function block(reader: Reader, type: string, line: number): HclBlock {
  const labels: string[] = [];
  for (;;) {
    reader.skipTrivia(false);
    if (reader.peek() === "{") {
      reader.position += 1;
      return { type, labels, body: body(reader, "}"), line };
    }
    labels.push(label(reader) ?? reader.fail(`expected a label or { after ${type}`));
  }
}

/** Parses one HCL file. Throws, naming the file and line, on syntax it cannot read. */
export function parseHcl(source: string, file: string): HclBody {
  return body(new Reader(source, file), undefined);
}

/**
 * The entries of an object constructor expression such as `{ Name = "x", "a:b" = y }`, by
 * key, with each value's source text; undefined for any other expression.
 */
export function objectEntries(expression: string): ReadonlyMap<string, string> | undefined {
  if (!expression.startsWith("{") || !expression.endsWith("}")) return undefined;
  const reader = new Reader(expression.slice(1, -1), "(object)");
  const entries = new Map<string, string>();
  for (;;) {
    skipSeparators(reader);
    if (reader.done) return entries;
    const key = label(reader);
    reader.skipTrivia(false);
    if (key === undefined || (reader.peek() !== "=" && reader.peek() !== ":")) return undefined;
    reader.position += 1;
    entries.set(key, reader.expression(true));
  }
}

/** Skips blank lines, comments and commas between object entries. */
function skipSeparators(reader: Reader): void {
  reader.skipTrivia(true);
  while (reader.peek() === ",") {
    reader.position += 1;
    reader.skipTrivia(true);
  }
}

const QUOTED = /^"(?:[^"\\]|\\.)*"$/;
/** HCL's escapes, all of which JSON shares: `\n`, `\r`, `\t`, `\"`, `\\` and `\uNNNN`. */
const HCL_ESCAPES = /\\(?:[nrt"\\]|u[0-9A-Fa-f]{4})/g;
/** A run of `$` or `%` before `{`: two is an escaped literal, one starts a template. */
const TEMPLATE_MARK = /([$%])\1*\{/g;

/**
 * The value of a quoted string literal without templates, or undefined. `$${` and `%%{`
 * are escaped literals; any other run of `$` or `%` before `{` is a template, or too
 * ambiguous to call a literal. Escapes JSON has and HCL does not, and HCL's `\U`, make it
 * unreadable too.
 */
export function stringLiteral(expression: string): string | undefined {
  if (!QUOTED.test(expression) || !hasOnlyHclEscapes(expression)) return undefined;
  const marks = expression.match(TEMPLATE_MARK) ?? [];
  if (marks.some((mark) => mark.length !== 3)) return undefined;
  return JSON.parse(expression.replace(TEMPLATE_MARK, "$1{")) as string;
}

function hasOnlyHclEscapes(expression: string): boolean {
  return !expression.replace(HCL_ESCAPES, "").includes("\\");
}

/** The values of a list of string literals, such as `["a", "b"]`, or undefined. */
export function stringList(expression: string): readonly string[] | undefined {
  if (!expression.startsWith("[") || !expression.endsWith("]")) return undefined;
  const items = expression
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const values = items.map(stringLiteral);
  return values.every((value) => value !== undefined) ? (values as string[]) : undefined;
}
