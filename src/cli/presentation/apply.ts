/**
 * Apply's and upgrade's run after the plan is approved (`docs/specs/plan-apply.md` §Apply,
 * §Failure, §Interruption, §Upgrade): the Applying section's rows, streamed as Terraform and
 * each worker progress; the Result, laid out from the complete `FactoryApply`, each line on the
 * stream it goes to; and the one Next block collecting what every stage leaves for the operator,
 * after the operation record, any diagnostics and an upgrade's pin notice. The stages decide
 * every outcome and its published next action; this lays them out, saying each once.
 */
import type { FactoryApply } from "../../application/apply-factory";
import type { WorkerProgress } from "../../application/apply-workers";
import { type DispatchGate, dispatchNextActions } from "../../domain/dispatch-readiness";
import type { HostKey } from "../../domain/instance";
import { changeTally, type PlanReview } from "../../domain/plan";
import { PASEO_CLIENTS, pendingCount } from "../../domain/readiness";
import { FIRST_BOOT_DEADLINE_MS, type WorkerOutcome } from "../../domain/rollout";
import {
  type Block,
  type Inline,
  type Next,
  type NextPart,
  type Report,
  type Row,
  render,
  renderInSection,
  renderNextParts,
  step,
  verbatim,
} from "./blocks";
import { fffactoryCommand, type Selection } from "./command-line";
import type { Style } from "./style";
import {
  deliveredSteps,
  enrollmentSteps,
  type KeyedEnrollment,
  workerEnrollmentOf,
  workerRow,
} from "./workers";

type Applied = Extract<FactoryApply, { readonly kind: "applied" }>;
type Failed = Extract<FactoryApply, { readonly kind: "failed" }>;
type Interrupted = Extract<FactoryApply, { readonly kind: "interrupted" }>;
type Bootstrapped = Extract<FactoryApply, { readonly kind: "bootstrapped" }>;
/** The runs that applied nothing and took no lock, refused as a plan's refusals are. */
type RefusedRun = Extract<
  FactoryApply,
  { readonly kind: "declined" | "configuration_changed" | "no_state_bucket" }
>;

/**
 * How a run is reported: the action, such as `apply`, the command a rerun uses, `apply`, or
 * `upgrade` for an upgrade whose pin was not moved, the instance and profile the command was
 * given, which every command it names repeats, an upgrade's pin: whether it moved to
 * `release`, and whether the plan was a saved one named by its ID (`--plan-id`); otherwise it
 * was made in this run, and its ID never shown.
 */
export interface ApplyReporting {
  readonly action: "apply" | "upgrade";
  readonly rerun: "apply" | "upgrade";
  readonly selection: Selection;
  readonly pin?: { readonly moved: boolean; readonly release: string } | undefined;
  readonly savedPlan?: boolean;
}

/** An output stream: standard output or standard error. */
type Stream = "out" | "err";
/** A line laid out for the stream it is written to. */
export interface StreamLine {
  readonly stream: Stream;
  readonly line: string;
}
/** Each stream's style. */
type Styles = Readonly<Record<Stream, Style>>;

/** The `fffactory` command `words` names, with the instance and profile given. */
const command = (words: readonly string[], { selection }: ApplyReporting): string =>
  fffactoryCommand(words, selection);

// Applying

/** The Applying section's rule, its rows streamed under it as they come. */
export const applyingSection = (): Block => ({ kind: "section", title: "Applying", blocks: [] });

/** One Applying row, its label padded to `labelWidth` so rows streamed one at a time align. */
export const applyingRow = (row: Row, labelWidth: number): Block => ({
  kind: "rows",
  rows: [row],
  labelWidth,
});

const INFRASTRUCTURE = "Infrastructure";

/**
 * Whether Terraform applies anything for `review`: backend bootstrap always creates, and a
 * factory plan creating the log archive applies the archive root.
 */
const terraformApplies = (review: PlanReview): boolean =>
  review.kind === "backend_bootstrap" ||
  review.archive?.creates === true ||
  changeTally(review.changes).changing > 0;

