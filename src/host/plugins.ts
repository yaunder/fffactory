/** Pinned plugin install and read-only verification (host protocol §Plugin installation). */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { WorkerSystem } from "./inspect";
import {
  object,
  type PluginPin,
  pluginMetadataMatches,
  pluginPins,
  records,
} from "./plugin-manifest";
import { AS_FACTORY, FACTORY_HOME } from "./runtime-account";

const MARKETPLACES = `${FACTORY_HOME}/.local/share/software-factory/marketplaces`;
const CACHE = `${FACTORY_HOME}/.claude/plugins/cache`;
const ENV = {
  PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
};

function succeeded(
  outcome: ProcessOutcome,
): outcome is Extract<ProcessOutcome, { kind: "exited" }> {
  return outcome.kind === "exited" && outcome.exitCode === 0;
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** One budget covers every command in the operation, including verification after install. */
function commands(system: WorkerSystem, timeoutMs: number, output?: number) {
  const deadline = performance.now() + timeoutMs;
  async function run(argv: readonly string[], mutation = false, asFactory = true) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error("Plugin operation timed out");
    return system.run(asFactory ? [...AS_FACTORY, ...argv] : argv, remaining, {
      cwd: join(system.root, FACTORY_HOME),
      env: ENV,
      output: mutation ? output : undefined,
    });
  }
  return {
    run,
    async change(argv: readonly string[], asFactory = true) {
      if (!succeeded(await run(argv, true, asFactory))) throw new Error("Plugin command failed");
    },
    async list(argv: readonly string[]) {
      const result = await run(argv);
      if (!succeeded(result)) throw new Error("Plugin inspection failed");
      return records(JSON.parse(result.stdout));
    },
  };
}

type Commands = ReturnType<typeof commands>;
const pluginList = ["claude", "plugin", "list", "--json"];
const marketplaceList = ["claude", "plugin", "marketplace", "list", "--json"];

async function checkoutMatches(system: WorkerSystem, run: Commands, pin: PluginPin) {
  const checkout = join(system.root, MARKETPLACES, pin.marketplace);
  if (!(await stat(join(checkout, ".git"))).isDirectory()) return false;
  const head = await run.run(["git", "--no-optional-locks", "-C", checkout, "rev-parse", "HEAD"]);
  if (!succeeded(head) || head.stdout.trim() !== pin.source.revision) return false;
  const clean = await run.run([
    "git",
    "--no-optional-locks",
    "-C",
    checkout,
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (!succeeded(clean) || clean.stdout.trim() !== "") return false;
  return pluginMetadataMatches(
    pin,
    await json(join(checkout, ".claude-plugin/marketplace.json")),
    await json(join(checkout, pin.path, ".claude-plugin/plugin.json")),
  );
}

async function installedMatches(system: WorkerSystem, run: Commands, pin: PluginPin) {
  const checkout = join(system.root, MARKETPLACES, pin.marketplace);
  const name = pin.id.split("@")[0] as string;
  const installPath = join(system.root, CACHE, pin.marketplace, name, pin.version);
  const marketplaces = await run.list(marketplaceList);
  if (
    !marketplaces.some(
      (row) => row.name === pin.marketplace && row.source === "directory" && row.path === checkout,
    )
  )
    return false;
  const installed = (await run.list(pluginList)).filter(
    (row) =>
      row.id === pin.id &&
      row.scope === "user" &&
      row.enabled === true &&
      row.version === pin.version,
  );
  if (
    installed.length !== 1 ||
    installed[0]?.installPath !== installPath ||
    !(await stat(installPath)).isDirectory()
  )
    return false;
  const registry = object(
    await json(join(system.root, FACTORY_HOME, ".claude/plugins/installed_plugins.json")),
  );
  if (
    !records(object(registry.plugins)[pin.id]).some(
      (row) => row.scope === "user" && row.gitCommitSha === pin.source.revision,
    )
  )
    return false;
  return succeeded(await run.run(["/usr/bin/diff", "-rq", join(checkout, pin.path), installPath]));
}

async function matches(system: WorkerSystem, run: Commands, pin: PluginPin): Promise<boolean> {
  try {
    return (await checkoutMatches(system, run, pin)) && (await installedMatches(system, run, pin));
  } catch {
    return false;
  }
}

async function verify(system: WorkerSystem, run: Commands, pins: PluginPin[]) {
  const plugins = await run.list(pluginList);
  const marketplaces = await run.list(marketplaceList);
  if (
    plugins.some((row) => row.scope === "user" && !pins.some((pin) => pin.id === row.id)) ||
    marketplaces.some((row) => !pins.some((pin) => pin.marketplace === row.name))
  )
    return false;
  for (const pin of pins) if (!(await matches(system, run, pin))) return false;
  return true;
}

function safeName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value))
    throw new Error("Invalid installed plugin name");
  return value;
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*@[a-z][a-z0-9-]*$/.test(value))
    throw new Error("Invalid installed plugin id");
  return value;
}

