/**
 * Apply's workers stage (`docs/specs/plan-apply.md` §The workers stage), run under the same
 * factory-wide lock and operation record as the infrastructure stage. For each declared
 * worker, one at a time: find it in the tailnet by the hostname-match rule, upload the
 * running release's tarball over SSH, and run the root activator with the digest the
 * executable embeds for it, streaming the host's projection (`projectHosts`, the one plan and
 * status digest) to `host apply` on standard input. `host apply` installs and verifies in one
 * process and answers with its record; a worker counts as installed only once that
 * verification completed. A known skip, such as an offline worker, leaves the others to be
 * attempted; an install or verification failure stops the rollout. Workers are reached only
 * over Tailscale SSH.
 *
 * A worker whose machine this apply's infrastructure stage created is waited for while it
 * boots (`docs/specs/plan-apply.md` §Waiting for a new worker): until it joins the tailnet and
 * its bootstrap finishes, within `FIRST_BOOT_DEADLINE_MS`, so one apply provisions, installs
 * and verifies it.
 */
import { activateCommand, UPLOAD_COMMAND } from "../domain/host-protocol";
import { type HostProjection, hostProjectionJson } from "../domain/host-projection";
import {
  ACTIVATION_TIMEOUT_MS,
  type ActivationAnswer,
  readActivation,
} from "../domain/installation";
import { preActivationDeferral } from "../domain/change-classification";
import type { HostKey, Release } from "../domain/instance";
import {
  activationOutcome,
  awaitsFirstBoot,
  FIRST_BOOT_DEADLINE_MS,
  FIRST_BOOT_POLL_MS,
  FIRST_BOOT_REPORT_MS,
  failed,
  failedAs,
  firstBootTimedOut,
  joiningTailnet,
  rolloutContinues,
  skipped,
  type WorkerIdentity,
  type WorkerOutcome,
} from "../domain/rollout";
import {
  connectionVerdict,
  locateWorker,
  type TailnetLocation,
  thenRerunApply,
} from "../domain/status";
import type { PeerView, WorkerAddress } from "../domain/tailnet";
import type { AssetBundle, WorkerRelease } from "./asset-bundle";
import type { Interrupted } from "./factory-lock";
import type { HostCommandOutcome, HostTransport } from "./host-transport";
import type { TailnetPeers } from "./tailnet-peers";

/** Long enough to upload a release tarball of tens of megabytes over a slow tailnet path. */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;

/** What the stage tells the operator while it works: first boots and installs take minutes. */
export type WorkerProgress =
  /** A worker this apply created has not finished its first boot: apply waits for it. */
  | (WorkerIdentity & { readonly kind: "waiting" })
  /** Every `FIRST_BOOT_REPORT_MS` of the wait, with what the worker showed last. */
  | (WorkerIdentity & {
      readonly kind: "still_waiting";
      readonly waitedMs: number;
      readonly lastSeen: string;
    })
  | (WorkerIdentity & { readonly kind: "uploading"; readonly bytes: number })
  | (WorkerIdentity & { readonly kind: "installing" });

export interface WorkersStageDependencies {
  readonly peers: TailnetPeers;
  readonly transport: HostTransport;
  readonly assets: Pick<AssetBundle, "workerRelease">;
  readonly interrupted: Interrupted;
  readonly progress: (event: WorkerProgress) => void;
  readonly clock: () => Date;
  /** Waits `ms`, or less once interrupted: the caller checks `interrupted` after it. */
  readonly sleep: (ms: number) => Promise<void>;
}

export interface WorkersStageRequest {
  /** factory.json's `tailscale.tag`, which each worker's device must carry. */
  readonly tag: string;
  /** The release factory.json pins, which the running fffactory is. */
  readonly release: Release;
  /**
   * Each declared worker's projection, in factory.json's order: the worker it names and exactly
   * what its `host apply` is sent. Build it with `projectHosts` from the instance. The type alone
   * does not stop a narrower projection, one without the Paseo secret reference (#132); the
   * pipeline test's clean rerun after an apply catches one.
   */
  readonly projections: readonly HostProjection[];
  /** Workers whose approved maintenance is deferred before release activation. */
  readonly deferred?: ReadonlySet<HostKey>;
  /** The workers whose machine this apply's infrastructure stage created: their first boot is waited for. */
  readonly created: readonly HostKey[];
}

