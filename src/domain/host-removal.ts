/**
 * `fffactory worker terminate KEY`'s removal of a host (`docs/specs/worker-lifecycle.md`
 * §Terminate (remove)): factory.json without the host, the scoped removal plan's rule, and the
 * words of the removal's refusals and failures. The plan shown for approval is laid out by the
 * CLI (`cli/presentation/plan.ts`). The removal plan is the only plan allowed to destroy a host
 * machine; every other plan keeps the D11 refusals (`plan.ts`). Pure:
 * `application/worker-lifecycle.ts` plans, applies and writes.
 */
import type { FactoryInstance, HostKey, Issue, SecretReference } from "./instance";
import {
  changesSomething,
  destroyedInstance,
  hostMachineAddress,
  isHostMachine,
  type ResourceChange,
  resourceChanges,
} from "./plan";
import type { WorkerIdentity } from "./rollout";
import { ADMIN_CONSOLE } from "./status";
import { isRecord } from "./validation";
import {
  type Refusal,
  remainingDevicesAction,
  thenRerunWorker,
  workerCommandLine,
} from "./worker-lifecycle";

/** The hosts' policy allowing them to read the secrets factory.json references. */
export const HOST_SECRETS_POLICY = "module.host_identity.aws_iam_role_policy.read_secrets";

function refusal(summary: string, nextAction: string, details: readonly string[] = []): Refusal {
  return { summary, details, nextAction };
}

const rerun = (key: HostKey) => `\`${workerCommandLine("terminate", key)}\``;

/**
 * The instance without host `key`, by own entries; every other field and host as it was. The
 * host's repository placements and dispatch settings are its own entry's, so they go with it;
 * removing the last host leaves `hosts` an empty list, a complete factory with no worker.
 */
export function withoutHost(instance: FactoryInstance, key: HostKey): FactoryInstance {
  return Object.fromEntries(
    Object.entries(instance).map(([field, value]) =>
      field === "hosts" && Array.isArray(value)
        ? [field, value.filter((host: { readonly key: string }) => host.key !== key)]
        : [field, value],
    ),
  ) as unknown as FactoryInstance;
}

/**
 * What a removal plan may do: destroy host `key`'s machine when EC2 lists one, that instance
 * (`instanceId`) and no other, and drop the removed host's Paseo password (`secret`) from the
 * hosts' secret-reading policy.
 */
export interface HostRemoval {
  readonly key: HostKey;
  /**
   * The instance EC2 lists for the host, which the gates inspected and the question names: the
   * plan must destroy it, and only it. Undefined when EC2 lists none: the plan must destroy none.
   */
  readonly instanceId?: string | undefined;
  /** The removed host's `paseo_password_secret`, which the policy may stop allowing. */
  readonly secret?: SecretReference | undefined;
}

function fate(actions: readonly string[]): string {
  switch (actions.join()) {
    case "create":
      return "created";
    case "update":
      return "updated in place";
    case "delete":
      return "destroyed";
    case "delete,create":
    case "create,delete":
      return "replaced";
    case "forget":
      return "forgotten by Terraform";
    default:
      return `changed by an action fffactory does not know (${actions.join(", ")})`;
  }
}

/** A policy document's statements, each with its actions and resources as sorted lists. */
function canonicalPolicy(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(document)) return undefined;
  const statements = [document.Statement].flat();
  if (!statements.every(isRecord)) return undefined;
  const list = (value: unknown) => [value].flat().map(String).sort();
  return canonicalJson({
    ...document,
    Statement: statements.map((statement) => ({
      ...statement,
      Action: list(statement.Action),
      Resource: list(statement.Resource),
    })),
  });
}

/** JSON with every object's keys sorted, so equal documents have equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

/** The policy text without `secret` among any statement's resources. */
function withoutResource(text: string, secret: string): string {
  const document = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify({
    ...document,
    Statement: [document.Statement].flat().map((statement) => {
      const resources = [(statement as Record<string, unknown>).Resource].flat();
      return { ...(statement as object), Resource: resources.filter((arn) => arn !== secret) };
    }),
  });
}

function hasUnknown(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(hasUnknown);
  return isRecord(value) && Object.values(value).some(hasUnknown);
}

/**
 * Whether a JSON plan's change of the secret-reading policy only stops allowing `secret`: every
 * other attribute as it was, nothing unknown until apply, and the document as before but for
 * that one resource. Anything it cannot read is no such change, failing closed.
 */
