import { describe, expect, test } from "bun:test";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import {
  BACKEND_STAGE,
  finishOperation,
  INFRASTRUCTURE_STAGE,
  type OperationRecord,
  operationKey,
  operationsPrefix,
  PIN_STAGE,
  rememberedHostKeys,
  serializeOperation,
  startOperation,
  startStageOperation,
  type StageStatus,
  startTeardownOperation,
  TEARDOWN_OPERATION,
  withDispatch,
  withHostKeys,
  withInspection,
  withInspections,
  withMachine,
  withVerification,
  WORKERS_STAGE,
  withStage,
  withRepositories,
  withWorkers,
} from "../../src/domain/operation";
import type { WorkerOutcome } from "../../src/domain/rollout";
import { inspectGateActions, workerRemovability } from "../../src/domain/worker-removability";
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

  test("of an apply that created the state bucket lead with the backend stage, applied", () => {
    const bootstrapped = startOperation(LOCK, undefined, { bootstrapped: true });
    expect(BACKEND_STAGE).toBe("backend");
    expect(bootstrapped).toEqual({
      ...startOperation(LOCK, undefined),
      stages: [
        { name: BACKEND_STAGE, status: "applied" },
        { name: INFRASTRUCTURE_STAGE, status: "planning" },
      ],
    });
    expect(startOperation(LOCK, undefined, { bootstrapped: false }).stages).toEqual([
      { name: INFRASTRUCTURE_STAGE, status: "planning" },
    ]);
    // The backend stage keeps its status as the operation moves on or ends.
    const applying = withStage(bootstrapped, INFRASTRUCTURE_STAGE, "applying", LATER);
    expect(finishOperation(applying, "failed", END).stages).toEqual([
      { name: BACKEND_STAGE, status: "applied" },
      { name: INFRASTRUCTURE_STAGE, status: "applying" },
    ]);
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
        delivered: [],
      },
      {
        key: "builder-2" as HostKey,
        hostname: "fff-abcd1234-builder-2",
        kind: "skipped",
        summary: "Offline in the tailnet",
        nextAction: "Check it, then rerun `fffactory apply`.",
      },
      { key: "builder-3" as HostKey, hostname: "fff-abcd1234-builder-3", kind: "not_attempted" },
      {
        key: "builder-4" as HostKey,
        hostname: "fff-abcd1234-builder-4",
        kind: "stopped",
        summary: "Stopped: nothing was sent to it",
        nextAction: "Start it, then rerun `fffactory apply`.",
      },
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
      {
        key: "builder-4",
        hostname: "fff-abcd1234-builder-4",
        status: "stopped",
        summary: "Stopped: nothing was sent to it",
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
    const upgrading = startOperation(LOCK, undefined, { pending: [PIN_STAGE] });
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

  test("of a saved bootstrap plan's apply hold the applied backend stage alone, and its plan ID", () => {
    const record = finishOperation(
      startStageOperation(LOCK, BACKEND_STAGE, "applied", "b00tstr4"),
      "succeeded",
      END,
    );
    expect(record).toMatchObject({
      plan_id: "b00tstr4",
      status: "succeeded",
      stages: [{ name: BACKEND_STAGE, status: "applied" }],
      finished_at: END.toISOString(),
      failure: null,
    });
    expect(startStageOperation(LOCK, "stop", "locating").plan_id).toBeNull();
  });

  test("are written as indented JSON", () => {
    const record = startOperation(LOCK, undefined);
    expect(JSON.parse(serializeOperation(record))).toEqual(record);
    expect(serializeOperation(record).endsWith("}\n")).toBe(true);
  });

  test("of a worker power operation start running its one stage, and record the machine", () => {
    const lock = { ...LOCK, operation: "worker-stop" };
    const started = startStageOperation(lock, "stop", "locating");
    expect(started).toEqual({
      ...startOperation(lock, undefined),
      stages: [{ name: "stop", status: "locating" }],
    });
    expect(started.machine).toBeUndefined();
    const located = withMachine(
      started,
      {
        key: "builder-1",
        hostname: "fff-abcd1234-builder-1",
        instance_id: "i-0123456789abcdef0",
        state: "running",
      },
      LATER,
    );
    expect(located.machine).toEqual({
      key: "builder-1",
      hostname: "fff-abcd1234-builder-1",
      instance_id: "i-0123456789abcdef0",
      state: "running",
    });
    expect(located.updated_at).toBe(LATER.toISOString());
    expect(JSON.parse(serializeOperation(located)).machine.state).toBe("running");
  });
});

