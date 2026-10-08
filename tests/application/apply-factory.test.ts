import { describe, expect, test } from "bun:test";
import { applyFactory, type FactoryApplyRequest } from "../../src/application/apply-factory";
import type { Approval } from "../../src/application/approval";
import { breakFactoryLock } from "../../src/application/factory-lock";
import { planFactory } from "../../src/application/plan-factory";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { Release } from "../../src/domain/instance";
import { pendingSteps, withStep } from "../../src/domain/installation";
import { type OperationRecord, operationKey } from "../../src/domain/operation";
import { PLAN_KEPT_MS, PLAN_TTL_MS, type SavedPlan } from "../../src/domain/plan";
import { FIRST_BOOT_POLL_MS } from "../../src/domain/rollout";
import {
  BUCKET,
  declaring,
  FACTORY,
  factory,
  NOW,
  fleetView,
  planRequest,
  TERRAFORM,
  workerFleet,
} from "../support/factory-world";
import { appliedRecord, installableWorker } from "../support/fake-workers";
import { hostAddress, NETWORK, STATE_BUCKET_ADDRESS } from "../support/fake-provisioner";

/** Approval that records every plan it is shown and answers from `answers` in turn. */
function approval(...answers: boolean[]) {
  const shown: (readonly string[])[] = [];
  const port: Approval = {
    approve: async (plan) => {
      shown.push(plan);
      return answers.shift() ?? false;
    },
  };
  return { port, shown };
}

/** A factory to apply: the world, an approval answering `answers`, and an interrupt switch. */
function applying(
  options: {
    bucket?: boolean;
    hosts?: string[];
    answers?: boolean[];
    workers?: ReturnType<typeof workerFleet>;
  } = {},
) {
  const world = factory(options);
  const approver = approval(...(options.answers ?? [true]));
  const signal = { interrupted: false };
  const deps = { ...world.deps, approval: approver.port, interrupted: () => signal.interrupted };
  return { ...world, approver, signal, deps };
}

let clockTicks = 0;
function applyRequest(overrides: Partial<FactoryApplyRequest> = {}): FactoryApplyRequest {
  const { now: _, ...base } = planRequest();
  return {
    ...base,
    host: "operator-laptop",
    clock: () => new Date(NOW.getTime() + 1000 * clockTicks++),
    ...overrides,
  };
}

const TARGET = { directory: TERRAFORM, root: "factory" };
const lockCalls = (calls: readonly string[]) =>
  calls.filter((call) => /^(create|remove) /.test(call));

/** An operation record write as its status, its stages and how many workers it records. */
function recordStep(record: OperationRecord) {
  return [
    record.status,
    record.stages.map(({ name, status }) => `${name}:${status}`).join(" "),
    record.workers.length,
  ];
}

