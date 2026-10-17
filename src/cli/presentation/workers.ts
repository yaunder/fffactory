/**
 * One worker's outcome in apply's Result, across every stage that ran for it, and the steps
 * that enroll its accounts in the Next block (`docs/specs/plan-apply.md` §Apply,
 * `docs/specs/readiness.md` §Where it is reported). The domain and the stages decide each
 * outcome and what is still to enroll; this lays it out.
 */
import type { ControlPlaneOutcome } from "../../application/apply-control-plane";
import type { DispatchOutcome } from "../../application/apply-dispatch";
import type { RepositoryOutcome } from "../../application/apply-repositories";
import type { HostKey } from "../../domain/instance";
import {
  ENROLLMENTS,
  enrollmentReport,
  pendingCount,
  RUNTIME_ACCOUNT,
  type WorkerEnrollment,
  workerEnrollment,
} from "../../domain/readiness";
import type { WorkerOutcome } from "../../domain/rollout";
import { type Inline, type NextPart, type Row, step, verbatim } from "./blocks";
import { fffactoryCommand, type Selection } from "./command-line";
import type { Status } from "./style";

/** Each later stage's label, in the plan's order. */
const STAGES = {
  controlPlane: "Control plane",
  repositories: "Repositories",
  dispatch: "Dispatch",
};
/** Every worker's stages align, whichever ran for it. */
const STAGE_WIDTH = Math.max(...Object.values(STAGES).map((label) => Bun.stringWidth(label)));

/** The later stages' outcomes for one worker, those that ran. */
export interface LaterStages {
  readonly controlPlane?: ControlPlaneOutcome | undefined;
  readonly repositories?: RepositoryOutcome | undefined;
  readonly dispatch?: DispatchOutcome | undefined;
}

/**
 * How much a status asks of the operator, so a worker shows its worst stage: a failure, then
 * action needed, then a skip, then ready. A stage with no status, such as dispatch not
 * requested, asks nothing.
 */
const WEIGHT: Partial<Record<Status, number>> = { error: 4, attention: 3, skipped: 2, ready: 1 };

const worst = (statuses: readonly (Status | undefined)[]): Status | undefined =>
  statuses.reduce<Status | undefined>(
    (worse, status) =>
      status !== undefined && (WEIGHT[status] ?? 0) > (worse ? (WEIGHT[worse] ?? 0) : 0)
        ? status
        : worse,
    undefined,
  );

/**
 * An installed worker's enrollment, named for the hostname the CLI resolved, with the accounts
 * its projection delivered; none otherwise.
 */
export function workerEnrollmentOf(outcome: WorkerOutcome): WorkerEnrollment | undefined {
  if (outcome.kind !== "installed") return undefined;
  return workerEnrollment(
    enrollmentReport(outcome.verification, outcome.hostname, outcome.delivered),
    outcome.hostname,
  );
}

/** A worker's own stage outcome: a status, and what happened. */
interface Outcome {
  readonly status?: Status;
  readonly value: Inline;
}

/** `word · SUMMARY`: a summary is data, never read for inline code. */
const said = (word: string, summary: string): Inline => [`${word} · `, verbatim(summary)];

function workersOutcome(outcome: WorkerOutcome, selection: Selection): Outcome {
  switch (outcome.kind) {
    case "installed": {
      const enrollment = workerEnrollmentOf(outcome);
      const pending = enrollment === undefined ? 0 : pendingCount(enrollment);
      return pending === 0
        ? { status: "ready", value: "installed and verified · every account enrolled" }
        : {
            status: "attention",
            value: [
              "installed and verified · ",
              { text: `enrollment pending (${pending})`, tone: "attention" },
            ],
          };
    }
    case "skipped":
      return { status: "skipped", value: said("skipped", outcome.summary) };
    case "failed":
      return { status: "error", value: said("failed", outcome.summary) };
    case "not_attempted":
      return {
        status: "not_attempted",
        value: "not attempted · the rollout stopped at the failure above",
      };
    case "stopped":
      return {
        status: "stopped",
        value: [
          "stopped · nothing was sent to it; to install it, start it with ",
          { text: fffactoryCommand(["worker", "start", outcome.key], selection), tone: "code" },
          ", then apply again",
        ],
      };
  }
}

/** A later stage's skip: its summary, unless the workers stage's skip already said it. */
const skippedValue = (summary: string, worker: WorkerOutcome): Inline =>
  worker.kind === "skipped" && worker.summary === summary ? "skipped" : said("skipped", summary);

