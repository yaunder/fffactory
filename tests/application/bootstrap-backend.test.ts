import { describe, expect, test } from "bun:test";
import type { Approval } from "../../src/application/approval";
import {
  applySavedBootstrap,
  type BackendBootstrapRequest,
  beginFactoryOperation,
  bootstrapBackend,
  type SavedBootstrapRequest,
} from "../../src/application/bootstrap-backend";
import type { AllowedAccount } from "../../src/application/require-expected-account";
import { unreadyBucketRefusal } from "../../src/domain/backend-bootstrap";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { FactoryId, FactoryInstance, Release } from "../../src/domain/instance";
import { newSavedBootstrapPlan, PLAN_TTL_MS } from "../../src/domain/plan";
import { FAKE_CALLER } from "../support/doctor-fakes";
import { fakeProvisioner } from "../support/fake-provisioner";
import { MemoryLockStore, READY_BUCKET } from "../support/memory-lock-store";
import { MemoryPlanStore } from "../support/memory-plan-store";

const BUCKET = "fff-abcd1234-state";
const INSTANCE: FactoryInstance = {
  schema_version: 1,
  release: "0.3.0",
  factory_id: "fff-abcd1234" as FactoryId,
  name: "Test factory",
  aws: { account_id: "123456789012", region: "eu-west-2" },
  state_backend: { bucket: BUCKET },
};
const ACCOUNT: AllowedAccount = { allowed: true, verdict: { kind: "match", caller: FAKE_CALLER } };
const CREATES = {
  format_version: "1.2",
  resource_changes: [
    { address: "module.state_bucket.aws_s3_bucket.state", change: { actions: ["create"] } },
    {
      address: "module.state_bucket.aws_s3_bucket_versioning.state",
      change: { actions: ["create"] },
    },
    {
      address: "module.state_bucket.data.aws_iam_policy_document.tls_only",
      change: { actions: ["read"] },
    },
  ],
};

function request(overrides: Partial<BackendBootstrapRequest> = {}): BackendBootstrapRequest {
  return {
    account: ACCOUNT,
    instancePath: "/work/.fffactory/factory.json",
    instance: INSTANCE,
    credentials: { source: "--profile", profile: "factory" },
    release: "0.3.0" as Release,
    terraformDirectory: "/cache/releases/0.3.0/terraform",
    planFile: "/tmp/op/backend.tfplan",
    ...overrides,
  };
}

/** Approval that records what it was shown and answers `answer`. */
function approval(answer: boolean) {
  const shown: (readonly string[])[] = [];
  const port: Approval = {
    approve: async (plan) => {
      shown.push(plan);
      return answer;
    },
  };
  return { port, shown };
}

/** A world where applying the backend plan creates the bucket in the lock store. */
function world(options: { existing?: boolean; shown?: unknown; approve?: boolean } = {}) {
  const store = new MemoryLockStore(options.existing ? [BUCKET] : []);
  const terraform = fakeProvisioner({
    shown: options.shown ?? CREATES,
    onApply: () => store.buckets.add(BUCKET),
  });
  const approver = approval(options.approve ?? true);
  const deps = { lockStore: store, provisioner: terraform.provisioner, approval: approver.port };
  return { store, terraform, approver, deps };
}