describe("a teardown's remembered host keys (teardown §Operation record)", () => {
  const TEARDOWN_LOCK = { ...LOCK, operation: TEARDOWN_OPERATION };
  const FACTORY = "fff-abcd1234" as FactoryId;
  const stored = (record: unknown, key = operationKey(startTeardownOperation(TEARDOWN_LOCK))) => ({
    key,
    text: typeof record === "string" ? record : serializeOperation(record as never),
  });

  test("a teardown's record starts with its one stage authorizing, remembering no host key", () => {
    expect(startTeardownOperation(TEARDOWN_LOCK)).toEqual({
      ...startStageOperation(TEARDOWN_LOCK, TEARDOWN_OPERATION, "authorizing"),
      host_keys: [],
    });
  });

  test("remembers each well-formed host key once, adding to those it already holds", () => {
    const started = startTeardownOperation(TEARDOWN_LOCK);
    const first = withHostKeys(started, ["builder-1", "Not A Key", "ghost", "builder-1"], LATER);
    expect(first.host_keys).toEqual(["builder-1" as HostKey, "ghost" as HostKey]);
    expect(first.updated_at).toBe(LATER.toISOString());
    const second = withHostKeys(first, ["builder-2", "ghost"], END);
    expect(second.host_keys).toEqual(["builder-1", "ghost", "builder-2"] as HostKey[]);
    expect(JSON.parse(serializeOperation(second)).host_keys).toEqual(second.host_keys);
  });

  test("are read back from every earlier teardown's record under the factory's prefix, once each", () => {
    expect(operationsPrefix(FACTORY)).toBe("fff-abcd1234-operations/");
    const earlier = withHostKeys(startTeardownOperation(TEARDOWN_LOCK), ["ghost", "a"], LATER);
    const later = withHostKeys(
      startTeardownOperation({
        ...TEARDOWN_LOCK,
        lock_id: "bbbbbbbb",
        acquired_at: END.toISOString(),
      }),
      ["a", "b"],
      END,
    );
    expect(
      rememberedHostKeys(FACTORY, [stored(earlier), stored(later, operationKey(later))]),
    ).toEqual({ kind: "remembered", keys: ["ghost", "a", "b"] as HostKey[] });
    expect(rememberedHostKeys(FACTORY, [])).toEqual({ kind: "remembered", keys: [] });
  });

  test("another operation's record, and an object fffactory never keys a record as, remember nothing", () => {
    const apply = startOperation(LOCK, undefined);
    expect(
      rememberedHostKeys(FACTORY, [
        stored({ ...apply, host_keys: ["builder-1"] }, operationKey(apply)),
        stored("{not json", "fff-abcd1234-operations/notes.txt"),
        stored("{not json", "fff-abcd1234-operations/2026-09-30T10:00:00.000Z-aaaaaaaa.json.bak"),
      ]),
    ).toEqual({ kind: "remembered", keys: [] });
  });

  test.each([
    ["not JSON", "{not json"],
    ["not an object", "[]"],
    ["without an operation", JSON.stringify({ factory_id: "fff-abcd1234" })],
    [
      "another factory's",
      serializeOperation({
        ...startTeardownOperation(TEARDOWN_LOCK),
        factory_id: "fff-zzzz9999" as FactoryId,
      }),
    ],
    [
      "a teardown's whose host keys are no list",
      JSON.stringify({ ...startTeardownOperation(TEARDOWN_LOCK), host_keys: "ghost" }),
    ],
    [
      "a teardown's with a malformed host key",
      JSON.stringify({
        ...startTeardownOperation(TEARDOWN_LOCK),
        host_keys: ["ghost", "Not A Key"],
      }),
    ],
    [
      "an apply's whose stages are no list",
      JSON.stringify({ ...startOperation(LOCK, undefined), stages: "applied" }),
    ],
    [
      "an apply's with a stage that is no stage",
      JSON.stringify({
        ...startOperation(LOCK, undefined),
        stages: [{ name: INFRASTRUCTURE_STAGE }],
      }),
    ],
  ])(
    "a record keyed as fffactory keys one that is %s is unreadable, named by its key",
    (_, text) => {
      const good = withHostKeys(startTeardownOperation(TEARDOWN_LOCK), ["ghost"], LATER);
      const key = "fff-abcd1234-operations/2026-09-30T11:00:00.000Z-cccccccc.json";
      expect(rememberedHostKeys(FACTORY, [stored(good), stored(text, key)])).toEqual({
        kind: "unreadable",
        records: [key],
      });
    },
  );

  test("a teardown's record without host keys, from before teardown remembered any, remembers none", () => {
    const old = startStageOperation(TEARDOWN_LOCK, TEARDOWN_OPERATION, "applying");
    expect(old).not.toHaveProperty("host_keys");
    expect(rememberedHostKeys(FACTORY, [stored(old)])).toEqual({ kind: "remembered", keys: [] });
  });

  /** A record of `operation` started at `at`, under lock ID `id`. */
  const lockAt = (operation: string, at: string, id: string) => ({
    ...LOCK,
    operation,
    lock_id: id,
    acquired_at: at,
  });
  const teardownAt = (at: string, id: string, keys: readonly string[]) =>
    withHostKeys(startTeardownOperation(lockAt(TEARDOWN_OPERATION, at, id)), keys, new Date(at));
  /** An apply's (or upgrade's) record started at `at`, its infrastructure stage at `status`. */
  const applyAt = (at: string, status: StageStatus, operation = "apply") =>
    withStage(
      startOperation(lockAt(operation, at, "dddddddd"), undefined),
      INFRASTRUCTURE_STAGE,
      status,
      new Date(at),
    );
  const T1 = "2026-09-30T10:00:00.000Z";
  const BETWEEN = "2026-09-30T10:05:00.000Z";
  const T2 = "2026-09-30T10:20:00.000Z";
  const chain = (between: OperationRecord) =>
    [teardownAt(T2, "bbbbbbbb", ["b"]), between, teardownAt(T1, "aaaaaaaa", ["ghost"])].map(
      (record) => stored(record, operationKey(record)),
    );

  test.each(
    (["applying", "applied", "failed"] as const).flatMap((status) =>
      ["apply", "upgrade"].map((operation) => ({ operation, status })),
    ),
  )(
    "a teardown started before an $operation whose infrastructure stage is $status remembers nothing",
    ({ operation, status }) => {
      expect(rememberedHostKeys(FACTORY, chain(applyAt(BETWEEN, status, operation)))).toEqual({
        kind: "remembered",
        keys: ["b"] as HostKey[],
      });
    },
  );

  test.each(["planning", "awaiting_approval", "unchanged", "declined", "refused"] as const)(
    "an apply whose infrastructure stage is %s changed no host: every teardown still remembers",
    (status) => {
      expect(rememberedHostKeys(FACTORY, chain(applyAt(BETWEEN, status)))).toEqual({
        kind: "remembered",
        keys: ["ghost", "b"] as HostKey[],
      });
    },
  );

  test("an apply before every teardown, or a worker operation between them, bounds nothing", () => {
    const before = applyAt("2026-09-30T09:00:00.000Z", "applied");
    expect(rememberedHostKeys(FACTORY, chain(before))).toEqual({
      kind: "remembered",
      keys: ["ghost", "b"] as HostKey[],
    });
    const terminate = withStage(
      startStageOperation(lockAt("worker-terminate", BETWEEN, "dddddddd"), "terminate", "locating"),
      "terminate",
      "removed",
      new Date(BETWEEN),
    );
    expect(rememberedHostKeys(FACTORY, chain(terminate))).toEqual({
      kind: "remembered",
      keys: ["ghost", "b"] as HostKey[],
    });
  });

  test("a teardown started in the same millisecond as an apply that changed the factory is passed over", () => {
    const records = [teardownAt(T1, "aaaaaaaa", ["ghost"]), applyAt(T1, "applied")];
    expect(
      rememberedHostKeys(
        FACTORY,
        records.map((record) => stored(record, operationKey(record))),
      ),
    ).toEqual({ kind: "remembered", keys: [] });
  });
});

