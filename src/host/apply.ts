/**
 * The worker side of `host apply` (`docs/specs/host-protocol.md` §apply): run as root by the
 * activator from the release it just unpacked, with the host projection on standard input.
 * It keeps the projection as the host's configuration, makes the release active, runs the
 * wrapped setup steps in order in this one process, stopping at the first that fails, then
 * the verifiers, and records each step's result as it goes. A failed install leaves the
 * requested release active and unhealthy; the steps are idempotent, so a rerun repairs it.
 * It holds the install lock throughout, so two installs never overlap on one worker.
 */
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WORKER_PATHS } from "../domain/host-protocol";
import { type HostProjection, parseHostProjection } from "../domain/host-projection";
import {
  type HostApplyRecord,
  type HostApplyResult,
  hostApplyJson,
  INSTALL_STEPS,
  installState,
  VERIFY_TIMEOUT_MS,
  pendingSteps,
  type RefusalReason,
  type StepResult,
  withStep,
} from "../domain/installation";
import type { Release } from "../domain/instance";
import type { Verification } from "../domain/readiness";
import { MATERIALIZED_MARKER } from "../domain/release-assets";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import { sha256Text } from "../infrastructure/release-tarball";
import { exists, markerRecords, operatingSystem, tokenOr, type WorkerSystem } from "./inspect";
import type { ExclusiveLock } from "./install-lock";
import type { HostVerifier } from "./verify";

/** What `host apply` needs of the worker beyond what inspection reads. */
export interface ApplySystem extends WorkerSystem {
  readonly now: () => Date;
  /** Whether this process runs as root. */
  readonly isRoot: () => boolean;
  /** Standard input: the host projection, read to its end or just past its size limit. */
  readonly readInput: () => Promise<string>;
  /** This executable's release, whose directory under the releases directory it installs. */
  readonly release: Release;
  /** Takes the install lock without waiting (`flockExclusive` on a worker). */
  readonly lock: ExclusiveLock;
}

export interface HostApplier {
  apply(): Promise<HostApplyResult>;
}

/** A step's name and timeout, run as `bash steps/<name>.sh` from the release. */
export interface InstallStep {
  readonly name: string;
  readonly timeoutMs: number;
}

/** A step's environment; the release's steps directory is always part of it. */
type StepEnvironment = Readonly<Record<string, string>> & { readonly FFFACTORY_STEPS: string };

/**
 * Every step's environment, and nothing else: the system's tools, root's home, and the
 * step's inputs from the release and the host projection.
 */
function stepEnvironment(
  system: ApplySystem,
  projection: HostProjection,
  releaseDirectory: string,
): StepEnvironment {
  return {
    PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/root",
    LANG: "C.UTF-8",
    FFFACTORY_RELEASE: system.release,
    FFFACTORY_STEPS: join(releaseDirectory, "steps"),
    FFFACTORY_STATE: join(system.root, WORKER_PATHS.state),
    FFFACTORY_HOSTNAME: projection.hostname,
    FFFACTORY_FACTORY_ID: projection.factory_id,
    FFFACTORY_HOST_KEY: projection.host_key,
  };
}

/** Why a step failed, in fffactory's own words; undefined when it succeeded. */
function failure(outcome: ProcessOutcome, timeoutMs: number): string | undefined {
  switch (outcome.kind) {
    case "exited":
      return outcome.exitCode === 0 ? undefined : `exited with status ${outcome.exitCode}`;
    case "timed_out":
      return `did not finish within ${timeoutMs / 1000} s`;
    case "not_found":
      return "bash is not installed";
    case "not_started":
      return `could not be started (${outcome.code})`;
  }
}

