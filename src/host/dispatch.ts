/** Worker-side dispatch adoption, reconciliation and observation. */
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type DispatchAdoption,
  type DispatchInspection,
  type DispatchProjection,
  DISPATCH_PROJECTION_PATH,
  DISPATCH_RESULT_PATH,
  dispatchInspectionJson,
  parseDispatchInspection,
  parseDispatchProjection,
} from "../domain/dispatch-projection";
import { HOST_PROTOCOL_VERSION, WORKER_PATHS } from "../domain/host-protocol";
import { REPOSITORY_MANIFEST_PATH } from "../domain/repository-placement";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { ApplySystem } from "./apply";

const TIMEOUT_MS = 15 * 60_000;
const FACTORY_HOME = "/home/factory";
const STABLE_DISPATCHER = "/usr/local/bin/factory-dispatch";
const INSTALLED_SKILL = `${FACTORY_HOME}/.agents/skills/dispatch/SKILL.md`;
const CLAUDE_SKILL = `${FACTORY_HOME}/.claude/skills/dispatch`;

export interface HostDispatch {
  adoption(): Promise<DispatchAdoption>;
  reconcileDispatch(): Promise<DispatchInspection>;
  inspectDispatch(): Promise<DispatchInspection>;
}

function pathAt(root: string, path: string): string {
  return join(root, path);
}

function active(root: string, relative: string): string {
  return pathAt(root, `${WORKER_PATHS.activeRelease}/steps/${relative}`);
}