describe("fffactory apply (plan-apply §Apply)", () => {
  test("plans under the lock, asks once for exactly that plan, applies it, then releases", async () => {
    const { deps, lockStore, terraform, approver, planStore } = applying({ hosts: ["builder-1"] });
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "builder-2") }),
    );
    expect(result).toMatchObject({
      kind: "applied",
      bootstrapped: false,
      infrastructure: "applied",
      recordFailure: undefined,
      operation: { bucket: BUCKET },
    });
    expect(result.kind === "applied" && result.workers.map((w) => `${w.key} ${w.kind}`)).toEqual([
      "builder-1 installed",
      "builder-2 installed",
    ]);
    expect(approver.shown).toEqual([
      [
        "Factory plan:",
        "  Configuration: /work/.fffactory/factory.json",
        "  Factory: Test factory (fff-abcd1234)",
        "  AWS account: 123456789012, Region: eu-west-2",
        "  Release: 0.3.0",
        "Infrastructure changes:",
        `  + ${hostAddress("builder-2")}`,
        "  1 to add, 0 to change, 0 to destroy.",
        "Worker changes, one worker at a time:",
        "  ~ builder-1 (fff-abcd1234-builder-1): install release 0.3.0 and its host configuration, then verify it",
        "  ~ builder-2 (fff-abcd1234-builder-2): install release 0.3.0 and its host configuration, then verify it",
        "Control-plane changes, before worker activation:",
        "  ~ builder-1 (fff-abcd1234-builder-1): paseo-package, service-definition, listen-address",
        "  ~ builder-2 (fff-abcd1234-builder-2): paseo-package, service-definition, listen-address",
        "Repository changes, one worker at a time:",
        "  ~ builder-1 (fff-abcd1234-builder-1): reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
        "  ~ builder-2 (fff-abcd1234-builder-2): reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
        "Dispatch changes, after every readiness gate:",
        "  ~ builder-1 (fff-abcd1234-builder-1): remove the factory dispatch schedule if it exists",
        "  ~ builder-2 (fff-abcd1234-builder-2): remove the factory dispatch schedule if it exists",
        "End-to-end verification: observe each worker's release, repositories, Paseo and actual dispatch schedule.",
      ],
    ]);
    const planned = terraform.calls.find(({ call }) => call === "plan")?.request;
    const applied = terraform.calls.find(({ call }) => call === "applyPlan")?.request;
    expect(applied?.configuration).toEqual(TARGET);
    // Planned under the factory lock, the plan keeps Terraform's own state lock too.
    expect(planned).toMatchObject({ stateLock: true });
    expect(applied && "planFile" in applied ? applied.planFile : "").toBe(
      planned && "planFile" in planned ? planned.planFile : "none",
    );
    expect([...terraform.world.hosts].sort()).toEqual(["builder-1", "builder-2"]);
    expect(lockStore.locks.size).toBe(0);
    expect(lockCalls(lockStore.calls)).toEqual([
      `create ${BUCKET} aaaaaaaa`,
      `remove ${BUCKET} version-1`,
    ]);
    expect(lockStore.operationWrites.map(recordStep)).toEqual([
      ["running", "infrastructure:planning", 0],
      ["running", "infrastructure:awaiting_approval", 0],
      ["running", "infrastructure:applying", 0],
      ["running", "infrastructure:applied", 0],
      ["running", "infrastructure:applied workers:installing", 0],
      ["running", "infrastructure:applied workers:installing", 1],
      ["running", "infrastructure:applied workers:installing", 2],
      ["running", "infrastructure:applied workers:installed", 2],
      ["running", "infrastructure:applied workers:installed repositories:synchronizing", 2],
      ["running", "infrastructure:applied workers:installed repositories:synchronizing", 2],
      ["running", "infrastructure:applied workers:installed repositories:synchronized", 2],
      ["succeeded", "infrastructure:applied workers:installed repositories:synchronized", 2],
    ]);
    expect(planStore.directories.size).toBe(0);
  });

  test("the workers stage runs after the infrastructure, under the same lock and record", async () => {
    const { deps, lockStore, fleet } = applying({ hosts: ["builder-1"] });
    await applyFactory(deps, applyRequest({ instance: declaring("builder-1", "builder-2") }));
    // Every worker was reached while the lock was held, after Terraform applied.
    expect(
      fleet.transport.calls.map(({ worker, command }) => [worker.hostname, command[0]]),
    ).toEqual([
      ["fff-abcd1234-builder-1", "/opt/fffactory/current/bin/fffactory"],
      ["fff-abcd1234-builder-1", "/opt/fffactory/current/bin/fffactory"],
      ["fff-abcd1234-builder-1", "dd"],
      ["fff-abcd1234-builder-1", "sudo"],
      ["fff-abcd1234-builder-2", "dd"],
      ["fff-abcd1234-builder-2", "sudo"],
      ["fff-abcd1234-builder-1", "sudo"],
      ["fff-abcd1234-builder-2", "sudo"],
    ]);
    expect(lockStore.operationWrites.at(-1)?.workers).toEqual([
      { key: "builder-1", hostname: "fff-abcd1234-builder-1", status: "installed", summary: null },
      { key: "builder-2", hostname: "fff-abcd1234-builder-2", status: "installed", summary: null },
    ]);
  });

  test("a failed install stops the rollout and fails the operation, which a rerun repairs", async () => {
    const failing = appliedRecord("fff-abcd1234-builder-1", "0.3.0", {
      state: "failed",
      steps: withStep(pendingSteps(), "harness", "failed", "exited with status 1"),
      verification: null,
    });
    const workers = workerFleet(undefined, {
      "fff-abcd1234-builder-1": installableWorker(failing),
    });
    const { deps, lockStore } = applying({ hosts: ["builder-1", "builder-2"], workers });
    const declared = declaring("builder-1", "builder-2");
    const result = await applyFactory(deps, applyRequest({ instance: declared }));
    expect(result).toMatchObject({ kind: "applied", infrastructure: "unchanged" });
    expect(result.kind === "applied" && result.workers.map((w) => w.kind)).toEqual([
      "failed",
      "not_attempted",
    ]);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "failed",
      failure:
        "worker builder-1: Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
      stages: [
        { name: "infrastructure", status: "unchanged" },
        { name: "workers", status: "failed" },
      ],
    });
    expect(lockStore.locks.size).toBe(0);

    const repaired = applying({ hosts: ["builder-1", "builder-2"] });
    const rerun = await applyFactory(repaired.deps, applyRequest({ instance: declared }));
    expect(rerun.kind === "applied" && rerun.workers.map((w) => w.kind)).toEqual([
      "installed",
      "installed",
    ]);
  });

  test("a skipped worker makes the operation partial; the others are installed", async () => {
    const workers = workerFleet(["builder-2"]);
    const { deps, lockStore } = applying({ hosts: ["builder-1", "builder-2"], workers });
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "builder-2") }),
    );
    expect(result.kind === "applied" && result.workers.map((w) => w.kind)).toEqual([
      "skipped",
      "installed",
    ]);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "partial",
      stages: [
        { name: "infrastructure", status: "unchanged" },
        { name: "workers", status: "partial" },
        { name: "repositories", status: "partial" },
      ],
    });
  });

  test("an interrupt during the workers stage keeps the lock and the record", async () => {
    const { deps, lockStore, signal } = applying({ hosts: ["builder-1", "builder-2"] });
    deps.progress = (event) => {
      if (event.kind === "installing") signal.interrupted = true;
    };
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "builder-2") }),
    );
    expect(result).toMatchObject({
      kind: "interrupted",
      locked: true,
      installing: { key: "builder-1", hostname: "fff-abcd1234-builder-1" },
    });
    expect(lockStore.locks.size).toBe(1);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "running",
      stages: [
        { name: "infrastructure", status: "unchanged" },
        { name: "workers", status: "installing" },
      ],
    });
  });

  test("waits for a worker it creates to finish its first boot, then installs and verifies it", async () => {
    // builder-2's machine is created by this apply; it joins the tailnet on the third look.
    const workers = workerFleet(["builder-1", "builder-2"], {}, (read) =>
      read < 5 ? fleetView("builder-1") : fleetView("builder-1", "builder-2"),
    );
    const { deps, lockStore } = applying({ hosts: ["builder-1"], workers });
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "builder-2") }),
    );
    expect(result.kind === "applied" && result.workers.map((w) => `${w.key} ${w.kind}`)).toEqual([
      "builder-1 installed",
      "builder-2 installed",
    ]);
    expect(workers.sleeps).toEqual([FIRST_BOOT_POLL_MS, FIRST_BOOT_POLL_MS]);
    expect(workers.progress.map(({ kind, key }) => `${kind} ${key}`)).toEqual([
      "uploading builder-1",
      "installing builder-1",
      "waiting builder-2",
      "uploading builder-2",
      "installing builder-2",
    ]);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "succeeded",
      stages: [
        { name: "infrastructure", status: "applied" },
        { name: "workers", status: "installed" },
        { name: "repositories", status: "synchronized" },
      ],
    });
    expect(lockStore.locks.size).toBe(0);
  });

  test("a provisioned worker missing from the tailnet is skipped without waiting", async () => {
    const workers = workerFleet([]);
    const { deps } = applying({ hosts: ["builder-1"], workers });
    const result = await applyFactory(deps, applyRequest());
    expect(result.kind === "applied" && result.workers.map((w) => w.kind)).toEqual(["skipped"]);
    expect(workers.sleeps).toEqual([]);
  });

  test("a new worker that never finishes its first boot fails the operation", async () => {
    const workers = workerFleet([]);
    const { deps, lockStore } = applying({ workers });
    const result = await applyFactory(deps, applyRequest());
    expect(result).toMatchObject({ kind: "applied", infrastructure: "applied" });
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "failed",
      failure: expect.stringMatching(
        /^worker builder-1: Its first boot did not finish within 15 min/,
      ),
      stages: [
        { name: "infrastructure", status: "applied" },
        { name: "workers", status: "failed" },
      ],
    });
    expect(lockStore.locks.size).toBe(0);
  });

  test("an interrupt while waiting for a first boot keeps the lock and the record", async () => {
    const workers = workerFleet([]);
    const { deps, lockStore, signal } = applying({ workers });
    workers.fleet.afterSleep = () => {
      signal.interrupted = true;
    };
    const result = await applyFactory(deps, applyRequest());
    expect(result).toMatchObject({
      kind: "interrupted",
      locked: true,
      installing: undefined,
      waiting: { key: "builder-1", hostname: "fff-abcd1234-builder-1" },
    });
    expect(workers.transport.calls).toEqual([]);
    expect(lockStore.locks.size).toBe(1);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "running",
      stages: [
        { name: "infrastructure", status: "applied" },
        { name: "workers", status: "installing" },
      ],
      workers: [],
    });
  });

  test("an unexpected error while installing fails the workers stage in the record", async () => {
    const { deps, lockStore } = applying({ hosts: ["builder-1"] });
    deps.transport = {
      run: async (_worker, command) => {
        if (command.at(-2) === "inspect")
          return { kind: "completed" as const, exitCode: 127, stdout: "" };
        throw new Error("the transport broke");
      },
    };
    const result = await applyFactory(deps, applyRequest());
    expect(result).toMatchObject({
      kind: "failed",
      step: "installing",
      reason: "the transport broke",
    });
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "failed",
      stages: [
        { name: "infrastructure", status: "unchanged" },
        { name: "workers", status: "failed" },
      ],
    });
    expect(lockStore.locks.size).toBe(0);
  });

  test("a tailscale.tag gone by the workers stage is an error, never a default", async () => {
    const { deps, fleet } = applying({ hosts: ["builder-1"] });
    const request = applyRequest();
    const approve = deps.approval.approve;
    deps.approval = {
      approve: async (plan) => {
        // Only a factory.json changed under the running apply could lose it.
        (request.instance as { tailscale?: unknown }).tailscale = {};
        return approve(plan);
      },
    };
    const result = await applyFactory(deps, request);
    expect(result).toMatchObject({
      kind: "failed",
      step: "installing",
      reason: "factory.json has no tailscale.tag, which every worker's device must carry",
    });
    expect(fleet.transport.calls).toHaveLength(1);
    expect(fleet.transport.calls[0]?.command).toEqual([
      "/opt/fffactory/current/bin/fffactory",
      "host",
      "inspect",
      "--json",
    ]);
  });

  test("the first apply bootstraps the backend with its own approval, then plans the factory", async () => {
    const { deps, lockStore, approver, terraform } = applying({
      bucket: false,
      answers: [true, true],
    });
    const result = await applyFactory(deps, applyRequest());
    expect(result).toMatchObject({ kind: "applied", bootstrapped: true });
    expect(approver.shown.map((plan) => plan.at(-1))).toEqual([
      `  + ${STATE_BUCKET_ADDRESS}`,
      "End-to-end verification: observe each worker's release, repositories, Paseo and actual dispatch schedule.",
    ]);
    expect(approver.shown[1]).toContain("  2 to add, 0 to change, 0 to destroy.");
    expect(
      terraform.calls.map(({ call, request }) => `${call} ${request.configuration.root}`),
    ).toEqual([
      "plan backend",
      "showPlan backend",
      "applyPlan backend",
      "output factory",
      "plan factory",
      "showPlan factory",
      "applyPlan factory",
    ]);
    expect(lockStore.buckets.has(BUCKET)).toBe(true);
    expect(terraform.world.hosts.has("builder-1")).toBe(true);
    expect(lockStore.locks.size).toBe(0);
  });

  test("declining backend bootstrap applies nothing and takes no lock", async () => {
    const { deps, lockStore, terraform } = applying({ bucket: false, answers: [false] });
    expect(await applyFactory(deps, applyRequest())).toEqual({
      kind: "declined",
      stage: "backend",
    });
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(lockStore.calls.some((call) => call.startsWith("create"))).toBe(false);
  });

  test("declining the factory plan applies nothing, records it, and releases the lock", async () => {
    const { deps, lockStore, terraform } = applying({ hosts: ["builder-1"], answers: [false] });
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "b") }),
    );
    expect(result).toEqual({ kind: "declined", stage: "infrastructure" });
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(lockStore.locks.size).toBe(0);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "declined",
      stages: [{ name: "infrastructure", status: "declined" }],
    });
  });

  test("without infrastructure changes the workers are still installed, after approval", async () => {
    const { deps, approver, lockStore, terraform } = applying({ hosts: ["builder-1"] });
    const result = await applyFactory(deps, applyRequest());
    expect(result).toMatchObject({ kind: "applied", infrastructure: "unchanged" });
    expect(approver.shown).toEqual([
      expect.arrayContaining([
        "Infrastructure: no changes.",
        "  ~ builder-1 (fff-abcd1234-builder-1): install release 0.3.0 and its host configuration, then verify it",
      ]),
    ]);
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "succeeded",
      stages: [
        { name: "infrastructure", status: "unchanged" },
        { name: "workers", status: "installed" },
        { name: "repositories", status: "synchronized" },
      ],
    });
    expect(lockStore.locks.size).toBe(0);
  });

  test("D11: a Terraform plan that replaces a host is refused before apply", async () => {
    const { deps, terraform, approver, lockStore } = applying({ hosts: ["builder-1"] });
    terraform.world.replace.add("builder-1");
    const result = await applyFactory(deps, applyRequest());
    expect(result).toMatchObject({
      kind: "d11",
      refusal: {
        capability: "host retirement and replacement",
        reasons: [`${hostAddress("builder-1")} would be replaced`],
      },
    });
    expect(approver.shown).toEqual([]);
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "refused" });
    expect(lockStore.locks.size).toBe(0);
  });

  test("D11: removing a provisioned host key is refused before Terraform plans", async () => {
    const { deps, terraform, lockStore } = applying({ hosts: ["builder-1", "builder-2"] });
    const result = await applyFactory(deps, applyRequest({ instance: declaring("builder-1") }));
    expect(result).toMatchObject({ kind: "d11", refusal: { capability: "host retirement" } });
    expect(terraform.calls.map(({ call }) => call)).toEqual(["output"]);
    expect(lockStore.locks.size).toBe(0);
  });

  test("the CLI/pin match guard refuses before any AWS call", async () => {
    const { deps, lockStore, terraform } = applying();
    const result = await applyFactory(deps, applyRequest({ release: "0.4.0" as Release }));
    expect(result).toMatchObject({ kind: "release_mismatch" });
    expect(lockStore.calls).toEqual([]);
    expect(terraform.calls).toEqual([]);
  });

  test("another operation holding the lock refuses the apply, showing its holder", async () => {
    const { deps, lockStore, terraform } = applying({ hosts: ["builder-1"] });
    const held = lockStore.hold(
      BUCKET,
      newLockRecord({
        factoryId: FACTORY,
        operation: "apply",
        holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
        now: NOW,
        release: "0.3.0" as Release,
        randomBytes: (count) => new Uint8Array(count).fill(5),
      }),
    );
    expect(await applyFactory(deps, applyRequest())).toEqual({ kind: "locked", held });
    expect(terraform.calls).toEqual([]);
    expect(lockStore.locks.get(BUCKET)).toBe(held);
  });

  test("a failing Terraform apply is recorded, releases the lock and says it may have changed things", async () => {
    const { deps, lockStore, terraform } = applying({ hosts: ["builder-1"] });
    terraform.world.failNext = "applyPlan";
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "b") }),
    );
    expect(result).toMatchObject({
      kind: "failed",
      step: "applying",
      reason: "`terraform apply` exited with status 1",
      recordFailure: undefined,
    });
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "failed",
      stages: [{ name: "infrastructure", status: "failed" }],
      failure: "`terraform apply` exited with status 1",
    });
    expect(lockStore.locks.size).toBe(0);
  });

  test("a failing Terraform plan fails before anything is applied", async () => {
    const { deps, lockStore, terraform, approver } = applying({ hosts: ["builder-1"] });
    terraform.world.failNext = "plan";
    const result = await applyFactory(deps, applyRequest());
    expect(result).toMatchObject({ kind: "failed", step: "planning" });
    expect(approver.shown).toEqual([]);
    expect(lockStore.locks.size).toBe(0);
  });

  test("a failed apply whose record cannot be finished still reports the failure", async () => {
    const { deps, lockStore, terraform } = applying({ hosts: ["builder-1"] });
    terraform.world.failNext = "applyPlan";
    const write = lockStore.writeOperation.bind(lockStore);
    lockStore.writeOperation = async (bucket, record) => {
      if (record.status === "failed")
        throw new Error("S3 PutObject on the state bucket failed: SlowDown");
      await write(bucket, record);
    };
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "b") }),
    );
    expect(result).toMatchObject({
      kind: "failed",
      step: "applying",
      reason: "`terraform apply` exited with status 1",
      operation: { bucket: BUCKET },
      recordFailure: "S3 PutObject on the state bucket failed: SlowDown",
    });
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "running" });
    expect(lockStore.locks.size).toBe(0);
  });

  test("an operation record that cannot be finished after applying is reported, not a failure", async () => {
    const { deps, lockStore } = applying({ hosts: ["builder-1"] });
    const write = lockStore.writeOperation.bind(lockStore);
    lockStore.writeOperation = async (bucket, record) => {
      if (record.status === "succeeded")
        throw new Error("S3 PutObject on the state bucket failed: SlowDown");
      await write(bucket, record);
    };
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "b") }),
    );
    expect(result).toMatchObject({
      kind: "applied",
      recordFailure: "S3 PutObject on the state bucket failed: SlowDown",
    });
    expect(lockStore.locks.size).toBe(0);
  });
});