/** The widest label `review`'s Applying rows can have: Terraform's, the pin's, each worker's. */
export function applyingLabelWidth(review: PlanReview): number {
  const labels = [
    ...(terraformApplies(review) ? [INFRASTRUCTURE] : []),
    ...(review.kind === "factory" && review.pinMove !== undefined ? ["Pin"] : []),
    ...(review.kind === "factory" ? review.workers.map(({ key }) => key) : []),
  ];
  return Math.max(0, ...labels.map((label) => Bun.stringWidth(label)));
}

/** Terraform applying `review`'s changes, when it has any. */
export function infrastructureApplyingRow(review: PlanReview): Row | undefined {
  if (!terraformApplies(review)) return undefined;
  return {
    label: INFRASTRUCTURE,
    value: "applying with Terraform (its output is not shown; can take several minutes)",
  };
}

/** An upgrade's pin, written once approved, before anything is applied. */
export const pinnedRow = (release: string): Row => ({
  label: "Pin",
  value: `factory.json now pins release ${release}`,
});

const FIRST_BOOT_MINUTES = FIRST_BOOT_DEADLINE_MS / 60_000;

/** A worker's progress: its key, never its hostname again, and what it is doing. */
export function progressRow(event: WorkerProgress): Row {
  const label = event.key;
  switch (event.kind) {
    case "waiting":
      return {
        label,
        value: `waiting for its first boot (up to ${FIRST_BOOT_MINUTES} min): this apply just created its machine`,
      };
    case "still_waiting":
      return {
        label,
        value: [
          `still waiting after ${Math.floor(event.waitedMs / 60_000)} of up to ${FIRST_BOOT_MINUTES} min: `,
          verbatim(event.lastSeen),
        ],
      };
    case "uploading":
      return { label, value: `uploading ${(event.bytes / 1024 ** 2).toFixed(1)} MiB` };
    case "installing":
      return { label, value: "installing and verifying (can take many minutes)" };
  }
}

/** A saved plan, approved by naming its ID: nothing is asked. */
export const savedPlanApproved = (planId: string): Block => ({
  kind: "text",
  lines: [`Applying saved plan ${planId}, approved by naming its ID.`],
});

// Routing

/** A row of the Result, on its stream. */
interface Routed {
  readonly stream: Stream;
  readonly row: Row;
}

/** Something said within a section, on its stream; `continues` the rows block before it. */
interface SectionItem {
  readonly stream: Stream;
  readonly block: Block;
  readonly continues?: boolean;
}

/** A Next block's part, on its stream. */
interface RoutedPart {
  readonly stream: Stream;
  readonly part: NextPart;
}

/** A Next block whose parts may go to two streams. */
interface RoutedNext {
  readonly title?: Inline;
  readonly paragraphs: readonly (readonly RoutedPart[])[];
}

/** `next`, every part on `stream`. */
const onStream = (stream: Stream, next: Next): RoutedNext => ({
  ...(next.title === undefined ? {} : { title: next.title }),
  paragraphs: next.paragraphs.map((paragraph) => paragraph.map((part) => ({ stream, part }))),
});

/** A report's top-level pieces, in order: a block, or a section whose items may go to two streams. */
type Piece =
  | { readonly kind: "block"; readonly stream: Stream; readonly block: Block }
  | { readonly kind: "section"; readonly title: string; readonly items: readonly SectionItem[] };

/**
 * Rows of one block, each on its own stream: one label width and, when any has a status, the
 * status column, so they align whichever stream shows them (`docs/specs/cli-output.md` §Rows).
 */
function rowItems(rows: readonly Routed[]): SectionItem[] {
  const labelWidth = Math.max(
    0,
    ...rows.map(({ row }) => Bun.stringWidth(typeof row.label === "string" ? row.label : "")),
  );
  const statusColumn = rows.some(({ row }) => row.status !== undefined);
  return rows.map(({ stream, row }, index) => ({
    stream,
    block: { kind: "rows", rows: [row], labelWidth, statusColumn },
    ...(index === 0 ? {} : { continues: true }),
  }));
}

