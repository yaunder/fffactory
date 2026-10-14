import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  ansiStyle,
  GLYPHS,
  plainStyle,
  STATUSES,
  type Style,
  writer,
} from "../../../src/cli/presentation/style";

const ESC = "\x1b";
const STYLE = resolve(import.meta.dir, "../../../src/cli/presentation/style.ts");

/** Every role of `style` applied to `text`, glyphs and command lines included. */
function everyRole(style: Style, text: string): string[] {
  return [
    style.heading(text),
    style.rule(text),
    style.label(text),
    style.muted(text),
    style.code(text),
    style.command(text),
    ...STATUSES.flatMap((status) => [
      style.glyph(status),
      style.status(status, text),
      style.verdict(status, text),
    ]),
  ];
}

describe("plain output (cli output §Plain output)", () => {
  test("no role writes an escape sequence", () => {
    for (const line of everyRole(plainStyle, "fffactory apply"))
      expect({ line, escape: line.includes(ESC) }).toEqual({ line, escape: false });
  });

  test("text is unchanged, inline code keeps its backticks and a command line its `$ `", () => {
    expect(plainStyle.heading("Plan")).toBe("Plan");
    expect(plainStyle.rule("──")).toBe("──");
    expect(plainStyle.label("Factory")).toBe("Factory");
    expect(plainStyle.muted("a note")).toBe("a note");
    expect(plainStyle.status("attention", "enrollment pending")).toBe("enrollment pending");
    expect(plainStyle.verdict("error", "Refusing")).toBe("Refusing");
    expect(plainStyle.code("fffactory status")).toBe("`fffactory status`");
    expect(plainStyle.command("fffactory status")).toBe("$ fffactory status");
  });

  test("every status keeps its glyph", () => {
    expect(STATUSES.map((status) => plainStyle.glyph(status))).toEqual([
      "✔",
      "!",
      "✖",
      "+",
      "~",
      "-",
    ]);
  });
});

describe("style roles in color (cli output §Style roles)", () => {
  test("heading and label are bold; the section rule and muted text are dim", () => {
    expect(ansiStyle.heading("Plan")).toBe(`${ESC}[1mPlan${ESC}[22m`);
    expect(ansiStyle.label("Factory")).toBe(`${ESC}[1mFactory${ESC}[22m`);
    expect(ansiStyle.rule("──")).toBe(`${ESC}[2m──${ESC}[22m`);
    expect(ansiStyle.muted("a note")).toBe(`${ESC}[2ma note${ESC}[22m`);
  });

  test("statuses color their glyphs and text: ready green, attention yellow, error red", () => {
    expect(ansiStyle.glyph("ready")).toBe(`${ESC}[32m✔${ESC}[39m`);
    expect(ansiStyle.glyph("attention")).toBe(`${ESC}[33m!${ESC}[39m`);
    expect(ansiStyle.glyph("error")).toBe(`${ESC}[31m✖${ESC}[39m`);
    expect(ansiStyle.status("attention", "enrollment pending")).toBe(
      `${ESC}[33menrollment pending${ESC}[39m`,
    );
  });

  test("changes: create green, update yellow, delete red", () => {
    expect(ansiStyle.glyph("create")).toBe(`${ESC}[32m+${ESC}[39m`);
    expect(ansiStyle.glyph("update")).toBe(`${ESC}[33m~${ESC}[39m`);
    expect(ansiStyle.glyph("delete")).toBe(`${ESC}[31m-${ESC}[39m`);
  });

  test("a command line is a dim `$ ` and a bold cyan command", () => {
    expect(ansiStyle.command("fffactory status")).toBe(
      `${ESC}[2m$ ${ESC}[22m${ESC}[1m${ESC}[36mfffactory status${ESC}[39m${ESC}[22m`,
    );
  });

  test("inline code is cyan, without its backticks", () => {
    expect(ansiStyle.code("fffactory lock break")).toBe(`${ESC}[36mfffactory lock break${ESC}[39m`);
  });

  test("a verdict is bold in its status's color", () => {
    expect(ansiStyle.verdict("ready", "Ready")).toBe(
      `${ESC}[1m${ESC}[32mReady${ESC}[39m${ESC}[22m`,
    );
    expect(ansiStyle.verdict("error", "Refusing")).toBe(
      `${ESC}[1m${ESC}[31mRefusing${ESC}[39m${ESC}[22m`,
    );
  });

  test("every glyph is shown in color too, so color is never the only signal", () => {
    for (const status of STATUSES) expect(ansiStyle.glyph(status)).toContain(GLYPHS[status]);
  });

  test("no role uses a background color", () => {
    const background = new RegExp(`${ESC}\\[(4[0-9]|10[0-7])(;[0-9]+)*m`);
    for (const line of everyRole(ansiStyle, "fffactory apply"))
      expect({ line, background: background.test(line) }).toEqual({ line, background: false });
  });

  test("escapes are written whatever the environment says, so the color rule alone decides", () => {
    const script = `
      import { ansiStyle } from ${JSON.stringify(STYLE)};
      process.stdout.write(ansiStyle.heading("Plan"));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", TERM: "dumb", FORCE_COLOR: "0" },
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe(`${ESC}[1mPlan${ESC}[22m`);
  });

  test("empty text writes nothing", () => {
    expect(ansiStyle.heading("")).toBe("");
    expect(ansiStyle.status("ready", "")).toBe("");
  });
});

describe("a stream's style travels with it (cli output §Color)", () => {
  test("a writer writes each line as given and carries its stream's style", () => {
    const lines: string[] = [];
    const out = writer((line) => lines.push(line), ansiStyle);
    out(`${ESC}[1mkept${ESC}[22m`);
    out("{}");
    expect(lines).toEqual([`${ESC}[1mkept${ESC}[22m`, "{}"]);
    expect(out.style).toBe(ansiStyle);
  });
});
