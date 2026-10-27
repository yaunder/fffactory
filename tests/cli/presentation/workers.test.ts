import { describe, expect, test } from "bun:test";
import type { ControlPlaneOutcome } from "../../../src/application/apply-control-plane";
import type { DispatchOutcome } from "../../../src/application/apply-dispatch";
import type { RepositoryOutcome } from "../../../src/application/apply-repositories";
import { type Row, render } from "../../../src/cli/presentation/blocks";
import {
  enrollmentSteps,
  workerEnrollmentOf,
  workerRow,
} from "../../../src/cli/presentation/workers";
import { plainStyle } from "../../../src/cli/presentation/style";
import type { HostKey } from "../../../src/domain/instance";
import {
  ENROLLMENTS,
  type EnrollmentId,
  type EnrollmentState,
  type Verification,
} from "../../../src/domain/readiness";
import { stoppedOutcome, type WorkerOutcome } from "../../../src/domain/rollout";

const HOST = "fff-abcd1234-builder-1";
const WORKER = { key: "builder-1" as HostKey, hostname: HOST };

function installed(
  state: (id: string) => EnrollmentState,
  delivered: readonly EnrollmentId[] = [],
): WorkerOutcome {
  const verification: Verification = {
    protocol_version: 1,
    hostname: "attacker",
    verified_at: "2026-09-30T12:00:00.000Z",
    checks: [],
    enrollment: ENROLLMENTS.map(({ id }) => ({ id, state: state(id) })),
  };
  return { ...WORKER, kind: "installed", release: "0.3.0", verification, delivered };
}

const ENROLLED = installed(() => "enrolled");
const pendingUnlessOpenai = (id: string) => (id === "openai" ? "enrolled" : "pending");
const PENDING = installed(pendingUnlessOpenai);

/** A worker's row, alone in its block, as plain text. */
const lines = (row: Row) => render(plainStyle, [{ kind: "rows", rows: [row] }]);

const applied: ControlPlaneOutcome = {
  ...WORKER,
  kind: "applied",
  live: [],
  reloaded: false,
  restarted: false,
};
const synchronized: RepositoryOutcome = { ...WORKER, kind: "synchronized", unmanaged: [] };
const notRequested: DispatchOutcome = { ...WORKER, kind: "not_requested" };

describe("a worker's result row (plan and apply §Apply)", () => {
  test("installed with accounts to enroll: action needed, never a ready glyph", () => {
    expect(lines(workerRow(PENDING, {}, {}))).toEqual([
      "! builder-1   installed and verified · enrollment pending (2)",
    ]);
  });

  test("installed and enrolled, every later stage under it: ready", () => {
    const row = workerRow(
      ENROLLED,
      { controlPlane: applied, repositories: synchronized, dispatch: notRequested },
      {},
    );
    expect(lines(row)).toEqual([
      "✔ builder-1   installed and verified · every account enrolled",
      "  ✔ Control plane   applied",
      "  ✔ Repositories    synchronized",
      "    Dispatch        not requested",
    ]);
  });

  test("installed and enrolled is not ready while a later stage is pending or failed", () => {
    const pending: DispatchOutcome = {
      ...WORKER,
      kind: "pending",
      gates: [],
      blocking: [
        {
          gate: "ffflow_adoption",
          passed: false,
          summary: `A placed repository on ${HOST} does not pass FFFlow adoption`,
          nextAction: "Adopt FFFlow",
        },
      ],
      summary: "Dispatch: pending",
      nextActions: [`A placed repository on ${HOST} does not pass FFFlow adoption: Adopt FFFlow`],
    };
    expect(lines(workerRow(ENROLLED, { controlPlane: applied, dispatch: pending }, {}))).toEqual([
      "! builder-1   installed and verified · every account enrolled",
      "  ✔ Control plane   applied",
      `  ! Dispatch        pending · A placed repository on ${HOST} does not pass FFFlow adoption`,
    ]);
    const failed: DispatchOutcome = {
      ...WORKER,
      kind: "failed",
      summary: "Reconciling dispatch failed",
      nextAction: "Check paseo.service, then rerun `fffactory apply`",
    };
    expect(lines(workerRow(ENROLLED, { controlPlane: applied, dispatch: failed }, {}))).toEqual([
      "✖ builder-1   installed and verified · every account enrolled",
      "  ✔ Control plane   applied",
      "  ✖ Dispatch        failed · Reconciling dispatch failed",
    ]);
  });

  test("a deferred control plane and unresolved repositories need action", () => {
    const deferred: ControlPlaneOutcome = {
      ...WORKER,
      kind: "deferred",
      pending: ["password"],
      reloaded: false,
      summary: "Maintenance (password) was deferred while agents may be busy",
      nextAction: "Close the agents",
    };
    const unresolved: RepositoryOutcome = {
      ...WORKER,
      kind: "unresolved",
      unmanaged: [],
      summary: "1 checkout is divergent",
      nextAction: "Resolve it",
    };
    expect(
      lines(workerRow(ENROLLED, { controlPlane: deferred, repositories: unresolved }, {})),
    ).toEqual([
      "! builder-1   installed and verified · every account enrolled",
      "  ! Control plane   deferred · Maintenance (password) was deferred while agents may be busy",
      "  ! Repositories    unresolved · 1 checkout is divergent",
    ]);
  });

  test("skipped: its reason, and a later stage's skip for the same reason says no more", () => {
    const outcome: WorkerOutcome = {
      ...WORKER,
      kind: "skipped",
      summary: "Offline in the tailnet",
      nextAction: "Start it, then rerun `fffactory apply`.",
    };
    const repositories: RepositoryOutcome = {
      ...WORKER,
      kind: "skipped",
      summary: "Offline in the tailnet",
      nextAction: "Start it, then rerun `fffactory apply`.",
    };
    const dispatch: DispatchOutcome = {
      ...WORKER,
      kind: "skipped",
      reason: "unreachable",
      summary: "Not located in the tailnet",
      nextAction: "Start it, then rerun `fffactory apply`.",
    };
    expect(lines(workerRow(outcome, { repositories, dispatch }, {}))).toEqual([
      "↷ builder-1   skipped · Offline in the tailnet",
      "  ↷ Repositories    skipped",
      "  ↷ Dispatch        skipped · Not located in the tailnet",
    ]);
  });

  test("failed: its summary as data, never read for inline code", () => {
    const outcome: WorkerOutcome = {
      ...WORKER,
      kind: "failed",
      summary: "host apply refused: `odd` message",
      nextAction: "Fix what host apply names, then rerun `fffactory apply`.",
    };
    expect(lines(workerRow(outcome, {}, {}))).toEqual([
      "✖ builder-1   failed · host apply refused: `odd` message",
    ]);
  });

  test("not attempted after a failure", () => {
    expect(lines(workerRow({ ...WORKER, kind: "not_attempted" }, {}, {}))).toEqual([
      "◌ builder-1   not attempted · the rollout stopped at the failure above",
    ]);
  });

  test("stopped: an intentional state, how to install it naming the instance and profile given", () => {
    const row = workerRow(
      stoppedOutcome(WORKER),
      { repositories: { ...WORKER, kind: "stopped" }, dispatch: { ...WORKER, kind: "stopped" } },
      { instance: "/work/my factory.json", profile: "factory" },
    );
    expect(lines(row)).toEqual([
      "◼ builder-1   stopped · nothing was sent to it; to install it, start it with " +
        "`fffactory worker start builder-1 --instance '/work/my factory.json' --profile factory`, " +
        "then apply again",
    ]);
  });
});

