/**
 * How `fffactory apply` reports what each stage left (plan-apply §Apply): the exit code of every
 * outcome, and each line on its stream, in the order written, through the exported
 * `reportApply` over faithfully shaped results. A failed rollout returns before the phase-3
 * stages run, so a `not_attempted` worker and the phase-3 outcomes never share one apply; they
 * are reported from two results here, each the shape the application produces. The layout of
 * every outcome is `tests/cli/presentation/apply.test.ts`'s.
 */
import { describe, expect, test } from "bun:test";
import { reportApply } from "../../src/cli/commands/apply";
import type { ApplyReporting } from "../../src/cli/presentation/apply";
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

/** A plain apply's reporting, given no instance or profile. */
const APPLYING: ApplyReporting = { action: "apply", rerun: "apply", selection: {} };

const BUCKET = "fff-abcd1234-state";
const KEY = "fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json";
const RECORD = `s3://${BUCKET}/${KEY}`;
const rule = (title: string) => `── ${title} ${"─".repeat(Math.max(2, 49 - title.length))}`;
const NEXT = rule("Next");

/** A worker's hostname, as the factory's resource naming makes it. */
const host = (key: string) => `fff-abcd1234-${key}`;

/** An installed worker whose accounts are enrolled unless `pending` names them. */
function installed(key: string, pending: readonly string[] = []): WorkerOutcome {
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
      enrollment: ENROLLMENTS.map(({ id }) => ({
        id,
        state: pending.includes(id) ? ("pending" as const) : ("enrolled" as const),
      })),
    },
  };
}

/** The CLI context whose output this test reads, and an applied result over `fields`. */
function applied(fields: Partial<Extract<FactoryApply, { readonly kind: "applied" }>>) {
  const cli = harness(new MemoryInstanceStore({}));
  const result: FactoryApply = {
    kind: "applied",
    bootstrapped: false,
    infrastructure: "unchanged",
    workers: [],
    operation: { bucket: BUCKET, key: KEY },
    recordFailure: undefined,
    ...fields,
  };
  return { ...cli, result };
}

