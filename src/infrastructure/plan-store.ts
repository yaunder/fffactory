/**
 * The local plan store: `<cache>/plans/<factory ID>/<plan ID>/`, private to the operator
 * (directories 0700, records 0600), one directory per plan:
 *
 *   factory.tfplan         the factory root's Terraform plan, written by Terraform
 *   backend.tfplan         backend bootstrap's plan, on a first apply
 *   factory.tfplan.sha256  the factory plan's SHA-256 when the plan was saved
 *   plan.json              the saved plan's record, written last: its presence saves the plan
 *
 * A plan is short-lived: plans long expired, and plans never saved that are long made (an
 * interrupted `plan` or `apply` leaves one), are pruned (`PLAN_KEPT_MS`).
 */
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanFiles, PlanStore, StoredPlan } from "../application/plan-store";
import type { FactoryId } from "../domain/instance";
import {
  isPlanId,
  isPrunable,
  PLAN_KEPT_MS,
  parseSavedPlan,
  type SavedPlan,
  serializeSavedPlan,
} from "../domain/plan";
import { sha256Hex } from "./release-tarball";

const RECORD = "plan.json";
const FACTORY_PLAN = "factory.tfplan";
const BACKEND_PLAN = "backend.tfplan";
const DIGEST = "factory.tfplan.sha256";
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

function isAbsent(error: unknown): boolean {
  return ABSENT.has((error as NodeJS.ErrnoException).code ?? "");
}

/** The file's text, or undefined when it does not exist. */
async function textOf(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
}

async function digestOf(path: string): Promise<string | undefined> {
  try {
    return sha256Hex(new Uint8Array(await readFile(path)));
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
}

/** Writes `text` beside `path` and renames it into place, so a reader sees all or nothing. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const staged = `${path}.staged`;
  await writeFile(staged, text, { mode: 0o600 });
  await rename(staged, path);
}

/** PlanStore over the local filesystem, rooted at `directory` (`<cache>/plans`). */
export function filesystemPlanStore(directory: string): PlanStore {
  function planDirectory(factoryId: FactoryId, planId: string): string {
    if (!isPlanId(planId))
      throw new Error("Not a plan ID: a plan ID is 8 lowercase letters or digits");
    return join(directory, factoryId, planId);
  }

  function filesOf(planDirectory: string): PlanFiles {
    return {
      factory: join(planDirectory, FACTORY_PLAN),
      backend: join(planDirectory, BACKEND_PLAN),
    };
  }

  /**
   * Whether a plan's directory should go: long expired, or never saved (or unreadable) and
   * long made (`PLAN_KEPT_MS`). One another command removed meanwhile is already gone.
   */
  async function prunable(factoryId: FactoryId, planId: string, now: Date): Promise<boolean> {
    const path = join(directory, factoryId, planId);
    const plan = parseSavedPlan((await textOf(join(path, RECORD))) ?? "", factoryId, planId);
    if (plan !== undefined) return isPrunable(plan, now);
    const info = await lstat(path).catch((error: unknown) => {
      if (isAbsent(error)) return undefined;
      throw error;
    });
    return info !== undefined && now.getTime() - info.mtimeMs > PLAN_KEPT_MS;
  }

  return {
    async create(factoryId, planId) {
      const path = planDirectory(factoryId, planId);
      await mkdir(join(directory, factoryId), { recursive: true, mode: 0o700 });
      await mkdir(path, { mode: 0o700 });
      return filesOf(path);
    },

    async save(plan: SavedPlan) {
      const path = planDirectory(plan.factory_id, plan.plan_id);
      const digest = await digestOf(join(path, FACTORY_PLAN));
      if (digest === undefined)
        throw new Error(`Plan ${plan.plan_id} has no Terraform plan to save`);
      await writeAtomically(join(path, DIGEST), `${digest}\n`);
      await writeAtomically(join(path, RECORD), serializeSavedPlan(plan));
    },

    async load(factoryId, planId): Promise<StoredPlan> {
      const path = planDirectory(factoryId, planId);
      const text = await textOf(join(path, RECORD));
      if (text === undefined) return { kind: "missing" };
      const plan = parseSavedPlan(text, factoryId, planId);
      const recorded = (await textOf(join(path, DIGEST)))?.trim();
      const digest = await digestOf(join(path, FACTORY_PLAN));
      if (plan === undefined || digest === undefined || digest !== recorded)
        return { kind: "damaged" };
      return { kind: "found", plan, files: filesOf(path), digest };
    },

    async digest(factoryId, planId) {
      return digestOf(join(planDirectory(factoryId, planId), FACTORY_PLAN));
    },

    async remove(factoryId, planId) {
      await rm(planDirectory(factoryId, planId), { recursive: true, force: true });
    },

    async prune(factoryId, now) {
      let entries: string[];
      try {
        entries = await readdir(join(directory, factoryId));
      } catch (error) {
        if (isAbsent(error)) return;
        throw error;
      }
      for (const planId of entries.filter(isPlanId))
        if (await prunable(factoryId, planId, now))
          await rm(join(directory, factoryId, planId), { recursive: true, force: true });
    },
  };
}
