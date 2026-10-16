import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedAwsEnvironment } from "../support/aws-isolation";
import { eventually } from "../support/processes";

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function marked(directory: string, name: string) {
  return eventually(2_000, async () =>
    access(join(directory, name)).then(
      () => true,
      () => undefined,
    ),
  );
}

function expectPromptUntouched(directory: string, mode: string) {
  if (mode !== "prompt") return;
  expect(existsSync(join(directory, "raw"))).toBe(false);
  expect(existsSync(join(directory, "approved"))).toBe(false);
}

describe("an undrained output pipe (cli-output §Plain output)", () => {
  for (const stream of ["out", "err"]) {
    for (const mode of ["grace", "double", "flush", "prompt"]) {
      test(`${stream}: ${mode === "double" ? "second interrupt kills tools immediately" : `${mode}: bounded first interrupt`}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "fffactory-undrained-"));
        directories.push(directory);
        const child = spawn(
          process.execPath,
          [
            resolve(import.meta.dir, "../support/descriptor-interrupted-main.ts"),
            directory,
            stream,
            mode,
          ],
          {
            env: isolatedAwsEnvironment(directory),
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        children.push(child);
        // Neither stream is read: the pipe remains open and full throughout the test.
        expect(await marked(directory, "full")).toBe(true);
        if (mode === "flush") expect(await marked(directory, "flushing")).toBe(true);
        expectPromptUntouched(directory, mode);
        child.kill("SIGINT");
        expect(await marked(directory, "stop")).toBe(true);
        if (mode === "double") {
          child.kill("SIGINT");
          expect(await marked(directory, "kill")).toBe(true);
        }
        expect(await eventually(2_000, () => child.exitCode ?? undefined)).toBe(130);
        expectPromptUntouched(directory, mode);
      });
    }
  }
});
