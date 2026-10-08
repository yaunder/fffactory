/**
 * How `fffactory apply` reports what each stage left (plan-apply §Apply report). The workers
 * stage's per-worker lines — an installed worker whose accounts are all enrolled, a failed
 * worker, and the workers never tried after it — and the phase-3 stages' output (repositories,
 * control plane, dispatch and the end-to-end verification), driven through the exported
 * `reportApply` over faithfully shaped `applied` results. A failed rollout returns before the
 * phase-3 stages run, so a `not_attempted` worker and the phase-3 outcomes never share one
 * apply; they are reported from two results here, each the shape the application produces.
 */
import { describe, expect, test } from "bun:test";
import { reportApply } from "../../src/cli/commands/apply";
import type { FactoryApply } from "../../src/application/apply-factory";
import type { ControlPlaneOutcome } from "../../src/application/apply-control-plane";
import type { DispatchOutcome } from "../../src/application/apply-dispatch";
import type { RepositoryOutcome } from "../../src/application/apply-repositories";
import { verifyFactory } from "../../src/application/verify-factory";
import type { HostKey } from "../../src/domain/instance";
import { HOST_PROTOCOL_VERSION } from "../../src/domain/protocol-fields";
import { ENROLLMENTS } from "../../src/domain/readiness";
import type { WorkerOutcome } from "../../src/domain/rollout";
import { harness } from "../support/cli-harness";
import { MemoryInstanceStore } from "../support/memory-instance-store";

const BUCKET = "fff-abcd1234-state";
const KEY = "fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json";

/** A worker's hostname, as the factory's resource naming makes it. */
const host = (key: string) => `fff-abcd1234-${key}`;

/** An installed worker whose every account is enrolled, so nothing is pending. */
function installed(key: string): WorkerOutcome {
  return {
    key: key as HostKey,
    hostname: host(key),
    kind: "installed",
    release: "0.3.0",
    verification: {
      protocol_version: HOST_PROTOCOL_VERSION,
      hostname: host(key),
      verified_at: "2026-09-30T12:00:00.000Z",
      checks: [],
      enrollment: ENROLLMENTS.map(({ id }) => ({ id, state: "enrolled" as const })),
    },
  };
}

/** The CLI context whose output this test reads, and an applied result over `fields`. */
function applied(fields: Partial<Extract<FactoryApply, { readonly kind: "applied" }>>) {
  const { context, out, err } = harness(new MemoryInstanceStore({}));
  const result: FactoryApply = {
    kind: "applied",
    bootstrapped: false,
    infrastructure: "unchanged",
    workers: [],
    operation: { bucket: BUCKET, key: KEY },
    recordFailure: undefined,
    ...fields,
  };
  return { context, out, err, result };
}

describe("fffactory apply, worker report (plan-apply §Apply)", () => {
  test("an installed worker all enrolled, a failed worker, and the workers never tried", () => {
    const { context, out, err, result } = applied({
      workers: [
        installed("builder-1"),
        {
          key: "builder-2" as HostKey,
          hostname: host("builder-2"),
          kind: "failed",
          summary:
            "Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
          nextAction: "Read its output and fix the cause, then rerun `fffactory apply`",
        },
        { key: "builder-3" as HostKey, hostname: host("builder-3"), kind: "not_attempted" },
      ],
    });

    // A failed worker stops the rollout: exit 1, with no verification to lift it to 2.
    expect(reportApply(result, context)).toBe(1);
    expect(out).toEqual([
      "Infrastructure: no changes to apply.",
      "Workers:",
      "  installed  builder-1 (fff-abcd1234-builder-1): release 0.3.0 installed and verified; every account is enrolled",
      "             Paseo clients: enrollment is checked from each client, not the worker",
      `Operation record: s3://${BUCKET}/${KEY}`,
    ]);
    expect(err).toEqual([
      "  failed     builder-2 (fff-abcd1234-builder-2): Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
      "             Next: Read its output and fix the cause, then rerun `fffactory apply`",
      "  not tried  builder-3 (fff-abcd1234-builder-3): the rollout stopped at the failure above",
    ]);
  });
});

