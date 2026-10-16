/**
 * Factory plans: what `fffactory plan` shows and saves, and what `fffactory apply` applies.
 * A saved plan is bound to the circumstances it was planned in (factory.json's exact text,
 * the release and its assets, the AWS account and the factory's Terraform state, or for a
 * bootstrap plan the state bucket's absence); applying it in any others is refused, as is a
 * plan older than its lifetime. A plan that would
 * remove a host key is refused, naming `fffactory worker terminate KEY`, the only command that
 * removes a host (`host-removal.ts`); until host replacement lands in milestone M3, one that
 * would destroy or replace a host machine is refused, naming the capability it needs (D11).
 *
 * The plan an operator approves is a `PlanReview`, data only: `cli/presentation/plan.ts` lays it
 * out as text, as it does each refusal and `StaleReason`.
 */
import { type RandomBytes, randomAlphanumeric } from "./initialization";
import {
  type DispatchSettings,
  type FactoryId,
  type FactoryInstance,
  type HostKey,
  type Issue,
  parseHostKey,
  parseRelease,
  type Release,
} from "./instance";
import { compareReleases } from "./release-compatibility";
import { hostName } from "./resource-naming";
import { isRecord } from "./validation";
import { CHANGE_TYPES, type ChangeType } from "./change-classification";
import type { DispatchSchedule } from "./dispatch-projection";
import type { BootstrapContext } from "./backend-bootstrap";
import type { PinMove } from "./release-compatibility";

export const PLAN_SCHEMA_VERSION = 1;

/**
 * How long a saved plan may be applied. Short, so a plan is applied while its review is
 * fresh; freshness never rests on age alone (`planStaleness`, `stateStaleness`).
 */
export const PLAN_TTL_MS = 60 * 60 * 1000;

/**
 * How long the local plan store keeps a plan directory: an expired plan until this long
 * after it expires, so applying it is refused as expired rather than unknown and a plan in
 * use as it expires is never removed under it; a directory never saved until this long after
 * it was made, so an apply waiting at its approval question keeps its plan.
 */
export const PLAN_KEPT_MS = 24 * 60 * 60 * 1000;

/** Whether the plan store may remove a saved plan: it expired over `PLAN_KEPT_MS` ago. */
export function isPrunable(plan: SavedPlan, now: Date): boolean {
  return now.getTime() > Date.parse(plan.expires_at) + PLAN_KEPT_MS;
}

const PLAN_ID_LENGTH = 8;
const PLAN_ID = /^[a-z0-9]{8}$/;

/** A new plan ID: eight random lowercase letters or digits, drawn like a factory ID. */
export function newPlanId(randomBytes: RandomBytes): string {
  return randomAlphanumeric(randomBytes, PLAN_ID_LENGTH);
}

/** Only a well-formed plan ID names a saved plan, so an argument can never name a path. */
export function isPlanId(value: string): boolean {
  return PLAN_ID.test(value);
}

/**
 * The CLI/pin match guard: only the release factory.json pins may plan or change the
 * factory. Moving the pin forward is `fffactory upgrade`'s; it is never moved back. A missing
 * pin is the completeness check's to report. The pin is never echoed: it is a configuration
 * value.
 */
export function pinRefusal(pinned: string | undefined, running: Release): string | undefined {
  if (pinned === undefined || pinned === running) return undefined;
  const parsed = parseRelease(pinned);
  const earlier = parsed.ok && compareReleases(parsed.value, running) <= 0;
  return (
    `factory.json pins another fffactory release than this one, ${running}: only the pinned ` +
    "release may plan or change this factory. Install the release factory.json pins" +
    (earlier
      ? `, or move the pin to ${running} with \`fffactory upgrade\`.`
      : ": fffactory never moves a pin back to an earlier release.")
  );
}

/** One resource's planned actions, from Terraform's JSON plan. */
export interface ResourceChange {
  readonly address: string;
  /** The resource type, such as `aws_instance`, when the plan names one. */
  readonly type?: string;
  /** `managed` or `data`, when the plan names it. */
  readonly mode?: string;
  readonly actions: readonly string[];
}

const PRINTABLE = /^[\x20-\x7e]+$/;

function printable(value: unknown): value is string {
  return typeof value === "string" && PRINTABLE.test(value);
}

/** A change's actions. Terraform always names one; an empty list is unreadable, failing closed. */
function readActions(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(printable)) return undefined;
  return value;
}

/** An optional printable field: absent, or the value; undefined marks it unreadable. */
function optional(value: unknown): { readonly value?: string } | undefined {
  if (value === undefined) return {};
  return printable(value) ? { value } : undefined;
}

