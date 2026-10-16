import { describe, expect, test } from "bun:test";
import { applyFactory, type FactoryApplyRequest } from "../../src/application/apply-factory";
import type { Approval } from "../../src/application/approval";
import { planBackendBootstrap } from "../../src/application/bootstrap-backend";
import { breakFactoryLock } from "../../src/application/factory-lock";
import { planFactory } from "../../src/application/plan-factory";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { HostKey, Release } from "../../src/domain/instance";
import { pendingSteps, withStep } from "../../src/domain/installation";
import { type OperationRecord, operationKey } from "../../src/domain/operation";
import {
  newSavedBootstrapPlan,
  PLAN_KEPT_MS,
  PLAN_TTL_MS,
  type SavedPlan,
} from "../../src/domain/plan";
import { FIRST_BOOT_POLL_MS } from "../../src/domain/rollout";
import {
  ACCOUNT,
  ASSETS_SHA256,
  BUCKET,
  declaring,
  FACTORY,
  factory,
  NOW,
  fleetView,
  planRequest,
  RELEASE,
  TERRAFORM,
  workerFleet,
} from "../support/factory-world";
import { appliedRecord, installableWorker, machine } from "../support/fake-workers";
import { hostAddress, NETWORK, STATE_BUCKET_ADDRESS } from "../support/fake-provisioner";
import { READY_BUCKET } from "../support/memory-lock-store";

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
        capability: "host replacement",
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
    expect(result).toMatchObject({ kind: "d11", refusal: { capability: "host removal" } });
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

