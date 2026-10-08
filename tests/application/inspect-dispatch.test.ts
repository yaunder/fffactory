import { describe, expect, test } from "bun:test";
import { inspectDispatch } from "../../src/application/inspect-dispatch";
import type { HostCommandOutcome, HostTransport } from "../../src/application/host-transport";
import {
  dispatchInspectionJson,
  INSPECT_DISPATCH_COMMAND,
} from "../../src/domain/dispatch-projection";
import { resolveWorker, type WorkerAddress } from "../../src/domain/tailnet";
import { peer, TAG } from "../support/fake-workers";

const HOSTNAME = "fff-abcd1234-builder-1";

function address(): WorkerAddress {
  const resolution = resolveWorker([peer(HOSTNAME)], HOSTNAME, TAG);
  if (resolution.kind !== "found") throw new Error("test worker did not resolve");
  return resolution.worker;
}

function transport(answer: HostCommandOutcome) {
  const calls: { command: readonly string[]; timeoutMs: number }[] = [];
  const fake: HostTransport = {
    run: async (_worker, command, options) => {
      calls.push({ command, timeoutMs: options.timeoutMs });
      return answer;
    },
  };
  return { fake, calls };
}

describe("dispatch inspection", () => {
  test("accepts a versioned inspection only when its exit status agrees", async () => {
    const inspection = {
      protocol_version: 1 as const,
      state: "pending" as const,
      blockers: ["github_credential" as const],
      changed: false,
    };
    const { fake, calls } = transport({
      kind: "completed",
      exitCode: 2,
      stdout: dispatchInspectionJson(inspection),
    });

    expect(await inspectDispatch(fake, address())).toEqual(inspection);
    expect(calls).toEqual([{ command: [...INSPECT_DISPATCH_COMMAND], timeoutMs: 120_000 }]);
  });

  test.each([
    { kind: "unreachable" as const, reason: "no route" },
    { kind: "completed" as const, exitCode: 0, stdout: "not json" },
    {
      kind: "completed" as const,
      exitCode: 0,
      stdout: dispatchInspectionJson({
        protocol_version: 1,
        state: "pending",
        blockers: ["paseo_health"],
        changed: false,
      }),
    },
  ])("fails closed for an untrusted host answer", async (answer) => {
    expect(await inspectDispatch(transport(answer).fake, address())).toEqual({
      protocol_version: 1,
      state: "unreadable",
    });
  });
});
