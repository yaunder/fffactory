/**
 * Writes through `descriptorOutput` as `cli/main.ts` wires it, then flushes before exiting
 * as `fffactory` does. Arguments: `large OUT_BYTES ERR_BYTES` writes one line of each size to
 * standard output and standard error; `alternate COUNT` writes COUNT numbered lines,
 * alternating between them; `prompt OUT_BYTES` follows a large review with a question.
 */
import { PassThrough } from "node:stream";
import { terminalPrompt } from "../../src/infrastructure/terminal-prompt";
import { descriptorOutput } from "../../src/cli/descriptor-lines";

// main.ts reads both streams' terminal status;
// creating Bun's stream objects makes both descriptors non-blocking.
void process.stdout.isTTY;
void process.stderr.isTTY;

const output = descriptorOutput();
const out = output.lines(1);
const err = output.lines(2);
const [mode, first = "0", second = "0"] = process.argv.slice(2);
if (mode === "large") {
  out("x".repeat(Number(first)));
  err("e".repeat(Number(second)));
} else if (mode === "prompt") {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
  const prompt = terminalPrompt(input, {
    write: (text) => output.write(2, text),
    flush: async () => {
      await output.flush();
      return true;
    },
  });
  out("x".repeat(Number(first)));
  const answer = prompt.ask("PROMPT ");
  input.write("yes\r");
  out(`ANSWER ${await answer}`);
} else if (mode === "alternate") {
  for (let n = 0; n < Number(first); n++) (n % 2 ? err : out)(`${n % 2 ? "err" : "out"} ${n}`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
await output.flush();
process.exit(0);