describe("a stopped worker (plan-apply §Stopped workers)", () => {
  const STOPPED_B2 = {
    kind: "machines" as const,
    machines: [
      machine("builder-1", "running", "i-0000000000000000a"),
      machine("builder-2", "stopped", "i-0000000000000000b"),
    ],
  };

  test("is shown skipped in the plan, sent nothing, and leaves the operation succeeded", async () => {
    const workers = workerFleet(["builder-1"]);
    workers.machines.inventory = STOPPED_B2;
    const { deps, lockStore, approver } = applying({ hosts: ["builder-1", "builder-2"], workers });
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "builder-2") }),
    );
    expect(approver.shown[0]).toContain(
      "  = builder-2 (fff-abcd1234-builder-2): skipped: stopped; start it with `fffactory worker start builder-2`, then apply again to install it",
    );
    expect(result.kind === "applied" && result.workers.map((w) => w.kind)).toEqual([
      "installed",
      "stopped",
    ]);
    expect(
      workers.transport.calls.some(({ worker }) => worker.hostname.endsWith("builder-2")),
    ).toBe(false);
    // Read once, under the lock: the plan and every stage go by it.
    expect(workers.machines.reads).toBe(1);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({
      status: "succeeded",
      stages: [
        { name: "infrastructure", status: "unchanged" },
        { name: "workers", status: "installed" },
        { name: "repositories", status: "synchronized" },
      ],
      workers: [
        { key: "builder-1", status: "installed", summary: null },
        { key: "builder-2", status: "stopped", summary: "Stopped: nothing was sent to it" },
      ],
      repositories: [
        { key: "builder-1", status: "synchronized" },
        { key: "builder-2", status: "stopped", summary: null },
      ],
    });
  });

  test("with an EC2 inventory it cannot read, a stopped worker is skipped by the tailnet, as before", async () => {
    const workers = workerFleet(["builder-1"]);
    workers.machines.inventory = { kind: "unavailable", reason: "EC2 DescribeInstances failed: x" };
    const { deps, lockStore } = applying({ hosts: ["builder-1", "builder-2"], workers });
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "builder-2") }),
    );
    expect(result.kind === "applied" && result.workers.map((w) => w.kind)).toEqual([
      "installed",
      "skipped",
    ]);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "partial" });
  });

  test("an instance type change on a stopped worker is refused under the lock, before approval", async () => {
    const workers = workerFleet(["builder-1"]);
    workers.machines.inventory = STOPPED_B2;
    const { deps, lockStore, approver, terraform } = applying({
      hosts: ["builder-1", "builder-2"],
      workers,
    });
    terraform.world.resize.add("builder-2");
    const result = await applyFactory(
      deps,
      applyRequest({ instance: declaring("builder-1", "builder-2") }),
    );
    expect(result).toEqual({
      kind: "stopped_resize",
      inventory: "read",
      workers: [
        { key: "builder-2" as HostKey, hostname: "fff-abcd1234-builder-2", machine: "stopped" },
      ],
    });
    expect(approver.shown).toEqual([]);
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "refused" });
    expect(lockStore.locks.size).toBe(0);
  });

  test("with the EC2 inventory unreadable, any instance type change is refused, failing closed", async () => {
    const workers = workerFleet(["builder-1", "builder-2"]);
    workers.machines.inventory = { kind: "unavailable", reason: "EC2 DescribeInstances failed: x" };
    const { deps, approver, terraform } = applying({ hosts: ["builder-1", "builder-2"], workers });
    terraform.world.resize.add("builder-2");
    expect(
      await applyFactory(deps, applyRequest({ instance: declaring("builder-1", "builder-2") })),
    ).toEqual({
      kind: "stopped_resize",
      inventory: "unreadable",
      workers: [{ key: "builder-2" as HostKey, hostname: "fff-abcd1234-builder-2" }],
    });
    expect(approver.shown).toEqual([]);
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
  });

  /** A saved plan of builder-1 and builder-2, made while `stopped` were stopped. */
  async function plannedWhile(stopped: string[]) {
    const workers = workerFleet(["builder-1", "builder-2"]);
    const machines = (states: string[]) => ({
      kind: "machines" as const,
      machines: ["builder-1", "builder-2"].map((key) =>
        machine(key, states.includes(key) ? "stopped" : "running"),
      ),
    });
    workers.machines.inventory = machines(stopped);
    const world = applying({ hosts: ["builder-1", "builder-2"], workers });
    const planned = await planFactory(
      world.deps,
      planRequest({ instance: declaring("builder-1", "builder-2") }),
    );
    if (planned.kind !== "planned") throw new Error(`expected planned, got ${planned.kind}`);
    const apply = () =>
      applyFactory(
        world.deps,
        applyRequest({
          planId: planned.saved.plan_id,
          instance: declaring("builder-1", "builder-2"),
          clock: () => new Date(NOW.getTime() + 60_000),
        }),
      );
    return { ...world, workers, saved: planned.saved, machines, apply };
  }

  test("a saved plan skips the workers it planned as stopped", async () => {
    const { saved, apply, approver, workers } = await plannedWhile(["builder-2"]);
    expect(saved.stopped_workers).toEqual(["builder-2" as HostKey]);
    workers.transport.calls.length = 0;
    const result = await apply();
    expect(approver.shown[0]).toContain(
      "  = builder-2 (fff-abcd1234-builder-2): skipped: stopped; start it with `fffactory worker start builder-2`, then apply again to install it",
    );
    expect(result.kind === "applied" && result.workers.map((w) => `${w.key} ${w.kind}`)).toEqual([
      "builder-1 installed",
      "builder-2 stopped",
    ]);
    expect(
      workers.transport.calls.some(({ worker }) => worker.hostname.endsWith("builder-2")),
    ).toBe(false);
  });

  test("a saved plan is stale once a worker was started or stopped after it was made", async () => {
    const started = await plannedWhile(["builder-2"]);
    // `fffactory worker start builder-2`, between the plan and its apply.
    started.workers.machines.inventory = started.machines([]);
    expect(await started.apply()).toEqual({
      kind: "stale",
      planId: started.saved.plan_id,
      reasons: ["worker builder-2 was stopped when it was planned, and is not now"],
    });
    expect(started.terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(started.lockStore.operationWrites.at(-1)).toMatchObject({ status: "refused" });

    const stopped = await plannedWhile([]);
    stopped.workers.machines.inventory = stopped.machines(["builder-1"]);
    expect(await stopped.apply()).toMatchObject({
      kind: "stale",
      reasons: ["worker builder-1 is stopped now, and was not when it was planned"],
    });

    const unknown = await plannedWhile(["builder-2"]);
    unknown.workers.machines.inventory = { kind: "unavailable", reason: "x" };
    expect(await unknown.apply()).toMatchObject({
      kind: "stale",
      reasons: [
        "the EC2 inventory could not be read to check that worker builder-2 is still stopped",
      ],
    });
  });

  test("the resize refusal is checked again on the saved Terraform plan that would be applied", async () => {
    const { saved, apply, terraform, planStore } = await plannedWhile(["builder-2"]);
    const update = { address: hostAddress("builder-2"), type: "aws_instance", actions: ["update"] };
    terraform.world.shown = {
      resource_changes: [
        {
          ...update,
          change: {
            actions: update.actions,
            before: { instance_type: "m7i.large" },
            after: { instance_type: "m7i.xlarge" },
          },
        },
      ],
    };
    planStore.saved.set(`${FACTORY}/${saved.plan_id}`, { ...saved, changes: [update] });
    expect(await apply()).toMatchObject({ kind: "stopped_resize" });
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
  });

  /** A saved plan, made while every worker ran, that changes builder-2's instance type. */
  async function resizingWhileRunning() {
    const planned = await plannedWhile([]);
    planned.terraform.world.resize.add("builder-2");
    const replanned = await planFactory(
      planned.deps,
      planRequest({
        instance: declaring("builder-1", "builder-2"),
        randomBytes: (n) => new Uint8Array(n).fill(1),
      }),
    );
    if (replanned.kind !== "planned") throw new Error(`expected planned, got ${replanned.kind}`);
    expect(replanned.saved.stopped_workers).toEqual([]);
    const apply = () =>
      applyFactory(
        planned.deps,
        applyRequest({
          planId: replanned.saved.plan_id,
          instance: declaring("builder-1", "builder-2"),
          clock: () => new Date(NOW.getTime() + 60_000),
        }),
      );
    return { ...planned, apply };
  }

  test("a saved resize is refused once its worker is stopping, which Terraform would start", async () => {
    const { apply, workers, terraform } = await resizingWhileRunning();
    workers.machines.inventory = {
      kind: "machines",
      machines: [machine("builder-1", "running"), machine("builder-2", "stopping")],
    };
    expect(await apply()).toMatchObject({
      kind: "stopped_resize",
      inventory: "read",
      workers: [{ key: "builder-2" as HostKey, machine: "stopping" }],
    });
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
  });

  test("a saved resize is refused when the EC2 inventory cannot be read at apply", async () => {
    // A worker may have been stopped since: the plan skips none, so it is not stale.
    const { apply, workers, terraform, lockStore } = await resizingWhileRunning();
    workers.machines.inventory = { kind: "unavailable", reason: "EC2 DescribeInstances failed: x" };
    expect(await apply()).toEqual({
      kind: "stopped_resize",
      inventory: "unreadable",
      workers: [{ key: "builder-2" as HostKey, hostname: "fff-abcd1234-builder-2" }],
    });
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(lockStore.operationWrites.at(-1)).toMatchObject({ status: "refused" });
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

describe("applying a saved bootstrap plan (plan-apply §Apply)", () => {
  const PLAN_ID = "b00tstr4";

  /**
   * A factory without its state bucket and a saved bootstrap plan B, its `backend.tfplan`
   * planned in the world, as `fffactory plan` saves one.
   */
  async function bootstrapPlanned() {
    const world = applying({ bucket: false });
    const files = await world.planStore.create(FACTORY, PLAN_ID);
    const planning = await planBackendBootstrap(world.terraform.provisioner, {
      instancePath: "/work/.fffactory/factory.json",
      instance: declaring("builder-1"),
      bucket: {
        factoryId: FACTORY,
        bucket: BUCKET,
        accountId: ACCOUNT.verdict.caller.account,
        region: "eu-west-2",
        credentials: { source: "--profile", profile: "factory" },
      },
      variables: {
        factory_id: FACTORY,
        account_id: ACCOUNT.verdict.caller.account,
        region: "eu-west-2",
        state_bucket_suffix: "state",
      },
      release: RELEASE,
      terraformDirectory: TERRAFORM,
      planFile: files.backend,
    });
    if (planning.kind !== "planned") throw new Error("not planned");
    const saved = newSavedBootstrapPlan({
      planId: PLAN_ID,
      factoryId: FACTORY,
      instancePath: "/work/.fffactory/factory.json",
      configurationSha256: "a".repeat(64),
      release: RELEASE,
      assetsSha256: ASSETS_SHA256,
      accountId: ACCOUNT.verdict.caller.account,
      now: NOW,
      changes: [{ address: STATE_BUCKET_ADDRESS, actions: ["create"] }],
    });
    await world.planStore.save(saved);
    world.terraform.calls.length = 0;
    world.planStore.calls.length = 0;
    return { ...world, saved };
  }

  const withBootstrapPlan = (overrides: Partial<FactoryApplyRequest> = {}) =>
    applyRequest({
      planId: PLAN_ID,
      clock: () => new Date(NOW.getTime() + 60_000),
      ...overrides,
    });

  /** Nothing was applied, locked or recorded, and B is kept. */
  function nothingChanged(world: Awaited<ReturnType<typeof bootstrapPlanned>>) {
    expect(world.terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
    expect(world.lockStore.buckets.has(BUCKET)).toBe(false);
    expect(world.lockStore.calls.some((call) => call.startsWith("create"))).toBe(false);
    expect(world.lockStore.operationWrites).toEqual([]);
    expect(world.planStore.saved.has(`${FACTORY}/${PLAN_ID}`)).toBe(true);
  }

  test("creates the bucket from exactly B's file, then locks, records B, releases and stops", async () => {
    const world = await bootstrapPlanned();
    const { deps, lockStore, terraform, approver, planStore } = world;
    const order: string[] = [];
    const { applyPlan } = terraform.provisioner;
    deps.provisioner = {
      ...terraform.provisioner,
      applyPlan: async (planned) => {
        order.push(`applyPlan ${planned.configuration.root}`);
        await applyPlan(planned);
      },
    };
    const create = lockStore.create.bind(lockStore);
    lockStore.create = async (bucket, record) => {
      order.push("lock");
      return create(bucket, record);
    };
    const writeOperation = lockStore.writeOperation.bind(lockStore);
    lockStore.writeOperation = async (bucket, record) => {
      order.push(`record ${record.status}`);
      return writeOperation(bucket, record);
    };
    const remove = lockStore.remove.bind(lockStore);
    lockStore.remove = async (bucket, version) => {
      order.push("release");
      return remove(bucket, version);
    };

    const result = await applyFactory(deps, withBootstrapPlan());

    expect(result).toEqual({
      kind: "bootstrapped",
      planId: PLAN_ID,
      operation: { bucket: BUCKET, key: expect.stringMatching(/^fff-abcd1234-operations\//) },
      recordFailure: undefined,
    });
    expect(order).toEqual(["applyPlan backend", "lock", "record succeeded", "release"]);
    // Exactly B's file is read back and applied: nothing is planned, and never the factory.
    const planFile = (request: object) => ("planFile" in request ? request.planFile : "none");
    expect(terraform.calls.map(({ call, request }) => `${call} ${planFile(request)}`)).toEqual([
      `showPlan /plans/${FACTORY}/${PLAN_ID}/backend.tfplan`,
      `applyPlan /plans/${FACTORY}/${PLAN_ID}/backend.tfplan`,
    ]);
    expect(approver.shown).toHaveLength(1);
    expect(approver.shown[0]?.at(-1)).toBe(`  + ${STATE_BUCKET_ADDRESS}`);
    expect(lockStore.buckets.has(BUCKET)).toBe(true);
    expect(lockStore.locks.size).toBe(0);
    expect(lockStore.operationWrites).toHaveLength(1);
    expect(lockStore.operationWrites[0]).toMatchObject({
      plan_id: PLAN_ID,
      operation: "apply",
      status: "succeeded",
      stages: [{ name: "backend", status: "applied" }],
      failure: null,
    });
    expect(planStore.saved.size).toBe(0);
    expect(planStore.directories.size).toBe(0);
  });

  test("B is spent once applied: a rerun names it missing", async () => {
    const { deps } = await bootstrapPlanned();
    expect(await applyFactory(deps, withBootstrapPlan())).toMatchObject({ kind: "bootstrapped" });
    expect(await applyFactory(deps, withBootstrapPlan())).toEqual({
      kind: "no_plan",
      planId: PLAN_ID,
    });
  });

  test("factory.json changed after B is refused as stale before anything reaches AWS", async () => {
    const world = await bootstrapPlanned();
    const result = await applyFactory(
      world.deps,
      withBootstrapPlan({ configurationSha256: "c".repeat(64) }),
    );
    expect(result).toEqual({
      kind: "stale",
      planId: PLAN_ID,
      reasons: ["factory.json changed after it was planned"],
    });
    expect(world.terraform.calls).toEqual([]);
    expect(world.lockStore.calls).toEqual([]);
    expect(world.approver.shown).toEqual([]);
    nothingChanged(world);
  });

  test.each([
    [
      "another release",
      { release: "0.3.1" as Release },
      "it was planned by fffactory 0.3.0, not this release",
    ],
    [
      "other assets",
      { assetsSha256: "d".repeat(64) },
      "it was planned with other release assets than this fffactory's",
    ],
    [
      "another factory.json",
      { instancePath: "/elsewhere/factory.json" },
      "it was planned for another factory.json, /work/.fffactory/factory.json",
    ],
    [
      "its expiry",
      { clock: () => new Date(NOW.getTime() + PLAN_TTL_MS + 1) },
      `it expired at ${new Date(NOW.getTime() + PLAN_TTL_MS).toISOString()}`,
    ],
  ])("B stale by %s is refused with nothing changed", async (_, overrides, reason) => {
    const world = await bootstrapPlanned();
    const instance =
      "release" in overrides ? { ...declaring("builder-1"), release: "0.3.1" } : undefined;
    const result = await applyFactory(
      world.deps,
      withBootstrapPlan({ ...overrides, ...(instance === undefined ? {} : { instance }) }),
    );
    expect(result).toEqual({ kind: "stale", planId: PLAN_ID, reasons: [reason] });
    expect(world.terraform.calls).toEqual([]);
    nothingChanged(world);
  });

  test.each([
    ["ready", undefined],
    ["unready", { versioning: undefined }],
  ])("a state bucket that exists now, %s, makes B stale", async (_, lacking) => {
    const world = await bootstrapPlanned();
    world.lockStore.buckets.add(BUCKET);
    if (lacking !== undefined)
      world.lockStore.readiness.set(BUCKET, { ...READY_BUCKET, ...lacking });
    expect(await applyFactory(world.deps, withBootstrapPlan())).toEqual({
      kind: "stale",
      planId: PLAN_ID,
      reasons: ["the state bucket was created after it was planned"],
    });
    expect(world.terraform.calls).toEqual([]);
    expect(world.lockStore.calls.some((call) => call.startsWith("create"))).toBe(false);
    expect(world.lockStore.operationWrites).toEqual([]);
    expect(world.planStore.saved.has(`${FACTORY}/${PLAN_ID}`)).toBe(true);
  });

  test("a tampered backend.tfplan is refused as damaged with nothing changed", async () => {
    const world = await bootstrapPlanned();
    world.planStore.damage(FACTORY, PLAN_ID);
    expect(await applyFactory(world.deps, withBootstrapPlan())).toEqual({
      kind: "damaged_plan",
      planId: PLAN_ID,
    });
    expect(world.terraform.calls).toEqual([]);
    nothingChanged(world);
  });

  test("a read-back that differs from B's record is damaged; nothing is applied", async () => {
    const world = await bootstrapPlanned();
    world.planStore.saved.set(`${FACTORY}/${PLAN_ID}`, {
      ...world.saved,
      changes: [
        { address: STATE_BUCKET_ADDRESS, actions: ["create"] },
        { address: "module.state_bucket.aws_s3_bucket_versioning.state", actions: ["create"] },
      ],
    });
    expect(await applyFactory(world.deps, withBootstrapPlan())).toEqual({
      kind: "damaged_plan",
      planId: PLAN_ID,
    });
    expect(world.terraform.calls.map(({ call }) => call)).toEqual(["showPlan"]);
    nothingChanged(world);
  });

  test("a read-back that does more than create is an unexpected plan; nothing is applied", async () => {
    const world = await bootstrapPlanned();
    world.terraform.world.shown = {
      resource_changes: [
        { address: STATE_BUCKET_ADDRESS, change: { actions: ["delete", "create"] } },
      ],
    };
    expect(await applyFactory(world.deps, withBootstrapPlan())).toEqual({
      kind: "unexpected_plan",
      unexpected: [`${STATE_BUCKET_ADDRESS} (delete, create)`],
    });
    expect(world.approver.shown).toEqual([]);
    nothingChanged(world);
  });

  test("a failed Terraform apply spends B, takes no lock and writes no record", async () => {
    const world = await bootstrapPlanned();
    world.terraform.world.failNext = "applyPlan";
    await expect(applyFactory(world.deps, withBootstrapPlan())).rejects.toThrow(
      "`terraform apply` exited with status 1",
    );
    expect(world.lockStore.locks.size).toBe(0);
    expect(world.lockStore.operationWrites).toEqual([]);
    expect(world.planStore.saved.size).toBe(0);
  });

  test("an interrupt before the lock takes none", async () => {
    const world = await bootstrapPlanned();
    const { applyPlan } = world.terraform.provisioner;
    world.deps.provisioner = {
      ...world.terraform.provisioner,
      applyPlan: async (planned) => {
        await applyPlan(planned);
        world.signal.interrupted = true;
      },
    };
    expect(await applyFactory(world.deps, withBootstrapPlan())).toEqual({
      kind: "interrupted",
      locked: false,
    });
    expect(world.lockStore.locks.size).toBe(0);
    expect(world.lockStore.operationWrites).toEqual([]);
    expect(world.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  test("an interrupt once the lock is taken keeps it, and writes no record", async () => {
    const world = await bootstrapPlanned();
    const create = world.lockStore.create.bind(world.lockStore);
    world.lockStore.create = async (bucket, record) => {
      world.signal.interrupted = true;
      return create(bucket, record);
    };
    expect(await applyFactory(world.deps, withBootstrapPlan())).toEqual({
      kind: "interrupted",
      locked: true,
      record: undefined,
    });
    expect(world.lockStore.locks.size).toBe(1);
    expect(world.lockStore.operationWrites).toEqual([]);
  });

  test("a record that cannot be written is reported, and the lock still released", async () => {
    const world = await bootstrapPlanned();
    world.lockStore.writeOperation = async () => {
      throw new Error("S3 PutObject failed: InternalError");
    };
    expect(await applyFactory(world.deps, withBootstrapPlan())).toMatchObject({
      kind: "bootstrapped",
      recordFailure: "S3 PutObject failed: InternalError",
    });
    expect(world.lockStore.locks.size).toBe(0);
  });

  test("a lock held by the time the bucket exists is reported as today", async () => {
    const world = await bootstrapPlanned();
    const { applyPlan } = world.terraform.provisioner;
    let held: ReturnType<typeof world.lockStore.hold> | undefined;
    world.deps.provisioner = {
      ...world.terraform.provisioner,
      applyPlan: async (planned) => {
        await applyPlan(planned);
        held = world.lockStore.hold(
          BUCKET,
          newLockRecord({
            factoryId: FACTORY,
            operation: "apply",
            holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
            now: NOW,
            release: RELEASE,
            randomBytes: (n) => new Uint8Array(n).fill(1),
          }),
        );
      },
    };
    expect(await applyFactory(world.deps, withBootstrapPlan())).toEqual({ kind: "locked", held });
    expect(world.lockStore.buckets.has(BUCKET)).toBe(true);
    expect(world.lockStore.operationWrites).toEqual([]);
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