function controlPlaneRow(outcome: ControlPlaneOutcome): Row | undefined {
  const label = STAGES.controlPlane;
  switch (outcome.kind) {
    case "applied":
      return { status: "ready", label, value: "applied" };
    case "deferred":
      return { status: "attention", label, value: said("deferred", outcome.summary) };
    case "failed":
      return { status: "error", label, value: said("failed", outcome.summary) };
    case "stopped":
      return undefined;
  }
}

function repositoriesRow(outcome: RepositoryOutcome, worker: WorkerOutcome): Row | undefined {
  const label = STAGES.repositories;
  switch (outcome.kind) {
    case "synchronized":
      return { status: "ready", label, value: "synchronized" };
    case "unresolved":
      return { status: "attention", label, value: said("unresolved", outcome.summary) };
    case "skipped":
      return { status: "skipped", label, value: skippedValue(outcome.summary, worker) };
    case "stopped":
      return undefined;
  }
}

function dispatchRow(outcome: DispatchOutcome, worker: WorkerOutcome): Row | undefined {
  const label = STAGES.dispatch;
  switch (outcome.kind) {
    case "active":
      return { status: "ready", label, value: "active" };
    case "not_requested":
      return { label, value: "not requested" };
    case "pending": {
      const blocking = outcome.blocking.map((gate) => gate.summary).join("; ");
      return {
        status: "attention",
        label,
        value: blocking === "" ? "pending" : said("pending", blocking),
      };
    }
    case "failed":
      return { status: "error", label, value: said("failed", outcome.summary) };
    case "skipped":
      return { status: "skipped", label, value: skippedValue(outcome.summary, worker) };
    case "stopped":
      return undefined;
  }
}

/**
 * A worker's row in the Result: its key, its workers-stage outcome, and under it each later
 * stage that ran for it, in the plan's order. Its status is its worst stage's, so a worker
 * whose enrollment is pending, or whose later stage is pending or failed, is never shown ready.
 * A stopped worker was sent nothing: how to install it repeats the instance and profile given.
 */
export function workerRow(outcome: WorkerOutcome, later: LaterStages, selection: Selection): Row {
  const own = workersOutcome(outcome, selection);
  const stages = [
    later.controlPlane && controlPlaneRow(later.controlPlane),
    later.repositories && repositoriesRow(later.repositories, outcome),
    later.dispatch && dispatchRow(later.dispatch, outcome),
  ].filter((row): row is Row => row !== undefined);
  const status = worst([own.status, ...stages.map((row) => row.status)]) ?? own.status;
  return {
    ...(status === undefined ? {} : { status }),
    label: outcome.key,
    value: own.value,
    ...(stages.length === 0
      ? {}
      : { details: [{ kind: "rows", rows: stages, labelWidth: STAGE_WIDTH, statusColumn: true }] }),
  };
}

/** One worker's enrollment, by its key. */
export interface KeyedEnrollment {
  readonly key: HostKey;
  readonly enrollment: WorkerEnrollment;
}

/**
 * Each delivered credential some worker did not accept, once for every worker, in
 * `ENROLLMENTS`' order: the workers, and the `fffactory secret set` that replaces it, with the
 * instance and profile given. The credential is factory-wide, so one replacement serves them all.
 */
export function deliveredSteps(
  enrollments: readonly KeyedEnrollment[],
  selection: Selection,
): NextPart[] {
  return ENROLLMENTS.flatMap(({ id, credential, secret }) => {
    const keys = enrollments
      .filter(({ enrollment }) => enrollment.delivered.some((entry) => entry.id === id))
      .map(({ key }) => key);
    return keys.length === 0
      ? []
      : [
          step(`Replace the ${credential}, which ${keys.join(", ")} did not accept:`, [
            fffactoryCommand(["secret", "set", secret], selection),
          ]),
        ];
  });
}

/** What logging in requires, said once with the login. */
const REQUIREMENTS: Readonly<Record<WorkerEnrollment["requirement"], string>> = {
  tailnet_ssh_as_runtime: "tailnet SSH policy must allow it",
};

/**
 * A worker's enrollment in a Next block: the login once, with what it requires, then each
 * account still to enroll, numbered, with its command lines. `named` names the worker, when
 * the block's title does not.
 */
export function enrollmentSteps(
  enrollment: WorkerEnrollment,
  key: string,
  named: boolean,
): NextPart[][] {
  const login = `as ${RUNTIME_ACCOUNT} (${REQUIREMENTS[enrollment.requirement]}):`;
  return [
    [step(named ? `On ${key}, log in ${login}` : `Log in ${login}`, [enrollment.login])],
    [
      {
        kind: "numbered",
        groups: enrollment.accounts.map(({ title, commands }) => ({ title, commands })),
      },
    ],
  ];
}