describe("a removal's inspections (worker-lifecycle and teardown §Operation record)", () => {
  const WORKER = { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" };
  const OTHER = { key: "builder-2" as HostKey, hostname: "fff-abcd1234-builder-2" };
  /** The inspection document `worker inspect --json` prints for `worker` as `observed`. */
  const printed = (worker: typeof WORKER, observed: Parameters<typeof workerRemovability>[1]) =>
    workerRemovability(worker, observed, inspectGateActions(worker.key)).inspection;
  const busy = {
    kind: "activity",
    activity: { kind: "busy", working: 1, needsInput: 0 },
    agents: { kind: "listed", agents: [{ id: "agent-1", state: "working", dispatched: true }] },
  } as const;

  test("a stop's record carries none: it has no work gate", () => {
    const started = startStageOperation({ ...LOCK, operation: "worker-stop" }, "stop", "locating");
    expect(Object.keys(started)).not.toContain("inspection");
    expect(Object.keys(started)).not.toContain("inspections");
  });

  test("a terminate's carries whether --force was given, beside the document inspect prints", () => {
    const started = startStageOperation(
      { ...LOCK, operation: "worker-terminate" },
      "terminate",
      "inspecting",
    );
    expect(Object.keys(started)).not.toContain("inspection");
    const forced = withInspection(
      started,
      { forced: true, document: printed(WORKER, { kind: "forced" }) },
      LATER,
    );
    expect(forced.inspection).toEqual({
      forced: true,
      document: {
        key: WORKER.key,
        hostname: WORKER.hostname,
        verdict: "not_inspected",
        not_inspected: "forced",
        summary: "--force: the worker is not inspected for busy agents, current work or checkouts.",
        details: [],
        activity: { state: "unknown", reason: null, agents: null },
        unarchived: {
          state: "unknown",
          files: null,
          bytes: null,
          complete: null,
          last_success_at: null,
        },
      },
    });
    expect(forced.updated_at).toBe(LATER.toISOString());
    const refused = withInspection(
      started,
      { forced: false, document: printed(WORKER, busy) },
      LATER,
    );
    // Written as JSON, the document is byte for byte what `worker inspect --json` prints.
    const written = JSON.parse(serializeOperation(refused)).inspection;
    expect(written.forced).toBe(false);
    expect(JSON.stringify(written.document, null, 2)).toBe(
      JSON.stringify(printed(WORKER, busy), null, 2),
    );
  });

  test("a teardown's carries one per running worker, refusals included, in the order inspected", () => {
    const started = startTeardownOperation({ ...LOCK, operation: TEARDOWN_OPERATION });
    expect(Object.keys(started)).not.toContain("inspections");
    const inspections = [
      { forced: false, document: printed(WORKER, busy) },
      { forced: false, document: printed(OTHER, { kind: "stopped" }) },
    ];
    const recorded = withInspections(started, inspections, LATER);
    expect(recorded.inspections).toEqual(inspections);
    expect(recorded.updated_at).toBe(LATER.toISOString());
    expect(withInspections(started, [], LATER).inspections).toEqual([]);
  });
});
