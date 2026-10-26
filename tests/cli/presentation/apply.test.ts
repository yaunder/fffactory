/**
 * Apply's and upgrade's run as text (plan-apply §Apply, §Failure, §Interruption, §Upgrade): the
 * Applying rows streamed as they come, the Result laid out from the complete `FactoryApply`, each
 * line on the stream it goes to, and the one Next block that collects what every stage leaves
 * for the operator, after the record and any pin notice.
 */
import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { FactoryApply } from "../../../src/application/apply-factory";
import type { ControlPlaneOutcome } from "../../../src/application/apply-control-plane";
import type { DispatchOutcome } from "../../../src/application/apply-dispatch";
import type { RepositoryOutcome } from "../../../src/application/apply-repositories";
import { verifyFactory } from "../../../src/application/verify-factory";
import {
  type ApplyReporting,
  appliedLines,
  applyingLabelWidth,
  applyingRow,
  applyingSection,
  bootstrappedLines,
  failedLines,
  infrastructureApplyingRow,
  interruptedLines,
  pinNotice,
  pinnedRow,
  progressRow,
  refusedRunReport,
  type StreamLine,
} from "../../../src/cli/presentation/apply";
import { render, renderInSection } from "../../../src/cli/presentation/blocks";
import { instanceHeader } from "../../../src/cli/presentation/instance-source";
import { reviewBlocks } from "../../../src/cli/presentation/plan";
import { ansiStyle, plainStyle } from "../../../src/cli/presentation/style";
import {
  dispatchNextActions,
  dispatchState,
  describeDispatch,
} from "../../../src/domain/dispatch-readiness";
import type { FactoryId, HostKey, Release } from "../../../src/domain/instance";
import type { FactoryPlanReview, PlanReview } from "../../../src/domain/plan";
import { HOST_PROTOCOL_VERSION } from "../../../src/domain/protocol-fields";
import { ENROLLMENTS, type EnrollmentState } from "../../../src/domain/readiness";
import { stoppedOutcome, type WorkerOutcome } from "../../../src/domain/rollout";

type Applied = Extract<FactoryApply, { readonly kind: "applied" }>;

const PLAIN = { out: plainStyle, err: plainStyle };
const APPLY: ApplyReporting = { action: "apply", rerun: "apply", selection: {} };
const SELECTED: ApplyReporting = {
  ...APPLY,
  selection: { instance: "/work/my factory.json", profile: "factory" },
};
const FLAGS = "--instance '/work/my factory.json' --profile factory";

/** A section's rule line, 53 columns wide, as `render` draws it. */
const rule = (title: string) => `── ${title} ${"─".repeat(Math.max(2, 49 - title.length))}`;
const RESULT = rule("Result");
const NEXT = rule("Next");
const PASEO = "  Paseo clients: enrollment is checked from each client, not the worker";

const BUCKET = "fff-abcd1234-state";
const RECORD = `s3://${BUCKET}/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json`;
const host = (key: string) => `fff-abcd1234-${key}`;
const worker = (key: string) => ({ key: key as HostKey, hostname: host(key) });

/** An installed worker whose accounts are enrolled unless `pending` names them. */
function installed(key: string, pending: readonly string[] = [], hostname = host(key)) {
  return {
    key: key as HostKey,
    hostname,
    kind: "installed",
    release: "0.3.0",
    verification: {
      protocol_version: HOST_PROTOCOL_VERSION,
      hostname,
      verified_at: "2026-09-30T12:00:00.000Z",
      checks: [],
      enrollment: ENROLLMENTS.map(({ id }) => ({
        id,
        state: (pending.includes(id) ? "pending" : "enrolled") as EnrollmentState,
      })),
    },
    delivered: [],
  } as const satisfies WorkerOutcome;
}
const ALL = ["github", "openai", "anthropic"];

const appliedPlane = (key: string): ControlPlaneOutcome => ({
  ...worker(key),
  kind: "applied",
  live: [],
  reloaded: false,
  restarted: false,
});
const synchronized = (key: string): RepositoryOutcome => ({
  ...worker(key),
  kind: "synchronized",
  unmanaged: [],
});

/** An applied result over `fields`, verified end to end from its stages when they ran. */
function applied(fields: Partial<Applied>): Applied {
  const base: Applied = {
    kind: "applied",
    bootstrapped: false,
    infrastructure: "unchanged",
    workers: [],
    operation: {
      bucket: BUCKET,
      key: "fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json",
    },
    recordFailure: undefined,
    ...fields,
  };
  if (base.controlPlane === undefined || "verification" in fields) return base;
  return {
    ...base,
    verification: verifyFactory({
      workers: base.workers,
      repositories: base.repositories ?? [],
      controlPlane: base.controlPlane,
      dispatch: base.dispatch ?? [],
    }),
  };
}

/** Each stream's lines, and every line in the order written. */
function streams(lines: readonly StreamLine[]) {
  return {
    out: lines.filter(({ stream }) => stream === "out").map(({ line }) => line),
    err: lines.filter(({ stream }) => stream === "err").map(({ line }) => line),
    all: lines.map(({ line }) => line),
  };
}

/** How each enrollment numbered group reads. */
const GITHUB = [
  "  1. GitHub",
  "     $ gh auth login --hostname github.com --git-protocol https --web",
  "     $ gh auth status --hostname github.com --active",
];
const THREE = [
  ...GITHUB,
  "  2. OpenAI Codex",
  "     $ codex login --device-auth",
  "     $ codex login status",
  "  3. Claude Code",
  "     $ claude auth login",
  "     $ claude auth status",
];
const closing = (flags = "") => [
  "  Return to your workstation:",
  "    $ exit",
  "  Refresh enrollment verification, reviewing the new plan:",
  `    $ fffactory apply${flags}`,
  "  Then confirm:",
  `    $ fffactory status${flags}`,
  PASEO,
];