/** Writes `data` to `path` whole or not at all: a flushed private copy renamed over it. */
async function writeAtomically(path: string, data: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(staging, "wx", mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

/** Points `current` at the release with one rename, so it is never absent or half made. */
async function makeActive(root: string, release: Release): Promise<void> {
  const current = join(root, WORKER_PATHS.activeRelease);
  const staging = `${current}.${randomUUID()}.tmp`;
  try {
    await symlink(`releases/${release}`, staging);
    await rename(staging, current);
  } finally {
    await rm(staging, { force: true });
  }
}

type Checked =
  | { readonly ok: true; readonly projection: HostProjection; readonly input: string }
  | { readonly ok: false; readonly reason: RefusalReason; readonly message: string };

function refuse(reason: RefusalReason, message: string): Checked {
  return { ok: false, reason, message };
}

/** What the projection claims, against this worker and this executable. */
function checkProjection(system: ApplySystem, input: string): Checked {
  const parsed = parseHostProjection(input);
  if (!parsed.ok)
    return refuse(
      "invalid_configuration",
      `The host configuration on standard input is invalid: ${
        parsed.kind === "invalid" ? parsed.problem : `it is protocol version ${parsed.version}`
      }`,
    );
  const projection = parsed.document;
  const hostname = tokenOr(system.hostname(), "unknown");
  if (projection.hostname.toLowerCase() !== hostname.toLowerCase())
    return refuse(
      "other_host",
      `The host configuration is for ${projection.hostname}, not this worker, ${hostname}`,
    );
  if (projection.release !== system.release)
    return refuse(
      "release_mismatch",
      `The host configuration is for release ${projection.release}, not this release, ${system.release}`,
    );
  return { ok: true, projection, input };
}

/** What must hold, once it runs as root and alone, before anything changes: input, release, base. */
async function preflight(system: ApplySystem): Promise<Checked> {
  const checked = checkProjection(system, await system.readInput());
  if (!checked.ok) return checked;
  const { root, release } = system;
  const marker = join(root, WORKER_PATHS.releases, release, MATERIALIZED_MARKER);
  if ((await markerRecords(marker, release)) === undefined)
    return refuse(
      "release_missing",
      `Release ${release} is not unpacked under ${WORKER_PATHS.releases}; host apply runs only through the activator`,
    );
  if (!(await exists(join(root, WORKER_PATHS.bootstrapComplete))))
    return refuse("bootstrap_incomplete", "Bootstrap has not finished on this worker");
  const os = await operatingSystem(root);
  if (os?.id !== "amzn" || os.version_id !== "2023")
    return refuse("unsupported_base", "This worker is not Amazon Linux 2023");
  return checked;
}

/** Keeps the install's record current on the worker, as `host inspect` reads it. */
function recorder(system: ApplySystem, initial: HostApplyRecord) {
  let record = initial;
  const path = join(system.root, WORKER_PATHS.lastApply);
  return {
    current: () => record,
    async update(changes: Partial<HostApplyRecord>): Promise<HostApplyRecord> {
      record = { ...record, ...changes };
      await writeAtomically(path, `${hostApplyJson(record)}\n`);
      return record;
    },
  };
}

/** An error's code, such as EISDIR, in a form a document can carry. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unexpected error";
}

/** Opens a step's log afresh, readable by `fffactory-admin`. */
async function openLog(path: string): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const log = await open(path, "w", 0o644);
  try {
    await log.chmod(0o644);
  } catch (error) {
    await log.close();
    throw error;
  }
  return log;
}

/**
 * Runs one step from the release. Its output goes straight to its log as it runs, so a step
 * that hangs, or a `host apply` that is killed, still leaves what it printed; a last line
 * says how the step ended.
 */
async function runStep(
  system: ApplySystem,
  step: InstallStep,
  env: StepEnvironment,
): Promise<string | undefined> {
  const script = join(env.FFFACTORY_STEPS, `${step.name}.sh`);
  const path = join(WORKER_PATHS.logs, `${step.name}.log`);
  let log: FileHandle;
  try {
    log = await openLog(join(system.root, path));
  } catch (error) {
    return `its log ${path} could not be opened (${errorCode(error)})`;
  }
  try {
    const outcome = await system.run(["/bin/bash", script], step.timeoutMs, {
      env,
      output: log.fd,
    });
    const reason = failure(outcome, step.timeoutMs);
    const ended = reason === undefined ? "succeeded" : `failed: ${reason}`;
    await log.write(`--- fffactory: step ${step.name} ${ended}\n`);
    return reason;
  } finally {
    await log.close();
  }
}

/** Runs the steps in order, recording each, and stops at the first that fails. */
async function runSteps(
  system: ApplySystem,
  steps: readonly InstallStep[],
  env: StepEnvironment,
  record: ReturnType<typeof recorder>,
  doing: (what: string) => void,
): Promise<boolean> {
  for (const step of steps) {
    doing(`running step ${step.name}`);
    const reason = await runStep(system, step, env);
    doing("recording the install");
    const results: StepResult[] = withStep(
      record.current().steps,
      step.name,
      reason === undefined ? "succeeded" : "failed",
      reason ?? null,
    );
    await record.update({ steps: results });
    if (reason !== undefined) return false;
  }
  return true;
}

/**
 * Reads `stream` as text to its end, or until just past `limit` bytes, so an endless input
 * cannot exhaust memory; the projection's parser refuses anything that long.
 */
export async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel();
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit + 1));
}