function readChange(value: unknown): ResourceChange | undefined {
  if (!isRecord(value) || !printable(value.address)) return undefined;
  const actions = readActions(isRecord(value.change) ? value.change.actions : undefined);
  const type = optional(value.type);
  const mode = optional(value.mode);
  if (actions === undefined || type === undefined || mode === undefined) return undefined;
  return {
    address: value.address,
    ...(type.value === undefined ? {} : { type: type.value }),
    ...(mode.value === undefined ? {} : { mode: mode.value }),
    actions,
  };
}

/**
 * Every resource change in a Terraform JSON plan (`terraform show -json`), or undefined
 * when the plan cannot be read.
 */
export function resourceChanges(plan: unknown): ResourceChange[] | undefined {
  if (!isRecord(plan)) return undefined;
  if (plan.resource_changes === undefined) return [];
  if (!Array.isArray(plan.resource_changes)) return undefined;
  const changes = plan.resource_changes.map(readChange);
  return changes.every((change) => change !== undefined) ? changes : undefined;
}

/** Actions that change nothing: reading a data source, or leaving a resource as it is. */
const UNCHANGED = new Set(["no-op", "read"]);

/** Whether a planned resource change changes anything: not only reads and no-ops. */
export function changesSomething({ actions }: ResourceChange): boolean {
  return !actions.every((action) => UNCHANGED.has(action));
}

/** Whether two plans make the same changes to the same resources, in the same order. */
export function sameChanges(a: readonly ResourceChange[], b: readonly ResourceChange[]): boolean {
  const key = (changes: readonly ResourceChange[]) =>
    JSON.stringify(changes.map(({ address, actions }) => [address, actions]));
  return key(a) === key(b);
}

/** What every plan shows first: which factory.json, factory, account, Region and release. */
export interface PlanTarget {
  readonly instancePath: string;
  readonly name?: string;
  readonly factoryId: FactoryId;
  readonly accountId: string;
  readonly region: string;
  readonly release: Release;
}

/**
 * What a change does to its resource. Terraform plans a replacement as two actions in either
 * order; anything else (a `forget`, an action fffactory does not know) is `other`.
 */
export type ChangeKind = "create" | "update" | "delete" | "replace" | "other";

const KINDS: Readonly<Record<string, ChangeKind>> = {
  create: "create",
  update: "update",
  delete: "delete",
  "delete,create": "replace",
  "create,delete": "replace",
};

export function changeKind({ actions }: ResourceChange): ChangeKind {
  return KINDS[actions.join()] ?? "other";
}

/** How many changes change something, and how many resources each adds, changes or destroys. */
export interface ChangeTally {
  readonly changing: number;
  readonly add: number;
  readonly change: number;
  readonly destroy: number;
}

/**
 * The tally of the changes that change something: a creation or replacement adds a resource,
 * an in-place update changes one, and any change that deletes destroys one.
 */
export function changeTally(changes: readonly ResourceChange[]): ChangeTally {
  const changing = changes.filter(changesSomething);
  const count = (measure: (change: ResourceChange) => boolean) => changing.filter(measure).length;
  return {
    changing: changing.length,
    add: count((change) => ["create", "replace"].includes(changeKind(change))),
    change: count((change) => changeKind(change) === "update"),
    destroy: count(({ actions }) => actions.includes("delete")),
  };
}

/** A worker the workers stage installs: its stable key and namespaced hostname. */
export interface PlannedWorker {
  readonly key: HostKey;
  readonly hostname: string;
}

export interface PlannedControlPlane extends PlannedWorker {
  /** The live release/configuration state this decision was made from. */
  readonly observation: string;
  readonly changes: readonly ChangeType[];
}

export interface PlannedDispatch extends PlannedWorker {
  readonly requested: boolean;
  readonly schedule: DispatchSchedule | null;
}

function plannedSchedule(settings: DispatchSettings | undefined): DispatchSchedule | null {
  if (settings?.enabled !== true) return null;
  const { cron, timezone, provider, model, mode, cwd } = settings;
  if (
    cron === undefined ||
    timezone === undefined ||
    provider === undefined ||
    model === undefined ||
    mode === undefined ||
    cwd === undefined
  )
    throw new Error("enabled dispatch settings are incomplete");
  return { cron, timezone, provider, model, mode, cwd };
}

