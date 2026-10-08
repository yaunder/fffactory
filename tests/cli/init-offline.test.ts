import { afterEach, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { run } from "../../src/cli/run";
import { harness } from "../support/cli-harness";
import { MemoryInstanceStore } from "../support/memory-instance-store";

const SOURCE = resolve(import.meta.dir, "../../src");
/** Modules init runs: the command, and the filesystem store main.ts wires in. */
const ROOTS = ["cli/commands/init.ts", "infrastructure/filesystem-instance-store.ts"];
/** Every non-relative import init may reach. Adding one here is a reviewed decision. */
const LOCAL_ONLY_IMPORTS = new Set(["node:crypto", "node:fs/promises", "node:path", "node:util"]);
const NETWORK_GLOBALS =
  /\b(fetch|WebSocket|XMLHttpRequest|EventSource|Bun\.(connect|listen|serve))\b/;

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Classifies each import of `file` as a local module to visit or an external dependency. */
async function importsOf(file: string): Promise<{ local: string[]; external: string[] }> {
  const local: string[] = [];
  const external: string[] = [];
  for (const { path } of transpiler.scanImports(await Bun.file(file).text())) {
    const target = resolve(dirname(file), path);
    if (!path.startsWith(".")) external.push(path);
    else if (path.endsWith(".json")) external.push(target);
    else local.push(`${target}.ts`);
  }
  return { local, external };
}

async function reachableModules(): Promise<{ files: string[]; external: Set<string> }> {
  const pending = ROOTS.map((root) => resolve(SOURCE, root));
  const files = new Set<string>();
  const external = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    const imports = await importsOf(file);
    pending.push(...imports.local);
    for (const path of imports.external) external.add(path);
  }
  return { files: [...files], external };
}

describe("fffactory init performs no network calls", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("runs to completion while every fetch fails loudly", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = Object.assign(
      async (...args: unknown[]) => {
        calls.push(args);
        throw new Error("init must not use the network");
      },
      { preconnect: realFetch.preconnect },
    );
    const store = new MemoryInstanceStore();
    const { context, err } = harness(store);
    expect(await run(["init"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("reaches only local-only modules and no network globals", async () => {
    const { files, external } = await reachableModules();
    expect(files.length).toBeGreaterThanOrEqual(ROOTS.length + 4);
    expect([...external].filter((path) => !LOCAL_ONLY_IMPORTS.has(path))).toEqual([]);
    for (const file of files) {
      expect({ file, network: NETWORK_GLOBALS.test(await Bun.file(file).text()) }).toEqual({
        file,
        network: false,
      });
    }
  });
});
