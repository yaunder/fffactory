/**
 * The workers stage's outcomes (`docs/specs/plan-apply.md` §The workers stage): what an
 * install attempt means for one worker, and the rollout rule. A known skip, such as an
 * offline worker, leaves the others to be attempted; an unexpected install or verification
 * failure stops the rollout before later workers are touched. And the rules of the wait for
 * a worker whose machine apply just created (§Waiting for a new worker). Pure.
 */
import {
  type ActivationAnswer,
  failedStep,
  type HostApplyRecord,
  type HostApplyRefusal,
  type HostApplyResult,
} from "./installation";
import type { HostKey } from "./instance";
import type { Verification } from "./readiness";
import { ADMIN_CONSOLE, type TailnetLocation, thenRerunApply, type Verdict } from "./status";
import { WORKER_ADMIN, WORKER_PATHS } from "./host-protocol";

export interface WorkerIdentity {
  readonly key: HostKey;
  readonly hostname: string;
}

export type WorkerOutcome =
  /** Installed and verified; its enrollment may still be pending. */
  | (WorkerIdentity & {
      readonly kind: "installed";
      readonly release: string;
      readonly verification: Verification;
    })
  /** Not attempted for a known reason that does not stop the rollout. */
  | (WorkerIdentity & {
      readonly kind: "skipped";
      readonly summary: string;
      readonly nextAction: string;
    })
  /**
   * The install or its verification failed: the rollout stops here. Or, `beforeInstall`, the
   * worker's new machine never finished its first boot: no install step ran on it, so the
   * rollout goes on.
   */
  | (WorkerIdentity & {
      readonly kind: "failed";
      readonly summary: string;
      readonly nextAction: string;
      readonly beforeInstall?: true;
    })
  /** After a failure, never touched. */
  | (WorkerIdentity & { readonly kind: "not_attempted" });

export function skipped(worker: WorkerIdentity, verdict: Pick<Verdict, "summary" | "nextAction">) {
  return {
    ...worker,
    kind: "skipped",
    summary: verdict.summary,
    nextAction: verdict.nextAction ?? thenRerunApply("Check the worker with `fffactory status`"),
  } as const satisfies WorkerOutcome;
}

export function failed(worker: WorkerIdentity, summary: string, action: string) {
  return { ...worker, kind: "failed", summary, nextAction: thenRerunApply(action) } as const;
}

/** A failure the verdict describes, its next action already complete. */
export function failedAs(worker: WorkerIdentity, verdict: Pick<Verdict, "summary" | "nextAction">) {
  return { ...skipped(worker, verdict), kind: "failed" } as const satisfies WorkerOutcome;
}

/**
 * Whether the rollout goes on to the next worker after this one: it stops at a failed install
 * or verification, which the next worker's could repeat, but not at a first boot that never
 * finished, which is that machine's alone.
 */
export function rolloutContinues(outcome: WorkerOutcome): boolean {
  return outcome.kind !== "failed" || outcome.beforeInstall === true;
}

/**
 * How the rollout ended: `installed` when every worker was, `failed` when one failed, and
 * `partial` when some were skipped.
 */
export function rolloutResult(
  outcomes: readonly WorkerOutcome[],
): "installed" | "partial" | "failed" {
  if (outcomes.some((outcome) => outcome.kind === "failed")) return "failed";
  return outcomes.every((outcome) => outcome.kind === "installed") ? "installed" : "partial";
}

const CHECK_STATUS = "Check the worker with `fffactory status`";

/** Reading a step's log needs no privilege: it is readable by `fffactory-admin`. */
function stepLog(hostname: string, step: string): string {
  return `\`tailscale ssh ${WORKER_ADMIN}@${hostname} cat ${WORKER_PATHS.logs}/${step}.log\``;
}

/** A document that answers for another worker or release is not this install's. */
function foreignAnswer(
  worker: WorkerIdentity,
  release: string,
  result: HostApplyResult,
): WorkerOutcome | undefined {
  if (result.hostname.toLowerCase() !== worker.hostname.toLowerCase())
    return failed(
      worker,
      `host apply answered as ${result.hostname}, not ${worker.hostname}; nothing it reported is trusted`,
      `Check at ${ADMIN_CONSOLE} that the device ${worker.hostname} is this factory's worker`,
    );
  if (result.state !== "refused" && result.release !== release)
    return failed(
      worker,
      `host apply installed release ${result.release}, not ${release}`,
      CHECK_STATUS,
    );
  return undefined;
}

/** What `host apply`'s refusal means: a known wait is a skip; anything else a failure. */
function refusalOutcome(worker: WorkerIdentity, result: HostApplyRefusal): WorkerOutcome {
  switch (result.reason) {
    case "bootstrap_incomplete":
      return skipped(worker, {
        summary: "Its bootstrap has not finished",
        nextAction: thenRerunApply("Wait for its first boot to finish"),
      });
    case "busy":
      return skipped(worker, {
        summary: `An install is still running on ${worker.hostname}`,
        nextAction: thenRerunApply("Wait for it to finish (`fffactory status` shows when it has)"),
      });
    default:
      return failed(worker, `host apply refused: ${result.message}`, "Fix what host apply names");
  }
}