/**
 * The pieces as lines, each on its stream, a blank line before every block, then `next`, last.
 * A section's rule goes to the stream of its first item, a Next block's to the stream of its
 * first part, and the blank line before a block or a paragraph to that block's or the
 * paragraph's first part's stream.
 */
function routedLines(styles: Styles, pieces: readonly Piece[], next?: RoutedNext): StreamLine[] {
  const lines: StreamLine[] = [];
  const emit = (stream: Stream, text: readonly string[]) => {
    for (const line of text) lines.push({ stream, line });
  };
  for (const piece of pieces) {
    if (piece.kind === "block") {
      emit(piece.stream, ["", ...render(styles[piece.stream], [piece.block])]);
      continue;
    }
    const first = piece.items[0]?.stream ?? "out";
    emit(first, [
      "",
      ...render(styles[first], [{ kind: "section", title: piece.title, blocks: [] }]),
    ]);
    piece.items.forEach((item, index) => {
      const blank = index > 0 && item.continues !== true ? [""] : [];
      emit(item.stream, [...blank, ...renderInSection(styles[item.stream], [item.block])]);
    });
  }
  if (next === undefined) return lines;
  const first = next.paragraphs[0]?.[0]?.stream ?? "out";
  const rule: Next = { ...(next.title === undefined ? {} : { title: next.title }), paragraphs: [] };
  emit(first, ["", ...render(styles[first], [], rule)]);
  next.paragraphs.forEach((paragraph, index) => {
    paragraph.forEach(({ stream, part }, at) => {
      const blank = index > 0 && at === 0 ? [""] : [];
      emit(stream, [...blank, ...renderNextParts(styles[stream], [part])]);
    });
  });
  return lines;
}

const RESULT = "Result";

/** The operation record's location: data, verbatim. */
const recordRow = ({ bucket, key }: { readonly bucket: string; readonly key: string }): Row => ({
  label: "Operation record",
  value: [verbatim(`s3://${bucket}/${key}`)],
});

/** A final record write that failed: said on standard error, the outcome kept. */
const recordFailure = (reason: string | undefined): SectionItem[] =>
  reason === undefined
    ? []
    : [
        {
          stream: "err",
          block: {
            kind: "verdict",
            status: "error",
            text: ["The operation record could not be finished: ", verbatim(reason)],
          },
        },
      ];

const NOT_MOVED = "factory.json's pin was not moved: it still pins the release it pinned.";

/** An upgrade's pin left where it was, said before any Next block. */
export function pinNotice(reporting: ApplyReporting): string | undefined {
  return reporting.pin !== undefined && !reporting.pin.moved ? NOT_MOVED : undefined;
}

const notices = (texts: readonly (string | undefined)[]): Piece[] =>
  texts.flatMap((text) =>
    text === undefined
      ? []
      : [{ kind: "block", stream: "err", block: { kind: "text", lines: [text] } } as const],
  );

// The applied Result

/** Each outcome by its worker's key, the first for each. */
function byKey<T extends { readonly key: HostKey }>(outcomes: readonly T[] | undefined) {
  const map = new Map<HostKey, T>();
  for (const outcome of outcomes ?? []) if (!map.has(outcome.key)) map.set(outcome.key, outcome);
  return map;
}

/** Failed and not-attempted workers go to standard error; every other to standard output. */
const workerStream = (outcome: WorkerOutcome): Stream =>
  outcome.kind === "failed" || outcome.kind === "not_attempted" ? "err" : "out";

