import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { terminalPrompt } from "../../src/infrastructure/terminal-prompt";

const SECRET = "tskey-auth-kSECRETVALUE-0123456789";

/** A stand-in terminal: input the test writes to, raw mode switches and output it records. */
function terminal(options: { tty?: boolean } = {}) {
  const tty = options.tty ?? true;
  const input = Object.assign(new PassThrough(), {
    isTTY: tty,
    modes: [] as boolean[],
    setRawMode(mode: boolean) {
      input.modes.push(mode);
      return input;
    },
  });
  const written: string[] = [];
  const output = { write: (text: string) => written.push(text) };
  return { input, output, written, prompt: terminalPrompt(input, output) };
}

describe("terminalPrompt", () => {
  test("is interactive when standard input is a terminal, wherever standard error goes", () => {
    expect(terminal().prompt.interactive).toBe(true);
    expect(terminal({ tty: false }).prompt.interactive).toBe(false);
    const input = Object.assign(new PassThrough(), { isTTY: true });
    expect(terminalPrompt(input, { write: () => true }).interactive).toBe(true);
  });

  test("a hidden answer is read in raw mode and never written back", async () => {
    const { input, prompt, written } = terminal();
    const answer = prompt.askHidden("Secret: ");
    input.write(SECRET.slice(0, 10));
    input.write(`${SECRET.slice(10)}\r`);
    expect(await answer).toBe(SECRET);
    expect(input.modes).toEqual([true, false]);
    expect(written).toEqual(["Secret: ", "\n"]);
    expect(written.join("")).not.toContain(SECRET);
  });

  test("backspace erases, other control characters are ignored", async () => {
    const { input, prompt } = terminal();
    const answer = prompt.askHidden("Secret: ");
    input.write("abx\u007fc\u001b\bd\td\n");
    expect(await answer).toBe("abdd");
  });

  test("multi-byte characters split across chunks survive", async () => {
    const { input, prompt } = terminal();
    const answer = prompt.askHidden("Secret: ");
    const bytes = new TextEncoder().encode("pässwörd\r");
    input.write(bytes.slice(0, 2));
    input.write(bytes.slice(2));
    expect(await answer).toBe("pässwörd");
  });

  test.each([
    ["Ctrl-C", "abc\u0003"],
    ["Ctrl-D on an empty line", "\u0004"],
  ])("%s cancels, and raw mode is restored", async (_, typed) => {
    const { input, prompt } = terminal();
    const answer = prompt.askHidden("Secret: ");
    input.write(typed);
    expect(await answer).toBeUndefined();
    expect(input.modes).toEqual([true, false]);
  });

  test("Ctrl-D after typing is ignored", async () => {
    const { input, prompt } = terminal();
    const answer = prompt.askHidden("Secret: ");
    input.write("ab\u0004c\r");
    expect(await answer).toBe("abc");
  });

  test("input that ends before Enter cancels", async () => {
    const { input, prompt } = terminal();
    const answer = prompt.askHidden("Secret: ");
    input.end("abc");
    expect(await answer).toBeUndefined();
  });

  test("without a terminal, a hidden question leaves the mode alone", async () => {
    const { input, prompt } = terminal({ tty: false });
    const answer = prompt.askHidden("Secret: ");
    input.write("abc\n");
    expect(await answer).toBe("abc");
    expect(input.modes).toEqual([]);
  });

  test("without a terminal, an echoed question reads one line", async () => {
    const { input, prompt, written } = terminal({ tty: false });
    const answer = prompt.ask("Lock ID: ");
    input.write("aaaa");
    input.write("aaaa\r\nmore");
    expect(await answer).toBe("aaaaaaaa");
    expect(written).toEqual(["Lock ID: "]);
    expect(input.modes).toEqual([]);
  });

  test("at a terminal, an echoed question is read in raw mode, echoing what is typed", async () => {
    const { input, prompt, written } = terminal();
    const answer = prompt.ask("Apply? ");
    input.write("yex\u007f");
    input.write("s\r");
    expect(await answer).toBe("yes");
    expect(input.modes).toEqual([true, false]);
    expect(written).toEqual(["Apply? ", "y", "e", "x", "\b \b", "s", "\n"]);
  });

  test.each([
    ["Ctrl-C", "ye\u0003"],
    ["Ctrl-D on an empty line", "\u0004"],
  ])("at a terminal, %s cancels an echoed question instead of interrupting", async (_, typed) => {
    const { input, prompt } = terminal();
    const answer = prompt.ask("Apply? ");
    input.write(typed);
    expect(await answer).toBeUndefined();
    expect(input.modes).toEqual([true, false]);
  });

  test("an echoed question at the end of input has no answer", async () => {
    for (const tty of [true, false]) {
      const { input, prompt } = terminal({ tty });
      const answer = prompt.ask("Lock ID: ");
      input.end();
      expect(await answer).toBeUndefined();
    }
  });

  test("reads all of standard input", async () => {
    const { input, prompt, written } = terminal({ tty: false });
    const read = prompt.readInput(1000);
    input.write("line one\n");
    input.end("line two\n");
    expect(await read).toBe("line one\nline two\n");
    expect(written).toEqual([]);
  });

  test("stops reading standard input past the limit", async () => {
    const { input, prompt } = terminal({ tty: false });
    const read = prompt.readInput(8);
    input.write("12345");
    input.write("67890");
    expect(await read).toBeUndefined();
  });

  test("a read error rejects", async () => {
    const { input, prompt } = terminal({ tty: false });
    const read = prompt.readInput(8);
    input.destroy(new Error("EIO"));
    await expect(read).rejects.toThrow("EIO");
  });
});