describe("fffactory apply, worker report (plan-apply §Apply)", () => {
  test("a failed rollout: each line on its stream, in order, the failed worker's next action on standard error", () => {
    const readLog = "Read its output and fix the cause, then rerun `fffactory apply`";
    const { context, out, err, written, result } = applied({
      workers: [
        installed("builder-1", ["github"]),
        {
          key: "builder-2" as HostKey,
          hostname: host("builder-2"),
          kind: "failed",
          summary:
            "Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
          nextAction: readLog,
        },
        { key: "builder-3" as HostKey, hostname: host("builder-3"), kind: "not_attempted" },
      ],
    });

    // A failed worker stops the rollout: exit 1, with no verification to lift it to 2.
    expect(reportApply(result, context, APPLYING)).toBe(1);
    expect(out.slice(0, 5)).toEqual([
      "",
      rule("Result"),
      "    Infrastructure     no changes",
      "  ! builder-1          installed and verified · enrollment pending (1)",
      `    Operation record   ${RECORD}`,
    ]);
    const enrollment = [
      "",
      "  On builder-1, log in as factory (tailnet SSH policy must allow it):",
      `    $ tailscale ssh factory@${host("builder-1")}`,
      "",
      "  1. GitHub",
      "     $ gh auth login --hostname github.com --git-protocol https --web",
      "     $ gh auth status",
      "",
      "  Return to your workstation:",
      "    $ exit",
      "  Refresh enrollment verification, reviewing the new plan:",
      "    $ fffactory apply",
      "  Then confirm:",
      "    $ fffactory status",
      "  Paseo clients: enrollment is checked from each client, not the worker",
    ];
    // The failed worker's row and its next action on standard error, as they always were; the
    // enrollment on standard output, as an installed worker's always was.
    expect(out.slice(5)).toEqual(enrollment);
    expect(err).toEqual([
      "  ✖ builder-2          failed · Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
      "  ◌ builder-3          not attempted · the rollout stopped at the failure above",
      "",
      NEXT,
      `  builder-2: ${readLog}`,
    ]);
    // Written in the Result's order across both streams, the record before the Next block.
    expect(written.slice(0, 8)).toEqual([
      { stream: "out", line: "" },
      { stream: "out", line: rule("Result") },
      { stream: "out", line: "    Infrastructure     no changes" },
      {
        stream: "out",
        line: "  ! builder-1          installed and verified · enrollment pending (1)",
      },
      {
        stream: "err",
        line: "  ✖ builder-2          failed · Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
      },
      {
        stream: "err",
        line: "  ◌ builder-3          not attempted · the rollout stopped at the failure above",
      },
      { stream: "out", line: `    Operation record   ${RECORD}` },
      { stream: "err", line: "" },
    ]);
    expect(written.slice(8, 11)).toEqual([
      { stream: "err", line: NEXT },
      { stream: "err", line: `  builder-2: ${readLog}` },
      { stream: "out", line: "" },
    ]);
    expect(written.filter(({ line }) => line === NEXT)).toHaveLength(1);
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

      expect(reportApply(result, context, APPLYING)).toBe(1);
      expect(err[2]).toBe(`  ✖ ${headline}: the worker returned an invalid result`);
      if (consequence !== undefined) expect(err[3]).toBe(`    ${consequence}`);
      expect(err.slice(-2)).toEqual([
        "  Rerun: it plans again from what exists now and converges what remains:",
        "    $ fffactory apply",
      ]);
      expect(out).toEqual(["", `  Operation record   ${RECORD}`]);
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
    expect(reportApply(result, context, APPLYING)).toBe(1);
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
    expect(reportApply(pendingResult.result, pendingResult.context, APPLYING)).toBe(2);
    // Not a failure: its Next block stays on standard output.
    expect(pendingResult.err).toEqual([]);
    expect(pendingResult.out).toContain("  builder-1: Enroll GitHub");

    const failed: DispatchOutcome = {
      key: "builder-1" as HostKey,
      hostname: host("builder-1"),
      kind: "failed",
      summary: "Schedule reconciliation failed",
      nextAction: "Repair Paseo",
    };
    const failedResult = applied({ workers: [installed("builder-1")], dispatch: [failed] });
    expect(reportApply(failedResult.result, failedResult.context, APPLYING)).toBe(1);
    // A failure, but a stage's next action stays on standard output, where it always was.
    expect(failedResult.err).toEqual([]);
    expect(failedResult.out.slice(-4)).toEqual([
      "",
      NEXT,
      "  builder-1: Repair Paseo",
      "  Paseo clients: enrollment is checked from each client, not the worker",
    ]);

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
    expect(reportApply(skippedResult.result, skippedResult.context, APPLYING)).toBe(2);
  });

  test("every repository, control-plane, dispatch and verification branch, each action once", () => {
    // builder-5's Paseo maintenance was deferred: the workers stage skipped it (#134).
    const close = `Close the active agents on ${host("builder-5")}, then rerun \`fffactory apply\``;
    const deferral = "Paseo maintenance is deferred while agents may be active";
    const workers: WorkerOutcome[] = [
      ...["builder-1", "builder-2", "builder-3", "builder-4"].map((key) => installed(key)),
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
        nextActions: [`Adopt FFFlow on ${host("builder-2")}`],
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
    expect(reportApply(result, context, APPLYING)).toBe(1);
    expect(out).toEqual([
      "",
      rule("Result"),
      "    Infrastructure     applied: matches factory.json",
      "  ✔ builder-1          installed and verified · every account enrolled",
      "    ✔ Control plane   applied",
      "    ✔ Repositories    synchronized",
      "    ✔ Dispatch        active",
      "  ! builder-2          installed and verified · every account enrolled",
      "    ! Repositories    unresolved · builder-2 has divergent checkouts",
      "    ! Dispatch        pending",
      "  ✖ builder-3          installed and verified · every account enrolled",
      "    ✖ Dispatch        failed · Reconciling dispatch failed",
      "  ✔ builder-4          installed and verified · every account enrolled",
      "      Dispatch        not requested",
      `  ! builder-5          skipped · ${deferral}`,
      "    ! Control plane   deferred · Maintenance (password) was deferred while agents may be active",
      "    ↷ Dispatch        skipped",
      `  ! Verification       ${verification.summary}`,
      `    Operation record   ${RECORD}`,
      // Every stage's next action once, in the stages' order: the deferral three stages name, once.
      "",
      NEXT,
      `  builder-5: ${close}`,
      "  builder-2: Resolve them, then rerun `fffactory apply`",
      "  builder-3: Check paseo.service, then rerun `fffactory apply`",
      `  builder-2: Adopt FFFlow on ${host("builder-2")}`,
      "  Paseo clients: enrollment is checked from each client, not the worker",
    ]);
    expect(err).toEqual([]);
  });
});