export type WorkersStage =
  | { readonly kind: "done"; readonly outcomes: readonly WorkerOutcome[] }
  /**
   * Interrupted: nothing more was started; `outcomes` holds the workers that ended,
   * `installing` the worker whose `host apply` was running, which may still be installing, and
   * `waiting` the new worker whose first boot apply was waiting for, on which no install step ran.
   */
  | {
      readonly kind: "interrupted";
      readonly outcomes: readonly WorkerOutcome[];
      readonly installing: WorkerIdentity | undefined;
      readonly waiting?: WorkerIdentity;
    };

/** What one worker is sent: the release tarball, then its projection on `host apply`'s input. */
interface Delivery {
  readonly release: WorkerRelease;
  readonly projection: Uint8Array;
}

/** Called with every outcome so far, as each worker's ends, for the operation record. */
export type RecordOutcomes = (outcomes: readonly WorkerOutcome[]) => Promise<void>;

const CHECK_STATUS = "Check the worker with `fffactory status`";

/**
 * After a timeout or a dropped connection `host apply` may run on: wait for it. A rerun
 * before it ends skips the worker (the install lock), so it never overlaps the install.
 */
const MAY_STILL_BE_INSTALLING = "the worker may still be installing";
const WAIT_FOR_THE_INSTALL =
  "Wait for the install that may still be running on it to finish (`fffactory status` shows its record)";

/** Why the SSH command did not complete, for a worker that is known to be reachable. */
function transportFailure(
  worker: WorkerIdentity,
  outcome: Exclude<HostCommandOutcome, { readonly kind: "completed" }>,
  during: "upload" | "install",
): WorkerOutcome {
  switch (outcome.kind) {
    case "not_started":
      return failed(worker, `ssh could not be started (${outcome.code})`, CHECK_STATUS);
    case "timed_out":
      return during === "upload"
        ? skipped(worker, {
            summary: `The upload did not finish within ${UPLOAD_TIMEOUT_MS / 60_000} min`,
            nextAction: thenRerunApply(
              `Check the connection to the worker with \`tailscale ping ${worker.hostname}\``,
            ),
          })
        : failed(
            worker,
            `host apply did not answer within ${ACTIVATION_TIMEOUT_MS / 60_000} min; ${MAY_STILL_BE_INSTALLING}`,
            WAIT_FOR_THE_INSTALL,
          );
    case "unreachable":
      if (during === "install")
        return failed(
          worker,
          `The connection dropped during the install (${outcome.reason}); ${MAY_STILL_BE_INSTALLING}`,
          WAIT_FOR_THE_INSTALL,
        );
      return skipped(worker, connectionVerdict(outcome, worker.hostname, thenRerunApply));
    default: {
      // Refused logins before anything changed are known skips; after the upload, failures.
      const verdict = connectionVerdict(outcome, worker.hostname, thenRerunApply);
      return during === "upload" ? skipped(worker, verdict) : failedAs(worker, verdict);
    }
  }
}

/**
 * An interrupt, naming the worker whose `host apply` it left running, if any, or the new
 * worker whose first boot apply was waiting for.
 */
interface Interruption {
  readonly interrupted: WorkerIdentity | undefined;
  readonly waiting?: WorkerIdentity;
}

/** Uploads the release tarball; undefined once it is on the worker. */
async function upload(
  deps: WorkersStageDependencies,
  worker: WorkerIdentity,
  address: WorkerAddress,
  { release }: Delivery,
): Promise<WorkerOutcome | Interruption | undefined> {
  deps.progress({ kind: "uploading", ...worker, bytes: release.tarball.length });
  const uploaded = await deps.transport.run(address, UPLOAD_COMMAND, {
    timeoutMs: UPLOAD_TIMEOUT_MS,
    stdin: release.tarball,
  });
  if (deps.interrupted()) return { interrupted: undefined };
  if (uploaded.kind !== "completed") return transportFailure(worker, uploaded, "upload");
  if (uploaded.exitCode !== 0)
    return failed(
      worker,
      `Uploading the release failed: dd exited with status ${uploaded.exitCode}`,
      `Check the free space in /home/fffactory-admin on ${worker.hostname}`,
    );
  return undefined;
}

