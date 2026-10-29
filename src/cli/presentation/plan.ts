/**
 * The plan an operator approves, and every refusal of one, as layout blocks: the only place a
 * `PlanReview`, a `StaleReason` or a plan refusal is laid out (`docs/specs/plan-apply.md`
 * §Layer mapping, `docs/specs/cli-output.md`). The domain decides what a plan does and why it is
 * refused; this lays it out.
 */
import type { PlanRefusal } from "../../application/plan-factory";
import {
  type BootstrapContext,
  type BucketHardening,
  type StateBucketLocation,
  type StateBucketReadiness,
  tlsOnlyPolicy,
  type UnreadyBucket,
} from "../../domain/backend-bootstrap";
import type { HostKey } from "../../domain/instance";
import {
  type BootstrapPlanReview,
  changeKind,
  changesSomething,
  changeTally,
  type D11Refusal,
  type FactoryPlanReview,
  hostMachineAddress,
  type PlannedArchive,
  type PlannedControlPlane,
  type PlannedDispatch,
  type PlannedRepositories,
  type PlannedWorker,
  type PlanReview,
  type PlanTarget,
  type PoweredDownWorker,
  type ResizeGuard,
  type ResourceChange,
  type SavedPlan,
  type StaleReason,
  type UnexpectedPlan,
} from "../../domain/plan";
import type { PinMove } from "../../domain/release-compatibility";
import type { WorkerIdentity } from "../../domain/rollout";
import {
  type Block,
  type Inline,
  type Next,
  type NextPart,
  nextSteps,
  type Report,
  type Row,
  type Span,
  step,
  verbatim,
} from "./blocks";
import { fffactoryCommand, type Selection } from "./command-line";
import { lockRefusalReport } from "./lock";
import { GLYPHS, type Status } from "./style";

// TODO(re-evaluate when epic #18 restyles `worker terminate`): lay the removal plan
// (`describeRemovalPlan`) out in blocks, and drop `describeTarget` and `describeInfrastructure`.
/** The removal plan's target lines: which factory.json, factory, account, Region and release. */
function describeTarget(target: PlanTarget): string[] {
  return [
    `  Configuration: ${target.instancePath}`,
    `  Factory: ${factoryName(target)}`,
    `  AWS account: ${target.accountId}, Region: ${target.region}`,
    `  Release: ${target.release}`,
  ];
}

/** Terraform's symbol for a change: `+`, `~`, `-`, or a replacement's `-/+` or `+/-`. */
function changeSymbol(change: ResourceChange): string | undefined {
  const kind = changeKind(change);
  if (kind === "other") return undefined;
  // A replacement's symbol tells which comes first: destroying the old, or creating the new.
  if (kind === "replace") return change.actions[0] === "delete" ? "-/+" : "+/-";
  return GLYPHS[kind];
}

/** The removal plan's infrastructure lines. */
function describeInfrastructure(changes: readonly ResourceChange[]): string[] {
  const tally = changeTally(changes);
  if (tally.changing === 0) return ["Infrastructure: no changes."];
  return [
    "Infrastructure changes:",
    ...changes.filter(changesSomething).map((change) => {
      const symbol = changeSymbol(change);
      return symbol === undefined
        ? `  ${change.address} (${change.actions.join(", ")})`
        : `  ${symbol} ${change.address}`;
    }),
    `  ${tally.add} to add, ${tally.change} to change, ${tally.destroy} to destroy.`,
  ];
}

/** The removal plan, as the operator approves it with the host key. */
export function describeRemovalPlan(plan: {
  readonly target: PlanTarget;
  readonly changes: readonly ResourceChange[];
  readonly worker: WorkerIdentity;
}): string[] {
  const { worker } = plan;
  return [
    "Removal plan:",
    ...describeTarget(plan.target),
    ...describeInfrastructure(plan.changes),
    `factory.json: remove host ${worker.key}.`,
    `Tailnet: delete the devices named ${worker.hostname} that carry the factory's tag.`,
  ];
}