function appliedRows(result: Applied, reporting: ApplyReporting): Routed[] {
  const out = (row: Row): Routed => ({ stream: "out", row });
  const controlPlane = byKey(result.controlPlane);
  const repositories = byKey(result.repositories);
  const dispatch = byKey(result.dispatch);
  const workers: Routed[] =
    result.workers.length === 0
      ? [
          out({
            label: "Workers",
            value: [
              "none declared. Declare a host in factory.json's hosts, then create it with ",
              { text: command(["apply"], reporting), tone: "code" },
              ".",
            ],
          }),
        ]
      : result.workers.map((outcome) => ({
          stream: workerStream(outcome),
          row: workerRow(
            outcome,
            {
              controlPlane: controlPlane.get(outcome.key),
              repositories: repositories.get(outcome.key),
              dispatch: dispatch.get(outcome.key),
            },
            reporting.selection,
          ),
        }));
  const { verification } = result;
  return [
    ...(result.bootstrapped ? [out({ label: "State bucket", value: "created" })] : []),
    out({
      label: INFRASTRUCTURE,
      value: result.infrastructure === "applied" ? "applied: matches factory.json" : "no changes",
    }),
    ...workers,
    ...(verification === undefined
      ? []
      : [out(verificationRow(verification, enrollmentPending(result)))]),
    out(recordRow(result.operation)),
  ];
}

/** An installed worker's accounts still to enroll; none for any other. */
function pendingOf(outcome: WorkerOutcome): number {
  const enrollment = workerEnrollmentOf(outcome);
  return enrollment === undefined ? 0 : pendingCount(enrollment);
}

/** How many installed workers have accounts still to enroll. */
const enrollmentPending = (result: Applied): number =>
  result.workers.filter((outcome) => pendingOf(outcome) > 0).length;

/**
 * The end-to-end verdict, as verification words it. Verification checks the software, and counts
 * an account still to enroll only when dispatch needs it, as GitHub's: while any worker has one,
 * the factory is not shown ready, its verdict kept and the enrollment said beside it.
 */
function verificationRow(verification: NonNullable<Applied["verification"]>, pending: number): Row {
  const workers = pending === 1 ? "worker" : "workers";
  return {
    status: verification.ready && pending === 0 ? "ready" : "attention",
    label: "Verification",
    value: [
      verbatim(verification.summary),
      ...(pending === 0
        ? []
        : [{ text: ` · enrollment pending on ${pending} ${workers}`, tone: "attention" } as const]),
    ],
  };
}

/** A next action a stage left for one worker, on the stream that stage's always went to. */
interface Left {
  readonly key: HostKey;
  readonly action: string;
  readonly stream: Stream;
}

/**
 * A next action, the workers it is for and its stream: standard error when any stage that named
 * it is on standard error, so a failed worker's recovery always reaches it.
 */
type Actions = Map<string, { readonly keys: HostKey[]; stream: Stream }>;

function addAction(actions: Actions, { key, action, stream }: Left): void {
  const named = actions.get(action);
  if (named === undefined) {
    actions.set(action, { keys: [key], stream });
    return;
  }
  if (!named.keys.includes(key)) named.keys.push(key);
  if (stream === "err") named.stream = "err";
}

/** A later stage's next action: on standard output, where those stages' always went. */
const laterStage = (key: HostKey, action: string): Left => ({ key, action, stream: "out" });

/**
 * The dispatch gates another stage's next action already covers for a worker: its release, the
 * GitHub account it still has to enroll, its unresolved repositories, its Paseo's failure.
 */
function coveredGates(result: Applied, key: HostKey): Set<DispatchGate> {
  const covered = new Set<DispatchGate>();
  const worker = result.workers.find((outcome) => outcome.key === key);
  if (worker?.kind !== "installed") covered.add("worker_release");
  const enrollment = worker === undefined ? undefined : workerEnrollmentOf(worker);
  if (
    enrollment !== undefined &&
    [...enrollment.accounts, ...enrollment.delivered].some(({ id }) => id === "github")
  )
    covered.add("github_credential");
  const repositories = byKey(result.repositories).get(key);
  if (repositories?.kind === "unresolved" || repositories?.kind === "skipped")
    covered.add("repository_sync");
  const controlPlane = byKey(result.controlPlane).get(key);
  if (controlPlane?.kind === "failed" || controlPlane?.kind === "deferred")
    covered.add("paseo_health");
  return covered;
}