/** Verification, or undefined when it did not finish within `timeoutMs`. */
async function verifyWithin(
  verifier: HostVerifier,
  timeoutMs: number,
): Promise<Verification | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([verifier.verify(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ends the install with `changes`, printed even when the record can no longer be kept. */
async function finish(
  record: ReturnType<typeof recorder>,
  changes: Partial<HostApplyRecord>,
): Promise<HostApplyRecord> {
  try {
    return await record.update(changes);
  } catch {
    return record.current();
  }
}

/**
 * Installs, holding the install lock: records the install, keeps the projection, makes the
 * release active, runs the steps, then verifies. Anything that throws on the way fails the
 * install with a reason in fffactory's own words, recorded as far as it can be, and printed.
 */
async function install(
  system: ApplySystem,
  verifier: HostVerifier,
  steps: readonly InstallStep[],
  verifyTimeoutMs: number,
  checked: Extract<Checked, { ok: true }>,
): Promise<HostApplyRecord> {
  const { root, release } = system;
  const releaseDirectory = join(root, WORKER_PATHS.releases, release);
  const record = recorder(system, {
    protocol_version: 1,
    hostname: tokenOr(system.hostname(), "unknown"),
    state: "running",
    release,
    configuration_sha256: sha256Text(checked.input),
    started_at: system.now().toISOString(),
    finished_at: null,
    steps: pendingSteps(steps),
    verification: null,
    failure: null,
  });
  const failed = (failure: string) =>
    finish(record, { state: "failed", failure, finished_at: system.now().toISOString() });
  let doing = "recording the install";
  try {
    await record.update({});
    doing = "keeping the host configuration";
    await writeAtomically(join(root, WORKER_PATHS.configuration), checked.input);
    doing = `making release ${release} active`;
    await makeActive(root, release);
    const env = stepEnvironment(system, checked.projection, releaseDirectory);
    const setDoing = (what: string) => {
      doing = what;
    };
    let verification: Verification | null = null;
    if (await runSteps(system, steps, env, record, setDoing)) {
      doing = "verifying";
      const verified = await verifyWithin(verifier, verifyTimeoutMs);
      if (verified === undefined)
        return failed(`verification did not finish within ${verifyTimeoutMs / 1000} s`);
      verification = verified;
    }
    doing = "recording the install";
    const { steps: results } = record.current();
    return await record.update({
      verification,
      state: installState(results, verification),
      finished_at: system.now().toISOString(),
    });
  } catch (error) {
    return failed(`host apply failed while ${doing} (${errorCode(error)})`);
  }
}

/** `host apply` on the worker `system` describes. */
export function workerApplier(
  system: ApplySystem,
  verifier: HostVerifier,
  steps: readonly InstallStep[] = INSTALL_STEPS,
  verifyTimeoutMs: number = VERIFY_TIMEOUT_MS,
): HostApplier {
  return {
    async apply() {
      const hostname = tokenOr(system.hostname(), "unknown");
      const refusal = (reason: RefusalReason, message: string): HostApplyResult => ({
        protocol_version: 1,
        hostname,
        state: "refused",
        reason,
        message,
      });
      if (!system.isRoot())
        return refusal("not_root", "host apply must run as root, through the activator");
      const lock = await system.lock(join(system.root, WORKER_PATHS.applyLock));
      if (lock === undefined)
        return refusal(
          "busy",
          "Another host apply is installing on this worker; wait for it to finish",
        );
      try {
        const checked = await preflight(system);
        if (!checked.ok) return refusal(checked.reason, checked.message);
        return await install(system, verifier, steps, verifyTimeoutMs, checked);
      } finally {
        lock.release();
      }
    },
  };
}