async function atomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.new`;
  try {
    await writeFile(temporary, text, { mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function factoryCommand(_root: string, argv: readonly string[]): readonly string[] {
  return [
    "/usr/sbin/runuser",
    "-u",
    "factory",
    "--",
    "/usr/bin/env",
    "-i",
    `HOME=${FACTORY_HOME}`,
    `PASEO_HOME=${FACTORY_HOME}/.paseo`,
    "PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "LANG=C.UTF-8",
    ...argv,
  ];
}

function exited(outcome: ProcessOutcome, expected: readonly number[]): boolean {
  return outcome.kind === "exited" && expected.includes(outcome.exitCode);
}

async function sameFile(source: string, destination: string, mode: number): Promise<boolean> {
  try {
    const [sourceBytes, destinationBytes, details] = await Promise.all([
      readFile(source),
      readFile(destination),
      lstat(destination),
    ]);
    return (
      details.isFile() &&
      !details.isSymbolicLink() &&
      (details.mode & 0o777) === mode &&
      sourceBytes.equals(destinationBytes)
    );
  } catch {
    return false;
  }
}

async function installFile(source: string, destination: string, mode: number): Promise<boolean> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  if (await sameFile(source, destination, mode)) return false;
  await rm(destination, { recursive: true, force: true });
  await copyFile(source, destination);
  await chmod(destination, mode);
  return true;
}

async function installLink(destination: string, target: string): Promise<boolean> {
  try {
    const details = await lstat(destination);
    if (details.isSymbolicLink() && (await readlink(destination)) === target) return false;
  } catch {
    // A missing or unreadable destination is replaced below.
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await rm(destination, { recursive: true, force: true });
  await symlink(target, destination, "dir");
  return true;
}

async function installAssets(root: string): Promise<boolean> {
  const dispatcher = active(root, "dispatch/factory-dispatch");
  const skill = active(root, "dispatch/skill/SKILL.md");
  const destination = pathAt(root, STABLE_DISPATCHER);
  const installedSkill = pathAt(root, INSTALLED_SKILL);
  const claudeSkill = pathAt(root, CLAUDE_SKILL);
  const changes = await Promise.all([
    installFile(dispatcher, destination, 0o755),
    installFile(skill, installedSkill, 0o644),
    installLink(claudeSkill, "../../.agents/skills/dispatch"),
  ]);
  return changes.some(Boolean);
}

function stateFor(projection: DispatchProjection, changed: boolean): DispatchInspection {
  if (!projection.requested)
    return {
      protocol_version: HOST_PROTOCOL_VERSION,
      state: "not_requested",
      blockers: [],
      changed,
    };
  if (!projection.active)
    return {
      protocol_version: HOST_PROTOCOL_VERSION,
      state: "pending",
      blockers: projection.blockers,
      changed,
    };
  return { protocol_version: HOST_PROTOCOL_VERSION, state: "active", blockers: [], changed };
}

function failed(blockers: DispatchProjection["blockers"], reason: string): DispatchInspection {
  return { protocol_version: HOST_PROTOCOL_VERSION, state: "failed", blockers, reason };
}

function projectionForHost(
  input: string,
  hostname: string,
): { readonly projection: DispatchProjection } | { readonly failure: DispatchInspection } {
  const parsed = parseDispatchProjection(input);
  if (!parsed.ok) return { failure: failed([], "invalid dispatch projection") };
  if (parsed.projection.hostname.toLowerCase() !== hostname.toLowerCase())
    return {
      failure: failed(parsed.projection.blockers, "dispatch projection is for another worker"),
    };
  return { projection: parsed.projection };
}

async function scheduleMatches(
  projectionPath: string,
  input: string,
  check: () => Promise<ProcessOutcome>,
): Promise<boolean> {
  try {
    return (await readFile(projectionPath, "utf8")) === input && exited(await check(), [0]);
  } catch {
    return false;
  }
}

function reconcileResult(
  projection: DispatchProjection,
  matches: boolean,
  applied: ProcessOutcome | undefined,
  assetsChanged: boolean,
): DispatchInspection {
  if (matches) return stateFor(projection, assetsChanged);
  return applied !== undefined && exited(applied, [0])
    ? stateFor(projection, true)
    : failed(projection.blockers, "dispatch schedule did not reconcile");
}

async function readResult(root: string): Promise<DispatchInspection> {
  try {
    return (
      parseDispatchInspection(await readFile(pathAt(root, DISPATCH_RESULT_PATH), "utf8")) ?? {
        protocol_version: HOST_PROTOCOL_VERSION,
        state: "unreadable",
      }
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { protocol_version: HOST_PROTOCOL_VERSION, state: "none" }
      : { protocol_version: HOST_PROTOCOL_VERSION, state: "unreadable" };
  }
}

export function workerDispatch(system: ApplySystem): HostDispatch {
  const projectionPath = pathAt(system.root, DISPATCH_PROJECTION_PATH);
  const resultPath = pathAt(system.root, DISPATCH_RESULT_PATH);
  const schedule = active(system.root, "dispatch/dispatch-schedule.sh");
  const auth = active(system.root, "control-plane/paseo-auth.sh");
  const runSchedule = (mode: "--apply" | "--check") =>
    system.run(
      factoryCommand(system.root, [
        `FACTORY_PASEO_BIN=${auth}`,
        schedule,
        mode,
        "--projection",
        projectionPath,
      ]),
      TIMEOUT_MS,
      { cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } },
    );
  return {
    async adoption() {
      if (!system.isRoot())
        throw new Error("host dispatch adoption must run through the activator");
      const dispatcher = active(system.root, "dispatch/factory-dispatch");
      const outcome = await system.run(
        factoryCommand(system.root, [
          dispatcher,
          "--adoption-only",
          "--manifest",
          pathAt(system.root, REPOSITORY_MANIFEST_PATH),
          "--host",
          system.hostname(),
        ]),
        TIMEOUT_MS,
        { cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } },
      );
      return {
        protocol_version: HOST_PROTOCOL_VERSION,
        state: exited(outcome, [0]) ? "passed" : "failed",
      };
    },
    async reconcileDispatch() {
      if (!system.isRoot())
        throw new Error("host dispatch reconcile must run through the activator");
      const input = await system.readInput();
      const parsed = projectionForHost(input, system.hostname());
      if ("failure" in parsed) return parsed.failure;
      const assetsChanged = parsed.projection.active ? await installAssets(system.root) : false;
      const matches = await scheduleMatches(projectionPath, input, () => runSchedule("--check"));
      await atomically(projectionPath, input);
      const reconciled = matches ? undefined : await runSchedule("--apply");
      const result = reconcileResult(parsed.projection, matches, reconciled, assetsChanged);
      await atomically(resultPath, `${dispatchInspectionJson(result)}\n`);
      return result;
    },
    async inspectDispatch() {
      if (!system.isRoot()) throw new Error("host dispatch inspect must run through the activator");
      const saved = await readResult(system.root);
      if (saved.state === "none" || saved.state === "unreadable" || saved.state === "failed")
        return saved;
      const checked = await runSchedule("--check");
      if (exited(checked, [0])) return { ...saved, changed: false };
      return {
        protocol_version: HOST_PROTOCOL_VERSION,
        state: "failed",
        blockers: "blockers" in saved ? saved.blockers : [],
        reason: "dispatch schedule differs from its recorded state",
      };
    },
  };
}
