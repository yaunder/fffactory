/**
 * Stopping dispatch on one worker outside apply (`docs/specs/dispatch.md` §Stopping dispatch),
 * over the real `WorkflowQueue` adapter and a scripted worker.
 */
import { describe, expect, test } from "bun:test";
import type { HostCommandOutcome } from "../../src/application/host-transport";
import { stopDispatch } from "../../src/application/stop-dispatch";
import {
  type DispatchInspection,
  dispatchProjectionJson,
  notRequestedDispatchProjection,
} from "../../src/domain/dispatch-projection";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import { resolveWorker, type WorkerAddress } from "../../src/domain/tailnet";
import {
  ffflowGithubWorkflowQueue,
  WORKFLOW_TIMEOUT_MS,
} from "../../src/infrastructure/ffflow-github-workflow-queue";
import { dispatchAnswer, fakeTransport, peer, TAG } from "../support/fake-workers";

const HOSTNAME = "fff-abcd1234-builder-1";

function address(): WorkerAddress {
  const resolution = resolveWorker([peer(HOSTNAME)], HOSTNAME, TAG);
  if (resolution.kind !== "found") throw new Error(`worker did not resolve: ${resolution.kind}`);
  return resolution.worker;
}

const reconciled = (changed: boolean): DispatchInspection => ({
  protocol_version: 1,
  state: "not_requested",
  blockers: [],
  changed,
});

/** Stops dispatch on a worker answering `dispatch reconcile` with `answer`. */
async function stopping(answer: HostCommandOutcome) {
  const { transport, calls } = fakeTransport({ [HOSTNAME]: answer });
  const result = await stopDispatch(
    { workflowQueue: ffflowGithubWorkflowQueue(transport) },
    address(),
  );
  return { result, calls };
}

describe("stopping dispatch on a worker", () => {
  test("sends only the not-requested projection, through the activator's dispatch reconcile", async () => {
    const { result, calls } = await stopping(dispatchAnswer(reconciled(true)));
    expect(result).toEqual({ kind: "stopped" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toEqual(["sudo", "-n", WORKER_PATHS.activator, "dispatch", "reconcile"]);
    expect(call?.timeoutMs).toBe(WORKFLOW_TIMEOUT_MS);
    expect(new TextDecoder().decode(call?.stdin)).toBe(
      dispatchProjectionJson(notRequestedDispatchProjection(HOSTNAME)),
    );
  });

  test("is already stopped when the worker held that projection and no schedule", async () => {
    expect((await stopping(dispatchAnswer(reconciled(false)))).result).toEqual({
      kind: "already_stopped",
    });
  });

  test.each([
    {
      case: "an unreachable worker",
      answer: { kind: "unreachable", reason: "the connection timed out" } as HostCommandOutcome,
      reason: "dispatch schedule reconcile unreachable",
    },
    {
      case: "a schedule that did not reconcile",
      answer: dispatchAnswer({
        protocol_version: 1,
        state: "failed",
        blockers: [],
        reason: "dispatch schedule did not reconcile",
      }),
      reason: "dispatch schedule did not reconcile",
    },
    {
      case: "an answer that is not the protocol's",
      answer: { kind: "completed", exitCode: 0, stdout: "Paseo said something" } as const,
      reason: "dispatch schedule reconcile returned invalid data",
    },
    {
      case: "a worker reporting dispatch still active",
      answer: dispatchAnswer({
        protocol_version: 1,
        state: "active",
        blockers: [],
        changed: false,
      }),
      reason: "the worker did not report dispatch stopped",
    },
    {
      case: "a worker reporting dispatch pending",
      answer: dispatchAnswer({
        protocol_version: 1,
        state: "pending",
        blockers: ["paseo_health"],
        changed: true,
      }),
      reason: "the worker did not report dispatch stopped",
    },
  ])("fails with its own reason, never daemon output, for $case", async ({ answer, reason }) => {
    const { result } = await stopping(answer);
    expect(result).toEqual({ kind: "failed", reason });
  });
});