export function plannedDispatch(
  instance: FactoryInstance,
  factoryId: FactoryId,
): PlannedDispatch[] {
  return (instance.hosts ?? []).map((host) => {
    const settings = host.dispatch;
    const requested = settings?.enabled === true;
    return {
      key: host.key,
      hostname: hostName(factoryId, host.key),
      requested,
      schedule: plannedSchedule(settings),
    };
  });
}

/** The workers factory.json declares, in its order, which is the order they are updated. */
export function declaredWorkers(instance: FactoryInstance, factoryId: FactoryId): PlannedWorker[] {
  return (instance.hosts ?? []).map(({ key }) => ({ key, hostname: hostName(factoryId, key) }));
}

/** The address the hosts module gives host `key`'s machine. */
export function hostMachineAddress(key: HostKey): string {
  return `module.hosts.aws_instance.host["${key}"]`;
}

/**
 * The workers whose host machine the plan creates, in their order: apply waits for their
 * first boot before installing them (`docs/specs/plan-apply.md` §Waiting for a new worker).
 */
export function createdWorkers(
  changes: readonly ResourceChange[],
  workers: readonly PlannedWorker[],
): HostKey[] {
  const created = new Set(
    changes
      .filter((change) => isHostMachine(change) && change.actions.includes("create"))
      .map(({ address }) => address),
  );
  return workers.filter(({ key }) => created.has(hostMachineAddress(key))).map(({ key }) => key);
}

/** The repositories factory.json places on a worker, which the repositories stage reconciles. */
export interface PlannedRepositories extends PlannedWorker {
  readonly placed: readonly string[];
}

/** Each worker's placed repositories, in the workers' order. */
function plannedRepositories(
  workers: readonly PlannedWorker[],
  instance: FactoryInstance,
): PlannedRepositories[] {
  const byKey = new Map((instance.hosts ?? []).map((host) => [host.key, host]));
  return workers.map(({ key, hostname }) => ({
    key,
    hostname,
    placed: [...(byKey.get(key)?.repositories ?? [])],
  }));
}

/**
 * The whole factory plan an operator approves, as data: its target, its infrastructure
 * changes, then each declared worker's install and later stages, those of the `stopped`
 * workers skipped. Each worker's install is idempotent, so the workers stage depends only on
 * factory.json and the release, which a saved plan is bound to; a worker whose machine is
 * stopped is skipped, and apply never starts it. An upgrade's review also carries the pin move
 * it approves.
 */
export interface FactoryPlanReview {
  readonly kind: "factory";
  readonly target: PlanTarget;
  readonly changes: readonly ResourceChange[];
  /** Every declared worker, in the order they are updated; none for an empty factory. */
  readonly workers: readonly PlannedWorker[];
  readonly repositories: readonly PlannedRepositories[];
  readonly controlPlane: readonly PlannedControlPlane[];
  readonly dispatch: readonly PlannedDispatch[];
  readonly stopped: readonly HostKey[];
  readonly pinMove?: PinMove;
}

/** Backend bootstrap's plan: the bucket it creates, and every resource it creates. */
export interface BootstrapPlanReview {
  readonly kind: "backend_bootstrap";
  readonly target: BootstrapContext;
  readonly creates: readonly string[];
}

/** A plan as the operator approves it (the `Approval` port's input). */
export type PlanReview = FactoryPlanReview | BootstrapPlanReview;

export interface FactoryPlanReviewInput {
  readonly target: PlanTarget;
  readonly changes: readonly ResourceChange[];
  readonly instance: FactoryInstance;
  readonly controlPlane: readonly PlannedControlPlane[];
  readonly dispatch: readonly PlannedDispatch[];
  readonly stopped: readonly HostKey[];
  readonly pinMove?: PinMove | undefined;
}

/** The review of a factory plan of `instance`: every declared worker and its repositories. */
export function factoryPlanReview(input: FactoryPlanReviewInput): FactoryPlanReview {
  const workers = declaredWorkers(input.instance, input.target.factoryId);
  return {
    kind: "factory",
    target: input.target,
    changes: input.changes,
    workers,
    repositories: plannedRepositories(workers, input.instance),
    controlPlane: input.controlPlane,
    dispatch: input.dispatch,
    stopped: input.stopped,
    ...(input.pinMove === undefined ? {} : { pinMove: input.pinMove }),
  };
}

/**
 * Why Terraform's plan is not one fffactory can apply: it, or the host keys the state
 * records, cannot be read, or a backend bootstrap plan does more than create, or creates
 * nothing.
 */
export type UnexpectedPlan =
  | { readonly kind: "unreadable_plan" }
  | { readonly kind: "unreadable_host_keys" }
  | { readonly kind: "not_create"; readonly change: ResourceChange }
  | { readonly kind: "creates_nothing" };