/** The outcomes whose kind is one of `leaving`: those that leave a next action. */
function leftBy<T extends { readonly kind: string }, K extends T["kind"]>(
  outcomes: readonly T[] | undefined,
  leaving: readonly K[],
): Extract<T, { readonly kind: K }>[] {
  return (outcomes ?? []).filter((outcome): outcome is Extract<T, { readonly kind: K }> =>
    leaving.some((kind) => kind === outcome.kind),
  );
}

/**
 * Dispatch's next actions, in its order: a failure's or a skip's, and a pending worker's gates
 * but for those another stage's action covers, worded as dispatch words its gates.
 */
function dispatchActions(result: Applied): Left[] {
  return (result.dispatch ?? []).flatMap((outcome): Left[] => {
    switch (outcome.kind) {
      case "failed":
      case "skipped":
        return [laterStage(outcome.key, outcome.nextAction)];
      case "pending": {
        const covered = coveredGates(result, outcome.key);
        const coveredActions = dispatchNextActions({
          kind: "pending",
          gates: outcome.gates,
          blocking: outcome.blocking.filter(({ gate }) => covered.has(gate)),
        });
        return outcome.nextActions
          .filter((action) => !coveredActions.includes(action))
          .map((action) => laterStage(outcome.key, action));
      }
      default:
        return [];
    }
  });
}

/**
 * Every stage's next actions, in the stages' order, each said once whichever stages and workers
 * name it: a failed worker's on standard error, as its row, even when another worker's names it
 * too; every other on standard output. A pending dispatch gate another stage's action covers is
 * left out.
 */
function stageActions(result: Applied): Actions {
  const actions: Actions = new Map();
  const named = [
    ...leftBy(result.workers, ["skipped", "failed"]).map(
      (outcome): Left => ({
        key: outcome.key,
        action: outcome.nextAction,
        stream: workerStream(outcome),
      }),
    ),
    ...leftBy(result.repositories, ["unresolved", "skipped"]).map(({ key, nextAction }) =>
      laterStage(key, nextAction),
    ),
    ...leftBy(result.controlPlane, ["deferred", "failed"]).map(({ key, nextAction }) =>
      laterStage(key, nextAction),
    ),
    ...dispatchActions(result),
  ];
  for (const left of named) addAction(actions, left);
  return actions;
}

const PASEO_NOTE: NextPart = { kind: "note", text: PASEO_CLIENTS };

/** Parts on standard output, where an installed worker's enrollment always went. */
const onOut = (parts: readonly NextPart[]): RoutedPart[] =>
  parts.map((part) => ({ stream: "out", part }));

/**
 * The workers' enrollment, after the stages' next actions: each delivered credential to
 * replace, once for every worker; then each worker's login (named unless the block's title names
 * it) and its accounts, back to the workstation; then `fffactory apply` to verify the enrollment
 * again and `fffactory status` to confirm (status alone reads the verification apply recorded).
 * All on standard output. None when no worker has an account to enroll.
 */
function enrollmentParagraphs(
  enrollments: readonly KeyedEnrollment[],
  named: boolean,
  reporting: ApplyReporting,
): RoutedPart[][] {
  if (enrollments.length === 0) return [];
  const delivered = deliveredSteps(enrollments, reporting.selection);
  const logins = enrollments.filter(({ enrollment }) => enrollment.accounts.length > 0);
  const back = step("Return to your workstation:", ["exit"]);
  const verify = [
    step("Refresh enrollment verification, reviewing the new plan:", [
      command(["apply"], reporting),
    ]),
    step("Then confirm:", [command(["status"], reporting)]),
  ];
  // Verifying follows the last return, or the credentials when no login is left to make.
  if (logins.length === 0) return [onOut([...delivered, ...verify])];
  return [
    ...(delivered.length === 0 ? [] : [onOut(delivered)]),
    ...logins.flatMap(({ key, enrollment }, index) => [
      ...enrollmentSteps(enrollment, key, named).map(onOut),
      onOut(index < logins.length - 1 ? [back] : [back, ...verify]),
    ]),
  ];
}

