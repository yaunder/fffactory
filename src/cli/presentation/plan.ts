/**
 * The plan an operator approves, and every refusal of one, as text: the only place a
 * `PlanReview`, a `StaleReason` or a plan refusal becomes lines (`docs/specs/plan-apply.md`
 * §Layer mapping). The domain decides what a plan does and why it is refused; this lays it out.
 */
import {
  type BucketHardening,
  type BootstrapContext,
  type StateBucketLocation,
  type StateBucketReadiness,
  tlsOnlyPolicy,
  type UnreadyBucket,
} from "../../domain/backend-bootstrap";
import type { HostKey, Release } from "../../domain/instance";
import {
  type ChangeKind,
  changeKind,
  changesSomething,
  changeTally,
  type D11Refusal,
  type FactoryPlanReview,
  hostMachineAddress,
  type PlannedControlPlane,
  type PlannedDispatch,
  type PlannedRepositories,
  type PlannedWorker,
  type PlanReview,
  type PlanTarget,
  type PoweredDownWorker,
  type ResizeGuard,
  type ResourceChange,
  type StaleReason,
  type UnexpectedPlan,
} from "../../domain/plan";
import type { PinMove } from "../../domain/release-compatibility";
import type { WorkerIdentity } from "../../domain/rollout";

/** What every plan shows first: which factory.json, factory, account, Region and release. */
export function describeTarget(target: PlanTarget): string[] {
  const factory =
    target.name === undefined ? target.factoryId : `${target.name} (${target.factoryId})`;
  return [
    `  Configuration: ${target.instancePath}`,
    `  Factory: ${factory}`,
    `  AWS account: ${target.accountId}, Region: ${target.region}`,
    `  Release: ${target.release}`,
  ];
}

/** Terraform's symbol for each kind of change it shows one for. */
const SYMBOLS: Readonly<Record<Exclude<ChangeKind, "replace" | "other">, string>> = {
  create: "+",
  update: "~",
  delete: "-",
};

function describeChange(change: ResourceChange): string {
  const { address, actions } = change;
  const kind = changeKind(change);
  if (kind === "other") return `  ${address} (${actions.join(", ")})`;
  // A replacement's symbol tells which comes first: destroying the old, or creating the new.
  const symbol = kind === "replace" ? (actions[0] === "delete" ? "-/+" : "+/-") : SYMBOLS[kind];
  return `  ${symbol} ${address}`;
}

/** The infrastructure changes a plan makes, as the operator approves them. */
export function describeInfrastructure(changes: readonly ResourceChange[]): string[] {
  const tally = changeTally(changes);
  if (tally.changing === 0) return ["Infrastructure: no changes."];
  return [
    "Infrastructure changes:",
    ...changes.filter(changesSomething).map(describeChange),
    `  ${tally.add} to add, ${tally.change} to change, ${tally.destroy} to destroy.`,
  ];
}

/** The plan's line for a factory that declares no worker. */
const NO_WORKERS_DECLARED =
  "Workers: none declared. Declare a host in factory.json's hosts, then create it with `fffactory apply`.";

/** A later stage's line for a worker whose machine is stopped: it is sent nothing. */
function skippedStopped({ key, hostname }: PlannedWorker): string {
  return `  = ${key} (${hostname}): skipped: stopped`;
}

/**
 * The workers stage's changes: each worker gets the release and its host configuration and is
 * verified, a stopped one is skipped, and a factory that declares no worker says so, and how to
 * add one.
 */
export function describeWorkers(
  workers: readonly PlannedWorker[],
  release: Release,
  stopped: readonly HostKey[] = [],
): string[] {
  if (workers.length === 0) return [NO_WORKERS_DECLARED];
  return [
    "Worker changes, one worker at a time:",
    ...workers.map(({ key, hostname }) =>
      stopped.includes(key)
        ? `  = ${key} (${hostname}): skipped: stopped; start it with \`fffactory worker start ${key}\`, then apply again to install it`
        : `  ~ ${key} (${hostname}): install release ${release} and its host configuration, then verify it`,
    ),
  ];
}