const factoryName = (target: PlanTarget): string =>
  target.name === undefined ? target.factoryId : `${target.name} (${target.factoryId})`;

/** What every plan shows first: which factory, account and Region, and which release. */
export function targetRows(target: PlanTarget, more: readonly Row[] = []): Block {
  return {
    kind: "rows",
    rows: [
      { label: "Factory", value: [verbatim(factoryName(target))] },
      { label: "Account", value: `${target.accountId} · ${target.region}` },
      { label: "Release", value: target.release },
      ...more,
    ],
  };
}

/** One change, after its glyph in its color; a change of no known kind is named by its actions. */
export function changeLine(change: ResourceChange): Inline {
  const symbol = changeSymbol(change);
  if (symbol === undefined) return [verbatim(`${change.address} (${change.actions.join(", ")})`)];
  const kind = changeKind(change);
  const tone: Status = kind === "create" || kind === "update" ? kind : "delete";
  return [{ text: symbol, tone }, " ", verbatim(change.address)];
}

/** The infrastructure stage: no changes, or the tally, then each change that changes something. */
function infrastructureRow(changes: readonly ResourceChange[]): Row {
  const tally = changeTally(changes);
  if (tally.changing === 0) return { label: "Infrastructure", value: "no changes" };
  return {
    label: "Infrastructure",
    value: `${tally.add} to add, ${tally.change} to change, ${tally.destroy} to destroy`,
    details: [{ kind: "text", lines: changes.filter(changesSomething).map(changeLine) }],
  };
}

/** The log archive: its bucket, which the plan creates, or which is present already. */
const archiveRow = ({ bucket, creates }: PlannedArchive): Row => ({
  label: "Archive",
  value: `${bucket}, ${creates ? "created" : "present"}`,
});

/** A stage's row, then each worker's change under it. */
const stageRow = (label: string, value: string, workers: readonly Row[]): Row => ({
  label,
  value,
  details: [{ kind: "rows", rows: workers }],
});

/** A worker's change in a stage: `~`, then its key and what it does. */
const changing = (key: HostKey, value: Inline): Row => ({ status: "update", label: key, value });

/** A worker that stage sends nothing, such as one whose machine is stopped: no glyph. */
const unchanged = (key: HostKey, value: Inline): Row => ({ label: key, value });

const STOPPED = "skipped: stopped";

/** An `fffactory` command as inline code, with the instance and profile given. */
const commandCode = (words: readonly string[], selection: Selection): Span => ({
  text: fffactoryCommand(words, selection),
  tone: "code",
});

/**
 * The workers stage: each worker gets the release and its host configuration and is verified,
 * a stopped one is skipped, and a factory that declares no worker says so, and how to add one.
 */
function workersRow({ workers, stopped, target }: FactoryPlanReview, selection: Selection): Row {
  if (workers.length === 0)
    return {
      label: "Workers",
      value: [
        "none declared. Declare a host in factory.json's hosts, then create it with ",
        commandCode(["apply"], selection),
        ".",
      ],
    };
  return stageRow(
    "Workers",
    "one at a time",
    workers.map(({ key }) =>
      stopped.includes(key)
        ? unchanged(key, [
            `${STOPPED}; start it with `,
            commandCode(["worker", "start", key], selection),
            ", then apply again to install it",
          ])
        : changing(key, `install release ${target.release} and host configuration, then verify`),
    ),
  );
}

function controlPlaneRows(plans: readonly PlannedControlPlane[], stopped: readonly HostKey[]) {
  if (plans.length === 0) return [];
  return [
    stageRow(
      "Control plane",
      "before worker activation",
      plans.map(({ key, changes }) => {
        if (stopped.includes(key)) return unchanged(key, STOPPED);
        return changes.length === 0
          ? unchanged(key, "Paseo is unchanged")
          : changing(key, changes.join(", "));
      }),
    ),
  ];
}

