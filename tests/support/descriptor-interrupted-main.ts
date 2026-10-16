/** Real undrained-pipe interruption regression (cli-output §Plain output). */
import { writeFileSync } from "node:fs";
import { constants } from "node:os";
import { PassThrough } from "node:stream";
import { terminalPrompt } from "../../src/infrastructure/terminal-prompt";
import { descriptorOutput, systemDescriptorIo } from "../../src/cli/descriptor-lines";
import { interruptible } from "../../src/cli/interrupts";

const [directory = "", stream = "out", mode = "grace"] = process.argv.slice(2);
void process.stdout.isTTY;
void process.stderr.isTTY;
const mark = (name: string) => writeFileSync(`${directory}/${name}`, "yes");
const io = {
  ...systemDescriptorIo,
  write(...args: Parameters<typeof systemDescriptorIo.write>) {
    try {
      return systemDescriptorIo.write(...args);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EAGAIN"
      ) {
        mark("full");
      }
      throw error;
    }
  },
};
const output = descriptorOutput(io);
const out = output.lines(1);
const err = output.lines(2);
const interrupts = interruptible({
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.off(signal, handler),
  exit: (code) => process.exit(code),
  flushOutput: () => {
    mark("flushing");
    return output.flush();
  },
  cancelOutput: output.cancel,
  signalNumber: (signal) => constants.signals[signal],
  stopRunningTools: () => {
    mark("stop");
    return mode === "double" ? new Promise(() => {}) : Promise.resolve();
  },
  killRunningTools: () => mark("kill"),
  stopsGracefully: () => mode === "double",
  err,
  graceMs: 100,
});
await interrupts.run(
  async () => {
    (stream === "out" ? out : err)("x".repeat(700_000));
    if (mode === "prompt") {
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: () => mark("raw"),
      });
      input.write("yes\r");
      const prompt = terminalPrompt(input, {
        write: (text) => output.write(2, text),
        flush: async () => {
          await output.flush();
          return !interrupts.interrupted();
        },
      });
      if (await prompt.ask("Approve? ")) mark("approved");
      return 0;
    }
    return mode === "flush" ? 0 : new Promise<number>(() => {});
  },
  { waitsOnInterrupt: true },
);