/** The repository-stage mutations included in the approved plan. */
export function describeRepositories(
  repositories: readonly PlannedRepositories[],
  stopped: readonly HostKey[] = [],
): string[] {
  if (repositories.length === 0) return [];
  return [
    "Repository changes, one worker at a time:",
    ...repositories.map((worker) => {
      const { key, hostname } = worker;
      if (stopped.includes(key)) return skippedStopped(worker);
      const count = worker.placed.length;
      return `  ~ ${key} (${hostname}): reconcile ${count} placed ${count === 1 ? "repository" : "repositories"} as factory; preserve and report unmanaged checkouts`;
    }),
  ];
}

function describeControlPlane(
  plans: readonly PlannedControlPlane[],
  stopped: readonly HostKey[] = [],
): string[] {
  if (plans.length === 0) return [];
  return [
    "Control-plane changes, before worker activation:",
    ...plans.map((plan) => {
      const { key, hostname, changes } = plan;
      if (stopped.includes(key)) return skippedStopped(plan);
      return changes.length === 0
        ? `  = ${key} (${hostname}): Paseo is unchanged`
        : `  ~ ${key} (${hostname}): ${changes.join(", ")}`;
    }),
  ];
}

function describeDispatch(
  plans: readonly PlannedDispatch[],
  stopped: readonly HostKey[] = [],
): string[] {
  if (plans.length === 0) return [];
  return [
    "Dispatch changes, after every readiness gate:",
    ...plans.map((plan) => {
      const { key, hostname, requested, schedule } = plan;
      if (stopped.includes(key)) return skippedStopped(plan);
      return requested && schedule !== null
        ? `  ~ ${key} (${hostname}): install the dispatcher and skill, then reconcile ${schedule.cron} ${schedule.timezone} with ${schedule.provider}/${schedule.model}, mode ${schedule.mode}, cwd ${schedule.cwd}`
        : `  ~ ${key} (${hostname}): remove the factory dispatch schedule if it exists`;
    }),
    "End-to-end verification: observe each worker's release, repositories, Paseo and actual dispatch schedule.",
  ];
}

/** What an upgrade's plan shows first: the pin it moves, approved with the plan. */
export function describePinMove(move: PinMove): string[] {
  const shown = move.from === "unshown" ? "the release it pins now" : move.from;
  return [
    `Upgrade: factory.json's release pin moves from ${shown} to ${move.to}. It is written once you ` +
      "approve this plan, before anything is applied.",
  ];
}

/**
 * The whole factory plan an operator approves: an upgrade's pin move, then its target, its
 * infrastructure changes, then each worker's install and later stages, those of the stopped
 * workers skipped.
 */
export function describePlan(review: FactoryPlanReview): string[] {
  const { target, stopped } = review;
  return [
    ...(review.pinMove === undefined ? [] : describePinMove(review.pinMove)),
    "Factory plan:",
    ...describeTarget(target),
    ...describeInfrastructure(review.changes),
    ...describeWorkers(review.workers, target.release, stopped),
    ...describeControlPlane(review.controlPlane, stopped),
    ...describeRepositories(review.repositories, stopped),
    ...describeDispatch(review.dispatch, stopped),
  ];
}

/** The lines an operator approves the backend bootstrap plan from. */
export function describeBootstrapPlan(
  context: BootstrapContext,
  creates: readonly string[],
): string[] {
  return [
    `Backend bootstrap: the state bucket ${context.bucket} does not exist yet.`,
    ...describeTarget(context),
    "Terraform will create:",
    ...creates.map((address) => `  + ${address}`),
  ];
}