/**
 * A change a lifecycle capability not yet built would need, refused until it lands (D11), or
 * one only a lifecycle command (`command`) may make.
 */
export interface D11Refusal {
  readonly capability: string;
  /** The only command that makes the change, when one does. */
  readonly command?: string;
  readonly reasons: readonly string[];
  /** What the operator can do instead. */
  readonly instead: string;
}

/** An `aws_instance` address, such as `module.hosts.aws_instance.host["builder-1"]`. */
const HOST_MACHINE = /(^|\.)aws_instance\.[A-Za-z0-9_-]+(\[[^\]]*\])?$/;

/**
 * A managed `aws_instance`. A plan that names no mode is judged by type and address alone,
 * failing closed: a data source is only ever read, so it is never refused anyway.
 */
export function isHostMachine({ address, type, mode }: ResourceChange): boolean {
  if (mode !== undefined && mode !== "managed") return false;
  if (type !== undefined) return type === "aws_instance";
  return HOST_MACHINE.test(address);
}

/**
 * What a host machine may undergo before host replacement lands: creation, an in-place
 * update, or nothing. Any other action, even one fffactory does not know, is refused.
 */
const KEEPS_HOST = new Set(["no-op", "read", "create", "update"]);

function keepsHost(actions: readonly string[]): boolean {
  return actions.every((action) => KEEPS_HOST.has(action));
}

function fate(actions: readonly string[]): string {
  if (actions.includes("forget")) return "forgotten by Terraform";
  if (actions.includes("delete")) return actions.includes("create") ? "replaced" : "destroyed";
  const unknown = actions.filter((action) => !KEEPS_HOST.has(action));
  return `changed by an action fffactory does not know (${unknown.join(", ")})`;
}

/**
 * D11: a plan that does anything to a host machine (an `aws_instance`) but create it, update
 * it in place or leave it, such as destroying or replacing it, is refused until host
 * replacement lands. Only `fffactory worker terminate KEY`'s removal plan destroys one
 * (`host-removal.ts`).
 */
export function hostMachineRefusal(changes: readonly ResourceChange[]): D11Refusal | undefined {
  const lost = changes.filter((change) => isHostMachine(change) && !keepsHost(change.actions));
  if (lost.length === 0) return undefined;
  return {
    capability: "host replacement",
    reasons: lost.map(({ address, actions }) => `${address} would be ${fate(actions)}`),
    instead: "Change factory.json so the plan keeps every host machine, then plan again.",
  };
}

/** The one command that removes a host, its machine with it. */
const REMOVES_HOST = "fffactory worker terminate KEY";

/**
 * D11: removing (or renaming) a host key the factory's state records by editing factory.json is
 * refused: only `fffactory worker terminate KEY` removes a host. `issues` are the stable host
 * key check's.
 */
export function hostKeyRemovalRefusal(issues: readonly Issue[]): D11Refusal | undefined {
  if (issues.length === 0) return undefined;
  return {
    capability: "host removal",
    command: REMOVES_HOST,
    reasons: issues.map(({ path, message }) => `${path}: ${message}`),
    instead:
      "Declare every provisioned host key in factory.json again, then remove a host with " +
      `\`${REMOVES_HOST}\`.`,
  };
}

/**
 * Whether a JSON plan's change sets another instance type. One it cannot read, or whose new
 * type is not known until apply, is taken as one, failing closed.
 */
function changesInstanceType(change: unknown): boolean {
  if (!isRecord(change) || !isRecord(change.before) || !isRecord(change.after)) return true;
  if (isRecord(change.after_unknown) && change.after_unknown.instance_type === true) return true;
  return change.before.instance_type !== change.after.instance_type;
}

/**
 * The workers among `guarded` whose host machine a JSON plan (`terraform show -json`) updates
 * in place with another instance type, in their order.
 */
export function resizedStoppedWorkers<W extends PlannedWorker>(
  plan: unknown,
  guarded: readonly W[],
): W[] {
  if (!isRecord(plan) || !Array.isArray(plan.resource_changes)) return [];
  const resized = new Set(
    plan.resource_changes
      .filter((raw) => {
        const change = readChange(raw);
        return (
          change !== undefined &&
          isHostMachine(change) &&
          change.actions.includes("update") &&
          changesInstanceType((raw as Record<string, unknown>).change)
        );
      })
      .map((raw) => (raw as Record<string, unknown>).address),
  );
  return guarded.filter(({ key }) => resized.has(hostMachineAddress(key)));
}

