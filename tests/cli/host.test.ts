import { describe, expect, test } from "bun:test";
import { run } from "../../src/cli/run";
import { hostInspectionJson, parseHostInspection } from "../../src/domain/host-protocol";
import {
  type HostApplyResult,
  hostApplyJson,
  pendingSteps,
  withStep,
} from "../../src/domain/installation";
import { verificationJson } from "../../src/domain/readiness";
import { repositoryInspectionJson } from "../../src/domain/repository-placement";
import { activityJson, controlPlaneActionJson } from "../../src/domain/control-plane";
import { dispatchAdoptionJson, dispatchInspectionJson } from "../../src/domain/dispatch-projection";
import { harness } from "../support/cli-harness";
import { fakeWorker, inspection, verification } from "../support/fake-workers";
import { MemoryInstanceStore } from "../support/memory-instance-store";

describe("fffactory host inspect", () => {
  test("prints the worker's inspection as the protocol's JSON document, needing no factory.json", async () => {
    const document = inspection("fff-aaaa1111-builder-1", { release: { state: "none" } });
    const { context, out, err } = harness(
      new MemoryInstanceStore(),
      {},
      {
        worker: fakeWorker(document),
      },
    );
    expect(await run(["host", "inspect", "--json"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([hostInspectionJson(document)]);
    expect(parseHostInspection(out[0] ?? "")).toEqual({ ok: true, inspection: document });
  });

  test("needs --json, a known subcommand and no other arguments", async () => {
    for (const args of [
      ["host", "inspect"],
      ["host"],
      ["host", "inspect", "--json", "extra"],
      ["host", "apply", "--json"],
      ["host", "verify"],
      ["host", "repositories"],
      ["host", "repositories", "--json", "--apply"],
      ["host", "dispatch"],
      ["host", "dispatch", "arbitrary"],
      ["host", "dispatch", "inspect", "extra"],
      ["host", "remove"],
    ]) {
      const { context, out } = harness(new MemoryInstanceStore());
      expect(await run(args, context)).toBe(1);
      expect(out).toEqual([]);
    }
    const { context, err } = harness(new MemoryInstanceStore());
    await run(["host", "inspect"], context);
    expect(err).toEqual(["fffactory host inspect: the host protocol is JSON; pass --json"]);
  });

  test("--help prints the usage", async () => {
    const { context, out } = harness(new MemoryInstanceStore());
    expect(await run(["host", "--help"], context)).toBe(0);
    expect(out.slice(0, 4)).toEqual([
      "Usage: fffactory host inspect --json",
      "       fffactory host apply",
      "       fffactory host verify --json",
      "       fffactory host repositories (--json | --apply)",
    ]);
    expect(out).toContain(
      "       fffactory host control-plane (activity | install | reload | restart)",
    );
    expect(out).toContain("       fffactory host dispatch (adoption | reconcile | inspect)");
  });
});

describe("fffactory host dispatch", () => {
  test("exposes only the versioned fixed adoption, reconcile and inspection operations", async () => {
    const pending = {
      protocol_version: 1 as const,
      state: "pending" as const,
      blockers: ["github_credential" as const],
      changed: true,
    };
    const worker = fakeWorker(inspection(HOST), {
      isRoot: () => true,
      adoption: async () => ({ protocol_version: 1, state: "failed" }),
      reconcileDispatch: async () => pending,
      inspectDispatch: async () => ({
        protocol_version: 1,
        state: "active",
        blockers: [],
        changed: false,
      }),
    });
    const adoption = harness(new MemoryInstanceStore(), {}, { worker });
    expect(await run(["host", "dispatch", "adoption"], adoption.context)).toBe(2);
    expect(adoption.out).toEqual([dispatchAdoptionJson({ protocol_version: 1, state: "failed" })]);
    const reconcile = harness(new MemoryInstanceStore(), {}, { worker });
    expect(await run(["host", "dispatch", "reconcile"], reconcile.context)).toBe(2);
    expect(reconcile.out).toEqual([dispatchInspectionJson(pending)]);
    const inspect = harness(new MemoryInstanceStore(), {}, { worker });
    expect(await run(["host", "dispatch", "inspect"], inspect.context)).toBe(0);
  });

  test("requires the fixed root activator", async () => {
    const { context, out } = harness(new MemoryInstanceStore());
    expect(await run(["host", "dispatch", "inspect"], context)).toBe(1);
    expect(out).toEqual([]);
  });
});

describe("fffactory host control-plane", () => {
  test("prints only versioned endpoint documents and propagates failures", async () => {
    const worker = fakeWorker(inspection(HOST), {
      isRoot: () => true,
      activity: async () => ({ kind: "active", count: 2 }),
      install: async () => ({ kind: "done" }),
      reload: async () => ({ kind: "failed", reason: "Paseo reload exited 1" }),
    });
    const active = harness(new MemoryInstanceStore(), {}, { worker });
    expect(await run(["host", "control-plane", "activity"], active.context)).toBe(0);
    expect(active.out).toEqual([activityJson({ kind: "active", count: 2 })]);
    const install = harness(new MemoryInstanceStore(), {}, { worker });
    expect(await run(["host", "control-plane", "install"], install.context)).toBe(0);
    expect(install.out).toEqual([controlPlaneActionJson({ kind: "done" })]);
    const reload = harness(new MemoryInstanceStore(), {}, { worker });
    expect(await run(["host", "control-plane", "reload"], reload.context)).toBe(1);
    expect(reload.out).toEqual([
      controlPlaneActionJson({ kind: "failed", reason: "Paseo reload exited 1" }),
    ]);
  });

  test("requires root and one fixed action", async () => {
    for (const args of [
      ["host", "control-plane", "activity"],
      ["host", "control-plane", "arbitrary"],
      ["host", "control-plane", "restart", "extra"],
    ]) {
      const { context, out } = harness(new MemoryInstanceStore());
      expect(await run(args, context)).toBe(1);
      expect(out).toEqual([]);
    }
  });
});

describe("fffactory host repositories", () => {
  test("reads the persisted result without root", async () => {
    const result = { protocol_version: 1 as const, state: "synchronized" as const, unmanaged: [] };
    const { context, out } = harness(
      new MemoryInstanceStore(),
      {},
      { worker: fakeWorker(inspection(HOST), { inspectRepositories: async () => result }) },
    );
    expect(await run(["host", "repositories", "--json"], context)).toBe(0);
    expect(out).toEqual([repositoryInspectionJson(result)]);
  });

  test("applies only through the worker endpoint and reports an unresolved result", async () => {
    const result = {
      protocol_version: 1 as const,
      state: "unresolved" as const,
      unmanaged: ["github.com/yaunder/old"],
    };
    const { context, out } = harness(
      new MemoryInstanceStore(),
      {},
      { worker: fakeWorker(inspection(HOST), { reconcileRepositories: async () => result }) },
    );
    expect(await run(["host", "repositories", "--apply"], context)).toBe(1);
    expect(out).toEqual([repositoryInspectionJson(result)]);
  });
});

const HOST = "fff-aaaa1111-builder-1";

function applied(state: "succeeded" | "failed"): HostApplyResult {
  const steps = pendingSteps().map((step) => ({ ...step, status: "succeeded" as const }));
  return {
    protocol_version: 1,
    hostname: HOST,
    state,
    release: "0.3.0",
    configuration_sha256: "d".repeat(64),
    started_at: "2026-09-30T12:00:00.000Z",
    finished_at: "2026-09-30T12:09:00.000Z",
    steps:
      state === "succeeded" ? steps : withStep(steps, "plugins", "failed", "exited with status 1"),
    verification: state === "succeeded" ? verification(HOST, "pending") : null,
    failure: null,
  };
}

describe("fffactory host apply (host protocol §apply)", () => {
  test("prints host apply's document and exits 0 once the install succeeded", async () => {
    const result = applied("succeeded");
    const { context, out, err } = harness(
      new MemoryInstanceStore(),
      {},
      { worker: fakeWorker(inspection(HOST), { apply: async () => result }) },
    );
    expect(await run(["host", "apply"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([hostApplyJson(result)]);
  });

  test("exits 1 with the document when the install failed or was refused", async () => {
    const refusal: HostApplyResult = {
      protocol_version: 1,
      hostname: HOST,
      state: "refused",
      reason: "not_root",
      message: "host apply must run as root, through the activator",
    };
    for (const result of [applied("failed"), refusal]) {
      const { context, out } = harness(
        new MemoryInstanceStore(),
        {},
        { worker: fakeWorker(inspection(HOST), { apply: async () => result }) },
      );
      expect(await run(["host", "apply"], context)).toBe(1);
      expect(out).toEqual([hostApplyJson(result)]);
    }
  });
});

describe("fffactory host verify (readiness §Verification)", () => {
  test("prints the verify document as root", async () => {
    const document = verification(HOST, "pending");
    const { context, out } = harness(
      new MemoryInstanceStore(),
      {},
      {
        worker: fakeWorker(inspection(HOST), {
          verify: async () => document,
          isRoot: () => true,
        }),
      },
    );
    expect(await run(["host", "verify", "--json"], context)).toBe(0);
    expect(out).toEqual([verificationJson(document)]);
  });

  test("refuses to run unprivileged: the credentials it checks are factory's", async () => {
    const { context, out, err } = harness(new MemoryInstanceStore());
    expect(await run(["host", "verify", "--json"], context)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "fffactory host verify: run it as root; `fffactory apply` runs it on every install, within host apply",
    ]);
  });
});