function repositoryRows(plans: readonly PlannedRepositories[], stopped: readonly HostKey[]) {
  if (plans.length === 0) return [];
  return [
    stageRow(
      "Repositories",
      "one worker at a time",
      plans.map(({ key, placed }) => {
        if (stopped.includes(key)) return unchanged(key, STOPPED);
        const count = placed.length;
        return changing(
          key,
          `reconcile ${count} placed ${count === 1 ? "repository" : "repositories"} as factory; ` +
            "preserve and report unmanaged checkouts",
        );
      }),
    ),
  ];
}

function dispatchChange({ requested, schedule }: PlannedDispatch): Inline {
  if (!requested || schedule === null) return "remove the factory dispatch schedule if it exists";
  return [
    "install the dispatcher and skill, then reconcile ",
    verbatim(`${schedule.cron} ${schedule.timezone}`),
    " with ",
    verbatim(`${schedule.provider}/${schedule.model}`),
    ", mode ",
    verbatim(schedule.mode),
    ", cwd ",
    verbatim(schedule.cwd),
  ];
}

/** The dispatch stage, then the end-to-end verification that follows it. */
function dispatchRows(plans: readonly PlannedDispatch[], stopped: readonly HostKey[]) {
  if (plans.length === 0) return [];
  return [
    stageRow(
      "Dispatch",
      "after every readiness gate",
      plans.map((plan) =>
        stopped.includes(plan.key)
          ? unchanged(plan.key, STOPPED)
          : changing(plan.key, dispatchChange(plan)),
      ),
    ),
    {
      label: "Verification",
      value:
        "end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule",
    },
  ];
}

/** An upgrade's pin move, approved with the plan. */
function pinRow(move: PinMove): Row {
  const from = move.from === "unshown" ? "the release it pins now" : move.from;
  return {
    label: "Pin",
    value:
      `factory.json's release pin moves from ${from} to ${move.to}, written once you approve ` +
      "this plan, before anything is applied",
  };
}

/**
 * The whole factory plan an operator approves, as the `Plan` section: its target (and an
 * upgrade's pin move), the log archive when factory.json enables it, its infrastructure
 * changes, then each worker's install and later stages, those of the stopped workers skipped.
 */
export function planSection(review: FactoryPlanReview, selection: Selection): Block {
  const { stopped } = review;
  return {
    kind: "section",
    title: "Plan",
    blocks: [
      targetRows(review.target, review.pinMove === undefined ? [] : [pinRow(review.pinMove)]),
      {
        kind: "rows",
        rows: [
          ...(review.archive === undefined ? [] : [archiveRow(review.archive)]),
          infrastructureRow(review.changes),
          workersRow(review, selection),
          ...controlPlaneRows(review.controlPlane, stopped),
          ...repositoryRows(review.repositories, stopped),
          ...dispatchRows(review.dispatch, stopped),
        ],
      },
    ],
  };
}

/** Backend bootstrap's plan, as its own section: the bucket it creates, and every creation. */
function bootstrapSection(target: BootstrapContext, creates: readonly string[]): Block {
  return {
    kind: "section",
    title: "Plan: backend bootstrap",
    blocks: [
      targetRows(target),
      {
        kind: "rows",
        rows: [
          { label: "State bucket", value: `${target.bucket}, which does not exist yet` },
          infrastructureRow(creates.map((address) => ({ address, actions: ["create"] }))),
        ],
      },
    ],
  };
}

/**
 * Any plan an operator approves, as the blocks shown before it is approved; the commands it
 * names carry the instance and profile in `selection`.
 */
export function reviewBlocks(review: PlanReview, selection: Selection): Block[] {
  return [
    review.kind === "factory"
      ? planSection(review, selection)
      : bootstrapSection(review.target, review.creates),
  ];
}