/** A worker whose machine the EC2 inventory shows stopped or stopping. */
export interface PoweredDownWorker extends PlannedWorker {
  readonly machine: "stopped" | "stopping";
}

/**
 * The workers whose instance type a plan may not change now. The pinned AWS provider changes
 * an instance's type by stopping it (waiting for one stopping), modifying it and starting it
 * again, whatever state it was in, so applying that change would start a worker that is
 * stopped or stopping: it is refused until the operator starts the worker
 * (`docs/specs/plan-apply.md` §Instance type of a stopped worker). With the EC2 inventory
 * unreadable no worker is known not to be stopped, so every declared one is guarded, failing
 * closed.
 */
export type ResizeGuard =
  | { readonly inventory: "read"; readonly workers: readonly PoweredDownWorker[] }
  | { readonly inventory: "unreadable"; readonly workers: readonly PlannedWorker[] };

/** The guarded workers a JSON plan changes the instance type of, or undefined when none. */
export function resizeRefusal(plan: unknown, guard: ResizeGuard): ResizeGuard | undefined {
  const refused: ResizeGuard =
    guard.inventory === "read"
      ? { inventory: "read", workers: resizedStoppedWorkers(plan, guard.workers) }
      : { inventory: "unreadable", workers: resizedStoppedWorkers(plan, guard.workers) };
  return refused.workers.length === 0 ? undefined : refused;
}

/** What every saved plan's record binds, whatever its kind. */
interface SavedPlanBinding {
  readonly schema_version: typeof PLAN_SCHEMA_VERSION;
  readonly plan_id: string;
  readonly factory_id: FactoryId;
  /** The resolved factory.json the plan was made from. */
  readonly instance_path: string;
  /** SHA-256 of factory.json's exact text when it was planned. */
  readonly configuration_sha256: string;
  /** The fffactory release that planned it, and the SHA-256 of that release's assets. */
  readonly release: Release;
  readonly assets_sha256: string;
  /** The AWS account the account check allowed: the only part of the caller it binds. */
  readonly account_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  /** The changes the plan makes, as shown when it was saved. */
  readonly changes: readonly ResourceChange[];
}

/**
 * A saved factory plan's record, kept beside its factory Terraform plan file
 * (`factory.tfplan`) in the local plan store. It holds no configuration values: factory.json
 * is bound by its SHA-256. A record without `kind` is one.
 */
export interface SavedFactoryPlan extends SavedPlanBinding {
  readonly kind?: never;
  /**
   * The revision of the factory's Terraform state object in the state bucket, read before
   * planning; null when there was no state yet.
   */
  readonly state_revision: string | null;
  readonly control_plane?: readonly PlannedControlPlane[];
  readonly dispatch: readonly PlannedDispatch[];
  /**
   * The workers whose machine was stopped when it was planned: the plan skips them, so apply
   * never installs them, even once they run again.
   */
  readonly stopped_workers: readonly HostKey[];
}

/**
 * A saved bootstrap plan's record, kept beside backend bootstrap's Terraform plan file
 * (`backend.tfplan`): made while the state bucket does not exist, so it has no state
 * revision, and nothing of the factory's workers. Its changes only create.
 */
export interface SavedBootstrapPlan extends SavedPlanBinding {
  readonly kind: "bootstrap";
}

/** A saved plan's record: a factory plan, or a bootstrap plan (`kind: "bootstrap"`). */
export type SavedPlan = SavedFactoryPlan | SavedBootstrapPlan;

/** The circumstances a plan is made or applied in. */
export interface PlanCircumstances {
  readonly factoryId: FactoryId;
  readonly instancePath: string;
  readonly configurationSha256: string;
  readonly release: Release;
  readonly assetsSha256: string;
  readonly accountId: string;
  readonly now: Date;
}

export interface NewSavedPlan extends PlanCircumstances {
  readonly planId: string;
  readonly stateRevision: string | undefined;
  readonly changes: readonly ResourceChange[];
  readonly controlPlane?: readonly PlannedControlPlane[];
  readonly dispatch?: readonly PlannedDispatch[];
  readonly stopped?: readonly HostKey[];
}

function copyChanges(changes: readonly ResourceChange[]): ResourceChange[] {
  return changes.map(({ address, type, mode, actions }) => ({
    address,
    ...(type === undefined ? {} : { type }),
    ...(mode === undefined ? {} : { mode }),
    actions: [...actions],
  }));
}