describe("the motivating run (plan-apply §Apply)", () => {
  const KEY = "test-builder-1" as HostKey;
  const HOST = "fff-aaaa1111-test-builder-1";
  const review: FactoryPlanReview = {
    kind: "factory",
    target: {
      instancePath: "/home/operator/test-factory/.fffactory/factory.json",
      name: "Test factory",
      factoryId: "fff-aaaa1111" as FactoryId,
      accountId: "123456789012",
      region: "us-east-1",
      release: "0.0.0" as Release,
    },
    changes: [],
    workers: [{ key: KEY, hostname: HOST }],
    controlPlane: [
      {
        key: KEY,
        hostname: HOST,
        observation: "no-release",
        changes: ["paseo-package", "service-definition", "listen-address", "password"],
      },
    ],
    repositories: [{ key: KEY, hostname: HOST, placed: [] }],
    dispatch: [{ key: KEY, hostname: HOST, requested: false, schedule: null }],
    stopped: [],
  };
  const workers = [{ ...installed(KEY, ALL, HOST), release: "0.0.0" }];
  const result = applied({
    workers,
    repositories: [{ key: KEY, hostname: HOST, kind: "synchronized", unmanaged: [] }],
    controlPlane: [
      { key: KEY, hostname: HOST, kind: "applied", live: [], reloaded: false, restarted: false },
    ],
    dispatch: [{ key: KEY, hostname: HOST, kind: "not_requested" }],
    operation: {
      bucket: "fff-aaaa1111-state",
      key: "fff-aaaa1111-operations/2026-10-05T16:05:52.256Z-mlrqnb5n.json",
    },
  });
  const width = applyingLabelWidth(review);
  const progress = [
    progressRow({ key: KEY, hostname: HOST, kind: "uploading", bytes: 37_013_094 }),
    progressRow({ key: KEY, hostname: HOST, kind: "installing" }),
  ];

  /** The run as a terminal shows it: the operator's typed answer after the question. */
  function run(style: typeof plainStyle): string[] {
    return [
      ...render(style, [
        instanceHeader(
          "apply",
          "0.0.0",
          { found: true, path: review.target.instancePath, source: "nearest" },
          "/home/operator",
        ),
      ]),
      "",
      ...render(style, reviewBlocks(review, {})),
      "",
      'Apply this plan? Only "yes" applies it: yes',
      "",
      ...render(style, [applyingSection()]),
      ...progress.flatMap((row) => renderInSection(style, [applyingRow(row, width)])),
      ...appliedLines(result, APPLY, { out: style, err: style }).map(({ line }) => line),
    ];
  }

  test("renders as the spec's example: Applying, the complete Result, then one Next block", () => {
    expect(run(plainStyle)).toEqual([
      "fffactory apply · release 0.0.0",
      "Instance  ~/test-factory/.fffactory/factory.json (nearest .fffactory/factory.json)",
      "",
      "── Plan ─────────────────────────────────────────────",
      "  Factory   Test factory (fff-aaaa1111)",
      "  Account   123456789012 · us-east-1",
      "  Release   0.0.0",
      "",
      "  Infrastructure   no changes",
      "  Workers          one at a time",
      "    ~ test-builder-1   install release 0.0.0 and host configuration, then verify",
      "  Control plane    before worker activation",
      "    ~ test-builder-1   paseo-package, service-definition, listen-address, password",
      "  Repositories     one worker at a time",
      "    ~ test-builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
      "  Dispatch         after every readiness gate",
      "    ~ test-builder-1   remove the factory dispatch schedule if it exists",
      "  Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule",
      "",
      'Apply this plan? Only "yes" applies it: yes',
      "",
      "── Applying ─────────────────────────────────────────",
      "  test-builder-1   uploading 35.3 MiB",
      "  test-builder-1   installing and verifying (can take many minutes)",
      "",
      "── Result ───────────────────────────────────────────",
      "    Infrastructure     no changes",
      "  ! test-builder-1     installed and verified · enrollment pending (3)",
      "    ✔ Control plane   applied",
      "    ✔ Repositories    synchronized",
      "      Dispatch        not requested",
      "  ! Verification       The factory is ready: every worker is verified end to end · enrollment pending on 1 worker",
      "    Operation record   s3://fff-aaaa1111-state/fff-aaaa1111-operations/2026-10-05T16:05:52.256Z-mlrqnb5n.json",
      "",
      "── Next: enroll 3 accounts on test-builder-1 ────────",
      "  Log in as factory (tailnet SSH policy must allow it):",
      "    $ tailscale ssh factory@fff-aaaa1111-test-builder-1",
      "",
      ...THREE,
      "",
      ...closing(),
    ]);
  });

  test("every line of it goes to standard output", () => {
    const lines = appliedLines(result, APPLY, PLAIN);
    expect(lines.every(({ stream }) => stream === "out")).toBe(true);
  });

  test("in color: rules dim, `!` and enrollment pending yellow, ✔ green, commands bold cyan", () => {
    const ESC = "\x1b";
    const colored = run(ansiStyle);
    expect(colored).toContain(
      `  ${ansiStyle.glyph("attention")} ${ansiStyle.label("test-builder-1")}     ` +
        `installed and verified · ${ansiStyle.status("attention", "enrollment pending (3)")}`,
    );
    expect(colored).toContain(
      `    ${ansiStyle.glyph("ready")} ${ansiStyle.label("Control plane")}   applied`,
    );
    expect(colored).toContain(
      `  ${ansiStyle.glyph("attention")} ${ansiStyle.label("Verification")}       ` +
        "The factory is ready: every worker is verified end to end" +
        ansiStyle.status("attention", " · enrollment pending on 1 worker"),
    );
    expect(colored).toContain(`    ${ansiStyle.command("fffactory apply")}`);
    expect(colored).toContain(
      `${ansiStyle.rule("──")} ${ansiStyle.heading("Next: enroll 3 accounts on test-builder-1")} ${ansiStyle.rule("────────")}`,
    );
    expect(colored).toContain(`  ${ansiStyle.muted(PASEO.trim())}`);
    expect(ansiStyle.glyph("ready")).toBe(`${ESC}[32m✔${ESC}[39m`);
    expect(colored.map((line) => stripVTControlCharacters(line))).toEqual(run(plainStyle));
  });
});

