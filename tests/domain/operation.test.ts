import { describe, expect, test } from "bun:test";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import {
  finishOperation,
  INFRASTRUCTURE_STAGE,
  operationKey,
  PIN_STAGE,
  serializeOperation,
  startOperation,
  withDispatch,
  withVerification,
  WORKERS_STAGE,
  withStage,
  withRepositories,
  withWorkers,
} from "../../src/domain/operation";
import type { WorkerOutcome } from "../../src/domain/rollout";
import { verification } from "../support/fake-workers";

const LOCK = newLockRecord({
  factoryId: "fff-abcd1234" as FactoryId,
  operation: "apply",
  holder: { principal: "arn:aws:sts::123456789012:assumed-role/Admin/op", host: "laptop" },
  now: new Date("2026-09-30T10:00:00.000Z"),
  release: "0.3.0" as Release,
  randomBytes: (count) => new Uint8Array(count),
});
const LATER = new Date("2026-09-30T10:05:00.000Z");
const END = new Date("2026-09-30T10:20:00.000Z");

describe("operation records", () => {
  test("are keyed in the state bucket under the factory ID, by start time and lock ID", () => {
    expect(operationKey(startOperation(LOCK, "k3x9q2ab"))).toBe(
      "fff-abcd1234-operations/2026-09-30T10:00:00.000Z-aaaaaaaa.json",
    );
  });

  test("start as running, planning the infrastructure stage, under the lock's identity", () => {
    expect(startOperation(LOCK, undefined)).toEqual({
      schema_version: 1,
      operation_id: "aaaaaaaa",
      factory_id: "fff-abcd1234" as FactoryId,
      operation: "apply",
      holder: LOCK.holder,
      release: "0.3.0" as Release,
      plan_id: null,
      status: "running",
      stages: [{ name: INFRASTRUCTURE_STAGE, status: "planning" }],
      workers: [],
      repositories: [],
      control_plane: [],
      dispatch: [],
      verification: null,
      started_at: "2026-09-30T10:00:00.000Z",
      updated_at: "2026-09-30T10:00:00.000Z",
      finished_at: null,
      failure: null,
    });
    expect(startOperation(LOCK, "k3x9q2ab").plan_id).toBe("k3x9q2ab");
  });

  test("record each stage's progress, replacing the stage's status and adding a new stage", () => {
    const started = startOperation(LOCK, undefined);
    const applying = withStage(started, INFRASTRUCTURE_STAGE, "applying", LATER);
    expect(applying.stages).toEqual([{ name: INFRASTRUCTURE_STAGE, status: "applying" }]);
    expect(applying.updated_at).toBe(LATER.toISOString());
    expect(applying.status).toBe("running");
    expect(started.stages).toEqual([{ name: INFRASTRUCTURE_STAGE, status: "planning" }]);
    expect(withStage(applying, "workers", "pending", LATER).stages).toEqual([
      { name: INFRASTRUCTURE_STAGE, status: "applying" },
      { name: "workers", status: "pending" },
    ]);
  });

  test("record each worker's result in the workers stage, in fffactory's words", () => {
    const outcomes: WorkerOutcome[] = [
      {
        key: "builder-1" as HostKey,
        hostname: "fff-abcd1234-builder-1",
        kind: "installed",
        release: "0.3.0",
        verification: verification("fff-abcd1234-builder-1", "pending"),
      },
      {
        key: "builder-2" as HostKey,
        hostname: "fff-abcd1234-builder-2",
        kind: "skipped",
        summary: "Offline in the tailnet",
        nextAction: "Check it, then rerun `fffactory apply`.",
      },
      { key: "builder-3" as HostKey, hostname: "fff-abcd1234-builder-3", kind: "not_attempted" },
    ];
    const record = withWorkers(
      withStage(startOperation(LOCK, undefined), WORKERS_STAGE, "installing", LATER),
      outcomes,
      END,
    );
    expect(record.workers).toEqual([
      { key: "builder-1", hostname: "fff-abcd1234-builder-1", status: "installed", summary: null },
      {
        key: "builder-2",
        hostname: "fff-abcd1234-builder-2",
        status: "skipped",
        summary: "Offline in the tailnet",
      },
      {
        key: "builder-3",
        hostname: "fff-abcd1234-builder-3",
        status: "not_attempted",
        summary: null,
      },
    ]);
    expect(record.updated_at).toBe(END.toISOString());
    expect(record.stages.at(-1)).toEqual({ name: "workers", status: "installing" });
  });

  test("records repository outcomes and unmanaged paths in the repository stage", () => {
    const record = withRepositories(
      startOperation(LOCK, undefined),
      [
        {
          key: "builder-1",
          hostname: "fff-abcd1234-builder-1",
          kind: "synchronized",
          unmanaged: ["legacy/product"],
        },
      ],
      LATER,
    );
    expect(record.repositories).toEqual([
      {
        key: "builder-1",
        hostname: "fff-abcd1234-builder-1",
        status: "synchronized",
        unmanaged: ["legacy/product"],
        summary: null,
      },
    ]);
  });

  test("records dispatch blockers and the independent end-to-end verification", () => {
    const dispatched = withDispatch(
      startOperation(LOCK, undefined),
      [
        {
          key: "builder-1",
          hostname: "fff-abcd1234-builder-1",
          kind: "pending",
          blocking: [{ gate: "github_credential" }],
          summary: "Dispatch pending",
        },
      ],
      LATER,
    );
    expect(dispatched.dispatch).toEqual([
      {
        key: "builder-1",
        hostname: "fff-abcd1234-builder-1",
        status: "pending",
        blockers: ["github_credential"],
        summary: "Dispatch pending",
      },
    ]);
    const checked = withVerification(
      dispatched,
      {
        ready: false,
        summary: "The factory is not ready",
        workers: [
          {
            key: "builder-1" as HostKey,
            hostname: "fff-abcd1234-builder-1",
            release: "healthy",
            repositories: "synchronized",
            controlPlane: "applied",
            dispatch: "pending",
            ready: false,
            summary: "worker is not ready",
            details: ["Enroll GitHub"],
          },
        ],
      },
      END,
    );
    expect(checked.verification?.workers[0]).toMatchObject({ dispatch: "pending", ready: false });
  });

  test("finish with the operation's outcome, and a failure's reason", () => {
    const applying = withStage(
      startOperation(LOCK, undefined),
      "infrastructure",
      "applying",
      LATER,
    );
    const failed = finishOperation(
      withStage(applying, INFRASTRUCTURE_STAGE, "failed", END),
      "failed",
      END,
      "`terraform apply` exited with status 1",
    );
    expect(failed).toMatchObject({
      status: "failed",
      stages: [{ name: INFRASTRUCTURE_STAGE, status: "failed" }],
      updated_at: END.toISOString(),
      finished_at: END.toISOString(),
      failure: "`terraform apply` exited with status 1",
    });
    expect(finishOperation(applying, "succeeded", END)).toMatchObject({
      status: "succeeded",
      finished_at: END.toISOString(),
      failure: null,
    });
  });

  test("finish with a stage still pending ended as the operation did, when it did not succeed", () => {
    const upgrading = startOperation(LOCK, undefined, [PIN_STAGE]);
    for (const outcome of ["declined", "refused", "failed"] as const)
      expect(finishOperation(upgrading, outcome, END).stages).toEqual([
        { name: PIN_STAGE, status: outcome },
        { name: INFRASTRUCTURE_STAGE, status: "planning" },
      ]);
    // A stage that moved on keeps its status.
    const written = withStage(upgrading, PIN_STAGE, "written", LATER);
    expect(finishOperation(written, "failed", END).stages[0]).toEqual({
      name: PIN_STAGE,
      status: "written",
    });
  });

  test("are written as indented JSON", () => {
    const record = startOperation(LOCK, undefined);
    expect(JSON.parse(serializeOperation(record))).toEqual(record);
    expect(serializeOperation(record).endsWith("}\n")).toBe(true);
  });
});
