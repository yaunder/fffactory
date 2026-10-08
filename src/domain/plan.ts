/**
 * Factory plans: what `fffactory plan` shows and saves, and what `fffactory apply` applies.
 * A saved plan is bound to the circumstances it was planned in (factory.json's exact text,
 * the release and its assets, the AWS account and the factory's Terraform state); applying
 * it in any others is refused, as is a plan older than its lifetime. Until the lifecycle
 * work of milestone M3 lands, a plan that would remove a host key or destroy or replace a
 * host machine is refused, naming the capability it needs (D11).
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

/** What every plan shows first: which factory.json, factory, account, Region and release. */
export interface PlanTarget {
  readonly instancePath: string;
  readonly name?: string;
  readonly factoryId: FactoryId;
  readonly accountId: string;
  readonly region: string;
  readonly release: Release;
}

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

/** Terraform's symbol for each kind of change, and what it counts as. */
const KINDS: Readonly<
  Record<string, { readonly symbol: string; readonly add: number; readonly change: number }>
> = {
  create: { symbol: "+", add: 1, change: 0 },
  update: { symbol: "~", add: 0, change: 1 },
  delete: { symbol: "-", add: 0, change: 0 },
  "delete,create": { symbol: "-/+", add: 1, change: 0 },
  "create,delete": { symbol: "+/-", add: 1, change: 0 },
};

function describeChange({ address, actions }: ResourceChange): string {
  const kind = KINDS[actions.join()];
  return kind === undefined
    ? `  ${address} (${actions.join(", ")})`
    : `  ${kind.symbol} ${address}`;
}