describe("the Applying section (plan-apply §Apply, §Waiting for a new worker)", () => {
  const review: FactoryPlanReview = {
    kind: "factory",
    target: {
      instancePath: "/work/.fffactory/factory.json",
      name: "Test factory",
      factoryId: "fff-abcd1234" as FactoryId,
      accountId: "123456789012",
      region: "eu-west-2",
      release: "0.3.0" as Release,
    },
    changes: [{ address: 'module.hosts.aws_instance.host["builder-1"]', actions: ["create"] }],
    workers: [worker("builder-1")],
    controlPlane: [],
    repositories: [],
    dispatch: [],
    stopped: [],
  };
  const rows = (review: PlanReview, ...more: ReturnType<typeof pinnedRow>[]) => {
    const infrastructure = infrastructureApplyingRow(review);
    return [
      ...render(plainStyle, [applyingSection()]),
      ...[...(infrastructure === undefined ? [] : [infrastructure]), ...more].flatMap((row) =>
        renderInSection(plainStyle, [applyingRow(row, applyingLabelWidth(review))]),
      ),
    ];
  };

  test("Terraform's apply, then a new worker's wait and install: plan-apply §Waiting for a new worker", () => {
    const B1 = host("builder-1");
    const missing = `No Tailscale device named ${B1} is visible from this machine`;
    expect(
      rows(
        review,
        progressRow({ ...worker("builder-1"), kind: "waiting" }),
        progressRow({
          ...worker("builder-1"),
          kind: "still_waiting",
          waitedMs: 61_000,
          lastSeen: missing,
        }),
        progressRow({ ...worker("builder-1"), kind: "uploading", bytes: 50_541_363 }),
        progressRow({ ...worker("builder-1"), kind: "installing" }),
      ),
    ).toEqual([
      rule("Applying"),
      "  Infrastructure   applying with Terraform (its output is not shown; can take several minutes)",
      "  builder-1        waiting for its first boot (up to 15 min): this apply just created its machine",
      `  builder-1        still waiting after 1 of up to 15 min: ${missing}`,
      "  builder-1        uploading 48.2 MiB",
      "  builder-1        installing and verifying (can take many minutes)",
    ]);
  });

  test("without infrastructure changes no Terraform row, and labels fit the workers' keys", () => {
    const quiet = { ...review, changes: [] };
    expect(infrastructureApplyingRow(quiet)).toBeUndefined();
    expect(rows(quiet, progressRow({ ...worker("builder-1"), kind: "installing" }))).toEqual([
      rule("Applying"),
      "  builder-1   installing and verifying (can take many minutes)",
    ]);
  });

  test("an upgrade's pin, written once approved, before the worker installs: plan-apply §Upgrade", () => {
    const upgrade: FactoryPlanReview = {
      ...review,
      changes: [],
      pinMove: { from: "0.2.0" as Release, to: "0.3.0" as Release },
    };
    expect(
      rows(
        upgrade,
        pinnedRow("0.3.0"),
        progressRow({ ...worker("builder-1"), kind: "uploading", bytes: 50_541_363 }),
        progressRow({ ...worker("builder-1"), kind: "installing" }),
      ),
    ).toEqual([
      "── Applying ─────────────────────────────────────────",
      "  Pin         factory.json now pins release 0.3.0",
      "  builder-1   uploading 48.2 MiB",
      "  builder-1   installing and verifying (can take many minutes)",
    ]);
    expect(applyingLabelWidth({ ...upgrade, workers: [] })).toBe(3);
  });

  test("backend bootstrap's apply is Terraform's too", () => {
    const bootstrap: PlanReview = {
      kind: "backend_bootstrap",
      target: {
        instancePath: "/work/.fffactory/factory.json",
        factoryId: "fff-abcd1234" as FactoryId,
        name: "Test factory",
        accountId: "123456789012",
        region: "eu-west-2",
        release: "0.3.0" as Release,
        bucket: BUCKET,
      },
      creates: ["module.state_bucket.aws_s3_bucket.state"],
    };
    expect(rows(bootstrap)).toEqual([
      rule("Applying"),
      "  Infrastructure   applying with Terraform (its output is not shown; can take several minutes)",
    ]);
  });
});

