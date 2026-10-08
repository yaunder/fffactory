import { describe, expect, test } from "bun:test";
import type { HostCommandOutcome, HostTransport } from "../../src/application/host-transport";
import {
  dispatchAdoptionJson,
  dispatchInspectionJson,
  dispatchProjection,
  dispatchProjectionJson,
} from "../../src/domain/dispatch-projection";
import type { RemoteCommand } from "../../src/domain/host-protocol";
import { resolveWorker, type WorkerAddress } from "../../src/domain/tailnet";
import { ffflowGithubWorkflowQueue } from "../../src/infrastructure/ffflow-github-workflow-queue";
import { peer, TAG } from "../support/fake-workers";

const HOSTNAME = "fff-abcd1234-builder-1";
const SETTINGS = {
  enabled: true,
  cron: "*/15 * * * *",
  timezone: "UTC",
  provider: "claude",
  model: "configured-model",
  mode: "default",
  cwd: "/home/factory",
} as const;

function address(): WorkerAddress {
  const resolution = resolveWorker([peer(HOSTNAME)], HOSTNAME, TAG);
  if (resolution.kind !== "found") throw new Error("test worker did not resolve");
  return resolution.worker;
}

const completed = (exitCode: number, stdout: string): HostCommandOutcome => ({
  kind: "completed",
  exitCode,
  stdout,
});

function fakeTransport(...answers: HostCommandOutcome[]) {
  const calls: { command: RemoteCommand; stdin?: Uint8Array }[] = [];
  const queue = [...answers];
  const transport: HostTransport = {
    run: async (_worker, command, options) => {
      calls.push({ command, ...(options.stdin ? { stdin: options.stdin } : {}) });
      return queue.shift() ?? { kind: "unreachable", reason: "no answer" };
    },
  };
  return { transport, calls };
}

describe("the FFFlow/GitHub workflow-queue adapter", () => {
  test("uses the fixed activator adoption operation and accepts its versioned result", async () => {
    const result = { protocol_version: 1 as const, state: "passed" as const };
    const { transport, calls } = fakeTransport(completed(0, dispatchAdoptionJson(result)));
    expect(await ffflowGithubWorkflowQueue(transport).adoption(address())).toEqual({
      kind: "passed",
    });
    expect(calls[0]?.command.join("\0")).toBe(
      ["sudo", "-n", "/usr/local/libexec/fffactory-activate", "dispatch", "adoption"].join("\0"),
    );
  });

  test("distinguishes adoption pending from an unreadable operation", async () => {
    const failed = { protocol_version: 1 as const, state: "failed" as const };
    expect(
      (
        await ffflowGithubWorkflowQueue(
          fakeTransport(completed(2, dispatchAdoptionJson(failed))).transport,
        ).adoption(address())
      ).kind,
    ).toBe("failed");
    expect(
      (
        await ffflowGithubWorkflowQueue(
          fakeTransport({ kind: "unreachable", reason: "no route" }).transport,
        ).adoption(address())
      ).kind,
    ).toBe("unknown");
    const passed = { protocol_version: 1 as const, state: "passed" as const };
    expect(
      (
        await ffflowGithubWorkflowQueue(
          fakeTransport(completed(1, dispatchAdoptionJson(passed))).transport,
        ).adoption(address())
      ).kind,
    ).toBe("unknown");
  });

  test("streams the authoritative projection and trusts active only when observed", async () => {
    const desired = dispatchProjection(HOSTNAME, SETTINGS, true, []);
    const observed = {
      protocol_version: 1 as const,
      state: "active" as const,
      blockers: [] as const,
      changed: false,
    };
    const { transport, calls } = fakeTransport(completed(0, dispatchInspectionJson(observed)));
    expect(
      await ffflowGithubWorkflowQueue(transport).reconcileDispatch(address(), desired),
    ).toEqual({
      kind: "reconciled",
      changed: false,
      inspection: observed,
    });
    expect(calls[0]?.command.at(-2)).toBe("dispatch");
    expect(calls[0]?.command.at(-1)).toBe("reconcile");
    expect(new TextDecoder().decode(calls[0]?.stdin)).toBe(dispatchProjectionJson(desired));
  });

  test("a reconciliation command failure is failed, not pending", async () => {
    const desired = dispatchProjection(HOSTNAME, SETTINGS, true, []);
    const failed = {
      protocol_version: 1 as const,
      state: "failed" as const,
      blockers: [],
      reason: "dispatch schedule did not reconcile",
    };
    const { transport } = fakeTransport(completed(1, dispatchInspectionJson(failed)));
    expect(
      (await ffflowGithubWorkflowQueue(transport).reconcileDispatch(address(), desired)).kind,
    ).toBe("failed");
  });

  test("inspection trusts a versioned state only when its exit status agrees", async () => {
    const active = {
      protocol_version: 1 as const,
      state: "active" as const,
      blockers: [] as const,
      changed: false,
    };
    const { transport, calls } = fakeTransport(completed(1, dispatchInspectionJson(active)));
    expect(await ffflowGithubWorkflowQueue(transport).inspectDispatch(address())).toEqual({
      protocol_version: 1,
      state: "unreadable",
    });
    expect(calls[0]?.command.join("\0")).toBe(
      ["sudo", "-n", "/usr/local/libexec/fffactory-activate", "dispatch", "inspect"].join("\0"),
    );
  });
});
