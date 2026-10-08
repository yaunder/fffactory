import { describe, expect, test } from "bun:test";
import type { HostCommandOutcome } from "../../src/application/host-transport";
import { inspectWorker } from "../../src/application/inspect-worker";
import { resolveWorker, type WorkerAddress } from "../../src/domain/tailnet";
import { answers, fakeTransport, inspection, peer, TAG } from "../support/fake-workers";

const NAME = "fff-aaaa1111-builder-1";

function worker(): WorkerAddress {
  const resolution = resolveWorker([peer(NAME)], NAME, TAG);
  if (resolution.kind !== "found") throw new Error("not found");
  return resolution.worker;
}

async function inspectAnswering(outcome: HostCommandOutcome) {
  return inspectWorker(fakeTransport({ [NAME]: outcome }).transport, worker());
}

describe("inspecting a worker", () => {
  test("reads the document it answers", async () => {
    const document = inspection(NAME);
    expect(await inspectAnswering(answers(document))).toEqual({
      kind: "inspected",
      inspection: document,
    });
  });

  test("a shell that cannot find the active release's executable means no release", async () => {
    expect(await inspectAnswering({ kind: "completed", exitCode: 127, stdout: "" })).toEqual({
      kind: "no_release",
    });
  });

  test("another exit status or an unreadable answer is a failure", async () => {
    expect(await inspectAnswering({ kind: "completed", exitCode: 1, stdout: "" })).toEqual({
      kind: "failed",
      reason: "host inspect exited with status 1",
    });
    expect(await inspectAnswering({ kind: "completed", exitCode: 0, stdout: "hello" })).toEqual({
      kind: "failed",
      reason: "its answer is not a host inspection: the output is not JSON",
    });
  });

  test("another protocol version is reported as such", async () => {
    const stdout = JSON.stringify({ protocol_version: 2 });
    expect(await inspectAnswering({ kind: "completed", exitCode: 0, stdout })).toEqual({
      kind: "unsupported_protocol",
      version: 2,
    });
  });

  test("a timeout is unreachable; an ssh that cannot start is a failure", async () => {
    expect(await inspectAnswering({ kind: "timed_out" })).toEqual({
      kind: "unreachable",
      reason: "no answer within 30 s",
    });
    expect(await inspectAnswering({ kind: "not_started", code: "EACCES" })).toEqual({
      kind: "failed",
      reason: "ssh could not be started (EACCES)",
    });
  });

  test("transport refusals pass through", async () => {
    for (const outcome of [
      { kind: "access_denied" },
      { kind: "host_key_mismatch" },
      { kind: "client_missing" },
      { kind: "unreachable", reason: "the connection was refused" },
    ] as HostCommandOutcome[])
      expect(await inspectAnswering(outcome)).toEqual(outcome as never);
  });
});