/** Any plan an operator approves. */
export function describeReview(review: PlanReview): string[] {
  return review.kind === "factory"
    ? describePlan(review)
    : describeBootstrapPlan(review.target, review.creates);
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

export function describeD11Refusal(refusal: D11Refusal): string[] {
  const missing =
    refusal.command === undefined
      ? "which fffactory does not have yet (D11; it arrives in milestone M3):"
      : `which only \`${refusal.command}\` does (D11):`;
  return [
    `Refusing: this change needs ${refusal.capability}, ${missing}`,
    ...refusal.reasons.map((reason) => `  ${reason}`),
    `Nothing was applied. ${refusal.instead}`,
  ];
}

/** Why `action` is refused for the resized guarded workers, and what to do first. */
export function describeStoppedResizeRefusal(action: string, refusal: ResizeGuard): string[] {
  const updated = ({ key, hostname }: PlannedWorker) =>
    `  ${key} (${hostname}): ${hostMachineAddress(key)} would be updated in place`;
  const starts = " a stopped instance to change its type:";
  if (refusal.inventory === "unreadable")
    return [
      `Refusing to ${action}: the plan changes the instance type of a worker the EC2 ` +
        `inventory could not be read to check is not stopped, and Terraform starts${starts}`,
      ...refusal.workers.map(updated),
      "Nothing was applied. Plan again once the EC2 inventory can be read.",
    ];
  const { workers } = refusal;
  const commands = workers.map(({ key }) => `\`fffactory worker start ${key}\``).join(" and ");
  const one = workers.length === 1;
  const once = workers.some(({ machine }) => machine === "stopping")
    ? ` once ${one ? "it has" : "they have"} stopped`
    : "";
  const stopping = (worker: PoweredDownWorker) =>
    worker.machine === "stopping" ? ", and it is stopping" : "";
  return [
    `Refusing to ${action}: the plan changes the instance type of a stopped worker, and ` +
      `Terraform starts${starts}`,
    ...workers.map((worker) => `${updated(worker)}${stopping(worker)}`),
    `Nothing was applied. Start ${one ? "it" : "each"} first with ${commands}${once}, then plan again.`,
  ];
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

export function staleRefusal(planId: string, reasons: readonly StaleReason[]): string[] {
  return [
    `Refusing to apply plan ${planId}: it is no longer the plan to apply:`,
    ...reasons.map((reason) => `  ${describeStaleReason(reason)}`),
    "Nothing was applied. Review a new plan with `fffactory plan`.",
  ];
}

function hardeningLabel(setting: BucketHardening, readiness: StateBucketReadiness): string {
  const labels: Record<BucketHardening, string> = {
    versioning: `versioning (${readiness.versioning ?? "never enabled"})`,
    public_access_block: "public access block",
    default_encryption: "default encryption",
    tls_only_policy: "TLS-only bucket policy",
  };
  return labels[setting];
}

function hardeningCommand(setting: BucketHardening, location: StateBucketLocation): string {
  const commands: Record<BucketHardening, readonly [string, string]> = {
    versioning: ["put-bucket-versioning", "--versioning-configuration Status=Enabled"],
    public_access_block: [
      "put-public-access-block",
      "--public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true," +
        "BlockPublicPolicy=true,RestrictPublicBuckets=true",
    ],
    default_encryption: [
      "put-bucket-encryption",
      "--server-side-encryption-configuration " +
        `'${JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] })}'`,
    ],
    tls_only_policy: ["put-bucket-policy", `--policy '${tlsOnlyPolicy(location.bucket)}'`],
  };
  const [command, settings] = commands[setting];
  return (
    `aws s3api ${command} --region ${location.region} --bucket ${location.bucket} ` +
    `--expected-bucket-owner ${location.accountId} ${settings}`
  );
}

// TODO(re-evaluate when the state-bucket module's hardening changes, or when apply can import
// existing resources into the backend root): converge the state bucket's hardening on rerun
// through the reviewed backend plan instead of printing AWS CLI commands.
/**
 * Why an operation refuses a state bucket that exists but lacks some of backend bootstrap's
 * settings, and how to complete it: fffactory itself cannot finish an interrupted bootstrap.
 */
export function unreadyBucketRefusal({ location, readiness, missing }: UnreadyBucket): string[] {
  return [
    `The state bucket ${location.bucket} exists, but backend bootstrap did not finish it. It lacks:`,
    ...missing.map((setting) => `  ${hardeningLabel(setting, readiness)}`),
    "If another first apply is still bootstrapping it, wait for that to finish, then retry.",
    "Otherwise complete the bucket with these AWS CLI commands, using credentials for account " +
      `${location.accountId}, then retry:`,
    ...missing.map((setting) => `  ${hardeningCommand(setting, location)}`),
    ...(missing.includes("tls_only_policy")
      ? ["put-bucket-policy replaces the whole bucket policy: add any statements it already has."]
      : []),
  ];
}