/**
 * What an applied run leaves for the operator, as one Next block: every stage's next actions,
 * then the workers' enrollment (`enrollmentParagraphs`). Each part goes to the stream its origin
 * always went to: a failed worker's next action to standard error, every other part to standard
 * output. Undefined when nothing is left.
 */
function appliedNext(result: Applied, reporting: ApplyReporting): RoutedNext | undefined {
  // TODO(re-evaluate when stage next actions carry their fffactory command as data): build it
  // with fffactoryCommand, so it repeats the --instance and --profile this run was given. Until
  // then the stages' published next_action wording is shown as it is: its `fffactory apply`
  // finds the nearest factory.json, which may not be the one this run selected.
  const actions = [...stageActions(result)].map(
    ([action, { keys, stream }]): RoutedPart => ({
      stream,
      part: step([{ text: keys.join(", "), tone: "label" }, ": ", action]),
    }),
  );
  const enrollments = result.workers.flatMap((outcome): KeyedEnrollment[] => {
    const enrollment = workerEnrollmentOf(outcome);
    return enrollment === undefined || pendingCount(enrollment) === 0
      ? []
      : [{ key: outcome.key, enrollment }];
  });
  const installed = result.workers.some((outcome) => outcome.kind === "installed");
  if (actions.length === 0 && enrollments.length === 0) return undefined;
  const named = !(actions.length === 0 && enrollments.length === 1);
  const paragraphs: RoutedPart[][] = [
    ...(actions.length === 0 ? [] : [actions]),
    ...enrollmentParagraphs(enrollments, named, reporting),
  ];
  if (installed) paragraphs.at(-1)?.push(...onOut([PASEO_NOTE]));
  const title = enrollmentTitle(actions.length, enrollments);
  return { ...(title === undefined ? {} : { title }), paragraphs };
}

/** The Next block's title: what enrolling asks, when that is all it asks. */
function enrollmentTitle(
  actions: number,
  enrollments: readonly KeyedEnrollment[],
): string | undefined {
  if (actions > 0 || enrollments.length === 0) return undefined;
  const [first] = enrollments;
  if (enrollments.length > 1 || first === undefined)
    return `enroll accounts on ${enrollments.length} workers`;
  const count = pendingCount(first.enrollment);
  return `enroll ${count} ${count === 1 ? "account" : "accounts"} on ${first.key}`;
}

// TODO(re-evaluate when #38 lands): an interrupt during the final operation-record write is
// reported here as this applied outcome, with no word of the lock it leaves; lay out #38's
// interrupted outcome, with its conditional recovery guidance, once apply returns it.
/**
 * An applied run's Result and Next block, each line on the stream it always went to, whatever
 * the exit code: the Result's rows on standard output, but for failed and not-attempted workers
 * and a record that could not be finished, on standard error; the Paseo clients note last in
 * the Result when nothing is left to do; the Next block's parts as `appliedNext` routes them.
 */
export function appliedLines(
  result: Applied,
  reporting: ApplyReporting,
  styles: Styles,
): StreamLine[] {
  const next = appliedNext(result, reporting);
  const note: SectionItem[] =
    next === undefined && result.workers.some((outcome) => outcome.kind === "installed")
      ? [
          {
            stream: "out",
            block: { kind: "text", lines: [[{ text: PASEO_CLIENTS, tone: "muted" }]] },
          },
        ]
      : [];
  const items = [
    ...rowItems(appliedRows(result, reporting)),
    ...recordFailure(result.recordFailure),
    ...note,
  ];
  return routedLines(
    styles,
    [{ kind: "section", title: RESULT, items }, ...notices([pinNotice(reporting)])],
    next,
  );
}

// A saved bootstrap plan, applied

/**
 * A saved bootstrap plan's Result: the state bucket it created and the operation record, on
 * standard output, any record that could not be finished on standard error; then planning the
 * factory, which this apply never does (D2), as its one Next block.
 */
