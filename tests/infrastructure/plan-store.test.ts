import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryId, Release } from "../../src/domain/instance";
import { newSavedPlan, PLAN_KEPT_MS, PLAN_TTL_MS, type SavedPlan } from "../../src/domain/plan";
import { filesystemPlanStore } from "../../src/infrastructure/plan-store";
import { sha256Hex } from "../../src/infrastructure/release-tarball";

const FACTORY = "fff-abcd1234" as FactoryId;
const NOW = new Date("2026-09-30T12:00:00.000Z");

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-plans-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function plan(planId: string, now = NOW): SavedPlan {
  return newSavedPlan({
    planId,
    factoryId: FACTORY,
    instancePath: "/work/.fffactory/factory.json",
    configurationSha256: "a".repeat(64),
    release: "0.3.0" as Release,
    assetsSha256: "b".repeat(64),
    accountId: "123456789012",
    stateRevision: "v1",
    now,
    changes: [{ address: 'module.hosts.aws_instance.host["a"]', actions: ["create"] }],
  });
}

async function fresh() {
  const directory = await mkdtemp(join(scratch, "store-"));
  return { directory, store: filesystemPlanStore(directory) };
}

/** Creates and saves plan `planId`, as `fffactory plan` does once Terraform wrote its plan. */
async function saved(store: ReturnType<typeof filesystemPlanStore>, planId: string, now = NOW) {
  const files = await store.create(FACTORY, planId);
  await writeFile(files.factory, `terraform plan ${planId}`);
  await store.save(plan(planId, now));
  return files;
}

describe("the local plan store", () => {
  test("gives each plan its own private directory under the factory ID", async () => {
    const { directory, store } = await fresh();
    const files = await store.create(FACTORY, "k3x9q2ab");
    const planDirectory = join(directory, FACTORY, "k3x9q2ab");
    expect(files).toEqual({
      factory: join(planDirectory, "factory.tfplan"),
      backend: join(planDirectory, "backend.tfplan"),
    });
    expect((await stat(planDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, FACTORY))).mode & 0o777).toBe(0o700);
    await expect(store.create(FACTORY, "k3x9q2ab")).rejects.toThrow();
  });

  test("never takes a plan ID that could name another path", async () => {
    const { store } = await fresh();
    await expect(store.create(FACTORY, "../../x")).rejects.toThrow("Not a plan ID");
    await expect(store.load(FACTORY, "../escape")).rejects.toThrow("Not a plan ID");
    await expect(store.remove(FACTORY, "a/b")).rejects.toThrow("Not a plan ID");
  });

  test("loads a saved plan with its files, and a plan never saved is missing", async () => {
    const { directory, store } = await fresh();
    const files = await saved(store, "k3x9q2ab");
    expect(await store.load(FACTORY, "k3x9q2ab")).toEqual({
      kind: "found",
      plan: plan("k3x9q2ab"),
      files,
      digest: sha256Hex(new TextEncoder().encode("terraform plan k3x9q2ab")),
    });
    const record = join(directory, FACTORY, "k3x9q2ab", "plan.json");
    expect((await stat(record)).mode & 0o777).toBe(0o600);
    await store.create(FACTORY, "unsaved1");
    expect(await store.load(FACTORY, "unsaved1")).toEqual({ kind: "missing" });
    expect(await store.load(FACTORY, "nothere1")).toEqual({ kind: "missing" });
  });

  test("a plan whose Terraform plan changed or vanished after saving is damaged", async () => {
    const { store } = await fresh();
    const files = await saved(store, "changed1");
    await writeFile(files.factory, "another plan");
    expect(await store.load(FACTORY, "changed1")).toEqual({ kind: "damaged" });
    const gone = await saved(store, "vanished");
    await rm(gone.factory);
    expect(await store.load(FACTORY, "vanished")).toEqual({ kind: "damaged" });
  });

  test("reads a plan's Terraform plan file digest as the file is now", async () => {
    const { store } = await fresh();
    const files = await saved(store, "swapped1");
    const loaded = await store.load(FACTORY, "swapped1");
    expect(await store.digest(FACTORY, "swapped1")).toBe(
      loaded.kind === "found" ? loaded.digest : "not found",
    );
    await writeFile(files.factory, "a swapped plan");
    expect(await store.digest(FACTORY, "swapped1")).toBe(
      sha256Hex(new TextEncoder().encode("a swapped plan")),
    );
    await rm(files.factory);
    expect(await store.digest(FACTORY, "swapped1")).toBeUndefined();
    await expect(store.digest(FACTORY, "../escape")).rejects.toThrow("Not a plan ID");
  });

  test("a plan whose record cannot be read, or is another plan's, is damaged", async () => {
    const { directory, store } = await fresh();
    await saved(store, "garbled1");
    await writeFile(join(directory, FACTORY, "garbled1", "plan.json"), "{not json");
    expect(await store.load(FACTORY, "garbled1")).toEqual({ kind: "damaged" });
    await saved(store, "original");
    await mkdir(join(directory, FACTORY, "copied11"), { mode: 0o700 });
    for (const file of ["plan.json", "factory.tfplan", "factory.tfplan.sha256"])
      await Bun.write(
        join(directory, FACTORY, "copied11", file),
        Bun.file(join(directory, FACTORY, "original", file)),
      );
    expect(await store.load(FACTORY, "copied11")).toEqual({ kind: "damaged" });
  });

  test("saving refuses a plan whose Terraform plan was never written", async () => {
    const { store } = await fresh();
    await store.create(FACTORY, "noplan11");
    await expect(store.save(plan("noplan11"))).rejects.toThrow();
    expect(await store.load(FACTORY, "noplan11")).toEqual({ kind: "missing" });
  });

  test("removes a plan, saved or not", async () => {
    const { directory, store } = await fresh();
    await saved(store, "k3x9q2ab");
    await store.create(FACTORY, "unsaved1");
    await store.remove(FACTORY, "k3x9q2ab");
    await store.remove(FACTORY, "unsaved1");
    await store.remove(FACTORY, "nothere1");
    expect(await readdir(join(directory, FACTORY))).toEqual([]);
  });

  test("prunes plans long expired and long unsaved, keeping the rest", async () => {
    const { directory, store } = await fresh();
    // Unsaved plans age by their directory's time, so this test runs on the real clock.
    const now = new Date();
    await store.prune(FACTORY, now);
    await saved(store, "expired1", new Date(now.getTime() - PLAN_TTL_MS - PLAN_KEPT_MS - 1));
    await saved(store, "expired2", new Date(now.getTime() - PLAN_TTL_MS - 1));
    await saved(store, "current1", now);
    await store.create(FACTORY, "unsaved1");
    await store.create(FACTORY, "unsaved2");
    const old = new Date(now.getTime() - PLAN_KEPT_MS - 60_000);
    await utimes(join(directory, FACTORY, "unsaved2"), old, old);
    await saved(store, "garbled1", now);
    await writeFile(join(directory, FACTORY, "garbled1", "plan.json"), "{not json");
    await utimes(join(directory, FACTORY, "garbled1"), old, old);
    await mkdir(join(directory, FACTORY, "Not-A-Plan"));

    await store.prune(FACTORY, now);

    expect((await readdir(join(directory, FACTORY))).sort()).toEqual([
      "Not-A-Plan",
      "current1",
      "expired2",
      "unsaved1",
    ]);
  });
});