describe("backend bootstrap", () => {
  test("an existing state bucket is left alone: no plan, no approval", async () => {
    const { deps, terraform, approver, store } = world({ existing: true });
    const result = await bootstrapBackend(deps, request());
    expect(result.kind).toBe("present");
    expect(terraform.calls).toEqual([]);
    expect(approver.shown).toEqual([]);
    expect(store.calls).toEqual([`bucketExists ${BUCKET}`, `bucketReadiness ${BUCKET}`]);
  });

  test("an existing bucket that bootstrap did not finish is refused with how to complete it", async () => {
    const { deps, terraform, approver, store } = world({ existing: true });
    const readiness = { ...READY_BUCKET, versioning: undefined, tlsOnly: false };
    store.readiness.set(BUCKET, readiness);
    const result = await bootstrapBackend(deps, request());
    expect(result).toEqual({
      kind: "unready",
      refusal: unreadyBucketRefusal(
        { bucket: BUCKET, accountId: "123456789012", region: "eu-west-2" },
        readiness,
      ),
    });
    expect(terraform.calls).toEqual([]);
    expect(approver.shown).toEqual([]);
  });

  test("a missing bucket is planned with the backend root, shown, approved, then applied", async () => {
    const { deps, terraform, approver, store } = world();
    const result = await bootstrapBackend(deps, request());
    expect(result).toMatchObject({ kind: "created", bucket: { bucket: BUCKET } });
    const target = {
      configuration: { directory: "/cache/releases/0.3.0/terraform", root: "backend" },
      credentials: { source: "--profile" as const, profile: "factory" },
      region: "eu-west-2",
      backend: {},
    };
    expect(terraform.calls).toEqual([
      {
        call: "plan",
        request: {
          ...target,
          planFile: "/tmp/op/backend.tfplan",
          variables: {
            factory_id: "fff-abcd1234",
            account_id: "123456789012",
            region: "eu-west-2",
            state_bucket_suffix: "state",
          },
        },
      },
      { call: "showPlan", request: { ...target, planFile: "/tmp/op/backend.tfplan" } },
      { call: "applyPlan", request: { ...target, planFile: "/tmp/op/backend.tfplan" } },
    ]);
    expect(approver.shown).toEqual([
      [
        `Backend bootstrap: the state bucket ${BUCKET} does not exist yet.`,
        "  Configuration: /work/.fffactory/factory.json",
        "  Factory: Test factory (fff-abcd1234)",
        "  AWS account: 123456789012, Region: eu-west-2",
        "  Release: 0.3.0",
        "Terraform will create:",
        "  + module.state_bucket.aws_s3_bucket.state",
        "  + module.state_bucket.aws_s3_bucket_versioning.state",
      ],
    ]);
    expect(store.buckets.has(BUCKET)).toBe(true);
  });

  test("a declined bootstrap applies nothing", async () => {
    const { deps, terraform } = world({ approve: false });
    expect(await bootstrapBackend(deps, request())).toEqual({ kind: "declined" });
    expect(terraform.calls.map(({ call }) => call)).toEqual(["plan", "showPlan"]);
  });

  test.each([
    [
      "a plan that would change or replace anything",
      {
        resource_changes: [
          { address: "a.x", change: { actions: ["create"] } },
          { address: "a.y", change: { actions: ["delete", "create"] } },
        ],
      },
      ["a.y (delete, create)"],
    ],
    ["an unreadable plan", { resource_changes: "nope" }, ["Terraform's plan could not be read"]],
    [
      "a plan that creates nothing",
      { resource_changes: [] },
      ["the plan creates nothing, though the state bucket does not exist"],
    ],
  ])("%s is refused before approval", async (_, shown, unexpected) => {
    const { deps, terraform, approver } = world({ shown });
    expect(await bootstrapBackend(deps, request())).toEqual({
      kind: "unexpected_plan",
      unexpected,
    });
    expect(approver.shown).toEqual([]);
    expect(terraform.calls.map(({ call }) => call)).toEqual(["plan", "showPlan"]);
  });

  test("an instance without its backend fields is refused before reaching AWS", async () => {
    const { deps, terraform, store } = world();
    const instance: FactoryInstance = {
      schema_version: 1,
      factory_id: "fff-abcd1234" as FactoryId,
    };
    const result = await bootstrapBackend(deps, request({ instance }));
    expect(result).toEqual({
      kind: "refused",
      issues: [
        { path: "aws.account_id", message: "is required to reach the state bucket" },
        { path: "aws.region", message: "is required to reach the state bucket" },
        { path: "state_backend.bucket", message: "is required to reach the state bucket" },
      ],
    });
    expect(store.calls).toEqual([]);
    expect(terraform.calls).toEqual([]);
  });

  test("a state bucket outside the factory's namespace is refused", async () => {
    const { deps, store } = world();
    const instance = { ...INSTANCE, state_backend: { bucket: "someone-elses-bucket" } };
    const result = await bootstrapBackend(deps, request({ instance }));
    expect(result).toMatchObject({ kind: "refused", issues: [{ path: "state_backend.bucket" }] });
    expect(store.calls).toEqual([]);
  });

  test("an account check for another account is refused", async () => {
    const { deps, store } = world();
    const other: AllowedAccount = {
      allowed: true,
      verdict: { kind: "match", caller: { ...FAKE_CALLER, account: "210987654321" } },
    };
    const result = await bootstrapBackend(deps, request({ account: other }));
    expect(result).toEqual({
      kind: "refused",
      issues: [{ path: "aws.account_id", message: "is not the account the account check allowed" }],
    });
    expect(store.calls).toEqual([]);
  });

  test("a failed bucket check stops before planning", async () => {
    const { deps, terraform } = world();
    const failing = {
      ...deps,
      lockStore: Object.assign(deps.lockStore, {
        bucketExists: async () => {
          throw new Error("S3 HeadBucket failed: Forbidden");
        },
      }),
    };
    await expect(bootstrapBackend(failing, request())).rejects.toThrow("Forbidden");
    expect(terraform.calls).toEqual([]);
  });
});

