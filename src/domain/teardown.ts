/**
 * Removing a whole factory (`fffactory teardown`, epic #56): the guarded destroy plan's rule
 * (`docs/specs/provisioning.md` §Destroy plan) and what listing the factory's tagged VPCs showed.
 * The destroy plan is the only plan, beside `worker terminate`'s removal plan
 * (`host-removal.ts`), allowed to destroy a host machine; `plan` and `apply` keep the D11
 * refusals (`plan.ts`). Pure.
 */
import {
  destroyedInstance,
  hostMachineAddress,
  isHostMachine,
  type ResourceChange,
  resourceChanges,
} from "./plan";
import { parseHostKey } from "./instance";
import type { Machine } from "./status";
import { isRecord } from "./validation";
import type { Refusal } from "./worker-lifecycle";

/** The command a destroy plan's refusal reruns. */
const TEARDOWN = "`fffactory teardown`";

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