export function bootstrappedLines(
  result: Bootstrapped,
  reporting: ApplyReporting,
  styles: Styles,
): StreamLine[] {
  const rows: Routed[] = [
    { stream: "out", row: { label: "State bucket", value: "created" } },
    { stream: "out", row: recordRow(result.operation) },
  ];
  return routedLines(
    styles,
    [
      {
        kind: "section",
        title: RESULT,
        items: [...rowItems(rows), ...recordFailure(result.recordFailure)],
      },
    ],
    onStream("out", {
      paragraphs: [[step("Plan the factory next:", [command(["plan"], reporting)])]],
    }),
  );
}

// A failure

/** What each step's failure may have left, and whether a rerun converges it. */
const FAILURES: Readonly<
  Record<
    Failed["step"],
    { readonly headline: string; readonly left?: string; readonly rerun?: true }
  >
> = {
  planning: { headline: "Planning failed", left: "Nothing was applied." },
  pinning: { headline: "Moving factory.json's pin failed", left: "Nothing was applied." },
  pinned: {
    headline: "Upgrading failed once factory.json's pin moved",
    left: "Nothing was applied.",
  },
  applying: {
    headline: "Applying failed",
    left: "Terraform may have changed some of the infrastructure before it stopped.",
    rerun: true,
  },
  installing: {
    headline: "Installing the workers failed",
    left: "The worker being installed may be on the new release, unhealthy.",
    rerun: true,
  },
  repositories: {
    headline: "Repository synchronization failed",
    left: "Completed repository changes were left in place.",
    rerun: true,
  },
  "control-plane": { headline: "Control-plane reconciliation failed", rerun: true },
  dispatch: { headline: "Dispatch reconciliation failed", rerun: true },
  verification: { headline: "End-to-end verification failed", rerun: true },
};

/**
 * A failed run's Result, on standard error but for the operation record's location: the
 * failure and what it may have left, the private diagnostics file's path (never its text), the
 * record, any record that could not be finished, an upgrade's pin, then how to converge.
 */
export function failedLines(
  result: Failed,
  reporting: ApplyReporting,
  styles: Styles,
): StreamLine[] {
  const failure = FAILURES[result.step];
  const verdict: Block = {
    kind: "verdict",
    status: "error",
    // The reason is any error's message, an adapter's too, so it may carry data: verbatim.
    text: [`${failure.headline}: `, verbatim(result.reason)],
    ...(failure.left === undefined ? {} : { details: [{ kind: "text", lines: [failure.left] }] }),
  };
  const rows: Routed[] = [
    ...(result.diagnosticsFile === undefined
      ? []
      : [
          {
            stream: "err",
            row: { label: "Terraform's diagnostics", value: [verbatim(result.diagnosticsFile)] },
          } as const,
        ]),
    { stream: "out", row: recordRow(result.operation) },
  ];
  const pin = reporting.pin;
  const finish =
    pin?.moved === true && (result.step === "pinning" || result.step === "pinned")
      ? pin.release
      : undefined;
  const next: NextPart[] = failure.rerun
    ? [
        step("Rerun: it plans again from what exists now and converges what remains:", [
          command([reporting.rerun], reporting),
        ]),
      ]
    : finish !== undefined
      ? [step("Finish with this release:", [command(["apply"], reporting)])]
      : [];
  return routedLines(
    styles,
    [
      {
        kind: "section",
        title: RESULT,
        items: [
          { stream: "err", block: verdict },
          ...rowItems(rows),
          ...recordFailure(result.recordFailure),
        ],
      },
      ...notices([
        finish === undefined ? undefined : `factory.json pins release ${finish}.`,
        pinNotice(reporting),
      ]),
    ],
    next.length === 0 ? undefined : onStream("err", { paragraphs: [next] }),
  );
}

// An interrupt

/** The worker an interrupt concerned, and what it means for it. */
function interruptedWorker(result: Interrupted): string[] {
  if (!result.locked) return [];
  const lines: string[] = [];
  if (result.installing !== undefined)
    lines.push(
      `Interrupted while installing on ${result.installing.key}: host apply may still be ` +
        "running there, and a rerun skips that worker until it has finished.",
    );
  if (result.waiting !== undefined)
    lines.push(
      `Interrupted while waiting for ${result.waiting.key} to finish its first boot: no ` +
        "install step ran on it.",
    );
  return lines;
}

