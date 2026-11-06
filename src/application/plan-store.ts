import { join } from "node:path";
import type { FactoryId } from "../domain/instance";
import type { SavedPlan } from "../domain/plan";

/** Absolute paths of one plan's Terraform plan files, in its own private directory. */
export interface PlanFiles {
  /** The factory root module's saved plan, which a saved factory plan binds. */
  readonly factory: string;
  /**
   * Backend bootstrap's saved plan, which a saved bootstrap plan binds; also written, never
   * bound, by a factory's interactive first apply.
   */
  readonly backend: string;
  /**
   * The archive root's saved plan, creating the log archive, which a saved factory plan that
   * creates it binds beside `factory`.
   */
  readonly archive: string;
}

export type StoredPlan =
  | {
      readonly kind: "found";
      readonly plan: SavedPlan;
      readonly files: PlanFiles;
      /**
       * The SHA-256 each Terraform plan file it binds was saved with, and has now, as one
       * opaque value (`PlanStore.digest`).
       */
      readonly digest: string;
    }
  | { readonly kind: "missing" }
  /** Its record cannot be read, or its Terraform plan is not the file it was saved with. */
  | { readonly kind: "damaged" };

/**
 * Port: the operator's local, private store of plans, per factory. A plan's directory holds
 * its Terraform plan files and, once saved, its record; a saved plan is bound to the
 * Terraform plan files its kind names, as they were when saved: a factory plan to `factory`,
 * and to `archive` too when it creates the log archive (`creates_archive`), a bootstrap plan
 * to `backend` (`PlanFiles`). Plans are short-lived: `prune`
 * removes expired ones of either kind and any directory without a record, never saved or
 * spent, long unchanged.
 */
export interface PlanStore {
  /** Creates plan `planId`'s empty private directory; rejects when it exists. */
  create(factoryId: FactoryId, planId: string): Promise<PlanFiles>;
  /**
   * Saves the plan's record, binding it to the Terraform plan files it binds as they are now;
   * rejects when one was never written.
   */
  save(plan: SavedPlan): Promise<void>;
  /**
   * The saved plan `planId`, only when its record and the Terraform plan files it binds are as
   * saved.
   */
  load(factoryId: FactoryId, planId: string): Promise<StoredPlan>;
  /**
   * The SHA-256 of each Terraform plan file the saved plan binds, as the files are now, as one
   * opaque value that changes when any of them does; undefined when one is absent.
   */
  digest(plan: SavedPlan): Promise<string | undefined>;
  /**
   * Spends saved plan `planId`: durably removes its record, so `load` finds it missing, and
   * keeps its Terraform plan files for an apply about to read them. True only for the call
   * that removed the record; false when it was already gone, spent or never saved. `remove`,
   * or else `prune`, removes the rest.
   */
  spend(factoryId: FactoryId, planId: string): Promise<boolean>;
  /** Removes plan `planId`'s directory, saved or not. */
  remove(factoryId: FactoryId, planId: string): Promise<void>;
  /**
   * Removes every plan of the factory, saved or not, with the factory's own directory
   * (`<cache>/plans/<factory ID>/`): teardown's, once the factory is gone. None is no failure.
   */
  removeAll(factoryId: FactoryId): Promise<void>;
  /**
   * Removes the factory's plans long expired, and directories without a record (never saved,
   * or spent) long unchanged (`PLAN_KEPT_MS`).
   */
  prune(factoryId: FactoryId, now: Date): Promise<void>;
}

/** Where the local plan store keeps plans: `<cache directory>/plans`. */
export function planStoreDirectory(cacheDirectory: string): string {
  return join(cacheDirectory, "plans");
}