export function newSavedPlan(plan: NewSavedPlan): SavedFactoryPlan {
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    plan_id: plan.planId,
    factory_id: plan.factoryId,
    instance_path: plan.instancePath,
    configuration_sha256: plan.configurationSha256,
    release: plan.release,
    assets_sha256: plan.assetsSha256,
    account_id: plan.accountId,
    state_revision: plan.stateRevision ?? null,
    created_at: plan.now.toISOString(),
    expires_at: new Date(plan.now.getTime() + PLAN_TTL_MS).toISOString(),
    changes: copyChanges(plan.changes),
    control_plane: (plan.controlPlane ?? []).map(({ key, hostname, observation, changes }) => ({
      key,
      hostname,
      observation,
      changes: [...changes],
    })),
    dispatch: (plan.dispatch ?? []).map(({ key, hostname, requested, schedule }) => ({
      key,
      hostname,
      requested,
      schedule,
    })),
    stopped_workers: [...(plan.stopped ?? [])],
  };
}

export interface NewSavedBootstrapPlan extends PlanCircumstances {
  readonly planId: string;
  /** Backend bootstrap's changes, as its plan verdict passed them: each only creates. */
  readonly changes: readonly ResourceChange[];
}

/** Whether a bootstrap plan's changes are what it may make: one or more, each only a create. */
function onlyCreates(changes: readonly ResourceChange[]): boolean {
  return changes.length > 0 && changes.every(({ actions }) => actions.join() === "create");
}

/**
 * A saved bootstrap plan's record. Throws unless its changes only create: backend bootstrap
 * refuses any other plan before one is saved.
 */
export function newSavedBootstrapPlan(plan: NewSavedBootstrapPlan): SavedBootstrapPlan {
  if (!onlyCreates(plan.changes)) throw new Error("a bootstrap plan may only create");
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    kind: "bootstrap",
    plan_id: plan.planId,
    factory_id: plan.factoryId,
    instance_path: plan.instancePath,
    configuration_sha256: plan.configurationSha256,
    release: plan.release,
    assets_sha256: plan.assetsSha256,
    account_id: plan.accountId,
    created_at: plan.now.toISOString(),
    expires_at: new Date(plan.now.getTime() + PLAN_TTL_MS).toISOString(),
    changes: copyChanges(plan.changes),
  };
}

export function serializeSavedPlan(plan: SavedPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function isoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function readChanges(value: unknown): ResourceChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return resourceChanges({
    resource_changes: value.map((change) =>
      isRecord(change) ? { ...change, change: { actions: change.actions } } : change,
    ),
  });
}

const CHANGE_TYPE_SET = new Set<string>(CHANGE_TYPES);

function readControlPlaneItem(
  value: unknown,
  factoryId: FactoryId,
): PlannedControlPlane | undefined {
  if (!isRecord(value) || !printable(value.key) || !parseHostKey(value.key).ok) return undefined;
  if (value.hostname !== hostName(factoryId, value.key as HostKey)) return undefined;
  if (!printable(value.observation) || !Array.isArray(value.changes)) return undefined;
  if (!value.changes.every((change) => typeof change === "string" && CHANGE_TYPE_SET.has(change)))
    return undefined;
  if (new Set(value.changes).size !== value.changes.length) return undefined;
  return {
    key: value.key as HostKey,
    hostname: value.hostname,
    observation: value.observation,
    changes: value.changes as ChangeType[],
  };
}

function readControlPlane(value: unknown, factoryId: FactoryId): PlannedControlPlane[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const plans = value.map((item) => readControlPlaneItem(item, factoryId));
  if (!plans.every((plan) => plan !== undefined)) return undefined;
  const keys = plans.map((plan) => plan.key);
  return new Set(keys).size === keys.length ? plans : undefined;
}

const DISPATCH_SCHEDULE_FIELDS = ["cron", "timezone", "provider", "model", "mode", "cwd"] as const;

function dispatchSchedule(value: unknown): DispatchSchedule | undefined {
  if (!isRecord(value)) return undefined;
  if (!DISPATCH_SCHEDULE_FIELDS.every((field) => printable(value[field]))) return undefined;
  const cwd = value.cwd as string;
  if (!cwd.startsWith("/") || cwd.includes("\0") || cwd.includes("\r") || cwd.includes("\n"))
    return undefined;
  return Object.fromEntries(
    DISPATCH_SCHEDULE_FIELDS.map((field) => [field, value[field]]),
  ) as unknown as DispatchSchedule;
}

