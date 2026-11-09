/**
 * The `collector` install step (`docs/specs/host-protocol.md` §The collector step): with the log
 * archive in the host projection, the collector's configuration and its systemd service and
 * timer, the service never reading the execution backend's private files, written as root, then systemd reloaded and the timer enabled and started. It never
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
  type CollectorUnits,
  collectorConfigurationOf,
  collectorConfigurationText,
  collectorUnits,
} from "../domain/collector-installation";
import type { HostProjection } from "../domain/host-projection";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import { ended, errorCode } from "./failures";
import type { WorkerSystem } from "./inspect";
import { writeRootFile } from "./root-files";

const SYSTEMCTL = "/usr/bin/systemctl";
/** systemctl's whole environment: no pager, no colors, nothing of root's. */
const SYSTEMCTL_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } as const;

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
  units: CollectorUnits,
  note: StepLog["note"],
): Promise<void> {
  await write(system.root, COLLECTOR_CONFIGURATION, text);
  await note("log_archive: collector.json written");
  for (const unit of units) await write(system.root, unit.path, unit.text);
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
async function uninstall(
  system: WorkerSystem,
  run: Systemctl,
  units: CollectorUnits,
  note: StepLog["note"],
) {
  const { root } = system;
  const [serviceUnit, timerUnit] = units;
  const timer = await present(root, timerUnit.path);
  const service = await present(root, serviceUnit.path);
  if (!timer && !service && !(await present(root, COLLECTOR_CONFIGURATION))) {
    await note("log_archive: not enabled; no collector to remove");
    return;
  }
  if (timer) await run("disable", "--now", COLLECTOR_TIMER);
  if (service) await run("stop", COLLECTOR_SERVICE);
  await remove(root, COLLECTOR_CONFIGURATION);
  for (const unit of units) await remove(root, unit.path);
  if (timer || service) await run("daemon-reload");
  await note("log_archive: not enabled; the collector removed, its state kept");
}

/**
 * Installs the collector while `input.log_archive` is present, never reading `privateFiles` (the
 * execution backend's, from its layout), and removes it otherwise, within `budgetMs`. Returns why
 * the step failed, naming the file and its error code or the systemctl command and how it ended,
 * or undefined.
 */
export async function workerCollectorStep(
  system: WorkerSystem,
  input: CollectorInput,
  privateFiles: readonly string[],
  budgetMs: number,
  log: StepLog,
): Promise<string | undefined> {
  const run = systemctl(system, budgetMs, log.output);
  const configuration = collectorConfigurationOf(input);
  const units = collectorUnits(privateFiles);
  try {
    if (configuration === undefined) await uninstall(system, run, units, log.note);
    else await install(system, run, collectorConfigurationText(configuration), units, log.note);
    return undefined;
  } catch (error) {
    if (error instanceof Refused) return error.reason;
    throw error;
  }
}
