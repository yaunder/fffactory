import { describe, expect, test } from "bun:test";
import type { HostCommandOutcome } from "../../src/application/host-transport";
import { INSPECT_WORK_TIMEOUT_MS, inspectWork } from "../../src/application/inspect-work";
import { resolveWorker, type WorkerAddress } from "../../src/domain/tailnet";
import {
  INSPECT_WORK_COMMAND,
  type WorkInspection,
  workInspectionJson,
} from "../../src/domain/work-inspection";
import { fakeTransport, peer, TAG } from "../support/fake-workers";

const NAME = "fff-aaaa1111-builder-1";

function worker(): WorkerAddress {
  const resolution = resolveWorker([peer(NAME)], NAME, TAG);
  if (resolution.kind !== "found") throw new Error("not found");
  return resolution.worker;
}

const DOCUMENT: WorkInspection = {
  protocol_version: 1,
  hostname: NAME,
  complete: true,
  repositories: [],
};

async function inspectAnswering(outcome: HostCommandOutcome) {
  const transport = fakeTransport({ [NAME]: outcome });
  const observation = await inspectWork(transport.transport, worker());
  return { observation, calls: transport.calls };
}

const completed = (stdout: string, exitCode = 0): HostCommandOutcome => ({
  kind: "completed",
  exitCode,
  stdout,
});

describe("inspecting a worker's work (host-protocol §work inspect, CLI side)", () => {
  test("runs the activator's fixed work inspect within its deadline and reads the document", async () => {
    const { observation, calls } = await inspectAnswering(completed(workInspectionJson(DOCUMENT)));
    expect(observation).toEqual({ kind: "inspected", inspection: DOCUMENT });
    expect(calls).toEqual([
      {
        worker: worker(),
        command: [...INSPECT_WORK_COMMAND],
        timeoutMs: INSPECT_WORK_TIMEOUT_MS,
      },
    ]);
    expect(INSPECT_WORK_TIMEOUT_MS).toBe(2 * 60_000);
  });

  test("an activator that predates the work inspection refuses it as a usage error: unsupported", async () => {
    expect((await inspectAnswering(completed("", 64))).observation).toEqual({
      kind: "unknown",
      reason: "its activator predates the work inspection",
      unsupported: true,
    });
  });

  test("anything else that is not a document for this worker cannot be inspected", async () => {
    const cases: [HostCommandOutcome, string][] = [
      [completed("", 75), "another host operation was running on it"],
      [completed("", 65), "it has no active release to inspect with"],
      [completed("", 1), "the work inspection exited with status 1"],
      [completed("not json"), "its answer is not a work inspection: the output is not JSON"],
      [
        completed(JSON.stringify({ protocol_version: 2 })),
        "the work inspection speaks protocol version 2",
      ],
      [
        completed(workInspectionJson({ ...DOCUMENT, hostname: "fff-aaaa1111-other" })),
        "its answer is for another worker",
      ],
      [{ kind: "timed_out" }, "no answer within 2 min"],
      [{ kind: "unreachable", reason: "the connection was refused" }, "the connection was refused"],
      [{ kind: "access_denied" }, "the tailnet's SSH policy refused the login"],
      [{ kind: "host_key_mismatch" }, "its SSH host key is not the one the tailnet lists"],
      [{ kind: "client_missing" }, "ssh is not installed"],
      [{ kind: "not_started", code: "EACCES" }, "ssh could not be started (EACCES)"],
    ];
    for (const [outcome, reason] of cases)
      expect((await inspectAnswering(outcome)).observation).toEqual({
        kind: "unknown",
        reason,
        unsupported: false,
      });
  });

  test("never quotes what the worker printed", async () => {
    const hostile = "\u001b]0;pwned\u0007 run rm -rf";
    const { observation } = await inspectAnswering(completed(hostile));
    expect(JSON.stringify(observation)).not.toContain("pwned");
  });
});