/** Runs the activator on the uploaded tarball: `host apply`'s answer, or why there is none. */
async function activate(
  deps: WorkersStageDependencies,
  worker: WorkerIdentity,
  address: WorkerAddress,
  { release, projection }: Delivery,
): Promise<WorkerOutcome | Interruption | ActivationAnswer> {
  const activation = await deps.transport.run(address, activateCommand(release.sha256), {
    timeoutMs: ACTIVATION_TIMEOUT_MS,
    stdin: projection,
  });
  // Stopping ssh leaves `host apply` running on the worker.
  if (deps.interrupted()) return { interrupted: worker };
  if (activation.kind !== "completed") return transportFailure(worker, activation, "install");
  return readActivation(activation.exitCode, activation.stdout);
}

function isAnswer(
  value: WorkerOutcome | Interruption | ActivationAnswer,
): value is ActivationAnswer {
  return "kind" in value && (value.kind === "result" || value.kind === "no_result");
}

/** Uploads, then activates; the worker's outcome. */
async function install(
  deps: WorkersStageDependencies,
  worker: WorkerIdentity,
  address: WorkerAddress,
  delivery: Delivery,
  request: WorkersStageRequest,
): Promise<WorkerOutcome | Interruption> {
  const stopped = await upload(deps, worker, address, delivery);
  if (stopped !== undefined) return stopped;
  deps.progress({ kind: "installing", ...worker });
  const answer = await activate(deps, worker, address, delivery);
  return isAnswer(answer) ? activationOutcome(worker, request.release, answer) : answer;
}

/** A booting worker's progress: when its wait began, how many looks it took, and its upload. */
interface FirstBoot {
  readonly start: number;
  polls: number;
  reportedMs: number;
  uploaded: boolean;
}

/**
 * One look at a new worker where the tailnet shows it: uploads the release once, then
 * activates. Its outcome, or what it shows while its bootstrap has not finished.
 */
async function lookAtBootedWorker(
  deps: WorkersStageDependencies,
  worker: WorkerIdentity,
  address: WorkerAddress,
  delivery: Delivery,
  request: WorkersStageRequest,
  boot: FirstBoot,
): Promise<WorkerOutcome | Interruption | { readonly booting: string }> {
  if (!boot.uploaded) {
    const stopped = await upload(deps, worker, address, delivery);
    if (stopped !== undefined) return stopped;
    boot.uploaded = true;
    deps.progress({ kind: "installing", ...worker });
  }
  const answer = await activate(deps, worker, address, delivery);
  if (!isAnswer(answer)) return answer;
  // The tarball stays where it was uploaded, so the next look only activates it again.
  if (awaitsFirstBoot(worker, answer)) return { booting: "Its bootstrap has not finished" };
  return activationOutcome(worker, request.release, answer);
}

/** What one look at a new worker found: its outcome, or what it shows while it boots. */
type Look = WorkerOutcome | Interruption | { readonly booting: string };

/**
 * One look at a new worker: installed once the tailnet shows it, still booting while it is
 * joining the tailnet, and refused at once for anything else.
 */
async function look(
  deps: WorkersStageDependencies,
  worker: WorkerIdentity,
  location: TailnetLocation,
  delivery: Delivery,
  request: WorkersStageRequest,
  boot: FirstBoot,
): Promise<Look> {
  if (location.kind === "found")
    return lookAtBootedWorker(deps, worker, location.worker, delivery, request, boot);
  if (joiningTailnet(location)) return { booting: location.verdict.summary };
  return skipped(worker, location.verdict);
}

/** Says that apply waits for the worker, then every `FIRST_BOOT_REPORT_MS` what it sees. */
function reportWait(
  deps: WorkersStageDependencies,
  worker: WorkerIdentity,
  boot: FirstBoot,
  waitedMs: number,
  lastSeen: string,
): void {
  if (boot.polls === 0) {
    deps.progress({ kind: "waiting", ...worker });
    return;
  }
  if (waitedMs - boot.reportedMs < FIRST_BOOT_REPORT_MS) return;
  boot.reportedMs = waitedMs;
  deps.progress({ kind: "still_waiting", ...worker, waitedMs, lastSeen });
}

/** Sleeps one poll, then reads the tailnet afresh: where the worker is, or undefined once interrupted. */
async function nextLocation(
  deps: WorkersStageDependencies,
  worker: WorkerIdentity,
  request: WorkersStageRequest,
  boot: FirstBoot,
): Promise<TailnetLocation | undefined> {
  await deps.sleep(FIRST_BOOT_POLL_MS);
  boot.polls += 1;
  if (deps.interrupted()) return undefined;
  const view = await deps.peers.view();
  if (deps.interrupted()) return undefined;
  return locateWorker(view, worker.hostname, request.tag, thenRerunApply);
}