function readDispatchItem(value: unknown, factoryId: FactoryId): PlannedDispatch | undefined {
  if (!isRecord(value) || !printable(value.key) || !parseHostKey(value.key).ok) return undefined;
  if (value.hostname !== hostName(factoryId, value.key as HostKey)) return undefined;
  if (typeof value.requested !== "boolean") return undefined;
  if (!value.requested && value.schedule === null)
    return {
      key: value.key as HostKey,
      hostname: value.hostname,
      requested: false,
      schedule: null,
    };
  if (!value.requested) return undefined;
  const schedule = dispatchSchedule(value.schedule);
  if (schedule === undefined) return undefined;
  return {
    key: value.key as HostKey,
    hostname: value.hostname,
    requested: true,
    schedule,
  };
}

function readDispatch(value: unknown, factoryId: FactoryId): PlannedDispatch[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const plans = value.map((item) => readDispatchItem(item, factoryId));
  if (!plans.every((plan) => plan !== undefined)) return undefined;
  const keys = plans.map((plan) => plan.key);
  return new Set(keys).size === keys.length ? plans : undefined;
}

/** The stopped workers a record lists; none in a record made before they were planned. */
function readStoppedWorkers(value: unknown): HostKey[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((key) => typeof key === "string" && parseHostKey(key).ok)) return undefined;
  return new Set(value).size === value.length ? (value as HostKey[]) : undefined;
}

/** The fields every saved plan binds, but its changes, are readable. */
function hasBindingFields(document: Record<string, unknown>): boolean {
  const { instance_path, configuration_sha256, release, assets_sha256, account_id } = document;
  return (
    printable(instance_path) &&
    printable(configuration_sha256) &&
    typeof release === "string" &&
    parseRelease(release).ok &&
    printable(assets_sha256) &&
    printable(account_id) &&
    isoTime(document.created_at) &&
    isoTime(document.expires_at)
  );
}

/** What only a factory plan records; a bootstrap record holding any of them is unreadable. */
const FACTORY_PLAN_FIELDS = ["state_revision", "control_plane", "dispatch", "stopped_workers"];

function parseBootstrapPlan(document: Record<string, unknown>): SavedBootstrapPlan | undefined {
  if (FACTORY_PLAN_FIELDS.some((field) => document[field] !== undefined)) return undefined;
  const changes = readChanges(document.changes);
  if (changes === undefined || !onlyCreates(changes) || !hasBindingFields(document))
    return undefined;
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    kind: "bootstrap",
    plan_id: document.plan_id as string,
    factory_id: document.factory_id as FactoryId,
    instance_path: document.instance_path as string,
    configuration_sha256: document.configuration_sha256 as string,
    release: document.release as Release,
    assets_sha256: document.assets_sha256 as string,
    account_id: document.account_id as string,
    created_at: document.created_at as string,
    expires_at: document.expires_at as string,
    changes,
  };
}

function parseFactoryPlan(
  document: Record<string, unknown>,
  factoryId: FactoryId,
): SavedFactoryPlan | undefined {
  const changes = readChanges(document.changes);
  const controlPlane = readControlPlane(document.control_plane, factoryId);
  const dispatch = readDispatch(document.dispatch, factoryId);
  const stopped = readStoppedWorkers(document.stopped_workers);
  if (
    changes === undefined ||
    controlPlane === undefined ||
    dispatch === undefined ||
    stopped === undefined ||
    !(document.state_revision === null || printable(document.state_revision)) ||
    !hasBindingFields(document)
  )
    return undefined;
  return {
    ...(document as unknown as SavedFactoryPlan),
    changes,
    control_plane: controlPlane,
    dispatch,
    stopped_workers: stopped,
  };
}

/**
 * Reads a saved plan record of `factoryId` with `planId`, or undefined when the text is not
 * one: a plan that cannot be read is never applied. A record without `kind` is a factory
 * plan; `"bootstrap"` is a bootstrap plan; any other kind is unreadable.
 */
export function parseSavedPlan(
  text: string,
  factoryId: FactoryId,
  planId: string,
): SavedPlan | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(document) || document.schema_version !== PLAN_SCHEMA_VERSION) return undefined;
  if (document.factory_id !== factoryId || document.plan_id !== planId) return undefined;
  if (document.kind === undefined) return parseFactoryPlan(document, factoryId);
  return document.kind === "bootstrap" ? parseBootstrapPlan(document) : undefined;
}

/**
 * Why a saved plan is no longer the plan to apply, with what its refusal names: never a
 * configuration value, only what the plan's record or the factory's identity holds.
 */