describe("beginning a factory operation (first apply)", () => {
  const NOW = new Date("2026-09-30T10:00:00.000Z");
  const begin = { operation: "apply", host: "laptop", clock: () => NOW };
  const randomBytes = (count: number) => new Uint8Array(count);

  test("bootstraps the backend, then acquires the newly created lock", async () => {
    const { deps, store } = world();
    const result = await beginFactoryOperation(deps, { ...request(), ...begin, randomBytes });
    if (result.kind !== "acquired") throw new Error(`not acquired: ${result.kind}`);
    expect(result.bootstrapped).toBe(true);
    expect(result.lock.record.holder).toEqual({ principal: FAKE_CALLER.arn, host: "laptop" });
    expect(store.locks.get(BUCKET)?.version).toBe(result.lock.version);
    expect(store.calls.slice(0, 2)).toEqual([
      `bucketExists ${BUCKET}`,
      `create ${BUCKET} aaaaaaaa`,
    ]);
  });

  test("an established factory only acquires the lock", async () => {
    const { deps, terraform } = world({ existing: true });
    const result = await beginFactoryOperation(deps, { ...request(), ...begin, randomBytes });
    expect(result).toMatchObject({ kind: "acquired", bootstrapped: false });
    expect(terraform.calls).toEqual([]);
  });

  test("a concurrent operation is refused with the holder shown", async () => {
    const { deps, store } = world({ existing: true });
    const other = { principal: "arn:aws:sts::123456789012:assumed-role/Admin/other", host: "desk" };
    const held = store.hold(
      BUCKET,
      newLockRecord({
        factoryId: "fff-abcd1234" as FactoryId,
        operation: "apply",
        holder: other,
        now: NOW,
        release: "0.3.0" as Release,
        randomBytes: (count) => new Uint8Array(count).fill(1),
      }),
    );
    const result = await beginFactoryOperation(deps, { ...request(), ...begin, randomBytes });
    expect(result).toEqual({ kind: "locked", held });
    expect(store.locks.get(BUCKET)).toBe(held);
  });

  test("a half-bootstrapped bucket takes no lock", async () => {
    const { deps, store } = world({ existing: true });
    store.readiness.set(BUCKET, { ...READY_BUCKET, versioning: "Suspended" });
    const result = await beginFactoryOperation(deps, { ...request(), ...begin, randomBytes });
    expect(result.kind).toBe("unready");
    expect(store.locks.size).toBe(0);
    expect(store.calls.some((call) => call.startsWith("create"))).toBe(false);
  });

  test("the lock is taken at the time bootstrap finishes", async () => {
    const { deps } = world();
    let ticks = 0;
    const clock = () => new Date(NOW.getTime() + 60_000 * ticks++);
    const result = await beginFactoryOperation(deps, {
      ...request(),
      ...begin,
      clock,
      randomBytes,
    });
    if (result.kind !== "acquired") throw new Error(`not acquired: ${result.kind}`);
    expect(result.lock.record.acquired_at).toBe(NOW.toISOString());
    expect(ticks).toBe(1);
  });

  test("an interrupt during bootstrap takes no lock", async () => {
    const { store, terraform } = world();
    let interrupted = false;
    const deps = {
      lockStore: store,
      provisioner: {
        ...terraform.provisioner,
        applyPlan: async (planned: Parameters<typeof terraform.provisioner.applyPlan>[0]) => {
          await terraform.provisioner.applyPlan(planned);
          interrupted = true;
        },
      },
      approval: { approve: async () => true },
      interrupted: () => interrupted,
    };
    const result = await beginFactoryOperation(deps, { ...request(), ...begin, randomBytes });
    expect(result).toEqual({ kind: "interrupted" });
    expect(store.locks.size).toBe(0);
    expect(store.buckets.has(BUCKET)).toBe(true);
  });

  test("a declined bootstrap takes no lock", async () => {
    const { deps, store } = world({ approve: false });
    const result = await beginFactoryOperation(deps, { ...request(), ...begin, randomBytes });
    expect(result).toEqual({ kind: "declined" });
    expect(store.locks.size).toBe(0);
  });
});