describe("fffactory apply, phase-3 report (plan-apply §Apply)", () => {
  test.each([
    [
      "repositories" as const,
      "Repository synchronization failed",
      "Completed repository changes were left in place.",
    ],
    ["control-plane" as const, "Control-plane reconciliation failed", undefined],
    ["dispatch" as const, "Dispatch reconciliation failed", undefined],
    ["verification" as const, "End-to-end verification failed", undefined],
  ])(
    "reports a %s stage failure with its safe recovery boundary",
    (step, headline, consequence) => {
      const { context, out, err } = harness(new MemoryInstanceStore({}));
      const result: FactoryApply = {
        kind: "failed",
        step,
        reason: "the worker returned an invalid result",
        diagnosticsFile: undefined,
        operation: { bucket: BUCKET, key: KEY },
        recordFailure: undefined,
      };

      expect(reportApply(result, context)).toBe(1);
      expect(err[0]).toStartWith(headline);
      if (consequence !== undefined) expect(err).toContain(consequence);
      expect(err.at(-1)?.toLowerCase()).toContain("rerun `fffactory apply`");
      expect(out).toEqual([`Operation record: s3://${BUCKET}/${KEY}`]);
    },
  );

  test("a failed control-plane action fails apply even without dispatch verification", () => {
    const { context, result } = applied({
      workers: [installed("builder-1")],
      controlPlane: [
        {
          key: "builder-1" as HostKey,
          hostname: host("builder-1"),
          kind: "failed",
          summary: "Paseo installation failed",
          nextAction: "Fix Paseo, then rerun apply",
        },
      ],
    });
    expect(reportApply(result, context)).toBe(1);
  });

  test("a genuine dispatch gate deferral exits 2, while reconciliation failure exits 1", () => {
    const pending: DispatchOutcome = {
      key: "builder-1" as HostKey,
      hostname: host("builder-1"),
      kind: "pending",
      gates: [],
      blocking: [],
      summary: "Dispatch pending",
      nextActions: ["Enroll GitHub"],
    };
    const pendingResult = applied({ workers: [installed("builder-1")], dispatch: [pending] });
    expect(reportApply(pendingResult.result, pendingResult.context)).toBe(2);

    const failed: DispatchOutcome = {
      key: "builder-1" as HostKey,
      hostname: host("builder-1"),
      kind: "failed",
      summary: "Schedule reconciliation failed",
      nextAction: "Repair Paseo",
    };
    const failedResult = applied({ workers: [installed("builder-1")], dispatch: [failed] });
    expect(reportApply(failedResult.result, failedResult.context)).toBe(1);

    // A worker sent nothing because an earlier stage skipped it is not a failure (#134).
    const skipped: DispatchOutcome = {
      key: "builder-1" as HostKey,
      hostname: host("builder-1"),
      kind: "skipped",
      reason: "unreachable",
      summary: "Offline in the tailnet",
      nextAction: "Check the worker, then rerun `fffactory apply`",
    };
    const skippedResult = applied({ workers: [installed("builder-1")], dispatch: [skipped] });
    expect(reportApply(skippedResult.result, skippedResult.context)).toBe(2);
  });

  test("reports every repository, control-plane, dispatch and verification branch", () => {
    // builder-5's Paseo maintenance was deferred: the workers stage skipped it (#134).
    const close = `Close the active agents on ${host("builder-5")}, then rerun \`fffactory apply\``;
    const deferral = "Paseo maintenance is deferred while agents may be active";
    const workers: WorkerOutcome[] = [
      ...["builder-1", "builder-2", "builder-3", "builder-4"].map(installed),
      {
        key: "builder-5" as HostKey,
        hostname: host("builder-5"),
        kind: "skipped",
        summary: deferral,
        nextAction: close,
      },
    ];
    const repositories: RepositoryOutcome[] = [
      {
        key: "builder-1" as HostKey,
        hostname: host("builder-1"),
        kind: "synchronized",
        unmanaged: [],
      },
      {
        key: "builder-2" as HostKey,
        hostname: host("builder-2"),
        kind: "unresolved",
        unmanaged: [],
        summary: "builder-2 has divergent checkouts",
        nextAction: "Resolve them, then rerun `fffactory apply`",
      },
    ];
    const controlPlane: ControlPlaneOutcome[] = [
      {
        key: "builder-1" as HostKey,
        hostname: host("builder-1"),
        kind: "applied",
        live: [],
        reloaded: false,
        restarted: false,
      },
      {
        key: "builder-5" as HostKey,
        hostname: host("builder-5"),
        kind: "deferred",
        pending: ["password"],
        reloaded: false,
        summary: "Maintenance (password) was deferred while agents may be active",
        nextAction: close,
      },
    ];
    const dispatch: DispatchOutcome[] = [
      {
        key: "builder-1" as HostKey,
        hostname: host("builder-1"),
        kind: "active",
        changed: true,
        gates: [],
      },
      { key: "builder-4" as HostKey, hostname: host("builder-4"), kind: "not_requested" },
      {
        key: "builder-3" as HostKey,
        hostname: host("builder-3"),
        kind: "failed",
        summary: "Reconciling dispatch failed",
        nextAction: "Check paseo.service, then rerun `fffactory apply`",
      },
      {
        key: "builder-2" as HostKey,
        hostname: host("builder-2"),
        kind: "pending",
        gates: [],
        blocking: [],
        summary: "Dispatch pending",
        nextActions: [
          "Enroll GitHub on fff-abcd1234-builder-2",
          "Synchronize repositories on fff-abcd1234-builder-2",
        ],
      },
      {
        key: "builder-5" as HostKey,
        hostname: host("builder-5"),
        kind: "skipped",
        reason: "deferred",
        summary: deferral,
        nextAction: close,
      },
    ];
    const verification = verifyFactory({ workers, repositories, controlPlane, dispatch });
    const { context, out, err, result } = applied({
      infrastructure: "applied",
      workers,
      repositories,
      controlPlane,
      dispatch,
      verification,
    });

    // A failed live dispatch reconciliation makes the command fail, even though other gaps are pending.
    expect(verification.ready).toBe(false);
    expect(reportApply(result, context)).toBe(1);
    expect(err).toEqual([]);

    const ready = verification.workers.find((worker) => worker.ready);
    const notReady = verification.workers.filter((worker) => !worker.ready);
    expect(ready?.summary).toBe("fff-abcd1234-builder-1 is ready and dispatching");
    expect(out).toEqual([
      "Applied: the factory's infrastructure matches factory.json.",
      "Workers:",
      ...["builder-1", "builder-2", "builder-3", "builder-4"].flatMap((key) => [
        `  installed  ${key} (${host(key)}): release 0.3.0 installed and verified; every account is enrolled`,
        "             Paseo clients: enrollment is checked from each client, not the worker",
      ]),
      `  skipped    builder-5 (${host("builder-5")}): ${deferral}`,
      `             Next: ${close}`,
      "Repositories:",
      "  synchronized  builder-1 (fff-abcd1234-builder-1)",
      "  unresolved  builder-2 (fff-abcd1234-builder-2): builder-2 has divergent checkouts",
      "    Next: Resolve them, then rerun `fffactory apply`",
      "Control plane:",
      "  applied  builder-1 (fff-abcd1234-builder-1)",
      "  deferred  builder-5 (fff-abcd1234-builder-5): Maintenance (password) was deferred while agents may be active",
      `    Next: ${close}`,
      "Dispatch:",
      "  active  builder-1 (fff-abcd1234-builder-1)",
      "  not requested  builder-4 (fff-abcd1234-builder-4)",
      "  failed  builder-3 (fff-abcd1234-builder-3): Reconciling dispatch failed",
      "    Next: Check paseo.service, then rerun `fffactory apply`",
      "  pending  builder-2 (fff-abcd1234-builder-2)",
      "    Enroll GitHub on fff-abcd1234-builder-2",
      "    Synchronize repositories on fff-abcd1234-builder-2",
      `  skipped  builder-5 (fff-abcd1234-builder-5): ${deferral}`,
      `    Next: ${close}`,
      `End-to-end verification: ${verification.summary}`,
      ...notReady.map((worker) => `  ${worker.summary}`),
      `Operation record: s3://${BUCKET}/${KEY}`,
    ]);
    // The ready worker is not among the lines the verification stage prints.
    expect(out).not.toContain(`  ${ready?.summary}`);
  });
});