/** `fffactory plan`'s plan, saved, then how to apply exactly it. */
export function savedPlanReport(
  review: FactoryPlanReview,
  saved: Pick<SavedPlan, "plan_id" | "expires_at">,
  selection: Selection,
): Report {
  return {
    blocks: [
      planSection(review, selection),
      { kind: "text", lines: [`Saved as plan ${saved.plan_id}, until ${saved.expires_at}.`] },
    ],
    next: nextSteps(
      step("Apply exactly this plan:", [
        fffactoryCommand(["apply", "--plan-id", saved.plan_id], selection),
      ]),
    ),
  };
}

/**
 * `fffactory plan` before the state bucket exists: bootstrap's plan, saved as a bootstrap plan,
 * then how to apply exactly it and plan the factory once the bucket exists.
 */
export function savedBootstrapPlanReport(
  review: BootstrapPlanReview,
  saved: Pick<SavedPlan, "plan_id" | "expires_at">,
  selection: Selection,
): Report {
  return {
    blocks: [
      bootstrapSection(review.target, review.creates),
      {
        kind: "text",
        lines: [
          `Saved as plan ${saved.plan_id}, until ${saved.expires_at}.`,
          "The factory itself is planned once the state bucket exists.",
        ],
      },
    ],
    next: nextSteps(
      step("Apply exactly this plan:", [
        fffactoryCommand(["apply", "--plan-id", saved.plan_id], selection),
      ]),
      step("Then plan the factory:", [fffactoryCommand(["plan"], selection)]),
    ),
  };
}

/** Why Terraform's plan is not one fffactory can apply, as one line. */
export function describeUnexpectedPlan(reason: UnexpectedPlan): string {
  switch (reason.kind) {
    case "unreadable_plan":
      return "Terraform's plan could not be read";
    case "unreadable_host_keys":
      return "the factory's Terraform state records host keys that cannot be read";
    case "creates_nothing":
      return "the plan creates nothing, though the state bucket does not exist";
    case "not_create":
      return `${reason.change.address} (${reason.change.actions.join(", ")})`;
  }
}

/** A refusal's error status line, then its reasons, each a line under it. */
const refused = (text: Inline, reasons: readonly Inline[] = []): Block => ({
  kind: "verdict",
  status: "error",
  text,
  ...(reasons.length === 0 ? {} : { details: [{ kind: "text", lines: reasons }] }),
});

/** What every refusal of a change says once it has given its reasons. */
const NOTHING_APPLIED: Block = { kind: "text", lines: ["Nothing was applied."] };

/** Preserve D11's published wording, rendering its removal commands with this selection. */
function d11Text(text: string, selection: Selection): Inline {
  const spans: Span[] = [];
  let from = 0;
  for (const match of text.matchAll(/`fffactory worker terminate (KEY|[a-z][a-z0-9-]*)`/g)) {
    spans.push(text.slice(from, match.index));
    spans.push(commandCode(["worker", "terminate", match[1] as string], selection));
    from = match.index + match[0].length;
  }
  spans.push(text.slice(from));
  return spans;
}

/** A change that needs a lifecycle capability fffactory does not have, or another command (D11). */
export function d11Report(refusal: D11Refusal, selection: Selection = {}): Report {
  const missing =
    refusal.command === undefined
      ? "which fffactory does not have yet (D11; it arrives in milestone M3):"
      : `which only \`${refusal.command}\` does (D11):`;
  return {
    blocks: [
      refused(
        d11Text(`Refusing: this change needs ${refusal.capability}, ${missing}`, selection),
        refusal.reasons.map((reason) => d11Text(reason, selection)),
      ),
      NOTHING_APPLIED,
    ],
    next: nextSteps(step(d11Text(refusal.instead, selection))),
  };
}

/** How a refusal of `action` was given: when, and the instance and profile its commands repeat. */
interface RefusalContext {
  readonly action: string;
  readonly now: Date;
  readonly selection: Selection;
}

