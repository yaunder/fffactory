/**
 * The local plan store: `<cache>/plans/<factory ID>/<plan ID>/`, private to the operator
 * (directories 0700, records 0600), one directory per plan:
 *
 *   factory.tfplan         the factory root's Terraform plan, written by Terraform
 *   backend.tfplan         backend bootstrap's plan, as a saved bootstrap plan or on a first apply
 *   archive.tfplan         the archive root's plan, when a factory plan creates the log archive
 *   factory.tfplan.sha256  a saved factory plan's factory.tfplan SHA-256 when it was saved
 *   backend.tfplan.sha256  a saved bootstrap plan's backend.tfplan SHA-256 when it was saved
 *   archive.tfplan.sha256  a saved factory plan's archive.tfplan SHA-256, when it creates the
 *                          log archive
 *   plan.json              the saved plan's record, written last: its presence saves the plan,
 *                          and its removal spends it, the Terraform plan kept for the apply
 *
 * A record binds the Terraform plan files its kind names: a factory plan `factory.tfplan`, and
 * `archive.tfplan` too when it creates the log archive (`"creates_archive": true`), a bootstrap
 * plan (`"kind": "bootstrap"`) `backend.tfplan`.
 *
 * Teardown removes a factory's directory whole, every plan in it (`removeAll`).
 *
 * A plan is short-lived: plans long expired, and directories without a record (never saved,
 * as an interrupted `plan` or `apply` leaves one, or spent, as an apply killed outright does)
 * long unchanged, are pruned (`PLAN_KEPT_MS`).
 */
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { PlanFiles, PlanStore, StoredPlan } from "../application/plan-store";
import { type FactoryId, parseFactoryId } from "../domain/instance";
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
const ARCHIVE_PLAN = "archive.tfplan";
const DIGEST_SUFFIX = ".sha256";
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

/** Flushes a directory's entries to disk, so a removal in it survives a crash. */
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The Terraform plan files a saved plan binds, in a fixed order. */
function boundFiles(plan: SavedPlan): string[] {
  if (plan.kind === "bootstrap") return [BACKEND_PLAN];
  return plan.creates_archive === true ? [FACTORY_PLAN, ARCHIVE_PLAN] : [FACTORY_PLAN];
}

/**
 * The SHA-256 of each file a saved plan binds, joined by spaces, as one value: a plan binding one
 * file has that file's SHA-256. Undefined when one is absent.
 */
async function boundDigest(path: string, plan: SavedPlan): Promise<string | undefined> {
  const digests = await Promise.all(boundFiles(plan).map((file) => digestOf(join(path, file))));
  return digests.every((digest) => digest !== undefined) ? digests.join(" ") : undefined;
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
      archive: join(planDirectory, ARCHIVE_PLAN),
    };
  }

  /**
   * Whether a plan's directory should go: long expired, or without a readable record (never
   * saved, spent, or unreadable) and long unchanged (`PLAN_KEPT_MS`). One another command
   * removed meanwhile is already gone.
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
      const bound = boundFiles(plan);
      const digests = await Promise.all(bound.map((file) => digestOf(join(path, file))));
      if (!digests.every((digest) => digest !== undefined))
        throw new Error(`Plan ${plan.plan_id} has no Terraform plan to save`);
      for (const [index, file] of bound.entries())
        await writeAtomically(join(path, `${file}${DIGEST_SUFFIX}`), `${digests[index]}\n`);
      await writeAtomically(join(path, RECORD), serializeSavedPlan(plan));
    },

    async load(factoryId, planId): Promise<StoredPlan> {
      const path = planDirectory(factoryId, planId);
      const text = await textOf(join(path, RECORD));
      if (text === undefined) return { kind: "missing" };
      const plan = parseSavedPlan(text, factoryId, planId);
      if (plan === undefined) return { kind: "damaged" };
      const recorded = await Promise.all(
        boundFiles(plan).map(async (file) =>
          (await textOf(join(path, `${file}${DIGEST_SUFFIX}`)))?.trim(),
        ),
      );
      const digest = await boundDigest(path, plan);
      if (digest === undefined || digest !== recorded.join(" ")) return { kind: "damaged" };
      return { kind: "found", plan, files: filesOf(path), digest };
    },

    async digest(plan) {
      return boundDigest(planDirectory(plan.factory_id, plan.plan_id), plan);
    },

    async spend(factoryId, planId) {
      const path = planDirectory(factoryId, planId);
      try {
        await unlink(join(path, RECORD));
      } catch (error) {
        if (isAbsent(error)) return false;
        throw error;
      }
      await syncDirectory(path);
      return true;
    },

    async remove(factoryId, planId) {
      await rm(planDirectory(factoryId, planId), { recursive: true, force: true });
    },

    async removeAll(factoryId) {
      if (!parseFactoryId(factoryId).ok) throw new Error("Not a factory ID");
      await rm(join(directory, factoryId), { recursive: true, force: true });
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