/** The infrastructure changes a plan makes, as the operator approves them. */
export function describeInfrastructure(changes: readonly ResourceChange[]): string[] {
  const changing = changes.filter(changesSomething);
  if (changing.length === 0) return ["Infrastructure: no changes."];
  const count = (measure: (change: ResourceChange) => number) =>
    changing.reduce((total, change) => total + measure(change), 0);
  const added = count(({ actions }) => KINDS[actions.join()]?.add ?? 0);
  const changed = count(({ actions }) => KINDS[actions.join()]?.change ?? 0);
  const destroyed = count(({ actions }) => (actions.includes("delete") ? 1 : 0));
  return [
    "Infrastructure changes:",
    ...changing.map(describeChange),
    `  ${added} to add, ${changed} to change, ${destroyed} to destroy.`,
  ];
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

export function describeDispatch(plans: readonly PlannedDispatch[]): string[] {
  if (plans.length === 0) return [];
  return [
    "Dispatch changes, after every readiness gate:",
    ...plans.map(({ key, hostname, requested, schedule }) =>
      requested && schedule !== null
        ? `  ~ ${key} (${hostname}): install the dispatcher and skill, then reconcile ${schedule.cron} ${schedule.timezone} with ${schedule.provider}/${schedule.model}, mode ${schedule.mode}, cwd ${schedule.cwd}`
        : `  ~ ${key} (${hostname}): remove the factory dispatch schedule if it exists`,
    ),
    "End-to-end verification: observe each worker's release, repositories, Paseo and actual dispatch schedule.",
  ];
}

export function describeControlPlane(plans: readonly PlannedControlPlane[]): string[] {
  if (plans.length === 0) return [];
  return [
    "Control-plane changes, before worker activation:",
    ...plans.map(({ key, hostname, changes }) =>
      changes.length === 0
        ? `  = ${key} (${hostname}): Paseo is unchanged`
        : `  ~ ${key} (${hostname}): ${changes.join(", ")}`,
    ),
  ];
}

/** The workers factory.json declares, in its order, which is the order they are updated. */
export function declaredWorkers(instance: FactoryInstance, factoryId: FactoryId): PlannedWorker[] {
  return (instance.hosts ?? []).map(({ key }) => ({ key, hostname: hostName(factoryId, key) }));
}

/** The address the hosts module gives host `key`'s machine. */
function hostMachineAddress(key: HostKey): string {
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

/**
 * The workers stage's changes, as the operator approves them. Each worker gets the release
 * and its host configuration and is verified, whatever it runs now: every step is
 * idempotent, so the stage depends only on factory.json and the release, which a saved plan
 * is bound to. Rerunning apply converges what remains.
 */
export function describeWorkers(workers: readonly PlannedWorker[], release: Release): string[] {
  if (workers.length === 0) return [];
  return [
    "Worker changes, one worker at a time:",
    ...workers.map(
      ({ key, hostname }) =>
        `  ~ ${key} (${hostname}): install release ${release} and its host configuration, then verify it`,
    ),
  ];
}

/** The repository-stage mutations included in the approved plan. */
export function describeRepositories(
  workers: readonly PlannedWorker[],
  instance: FactoryInstance,
): string[] {
  if (workers.length === 0) return [];
  const byKey = new Map((instance.hosts ?? []).map((host) => [host.key, host]));
  return [
    "Repository changes, one worker at a time:",
    ...workers.map(({ key, hostname }) => {
      const count = byKey.get(key)?.repositories?.length ?? 0;
      return `  ~ ${key} (${hostname}): reconcile ${count} placed ${count === 1 ? "repository" : "repositories"} as factory; preserve and report unmanaged checkouts`;
    }),
  ];
}

/**
 * The whole plan an operator approves: its target, then its infrastructure changes, then
 * each worker's install.
 */
export function describePlan(
  target: PlanTarget,
  changes: readonly ResourceChange[],
  workers: readonly PlannedWorker[] = [],
  instance?: FactoryInstance,
  controlPlane: readonly PlannedControlPlane[] = [],
  dispatch: readonly PlannedDispatch[] = [],
): string[] {
  return [
    "Factory plan:",
    ...describeTarget(target),
    ...describeInfrastructure(changes),
    ...describeWorkers(workers, target.release),
    ...describeControlPlane(controlPlane),
    ...(instance === undefined ? [] : describeRepositories(workers, instance)),
    ...describeDispatch(dispatch),
  ];
}

/** A change a lifecycle capability not yet built would need, refused until it lands (D11). */
export interface D11Refusal {
  readonly capability: string;
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
function isHostMachine({ address, type, mode }: ResourceChange): boolean {
  if (mode !== undefined && mode !== "managed") return false;
  if (type !== undefined) return type === "aws_instance";
  return HOST_MACHINE.test(address);
}

/**
 * What a host machine may undergo before host retirement and replacement land: creation, an
 * in-place update, or nothing. Any other action, even one fffactory does not know, is refused.
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
 * retirement and replacement land.
 */
export function hostMachineRefusal(changes: readonly ResourceChange[]): D11Refusal | undefined {
  const lost = changes.filter((change) => isHostMachine(change) && !keepsHost(change.actions));
  if (lost.length === 0) return undefined;
  return {
    capability: "host retirement and replacement",
    reasons: lost.map(({ address, actions }) => `${address} would be ${fate(actions)}`),
    instead: "Change factory.json so the plan keeps every host machine, then plan again.",
  };
}

/**
 * D11: removing (or renaming) a host key the factory's state records is refused until host
 * retirement lands. `issues` are the stable host key check's.
 */
export function hostKeyRemovalRefusal(issues: readonly Issue[]): D11Refusal | undefined {
  if (issues.length === 0) return undefined;
  return {
    capability: "host retirement",
    reasons: issues.map(({ path, message }) => `${path}: ${message}`),
    instead: "Declare every provisioned host key in factory.json again, then plan again.",
  };
}

export function describeD11Refusal(refusal: D11Refusal): string[] {
  return [
    `Refusing: this change needs ${refusal.capability}, which fffactory does not have yet ` +
      "(D11; it arrives in milestone M3):",
    ...refusal.reasons.map((reason) => `  ${reason}`),
    `Nothing was applied. ${refusal.instead}`,
  ];
}

/**
 * A saved plan's record, kept beside its Terraform plan file in the local plan store. It
 * holds no configuration values: factory.json is bound by its SHA-256.
 */
export interface SavedPlan {
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
  /** The AWS account the account check allowed. */
  readonly account_id: string;
  /**
   * The revision of the factory's Terraform state object in the state bucket, read before
   * planning; null when there was no state yet.
   */
  readonly state_revision: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  /** The changes the plan makes, as shown when it was saved. */
  readonly changes: readonly ResourceChange[];
  readonly control_plane?: readonly PlannedControlPlane[];
  readonly dispatch: readonly PlannedDispatch[];
}

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
}

export function newSavedPlan(plan: NewSavedPlan): SavedPlan {
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
    changes: plan.changes.map(({ address, type, mode, actions }) => ({
      address,
      ...(type === undefined ? {} : { type }),
      ...(mode === undefined ? {} : { mode }),
      actions: [...actions],
    })),
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

function hasPlanFields(document: Record<string, unknown>): boolean {
  const { instance_path, configuration_sha256, release, assets_sha256, account_id } = document;
  return (
    printable(instance_path) &&
    printable(configuration_sha256) &&
    typeof release === "string" &&
    parseRelease(release).ok &&
    printable(assets_sha256) &&
    printable(account_id) &&
    (document.state_revision === null || printable(document.state_revision)) &&
    isoTime(document.created_at) &&
    isoTime(document.expires_at)
  );
}

/**
 * Reads a saved plan record of `factoryId` with `planId`, or undefined when the text is not
 * one: a plan that cannot be read is never applied.
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
  const changes = readChanges(document.changes);
  const controlPlane = readControlPlane(document.control_plane, factoryId);
  const dispatch = readDispatch(document.dispatch, factoryId);
  if (
    changes === undefined ||
    controlPlane === undefined ||
    dispatch === undefined ||
    !hasPlanFields(document)
  )
    return undefined;
  return {
    ...(document as unknown as SavedPlan),
    changes,
    control_plane: controlPlane,
    dispatch,
  };
}

/**
 * Why a saved plan may no longer be applied in `current`, before the state is read: every
 * reason, or none when it is fresh. The same factory.json text, release and assets, and
 * account, within the plan's lifetime, are required.
 */
export function planStaleness(plan: SavedPlan, current: PlanCircumstances): string[] {
  const reasons: [boolean, string][] = [
    [current.now.getTime() > Date.parse(plan.expires_at), `it expired at ${plan.expires_at}`],
    [
      current.instancePath !== plan.instance_path,
      `it was planned for another factory.json, ${plan.instance_path}`,
    ],
    [
      current.configurationSha256 !== plan.configuration_sha256,
      "factory.json changed after it was planned",
    ],
    [
      current.release !== plan.release,
      `it was planned by fffactory ${plan.release}, not this release`,
    ],
    [
      current.release === plan.release && current.assetsSha256 !== plan.assets_sha256,
      "it was planned with other release assets than this fffactory's",
    ],
    [
      current.accountId !== plan.account_id,
      `it was planned in AWS account ${plan.account_id}, not this one`,
    ],
  ];
  return reasons.filter(([stale]) => stale).map(([, reason]) => reason);
}

/**
 * Why a saved plan may no longer be applied once the factory lock is held: the factory's
 * Terraform state is not the revision it was planned against (or appeared or vanished).
 */
export function stateStaleness(plan: SavedPlan, revision: string | undefined): string | undefined {
  if ((revision ?? null) === plan.state_revision) return undefined;
  return "the factory's Terraform state changed after it was planned";
}

export function staleRefusal(planId: string, reasons: readonly string[]): string[] {
  return [
    `Refusing to apply plan ${planId}: it is no longer the plan to apply:`,
    ...reasons.map((reason) => `  ${reason}`),
    "Nothing was applied. Review a new plan with `fffactory plan`.",
  ];
}

/**
 * The factory's Terraform state object in the state bucket: the key the factory root
 * module's S3 backend declares (`assets/terraform/factory/versions.tf`).
 */
export const FACTORY_STATE_KEY = "factory/terraform.tfstate";