export type StaleReason =
  /** Its lifetime ended. */
  | { readonly kind: "expired"; readonly expiresAt: string }
  /** It was planned for another factory.json, `instancePath`. */
  | { readonly kind: "other_instance"; readonly instancePath: string }
  | { readonly kind: "configuration_changed" }
  /** It was planned by fffactory `release`, not the running one. */
  | { readonly kind: "other_release"; readonly release: Release }
  /** The same release, but other release assets. */
  | { readonly kind: "other_assets" }
  /** It was planned in AWS account `accountId`, not the caller's. */
  | { readonly kind: "other_account"; readonly accountId: string }
  /** The factory's Terraform state is not the revision it was planned against. */
  | { readonly kind: "state_changed" }
  /** The state bucket it was planned against no longer exists. */
  | { readonly kind: "state_bucket_missing" }
  /** The state bucket a bootstrap plan was planned to create exists now, ready or not. */
  | { readonly kind: "state_bucket_created" }
  /** The EC2 inventory could not be read to check that worker `key` is still stopped. */
  | { readonly kind: "inventory_unreadable"; readonly key: HostKey }
  /** Worker `key` was stopped when it was planned, and is not now. */
  | { readonly kind: "worker_started"; readonly key: HostKey }
  /** Worker `key` is stopped now, and was not when it was planned. */
  | { readonly kind: "worker_stopped"; readonly key: HostKey }
  /** The Paseo state the plan's control-plane changes were made from changed on the worker. */
  | { readonly kind: "paseo_changed"; readonly key: HostKey; readonly hostname: string };

/**
 * Why a saved plan of either kind may no longer be applied in `current`, before the state is
 * read: every reason, or none when it is fresh. The same factory.json text, release and
 * assets, and account, within the plan's lifetime, are required.
 */
export function planStaleness(plan: SavedPlan, current: PlanCircumstances): StaleReason[] {
  const reasons: [boolean, StaleReason][] = [
    [
      current.now.getTime() > Date.parse(plan.expires_at),
      { kind: "expired", expiresAt: plan.expires_at },
    ],
    [
      current.instancePath !== plan.instance_path,
      { kind: "other_instance", instancePath: plan.instance_path },
    ],
    [current.configurationSha256 !== plan.configuration_sha256, { kind: "configuration_changed" }],
    [current.release !== plan.release, { kind: "other_release", release: plan.release }],
    [
      current.release === plan.release && current.assetsSha256 !== plan.assets_sha256,
      { kind: "other_assets" },
    ],
    [current.accountId !== plan.account_id, { kind: "other_account", accountId: plan.account_id }],
  ];
  return reasons.filter(([stale]) => stale).map(([, reason]) => reason);
}

/**
 * Why a saved bootstrap plan may no longer be applied: every reason a factory plan has but the
 * state revision, which a bootstrap plan has none of, and in its place the state bucket
 * existing now (`bucketExists`), ready or not. Every reason, or none when it is fresh.
 */
export function bootstrapStaleness(
  plan: SavedBootstrapPlan,
  current: PlanCircumstances,
  bucketExists: boolean,
): StaleReason[] {
  return [
    ...planStaleness(plan, current),
    ...(bucketExists ? [{ kind: "state_bucket_created" } as const] : []),
  ];
}

/**
 * Why a saved plan may no longer be applied once the factory lock is held: the factory's
 * Terraform state is not the revision it was planned against (or appeared or vanished).
 */
export function stateStaleness(
  plan: SavedFactoryPlan,
  revision: string | undefined,
): StaleReason | undefined {
  if ((revision ?? null) === plan.state_revision) return undefined;
  return { kind: "state_changed" };
}

/**
 * Why a saved plan may no longer be applied once the factory lock is held: a worker stopped or
 * started since it was planned, `stopped` being the workers stopped now, or undefined when the
 * EC2 inventory could not be read. A plan that skips no stopped worker needs no inventory, as
 * before stopped workers were planned.
 */
export function stoppedStaleness(
  plan: SavedFactoryPlan,
  stopped: readonly HostKey[] | undefined,
): StaleReason[] {
  const planned = plan.stopped_workers;
  if (stopped === undefined)
    return planned.map((key) => ({ kind: "inventory_unreadable", key }) as const);
  return [
    ...planned
      .filter((key) => !stopped.includes(key))
      .map((key) => ({ kind: "worker_started", key }) as const),
    ...stopped
      .filter((key) => !planned.includes(key))
      .map((key) => ({ kind: "worker_stopped", key }) as const),
  ];
}

/**
 * The factory's Terraform state object in the state bucket: the key the factory root
 * module's S3 backend declares (`assets/terraform/factory/versions.tf`).
 */
export const FACTORY_STATE_KEY = "factory/terraform.tfstate";