function dropsOnly(raw: unknown, secret: SecretReference | undefined): boolean {
  if (secret === undefined || !isRecord(raw) || !isRecord(raw.change)) return false;
  const { before, after, after_unknown } = raw.change;
  if (!isRecord(before) || !isRecord(after) || hasUnknown(after_unknown)) return false;
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  fields.delete("policy");
  for (const field of fields)
    if (canonicalJson(before[field]) !== canonicalJson(after[field])) return false;
  const was = canonicalPolicy(before.policy);
  const now = canonicalPolicy(after.policy);
  if (was === undefined || now === undefined || was === now) return false;
  return canonicalPolicy(withoutResource(before.policy as string, secret)) === now;
}

/**
 * The plan destroys an instance for the host other than the one EC2 lists, or one it does not
 * name: say its state holds an instance whose tags were stripped by hand, while EC2 lists
 * another. Destroying it would leave the approved instance running.
 */
function anotherInstance(key: HostKey, destroyed: string | undefined, listed: string): Refusal {
  return refusal(
    destroyed === undefined
      ? `Terraform's plan does not identify the instance it destroys for host ${key}: only ${listed}, the instance EC2 lists for it, may be destroyed`
      : `Terraform's plan destroys instance ${destroyed} for host ${key}, not ${listed}, the instance EC2 lists for it`,
    thenRerunWorker(
      "terminate",
      key,
    )(
      destroyed === undefined
        ? `Check the instances carrying the host key ${key} in the EC2 console`
        : `Check instances ${destroyed} and ${listed} in the EC2 console`,
    ),
  );
}

/**
 * Why the plan's change of the host's machine (`machine`) destroys the wrong one: a machine EC2
 * does not list, or an instance other than the one it lists. Undefined when it destroys exactly
 * that instance; a replacement is left to the rule's other changes.
 */
function destroyingRefusal(
  machine: { readonly change: ResourceChange; readonly raw: unknown },
  { key, instanceId: listed }: HostRemoval,
): Refusal | undefined {
  if (listed === undefined)
    return refusal(
      `Terraform's state holds a machine for host ${key} that EC2 does not list with the factory's tags`,
      thenRerunWorker("terminate", key)("Check the factory's instances in the EC2 console"),
    );
  if (machine.change.actions.join() !== "delete") return undefined;
  const destroyed = destroyedInstance(machine.raw);
  return destroyed === listed ? undefined : anotherInstance(key, destroyed, listed);
}

/** Whether `change` is the removal's own: the host's machine destroyed, or its secret dropped. */
function isRemovals(change: ResourceChange, raw: unknown, removal: HostRemoval): boolean {
  if (change.address === hostMachineAddress(removal.key))
    return isHostMachine(change) && change.actions.join() === "delete";
  if (change.address === HOST_SECRETS_POLICY && change.actions.join() === "update")
    return dropsOnly(raw, removal.secret);
  return false;
}

/**
 * The scoped removal plan's rule, over Terraform's JSON plan of factory.json without the host:
 * it may only destroy the host's machine, which it must when EC2 lists one, the very instance
 * EC2 lists, and must not when EC2 lists none, and drop the host's Paseo password from the
 * hosts' policy. Any other change, pending in factory.json or drift, is refused, as is a plan
 * that cannot be read. Undefined when the plan may be applied.
 */