async function removePlugin(system: WorkerSystem, run: Commands, value: unknown) {
  const id = safeId(value);
  const [name, marketplace] = id.split("@") as [string, string];
  await run.change(["claude", "plugin", "uninstall", id, "--scope", "user", "--yes"]);
  await run.change(
    ["/usr/bin/rm", "-rf", "--", join(system.root, CACHE, marketplace, name)],
    false,
  );
}

async function removeMarketplace(run: Commands, value: unknown) {
  await run.change(["claude", "plugin", "marketplace", "remove", safeName(value)]);
}

async function prune(system: WorkerSystem, run: Commands, pins: PluginPin[]) {
  const plugins = await run.list(pluginList);
  for (const id of new Set(plugins.filter((row) => row.scope === "user").map((row) => row.id)))
    if (!pins.some((pin) => pin.id === id)) await removePlugin(system, run, id);
  for (const row of await run.list(marketplaceList)) {
    if (pins.some((pin) => pin.marketplace === row.name)) continue;
    const name = safeName(row.name);
    await removeMarketplace(run, name);
    await run.change(["/usr/bin/rm", "-rf", "--", join(system.root, MARKETPLACES, name)], false);
  }
}

async function install(system: WorkerSystem, run: Commands, pins: PluginPin[]) {
  await run.change(
    [
      "/usr/bin/install",
      "-d",
      "-o",
      "factory",
      "-g",
      "factory",
      "-m",
      "0700",
      join(system.root, MARKETPLACES),
    ],
    false,
  );
  await prune(system, run, pins);
  for (const pin of pins) await installPin(system, run, pin);
}

async function installPin(system: WorkerSystem, run: Commands, pin: PluginPin) {
  if (await matches(system, run, pin)) return;
  if ((await run.list(marketplaceList)).some((row) => row.name === pin.marketplace))
    await removeMarketplace(run, pin.marketplace);
  if ((await run.list(pluginList)).some((row) => row.id === pin.id && row.scope === "user"))
    await removePlugin(system, run, pin.id);
  const name = pin.id.split("@")[0] as string;
  await run.change(
    ["/usr/bin/rm", "-rf", "--", join(system.root, CACHE, pin.marketplace, name)],
    false,
  );
  const checkout = join(system.root, MARKETPLACES, pin.marketplace);
  await run.change(["/usr/bin/rm", "-rf", "--", checkout], false);
  await run.change([
    "git",
    "clone",
    "--quiet",
    `https://github.com/${pin.source.repository}.git`,
    checkout,
  ]);
  await run.change(["git", "-C", checkout, "checkout", "--quiet", "--detach", pin.source.revision]);
  if (!(await checkoutMatches(system, run, pin)))
    throw new Error("Plugin checkout differs from its pin");
  await run.change(["claude", "plugin", "marketplace", "add", checkout]);
  await run.change(["claude", "plugin", "install", pin.id, "--scope", "user"]);
  if (!(await matches(system, run, pin)))
    throw new Error("Plugin installation differs from its pin");
}

/** Called only inside locked host apply for install; verification makes no changes. */
export async function workerPlugins(
  system: WorkerSystem,
  steps: string,
  action: "install" | "verify",
  timeoutMs: number,
  output?: number,
): Promise<boolean> {
  try {
    const pins = pluginPins(await json(join(steps, "plugins.json")));
    const run = commands(system, timeoutMs, output);
    if (action === "install") await install(system, run, pins);
    return await verify(system, run, pins);
  } catch {
    return false;
  }
}
