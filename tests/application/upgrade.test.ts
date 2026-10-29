import { describe, expect, test } from "bun:test";
import { applyFactory, type FactoryApplyRequest } from "../../src/application/apply-factory";
import type { Approval } from "../../src/application/approval";
import { breakFactoryLock } from "../../src/application/factory-lock";
import { type UpgradeRequest, upgradeFactory } from "../../src/application/upgrade";
import type { FactoryInstance, HostKey, Release } from "../../src/domain/instance";
import type { OperationRecord } from "../../src/domain/operation";
import type { PlanReview } from "../../src/domain/plan";
import type { ReleaseCompatibility } from "../../src/domain/release-compatibility";
import {
  ARCHIVE,
  BUCKET,
  declaring,
  FACTORY,
  factory,
  NOW,
  planRequest,
} from "../support/factory-world";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { type MemoryLockStore, READY_ARCHIVE } from "../support/memory-lock-store";
import type { MemoryPlanStore } from "../support/memory-plan-store";

const PATH = "/work/.fffactory/factory.json";
const RUNNING = "0.3.0" as Release;
const COMPATIBLE: ReleaseCompatibility = {
  schema_version: 1,
  base_generation: 1,
  base_generation_since: "0.0.0" as Release,
};

/** factory.json pinning `release`, as its text is written. */
function pinnedTo(release: string | undefined): FactoryInstance {
  return { ...declaring("builder-1"), release };
}
const textOf = (instance: FactoryInstance) => `${JSON.stringify(instance, null, 2)}\n`;

/** What happened, in order: lock writes, Terraform calls, factory.json writes. */
type Event = string;

/** A factory pinned to `pin`, its factory.json in a store, an approval and an event log. */
function upgrading(
  options: { pin?: string; answers?: boolean[]; hosts?: string[]; bucket?: boolean } = {},
) {
  const world = factory({
    hosts: options.hosts ?? ["builder-1"],
    ...(options.bucket === undefined ? {} : { bucket: options.bucket }),
  });
  const instance = pinnedTo("pin" in options ? options.pin : "0.2.0");
  const text = textOf(instance);
  const store = new MemoryInstanceStore({ [PATH]: text });
  const events: Event[] = [];
  const shown: PlanReview[] = [];
  const answers = [...(options.answers ?? [true])];
  let beforeAnswer: (() => void) | undefined;
  const approval: Approval = {
    approve: async (review) => {
      shown.push(review);
      beforeAnswer?.();
      return answers.shift() ?? false;
    },
  };
  const signal = { interrupted: false };
  const write = store.write.bind(store);
  store.write = async (path, contents) => {
    events.push(`write factory.json (locked: ${world.lockStore.locks.size > 0})`);
    await write(path, contents);
  };
  const applyPlan = world.terraform.provisioner.applyPlan;
  world.terraform.provisioner.applyPlan = async (request) => {
    events.push("terraform apply");
    return applyPlan(request);
  };
  const pinned: string[] = [];
  const deps = {
    ...world.deps,
    approval,
    interrupted: () => signal.interrupted,
    store,
    pinned: () => {
      pinned.push("pinned");
    },
  };
  let ticks = 0;
  const { now: _, ...base } = planRequest({ instance, instancePath: PATH });
  const request: UpgradeRequest = {
    ...base,
    release: RUNNING,
    text,
    compatibility: COMPATIBLE,
    host: "operator-laptop",
    clock: () => new Date(NOW.getTime() + 1000 * ticks++),
  };
  return {
    ...world,
    store,
    events,
    shown,
    signal,
    deps,
    request,
    pinned,
    setBeforeAnswer: (run: () => void) => {
      beforeAnswer = run;
    },
  };
}

const pinOf = (store: MemoryInstanceStore) => JSON.parse(store.files[PATH] ?? "{}").release;

function stages(record: OperationRecord | undefined) {
  return record?.stages.map(({ name, status }) => `${name}:${status}`).join(" ");
}