describe("the Result and its Next block (plan-apply §Apply)", () => {
  test("an installed worker and a skipped one: plan-apply §The workers stage's example", () => {
    const offline =
      "Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.";
    const skip = { summary: "Offline in the tailnet", nextAction: offline };
    const result = applied({
      workers: [installed("builder-1", ALL), { ...worker("builder-2"), kind: "skipped", ...skip }],
      repositories: [
        synchronized("builder-1"),
        { ...worker("builder-2"), kind: "skipped", ...skip },
      ],
      controlPlane: [appliedPlane("builder-1")],
      dispatch: [
        { ...worker("builder-1"), kind: "not_requested" },
        { ...worker("builder-2"), kind: "skipped", reason: "unreachable", ...skip },
      ],
    });
    const { out, err } = streams(appliedLines(result, APPLY, PLAIN));
    expect(err).toEqual([]);
    expect(out).toEqual([
      "",
      "── Result ───────────────────────────────────────────",
      "    Infrastructure     no changes",
      "  ! builder-1          installed and verified · enrollment pending (3)",
      "    ✔ Control plane   applied",
      "    ✔ Repositories    synchronized",
      "      Dispatch        not requested",
      "  ↷ builder-2          skipped · Offline in the tailnet",
      "    ↷ Repositories    skipped",
      "    ↷ Dispatch        skipped",
      "  ! Verification       The factory is not ready: 1 of 2 workers need attention · enrollment pending on 1 worker",
      "    Operation record   s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json",
      "",
      "── Next ─────────────────────────────────────────────",
      "  builder-2: Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.",
      "",
      "  On builder-1, log in as factory (tailnet SSH policy must allow it):",
      "    $ tailscale ssh factory@fff-abcd1234-builder-1",
      "",
      "  1. GitHub",
      "     $ gh auth login --hostname github.com --git-protocol https --web",
      "     $ gh auth status --hostname github.com --active",
      "  2. OpenAI Codex",
      "     $ codex login --device-auth",
      "     $ codex login status",
      "  3. Claude Code",
      "     $ claude auth login",
      "     $ claude auth status",
      "",
      "  Return to your workstation:",
      "    $ exit",
      "  Refresh enrollment verification, reviewing the new plan:",
      "    $ fffactory apply",
      "  Then confirm:",
      "    $ fffactory status",
      "  Paseo clients: enrollment is checked from each client, not the worker",
    ]);
  });

  test("nothing pending: no Next block, the Paseo clients note last", () => {
    const result = applied({
      infrastructure: "applied",
      workers: [installed("builder-1")],
      repositories: [synchronized("builder-1")],
      controlPlane: [appliedPlane("builder-1")],
      dispatch: [{ ...worker("builder-1"), kind: "active", changed: true, gates: [] }],
    });
    const { out, err } = streams(appliedLines(result, APPLY, PLAIN));
    expect(err).toEqual([]);
    expect(out).toEqual([
      "",
      RESULT,
      "    Infrastructure     applied: matches factory.json",
      "  ✔ builder-1          installed and verified · every account enrolled",
      "    ✔ Control plane   applied",
      "    ✔ Repositories    synchronized",
      "    ✔ Dispatch        active",
      "  ✔ Verification       The factory is ready: every worker is verified end to end",
      `    Operation record   ${RECORD}`,
      "",
      PASEO,
    ]);
  });

  test("a state bucket created first is said before the infrastructure", () => {
    const { out } = streams(
      appliedLines(applied({ bootstrapped: true, infrastructure: "applied" }), APPLY, PLAIN),
    );
    expect(out.slice(2, 4)).toEqual([
      "  State bucket       created",
      "  Infrastructure     applied: matches factory.json",
    ]);
  });

  test("several workers pending enrollment: each one's login and accounts, one return each", () => {
    const result = applied({
      workers: [installed("builder-1", ["github", "anthropic"]), installed("builder-2", ALL)],
      repositories: [synchronized("builder-1"), synchronized("builder-2")],
    });
    const { out, err } = streams(appliedLines(result, SELECTED, PLAIN));
    expect(err).toEqual([]);
    expect(out).toEqual([
      "",
      RESULT,
      "    Infrastructure     no changes",
      "  ! builder-1          installed and verified · enrollment pending (2)",
      "    ✔ Repositories    synchronized",
      "  ! builder-2          installed and verified · enrollment pending (3)",
      "    ✔ Repositories    synchronized",
      `    Operation record   ${RECORD}`,
      "",
      rule("Next: enroll accounts on 2 workers"),
      "  On builder-1, log in as factory (tailnet SSH policy must allow it):",
      `    $ tailscale ssh factory@${host("builder-1")}`,
      "",
      ...GITHUB,
      "  2. Claude Code",
      "     $ claude auth login",
      "     $ claude auth status",
      "",
      "  Return to your workstation:",
      "    $ exit",
      "",
      "  On builder-2, log in as factory (tailnet SSH policy must allow it):",
      `    $ tailscale ssh factory@${host("builder-2")}`,
      "",
      ...THREE,
      "",
      ...closing(` ${FLAGS}`),
    ]);
  });

  test("a delivered credential not accepted: replace it from the workstation, no login", () => {
    const github = { ...installed("builder-1", ["github"]), delivered: ["github" as const] };
    const state = dispatchState(
      true,
      {
        releaseHealthy: true,
        githubCredential: "pending",
        githubDelivered: true,
        repositorySync: "ready",
        ffflowAdoption: "passed",
        paseoHealth: "healthy",
      },
      host("builder-1"),
    );
    if (state.kind !== "pending") throw new Error("not pending");
    const result = applied({
      workers: [github],
      repositories: [synchronized("builder-1")],
      dispatch: [
        {
          ...worker("builder-1"),
          kind: "pending",
          gates: state.gates,
          blocking: state.blocking,
          summary: describeDispatch(state),
          nextActions: dispatchNextActions(state),
        },
      ],
    });
    const { out, err } = streams(appliedLines(result, SELECTED, PLAIN));
    expect(err).toEqual([]);
    expect(
      out.slice(
        out.indexOf("  ! builder-1          installed and verified · enrollment pending (1)"),
      ),
    ).toEqual([
      "  ! builder-1          installed and verified · enrollment pending (1)",
      "    ✔ Repositories    synchronized",
      `    ! Dispatch        pending · GitHub is not authenticated for the runtime account on ${host("builder-1")}`,
      `    Operation record   ${RECORD}`,
      "",
      rule("Next: enroll 1 account on builder-1"),
      "  Replace the GitHub token, which builder-1 did not accept:",
      `    $ fffactory secret set github-token ${FLAGS}`,
      "  Refresh enrollment verification, reviewing the new plan:",
      `    $ fffactory apply ${FLAGS}`,
      "  Then confirm:",
      `    $ fffactory status ${FLAGS}`,
      PASEO,
    ]);
    expect(out.join("\n")).not.toContain("tailscale ssh");
  });

  test("delivered credentials said once for every worker, before the logins still to make", () => {
    const delivered = ["github", "anthropic"] as const;
    const result = applied({
      workers: [
        { ...installed("builder-1", ["github", "openai"]), delivered },
        { ...installed("builder-2", ["github", "anthropic"]), delivered },
      ],
    });
    const { out } = streams(appliedLines(result, APPLY, PLAIN));
    expect(out.slice(out.indexOf(rule("Next: enroll accounts on 2 workers")))).toEqual([
      rule("Next: enroll accounts on 2 workers"),
      "  Replace the GitHub token, which builder-1, builder-2 did not accept:",
      "    $ fffactory secret set github-token",
      "  Replace the Anthropic API key, which builder-2 did not accept:",
      "    $ fffactory secret set anthropic-api-key",
      "",
      "  On builder-1, log in as factory (tailnet SSH policy must allow it):",
      `    $ tailscale ssh factory@${host("builder-1")}`,
      "",
      "  1. OpenAI Codex",
      "     $ codex login --device-auth",
      "     $ codex login status",
      "",
      ...closing(),
    ]);
  });

  test("verified software with enrollment pending is not shown ready: the verdict kept, the enrollment qualified", () => {
    const keys = ["builder-1", "builder-2"];
    const result = applied({
      workers: [installed("builder-1", ["github"]), installed("builder-2", ALL)],
      repositories: keys.map(synchronized),
      controlPlane: keys.map(appliedPlane),
      dispatch: keys.map((key) => ({ ...worker(key), kind: "not_requested" as const })),
    });
    expect(result.verification?.ready).toBe(true);
    const { out } = streams(appliedLines(result, APPLY, PLAIN));
    expect(out).toContain(
      "  ! Verification       The factory is ready: every worker is verified end to end · enrollment pending on 2 workers",
    );
  });

  describe("mixed outcomes of a failed rollout", () => {
    const B3 = host("builder-3");
    const offline =
      "Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.";
    const readLog =
      `Read its output with \`tailscale ssh fffactory-admin@${B3} cat /var/log/fffactory/harness.log\` ` +
      "and fix the cause; the steps are idempotent, so rerunning repairs the worker, then rerun `fffactory apply`.";
    const result = applied({
      workers: [
        installed("builder-1", ["github"]),
        {
          ...worker("builder-2"),
          kind: "skipped",
          summary: "Offline in the tailnet",
          nextAction: offline,
        },
        {
          ...worker("builder-3"),
          kind: "failed",
          summary:
            "Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
          nextAction: readLog,
        },
        { ...worker("builder-4"), kind: "not_attempted" },
      ],
    });
    const lines = appliedLines(result, APPLY, PLAIN);

    test("failed and not attempted, and the failed worker's next action, on standard error; the rest on standard output", () => {
      const { out, err } = streams(lines);
      expect(out).toEqual([
        "",
        RESULT,
        "    Infrastructure     no changes",
        "  ! builder-1          installed and verified · enrollment pending (1)",
        "  ↷ builder-2          skipped · Offline in the tailnet",
        `    Operation record   ${RECORD}`,
        "",
        NEXT,
        `  builder-2: ${offline}`,
        "",
        "  On builder-1, log in as factory (tailnet SSH policy must allow it):",
        `    $ tailscale ssh factory@${host("builder-1")}`,
        "",
        ...GITHUB,
        "",
        ...closing(),
      ]);
      expect(err).toEqual([
        "  ✖ builder-3          failed · Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
        "  ◌ builder-4          not attempted · the rollout stopped at the failure above",
        `  builder-3: ${readLog}`,
      ]);
    });

    test("written in order: the Result's rows, then the one Next block, nothing missed or twice", () => {
      expect(lines).toEqual([
        ...[
          "",
          RESULT,
          "    Infrastructure     no changes",
          "  ! builder-1          installed and verified · enrollment pending (1)",
          "  ↷ builder-2          skipped · Offline in the tailnet",
        ].map((line) => ({ stream: "out" as const, line })),
        ...[
          "  ✖ builder-3          failed · Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
          "  ◌ builder-4          not attempted · the rollout stopped at the failure above",
        ].map((line) => ({ stream: "err" as const, line })),
        ...[`    Operation record   ${RECORD}`, "", NEXT, `  builder-2: ${offline}`].map(
          (line) => ({ stream: "out" as const, line }),
        ),
        { stream: "err" as const, line: `  builder-3: ${readLog}` },
        ...[
          "",
          "  On builder-1, log in as factory (tailnet SSH policy must allow it):",
          `    $ tailscale ssh factory@${host("builder-1")}`,
          "",
          ...GITHUB,
          "",
          ...closing(),
        ].map((line) => ({ stream: "out" as const, line })),
      ]);
      const all = lines.map(({ line }) => line);
      for (const action of [offline, readLog])
        expect(all.filter((line) => line.includes(action))).toHaveLength(1);
    });

    test("a failed worker's next action merged with a skipped one's is on standard error", () => {
      const shared = applied({
        workers: [
          { ...worker("builder-2"), kind: "skipped", summary: "Offline", nextAction: readLog },
          {
            ...worker("builder-3"),
            kind: "failed",
            summary: "Step harness failed",
            nextAction: readLog,
          },
        ],
      });
      const { out, err } = streams(appliedLines(shared, APPLY, PLAIN));
      expect(err).toEqual([
        "  ✖ builder-3          failed · Step harness failed",
        "",
        NEXT,
        `  builder-2, builder-3: ${readLog}`,
      ]);
      expect(out.some((line) => line.includes(readLog))).toBe(false);
    });

    test("a Next block whose first step is the failed worker's starts on standard error", () => {
      const failedFirst = applied({
        workers: [result.workers[0], result.workers[2], result.workers[3]].filter(
          (outcome): outcome is WorkerOutcome => outcome !== undefined,
        ),
      });
      const { err, out } = streams(appliedLines(failedFirst, APPLY, PLAIN));
      expect(err.slice(-3)).toEqual(["", NEXT, `  builder-3: ${readLog}`]);
      expect(
        out.slice(out.indexOf(`    Operation record   ${RECORD}`) + 1, -closing().length),
      ).toEqual([
        "",
        "  On builder-1, log in as factory (tailnet SSH policy must allow it):",
        `    $ tailscale ssh factory@${host("builder-1")}`,
        "",
        ...GITHUB,
        "",
      ]);
    });
  });

  test("enrolled workers with pending or failed dispatch are not ready; a gate enrollment covers is said once", () => {
    const pending = (key: string, github: EnrollmentState): DispatchOutcome => {
      const state = dispatchState(
        true,
        {
          releaseHealthy: true,
          githubCredential: github,
          githubDelivered: false,
          repositorySync: "ready",
          ffflowAdoption: "failed",
          paseoHealth: "healthy",
        },
        host(key),
      );
      if (state.kind !== "pending") throw new Error("not pending");
      return {
        ...worker(key),
        kind: "pending",
        gates: state.gates,
        blocking: state.blocking,
        summary: describeDispatch(state),
        nextActions: dispatchNextActions(state),
      };
    };
    const paseo = `Check \`systemctl status paseo.service\` on ${host("builder-3")}, then rerun \`fffactory apply\``;
    const result = applied({
      workers: [installed("builder-1"), installed("builder-2", ["github"]), installed("builder-3")],
      repositories: ["builder-1", "builder-2", "builder-3"].map(synchronized),
      controlPlane: ["builder-1", "builder-2", "builder-3"].map(appliedPlane),
      dispatch: [
        pending("builder-1", "enrolled"),
        pending("builder-2", "pending"),
        {
          ...worker("builder-3"),
          kind: "failed",
          summary: "Reconciling dispatch failed",
          nextAction: paseo,
        },
      ],
    });
    const { out, err } = streams(appliedLines(result, APPLY, PLAIN));
    const adoption = (key: string) =>
      `A placed repository on ${host(key)} does not pass FFFlow adoption`;
    const adopt =
      "Adopt FFFlow (`.ffflow/config.yaml`) on the placed repositories and rerun `fffactory apply`";
    expect(out).toEqual([
      "",
      RESULT,
      "    Infrastructure     no changes",
      "  ! builder-1          installed and verified · every account enrolled",
      "    ✔ Control plane   applied",
      "    ✔ Repositories    synchronized",
      `    ! Dispatch        pending · ${adoption("builder-1")}`,
      "  ! builder-2          installed and verified · enrollment pending (1)",
      "    ✔ Control plane   applied",
      "    ✔ Repositories    synchronized",
      `    ! Dispatch        pending · GitHub is not authenticated for the runtime account on ${host("builder-2")}; ${adoption("builder-2")}`,
      "  ✖ builder-3          installed and verified · every account enrolled",
      "    ✔ Control plane   applied",
      "    ✔ Repositories    synchronized",
      "    ✖ Dispatch        failed · Reconciling dispatch failed",
      "  ! Verification       The factory is not ready: 3 of 3 workers need attention · enrollment pending on 1 worker",
      `    Operation record   ${RECORD}`,
      // A failed dispatch fails the run, but its next action stays on standard output.
      "",
      NEXT,
      `  builder-1: ${adoption("builder-1")}: ${adopt}`,
      `  builder-2: ${adoption("builder-2")}: ${adopt}`,
      `  builder-3: ${paseo}`,
      "",
      "  On builder-2, log in as factory (tailnet SSH policy must allow it):",
      `    $ tailscale ssh factory@${host("builder-2")}`,
      "",
      ...GITHUB,
      "",
      ...closing(),
    ]);
    expect(err).toEqual([]);
    expect(out.join("\n")).not.toContain("Authenticate GitHub");
  });

  test("a repository gap: its next action once, the dispatch gate it blocks not repeated", () => {
    const resolve = `Resolve the reported checkouts on ${host("builder-1")}, then rerun \`fffactory apply\`.`;
    const state = dispatchState(
      true,
      {
        releaseHealthy: true,
        githubCredential: "enrolled",
        githubDelivered: false,
        repositorySync: "pending",
        ffflowAdoption: "passed",
        paseoHealth: "healthy",
      },
      host("builder-1"),
    );
    if (state.kind !== "pending") throw new Error("not pending");
    const result = applied({
      workers: [installed("builder-1")],
      repositories: [
        {
          ...worker("builder-1"),
          kind: "unresolved",
          unmanaged: [],
          summary: "1 checkout is divergent",
          nextAction: resolve,
        },
      ],
      controlPlane: [appliedPlane("builder-1")],
      dispatch: [
        {
          ...worker("builder-1"),
          kind: "pending",
          gates: state.gates,
          blocking: state.blocking,
          summary: describeDispatch(state),
          nextActions: dispatchNextActions(state),
        },
      ],
    });
    const { out, err } = streams(appliedLines(result, APPLY, PLAIN));
    expect(err).toEqual([]);
    expect(out.slice(3, 7)).toEqual([
      "  ! builder-1          installed and verified · every account enrolled",
      "    ✔ Control plane   applied",
      "    ! Repositories    unresolved · 1 checkout is divergent",
      `    ! Dispatch        pending · Some repositories on ${host("builder-1")} are not synchronized`,
    ]);
    expect(out.slice(out.indexOf(NEXT))).toEqual([NEXT, `  builder-1: ${resolve}`, PASEO]);
  });

  test("deferred maintenance: one recovery instruction, though three stages name it", () => {
    const close = `Wait until no agent on ${host("builder-1")} is working or needs input, then rerun \`fffactory apply\``;
    const deferral = "Paseo maintenance is deferred while agents may be busy";
    const result = applied({
      workers: [{ ...worker("builder-1"), kind: "skipped", summary: deferral, nextAction: close }],
      repositories: [synchronized("builder-1")],
      controlPlane: [
        {
          ...worker("builder-1"),
          kind: "deferred",
          pending: ["password"],
          reloaded: false,
          summary: "Maintenance (password) was deferred while agents may be busy",
          nextAction: close,
        },
      ],
      dispatch: [
        {
          ...worker("builder-1"),
          kind: "skipped",
          reason: "deferred",
          summary: deferral,
          nextAction: close,
        },
      ],
    });
    const { out, err } = streams(appliedLines(result, APPLY, PLAIN));
    expect(err).toEqual([]);
    expect(out.slice(3)).toEqual([
      `  ! builder-1          skipped · ${deferral}`,
      "    ! Control plane   deferred · Maintenance (password) was deferred while agents may be busy",
      "    ✔ Repositories    synchronized",
      "    ↷ Dispatch        skipped",
      "  ! Verification       The factory is not ready: 1 of 1 workers need attention",
      `    Operation record   ${RECORD}`,
      "",
      NEXT,
      `  builder-1: ${close}`,
    ]);
  });

  test("a stopped worker is a successful intentional state: no glyph of failure, no Next block", () => {
    const result = applied({
      workers: [installed("builder-1"), stoppedOutcome(worker("builder-2"))],
      repositories: [synchronized("builder-1"), { ...worker("builder-2"), kind: "stopped" }],
      controlPlane: [appliedPlane("builder-1"), { ...worker("builder-2"), kind: "stopped" }],
      dispatch: [
        { ...worker("builder-1"), kind: "not_requested" },
        { ...worker("builder-2"), kind: "stopped" },
      ],
    });
    const { out, err } = streams(appliedLines(result, SELECTED, PLAIN));
    expect(err).toEqual([]);
    expect(out).toEqual([
      "",
      RESULT,
      "    Infrastructure     no changes",
      "  ✔ builder-1          installed and verified · every account enrolled",
      "    ✔ Control plane   applied",
      "    ✔ Repositories    synchronized",
      "      Dispatch        not requested",
      "  ◼ builder-2          stopped · nothing was sent to it; to install it, start it with " +
        `\`fffactory worker start builder-2 ${FLAGS}\`, then apply again`,
      "  ✔ Verification       The factory is ready: every worker but the 1 stopped is verified end to end",
      `    Operation record   ${RECORD}`,
      "",
      PASEO,
    ]);
  });

  test("an empty factory: plan-apply §An empty factory's example", () => {
    const result = applied({ repositories: [], controlPlane: [], dispatch: [] });
    expect(appliedLines(result, APPLY, PLAIN)).toEqual(
      [
        "",
        "── Result ───────────────────────────────────────────",
        "    Infrastructure     no changes",
        "    Workers            none declared. Declare a host in factory.json's hosts, then create it with `fffactory apply`.",
        "  ✔ Verification       The factory is ready: it declares no workers",
        "    Operation record   s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json",
      ].map((line) => ({ stream: "out", line })),
    );
  });

  test("an empty factory reports no workers, with how to add one, and nothing next", () => {
    const result = applied({
      infrastructure: "applied",
      repositories: [],
      controlPlane: [],
      dispatch: [],
    });
    const { out, err } = streams(appliedLines(result, SELECTED, PLAIN));
    expect(err).toEqual([]);
    expect(out).toEqual([
      "",
      RESULT,
      "    Infrastructure     applied: matches factory.json",
      "    Workers            none declared. Declare a host in factory.json's hosts, then create " +
        `it with \`fffactory apply ${FLAGS}\`.`,
      "  ✔ Verification       The factory is ready: it declares no workers",
      `    Operation record   ${RECORD}`,
    ]);
  });

  test("a record that could not be finished: on standard error, before the Next block", () => {
    const result = applied({
      workers: [installed("builder-1", ["github"])],
      recordFailure: "S3 PutObject on the state bucket failed: SlowDown",
    });
    const lines = appliedLines(result, APPLY, PLAIN);
    const { out, err, all } = streams(lines);
    expect(err).toEqual([
      "",
      "  ✖ The operation record could not be finished: S3 PutObject on the state bucket failed: SlowDown",
    ]);
    expect(out[out.length - 1]).toBe(PASEO);
    const record = all.indexOf(`    Operation record   ${RECORD}`);
    const failure = all.indexOf(err[1] ?? "");
    expect(record).toBeLessThan(failure);
    expect(failure).toBeLessThan(all.indexOf(rule("Next: enroll 1 account on builder-1")));
  });
});