describe("applying a saved plan (plan-apply §Saved plans)", () => {
  /** Plans with `fffactory plan`, then returns the saved plan and the world to apply it in. */
  async function planned(hosts: string[] = ["builder-1"], declared = ["builder-1", "builder-2"]) {
    const world = applying({ hosts, answers: [true] });
    const result = await planFactory(world.deps, planRequest({ instance: declaring(...declared) }));
    if (result.kind !== "planned" || result.saved === undefined) throw new Error("nothing saved");
    world.terraform.calls.length = 0;
    return { ...world, saved: result.saved };
  }

  function withPlan(saved: SavedPlan, overrides: Partial<FactoryApplyRequest> = {}) {
    return applyRequest({
      planId: saved.plan_id,
      instance: declaring("builder-1", "builder-2"),
      clock: () => new Date(NOW.getTime() + 60_000),
      ...overrides,
    });
  }

  test("applies exactly the saved plan, approved by its ID, without planning again", async () => {
    const { deps, saved, terraform, approver, planStore, lockStore } = await planned();
    const result = await applyFactory(deps, withPlan(saved));
    expect(result).toMatchObject({ kind: "applied" });
    // The plan file applied is read back first; nothing is planned again.
    expect(terraform.calls.map(({ call }) => call)).toEqual(["showPlan", "applyPlan"]);
    for (const { request } of terraform.calls)
      expect(request).toMatchObject({
        configuration: TARGET,
        planFile: `/plans/${FACTORY}/${saved.plan_id}/factory.tfplan`,
      });
    expect(approver.shown).toHaveLength(1);
    expect(approver.shown[0]).toContain(`  + ${hostAddress("builder-2")}`);
    expect(lockStore.operationWrites[0]?.plan_id).toBe(saved.plan_id);
    expect(planStore.saved.size).toBe(0);
    expect(terraform.world.hosts.has("builder-2")).toBe(true);
  });

  test("a plan applied after factory.json changes is refused before the lock", async () => {
    const { deps, saved, terraform, lockStore } = await planned();
    const result = await applyFactory(
      deps,
      withPlan(saved, { configurationSha256: "c".repeat(64) }),
    );
    expect(result).toEqual({
      kind: "stale",
      planId: saved.plan_id,
      reasons: ["factory.json changed after it was planned"],
    });
    expect(terraform.calls).toEqual([]);
    expect(lockStore.calls.some((call) => call.startsWith("create"))).toBe(false);
  });

  test("a plan made by another release, or with other assets, is refused", async () => {
    const { deps, saved } = await planned();
    const plan = { ...saved, release: "0.2.0" as Release };
    deps.planStore.saved.set(`${FACTORY}/${saved.plan_id}`, plan);
    expect(await applyFactory(deps, withPlan(saved))).toMatchObject({
      kind: "stale",
      reasons: ["it was planned by fffactory 0.2.0, not this release"],
    });
    deps.planStore.saved.set(`${FACTORY}/${saved.plan_id}`, saved);
    expect(
      await applyFactory(deps, withPlan(saved, { assetsSha256: "d".repeat(64) })),
    ).toMatchObject({
      kind: "stale",
      reasons: ["it was planned with other release assets than this fffactory's"],
    });
  });

  test("an expired plan is refused as expired, and pruned once long expired", async () => {
    const { deps, saved, lockStore } = await planned();
    const late = () => new Date(Date.parse(saved.expires_at) + 1);
    expect(await applyFactory(deps, withPlan(saved, { clock: late }))).toEqual({
      kind: "stale",
      planId: saved.plan_id,
      reasons: [`it expired at ${saved.expires_at}`],
    });
    expect(lockStore.calls.some((call) => call.startsWith("create"))).toBe(false);
    const later = () => new Date(Date.parse(saved.expires_at) + PLAN_KEPT_MS + 1);
    expect(await applyFactory(deps, withPlan(saved, { clock: later }))).toEqual({
      kind: "no_plan",
      planId: saved.plan_id,
    });
  });

  test("a plan whose Terraform state changed after planning is refused under the lock", async () => {
    const { deps, saved, lockStore, terraform } = await planned();
    lockStore.states.set(BUCKET, "revision-after-another-apply");
    const result = await applyFactory(deps, withPlan(saved));
    expect(result).toEqual({
      kind: "stale",
      planId: saved.plan_id,
      reasons: ["the factory's Terraform state changed after it was planned"],
    });
    expect(terraform.calls).toEqual([]);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "refused" });
    expect(lockStore.locks.size).toBe(0);
    expect(deps.planStore.saved.size).toBe(0);
  });

  test("a saved record that no longer shows what its Terraform plan does is refused", async () => {
    const { deps, saved, terraform, lockStore } = await planned();
    deps.planStore.saved.set(`${FACTORY}/${saved.plan_id}`, { ...saved, changes: [] });
    expect(await applyFactory(deps, withPlan(saved))).toEqual({
      kind: "damaged_plan",
      planId: saved.plan_id,
    });
    expect(terraform.calls.map(({ call }) => call)).toEqual(["showPlan"]);
    expect(lockStore.locks.size).toBe(0);
  });

  test("a saved Terraform plan file swapped after it was loaded is refused under the lock", async () => {
    const { deps, saved, terraform, lockStore, planStore } = await planned();
    const create = lockStore.create.bind(lockStore);
    lockStore.create = async (bucket, record) => {
      // Same record, same addresses and actions: only the file's digest tells it apart.
      planStore.swap(FACTORY, saved.plan_id);
      return create(bucket, record);
    };
    expect(await applyFactory(deps, withPlan(saved))).toEqual({
      kind: "damaged_plan",
      planId: saved.plan_id,
    });
    expect(terraform.calls).toEqual([]);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "refused" });
    expect(lockStore.locks.size).toBe(0);
    expect(planStore.saved.size).toBe(0);
  });

  test("a saved Terraform plan file swapped after it was read back is never applied", async () => {
    const { deps, saved, terraform, planStore } = await planned();
    const { showPlan } = terraform.provisioner;
    deps.provisioner = {
      ...terraform.provisioner,
      showPlan: async (request) => {
        const shown = await showPlan(request);
        planStore.swap(FACTORY, saved.plan_id);
        return shown;
      },
    };
    expect(await applyFactory(deps, withPlan(saved))).toEqual({
      kind: "damaged_plan",
      planId: saved.plan_id,
    });
    expect(terraform.calls.map(({ call }) => call)).toEqual(["showPlan"]);
  });

  test("a saved Terraform plan that cannot be read back is refused", async () => {
    const { deps, saved, terraform } = await planned();
    terraform.world.shown = { resource_changes: "garbled" };
    expect(await applyFactory(deps, withPlan(saved))).toMatchObject({ kind: "unexpected_plan" });
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
  });

  test("D11 is checked again on the saved Terraform plan that would be applied", async () => {
    const { deps, saved, terraform } = await planned();
    const replace = {
      address: hostAddress("builder-1"),
      type: "aws_instance",
      actions: ["delete", "create"],
    };
    terraform.world.shown = {
      resource_changes: [{ ...replace, change: { actions: replace.actions } }],
    };
    deps.planStore.saved.set(`${FACTORY}/${saved.plan_id}`, { ...saved, changes: [replace] });
    expect(await applyFactory(deps, withPlan(saved))).toMatchObject({ kind: "d11" });
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
  });

  test("an unknown plan ID, or a damaged saved plan, is refused", async () => {
    const { deps, saved } = await planned();
    expect(await applyFactory(deps, withPlan(saved, { planId: "zzzzzzzz" }))).toEqual({
      kind: "no_plan",
      planId: "zzzzzzzz",
    });
    deps.planStore.damage(FACTORY, saved.plan_id);
    expect(await applyFactory(deps, withPlan(saved))).toEqual({
      kind: "damaged_plan",
      planId: saved.plan_id,
    });
  });

  test("a saved plan never bootstraps: a vanished state bucket makes it stale", async () => {
    const { deps, saved, lockStore, terraform } = await planned();
    lockStore.buckets.delete(BUCKET);
    expect(await applyFactory(deps, withPlan(saved))).toEqual({
      kind: "stale",
      planId: saved.plan_id,
      reasons: ["the state bucket no longer exists"],
    });
    expect(terraform.calls).toEqual([]);
  });
});

