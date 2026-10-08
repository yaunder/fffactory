import type { PlanFiles, PlanStore, StoredPlan } from "../../src/application/plan-store";
import type { FactoryId } from "../../src/domain/instance";
import { isPrunable, type SavedPlan } from "../../src/domain/plan";

/**
 * In-memory PlanStore, keyed by `<factory ID>/<plan ID>`: plan directories created, the saved
 * plans in them, and any `damage`d (their Terraform plan changed after saving). A plan's
 * Terraform plan file digest is `digest-<key>-<swaps>`, changed by `swap`. Records every
 * call. Plan files are paths under `/plans` that nothing writes.
 */
export class MemoryPlanStore implements PlanStore {
  readonly calls: string[] = [];
  readonly directories = new Set<string>();
  readonly saved = new Map<string, SavedPlan>();
  readonly damaged = new Set<string>();
  /** How often each plan's Terraform plan file was swapped since it was saved. */
  readonly swaps = new Map<string, number>();

  private files(key: string): PlanFiles {
    return { factory: `/plans/${key}/factory.tfplan`, backend: `/plans/${key}/backend.tfplan` };
  }

  /** Marks a saved plan's Terraform plan as changed since it was saved. */
  damage(factoryId: FactoryId, planId: string): void {
    this.damaged.add(`${factoryId}/${planId}`);
  }

  /**
   * Replaces a saved plan's Terraform plan file with another after `load` read it, as a file
   * swapped in the plan directory would be: its digest changes; its record does not.
   */
  swap(factoryId: FactoryId, planId: string): void {
    const key = `${factoryId}/${planId}`;
    this.swaps.set(key, (this.swaps.get(key) ?? 0) + 1);
  }

  private digestOf(key: string): string {
    return `digest-${key}-${this.swaps.get(key) ?? 0}`;
  }

  async create(factoryId: FactoryId, planId: string): Promise<PlanFiles> {
    const key = `${factoryId}/${planId}`;
    this.calls.push(`create ${key}`);
    if (this.directories.has(key)) throw new Error(`${key} exists`);
    this.directories.add(key);
    return this.files(key);
  }

  async save(plan: SavedPlan): Promise<void> {
    const key = `${plan.factory_id}/${plan.plan_id}`;
    this.calls.push(`save ${key}`);
    if (!this.directories.has(key)) throw new Error(`${key} was never created`);
    this.saved.set(key, plan);
  }

  async load(factoryId: FactoryId, planId: string): Promise<StoredPlan> {
    const key = `${factoryId}/${planId}`;
    this.calls.push(`load ${key}`);
    const plan = this.saved.get(key);
    if (plan === undefined) return { kind: "missing" };
    if (this.damaged.has(key)) return { kind: "damaged" };
    return { kind: "found", plan, files: this.files(key), digest: this.digestOf(key) };
  }

  async digest(factoryId: FactoryId, planId: string): Promise<string | undefined> {
    const key = `${factoryId}/${planId}`;
    this.calls.push(`digest ${key}`);
    return this.directories.has(key) ? this.digestOf(key) : undefined;
  }

  async remove(factoryId: FactoryId, planId: string): Promise<void> {
    const key = `${factoryId}/${planId}`;
    this.calls.push(`remove ${key}`);
    this.directories.delete(key);
    this.saved.delete(key);
  }

  async prune(factoryId: FactoryId, now: Date): Promise<void> {
    this.calls.push(`prune ${factoryId}`);
    for (const [key, plan] of this.saved)
      if (plan.factory_id === factoryId && isPrunable(plan, now)) {
        this.saved.delete(key);
        this.directories.delete(key);
      }
  }
}
