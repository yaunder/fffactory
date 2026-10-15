/** Plugin installation contract (§Plugin installation): local files and a scripted runner only. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginMetadataMatches, pluginPins } from "../../src/host/plugin-manifest";
import { workerPlugins } from "../../src/host/plugins";
import { AS_FACTORY } from "../../src/host/runtime-account";
import type { ProcessOptions, ProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { system } from "./worker-scenarios";

const PIN = {
  id: "fff@ffflow",
  version: "0.4.3",
  marketplace: "ffflow",
  path: "plugin",
  source: { type: "github" as const, repository: "zerotechdebt/ffflow", revision: "a".repeat(40) },
};
const MANIFEST = { schema: 1, providers: { claude: { plugins: [PIN] }, codex: { plugins: [] } } };
const CATALOG = {
  name: "ffflow",
  metadata: { version: "0.5.0" },
  plugins: [
    { name: "fff", source: "./plugin" },
    { name: "ppp", source: "./ppp" },
  ],
};
let root: string;
let steps: string;
let checkout: string;
let cache: string;
async function json(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-plugins-"));
  steps = join(root, "release/steps");
  checkout = join(root, "/home/factory/.local/share/software-factory/marketplaces/ffflow");
  cache = join(root, "/home/factory/.claude/plugins/cache/ffflow/fff/0.4.3");
  await json(join(steps, "plugins.json"), MANIFEST);
  await json(join(checkout, ".claude-plugin/marketplace.json"), CATALOG);
  await json(join(checkout, "plugin/.claude-plugin/plugin.json"), {
    name: "fff",
    version: "0.4.3",
  });
  await mkdir(cache, { recursive: true });
  await mkdir(join(checkout, ".git"), { recursive: true });
  await json(join(root, "/home/factory/.claude/plugins/installed_plugins.json"), {
    plugins: { "fff@ffflow": [{ scope: "user", gitCommitSha: PIN.source.revision }] },
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function worker() {
  let plugins: Record<string, unknown>[] = [
    { id: PIN.id, scope: "user", enabled: true, version: PIN.version, installPath: cache },
  ];
  let marketplaces: Record<string, unknown>[] = [
    { name: "ffflow", source: "directory", path: checkout },
  ];
  const state = { head: PIN.source.revision, dirty: "", contentMatches: true, fail: "" };
  const calls: { argv: readonly string[]; timeout: number; options?: ProcessOptions }[] = [];
  function updatePlugin(args: readonly string[]) {
    if (args[2] === "uninstall") plugins = plugins.filter((row) => row.id !== args[3]);
    if (args[2] === "install")
      plugins = [
        { id: PIN.id, scope: "user", enabled: true, version: PIN.version, installPath: cache },
      ];
    if (args[2] === "marketplace") updateMarketplace(args);
  }
  function updateMarketplace(args: readonly string[]) {
    if (args[3] === "remove") marketplaces = marketplaces.filter((row) => row.name !== args[4]);
    if (args[3] === "add")
      marketplaces.push({ name: "ffflow", source: "directory", path: checkout });
  }
  function output(args: readonly string[]) {
    if (args.join(" ") === "claude plugin list --json") return JSON.stringify(plugins);
    if (args.join(" ") === "claude plugin marketplace list --json")
      return JSON.stringify(marketplaces);
    if (args.includes("rev-parse")) return state.head;
    if (args.includes("status")) return state.dirty;
    return "";
  }
  function execute(args: readonly string[]) {
    if (state.fail && args.join(" ").includes(state.fail)) return 1;
    if (args[0] === "/usr/bin/diff" && !state.contentMatches) return 1;
    if (args[1] === "plugin") updatePlugin(args);
    if (args.includes("--detach")) {
      state.head = PIN.source.revision;
      state.dirty = "";
    }
    return 0;
  }
  const run: ProcessRunner = async (argv, timeout, options) => {
    calls.push({ argv, timeout, options });
    const asFactory = argv[0] === AS_FACTORY[0];
    if (asFactory) expect(argv.slice(0, AS_FACTORY.length)).toEqual([...AS_FACTORY]);
    const args = asFactory ? argv.slice(AS_FACTORY.length) : argv;
    return { kind: "exited", exitCode: execute(args), stdout: output(args), stderr: "" };
  };
  return {
    state,
    calls,
    plugins,
    marketplaces,
    act: (action: "install" | "verify", timeout = 1000) =>
      workerPlugins(
        system(root, { run }),
        steps,
        action,
        timeout,
        action === "install" ? 42 : undefined,
      ),
  };
}

describe("plugin metadata", () => {
  test("uses plugin.json's version with an unversioned, multi-plugin catalog", () => {
    expect(pluginMetadataMatches(PIN, CATALOG, { name: "fff", version: "0.4.3" })).toBe(true);
    expect(pluginMetadataMatches(PIN, CATALOG, { name: "fff", version: "0.5.0" })).toBe(false);
    expect(
      pluginMetadataMatches(PIN, { ...CATALOG, name: "other" }, { name: "fff", version: "0.4.3" }),
    ).toBe(false);
    expect(
      pluginMetadataMatches(
        PIN,
        { ...CATALOG, plugins: [{ name: "fff", source: "./other" }] },
        { name: "fff", version: "0.4.3" },
      ),
    ).toBe(false);
  });
  test("rejects malformed, ambiguous and unsafe release pins", () => {
    expect(pluginPins(MANIFEST)).toEqual([PIN]);
    for (const bad of [
      null,
      {},
      { ...MANIFEST, schema: 2 },
      { ...MANIFEST, providers: { claude: { plugins: [PIN, PIN] }, codex: { plugins: [] } } },
    ])
      expect(() => pluginPins(bad)).toThrow();
    for (const patch of [
      { id: "../x@ffflow" },
      { path: "../plugin" },
      { marketplace: "other" },
      { source: { ...PIN.source, revision: "main" } },
      { source: { ...PIN.source, repository: "../repo" } },
    ])
      expect(() =>
        pluginPins({
          schema: 1,
          providers: { claude: { plugins: [{ ...PIN, ...patch }] }, codex: { plugins: [] } },
        }),
      ).toThrow();
  });
});

describe("native worker plugins", () => {
  test("verifies the pinned commit, version, registry and content without mutations", async () => {
    const w = worker();
    expect(await w.act("verify")).toBe(true);
    expect(w.calls.every(({ options }) => options?.output === undefined)).toBe(true);
    expect(
      w.calls
        .filter(({ argv }) => argv.includes("git"))
        .every(({ argv }) => argv.includes("--no-optional-locks")),
    ).toBe(true);
    expect(w.calls.every(({ argv }) => argv[0] === AS_FACTORY[0])).toBe(true);
    expect(w.calls.every(({ timeout }) => timeout > 0 && timeout <= 1000)).toBe(true);
  });
  test("a healthy rerun never reinstalls or fetches", async () => {
    const w = worker();
    expect(await w.act("install")).toBe(true);
    expect(w.calls.some(({ argv }) => argv.includes("clone") || argv.includes("uninstall"))).toBe(
      false,
    );
  });
  test("repairs drift at the exact commit, then verifies; mutation output goes to the step log", async () => {
    const w = worker();
    w.state.head = "b".repeat(40);
    expect(await w.act("install")).toBe(true);
    const clone = w.calls.find(({ argv }) => argv.includes("clone"));
    expect(clone?.argv).toEqual([
      ...AS_FACTORY,
      "git",
      "clone",
      "--quiet",
      "https://github.com/zerotechdebt/ffflow.git",
      checkout,
    ]);
    expect(clone?.options?.output).toBe(42);
    expect(w.calls.find(({ argv }) => argv.includes("--detach"))?.argv.at(-1)).toBe(
      PIN.source.revision,
    );
  });
  test("rejects drift and never repairs it during verification", async () => {
    for (const patch of [
      { head: "b".repeat(40) },
      { dirty: " M plugin/SKILL.md" },
      { contentMatches: false },
    ]) {
      const w = worker();
      Object.assign(w.state, patch);
      expect(await w.act("verify")).toBe(false);
      expect(w.calls.some(({ argv }) => argv.includes("clone"))).toBe(false);
    }
  });
  test("rejects wrong plugin versions and missing or wrong installation records", async () => {
    await json(join(checkout, "plugin/.claude-plugin/plugin.json"), {
      name: "fff",
      version: "0.4.2",
    });
    expect(await worker().act("verify")).toBe(false);
    await json(join(checkout, "plugin/.claude-plugin/plugin.json"), {
      name: "fff",
      version: "0.4.3",
    });
    await json(join(root, "/home/factory/.claude/plugins/installed_plugins.json"), {
      plugins: { "fff@ffflow": [{ scope: "user", gitCommitSha: "b".repeat(40) }] },
    });
    expect(await worker().act("verify")).toBe(false);
  });
  test("removes undeclared user plugins and marketplaces, leaving project scope alone", async () => {
    const w = worker();
    w.plugins.push(
      { id: "extra@extra", scope: "user" },
      { id: "project@project", scope: "project" },
    );
    w.marketplaces.push({ name: "extra" });
    expect(await w.act("verify")).toBe(false);
    expect(await w.act("install")).toBe(true);
    expect(
      w.calls.some(({ argv }) => argv.includes("uninstall") && argv.includes("extra@extra")),
    ).toBe(true);
    expect(
      w.calls.some(({ argv }) => argv.includes("uninstall") && argv.includes("project@project")),
    ).toBe(false);
  });
  test("fails closed on malformed metadata, command failure or an exhausted budget", async () => {
    const w = worker();
    w.state.head = "b".repeat(40);
    w.state.fail = "clone";
    expect(await w.act("install")).toBe(false);
    expect(w.calls.some(({ argv }) => argv.includes("--detach"))).toBe(false);
    expect(await worker().act("verify", 0)).toBe(false);
    await writeFile(join(steps, "plugins.json"), "invalid");
    const invalid = worker();
    expect(await invalid.act("install")).toBe(false);
    expect(invalid.calls).toHaveLength(0);
  });
});