describe("a failure (plan-apply §Failure)", () => {
  const failed = (
    step: Extract<FactoryApply, { readonly kind: "failed" }>["step"],
    fields: Partial<Extract<FactoryApply, { readonly kind: "failed" }>> = {},
  ): Extract<FactoryApply, { readonly kind: "failed" }> => ({
    kind: "failed",
    step,
    reason: "`terraform apply` exited with status 1",
    diagnosticsFile: undefined,
    operation: {
      bucket: BUCKET,
      key: "fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json",
    },
    recordFailure: undefined,
    ...fields,
  });
  const DIAGNOSTICS =
    "/home/operator/.cache/fffactory/terraform/diagnostics/20260930T120000Z-apply-Ab12Cd.log";

  test("plan-apply §Failure's example: the failure, its diagnostics and record, then a rerun", () => {
    const { out, err, all } = streams(
      failedLines(failed("applying", { diagnosticsFile: DIAGNOSTICS }), APPLY, PLAIN),
    );
    expect(all).toEqual([
      "",
      "── Result ───────────────────────────────────────────",
      "  ✖ Applying failed: `terraform apply` exited with status 1",
      "    Terraform may have changed some of the infrastructure before it stopped.",
      "",
      "  Terraform's diagnostics   /home/operator/.cache/fffactory/terraform/diagnostics/20260930T120000Z-apply-Ab12Cd.log",
      "  Operation record          s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json",
      "",
      "── Next ─────────────────────────────────────────────",
      "  Rerun: it plans again from what exists now and converges what remains:",
      "    $ fffactory apply",
    ]);
    const record = `  Operation record          ${RECORD}`;
    expect(out).toEqual([record]);
    expect(err).not.toContain(record);
  });

  test("the reason may carry data, such as an adapter's error message: shown verbatim, never read for inline code", () => {
    const lines = failedLines(failed("applying"), APPLY, { out: ansiStyle, err: ansiStyle });
    const verdict = lines.find(({ line }) => line.includes("Applying failed"))?.line ?? "";
    expect(verdict).toContain(ansiStyle.verdict("error", "`terraform apply` exited with status 1"));
    expect(verdict).not.toContain(ansiStyle.code("terraform apply"));
  });

  test("what may have changed, the diagnostics, the record, then how to converge", () => {
    const lines = failedLines(
      failed("applying", {
        diagnosticsFile: DIAGNOSTICS,
        recordFailure: "S3 PutObject on the state bucket failed: SlowDown",
      }),
      SELECTED,
      PLAIN,
    );
    const { out, err, all } = streams(lines);
    expect(all).toEqual([
      "",
      RESULT,
      "  ✖ Applying failed: `terraform apply` exited with status 1",
      "    Terraform may have changed some of the infrastructure before it stopped.",
      "",
      `  Terraform's diagnostics   ${DIAGNOSTICS}`,
      `  Operation record          ${RECORD}`,
      "",
      "  ✖ The operation record could not be finished: S3 PutObject on the state bucket failed: SlowDown",
      "",
      NEXT,
      "  Rerun: it plans again from what exists now and converges what remains:",
      `    $ fffactory apply ${FLAGS}`,
    ]);
    expect(out).toEqual([`  Operation record          ${RECORD}`]);
    expect(err).not.toContain(out[0]);
  });

  test.each([
    [
      "installing",
      "Installing the workers failed",
      "The worker being installed may be on the new release, unhealthy.",
    ],
    [
      "repositories",
      "Repository synchronization failed",
      "Completed repository changes were left in place.",
    ],
    ["control-plane", "Control-plane reconciliation failed", undefined],
    ["dispatch", "Dispatch reconciliation failed", undefined],
    ["verification", "End-to-end verification failed", undefined],
  ] as const)("a %s failure says what it left and how to converge", (step, headline, left) => {
    const { all } = streams(
      failedLines(failed(step, { reason: "the transport broke" }), APPLY, PLAIN),
    );
    expect(all.slice(0, 3)).toEqual(["", RESULT, `  ✖ ${headline}: the transport broke`]);
    expect(all[3]).toBe(left === undefined ? "" : `    ${left}`);
    expect(all.slice(-2)).toEqual([
      "  Rerun: it plans again from what exists now and converges what remains:",
      "    $ fffactory apply",
    ]);
  });

  test("a planning failure applied nothing, and has no Next block", () => {
    const { all } = streams(
      failedLines(
        failed("planning", { reason: "`terraform plan` exited with status 1" }),
        APPLY,
        PLAIN,
      ),
    );
    expect(all).toEqual([
      "",
      RESULT,
      "  ✖ Planning failed: `terraform plan` exited with status 1",
      "    Nothing was applied.",
      "",
      `  Operation record   ${RECORD}`,
    ]);
  });

  test("an upgrade failing once the pin moved: the pin's state, then how to finish", () => {
    const upgrade: ApplyReporting = {
      action: "upgrade",
      rerun: "apply",
      selection: {},
      pin: { moved: true, release: "0.3.0" },
    };
    const { out, err, all } = streams(
      failedLines(failed("pinned", { reason: "S3 answered SlowDown" }), upgrade, PLAIN),
    );
    expect(all).toEqual([
      "",
      RESULT,
      "  ✖ Upgrading failed once factory.json's pin moved: S3 answered SlowDown",
      "    Nothing was applied.",
      "",
      `  Operation record   ${RECORD}`,
      "",
      "factory.json pins release 0.3.0.",
      "",
      NEXT,
      "  Finish with this release:",
      "    $ fffactory apply",
    ]);
    expect(out).toEqual(["", `  Operation record   ${RECORD}`]);
    expect(err).toContain("factory.json pins release 0.3.0.");
  });

  test("an upgrade failing before the pin moved says so, and replans with upgrade", () => {
    const upgrade: ApplyReporting = {
      action: "upgrade",
      rerun: "upgrade",
      selection: {},
      pin: { moved: false, release: "0.3.0" },
    };
    const { err } = streams(failedLines(failed("planning"), upgrade, PLAIN));
    expect(err.at(-1)).toBe(
      "factory.json's pin was not moved: it still pins the release it pinned.",
    );
    expect(pinNotice(upgrade)).toBe(err.at(-1));
    expect(pinNotice(APPLY)).toBeUndefined();
  });
});

