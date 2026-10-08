import type { OperatorPrompt } from "../application/operator-prompt";

/** Standard input; on a terminal, raw mode stops it echoing what is typed. */
export type PromptInput = NodeJS.ReadableStream & {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
};

/** Where questions go: standard error, so standard output stays the command's result. */
export interface PromptOutput {
  write(text: string): unknown;
}

type Step<T> = { readonly value: T } | undefined;

/**
 * Feeds each chunk of input to `consume` until it returns a value, or gives `ended()` when
 * input ends first. Stops reading either way, so an exiting process is not held open.
 */
function readChunks<T>(
  input: PromptInput,
  consume: (chunk: Uint8Array) => Step<T>,
  ended: () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const encoder = new TextEncoder();
    const stop = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
    };
    const onData = (chunk: Uint8Array | string) => {
      const step = consume(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      if (step === undefined) return;
      stop();
      resolve(step.value);
    };
    const onEnd = () => {
      stop();
      resolve(ended());
    };
    const onError = (error: Error) => {
      stop();
      reject(error);
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

const ENTER = new Set(["\r", "\n"]);
const ERASE = new Set(["\u007f", "\b"]);
const INTERRUPT = "\u0003";
const END_OF_INPUT = "\u0004";

/** What one typed character does to a hidden line: finishes it, or edits what is typed. */
function press(typed: string[], character: string): Step<string | undefined> {
  if (ENTER.has(character)) return { value: typed.join("") };
  if (character === INTERRUPT) return { value: undefined };
  if (character === END_OF_INPUT && typed.length === 0) return { value: undefined };
  if (ERASE.has(character)) typed.pop();
  else if (character >= " ") typed.push(character);
  return undefined;
}

/**
 * A line typed in raw mode: Enter ends it, Ctrl-C cancels, Ctrl-D cancels an empty one.
 * `echo`, when given, shows what is typed and erased, since raw mode echoes nothing.
 */
function rawLine(echo?: PromptOutput): (chunk: Uint8Array) => Step<string | undefined> {
  const decoder = new TextDecoder();
  const typed: string[] = [];
  const shown = (before: number, character: string) => {
    if (typed.length > before) echo?.write(character);
    else if (typed.length < before) echo?.write("\b \b");
  };
  return (chunk) => {
    for (const character of decoder.decode(chunk, { stream: true })) {
      const before = typed.length;
      const step = press(typed, character);
      if (step !== undefined) return step;
      shown(before, character);
    }
    return undefined;
  };
}

/** Reads a raw-mode line at a terminal, restoring the mode and ending the line after. */
async function inRawMode(
  input: PromptInput,
  output: PromptOutput,
  echo: boolean,
): Promise<string | undefined> {
  const raw = input.isTTY === true && input.setRawMode !== undefined;
  if (raw) input.setRawMode?.(true);
  try {
    return await readChunks(input, rawLine(echo ? output : undefined), () => undefined);
  } finally {
    if (raw) input.setRawMode?.(false);
    output.write("\n");
  }
}

/** An echoed line, without its line ending. */
function echoedLine(): (chunk: Uint8Array) => Step<string | undefined> {
  const decoder = new TextDecoder();
  let text = "";
  return (chunk) => {
    text += decoder.decode(chunk, { stream: true });
    const end = text.indexOf("\n");
    return end < 0 ? undefined : { value: text.slice(0, end).replace(/\r$/, "") };
  };
}

/** All of the input, or undefined as soon as it passes `limit` bytes. */
function wholeInput(limit: number): {
  consume: (chunk: Uint8Array) => Step<string | undefined>;
  ended: () => string;
} {
  const chunks: Uint8Array[] = [];
  let size = 0;
  return {
    consume: (chunk) => {
      size += chunk.length;
      chunks.push(chunk);
      return size > limit ? { value: undefined } : undefined;
    },
    ended: () => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(bytes);
    },
  };
}

/**
 * The operator at a terminal: questions go to `output` (standard error), answers come from
 * `input` (standard input). At a terminal every answer is read in raw mode, so Ctrl-C cancels
 * the question instead of interrupting fffactory; an echoed answer is echoed by the prompt
 * itself, and a hidden one is never written anywhere. Standard input that is a terminal is always
 * interactive, even with standard error redirected: reading it whole would echo a secret.
 */
export function terminalPrompt(input: PromptInput, output: PromptOutput): OperatorPrompt {
  return {
    interactive: input.isTTY === true,

    ask(question) {
      output.write(question);
      if (input.isTTY === true && input.setRawMode !== undefined)
        return inRawMode(input, output, true);
      return readChunks(input, echoedLine(), () => undefined);
    },

    askHidden(question) {
      output.write(question);
      return inRawMode(input, output, false);
    },

    readInput(limit) {
      const reading = wholeInput(limit);
      return readChunks<string | undefined>(input, reading.consume, reading.ended);
    },
  };
}
