import { join } from "node:path";
import type { FactoryId } from "../domain/instance";
import type { SavedPlan } from "../domain/plan";

/** Absolute paths of one plan's Terraform plan files, in its own private directory. */
export interface PlanFiles {
  /** The factory root module's saved plan. */
  readonly factory: string;
  /** Backend bootstrap's saved plan, on a factory's first apply. */
  readonly backend: string;
}

export type StoredPlan =
  | {
      readonly kind: "found";
      readonly plan: SavedPlan;
      readonly files: PlanFiles;
      /** The SHA-256 its factory Terraform plan file was saved with, and has now. */
      readonly digest: string;
    }
  | { readonly kind: "missing" }
  /** Its record cannot be read, or its Terraform plan is not the file it was saved with. */
  | { readonly kind: "damaged" };

/**
 * Port: the operator's local, private store of plans, per factory. A plan's directory holds
 * its Terraform plan files and, once saved, its record; a saved plan is bound to its
 * Terraform plan file as it was when saved. Plans are short-lived: `prune` removes expired
 * ones and any never saved.
 */
export interface PlanStore {
  /** Creates plan `planId`'s empty private directory; rejects when it exists. */
  create(factoryId: FactoryId, planId: string): Promise<PlanFiles>;
  /** Saves the plan's record, binding it to its factory plan file as that file is now. */
  save(plan: SavedPlan): Promise<void>;
  /** The saved plan `planId`, only when its record and Terraform plan are as saved. */
  load(factoryId: FactoryId, planId: string): Promise<StoredPlan>;
  /** The SHA-256 of plan `planId`'s factory Terraform plan file now; undefined when absent. */
  digest(factoryId: FactoryId, planId: string): Promise<string | undefined>;
  /** Removes plan `planId`'s directory, saved or not. */
  remove(factoryId: FactoryId, planId: string): Promise<void>;
  /** Removes the factory's plans long expired, and those long made but never saved (`PLAN_KEPT_MS`). */
  prune(factoryId: FactoryId, now: Date): Promise<void>;
}

/** Where the local plan store keeps plans: `<cache directory>/plans`. */
export function planStoreDirectory(cacheDirectory: string): string {
  return join(cacheDirectory, "plans");
}