describe("fffactory upgrade (plan-apply §Upgrade)", () => {
  test("an empty factory moves its pin with nothing to install", async () => {
    const { deps, request, store, shown, terraform, lockStore } = upgrading({ hosts: [] });
    // Its shared infrastructure exists, as `worker terminate` leaves it after the last host.
    terraform.world.network = true;
    const instance: FactoryInstance = { ...pinnedTo("0.2.0"), hosts: [] };
    const text = textOf(instance);
    store.files[PATH] = text;
    const result = await upgradeFactory(deps, { ...request, instance, text });
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: true,
      apply: { kind: "applied", infrastructure: "unchanged", workers: [] },
    });
    expect(shown).toMatchObject([
      {
        kind: "factory",
        changes: [],
        workers: [],
        repositories: [],
        controlPlane: [],
        dispatch: [],
        pinMove: { from: "0.2.0", to: "0.3.0" },
      },
    ]);
    expect(JSON.parse(store.files[PATH] ?? "")).toEqual({ ...instance, release: "0.3.0" });
    expect(lockStore.locks.size).toBe(0);
  });

  test("shows the pin move with the plan made for the running release, writes the pin once approved under the lock, then applies", async () => {
    const { deps, request, store, events, shown, lockStore, pinned } = upgrading();
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({ kind: "upgrade", pinned: true, apply: { kind: "applied" } });
    // The pin move, and every stage of the plan made for the running release.
    const builder = { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" };
    expect(shown).toEqual([
      {
        kind: "factory",
        target: {
          instancePath: PATH,
          name: "Test factory",
          factoryId: FACTORY,
          accountId: "123456789012",
          region: "eu-west-2",
          release: RUNNING,
        },
        changes: [],
        workers: [builder],
        repositories: [{ ...builder, placed: [] }],
        controlPlane: [
          {
            ...builder,
            observation: "no-release",
            changes: ["paseo-package", "service-definition", "listen-address", "password"],
          },
        ],
        dispatch: [{ ...builder, requested: false, schedule: null }],
        stopped: [],
        pinMove: { from: "0.2.0" as Release, to: RUNNING },
      },
    ]);
    expect(pinOf(store)).toBe("0.3.0");
    // The rest of factory.json is unchanged: only the pin moved.
    expect(JSON.parse(store.files[PATH] ?? "")).toEqual(pinnedTo("0.3.0"));
    expect(events).toEqual(["write factory.json (locked: true)"]);
    expect(pinned).toEqual(["pinned"]);
    expect(lockStore.locks.size).toBe(0);
    const records = lockStore.operationWrites;
    expect(records[0]?.operation).toBe("upgrade");
    expect(records[0]?.release).toBe(RUNNING);
    expect(records.map(stages)).toEqual([
      "pin:pending infrastructure:planning",
      "pin:pending infrastructure:awaiting_approval",
      "pin:written infrastructure:awaiting_approval",
      "pin:written infrastructure:unchanged",
      "pin:written infrastructure:unchanged workers:installing",
      "pin:written infrastructure:unchanged workers:installing",
      "pin:written infrastructure:unchanged workers:installed",
      "pin:written infrastructure:unchanged workers:installed repositories:synchronizing",
      "pin:written infrastructure:unchanged workers:installed repositories:synchronizing",
      "pin:written infrastructure:unchanged workers:installed repositories:synchronized",
      "pin:written infrastructure:unchanged workers:installed repositories:synchronized",
    ]);
    expect(records.at(-1)?.status).toBe("succeeded");
  });

  test("with infrastructure changes, the pin is written before Terraform applies them", async () => {
    const { deps, request, events } = upgrading({ hosts: [] });
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({ kind: "upgrade", pinned: true, apply: { kind: "applied" } });
    expect(events).toEqual(["write factory.json (locked: true)", "terraform apply"]);
  });

  test("a missing log archive is created through the same infrastructure stage, after the pin", async () => {
    const { deps, request, store, events, shown, lockStore, terraform } = upgrading();
    const instance: FactoryInstance = { ...pinnedTo("0.2.0"), log_archive: { enabled: true } };
    const text = textOf(instance);
    store.files[PATH] = text;
    const result = await upgradeFactory(deps, { ...request, instance, text });
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: true,
      apply: { kind: "applied", infrastructure: "applied" },
    });
    expect(shown).toMatchObject([{ kind: "factory", archive: { bucket: ARCHIVE, creates: true } }]);
    expect(events).toEqual(["write factory.json (locked: true)", "terraform apply"]);
    expect(terraform.calls.filter(({ call }) => call === "applyPlan")).toMatchObject([
      { request: { configuration: { root: "archive" } } },
    ]);
    expect(lockStore.buckets.has(ARCHIVE)).toBe(true);
    expect(stages(lockStore.operationWrites.at(-1))).toContain("infrastructure:applied");
  });

  test("a log archive that appears during approval refuses the plan before the pin moves", async () => {
    const { deps, request, store, events, lockStore, pinned, setBeforeAnswer } = upgrading();
    const instance: FactoryInstance = { ...pinnedTo("0.2.0"), log_archive: { enabled: true } };
    const text = textOf(instance);
    store.files[PATH] = text;
    setBeforeAnswer(() => {
      lockStore.buckets.add(ARCHIVE);
    });
    const result = await upgradeFactory(deps, { ...request, instance, text });
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: false,
      apply: { kind: "stale", reasons: [{ kind: "archive_created" }] },
    });
    expect(store.files[PATH]).toBe(text);
    expect(store.writes).toEqual([]);
    expect(pinned).toEqual([]);
    expect(events).toEqual([]);
    expect(lockStore.locks.size).toBe(0);
    expect(stages(lockStore.operationWrites.at(-1))).toBe("pin:refused infrastructure:refused");
    expect(lockStore.operationWrites.at(-1)?.status).toBe("refused");
  });

  test.each([
    [
      "a log archive found present that disappears during approval is stale",
      (lockStore: MemoryLockStore) => lockStore.buckets.delete(ARCHIVE),
      { kind: "stale", reasons: [{ kind: "archive_missing" }] },
    ],
    [
      "a log archive found ready that loses a setting during approval is unready",
      (lockStore: MemoryLockStore) =>
        lockStore.archives.set(ARCHIVE, { ...READY_ARCHIVE, tlsOnly: false }),
      { kind: "unready_archive", bucket: { missing: ["tls_only_policy"] } },
    ],
  ])("%s: refused before the pin moves, applying nothing", async (_, change, apply) => {
    const { deps, request, store, events, lockStore, pinned, setBeforeAnswer } = upgrading({
      hosts: [],
    });
    lockStore.buckets.add(ARCHIVE);
    const instance: FactoryInstance = { ...pinnedTo("0.2.0"), log_archive: { enabled: true } };
    const text = textOf(instance);
    store.files[PATH] = text;
    setBeforeAnswer(() => {
      change(lockStore);
    });
    const result = await upgradeFactory(deps, { ...request, instance, text });
    expect(result).toMatchObject({ kind: "upgrade", pinned: false, apply });
    expect(store.files[PATH]).toBe(text);
    expect(store.writes).toEqual([]);
    expect(pinned).toEqual([]);
    expect(events).toEqual([]);
    expect(lockStore.locks.size).toBe(0);
    expect(stages(lockStore.operationWrites.at(-1))).toBe("pin:refused infrastructure:refused");
  });

  test("interrupted while the log archive is rechecked: the pin is not moved", async () => {
    const { deps, request, store, events, lockStore, pinned, signal, setBeforeAnswer } =
      upgrading();
    const instance: FactoryInstance = { ...pinnedTo("0.2.0"), log_archive: { enabled: true } };
    const text = textOf(instance);
    store.files[PATH] = text;
    setBeforeAnswer(() => {
      const bucketExists = lockStore.bucketExists.bind(lockStore);
      lockStore.bucketExists = async (bucket) => {
        signal.interrupted = true;
        return bucketExists(bucket);
      };
    });
    const result = await upgradeFactory(deps, { ...request, instance, text });
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: false,
      apply: { kind: "interrupted", locked: true },
    });
    expect(store.files[PATH]).toBe(text);
    expect(pinned).toEqual([]);
    expect(events).toEqual([]);
  });

  test("declined: the pin is not moved and nothing is applied", async () => {
    const { deps, request, store, events, lockStore } = upgrading({ answers: [false] });
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: false,
      apply: { kind: "declined", stage: "infrastructure" },
    });
    expect(pinOf(store)).toBe("0.2.0");
    expect(events).toEqual([]);
    expect(lockStore.locks.size).toBe(0);
    // The record ends with the pin stage ended too, not left pending.
    expect(stages(lockStore.operationWrites.at(-1))).toBe("pin:declined infrastructure:declined");
    expect(lockStore.operationWrites.at(-1)?.status).toBe("declined");
  });

  test("a factory without its state bucket yet is refused: nothing is bootstrapped, asked, locked or written", async () => {
    const { deps, request, store, events, lockStore, terraform, shown, pinned } = upgrading({
      bucket: false,
    });
    const planStore = deps.planStore as MemoryPlanStore;
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: false,
      apply: { kind: "no_state_bucket" },
    });
    expect(shown).toEqual([]);
    expect(terraform.calls).toEqual([]);
    expect(lockStore.buckets.size).toBe(0);
    expect(lockStore.locks.size).toBe(0);
    expect(lockStore.operationWrites).toEqual([]);
    expect(planStore.directories.size).toBe(0);
    expect(store.writes).toEqual([]);
    expect(events).toEqual([]);
    expect(pinned).toEqual([]);
    expect(pinOf(store)).toBe("0.2.0");
  });

  test("a planning refusal ends the pin stage refused, moving nothing", async () => {
    const { deps, request, store, events, lockStore, terraform } = upgrading();
    terraform.world.replace.add("builder-1");
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({ kind: "upgrade", pinned: false, apply: { kind: "d11" } });
    expect(stages(lockStore.operationWrites.at(-1))).toBe("pin:refused infrastructure:refused");
    expect(lockStore.operationWrites.at(-1)?.status).toBe("refused");
    expect(pinOf(store)).toBe("0.2.0");
    expect(events).toEqual([]);
  });

  test("a planning failure ends the pin stage failed, moving nothing", async () => {
    const { deps, request, store, events, lockStore, terraform } = upgrading();
    terraform.world.failNext = "plan";
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: false,
      apply: { kind: "failed", step: "planning" },
    });
    expect(stages(lockStore.operationWrites.at(-1))).toBe("pin:failed infrastructure:failed");
    expect(pinOf(store)).toBe("0.2.0");
    expect(events).toEqual([]);
  });

  test("factory.json changed after the plan was made: the pin is not moved and nothing is applied", async () => {
    const { deps, request, store, events, lockStore, setBeforeAnswer } = upgrading({
      hosts: [],
    });
    const edited = `${store.files[PATH]} `;
    setBeforeAnswer(() => {
      store.files[PATH] = edited;
    });
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: false,
      apply: { kind: "configuration_changed" },
    });
    expect(store.files[PATH]).toBe(edited);
    expect(events).toEqual([]);
    expect(lockStore.locks.size).toBe(0);
    expect(stages(lockStore.operationWrites.at(-1))).toBe(
      "pin:refused infrastructure:awaiting_approval",
    );
    expect(lockStore.operationWrites.at(-1)?.status).toBe("refused");
  });

  test("a failed apply leaves factory.json pinned to the new release, and a plain apply by it converges", async () => {
    const { deps, request, store, terraform, lockStore } = upgrading({
      hosts: [],
      answers: [true, true],
    });
    terraform.world.failNext = "applyPlan";
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: true,
      apply: { kind: "failed", step: "applying" },
    });
    expect(pinOf(store)).toBe("0.3.0");
    expect(lockStore.locks.size).toBe(0);
    // The pin now matches the running release, so `fffactory apply` by it is allowed.
    const { text: _, compatibility: __, ...base } = request;
    const rerun: FactoryApplyRequest = { ...base, instance: pinnedTo("0.3.0") };
    expect(await applyFactory(deps, rerun)).toMatchObject({ kind: "applied" });
    expect([...terraform.world.hosts]).toEqual(["builder-1"]);
  });

  test("a failure writing the pin applies nothing and leaves the pin", async () => {
    const { deps, request, store, events, lockStore } = upgrading({ hosts: [] });
    store.write = async () => {
      throw new Error("EACCES: permission denied");
    };
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: false,
      apply: { kind: "failed", step: "pinning", reason: "EACCES: permission denied" },
    });
    expect(pinOf(store)).toBe("0.2.0");
    expect(events).toEqual([]);
    expect(stages(lockStore.operationWrites.at(-1))).toBe(
      "pin:failed infrastructure:awaiting_approval",
    );
  });

  test("a failure after the pin was written, before anything is applied, reports the pin as moved", async () => {
    const { deps, request, store, events, lockStore } = upgrading({ hosts: [] });
    const write = lockStore.writeOperation.bind(lockStore);
    let failed = false;
    lockStore.writeOperation = async (bucket, record) => {
      const written = record.stages.some(
        ({ name, status }) => name === "pin" && status === "written",
      );
      if (written && !failed) {
        failed = true;
        throw new Error("S3 answered SlowDown");
      }
      return write(bucket, record);
    };
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: true,
      apply: { kind: "failed", step: "pinned", reason: "S3 answered SlowDown" },
    });
    expect(pinOf(store)).toBe("0.3.0");
    expect(events).toEqual(["write factory.json (locked: true)"]);
    // The pin moved: the failure is the infrastructure stage's, never the pin's.
    expect(stages(lockStore.operationWrites.at(-1))).toBe("pin:written infrastructure:failed");
    expect(lockStore.operationWrites.at(-1)?.status).toBe("failed");
  });

  test("interrupted after the pin is written: the lock and record stay, the pin is moved", async () => {
    const { deps, request, store, lockStore, signal, events } = upgrading({ hosts: [] });
    deps.pinned = () => {
      signal.interrupted = true;
    };
    const result = await upgradeFactory(deps, request);
    expect(result).toMatchObject({
      kind: "upgrade",
      pinned: true,
      apply: { kind: "interrupted", locked: true },
    });
    expect(pinOf(store)).toBe("0.3.0");
    expect(events).toEqual(["write factory.json (locked: true)"]);
    expect(lockStore.locks.size).toBe(1);
    // The lock an interrupted upgrade left names the upgrade, and breaks as any other.
    const held = lockStore.locks.get(BUCKET);
    expect(held?.record?.operation).toBe("upgrade");
  });

  describe("refusals before anything reaches AWS", () => {
    test.each([
      [
        "the running release's own pin: nothing to upgrade",
        "0.3.0",
        COMPATIBLE,
        { kind: "current" },
      ],
      ["a later pin: downgrade is not supported", "0.3.1", COMPATIBLE, { kind: "downgrade" }],
      ["no pin", undefined, COMPATIBLE, { kind: "unpinned" }],
      [
        "a release needing a newer base generation (D11)",
        "0.2.0",
        { ...COMPATIBLE, base_generation: 2, base_generation_since: "0.2.5" as Release },
        { kind: "d11", refusal: { capability: "base migration" } },
      ],
      [
        "a release changing the schema version (D11)",
        "0.2.0",
        { ...COMPATIBLE, schema_version: 2 },
        { kind: "d11", refusal: { capability: "schema migration" } },
      ],
    ] as const)("%s", async (_, pin, compatibility, expected) => {
      const { deps, request, store, lockStore, terraform, shown } = upgrading({ pin });
      const result = await upgradeFactory(deps, { ...request, compatibility });
      expect(result).toMatchObject(expected);
      expect(store.writes).toEqual([]);
      expect(lockStore.calls).toEqual([]);
      expect(terraform.calls).toEqual([]);
      expect(shown).toEqual([]);
    });
  });

  test("a lock an interrupted upgrade left is broken like any other, then the upgrade finishes with apply", async () => {
    const { deps, request, lockStore, signal } = upgrading({ hosts: [], answers: [true, true] });
    deps.pinned = () => {
      signal.interrupted = true;
    };
    await upgradeFactory(deps, request);
    signal.interrupted = false;
    const held = lockStore.locks.get(BUCKET);
    if (held === undefined) throw new Error("expected the lock");
    const broken = await breakFactoryLock(lockStore, {
      bucket: {
        factoryId: FACTORY,
        bucket: BUCKET,
        accountId: "123456789012",
        region: "eu-west-2",
        credentials: { source: "chain" },
      },
      held,
      confirmation: held.record?.lock_id ?? "",
      breaker: { principal: "arn:aws:iam::123456789012:user/op", host: "operator-laptop" },
      now: NOW,
      release: RUNNING,
    });
    expect(broken.kind).toBe("broken");
    const { text: _, compatibility: __, ...base } = request;
    const rerun = await applyFactory(deps, { ...base, instance: pinnedTo("0.3.0") });
    expect(rerun).toMatchObject({ kind: "applied", infrastructure: "applied" });
  });
});
