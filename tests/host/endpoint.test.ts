import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Release } from "../../src/domain/instance";
import type { ApplySystem } from "../../src/host/apply";
import { localCollectionSystem, workerCollection } from "../../src/host/collection";
import { workerEndpoint } from "../../src/host/endpoint";
import { system } from "./worker-scenarios";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-endpoint-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the composed worker endpoint", () => {
  test("keeps every host protocol verb wired to its worker-side implementation", async () => {
    const worker: ApplySystem = {
      ...system(root, {
        run: async () => ({ kind: "exited", exitCode: 1, stdout: "", stderr: "" }),
      }),
      now: () => new Date("2026-10-05T12:00:00.000Z"),
      isRoot: () => false,
      readInput: async () => "{}\n",
      release: "0.3.0" as Release,
      lock: async () => ({ release: () => {} }),
    };
    const endpoint = workerEndpoint(
      worker,
      workerCollection(localCollectionSystem("0.3.0" as Release, root)),
    );

    const results = await Promise.allSettled([
      endpoint.inspect(),
      endpoint.apply(),
      endpoint.verify(),
      endpoint.inspectRepositories(),
      endpoint.reconcileRepositories(),
      endpoint.activity(),
      endpoint.install(),
      endpoint.reload(),
      endpoint.restart(),
      endpoint.adoption(),
      endpoint.reconcileDispatch(),
      endpoint.inspectDispatch(),
      endpoint.inspectWork(),
      endpoint.agents(),
      endpoint.collect(),
    ]);

    expect(endpoint.isRoot()).toBe(false);
    expect(results).toHaveLength(15);
    expect(results.slice(0, 4).every(({ status }) => status === "fulfilled")).toBe(true);
    expect(results[4]?.status).toBe("rejected");
    expect(results.slice(5, 9).every(({ status }) => status === "fulfilled")).toBe(true);
    expect(results.slice(9, 13).every(({ status }) => status === "rejected")).toBe(true);
    // Unprivileged, as the dispatcher runs it: its Paseo list fails here, so unknown.
    expect(results[13]).toEqual({
      status: "fulfilled",
      value: { kind: "unknown", reason: "Paseo activity could not be read" },
    });
    // No collector.json under this root: the collector is not configured.
    expect(results[14]).toEqual({ status: "fulfilled", value: { kind: "not_configured" } });
  });
});
