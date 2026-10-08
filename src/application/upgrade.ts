/**
 * `fffactory upgrade`, the minimal upgrade until milestone M3: run by a newer fffactory, it
 * moves factory.json's release pin to the running release and applies the factory's complete
 * plan made for it, under one approval and the one factory-wide lock.
 *
 * The plan is made, under the lock, from factory.json as it will be once the pin moves: the
 * instance read, with only its pin changed. The operator approves the pin move and that plan
 * together. Once approved, and only then, the new pin is written, provided factory.json is
 * still the exact text the plan was made from; otherwise nothing is written or applied. The
 * pin is written before anything is applied, so from then on factory.json pins the release
 * being installed: a failed or interrupted apply leaves a factory that `fffactory apply` by
 * this release converges, and a partial rollout leaves the pin moved.
 *
 * Refused before anything reaches AWS: a factory.json of another schema version (schema
 * migration, D11), a release that needs a newer base generation than the pinned release's
 * workers have (base migration, D11), and a pin that is not earlier than the running release.
 */
import { type FactoryInstance, serializeInstance } from "../domain/instance";
import {
  assessUpgrade,
  describePinMove,
  type ReleaseCompatibility,
  schemaVersionChange,
  type UpgradeAssessment,
} from "../domain/release-compatibility";
import {
  applyFactory,
  type FactoryApply,
  type FactoryApplyDependencies,
  type FactoryApplyRequest,
  type PinMove,
} from "./apply-factory";
import type { InstanceStore } from "./instance-store";

export interface UpgradeDependencies extends FactoryApplyDependencies {
  /** Where factory.json is, to write its new pin. */
  readonly store: InstanceStore;
  /** Told once factory.json pins the running release. */
  readonly pinned: () => void;
}

export interface UpgradeRequest
  extends Omit<FactoryApplyRequest, "planId" | "operation" | "pinMove"> {
  /** factory.json's exact text, as `instance` was read from it. */
  readonly text: string;
  /** What the running release declares. */
  readonly compatibility: ReleaseCompatibility;
}

export type Upgrade =
  | Exclude<UpgradeAssessment, { readonly kind: "upgrade" }>
  /** The operation ran: `apply` is how it ended, `pinned` whether the new pin was written. */
  | { readonly kind: "upgrade"; readonly apply: FactoryApply; readonly pinned: boolean };

/**
 * Upgrades the factory after the account check allowed the caller: refuses what the running
 * release may not do, then runs apply with the pin move, the plan made for the running
 * release, and the operation named `upgrade`.
 */
export async function upgradeFactory(
  deps: UpgradeDependencies,
  request: UpgradeRequest,
): Promise<Upgrade> {
  const { text, compatibility, ...applying } = request;
  const schema = schemaVersionChange(text, compatibility);
  if (schema !== undefined) return schema;
  const assessment = assessUpgrade(request.instance.release, request.release, compatibility);
  if (assessment.kind !== "upgrade") return assessment;
  const upgraded: FactoryInstance = { ...request.instance, release: request.release };
  let pinned = false;
  const pinMove: PinMove = {
    preview: describePinMove(assessment.from, request.release),
    write: async () => {
      if ((await deps.store.read(request.instancePath)) !== text) return false;
      await deps.store.write(request.instancePath, serializeInstance(upgraded));
      pinned = true;
      deps.pinned();
      return true;
    },
  };
  const apply = await applyFactory(deps, {
    ...applying,
    instance: upgraded,
    operation: "upgrade",
    pinMove,
  });
  return { kind: "upgrade", apply, pinned };
}