describe("an interrupt (plan-apply §Interruption)", () => {
  const record = {
    bucket: BUCKET,
    key: "fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json",
  };
  const LOCK_BREAK = [
    NEXT,
    "  Once fffactory has exited, break the lock:",
    "    $ fffactory lock break",
    "  Then rerun:",
    "    $ fffactory apply",
  ];

  test("before the lock was taken: nothing to break, rerun", () => {
    const { out, all } = streams(
      interruptedLines({ kind: "interrupted", locked: false }, APPLY, PLAIN),
    );
    expect(out).toEqual([]);
    expect(all).toEqual([
      "",
      RESULT,
      "  ! Interrupted before the factory was locked: it is not locked",
      "",
      NEXT,
      "  Rerun: it plans again from what exists now:",
      "    $ fffactory apply",
    ]);
  });

  test("holding the lock with no record yet", () => {
    const { all } = streams(
      interruptedLines({ kind: "interrupted", locked: true, record: undefined }, APPLY, PLAIN),
    );
    expect(all).toEqual([
      "",
      RESULT,
      "  ! Interrupted: the factory stays locked by this apply, which may have no operation record",
      "",
      ...LOCK_BREAK,
    ]);
  });

  test("while a worker installs: the worker, the lock and record, the record on standard output", () => {
    const { out, err } = streams(
      interruptedLines(
        { kind: "interrupted", locked: true, record, installing: worker("builder-1") },
        APPLY,
        PLAIN,
      ),
    );
    expect(err).toEqual([
      "",
      RESULT,
      "  ! Interrupted: the factory stays locked, with a record of this operation",
      "    Interrupted while installing on builder-1: host apply may still be running there, and a rerun skips that worker until it has finished.",
      "",
      ...LOCK_BREAK,
    ]);
    expect(out).toEqual(["", `  Operation record   ${RECORD}`]);
  });

  test("while a new worker boots: no install step ran on it", () => {
    const { err } = streams(
      interruptedLines(
        { kind: "interrupted", locked: true, record, waiting: worker("builder-1") },
        APPLY,
        PLAIN,
      ),
    );
    expect(err[3]).toBe(
      "    Interrupted while waiting for builder-1 to finish its first boot: no install step ran on it.",
    );
  });

  test("an upgrade before its pin moved: the pin's state before the Next block, rerun upgrade", () => {
    const upgrade: ApplyReporting = {
      action: "upgrade",
      rerun: "upgrade",
      selection: { profile: "factory" },
      pin: { moved: false, release: "0.3.0" },
    };
    const { err } = streams(
      interruptedLines({ kind: "interrupted", locked: true, record }, upgrade, PLAIN),
    );
    expect(err.slice(-8)).toEqual([
      "",
      "factory.json's pin was not moved: it still pins the release it pinned.",
      "",
      NEXT,
      "  Once fffactory has exited, break the lock:",
      "    $ fffactory lock break --profile factory",
      "  Then rerun:",
      "    $ fffactory upgrade --profile factory",
    ]);
  });
});