/** The command that plans again after a refusal: an upgrade's is `fffactory upgrade`. */
const replan = ({ action, selection }: RefusalContext): string =>
  fffactoryCommand([action === "upgrade" ? "upgrade" : "plan"], selection);

/** The start commands, once a stopped or stopping worker can be started, and then planning again. */
function startFirst(workers: readonly PoweredDownWorker[], context: RefusalContext): NextPart[] {
  const one = workers.length === 1;
  const once = workers.some(({ machine }) => machine === "stopping")
    ? `, once ${one ? "it has" : "they have"} stopped`
    : "";
  return [
    step(
      `Start ${one ? "it" : "each"} first${once}:`,
      workers.map(({ key }) => fffactoryCommand(["worker", "start", key], context.selection)),
    ),
    step("Then plan again:", [replan(context)]),
  ];
}

/** Why the plan is refused for the resized guarded workers, and what to do first. */
function stoppedResizeReport(refusal: ResizeGuard, context: RefusalContext): Report {
  const unreadable = refusal.inventory === "unreadable";
  const worker = unreadable
    ? "a worker the EC2 inventory could not be read to check is not stopped"
    : "a stopped worker";
  const updated = (plan: PlannedWorker | PoweredDownWorker): Row => ({
    label: plan.key,
    value:
      `${hostMachineAddress(plan.key)} would be updated in place` +
      ("machine" in plan && plan.machine === "stopping" ? ", and it is stopping" : ""),
  });
  return {
    blocks: [
      {
        kind: "verdict",
        status: "error",
        text:
          `Refusing to ${context.action}: the plan changes the instance type of ${worker}, and ` +
          "Terraform starts a stopped instance to change its type:",
        details: [{ kind: "rows", rows: refusal.workers.map(updated) }],
      },
      NOTHING_APPLIED,
    ],
    next: unreadable
      ? nextSteps(step("Plan again once the EC2 inventory can be read:", [replan(context)]))
      : nextSteps(...startFirst(refusal.workers, context)),
  };
}

/** Why a saved plan is no longer the plan to apply, as one line. */
export function describeStaleReason(reason: StaleReason): string {
  switch (reason.kind) {
    case "expired":
      return `it expired at ${reason.expiresAt}`;
    case "other_instance":
      return `it was planned for another factory.json, ${reason.instancePath}`;
    case "configuration_changed":
      return "factory.json changed after it was planned";
    case "other_release":
      return `it was planned by fffactory ${reason.release}, not this release`;
    case "other_assets":
      return "it was planned with other release assets than this fffactory's";
    case "other_account":
      return `it was planned in AWS account ${reason.accountId}, not this one`;
    case "state_changed":
      return "the factory's Terraform state changed after it was planned";
    case "state_bucket_missing":
      return "the state bucket no longer exists";
    case "state_bucket_created":
      return "the state bucket was created after it was planned";
    case "archive_created":
      return "the log archive was created after it was planned";
    case "archive_missing":
      return "the log archive no longer exists";
    case "inventory_unreadable":
      return `the EC2 inventory could not be read to check that worker ${reason.key} is still stopped`;
    case "worker_started":
      return `worker ${reason.key} was stopped when it was planned, and is not now`;
    case "worker_stopped":
      return `worker ${reason.key} is stopped now, and was not when it was planned`;
    case "paseo_changed":
      return `Paseo state on ${reason.hostname} changed after it was planned`;
  }
}

/** A Next block reviewing a new plan, with the instance and profile given. */
const reviewNewPlan = (selection: Selection): Next =>
  nextSteps(step("Review a new plan:", [fffactoryCommand(["plan"], selection)]));