/**
 * How to go on after an interrupt: rerun the command, or, when a saved bootstrap plan was being
 * applied, plan the factory instead. That plan may be spent, and apply without one needs a
 * terminal, so it is never rerun.
 */
function goOn(result: Interrupted, reporting: ApplyReporting) {
  if (result.bootstrapPlan === undefined) {
    const rerun = command([reporting.rerun], reporting);
    return {
      unlocked: step("Rerun: it plans again from what exists now:", [rerun]),
      locked: step("Then rerun:", [rerun]),
    };
  }
  const plan = command(["plan"], reporting);
  return {
    unlocked: step("Plan again from what exists now:", [plan]),
    locked: step("Then plan the factory next:", [plan]),
  };
}

/** The verdict's details: the saved bootstrap plan that may be spent, or the worker concerned. */
function interruptedDetails(result: Interrupted): Block[] {
  const lines =
    result.bootstrapPlan === undefined
      ? interruptedWorker(result)
      : result.locked
        ? []
        : [`Saved plan ${result.bootstrapPlan} may be spent and the state bucket created.`];
  return lines.length === 0 ? [] : [{ kind: "text", lines }];
}

/**
 * What an interrupt left, on standard error but for the record's location: no lock, the lock
 * alone, or the lock and a record of the operation, then how to recover: rerun, or plan the
 * factory after a saved bootstrap plan.
 */
export function interruptedLines(
  result: Interrupted,
  reporting: ApplyReporting,
  styles: Styles,
): StreamLine[] {
  const next = goOn(result, reporting);
  const details = interruptedDetails(result);
  const verdict: Block = {
    kind: "verdict",
    status: "attention",
    text: !result.locked
      ? "Interrupted before the factory was locked: it is not locked"
      : result.record === undefined
        ? `Interrupted: the factory stays locked by this ${reporting.action}, which may have no operation record`
        : "Interrupted: the factory stays locked, with a record of this operation",
    ...(details.length === 0 ? {} : { details }),
  };
  const record: Routed[] =
    !result.locked || result.record === undefined
      ? []
      : [{ stream: "out", row: recordRow(result.record) }];
  return routedLines(
    styles,
    [
      {
        kind: "section",
        title: RESULT,
        items: [{ stream: "err", block: verdict }, ...rowItems(record)],
      },
      ...notices([pinNotice(reporting)]),
    ],
    onStream("err", {
      paragraphs: [
        result.locked
          ? [
              step("Once fffactory has exited, break the lock:", [
                command(["lock", "break"], reporting),
              ]),
              next.locked,
            ]
          : [next.unlocked],
      ],
    }),
  );
}

// A run that applied nothing

const refused = (text: Inline): Block => ({ kind: "verdict", status: "error", text });
const said = (text: string): Block => ({ kind: "text", lines: [text] });

/**
 * A run that applied nothing and holds no lock: declined at the question, an upgrade whose
 * factory.json changed while its plan was shown, or one without a state bucket.
 */
export function refusedRunReport(result: RefusedRun, reporting: ApplyReporting): Report {
  switch (result.kind) {
    case "declined":
      return { blocks: [refused("Not approved: nothing was applied")] };
    case "configuration_changed":
      return {
        blocks: [
          refused(`Refusing to ${reporting.action}: factory.json changed after the plan was made`),
          said("Nothing was applied."),
        ],
        next: {
          paragraphs: [[step("Review a new plan:", [command([reporting.rerun], reporting)])]],
        },
      };
    case "no_state_bucket":
      return {
        blocks: [
          refused(
            "Refusing to upgrade: the factory has no state bucket yet, and an upgrade never creates it",
          ),
          said("Nothing was created or applied."),
        ],
        next: {
          paragraphs: [
            [
              step("Create it with the release factory.json pins, which applies the factory:", [
                command(["apply"], reporting),
              ]),
              step("Then upgrade again:", [command(["upgrade"], reporting)]),
            ],
          ],
        },
      };
  }
}