describe("a worker's enrollment (readiness §Where it is reported)", () => {
  test("only an installed worker has one, named for the hostname the CLI resolved", () => {
    expect(workerEnrollmentOf(PENDING)).toEqual({
      hostname: HOST,
      login: `tailscale ssh factory@${HOST}`,
      requirement: "tailnet_ssh_as_runtime",
      accounts: [
        {
          id: "github",
          title: "GitHub",
          commands: [
            "gh auth login --hostname github.com --git-protocol https --web",
            "gh auth status --hostname github.com --active",
          ],
        },
        {
          id: "anthropic",
          title: "Claude Code",
          commands: ["claude auth login", "claude auth status"],
        },
      ],
      delivered: [],
    });
    expect(workerEnrollmentOf(ENROLLED)?.accounts).toEqual([]);
    expect(workerEnrollmentOf({ ...WORKER, kind: "not_attempted" })).toBeUndefined();
  });

  test("a delivered account is grouped apart from the login, from the outcome's delivered set", () => {
    const enrollment = workerEnrollmentOf(installed(pendingUnlessOpenai, ["github"]));
    expect(enrollment?.accounts.map(({ id }) => id)).toEqual(["anthropic"]);
    expect(enrollment?.delivered).toEqual([
      { id: "github", title: "GitHub", credential: "GitHub token", secret: "github-token" },
    ]);
  });

  test("the login once with its caveat, then each account numbered with its command lines", () => {
    const enrollment = workerEnrollmentOf(PENDING);
    if (enrollment === undefined) throw new Error("no enrollment");
    const steps = (named: boolean) =>
      render(plainStyle, [], { paragraphs: enrollmentSteps(enrollment, "builder-1", named) });
    expect(steps(false)).toEqual([
      "── Next ─────────────────────────────────────────────",
      "  Log in as factory (tailnet SSH policy must allow it):",
      `    $ tailscale ssh factory@${HOST}`,
      "",
      "  1. GitHub",
      "     $ gh auth login --hostname github.com --git-protocol https --web",
      "     $ gh auth status --hostname github.com --active",
      "  2. Claude Code",
      "     $ claude auth login",
      "     $ claude auth status",
    ]);
    expect(steps(true)[1]).toBe(
      "  On builder-1, log in as factory (tailnet SSH policy must allow it):",
    );
  });
});
