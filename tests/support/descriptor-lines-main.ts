/**
 * Writes through `descriptorLines` as `cli/main.ts` wires it, then exits at once, as
 * `fffactory` does. Arguments: `large OUT_BYTES ERR_BYTES` writes one line of each size to
 * standard output and standard error; `alternate COUNT` writes COUNT numbered lines,
 * alternating between them.
 */
import { descriptorLines } from "../../src/cli/descriptor-lines";

// main.ts reads both streams' terminal status and hands standard error to the prompt;
// creating Bun's stream objects makes both descriptors non-blocking.
void process.stdout.isTTY;
void process.stderr.isTTY;

const out = descriptorLines(1);
const err = descriptorLines(2);
const [mode, first = "0", second = "0"] = process.argv.slice(2);
if (mode === "large") {
  out("x".repeat(Number(first)));
  err("e".repeat(Number(second)));
} else if (mode === "alternate") {
  for (let n = 0; n < Number(first); n++) (n % 2 ? err : out)(`${n % 2 ? "err" : "out"} ${n}`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
process.exit(0);
