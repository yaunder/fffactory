/**
 * Runs on the execution backend (`docs/specs/execution-backend.md` §The run contract): the
 * launch identity's equality the duplicate check uses, and a worker's runs read as its agents.
 */
import { describe, expect, test } from "bun:test";
import { launchedFor, type Run, sameWork, workerAgents } from "../../src/domain/run";

const PRODUCT_101 = { repository: "product", workItem: 101 };

describe("the launch identity (execution backend §The run contract)", () => {
  test("two launches are for the same work when their repository and work item are, whatever the attempt", () => {
    const first = { ...PRODUCT_101, attempt: "20261109T070503Z" };
    const retry = { ...PRODUCT_101, attempt: "20261110T000000Z" };
    expect(sameWork(first, retry)).toBe(true);
    expect(sameWork(first, PRODUCT_101)).toBe(true);
    expect(sameWork(first, { repository: "product", workItem: 102 })).toBe(false);
    expect(sameWork(first, { repository: "other", workItem: 101 })).toBe(false);
  });

  test("the runs launched for some work are the dispatched ones the backend reports for it, in any state", () => {
    const runs: Run[] = [
      { id: "a", state: "finished", dispatched: true, work: PRODUCT_101 },
      { id: "b", state: "stopped", dispatched: true, work: { ...PRODUCT_101, workItem: 102 } },
      { id: "c", state: "working", dispatched: true },
      { id: "d", state: "working", dispatched: false },
      { id: "e", state: "failed", dispatched: true, work: PRODUCT_101 },
    ];
    expect(launchedFor(runs, PRODUCT_101).map(({ id }) => id)).toEqual(["a", "e"]);
    expect(launchedFor(runs, { repository: "other", workItem: 101 })).toEqual([]);
  });

  test("a run dispatch did not launch is never one launched for any work", () => {
    const run: Run = { id: "a", state: "working", dispatched: false, work: PRODUCT_101 };
    expect(launchedFor([run], PRODUCT_101)).toEqual([]);
  });
});

describe("a worker's runs as its agents (control plane §Agent states)", () => {
  test("each run is an agent: its ID, state and whether dispatch launched it, nothing else", () => {
    expect(
      workerAgents({
        kind: "listed",
        runs: [
          { id: "a", state: "needs_input", dispatched: true, work: PRODUCT_101 },
          { id: "b", state: "working", dispatched: false },
        ],
      }),
    ).toEqual({
      kind: "listed",
      agents: [
        { id: "a", state: "needs_input", dispatched: true },
        { id: "b", state: "working", dispatched: false },
      ],
    });
  });

  test("runs that could not be read are unknown agents, for the same reason", () => {
    const unknown = { kind: "unknown", reason: "Paseo activity could not be read" } as const;
    expect(workerAgents(unknown)).toEqual(unknown);
  });
});