export function removalPlanRefusal(plan: unknown, removal: HostRemoval): Refusal | undefined {
  const { key } = removal;
  const changes = resourceChanges(plan);
  if (changes === undefined)
    return refusal("Terraform's removal plan could not be read", `Rerun ${rerun(key)}.`);
  const raws = isRecord(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const changing = changes.flatMap((change, index) =>
    changesSomething(change) ? [{ change, raw: raws[index] }] : [],
  );
  // Each change of the host's machine, should a plan hold several, destroys the right one.
  const machines = changing.filter(
    ({ change }) => change.address === hostMachineAddress(key) && isHostMachine(change),
  );
  const wrongMachine = machines
    .map((machine) => destroyingRefusal(machine, removal))
    .find((wrong) => wrong !== undefined);
  if (wrongMachine !== undefined) return wrongMachine;
  const others = changing.filter(({ change, raw }) => !isRemovals(change, raw, removal));
  if (others.length > 0)
    return refusal(
      `The removal plan changes more than host ${key}'s machine: apply factory.json's other changes first`,
      "Apply factory.json's other changes first with `fffactory apply`, or undo them, then " +
        `rerun ${rerun(key)}.`,
      others.map(({ change }) => `${change.address} would be ${fate(change.actions)}`),
    );
  if (removal.instanceId !== undefined && machines.length === 0)
    return refusal(
      `Terraform's plan does not destroy host ${key}'s machine: its state does not hold the instance EC2 lists for it`,
      thenRerunWorker(
        "terminate",
        key,
      )(`Check the instance carrying the host key ${key} in the EC2 console`),
    );
  return undefined;
}

/** The host keys the factory's Terraform state records cannot be read: nothing is planned. */
export function recordedKeysUnreadable(key: HostKey): Refusal {
  return refusal(
    "The factory's Terraform state records host keys that cannot be read",
    thenRerunWorker("terminate", key)("Check the factory's Terraform state with `fffactory plan`"),
  );
}

/**
 * factory.json without the host cannot be planned: a hand edit already removed another
 * provisioned host, say. `issues` are the projection's, each by field path.
 */
export function removalProjectionRefusal(key: HostKey, issues: readonly Issue[]): Refusal {
  return refusal(
    `factory.json without host ${key} cannot be planned`,
    thenRerunWorker("terminate", key)("Correct factory.json"),
    issues.map(({ path, message }) => `${path}: ${message}`),
  );
}

/** factory.json is no longer the text the removal was planned from: nothing is applied. */
export function removalConfigurationChanged(key: HostKey, reason: string): Refusal {
  return refusal(`factory.json ${reason}: nothing was applied`, `Rerun ${rerun(key)}.`);
}

/** Terraform could not plan the removal: nothing changed. */
export function removalPlanningFailed(key: HostKey, reason: string): Refusal {
  return refusal(`Planning the removal failed: ${reason}`, `Rerun ${rerun(key)}.`, [
    "Nothing was applied: the machine and factory.json are as they were.",
  ]);
}

/** Terraform's apply of the removal failed: it may have destroyed the machine; factory.json is as it was. */
export function removalApplyFailed(key: HostKey, reason: string): Refusal {
  return refusal(
    `Removing the host failed: ${reason}`,
    `Rerun ${rerun(key)}: it plans the removal again from what exists now, and finishes it.`,
    [
      `Terraform may have destroyed the machine before it stopped. factory.json is unchanged: it still declares host ${key}.`,
    ],
  );
}

/**
 * Terraform applied the removal but its state still records the host key: factory.json is not
 * written, since every later plan would refuse a recorded key it no longer declares (D11).
 */
export function removalStillRecorded(key: HostKey): Refusal {
  return refusal(
    `Terraform still records host ${key} after applying its removal`,
    `Rerun ${rerun(key)}.`,
    [`factory.json is unchanged: it still declares host ${key}.`],
  );
}

/**
 * Terraform removed the host, but factory.json could not be written, or changed meanwhile: it
 * still declares the host, which is exactly what to undo.
 */
export function removalUnwritten(worker: WorkerIdentity, path: string, reason: string): Refusal {
  const { key, hostname } = worker;
  return refusal(
    `Terraform destroyed host ${key}'s machine and no longer records it, but factory.json could not be written (${reason}): it still declares the host`,
    `Remove the host ${key} from hosts in ${path} yourself and delete the Tailscale devices ` +
      `named ${hostname} at ${ADMIN_CONSOLE}, or rerun ${rerun(key)} once factory.json can be ` +
      "written: it finds the machine gone and finishes the removal.",
    ["Until the host is removed from factory.json, `fffactory apply` would create it afresh."],
  );
}

/**
 * An error once factory.json was written without the host, such as the operation record's
 * write before the devices are deleted: there is nothing to rerun, since factory.json no longer
 * declares the host and a rerun is refused, and its tailnet devices may remain.
 */
export function failedAfterRemoval(worker: WorkerIdentity, reason: string): Refusal {
  return refusal(reason, remainingDevicesAction(worker, "terminate"), [
    `Terraform destroyed host ${worker.key}'s machine and factory.json no longer declares it; ` +
      "its Tailscale devices may remain.",
  ]);
}