describe("applying a saved bootstrap plan (plan-apply §Apply)", () => {
  const NOW = new Date("2026-09-30T10:00:00.000Z");
  const FACTORY_ID = "fff-abcd1234" as FactoryId;
  const PLAN_ID = "b00tstr4";
  const CONFIGURATION = "c".repeat(64);
  const ASSETS = "d".repeat(64);
  const CURRENT = {
    factoryId: FACTORY_ID,
    instancePath: "/work/.fffactory/factory.json",
    configurationSha256: CONFIGURATION,
    release: "0.3.0" as Release,
    assetsSha256: ASSETS,
    accountId: "123456789012",
    now: new Date(NOW.getTime() + 60_000),
  };
  const BACKEND_TARGET = {
    configuration: { directory: "/cache/releases/0.3.0/terraform", root: "backend" },
    credentials: { source: "--profile" as const, profile: "factory" },
    region: "eu-west-2",
    backend: {},
    planFile: `/plans/${FACTORY_ID}/${PLAN_ID}/backend.tfplan`,
  };

  /**
   * A factory with no state bucket and a saved bootstrap plan B for it, as `fffactory plan`
   * saves one. `events` orders what changes anything: the Terraform apply, B's removal and the
   * lock's creation.
   */
  async function savedWorld(options: { shown?: unknown; approve?: boolean } = {}) {
    const events: string[] = [];
    const store = new MemoryLockStore();
    const terraform = fakeProvisioner({
      shown: options.shown ?? CREATES,
      onApply: () => {
        events.push("applyPlan");
        store.buckets.add(BUCKET);
      },
    });
    const planStore = new MemoryPlanStore();
    const files = await planStore.create(FACTORY_ID, PLAN_ID);
    const saved = newSavedBootstrapPlan({
      ...CURRENT,
      planId: PLAN_ID,
      now: NOW,
      changes: [
        { address: "module.state_bucket.aws_s3_bucket.state", actions: ["create"] },
        { address: "module.state_bucket.aws_s3_bucket_versioning.state", actions: ["create"] },
      ],
    });
    await planStore.save(saved);
    const loaded = await planStore.load(FACTORY_ID, PLAN_ID);
    if (loaded.kind !== "found") throw new Error("not saved");
    const create = store.create.bind(store);
    store.create = async (bucket, record) => {
      events.push("lock");
      return create(bucket, record);
    };
    const remove = planStore.remove.bind(planStore);
    planStore.remove = async (factoryId, planId) => {
      events.push(`remove ${planId}`);
      return remove(factoryId, planId);
    };
    const approver = approval(options.approve ?? true);
    const signal = { interrupted: false };
    const deps = {
      lockStore: store,
      provisioner: terraform.provisioner,
      approval: approver.port,
      planStore,
      interrupted: () => signal.interrupted,
    };
    const savedRequest = (
      overrides: Partial<SavedBootstrapRequest> = {},
    ): SavedBootstrapRequest => {
      const { planFile: _, ...base } = request();
      return {
        ...base,
        saved,
        files,
        digest: loaded.digest,
        current: CURRENT,
        operation: "apply",
        host: "laptop",
        clock: () => NOW,
        randomBytes: (count) => new Uint8Array(count),
        ...overrides,
      };
    };
    return { events, store, terraform, planStore, approver, signal, deps, saved, savedRequest };
  }

  /** Nothing was applied, locked or recorded, and B is kept: it was never spent. */
  function nothingChanged(world: Awaited<ReturnType<typeof savedWorld>>) {
    expect(world.terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(world.store.calls.some((call) => call.startsWith("create"))).toBe(false);
    expect(world.store.operationWrites).toEqual([]);
    expect(world.planStore.saved.has(`${FACTORY_ID}/${PLAN_ID}`)).toBe(true);
  }

  test("applies exactly B's file, approved by its ID, then spends B and takes the lock", async () => {
    const world = await savedWorld();
    const result = await applySavedBootstrap(world.deps, world.savedRequest());
    if (result.kind !== "acquired") throw new Error(`not acquired: ${result.kind}`);
    expect(result.lock.record.holder).toEqual({ principal: FAKE_CALLER.arn, host: "laptop" });
    expect(world.store.locks.get(BUCKET)?.version).toBe(result.lock.version);
    // Exactly the saved file is read back and applied; nothing is planned.
    expect(world.terraform.calls).toEqual([
      { call: "showPlan", request: BACKEND_TARGET },
      { call: "applyPlan", request: BACKEND_TARGET },
    ]);
    expect(world.events).toEqual(["applyPlan", `remove ${PLAN_ID}`, "lock"]);
    expect(world.approver.shown).toEqual([
      [
        `Backend bootstrap: the state bucket ${BUCKET} does not exist yet.`,
        "  Configuration: /work/.fffactory/factory.json",
        "  Factory: Test factory (fff-abcd1234)",
        "  AWS account: 123456789012, Region: eu-west-2",
        "  Release: 0.3.0",
        "Terraform will create:",
        "  + module.state_bucket.aws_s3_bucket.state",
        "  + module.state_bucket.aws_s3_bucket_versioning.state",
      ],
    ]);
    // The bucket is checked missing before the read-back, and again right before the apply.
    expect(world.store.calls.filter((call) => call.startsWith("bucketExists"))).toHaveLength(2);
    expect(world.store.buckets.has(BUCKET)).toBe(true);
    expect(world.planStore.saved.size).toBe(0);
  });

  test.each([
    [
      "factory.json changed",
      { configurationSha256: "e".repeat(64) },
      "factory.json changed after it was planned",
    ],
    [
      "another factory.json",
      { instancePath: "/elsewhere/factory.json" },
      "it was planned for another factory.json, /work/.fffactory/factory.json",
    ],
    [
      "another release",
      { release: "0.3.1" as Release },
      "it was planned by fffactory 0.3.0, not this release",
    ],
    [
      "other assets",
      { assetsSha256: "f".repeat(64) },
      "it was planned with other release assets than this fffactory's",
    ],
    [
      "another account",
      { accountId: "210987654321" },
      "it was planned in AWS account 123456789012, not this one",
    ],
    [
      "its expiry",
      { now: new Date(NOW.getTime() + PLAN_TTL_MS + 1) },
      `it expired at ${new Date(NOW.getTime() + PLAN_TTL_MS).toISOString()}`,
    ],
  ])("a plan stale by %s is refused with nothing changed", async (_, changed, reason) => {
    const world = await savedWorld();
    const result = await applySavedBootstrap(
      world.deps,
      world.savedRequest({ current: { ...CURRENT, ...changed } }),
    );
    expect(result).toEqual({ kind: "stale", planId: PLAN_ID, reasons: [reason] });
    expect(world.terraform.calls).toEqual([]);
    nothingChanged(world);
  });

  test.each([
    ["ready", READY_BUCKET],
    ["unready", { ...READY_BUCKET, versioning: undefined }],
  ])("a state bucket that exists now, %s, makes B stale", async (_, readiness) => {
    const world = await savedWorld();
    world.store.buckets.add(BUCKET);
    world.store.readiness.set(BUCKET, readiness);
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "stale",
      planId: PLAN_ID,
      reasons: ["the state bucket was created after it was planned"],
    });
    expect(world.terraform.calls).toEqual([]);
    nothingChanged(world);
  });

  test("a bucket created after the read-back is caught right before the apply", async () => {
    const world = await savedWorld();
    const { showPlan } = world.terraform.provisioner;
    world.deps.provisioner = {
      ...world.terraform.provisioner,
      showPlan: async (planned) => {
        const shown = await showPlan(planned);
        world.store.buckets.add(BUCKET);
        return shown;
      },
    };
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "stale",
      planId: PLAN_ID,
      reasons: ["the state bucket was created after it was planned"],
    });
    nothingChanged(world);
  });

  test("a backend.tfplan swapped after B was loaded is damaged, and never read back", async () => {
    const world = await savedWorld();
    world.planStore.swap(FACTORY_ID, PLAN_ID);
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "damaged_plan",
      planId: PLAN_ID,
    });
    expect(world.terraform.calls).toEqual([]);
    nothingChanged(world);
  });

  test("a backend.tfplan swapped after it was read back is never applied", async () => {
    const world = await savedWorld();
    const { showPlan } = world.terraform.provisioner;
    world.deps.provisioner = {
      ...world.terraform.provisioner,
      showPlan: async (planned) => {
        const shown = await showPlan(planned);
        world.planStore.swap(FACTORY_ID, PLAN_ID);
        return shown;
      },
    };
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "damaged_plan",
      planId: PLAN_ID,
    });
    nothingChanged(world);
  });

  test("a read-back that differs from B's record is damaged", async () => {
    const world = await savedWorld({
      shown: {
        resource_changes: [
          { address: "module.state_bucket.aws_s3_bucket.state", change: { actions: ["create"] } },
        ],
      },
    });
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "damaged_plan",
      planId: PLAN_ID,
    });
    expect(world.approver.shown).toEqual([]);
    nothingChanged(world);
  });

  test.each([
    [
      "does more than create",
      {
        resource_changes: [
          { address: "module.state_bucket.aws_s3_bucket.state", change: { actions: ["create"] } },
          {
            address: "module.state_bucket.aws_s3_bucket_versioning.state",
            change: { actions: ["delete", "create"] },
          },
        ],
      },
      ["module.state_bucket.aws_s3_bucket_versioning.state (delete, create)"],
    ],
    ["cannot be read", { resource_changes: "nope" }, ["Terraform's plan could not be read"]],
    [
      "creates nothing",
      { resource_changes: [] },
      ["the plan creates nothing, though the state bucket does not exist"],
    ],
  ])("a read-back that %s is an unexpected plan", async (_, shown, unexpected) => {
    const world = await savedWorld({ shown });
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "unexpected_plan",
      unexpected,
    });
    expect(world.approver.shown).toEqual([]);
    nothingChanged(world);
  });

  test("an approval that does not approve applies nothing", async () => {
    const world = await savedWorld({ approve: false });
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "declined",
    });
    nothingChanged(world);
  });

  test("an account check for another account is refused before reaching AWS", async () => {
    const world = await savedWorld();
    const other: AllowedAccount = {
      allowed: true,
      verdict: { kind: "match", caller: { ...FAKE_CALLER, account: "210987654321" } },
    };
    expect(await applySavedBootstrap(world.deps, world.savedRequest({ account: other }))).toEqual({
      kind: "refused",
      issues: [{ path: "aws.account_id", message: "is not the account the account check allowed" }],
    });
    expect(world.store.calls).toEqual([]);
    expect(world.terraform.calls).toEqual([]);
    nothingChanged(world);
  });

  test("a failed Terraform apply spends B, takes no lock and fails", async () => {
    const world = await savedWorld();
    world.deps.provisioner = {
      ...world.terraform.provisioner,
      applyPlan: async () => {
        throw new Error("`terraform apply` exited with status 1");
      },
    };
    await expect(applySavedBootstrap(world.deps, world.savedRequest())).rejects.toThrow(
      "exited with status 1",
    );
    expect(world.events).toEqual([`remove ${PLAN_ID}`]);
    expect(world.store.locks.size).toBe(0);
    expect(world.store.operationWrites).toEqual([]);
  });

  test("an interrupt during the apply takes no lock, and B is spent", async () => {
    const world = await savedWorld();
    const { applyPlan } = world.terraform.provisioner;
    world.deps.provisioner = {
      ...world.terraform.provisioner,
      applyPlan: async (planned) => {
        await applyPlan(planned);
        world.signal.interrupted = true;
      },
    };
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "interrupted",
    });
    expect(world.events).toEqual(["applyPlan", `remove ${PLAN_ID}`]);
    expect(world.store.locks.size).toBe(0);
    expect(world.store.buckets.has(BUCKET)).toBe(true);
  });

  test("an interrupt that stops Terraform takes no lock, and says so rather than failing", async () => {
    const world = await savedWorld();
    world.deps.provisioner = {
      ...world.terraform.provisioner,
      applyPlan: async () => {
        world.signal.interrupted = true;
        throw new Error("`terraform apply` exited with status 1");
      },
    };
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "interrupted",
    });
    expect(world.events).toEqual([`remove ${PLAN_ID}`]);
    expect(world.store.locks.size).toBe(0);
  });

  test("an interrupt before the apply applies nothing and keeps B", async () => {
    const world = await savedWorld();
    world.deps.approval = {
      approve: async () => {
        world.signal.interrupted = true;
        return true;
      },
    };
    expect(await applySavedBootstrap(world.deps, world.savedRequest())).toEqual({
      kind: "interrupted",
    });
    nothingChanged(world);
  });

  test("a lock another operation took meanwhile is reported, with the bucket created", async () => {
    const world = await savedWorld();
    const other = { principal: "arn:aws:sts::123456789012:assumed-role/Admin/other", host: "desk" };
    let held: ReturnType<typeof world.store.hold> | undefined;
    const { applyPlan } = world.terraform.provisioner;
    world.deps.provisioner = {
      ...world.terraform.provisioner,
      applyPlan: async (planned) => {
        await applyPlan(planned);
        held = world.store.hold(
          BUCKET,
          newLockRecord({
            factoryId: FACTORY_ID,
            operation: "apply",
            holder: other,
            now: NOW,
            release: "0.3.0" as Release,
            randomBytes: (count) => new Uint8Array(count).fill(1),
          }),
        );
      },
    };
    const result = await applySavedBootstrap(world.deps, world.savedRequest());
    expect(result).toEqual({ kind: "locked", held });
    expect(world.store.buckets.has(BUCKET)).toBe(true);
    expect(world.planStore.saved.size).toBe(0);
  });
});
