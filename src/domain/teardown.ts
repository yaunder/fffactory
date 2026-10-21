/**
 * Removing a whole factory (`fffactory teardown`, epic #56, `docs/specs/teardown.md`): the
 * guarded destroy plan's rule (`docs/specs/provisioning.md` §Destroy plan) and what listing the
 * factory's tagged VPCs showed; the devices it deletes (D9), the secrets it keeps, the
 * confirmation by factory ID, the next actions of its gates, what it shows before it is
 * confirmed and reports once done, and the words of its refusals. The destroy plan is the only
 * plan, beside `worker terminate`'s removal plan (`host-removal.ts`), allowed to destroy a host
 * machine; `plan` and `apply` keep the D11 refusals (`plan.ts`). Pure.
 */
import { isGeneratedFactoryId } from "./initialization";
import {
  changesSomething,
  destroyedInstance,
  hostMachineAddress,
  isHostMachine,
  type PlanTarget,
  type ResourceChange,
  resourceChanges,
} from "./plan";
import {
  type FactoryId,
  type HostKey,
  type Issue,
  parseHostKey,
  type SecretReference,
} from "./instance";
import type { StageStatus } from "./operation";
import type { WorkerIdentity } from "./rollout";
import { carriesFactoryId, hostName } from "./resource-naming";
import { refersTo, type SecretInventory, type ListedSecret } from "./secrets";
import type { BucketDeletion, LockAfterDeletion } from "./state-bucket-deletion";
import { ADMIN_CONSOLE, type Machine, type MachineState } from "./status";
import { selectWorkerDevices, type TailnetDevice } from "./tailnet";
import { isRecord } from "./validation";
import { type Refusal, type RemovalGateActions, TRUST_CREDENTIALS } from "./worker-lifecycle";

/** The command every next action of teardown's reruns. */
const TEARDOWN = "`fffactory teardown`";

/** Completes a next action by rerunning teardown. */
export function thenRerunTeardown(step: string): string {
  return `${step}, then rerun ${TEARDOWN}.`;
}

function refusal(summary: string, nextAction: string, details: readonly string[] = []): Refusal {
  return { summary, details, nextAction };
}

/** What listing the factory's VPCs, by the factory ID tag, showed. */
export type VpcInventory =
  | { readonly kind: "vpcs"; readonly vpcIds: readonly string[] }
  /** The listing failed; `reason` names the error, never quoting AWS. */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * What a destroy plan may do to a resource, each a whole action list: destroy it, read it, or
 * leave it. Any other list, even one mixing these, is refused, failing closed.
 */
const DESTROYS = new Set(["delete", "no-op", "read"]);

/** A change as the refusal lists it: `ADDRESS (ACTIONS)`. */
function described({ address, actions }: ResourceChange): string {
  return `${address} (${actions.join(", ")})`;
}

/**
 * Why an instance delete (`change`, as read, and `raw`, as Terraform gives it) destroys an
 * instance it may not: one it does not name, one EC2 does not list for the factory, or one EC2
 * lists for another host or for none. Undefined when it destroys the instance EC2 lists for the
 * host at its address, the check `worker terminate` makes of the one host it removes.
 */
function wrongInstance(
  change: ResourceChange,
  raw: unknown,
  listed: readonly Machine[],
): string | undefined {
  const destroyed = destroyedInstance(raw);
  const line = described(change);
  if (destroyed === undefined) return `${line}: the plan does not name the instance it destroys`;
  const machine = listed.find(({ instanceId }) => instanceId === destroyed);
  if (machine === undefined)
    return `${line}: instance ${destroyed}, which EC2 does not list with the factory's tags`;
  // A tag that is not a well-formed host key is never echoed: it is not fffactory's to show.
  const key = parseHostKey(machine.hostKey ?? "");
  if (!key.ok)
    return `${line}: instance ${destroyed}, which EC2 lists without a well-formed host key tag`;
  if (hostMachineAddress(key.value) !== change.address)
    return `${line}: instance ${destroyed}, which EC2 lists for host ${key.value}`;
  return undefined;
}

/**
 * The guarded destroy plan's rule (D13), over Terraform's JSON plan of `plan -destroy`: every
 * resource change deletes, reads or leaves its resource, and every instance it deletes is one
 * EC2 lists for the factory (`listed`, the factory-ID-tagged instances) at its host's address.
 * A plan that cannot be read is refused, and so is anything else, each offending change listed
 * as `ADDRESS (ACTIONS)`. A plan with no change, an empty state's, passes: the factory's root
 * is already absent. Undefined when the plan may be applied.
 */