/** Why a finished install failed: a step, a failure outside the steps, or failed checks. */
function failureOutcome(worker: WorkerIdentity, result: HostApplyRecord): WorkerOutcome {
  const step = failedStep(result.steps);
  if (step !== undefined)
    return failed(
      worker,
      `Step ${step.name} failed: ${step.reason}; release ${result.release} is active but unhealthy`,
      `Read its output with ${stepLog(worker.hostname, step.name)} and fix the cause; the steps are idempotent, so rerunning repairs the worker`,
    );
  if (result.failure !== null)
    return failed(
      worker,
      `${result.failure}; release ${result.release} may be active but unhealthy`,
      "Fix what host apply names; rerunning repairs the worker",
    );
  const checks = (result.verification?.checks ?? [])
    .filter((check) => check.status === "failed")
    .map((check) => check.summary);
  return failed(
    worker,
    `Verification failed: ${checks.join("; ")}; release ${result.release} is active but unhealthy`,
    "Fix what verification names; rerunning repairs the worker",
  );
}

/**
 * What the activator's answer means for the worker installing `release`. Only a document for
 * this worker and release counts.
 */
export function activationOutcome(
  worker: WorkerIdentity,
  release: string,
  answer: ActivationAnswer,
): WorkerOutcome {
  if (answer.kind === "no_result")
    return failed(worker, `Installing failed: ${answer.reason}`, CHECK_STATUS);
  const { result } = answer;
  const foreign = foreignAnswer(worker, release, result);
  if (foreign !== undefined) return foreign;
  switch (result.state) {
    case "refused":
      return refusalOutcome(worker, result);
    case "running":
      return failed(worker, "host apply ended before its install finished", CHECK_STATUS);
    case "failed":
      return failureOutcome(worker, result);
    case "succeeded":
      return result.verification === null
        ? failed(worker, "host apply reported success without verifying", CHECK_STATUS)
        : {
            ...worker,
            kind: "installed",
            release: result.release,
            verification: result.verification,
          };
  }
}

/**
 * How long apply waits for a worker whose machine it just created to finish its first boot
 * (`docs/specs/plan-apply.md` §Waiting for a new worker). A first boot usually takes a few
 * minutes: EC2 boots and cloud-init runs the bootstrap, whose `dnf` installs (up to 75 s of
 * RPM-lock backoff besides their downloads) and wait for a Tailscale address (up to 60 s) are
 * its long steps. Fifteen minutes is several times that, and a bootstrap still unfinished then
 * has failed or is stuck.
 */
export const FIRST_BOOT_DEADLINE_MS = 15 * 60_000;

/** Between two looks at a booting worker: the tailnet view, or its activator. */
export const FIRST_BOOT_POLL_MS = 15_000;

/** How often apply says it is still waiting. */
export const FIRST_BOOT_REPORT_MS = 60_000;

/**
 * Whether a worker's place in the tailnet is what a booting worker shows before Tailscale is
 * up on it: no device yet, the device still offline, or no Tailscale SSH host key or address
 * listed yet. A duplicate name, a device without the factory's tag or an unavailable peer
 * view are refused at once: waiting never makes a guess safe.
 */
export function joiningTailnet(location: TailnetLocation): boolean {
  return (
    location.kind === "blocked" &&
    (location.tailnet === "missing" ||
      location.tailnet === "offline" ||
      location.tailnet === "no_ssh")
  );
}

/** Whether the activator's answer is this worker's `host apply` refusing an unfinished bootstrap. */
export function awaitsFirstBoot(worker: WorkerIdentity, answer: ActivationAnswer): boolean {
  return (
    answer.kind === "result" &&
    answer.result.state === "refused" &&
    answer.result.reason === "bootstrap_incomplete" &&
    answer.result.hostname.toLowerCase() === worker.hostname.toLowerCase()
  );
}

/**
 * A new worker whose first boot did not finish in time, `lastSeen` being what it showed last:
 * a failure, with the failed first boot's recovery (`docs/specs/worker-bootstrap.md`
 * §Failed first boot). No install step ran on it, though the release may have been uploaded
 * and unpacked there, so the rollout goes on.
 */
export function firstBootTimedOut(worker: WorkerIdentity, lastSeen: string): WorkerOutcome {
  return {
    ...failed(
      worker,
      `Its first boot did not finish within ${FIRST_BOOT_DEADLINE_MS / 60_000} min (last seen: ${lastSeen})`,
      "Read the bootstrap in the instance's EC2 console output, and check that tailnet policy " +
        "lets this device see the factory's tag. If the bootstrap failed, terminate the " +
        "instance in the EC2 console and wait until it is terminated; if it is still running, " +
        "wait for it to finish",
    ),
    beforeInstall: true,
  };
}