describe("a saved bootstrap plan (plan-apply §Applying a saved bootstrap plan)", () => {
  const operation = {
    bucket: BUCKET,
    key: "fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json",
  };
  const bootstrapped = (recordFailure?: string): FactoryApply => ({
    kind: "bootstrapped",
    planId: "b00tstr4",
    operation,
    recordFailure,
  });
  const lines = (result: FactoryApply, reporting = APPLY, styles = PLAIN) => {
    if (result.kind !== "bootstrapped") throw new Error(result.kind);
    return streams(bootstrappedLines(result, reporting, styles));
  };

  test("the bucket created and its record, then planning the factory next, on standard output", () => {
    const { out, err } = lines(bootstrapped());
    expect(err).toEqual([]);
    expect(out).toEqual([
      "",
      RESULT,
      "  State bucket       created",
      `  Operation record   ${RECORD}`,
      "",
      NEXT,
      "  Plan the factory next:",
      "    $ fffactory plan",
    ]);
  });

  test("the next step repeats the instance and profile given", () => {
    expect(lines(bootstrapped(), SELECTED).out.at(-1)).toBe(`    $ fffactory plan ${FLAGS}`);
  });

  test("a record that could not be finished: on standard error, the bucket still created", () => {
    const { all, err } = lines(bootstrapped("S3 PutObject on the state bucket failed: SlowDown"));
    expect(err).toEqual([
      "",
      "  ✖ The operation record could not be finished: S3 PutObject on the state bucket failed: SlowDown",
    ]);
    expect(all.slice(0, 6)).toEqual([
      "",
      RESULT,
      "  State bucket       created",
      `  Operation record   ${RECORD}`,
      "",
      "  ✖ The operation record could not be finished: S3 PutObject on the state bucket failed: SlowDown",
    ]);
    expect(all.at(-1)).toBe("    $ fffactory plan");
  });

  test("its human output is colored only on a stream that is", () => {
    const { out } = lines(bootstrapped(), APPLY, { out: ansiStyle, err: plainStyle });
    expect(out).toContain(`    ${ansiStyle.command("fffactory plan")}`);
    expect(out.map((line) => stripVTControlCharacters(line))).toEqual(lines(bootstrapped()).out);
  });

  test("interrupted before the lock: B may be spent, so the factory is planned again", () => {
    const { out, all } = streams(
      interruptedLines(
        { kind: "interrupted", locked: false, bootstrapPlan: "b00tstr4" },
        SELECTED,
        PLAIN,
      ),
    );
    expect(out).toEqual([]);
    expect(all).toEqual([
      "",
      RESULT,
      "  ! Interrupted before the factory was locked: it is not locked",
      "    Saved plan b00tstr4 may be spent and the state bucket created.",
      "",
      NEXT,
      "  Plan again from what exists now:",
      `    $ fffactory plan ${FLAGS}`,
    ]);
  });

  test("interrupted holding the lock: break it, then plan the factory, never rerun apply", () => {
    const { out, err } = streams(
      interruptedLines(
        { kind: "interrupted", locked: true, record: operation, bootstrapPlan: "b00tstr4" },
        APPLY,
        PLAIN,
      ),
    );
    expect(err).toEqual([
      "",
      RESULT,
      "  ! Interrupted: the factory stays locked, with a record of this operation",
      "",
      NEXT,
      "  Once fffactory has exited, break the lock:",
      "    $ fffactory lock break",
      "  Then plan the factory next:",
      "    $ fffactory plan",
    ]);
    expect(out).toEqual(["", `  Operation record   ${RECORD}`]);
  });
});