/**
 * Waits for a worker this apply created, looking every `FIRST_BOOT_POLL_MS`: until it joins
 * the tailnet and its bootstrap has finished, when it is installed, or until
 * `FIRST_BOOT_DEADLINE_MS`, when it fails with the failed first boot's recovery. A duplicate
 * name, an untagged device or an unavailable peer view is refused at once, never waited out.
 */
async function awaitFirstBoot(
  deps: WorkersStageDependencies,
  worker: WorkerIdentity,
  first: TailnetLocation,
  delivery: Delivery,
  request: WorkersStageRequest,
): Promise<WorkerOutcome | Interruption> {
  const boot: FirstBoot = {
    start: deps.clock().getTime(),
    polls: 0,
    reportedMs: 0,
    uploaded: false,
  };
  let location = first;
  for (;;) {
    const seen = await look(deps, worker, location, delivery, request, boot);
    if (!("booting" in seen)) return seen;
    // Every look after the first sleeps a poll, so a stalled clock cannot stretch the wait.
    const waitedMs = Math.max(deps.clock().getTime() - boot.start, boot.polls * FIRST_BOOT_POLL_MS);
    if (waitedMs >= FIRST_BOOT_DEADLINE_MS) return firstBootTimedOut(worker, seen.booting);
    reportWait(deps, worker, boot, waitedMs, seen.booting);
    const next = await nextLocation(deps, worker, request, boot);
    if (next === undefined) return { interrupted: undefined, waiting: worker };
    location = next;
  }
}

/** One worker: found in the tailnet, then installed; or why not. */
async function attempt(
  deps: WorkersStageDependencies,
  worker: WorkerIdentity,
  view: PeerView,
  delivery: Delivery,
  request: WorkersStageRequest,
): Promise<WorkerOutcome | Interruption> {
  const location = locateWorker(view, worker.hostname, request.tag, thenRerunApply);
  if (request.deferred?.has(worker.key) === true)
    return skipped(worker, preActivationDeferral(worker.hostname));
  if (request.created.includes(worker.key))
    return awaitFirstBoot(deps, worker, location, delivery, request);
  // Missing for any other reason is not a first boot: skipped, never waited out.
  if (location.kind === "blocked") return skipped(worker, location.verdict);
  return install(deps, worker, location.worker, delivery, request);
}

/** Every worker skipped: this fffactory has nothing to install. */
function noWorkerExecutable(workers: readonly WorkerIdentity[]): WorkersStage {
  return {
    kind: "done",
    outcomes: workers.map((worker) =>
      skipped(worker, {
        summary:
          "This fffactory carries no worker executable: it runs from source, not from a built release",
        nextAction: thenRerunApply("Install the workers with a built fffactory (`just build`)"),
      }),
    ),
  };
}

/** The stage, interrupted after `outcomes`, naming the worker the interruption concerned. */
function interruptedAt(
  outcomes: readonly WorkerOutcome[],
  interruption: Interruption,
): WorkersStage {
  return {
    kind: "interrupted",
    outcomes,
    installing: interruption.interrupted,
    ...(interruption.waiting === undefined ? {} : { waiting: interruption.waiting }),
  };
}

/** The workers stage: every declared worker, in factory.json's order, one at a time. */
export async function applyWorkers(
  deps: WorkersStageDependencies,
  request: WorkersStageRequest,
  record: RecordOutcomes,
): Promise<WorkersStage> {
  const workers = request.projections.map((projection) => ({
    worker: { key: projection.host_key, hostname: projection.hostname },
    projection: new TextEncoder().encode(hostProjectionJson(projection)),
  }));
  const release = await deps.assets.workerRelease();
  if (release === undefined) return noWorkerExecutable(workers.map(({ worker }) => worker));
  const view = await deps.peers.view();
  const outcomes: WorkerOutcome[] = [];
  for (const { worker, projection } of workers) {
    if (deps.interrupted()) return { kind: "interrupted", outcomes, installing: undefined };
    const stopped = outcomes.some((outcome) => !rolloutContinues(outcome));
    const outcome: WorkerOutcome | Interruption = stopped
      ? { ...worker, kind: "not_attempted" }
      : await attempt(deps, worker, view, { release, projection }, request);
    if ("interrupted" in outcome) return interruptedAt(outcomes, outcome);
    outcomes.push(outcome);
    await record([...outcomes]);
  }
  return { kind: "done", outcomes };
}
