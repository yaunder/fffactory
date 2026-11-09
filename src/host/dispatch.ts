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
  type RecordedInspection,
  DISPATCH_PROJECTION_PATH,
  DISPATCH_RESULT_PATH,
  dispatchInspectionJson,
  parseDispatchInspection,
  parseDispatchProjection,
} from "../domain/dispatch-projection";
import { HOST_PROTOCOL_VERSION, WORKER_PATHS } from "../domain/host-protocol";
import { REPOSITORY_MANIFEST_PATH } from "../domain/repository-placement";
import { placedCheckouts, type RepositoryRegistration } from "../domain/repository-registration";
import { WORK_ROOTS } from "../domain/work-inspection";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { ApplySystem } from "./apply";
import { executionBackend } from "./execution-backend";
import { FACTORY_HOME } from "./runtime-account";

const TIMEOUT_MS = 15 * 60_000;
// TODO(re-evaluate when a dispatch reconcile is seen outlasting the CLI's WORKFLOW_TIMEOUT_MS,
// or the schedule's TIMEOUT_MS changes): give reconcileDispatch one deadline under
// WORKFLOW_TIMEOUT_MS that the schedule's --check, --apply and the registration share, as
// activity's budget sits under its CLI wait.
/** Every execution backend call of one repository registration together. */
const REGISTRATION_BUDGET_MS = 2 * 60_000;
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

function stateFor(projection: DispatchProjection, changed: boolean): RecordedInspection {
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

function failed(blockers: DispatchProjection["blockers"], reason: string): RecordedInspection {
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
): RecordedInspection {
  if (matches) return stateFor(projection, assetsChanged);
  return applied !== undefined && exited(applied, [0])
    ? stateFor(projection, true)
    : failed(projection.blockers, "dispatch schedule did not reconcile");
}

/** Whether every path from the repository root down to `checkout` is a directory, never a link. */
async function presentOnDisk(root: string, checkout: string): Promise<boolean> {
  const components = checkout.slice(WORK_ROOTS.repositories.length + 1).split("/");
  const paths = components.map((_, index) =>
    [WORK_ROOTS.repositories, ...components.slice(0, index + 1)].join("/"),
  );
  for (const path of [WORK_ROOTS.repositories, ...paths]) {
    const directory = await lstat(pathAt(root, path)).then(
      (details) => details.isDirectory(),
      () => false,
    );
    if (!directory) return false;
  }
  return true;
}

/**
 * The checkouts this worker's repository manifest places that are directories on disk, whatever
 * their sync result, in placement order: one not yet cloned is left out, and so is one reached
 * through a link, the repository root's or any directory's down to it, as sync refuses it.
 * Without a manifest, none: nothing placed has reached the worker. Undefined when the manifest
 * cannot be read or is invalid: what it places is unknown.
 */
async function presentCheckouts(root: string): Promise<readonly string[] | undefined> {
  let text: string;
  try {
    text = await readFile(pathAt(root, REPOSITORY_MANIFEST_PATH), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
  }
  const placed = placedCheckouts(text);
  if (!placed.ok) return undefined;
  const present = await Promise.all(
    placed.checkouts.map((checkout) => presentOnDisk(root, checkout)),
  );
  return placed.checkouts.filter((_, index) => present[index]);
}

/**
 * Makes the placed checkouts present on disk available through the worker's execution backend
 * (`docs/specs/dispatch.md` §Repository registration), never Paseo directly; or none when the
 * manifest cannot be read, or anything throws: the schedule's result is persisted regardless.
 */
async function registerRepositories(
  system: ApplySystem,
): Promise<RepositoryRegistration | undefined> {
  try {
    const checkouts = await presentCheckouts(system.root);
    if (checkouts === undefined) return undefined;
    const backend = executionBackend(system, REGISTRATION_BUDGET_MS);
    return await backend.registerRepositories(checkouts);
  } catch {
    return undefined;
  }
}

/** The stored registration, carried as it is. */
function registrationOf(inspection: DispatchInspection) {
  return "repository_registration" in inspection && inspection.repository_registration
    ? { repository_registration: inspection.repository_registration }
    : {};
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
      const schedule = reconcileResult(parsed.projection, matches, reconciled, assetsChanged);
      // After the schedule, whatever the projection; it never changes the schedule's result.
      const registration = await registerRepositories(system);
      const result: RecordedInspection =
        registration === undefined
          ? schedule
          : { ...schedule, repository_registration: registration };
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
        ...registrationOf(saved),
      };
    },
  };
}