// TODO(re-evaluate when #12 lands): update the `paseo_changed` refusal's wording to #12's
// corrected outcome, in `staleReport` and `staleRunReport` alike. It comes after the
// infrastructure stage applied, so its `Nothing was applied.` is known to be misleading: #12
// moves the check before anything is applied, or reports what was.
/** The refusal of a plan no longer the plan to apply: `heading`, every reason, then nothing applied. */
const staleBlocks = (heading: string, reasons: readonly StaleReason[]): Block[] => [
  refused(
    heading,
    reasons.map((reason) => [verbatim(describeStaleReason(reason))]),
  ),
  NOTHING_APPLIED,
];

/** Why a saved plan is no longer the plan to apply: every reason, then a new plan. */
export function staleReport(
  planId: string,
  reasons: readonly StaleReason[],
  selection: Selection,
): Report {
  return {
    blocks: staleBlocks(
      `Refusing to apply plan ${planId}: it is no longer the plan to apply:`,
      reasons,
    ),
    next: reviewNewPlan(selection),
  };
}

/**
 * Why the plan approved in this run, never saved and its ID never shown, is no longer the plan
 * to apply: every reason, then the command that plans it again, `rerun` (apply's, or an
 * upgrade's while its pin has not moved).
 */
export function staleRunReport(
  reasons: readonly StaleReason[],
  {
    action,
    rerun,
    selection,
  }: { readonly action: string; readonly rerun: string; readonly selection: Selection },
): Report {
  return {
    blocks: staleBlocks(
      `Refusing to ${action}: the plan approved is no longer the plan to apply:`,
      reasons,
    ),
    next: nextSteps(step("Review a new plan:", [fffactoryCommand([rerun], selection)])),
  };
}

/** A plan ID naming no saved plan of this factory here. */
export function unknownPlanReport(planId: string, selection: Selection): Report {
  return {
    blocks: [
      refused(
        `There is no saved plan ${planId} for this factory here: it expired, was applied, or ` +
          "was saved elsewhere",
      ),
    ],
    next: reviewNewPlan(selection),
  };
}

/** A saved plan whose record cannot be read, or whose Terraform plan changed after saving. */
export function damagedPlanReport(planId: string, selection: Selection): Report {
  return {
    blocks: [
      refused(
        `Saved plan ${planId} cannot be applied: its record cannot be read, or its Terraform ` +
          "plan changed after it was saved",
      ),
    ],
    next: reviewNewPlan(selection),
  };
}

function hardeningLabel(setting: BucketHardening, readiness: StateBucketReadiness): string {
  const labels: Record<BucketHardening, string> = {
    versioning: `versioning (${readiness.versioning ?? "never enabled"})`,
    public_access_block: "public access block",
    default_encryption: "default encryption",
    tls_only_policy: "TLS-only bucket policy",
    bucket_owner_enforced: "bucket-owner-enforced object ownership",
    sse_s3: "SSE-S3 default encryption",
    abac: "attribute-based access control",
  };
  return labels[setting];
}

const SSE_S3_CONFIGURATION =
  "--server-side-encryption-configuration " +
  `'${JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] })}'`;

function hardeningCommand(setting: BucketHardening, location: StateBucketLocation): string {
  const commands: Record<BucketHardening, readonly [string, string]> = {
    versioning: ["put-bucket-versioning", "--versioning-configuration Status=Enabled"],
    public_access_block: [
      "put-public-access-block",
      "--public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true," +
        "BlockPublicPolicy=true,RestrictPublicBuckets=true",
    ],
    default_encryption: ["put-bucket-encryption", SSE_S3_CONFIGURATION],
    tls_only_policy: ["put-bucket-policy", `--policy '${tlsOnlyPolicy(location.bucket)}'`],
    bucket_owner_enforced: [
      "put-bucket-ownership-controls",
      "--ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'",
    ],
    sse_s3: ["put-bucket-encryption", SSE_S3_CONFIGURATION],
    abac: ["put-bucket-abac", "--abac-status Status=Enabled"],
  };
  const [command, settings] = commands[setting];
  return (
    `aws s3api ${command} --region ${location.region} --bucket ${location.bucket} ` +
    `--expected-bucket-owner ${location.accountId} ${settings}`
  );
}