describe("an interrupted apply (plan-apply §Interruption)", () => {
  test("leaves the lock and its record, and a rerun after a break converges", async () => {
    const { deps, lockStore, terraform, signal, approver } = applying({
      answers: [true, true, true],
    });
    const declared = declaring("builder-1", "builder-2");
    // Terraform is interrupted after creating the network and one host.
    terraform.world.beforeChange = (applied) => {
      if (applied < 2) return;
      signal.interrupted = true;
      throw new Error("`terraform apply` exited with status 1");
    };

    const first = await applyFactory(deps, applyRequest({ instance: declared }));

    expect(first).toMatchObject({ kind: "interrupted", locked: true, record: { bucket: BUCKET } });
    expect(terraform.world.network).toBe(true);
    expect([...terraform.world.hosts]).toEqual(["builder-1"]);
    const held = lockStore.locks.get(BUCKET);
    expect(held?.record?.operation).toBe("apply");
    const record = lockStore.operationWrites.at(-1);
    expect(record).toMatchObject({
      operation_id: held?.record?.lock_id,
      status: "running",
      stages: [{ name: "infrastructure", status: "applying" }],
      finished_at: null,
    });
    expect(lockStore.operations.get(operationKey(record as never))).toBe(record as never);

    // The process has exited; a new one runs, with its own lock ID. The lock refuses it
    // until it is broken.
    signal.interrupted = false;
    terraform.world.beforeChange = undefined;
    const again = applyRequest({
      instance: declared,
      randomBytes: (n) => new Uint8Array(n).fill(1),
    });
    expect(await applyFactory(deps, again)).toMatchObject({ kind: "locked", held });
    const broken = await breakFactoryLock(lockStore, {
      bucket: {
        factoryId: FACTORY,
        bucket: BUCKET,
        accountId: "123456789012",
        region: "eu-west-2",
        credentials: { source: "chain" },
      },
      held: held as NonNullable<typeof held>,
      confirmation: held?.record?.lock_id ?? "",
      breaker: { principal: "arn:aws:iam::123456789012:user/op", host: "operator-laptop" },
      now: NOW,
      release: "0.3.0" as Release,
    });
    expect(broken.kind).toBe("broken");

    const rerun = await applyFactory(
      deps,
      applyRequest({ instance: declared, randomBytes: (n) => new Uint8Array(n).fill(2) }),
    );

    expect(rerun).toMatchObject({ kind: "applied" });
    // The rerun planned from what the interrupted apply left: only the missing host.
    expect(approver.shown.at(-1)).toEqual(
      expect.arrayContaining([
        `  + ${hostAddress("builder-2")}`,
        "  1 to add, 0 to change, 0 to destroy.",
      ]),
    );
    expect(approver.shown.at(-1)).not.toContain(`  + ${NETWORK}`);
    expect([...terraform.world.hosts].sort()).toEqual(["builder-1", "builder-2"]);
    expect(lockStore.locks.size).toBe(0);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "succeeded" });
    // Converged: a third apply changes no infrastructure and reinstalls the workers.
    expect(await applyFactory(deps, applyRequest({ instance: declared }))).toMatchObject({
      kind: "applied",
      infrastructure: "unchanged",
    });
  });

  test("a Terraform that finishes after the interrupt still records nothing more", async () => {
    const { deps, lockStore, terraform, signal } = applying({ hosts: ["builder-1"] });
    terraform.world.beforeChange = () => {
      signal.interrupted = true;
    };
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "b") }),
    );
    expect(result).toMatchObject({ kind: "interrupted", locked: true, record: { bucket: BUCKET } });
    expect(lockStore.locks.size).toBe(1);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "running",
      stages: [{ name: "infrastructure", status: "applying" }],
    });
  });

  test("an interrupt at approval changes nothing and leaves the lock", async () => {
    const { deps, lockStore, terraform, signal } = applying({ hosts: ["builder-1"] });
    deps.approval = {
      approve: async () => {
        signal.interrupted = true;
        return true;
      },
    };
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "b") }),
    );
    expect(result).toMatchObject({ kind: "interrupted", locked: true, record: { bucket: BUCKET } });
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(lockStore.locks.size).toBe(1);
    expect(lockStore.operationWrites.at(-1)?.stages[0]?.status).toBe("awaiting_approval");
  });

  test("an interrupt at a declined approval leaves the lock, not a decline", async () => {
    const { deps, lockStore, terraform, signal } = applying({ hosts: ["builder-1"] });
    deps.approval = {
      approve: async () => {
        signal.interrupted = true;
        return false;
      },
    };
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "b") }),
    );
    expect(result).toEqual({
      kind: "interrupted",
      locked: true,
      record: { bucket: BUCKET, key: expect.any(String) },
    });
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(lockStore.locks.size).toBe(1);
    expect(lockStore.operationWrites.at(-1)?.stages[0]?.status).toBe("awaiting_approval");
  });

  test.each([
    ["changes nothing", [] as string[], "unchanged"],
    ["is refused (D11)", ["builder-1"], "refused"],
  ])(
    "an interrupt while Terraform reads back a plan that %s writes no more of the record",
    async (_, replaced) => {
      const { deps, lockStore, terraform, signal } = applying({ hosts: ["builder-1"] });
      for (const key of replaced) terraform.world.replace.add(key);
      const { showPlan } = terraform.provisioner;
      deps.provisioner = {
        ...terraform.provisioner,
        showPlan: async (request) => {
          const shown = await showPlan(request);
          signal.interrupted = true;
          return shown;
        },
      };
      const result = await applyFactory(deps, applyRequest());
      expect(result).toMatchObject({
        kind: "interrupted",
        locked: true,
        record: { bucket: BUCKET },
      });
      expect(lockStore.locks.size).toBe(1);
      expect(
        lockStore.operationWrites.map(({ status, stages }) => [status, stages[0]?.status]),
      ).toEqual([["running", "planning"]]);
    },
  );

  test("an interrupt once the record is written starts no Terraform", async () => {
    const { deps, lockStore, terraform, signal } = applying({ hosts: ["builder-1"] });
    const write = lockStore.writeOperation.bind(lockStore);
    lockStore.writeOperation = async (bucket, record) => {
      await write(bucket, record);
      signal.interrupted = true;
    };
    const result = await applyFactory(deps, applyRequest());
    expect(result).toMatchObject({ kind: "interrupted", locked: true, record: { bucket: BUCKET } });
    expect(terraform.calls).toEqual([]);
    expect(lockStore.operationWrites).toHaveLength(1);
  });

  test("an interrupt while the lock is being taken leaves it and starts nothing", async () => {
    const { deps, lockStore, terraform, signal } = applying({ hosts: ["builder-1"] });
    const create = lockStore.create.bind(lockStore);
    lockStore.create = async (bucket, record) => {
      signal.interrupted = true;
      return create(bucket, record);
    };
    // The lock is held, but no record of the operation was written.
    expect(await applyFactory(deps, applyRequest())).toEqual({
      kind: "interrupted",
      locked: true,
      record: undefined,
    });
    expect(lockStore.locks.size).toBe(1);
    expect(lockStore.operationWrites).toEqual([]);
    expect(terraform.calls).toEqual([]);
  });

  test("an interrupt before the lock is taken leaves the factory unlocked", async () => {
    const { deps, lockStore, signal } = applying({ bucket: false });
    deps.approval = {
      approve: async () => {
        signal.interrupted = true;
        return true;
      },
    };
    expect(await applyFactory(deps, applyRequest())).toEqual({
      kind: "interrupted",
      locked: false,
    });
    expect(lockStore.locks.size).toBe(0);
    expect(lockStore.operationWrites).toEqual([]);
  });

  test("plans long expired are pruned at the start of every apply", async () => {
    const { deps, planStore } = applying({ hosts: ["builder-1"] });
    await planFactory(deps, planRequest({ instance: declaring("builder-1", "b") }));
    expect(planStore.saved.size).toBe(1);
    await applyFactory(
      deps,
      applyRequest({ clock: () => new Date(NOW.getTime() + PLAN_TTL_MS + PLAN_KEPT_MS + 1) }),
    );
    expect(planStore.saved.size).toBe(0);
  });
});
