/**
 * The `collector` install step (`docs/specs/host-protocol.md` §The collector step): with the log
 * archive in the host projection, the collector's configuration and its systemd service and
 * timer, written as root, then systemd reloaded and the timer enabled and started. It never
 * starts a collection, asks how one went or waits for one: the collector's health is not the
 * install's. Without the archive, it disables and stops the timer, stops a run under way, and
 * removes the units and the configuration, keeping the collector's state directory; on a worker
 * that never had the collector it does nothing. Runs only inside locked `host apply`.
 */
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { COLLECTOR_CONFIGURATION } from "../domain/collector";
import {
  COLLECTOR_COMMAND_TIMEOUT_MS,
  COLLECTOR_SERVICE,
  COLLECTOR_TIMER,
  COLLECTOR_UNITS,
  collectorConfigurationOf,
  collectorConfigurationText,
} from "../domain/collector-installation";
import type { HostProjection } from "../domain/host-projection";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { WorkerSystem } from "./inspect";
import { writeRootFile } from "./root-files";

const SYSTEMCTL = "/usr/bin/systemctl";
/** systemctl's whole environment: no pager, no colors, nothing of root's. */
const SYSTEMCTL_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } as const;
const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;
const [SERVICE_UNIT, TIMER_UNIT] = COLLECTOR_UNITS;

/** What of the host projection the step reads: the worker's identity and the log archive. */
export type CollectorInput = Pick<HostProjection, "factory_id" | "host_key" | "log_archive">;

/** The step's log: systemctl writes its own output there, and the step its own lines. */
export interface StepLog {
  readonly output: number;
  readonly note: (line: string) => Promise<void>;
}

/** Why the step failed, in fffactory's own words. */
class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unexpected error";
}

/** How a command that did not succeed ended, as `<what> ...`; undefined when it succeeded. */
function ended(what: string, outcome: ProcessOutcome): string | undefined {
  switch (outcome.kind) {
    case "exited":
      return outcome.exitCode === 0 ? undefined : `${what} exited with status ${outcome.exitCode}`;
    case "timed_out":
      return `${what} timed out`;
    case "not_found":
      return `${what} could not be started (ENOENT)`;
    case "not_started":
      return `${what} could not be started (${ERROR_CODE.test(outcome.code) ? outcome.code : "unexpected error"})`;
  }
}

/** Runs `systemctl` within the step's budget, each command also within its own deadline. */
function systemctl(system: WorkerSystem, budgetMs: number, output: number) {
  const end = performance.now() + budgetMs;
  return async (...args: readonly string[]): Promise<void> => {
    const what = `systemctl ${args.join(" ")}`;
    const remaining = Math.min(COLLECTOR_COMMAND_TIMEOUT_MS, Math.floor(end - performance.now()));
    const outcome: ProcessOutcome =
      remaining <= 0
        ? { kind: "timed_out" }
        : await system.run([SYSTEMCTL, ...args], remaining, { env: SYSTEMCTL_ENV, output });
    const failure = ended(what, outcome);
    if (failure !== undefined) throw new Refused(failure);
  };
}

type Systemctl = ReturnType<typeof systemctl>;

async function write(root: string, path: string, text: string): Promise<void> {
  try {
    await writeRootFile(join(root, path), text);
  } catch (error) {
    throw new Refused(`writing ${path} failed (${errorCode(error)})`);
  }
}

async function remove(root: string, path: string): Promise<void> {
  try {
    await rm(join(root, path), { force: true });
  } catch (error) {
    throw new Refused(`removing ${path} failed (${errorCode(error)})`);
  }
}

async function present(root: string, path: string): Promise<boolean> {
  try {
    await lstat(join(root, path));
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new Refused(`reading ${path} failed (${errorCode(error)})`);
  }
}

/** Configuration first, so the first run finds it, then the units, then the timer enabled. */
async function install(
  system: WorkerSystem,
  run: Systemctl,
  text: string,
  note: StepLog["note"],
): Promise<void> {
  await write(system.root, COLLECTOR_CONFIGURATION, text);
  await note("log_archive: collector.json written");
  for (const unit of COLLECTOR_UNITS) await write(system.root, unit.path, unit.text);
  await note(`log_archive: ${COLLECTOR_SERVICE} and ${COLLECTOR_TIMER} written`);
  await run("daemon-reload");
  await run("enable", "--now", COLLECTOR_TIMER);
  await note(`log_archive: ${COLLECTOR_TIMER} enabled; collection is not waited for`);
}

/**
 * The timer disabled and stopped, then a run under way stopped (the run is crash-safe), each only
 * while its unit file is there, then the configuration and the units removed and systemd
 * reloaded. The state directory stays. Nothing there, nothing is done.
 */
async function uninstall(system: WorkerSystem, run: Systemctl, note: StepLog["note"]) {
  const { root } = system;
  const timer = await present(root, TIMER_UNIT.path);
  const service = await present(root, SERVICE_UNIT.path);
  if (!timer && !service && !(await present(root, COLLECTOR_CONFIGURATION))) {
    await note("log_archive: not enabled; no collector to remove");
    return;
  }
  if (timer) await run("disable", "--now", COLLECTOR_TIMER);
  if (service) await run("stop", COLLECTOR_SERVICE);
  await remove(root, COLLECTOR_CONFIGURATION);
  for (const unit of COLLECTOR_UNITS) await remove(root, unit.path);
  if (timer || service) await run("daemon-reload");
  await note("log_archive: not enabled; the collector removed, its state kept");
}

/**
 * Installs the collector while `input.log_archive` is present and removes it otherwise, within
 * `budgetMs`. Returns why the step failed, naming the file and its error code or the systemctl
 * command and how it ended, or undefined.
 */
export async function workerCollectorStep(
  system: WorkerSystem,
  input: CollectorInput,
  budgetMs: number,
  log: StepLog,
): Promise<string | undefined> {
  const run = systemctl(system, budgetMs, log.output);
  const configuration = collectorConfigurationOf(input);
  try {
    if (configuration === undefined) await uninstall(system, run, log.note);
    else await install(system, run, collectorConfigurationText(configuration), log.note);
    return undefined;
  } catch (error) {
    if (error instanceof Refused) return error.reason;
    throw error;
  }
}