/** What an unready bucket's refusal says first, and the wait it names before completing it. */
interface UnreadyWords {
  readonly heading: string;
  readonly wait: string;
}

// TODO(re-evaluate when the state-bucket module's hardening changes, or when apply can import
// existing resources into the backend root): converge the state bucket's hardening on rerun
// through the reviewed backend plan instead of printing AWS CLI commands.
/**
 * Why an operation refuses a state bucket that exists but lacks some of backend bootstrap's
 * settings, and how to complete it: fffactory itself cannot finish an interrupted bootstrap.
 */
const unreadyBucketReport = (bucket: UnreadyBucket): Report =>
  incompleteBucketReport(bucket, {
    heading: `The state bucket ${bucket.location.bucket} exists, but backend bootstrap did not finish it.`,
    wait: "If another first apply is still bootstrapping it, wait for that to finish, then retry.",
  });

// TODO(re-evaluate when retention or bucket settings must change): converge the log archive's
// settings through a reviewed plan instead of printing AWS CLI commands.
/**
 * Why plan and apply refuse a log archive that exists but lacks some of the archive root's
 * settings, and how to complete it: the archive root keeps no state, so it cannot finish one.
 */
const unreadyArchiveReport = (bucket: UnreadyBucket): Report =>
  incompleteBucketReport(bucket, {
    heading: `The log archive ${bucket.location.bucket} exists, but without every setting fffactory gives it.`,
    wait: "If another apply is still creating it, wait for that to finish, then retry.",
  });

/** A bucket that lacks settings fffactory gives it: each one, then the commands that apply it. */
function incompleteBucketReport(
  { location, readiness, missing }: UnreadyBucket,
  words: UnreadyWords,
): Report {
  const warning: NextPart[] = missing.includes("tls_only_policy")
    ? [
        {
          kind: "note",
          text: "put-bucket-policy replaces the whole bucket policy: add any statements it already has.",
        },
      ]
    : [];
  return {
    blocks: [
      refused(
        `${words.heading} It lacks:`,
        missing.map((setting) => hardeningLabel(setting, readiness)),
      ),
    ],
    next: {
      paragraphs: [
        [step(words.wait)],
        [
          step(
            "Otherwise complete the bucket with these AWS CLI commands, using credentials for " +
              `account ${location.accountId}, then retry:`,
            missing.map((setting) => hardeningCommand(setting, location)),
          ),
          ...warning,
        ],
      ],
    },
  };
}

/** Why `context.action` was refused before anything changed: its status line, reasons and next step. */
export function planRefusalReport(refusal: PlanRefusal, context: RefusalContext): Report {
  const { action } = context;
  switch (refusal.kind) {
    case "release_mismatch":
      return { blocks: [refused(`Refusing to ${action}: ${refusal.message}`)] };
    case "refused":
      return {
        blocks: [
          refused(
            `Refusing to ${action}: factory.json is not ready:`,
            refusal.issues.map((issue) => [verbatim(`${issue.path}: ${issue.message}`)]),
          ),
        ],
      };
    case "d11":
      return d11Report(refusal.refusal, context.selection);
    case "stopped_resize":
      return stoppedResizeReport(refusal, context);
    case "unready":
      return unreadyBucketReport(refusal.bucket);
    case "unready_archive":
      return unreadyArchiveReport(refusal.bucket);
    case "unexpected_plan":
      return {
        blocks: [
          refused(
            `Refusing to ${action}: Terraform's plan is not one fffactory can apply:`,
            refusal.unexpected.map((reason) => [verbatim(describeUnexpectedPlan(reason))]),
          ),
        ],
      };
    case "locked":
      return lockRefusalReport(refusal.held, context.now, context.selection);
  }
}