export function destroyPlanRefusal(plan: unknown, listed: readonly Machine[]): Refusal | undefined {
  const changes = resourceChanges(plan);
  if (changes === undefined)
    return {
      summary: "Terraform's destroy plan could not be read",
      details: [],
      nextAction: `Rerun ${TEARDOWN}.`,
    };
  const others = changes.filter(({ actions }) => !DESTROYS.has(actions.join()));
  if (others.length > 0)
    return {
      summary: "Terraform's destroy plan does more than destroy the factory's resources",
      details: others.map(described),
      nextAction: `Check the factory's Terraform state with \`fffactory plan\`, then rerun ${TEARDOWN}.`,
    };
  const raws = isRecord(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const wrong = changes.flatMap((change, index) =>
    isHostMachine(change) && change.actions.join() === "delete"
      ? [wrongInstance(change, raws[index], listed)].filter((line) => line !== undefined)
      : [],
  );
  if (wrong.length > 0)
    return {
      summary: "Terraform's destroy plan destroys an instance EC2 does not list for the factory",
      details: wrong,
      nextAction: `Check the factory's instances in the EC2 console, then rerun ${TEARDOWN}.`,
    };
  return undefined;
}

/**
 * Terraform's `-detailed-exitcode` and its JSON plan must agree (defence in depth): changes
 * reported with no resource change, or resource changes with none reported, refuse the plan.
 * Undefined when they agree.
 */
export function destroyPlanMismatch(
  reportsChanges: boolean,
  changes: readonly ResourceChange[],
): Refusal | undefined {
  const changing = changes.some(changesSomething);
  if (reportsChanges === changing) return undefined;
  const nextAction = `Check the factory's Terraform state with \`fffactory plan\`, then rerun ${TEARDOWN}.`;
  return reportsChanges
    ? refusal(
        "Terraform's destroy plan reports changes, but its JSON plan changes no resource",
        nextAction,
      )
    : refusal(
        "Terraform's destroy plan reports no change, but its JSON plan changes resources",
        nextAction,
      );
}

/**
 * The factory's tailnet devices as teardown sees them (D9). The tag is shared between
 * factories, so the hostname tells whose a device is.
 */
export interface FactoryDevices {
  /**
   * Deleted: carrying the factory's tag, and named `<id>-<key>` for a key factory.json declares,
   * the state records or EC2 tags, or, for a generated ID, any other `<id>-*`.
   */
  readonly deleted: readonly TailnetDevice[];
  /**
   * Tagged and named `<id>-*` for no known key, under a hand-chosen ID: possibly this
   * factory's, or another's whose ID extends it (`acme-lab`'s for `acme`). Listed, never deleted.
   */
  readonly possible: readonly TailnetDevice[];
  /** Named like this factory's, without its tag: any tailnet member can take a name. Listed, never deleted. */
  readonly untagged: readonly TailnetDevice[];
}

/**
 * The devices teardown deletes and lists (D9): for each well-formed key of `keys`, the devices
 * `selectWorkerDevices` finds for its hostname (reported hostname, ignoring case, never the
 * MagicDNS label); then every other device whose hostname is in the factory's namespace,
 * deleted when tagged under a generated ID (`isGeneratedFactoryId`), only listed otherwise.
 * Once the review was shown, `shown` holds the IDs of the devices it showed deleted: another
 * namespace device not among them appeared since, and is only listed (`possible`), so no
 * device is deleted unseen beyond the known keys' exact names.
 */
export function selectFactoryDevices(
  devices: readonly TailnetDevice[],
  factoryId: FactoryId,
  keys: readonly string[],
  tag: string,
  shown?: readonly string[],
): FactoryDevices {
  const deleted: TailnetDevice[] = [];
  const untagged: TailnetDevice[] = [];
  for (const key of new Set(keys)) {
    const parsed = parseHostKey(key);
    if (!parsed.ok) continue;
    const named = selectWorkerDevices(devices, hostName(factoryId, parsed.value), tag);
    deleted.push(...named.tagged);
    untagged.push(...named.untagged);
  }
  const known = new Set([...deleted, ...untagged].map(({ id }) => id));
  const others = devices.filter(
    (device) => !known.has(device.id) && carriesFactoryId(device.hostName.toLowerCase(), factoryId),
  );
  const tagged = others.filter((device) => device.tags.includes(tag));
  const generated = isGeneratedFactoryId(factoryId);
  const seen = (device: TailnetDevice) => shown === undefined || shown.includes(device.id);
  const deletable = generated ? tagged.filter(seen) : [];
  return {
    deleted: [...deleted, ...deletable],
    possible: tagged.filter((device) => !deletable.includes(device)),
    untagged: [...untagged, ...others.filter((device) => !device.tags.includes(tag))],
  };
}

/**
 * A tailnet device as teardown shows and reports it: its ID, and the hostname it derived,
 * `<id>-<key>` in lowercase, when its reported hostname is that for a well-formed key. Never its
 * tags, nor a reported hostname it did not derive: either could hold a pasted secret.
 */
export interface ShownDevice {
  readonly id: string;
  readonly hostname: string | undefined;
}

/** `FactoryDevices` as teardown shows and reports them. */
export interface ShownDevices {
  readonly deleted: readonly ShownDevice[];
  readonly possible: readonly ShownDevice[];
  readonly untagged: readonly ShownDevice[];
}

/**
 * The devices teardown listed but kept (D9), the operator's to check: possibly this factory's,
 * or named like it without its tag. Once the admin client is deleted, no rerun lists them again.
 */
export type ListedDevices = Pick<ShownDevices, "possible" | "untagged">;

/** No device listed but kept: none listed yet. */
export const NO_LISTED_DEVICES: ListedDevices = { possible: [], untagged: [] };

/** `ID (HOSTNAME)`, the hostname only when teardown derived it. */
function deviceLine({ id, hostname }: ShownDevice): string {
  return hostname === undefined ? id : `${id} (${hostname})`;
}

/** The devices listed but kept, then the advice to check them; nothing when there are none. */
function listedDeviceLines({ possible, untagged }: ListedDevices): string[] {
  const listed = [...possible, ...untagged];
  if (listed.length === 0) return [];
  return [
    `Listed, not deleted: tailnet devices ${listed.map(deviceLine).join(", ")}`,
    CHECK_LISTED_DEVICES,
  ];
}

function shownDevice(factoryId: FactoryId, device: TailnetDevice): ShownDevice {
  const prefix = `${factoryId}-`;
  const name = device.hostName.toLowerCase();
  const key = name.startsWith(prefix) ? parseHostKey(name.slice(prefix.length)) : undefined;
  return { id: device.id, hostname: key?.ok ? hostName(factoryId, key.value) : undefined };
}

/** The devices of a selection as teardown shows and reports them (`ShownDevice`). */
export function shownDevices(factoryId: FactoryId, devices: FactoryDevices): ShownDevices {
  const shown = (list: readonly TailnetDevice[]) => list.map((d) => shownDevice(factoryId, d));
  return {
    deleted: shown(devices.deleted),
    possible: shown(devices.possible),
    untagged: shown(devices.untagged),
  };
}

/**
 * An EC2 instance as teardown shows and reports it: its host key tag only when it is a
 * well-formed key; one that is not is only marked (`malformedHostKey`), never carried.
 */
export interface ShownMachine {
  readonly instanceId: string;
  readonly state: MachineState;
  readonly hostKey: HostKey | undefined;
  readonly malformedHostKey: boolean;
}

export function shownMachines(machines: readonly Machine[]): ShownMachine[] {
  return machines.map(({ instanceId, state, hostKey }) => {
    const key = hostKey === undefined ? undefined : parseHostKey(hostKey);
    return {
      instanceId,
      state,
      hostKey: key?.ok ? key.value : undefined,
      malformedHostKey: key !== undefined && !key.ok,
    };
  });
}

/** A secret as teardown shows and reports it: by name and ARN, never its tags. */
export type ShownSecret = Pick<ListedSecret, "name" | "arn">;

function shownSecret({ name, arn }: ListedSecret): ShownSecret {
  return { name, arn };
}

/** The secret name an ARN, full or partial, names. */
function secretNameOf(reference: SecretReference): string {
  return reference.split(":secret:")[1] ?? "";
}

/**
 * Whether a reference names a secret under the factory's names (`<id>/`), the only ones
 * teardown may delete: one outside them was never deleted by teardown.
 */
export function underFactoryNames(factoryId: FactoryId, reference: SecretReference): boolean {
  return secretNameOf(reference).startsWith(`${factoryId}/`);
}

/** The secrets teardown leaves, in three groups the report lists apart. */
export interface KeptSecrets {
  /** Tagged with the factory ID, but not owned (D7): kept. */
  readonly tagged: readonly ShownSecret[];
  /** factory.json references outside the factory's names, such as a `fffv/*` source: kept. */
  readonly referenced: readonly SecretReference[];
  /**
   * factory.json references under `<id>/` that the listing did not find: not deleted, and never
   * reported kept, since they may be gone already (a rerun) or were never tagged.
   */
  readonly unlisted: readonly SecretReference[];
}

/**
 * What `classifySecrets` keeps, grouped for the report: a reference to a tagged secret is
 * listed once, with it; one under the factory's names that nothing listed is `unlisted`.
 */
export function keptSecrets(factoryId: FactoryId, inventory: SecretInventory): KeptSecrets {
  const others = inventory.referencedNotOwned.filter(
    (reference) => !inventory.taggedNotOwned.some((secret) => refersTo(reference, secret.arn)),
  );
  const ours = (reference: SecretReference) => underFactoryNames(factoryId, reference);
  return {
    tagged: inventory.taggedNotOwned.map(shownSecret),
    referenced: others.filter((reference) => !ours(reference)),
    unlisted: others.filter(ours),
  };
}

/**
 * Confirmed in advance by `--confirm` naming the factory ID exactly, refused when it names
 * anything else (`mismatch`), asked at a terminal, or impossible to confirm.
 */
export type TeardownConfirmation = "confirmed" | "ask" | "unavailable" | "mismatch";

export function teardownConfirmation(
  confirm: string | undefined,
  interactive: boolean,
  factoryId: FactoryId,
): TeardownConfirmation {
  if (confirm !== undefined) return confirm === factoryId ? "confirmed" : "mismatch";
  return interactive ? "ask" : "unavailable";
}

/** Only the factory ID itself, exactly, around blank space, confirms; anything else declines. */
export function typedIdConfirms(answer: string | undefined, factoryId: FactoryId): boolean {
  return answer?.trim() === factoryId;
}

/** Why teardown refuses without a terminal or `--confirm`. */
export const TEARDOWN_UNCONFIRMABLE =
  "Removing a factory needs your confirmation: rerun at a terminal, or pass --confirm FACTORY_ID.";

/** `--confirm` named something other than the factory ID: refused, the value never echoed. */
export function teardownConfirmMismatch(factoryId: FactoryId): Refusal {
  return refusal(
    `--confirm does not name the factory ${factoryId}`,
    `Pass --confirm ${factoryId} to remove it, or type the factory ID when asked at a terminal.`,
  );
}

/**
 * The question asked once what will be removed and kept has been shown; `withoutBucket`, when
 * only the tailnet devices and owned secrets are left (§No state bucket).
 */
export function teardownQuestion(factoryId: FactoryId, withoutBucket = false): string {
  if (withoutBucket)
    return (
      `Remove what is left of factory ${factoryId}? Its tailnet devices and owned secrets are ` +
      "deleted, and none can be recovered. Type the factory ID to confirm: "
    );
  return (
    `Remove factory ${factoryId} and everything it owns? Its workers, network, IAM, ` +
    "Terraform state, tailnet devices, owned secrets and state bucket are deleted, and none " +
    "can be recovered. Type the factory ID to confirm: "
  );
}

const CHECK_STATUS = "Check the worker with `fffactory status`";

/**
 * The next actions of a gate that refuses teardown for `worker` (`removalGate`): rerun teardown,
 * or remove the worker first, uninspected. A worker factory.json declares is removed with
 * `fffactory worker terminate KEY --force`; one it does not, `undeclared`, the EC2 instance
 * carrying its key, only in the EC2 console. Teardown itself has no `--force` (D4).
 */
export function teardownGateActions(
  worker: WorkerIdentity,
  undeclared?: string,
): RemovalGateActions {
  const terminate = `\`fffactory worker terminate ${worker.key} --force\``;
  const remove =
    undeclared === undefined
      ? `run ${terminate}`
      : `terminate EC2 instance ${undeclared} in the EC2 console`;
  return {
    orForce: (step, how) =>
      `${thenRerunTeardown(step)} To remove the worker ${how}, ${remove} first.`,
    unlocated: `${thenRerunTeardown(CHECK_STATUS)} If it cannot be inspected, remove it uninspected: ${thenRerunTeardown(remove)}`,
    forced:
      undeclared === undefined
        ? `terminate it with --force: ${terminate}, and rerun ${TEARDOWN}.`
        : `terminate EC2 instance ${undeclared} in the EC2 console, and rerun ${TEARDOWN}.`,
  };
}

/** Dispatch could not be stopped on a running worker: refused, as a gate would. */
export function dispatchNotStopped(
  worker: WorkerIdentity,
  reason: string,
  actions: RemovalGateActions,
): Refusal {
  return refusal(
    `Dispatch could not be stopped on ${worker.hostname}: ${reason}`,
    actions.orForce(CHECK_STATUS, "uninspected"),
  );
}

/** Where dispatch was left stopped when teardown was refused after stopping it (D3). */
export function dispatchLeftStopped(hostnames: readonly string[]): string {
  return `Dispatch is stopped on ${hostnames.join(", ")}: \`fffactory apply\` restarts it.`;
}

/** A worker's machine on its way to running or stopped cannot be judged: refused until it is. */
export function machineInPassing(worker: WorkerIdentity, machine: Machine): Refusal {
  return refusal(
    `EC2 instance ${machine.instanceId} of ${worker.hostname} is ${machine.state}`,
    thenRerunTeardown(
      machine.state === "pending" ? "Wait until it is running" : "Wait until it has stopped",
    ),
  );
}

/** `EC2 instance ID`, and `of HOSTNAME` when its host key tag is a well-formed key. */
function instanceNamed(factoryId: FactoryId, { instanceId, hostKey }: Machine): string {
  const key = parseHostKey(hostKey ?? "");
  return key.ok
    ? `EC2 instance ${instanceId} of ${hostName(factoryId, key.value)}`
    : `EC2 instance ${instanceId}`;
}

/**
 * Changed live state invalidates the review: the factory's EC2 instances, listed again once
 * dispatch is stopped, must be those reviewed, each in the state and with the host key tag it
 * was reviewed in. A worker started, stopped, added or removed while the confirmation waited
 * would otherwise be judged by the gates as it was, and destroyed uninspected. Each change is
 * listed, a host key tag only when well-formed. A machine reviewed `shutting-down` was already
 * being terminated, and neither stopped nor inspected: one no longer listed has finished, which
 * is no change. Undefined when nothing changed.
 */
export function machinesChanged(
  factoryId: FactoryId,
  reviewed: readonly Machine[],
  listed: readonly Machine[],
): Refusal | undefined {
  const changes = [
    ...reviewed.flatMap((before) => {
      const now = listed.find(({ instanceId }) => instanceId === before.instanceId);
      const named = instanceNamed(factoryId, before);
      if (now === undefined)
        return before.state === "shutting-down" ? [] : [`${named}: no longer listed`];
      if (now.hostKey !== before.hostKey) return [`${named}: its host key tag changed`];
      if (now.state !== before.state) return [`${named}: ${now.state}, reviewed ${before.state}`];
      return [];
    }),
    ...listed
      .filter(({ instanceId }) => !reviewed.some((before) => before.instanceId === instanceId))
      .map((now) => `${instanceNamed(factoryId, now)} (${now.state}): not reviewed`),
  ];
  if (changes.length === 0) return undefined;
  return refusal(
    "The factory's EC2 instances changed after they were reviewed",
    `Rerun ${TEARDOWN} to review the factory as it is now.`,
    changes,
  );
}

/** Teardown deletes the factory's tailnet devices with the admin client: refused without one. */
export function teardownAdminClientMissing(): Refusal {
  return refusal(
    "factory.json has no Tailscale admin client (tailscale.admin_client_secret): teardown deletes the factory's tailnet devices with it",
    thenRerunTeardown("Store it with `fffactory secret set tailscale-admin-client`"),
  );
}

/**
 * The admin client's secret could not be read; `reason` names the error, never quoting AWS.
 * `found`: DescribeSecret still finds it, so it may be pending deletion, as teardown leaves it for
 * a while once it deleted it.
 */
export function teardownAdminSecretUnreadable(reason: string, found: boolean): Refusal {
  return refusal(
    reason,
    thenRerunTeardown(
      "Check that the credentials may call secretsmanager:GetSecretValue on the secret " +
        "tailscale.admin_client_secret refers to",
    ),
    found
      ? [
          `Secrets Manager does not read a secret pending deletion either, as the admin client is for a while once teardown deleted it: rerun ${TEARDOWN} once it is gone.`,
        ]
      : [],
  );
}

/**
 * The admin client's secret no longer exists while the factory's resources remain: teardown
 * deletes it only after the destroy and the devices, so it did not go by an earlier teardown's
 * hand, and the devices cannot be deleted without it. Refused, deleting nothing.
 */
export function teardownAdminClientGone(): Refusal {
  return refusal(
    "The Tailscale admin client's secret no longer exists, but the factory's resources remain",
    thenRerunTeardown(
      "Store the admin client again with `fffactory secret set tailscale-admin-client`",
    ),
    [
      "Teardown deletes the admin client only once the factory's resources and tailnet devices are gone: without it, the devices cannot be deleted.",
    ],
  );
}

/**
 * The devices of a rerun whose admin client an earlier teardown already deleted: not listed,
 * since nothing can list them without it, and never reported as remaining.
 */
export const DEVICES_NOT_CHECKED =
  "not checked: teardown deletes the admin client only after the devices";

/**
 * Devices not checked are the operator's to check: those an earlier teardown listed but did not
 * delete, which no rerun lists again, and the factory's own, should the admin client have gone
 * otherwise.
 */
export const CHECK_UNCHECKED_DEVICES = `The admin client's secret no longer exists, so the tailnet's devices were not listed: teardown deletes it only once they are gone. Check the devices at ${ADMIN_CONSOLE} for any an earlier teardown listed but did not delete, and, if the secret was deleted otherwise, for the factory's own.`;

/**
 * S3 answered 403 for the state bucket, to a request requiring the factory's account to own it:
 * these credentials may not reach it, or another account owns the name, as it may once an
 * earlier teardown deleted the bucket. Refused before any lock, never taken for the factory's.
 */
export function bucketUnreachable(bucket: string, accountId: string): Refusal {
  return refusal(
    `The state bucket ${bucket} cannot be reached in account ${accountId} (S3 answered 403)`,
    `${thenRerunTeardown("Check that the credentials may reach the bucket (s3:ListBucket)")} If an earlier teardown reached the state bucket's deletion, it had removed everything else of the factory it could before: the name may since be another account's, and nothing of the factory is left in it.`,
    [
      "S3 answers 403 when these credentials may not reach the bucket, and when its name belongs to another account, as it may once an earlier teardown deleted it: teardown cannot tell which, and never takes it for the factory's bucket.",
    ],
  );
}

/** Tailscale did not grant the admin client a token, or could not be reached. */
export function teardownAdminClientUnusable(reason: string): Refusal {
  return refusal(
    `The Tailscale admin client could not be used: ${reason}`,
    thenRerunTeardown(
      `Check the OAuth client at ${TRUST_CREDENTIALS} (scope devices:core) and store its ` +
        "secret with `fffactory secret set tailscale-admin-client`",
    ),
  );
}

/** What teardown lists before anything is removed, and again after the destroy. */
export type InventoryPart = "instances" | "vpcs" | "secrets" | "devices";

const INVENTORY_CHECKS: Readonly<Record<InventoryPart, string>> = {
  instances:
    "Check your network connection and that the credentials may call ec2:DescribeInstances",
  vpcs: "Check your network connection and that the credentials may call ec2:DescribeVpcs",
  secrets:
    "Check your network connection and that the credentials may call secretsmanager:ListSecrets",
  devices: `Check the OAuth client at ${TRUST_CREDENTIALS} (scope devices:core)`,
};

function listingFailed(part: InventoryPart, reason: string): string {
  return part === "devices" ? `The tailnet's devices could not be listed: ${reason}` : reason;
}

/**
 * A listing failed before anything was removed: refused, never taken for one that found
 * nothing, which would read as nothing to remove, or, for EC2, as no instance the destroy plan
 * may delete. `reason` names the error, never quoting AWS or Tailscale.
 */
export function inventoryUnavailable(part: InventoryPart, reason: string): Refusal {
  return refusal(listingFailed(part, reason), thenRerunTeardown(INVENTORY_CHECKS[part]), [
    "Nothing was removed: a listing that failed is never taken for one that found nothing.",
  ]);
}

/**
 * Listing the factory's tagged instances or VPCs failed after the destroy: nothing proves the
 * factory's resources gone, so devices, secrets and the state bucket are kept.
 */
export function leftoversUnverified(part: "instances" | "vpcs", reason: string): Refusal {
  return refusal(reason, thenRerunTeardown(INVENTORY_CHECKS[part]), [
    "Terraform destroyed the factory's resources, but nothing proves that none tagged with its ID remains.",
  ]);
}

/** Removing tagged resources outside Terraform state is the operator's, by hand. */
const REMOVE_TAGGED = thenRerunTeardown(
  "Check them in the EC2 console and remove those that are this factory's yourself",
);

/** Each tagged resource by its ID: `EC2 instance ID (STATE)`, `VPC ID`. */
function taggedLines(machines: readonly Machine[], vpcIds: readonly string[]): string[] {
  return [
    ...machines.map(({ instanceId, state }) => `EC2 instance ${instanceId} (${state})`),
    ...vpcIds.map((id) => `VPC ${id}`),
  ];
}

/**
 * Resources tagged with the factory ID remain after the destroy, outside its Terraform state
 * (D12): the run stops before devices, secrets and the state bucket, each listed by its ID.
 */
export function leftoversRemain(machines: readonly Machine[], vpcIds: readonly string[]): Refusal {
  return refusal(
    "Resources tagged with the factory's ID remain after the destroy, outside its Terraform state",
    REMOVE_TAGGED,
    taggedLines(machines, vpcIds),
  );
}

/**
 * Without a state bucket (D10), why teardown runs without the factory lock: S3 does not find
 * the bucket that would hold one, and EC2 lists nothing tagged that a lock would guard, as
 * `secret set` runs before a bucket exists. It claims only what was looked at: nothing outside
 * EC2 (`checkOutsideEc2`). Shown with the review and the report.
 */
export function ranWithoutLock(bucket: string): string {
  return (
    `No factory lock: S3 does not find the state bucket ${bucket}, which would hold it, and ` +
    "EC2 lists no instance or VPC tagged with the factory ID; nothing outside EC2, such as " +
    "IAM, was looked for. Without a lock, teardown deletes only the factory's tailnet " +
    "devices, owned secrets and local saved plans, as `fffactory secret set` stores " +
    "secrets before a bucket exists."
  );
}

/**
 * Without a state bucket, what teardown did not look for is the operator's to check: the
 * factory's IAM role and instance profile (`<id>-host`), outside EC2 and its VPC, which a first
 * apply that failed after creating them leaves behind (§No state bucket).
 */
export function checkOutsideEc2(factoryId: FactoryId): string {
  return (
    "Without the state bucket, teardown looked for nothing outside EC2: check IAM for the " +
    `role and instance profile ${factoryId}-host, which a failed first apply may have left, and ` +
    "delete them yourself if they are this factory's."
  );
}

/**
 * The state bucket does not exist, but EC2 lists instances (in any state but `terminated`) or
 * VPCs tagged with the factory ID (D10): their Terraform state is lost with the bucket, so
 * teardown cannot destroy them. Refused, each named, nothing removed: a step by hand first.
 */
export function taggedWithoutBucket(
  bucket: string,
  machines: readonly Machine[],
  vpcIds: readonly string[],
): Refusal {
  return refusal(
    `The state bucket ${bucket} does not exist, but resources tagged with the factory's ID do`,
    REMOVE_TAGGED,
    [
      "Their Terraform state was kept in the state bucket: without it, teardown cannot destroy them, and nothing was removed.",
      ...taggedLines(machines, vpcIds),
    ],
  );
}

/**
 * The state bucket, missing when the factory was reviewed, exists by the confirmation: changed
 * live state invalidates the review, and the factory is no longer left without a lock.
 */
export function bucketAppeared(bucket: string): Refusal {
  return refusal(
    `The state bucket ${bucket} exists now, but did not when the factory was reviewed`,
    `Rerun ${TEARDOWN} to review the factory as it is now.`,
    ["Nothing was removed."],
  );
}

/** The host keys the factory's state records could not be read: the destroy is not planned. */
export function destroyKeysUnreadable(): Refusal {
  return refusal(
    "The host keys the factory's Terraform state records could not be read",
    `Check the factory's Terraform state with \`fffactory plan\`, then rerun ${TEARDOWN}.`,
  );
}

/** factory.json, which Terraform still evaluates in destroy mode, cannot be projected. */
export function destroyProjectionRefusal(issues: readonly Issue[]): Refusal {
  return refusal(
    "factory.json cannot be projected into the destroy plan's Terraform inputs",
    thenRerunTeardown("Fix factory.json"),
    issues.map(({ path, message }) => `${path}: ${message}`),
  );
}

/** Terraform failed to plan the destroy; `reason` is fffactory's words, never Terraform's output. */
export function destroyPlanningFailed(reason: string): Refusal {
  return refusal(`Planning the factory's destruction failed: ${reason}`, `Rerun ${TEARDOWN}.`, [
    "Nothing was removed.",
  ]);
}

/**
 * Terraform's apply of the destroy plan failed: it may have destroyed some of the factory's
 * resources, and nothing after it ran.
 */
export function destroyApplyFailed(reason: string): Refusal {
  return refusal(
    `Destroying the factory's resources failed: ${reason}`,
    `Rerun ${TEARDOWN}: it plans the destroy again from what exists now.`,
    ["Terraform may have destroyed some of the factory's resources before it stopped."],
  );
}

/**
 * What the shown teardown removes and keeps, before it is confirmed. Every field is one teardown
 * may print (§What it never prints): no device tag, no host key tag that is not a key.
 */
export interface TeardownReview {
  readonly target: PlanTarget;
  /** The destroy plan's changes, each a delete; none when the factory's root is already gone. */
  readonly changes: readonly ResourceChange[];
  /** The factory's tagged instances, as EC2 lists them. */
  readonly machines: readonly ShownMachine[];
  readonly vpcIds: readonly string[];
  readonly devices: ShownDevices;
  /** `DEVICES_NOT_CHECKED` when the admin client is already gone, as on a rerun; `devices` then lists none. */
  readonly devicesUnchecked: string | undefined;
  readonly secrets: {
    readonly owned: readonly ShownSecret[];
    /** factory.json references under `<id>/` that DescribeSecret no longer finds: already absent. */
    readonly absent: readonly SecretReference[];
    readonly kept: KeptSecrets;
  };
  /** The state bucket: deleted last, or not found, so not deleted (`withoutLock`). */
  readonly bucket: TeardownBucket;
  /** Why teardown runs without the lock, the bucket missing (`ranWithoutLock`); undefined under it. */
  readonly withoutLock: string | undefined;
}

/**
 * The state bucket, by name, and what becomes of it: `deleted`, last of all (in the review, to
 * be); `not_found` when S3 did not find it as this run looked (§No state bucket), so this run
 * does not delete it.
 */
export interface TeardownBucket {
  readonly name: string;
  readonly outcome: "deleted" | "not_found";
}

/**
 * What teardown removed (D6), and what it kept and listed (D7, D9). `infrastructure` is
 * `absent` when the destroy plan found nothing to destroy, as when the root was already gone;
 * `not_found_by_ec2` without a state bucket, when no destroy plan was made: EC2 listed no
 * instance or VPC tagged with the factory ID, and nothing outside EC2 was looked for
 * (`checkOutsideEc2`).
 */
export interface TeardownReport {
  readonly infrastructure: "destroyed" | "absent" | "not_found_by_ec2";
  /** The resources Terraform destroyed. */
  readonly changes: readonly ResourceChange[];
  /** Instances EC2 listed before the destroy, now gone with it. */
  readonly machines: readonly ShownMachine[];
  readonly devices: {
    /** Deleted, or already gone, by ID. */
    readonly removed: readonly string[];
    readonly possible: readonly ShownDevice[];
    readonly untagged: readonly ShownDevice[];
  };
  /** `DEVICES_NOT_CHECKED` when the admin client was already gone: no device was listed. */
  readonly devicesUnchecked: string | undefined;
  readonly secrets: {
    readonly removed: readonly string[];
    /** factory.json references under `<id>/` already absent, as an earlier teardown leaves them. */
    readonly absent: readonly SecretReference[];
    readonly kept: KeptSecrets;
  };
  /** The state bucket: deleted, or not found by this run, so not deleted by it (`withoutLock`). */
  readonly bucket: TeardownBucket;
  /** Why teardown ran without the lock, the bucket missing (`ranWithoutLock`); undefined under it. */
  readonly withoutLock: string | undefined;
}

/** factory.json is left as it was (D11), and the report says so. */
export const FACTORY_JSON_KEPT =
  "factory.json is left as it is: teardown never changes it. Remove it yourself once you no longer need it.";

/** The persistent sources a factory only refers to are the operator's to revoke. */
export const REVOKE_SOURCES =
  "Teardown revokes nothing it only refers to: revoke the Tailscale auth key and admin OAuth " +
  `client (${TRUST_CREDENTIALS}) and the API credentials kept above at their providers, once ` +
  "nothing else uses them.";

/** Devices listed but not deleted are the operator's to check. */
export const CHECK_LISTED_DEVICES = `Check the devices listed but not deleted at ${ADMIN_CONSOLE}, and remove those that were this factory's yourself.`;

/**
 * Teardown stopped once its tailnet devices were not all deleted: its secrets and state bucket
 * were kept, the admin client among them, so a rerun can delete the devices still left.
 */
export function devicesRemain(
  failed: readonly { readonly id: string; readonly reason: string }[],
  unlisted: string | undefined,
): Refusal {
  const kept = "The admin client was kept, so a rerun can delete them.";
  return unlisted === undefined
    ? refusal(
        "Not every Tailscale device of the factory was deleted",
        thenRerunTeardown(`Check the devices at ${ADMIN_CONSOLE}`),
        [...failed.map(({ id, reason }) => `Deleting device ${id} failed: ${reason}`), kept],
      )
    : refusal(
        `The tailnet's devices could not be listed: ${unlisted}`,
        thenRerunTeardown(INVENTORY_CHECKS.devices),
        [kept],
      );
}

/** Teardown stopped once a secret it owns was not confirmed gone: the state bucket was kept. */
export function secretsRemain(
  remaining: readonly { readonly name: string; readonly reason: string }[],
): Refusal {
  return refusal(
    "Not every secret the factory owns is gone",
    thenRerunTeardown("Check the credentials may delete and describe them"),
    remaining.map(({ name, reason }) => `${name}: ${reason}`),
  );
}

/**
 * What became of the factory lock when the state bucket remains. Only a teardown that returned
 * reports it, and that one released whatever was left of the lock by its version: an
 * interrupted one keeps it, and says so instead (`interruptedTeardown`).
 */
const LOCK_LEFT: Readonly<Record<LockAfterDeletion, string>> = {
  held: "The factory lock was not deleted: teardown released it.",
  unknown:
    "Deleting the factory lock's versions stopped part way: teardown released it by its version.",
  deleted: "The factory lock was deleted with the bucket's versions: the factory is unlocked.",
};

/**
 * The state bucket remains (`LockStore.deleteBucket`): what failed, what is left of it, and
 * what became of the lock.
 */
export function bucketRemains(
  bucket: string,
  deletion: Extract<BucketDeletion, { readonly kind: "remains" }>,
): Refusal {
  const left =
    deletion.versions === undefined
      ? "An unknown number of object versions and delete markers remain in it."
      : `${deletion.versions} object versions and delete markers remain in it.`;
  return refusal(
    `The state bucket ${bucket} remains`,
    thenRerunTeardown(
      "Check that the credentials may list and delete the bucket's object versions, and delete the bucket",
    ),
    [
      ...(deletion.failure === undefined ? [] : [deletion.failure]),
      ...deletion.codes.map((code) => `S3 did not delete some versions: ${code}`),
      left,
      LOCK_LEFT[deletion.lock],
    ],
  );
}

/** A step under the lock failed unexpectedly; `reason` is fffactory's words. */
export function teardownFailed(reason: string): Refusal {
  return refusal(reason, thenRerunTeardown("Check the factory with `fffactory status`"));
}

/**
 * The factory's Terraform state still records host keys once its destroy was applied: the
 * destroy did not remove all it should have (D12). Each key is named only when well-formed.
 */
export function stateStillRecords(keys: readonly string[]): Refusal {
  return refusal(
    "The factory's Terraform state still records hosts after the destroy",
    `Rerun ${TEARDOWN}: it plans the destroy again from what the state records.`,
    keys.map((key) => {
      const parsed = parseHostKey(key);
      return parsed.ok ? `Host ${parsed.value}` : "A host key that is not well-formed";
    }),
  );
}

/** The steps teardown's record goes through, in order (§Operation record). */
export type TeardownStep = Extract<
  StageStatus,
  | "authorizing"
  | "inventorying"
  | "planning"
  | "awaiting_approval"
  | "stopping_dispatch"
  | "inspecting"
  | "applying"
  | "verifying"
  | "removing_devices"
  | "removing_secrets"
  | "removing_plans"
  | "deleting_bucket"
>;

/**
 * Where a teardown that had begun removing the factory stopped, in D6's order: the destroy, the
 * proof that nothing tagged remains (`leftovers`, D12), the devices, the secrets, the local
 * saved plans, the state bucket.
 */
export type TeardownStop = "destroy" | "leftovers" | "devices" | "secrets" | "plans" | "bucket";

const STOPS: readonly TeardownStop[] = [
  "destroy",
  "leftovers",
  "devices",
  "secrets",
  "plans",
  "bucket",
];

/**
 * What a teardown stopped part way left of the factory, by kind, in D6's order: every kind
 * before where it stopped is gone, since each step starts only once the one before finished.
 */
export interface TeardownRemaining {
  /** Whether the factory's Terraform state may still hold resources: its destroy failed. */
  readonly state: boolean;
  /**
   * The tailnet devices left, by ID: those the review showed deleted until the devices' step
   * ran, then those it could not delete. `unchecked` when the admin client was already gone,
   * wherever the run stopped.
   */
  readonly devices: readonly string[] | "unchecked";
  /** The devices the devices step listed but kept (`ListedDevices`); none before it listed. */
  readonly listedDevices: ListedDevices;
  /** The owned secrets left, by name: all of them until their step ran, then those not gone. */
  readonly secrets: readonly string[];
  /** Whether the factory's local saved plans remain. */
  readonly plans: boolean;
  /**
   * The state bucket, which always remains when teardown stops part way under the lock;
   * undefined without one, when S3 found no bucket (§No state bucket).
   */
  readonly bucket: string | undefined;
}

/** What is known to be left of each kind when teardown stops at `stop` (`TeardownRemaining`). */
export function remainingAt(
  stop: TeardownStop,
  left: Pick<TeardownRemaining, "devices" | "listedDevices" | "secrets" | "bucket">,
): TeardownRemaining {
  const before = (step: TeardownStop) => STOPS.indexOf(stop) <= STOPS.indexOf(step);
  return {
    state: stop === "destroy",
    devices: left.devices === "unchecked" || before("devices") ? left.devices : [],
    listedDevices: left.listedDevices,
    secrets: before("secrets") ? left.secrets : [],
    plans: before("plans"),
    bucket: left.bucket,
  };
}

function remainingLines(remaining: TeardownRemaining): string[] {
  const { devices, secrets } = remaining;
  return [
    ...(remaining.state ? ["Remains: whatever the factory's Terraform state still holds"] : []),
    ...(devices === "unchecked"
      ? [`Tailnet devices: ${DEVICES_NOT_CHECKED}`, CHECK_UNCHECKED_DEVICES]
      : devices.length > 0
        ? [`Remains: tailnet devices ${devices.join(", ")}`]
        : []),
    ...listedDeviceLines(remaining.listedDevices),
    ...(secrets.length > 0 ? [`Remains: owned secrets ${secrets.join(", ")}`] : []),
    ...(remaining.plans ? ["Remains: the local saved plans"] : []),
    ...(remaining.bucket === undefined ? [] : [`Remains: the state bucket ${remaining.bucket}`]),
  ];
}

/**
 * Why teardown stopped part way (`refusal`: what failed, and the next action, rerunning
 * teardown or a step by hand first), with what remains of each kind listed after its details.
 */
export function stoppedPartWay(refusal: Refusal, remaining: TeardownRemaining): Refusal {
  return { ...refusal, details: [...refusal.details, ...remainingLines(remaining)] };
}

/** How far an interrupted teardown got, and what it left of the lock and its record. */
export interface TeardownInterruption {
  /** The last step it started. */
  readonly reached: TeardownStep;
  /**
   * Whether it had begun removing: reached the destroy step, or without a state bucket the
   * devices step. From there on the factory may be partly removed.
   */
  readonly removing: boolean;
  /** Whether its operation record was written, and is not being deleted with the bucket. */
  readonly record: boolean;
  /** The workers dispatch was stopped on, which `fffactory apply` restarts. */
  readonly dispatchStopped: readonly string[];
  /** The devices the devices step listed but kept; none before it listed. */
  readonly listedDevices: ListedDevices;
  /**
   * `held` until the state bucket's deletion reached the lock (`LockAfterDeletion`); `none` when
   * there was no bucket to hold one (§No state bucket).
   */
  readonly lock: LockAfterDeletion | "none";
}

/** What teardown was doing at each step, as an interruption reports it. */
const DOING: Readonly<Record<TeardownStep, string>> = {
  authorizing: "opening the Tailscale admin session",
  inventorying: "listing what the factory has",
  planning: "planning the factory's destruction",
  awaiting_approval: "waiting for the confirmation",
  stopping_dispatch: "stopping dispatch",
  inspecting: "inspecting the workers",
  applying: "destroying the factory's resources",
  verifying: "checking that nothing tagged with the factory ID remains",
  removing_devices: "deleting the tailnet devices",
  removing_secrets: "deleting the owned secrets",
  removing_plans: "removing the local saved plans",
  deleting_bucket: "deleting the state bucket",
};

const INTERRUPTED_LOCK: Readonly<Record<TeardownInterruption["lock"], string>> = {
  none: "Interrupted: the factory is not locked, since it has no state bucket to hold a lock",
  held: "Interrupted: the factory stays locked",
  unknown:
    "Interrupted while the state bucket was being deleted: the factory lock may already be gone with it",
  deleted:
    "Interrupted while the state bucket was being deleted: the factory lock is already gone with it",
};

const EXITED = "Once fffactory has exited";

/**
 * What an interrupted teardown tells the operator: whether the lock stays, how far it got, and
 * the next action. `fffactory lock break` is named only for this teardown once fffactory has
 * exited, the operation then confirmed dead; once the bucket's deletion reached the lock, only
 * for the lock a rerun finds still held by it; never without a lock (`none`).
 */
export function interruptedTeardown(at: TeardownInterruption): Refusal {
  const summary =
    at.lock !== "held"
      ? INTERRUPTED_LOCK[at.lock]
      : at.record
        ? `${INTERRUPTED_LOCK.held}, with a record of this teardown`
        : `${INTERRUPTED_LOCK.held} by this teardown, which may have no operation record`;
  const details = at.removing
    ? [
        `Teardown had begun removing the factory, and was ${DOING[at.reached]}: a rerun inventories again and finishes from what remains.`,
        ...listedDeviceLines(at.listedDevices),
      ]
    : [
        "Nothing was removed.",
        ...(at.dispatchStopped.length > 0 ? [dispatchLeftStopped(at.dispatchStopped)] : []),
      ];
  const nextAction = {
    none: `${EXITED}, rerun ${TEARDOWN}.`,
    held: `${EXITED}, break the lock with \`fffactory lock break\`, then rerun ${TEARDOWN}.`,
    unknown: `${EXITED}, rerun ${TEARDOWN}. If it finds the factory locked by this teardown, break that lock with \`fffactory lock break\`, then rerun it.`,
    deleted: `${EXITED}, rerun ${TEARDOWN}.`,
  }[at.lock];
  return refusal(summary, nextAction, details);
}