describe("a run that applied nothing (plan-apply §Apply, §Upgrade)", () => {
  const plain = (report: ReturnType<typeof refusedRunReport>) =>
    render(plainStyle, report.blocks, report.next);

  test("declined", () => {
    expect(plain(refusedRunReport({ kind: "declined", stage: "infrastructure" }, APPLY))).toEqual([
      "✖ Not approved: nothing was applied",
    ]);
  });

  test("factory.json changed after an upgrade's plan was made", () => {
    const upgrade: ApplyReporting = { action: "upgrade", rerun: "upgrade", selection: {} };
    expect(plain(refusedRunReport({ kind: "configuration_changed" }, upgrade))).toEqual([
      "✖ Refusing to upgrade: factory.json changed after the plan was made",
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Review a new plan:",
      "    $ fffactory upgrade",
    ]);
  });

  test("an upgrade without a state bucket: apply with the pinned release first", () => {
    const upgrade: ApplyReporting = {
      action: "upgrade",
      rerun: "upgrade",
      selection: SELECTED.selection,
    };
    expect(plain(refusedRunReport({ kind: "no_state_bucket" }, upgrade))).toEqual([
      "✖ Refusing to upgrade: the factory has no state bucket yet, and an upgrade never creates it",
      "",
      "Nothing was created or applied.",
      "",
      NEXT,
      "  Create it with the release factory.json pins, which applies the factory:",
      `    $ fffactory apply ${FLAGS}`,
      "  Then upgrade again:",
      `    $ fffactory upgrade ${FLAGS}`,
    ]);
  });
});
