/**
 * Teardown's human output (`docs/specs/teardown.md` §Output and exit codes), laid out from the
 * use case's data: the review, each step, and every outcome. Pure: exact plain text, and only
 * what the domain hands it.
 */
import { describe, expect, test } from "bun:test";
import { render, renderInSection } from "../../../src/cli/presentation/blocks";
import { plainStyle } from "../../../src/cli/presentation/style";
import {
  type ReportedTeardown,
  teardownOutcome,
  teardownProgressLine,
  teardownReviewBlocks,
} from "../../../src/cli/presentation/teardown";
import { unreadyBucket } from "../../../src/domain/backend-bootstrap";
import type { FactoryId, HostKey, Release, SecretReference } from "../../../src/domain/instance";
import {
  CHECK_LISTED_DEVICES,
  CHECK_UNCHECKED_DEVICES,
  checkOutsideEc2,
  DEVICES_NOT_CHECKED,
  FACTORY_JSON_KEPT,
  NO_LISTED_DEVICES,
  ranWithoutLock,
  REVOKE_SOURCES,
  remainingAt,
  secretsRemain,
  stoppedPartWay,
  TEARDOWN_UNCONFIRMABLE,
  type TeardownReport,
  type TeardownReview,
  teardownConfirmMismatch,
} from "../../../src/domain/teardown";

const FACTORY = "fff-abcd1234" as FactoryId;
const BUCKET = "fff-abcd1234-state";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const TARGET = {
  instancePath: "/work/.fffactory/factory.json",
  name: "Test factory",
  factoryId: FACTORY,
  accountId: "123456789012",
  region: "eu-west-2",
  release: "0.3.0" as Release,
};
const HOST = 'module.hosts.aws_instance.host["builder-1"]';
const VPC = "vpc-0123456789abcdef0";
const arn = (name: string) =>
  `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${name}-AbCdEf` as SecretReference;
const SOURCE = arn("fffv/github-token");
const OWNED = [`${FACTORY}/tailscale-auth-key`, `${FACTORY}/tailscale-admin-client`];

/** A section's rule line, 53 columns wide, as `render` draws it. */
const rule = (title: string) => `── ${title} ${"─".repeat(Math.max(2, 49 - title.length))}`;
const TARGET_ROWS = [
  "  Factory   Test factory (fff-abcd1234)",
  "  Account   123456789012 · eu-west-2",
  "  Release   0.3.0",
];

const NO_KEPT = { tagged: [], referenced: [] };

function review(fields: Partial<TeardownReview> = {}): TeardownReview {
  return {
    target: TARGET,
    changes: [
      { address: HOST, type: "aws_instance", actions: ["delete"] },
      { address: "module.network.aws_vpc.this", actions: ["delete"] },
    ],
    machines: [
      {
        instanceId: "i-0123",
        state: "stopped",
        hostKey: "builder-1" as HostKey,
        malformedHostKey: false,
      },
    ],
    vpcIds: [VPC],
    devices: {
      deleted: [{ id: "n1CNTRL", hostname: "fff-abcd1234-builder-1" }],
      possible: [],
      untagged: [],
    },
    devicesUnchecked: undefined,
    secrets: { owned: OWNED.map((name) => ({ name, arn: arn(name) })), absent: [], kept: NO_KEPT },
    bucket: { name: BUCKET, outcome: "deleted" },
    withoutLock: undefined,
    ...fields,
  };
}

function report(fields: Partial<TeardownReport> = {}): TeardownReport {
  return {
    infrastructure: "destroyed",
    changes: review().changes,
    machines: review().machines,
    devices: { removed: ["n1CNTRL"], possible: [], untagged: [] },
    devicesUnchecked: undefined,
    secrets: { removed: OWNED, absent: [], kept: NO_KEPT },
    bucket: { name: BUCKET, outcome: "deleted" },
    withoutLock: undefined,
    ...fields,
  };
}

const plain = (blocks: Parameters<typeof render>[1]) => render(plainStyle, blocks);
const reporting = (selection = {}) => ({ factoryId: FACTORY, now: NOW, selection });
/** An outcome's stream, and its report as plain text. */
function outcome(result: ReportedTeardown, selection = {}) {
  const { stream, report: shown } = teardownOutcome(result, reporting(selection));
  return { stream, lines: render(plainStyle, shown.blocks, shown.next) };
}

describe("the review (teardown §Order, step 10)", () => {
  test("the target, what is removed, and the state bucket last", () => {
    expect(plain(teardownReviewBlocks(review(), {}))).toEqual([
      rule("Teardown"),
      ...TARGET_ROWS,
      "",
      "  Infrastructure    2 to destroy",
      `    - ${HOST}`,
      "    - module.network.aws_vpc.this",
      "  EC2 instances     i-0123 (builder-1, stopped)",
      `  VPCs              ${VPC}`,
      "  Tailnet devices   delete n1CNTRL (fff-abcd1234-builder-1)",
      `  Owned secrets     delete ${OWNED.join(", ")}, each confirmed gone`,
      `  State bucket      ${BUCKET}, deleted last, with the lock`,
    ]);
  });

  test("what it keeps, apart; references already absent apart from them", () => {
    const lines = plain(
      teardownReviewBlocks(
        review({
          devices: {
            deleted: [],
            possible: [{ id: "n2CNTRL", hostname: "fff-abcd1234-lab" }],
            untagged: [{ id: "n3CNTRL", hostname: undefined }],
          },
          secrets: {
            owned: [],
            absent: [arn(`${FACTORY}/paseo-password`)],
            kept: {
              tagged: [{ name: "fff-abcd1234-other", arn: arn("fff-abcd1234-other") }],
              referenced: [SOURCE, arn(`${FACTORY}/hand-made`)],
            },
          },
        }),
        {},
      ),
    );
    expect(lines.slice(TARGET_ROWS.length + 2)).toEqual([
      "  Infrastructure    2 to destroy",
      `    - ${HOST}`,
      "    - module.network.aws_vpc.this",
      "  EC2 instances     i-0123 (builder-1, stopped)",
      `  VPCs              ${VPC}`,
      "  Tailnet devices   none to delete",
      "  Owned secrets     none to delete",
      `  Already absent    ${arn(`${FACTORY}/paseo-password`)}`,
      `  State bucket      ${BUCKET}, deleted last, with the lock`,
      "",
      rule("Kept"),
      "  Possibly its devices   n2CNTRL (fff-abcd1234-lab)",
      "  Untagged look-alikes   n3CNTRL",
      `  Tagged, not owned      fff-abcd1234-other (${arn("fff-abcd1234-other")})`,
      `  Referenced             ${SOURCE}, ${arn(`${FACTORY}/hand-made`)}`,
    ]);
  });

  test("a malformed host key is only marked; the root already gone destroys nothing", () => {
    const lines = plain(
      teardownReviewBlocks(
        review({
          changes: [],
          machines: [
            { instanceId: "i-0456", state: "running", hostKey: undefined, malformedHostKey: true },
          ],
        }),
        {},
      ),
    );
    expect(lines).toContain("  Infrastructure    nothing to destroy: the factory root is gone");
    expect(lines).toContain(
      "  EC2 instances     i-0456 (a host key tag that is not well-formed, running)",
    );
  });

  test("devices not checked, with the advice to check them", () => {
    const lines = plain(
      teardownReviewBlocks(
        review({
          devices: { deleted: [], possible: [], untagged: [] },
          devicesUnchecked: DEVICES_NOT_CHECKED,
        }),
        {},
      ),
    );
    expect(lines).toContain(`  Tailnet devices   ${DEVICES_NOT_CHECKED}`);
    expect(lines).toContain(`    ${CHECK_UNCHECKED_DEVICES}`);
  });

  test("without a state bucket: no destroy plan, the bucket not found, and why there is no lock", () => {
    const lines = plain(
      teardownReviewBlocks(
        review({
          changes: [],
          machines: [],
          vpcIds: [],
          bucket: { name: BUCKET, outcome: "not_found" },
          withoutLock: ranWithoutLock(BUCKET),
        }),
        {},
      ),
    );
    expect(lines.slice(TARGET_ROWS.length + 2)).toEqual([
      "  Infrastructure    no destroy plan: EC2 lists nothing tagged with the factory ID",
      "  Tailnet devices   delete n1CNTRL (fff-abcd1234-builder-1)",
      `  Owned secrets     delete ${OWNED.join(", ")}, each confirmed gone`,
      `  State bucket      ${BUCKET}: not found by this run, so not deleted by it`,
      "",
      `  ${ranWithoutLock(BUCKET)}`,
    ]);
    expect(lines.join("\n")).not.toContain("deleted last");
  });
});

describe("the steps as they run", () => {
  test("each step under the Removing section", () => {
    const lines = renderInSection(plainStyle, [
      teardownProgressLine({ kind: "stopping_dispatch", hostname: "fff-abcd1234-builder-1" }),
      teardownProgressLine({ kind: "uninspected_stopped", hostname: "fff-abcd1234-builder-2" }),
      teardownProgressLine({ kind: "destroying" }),
      teardownProgressLine({ kind: "removing_devices" }),
      teardownProgressLine({ kind: "removing_secrets" }),
      teardownProgressLine({ kind: "deleting_bucket", bucket: BUCKET }),
    ]);
    expect(lines).toEqual([
      "  Stopping dispatch on fff-abcd1234-builder-1.",
      "",
      "  fff-abcd1234-builder-2 is stopped: it is not inspected, and unpushed work on its disk is destroyed with it.",
      "",
      "  Destroying the factory's resources. Terraform's output is not shown; this can take several minutes.",
      "",
      "  Deleting the factory's tailnet devices.",
      "",
      "  Deleting the owned secrets, confirming each is gone.",
      "",
      `  Deleting the state bucket ${BUCKET}, the lock last.`,
    ]);
  });
});

const ADVICE = [rule("Next"), `  ${REVOKE_SOURCES}`, `  ${FACTORY_JSON_KEPT}`];

describe("a finished teardown (teardown §Report)", () => {
  test("what it removed, on standard output, then the advice it leaves", () => {
    expect(outcome({ kind: "done", report: report() })).toEqual({
      stream: "out",
      lines: [
        "✔ Removed factory fff-abcd1234: nothing it owns remains",
        "",
        rule("Result"),
        "  Infrastructure    destroyed: 2 resources",
        `    - ${HOST}`,
        "    - module.network.aws_vpc.this",
        "  EC2 instances     i-0123 (builder-1, stopped)",
        "  Tailnet devices   deleted n1CNTRL",
        `  Owned secrets     deleted ${OWNED.join(", ")}, each confirmed gone`,
        `  State bucket      ${BUCKET}, deleted`,
        "",
        ...ADVICE,
      ],
    });
  });

  test("the devices listed but kept, the kept secrets, and the advice to check the devices", () => {
    const { lines } = outcome({
      kind: "done",
      report: report({
        infrastructure: "absent",
        changes: [],
        machines: [],
        devices: {
          removed: [],
          possible: [{ id: "n2CNTRL", hostname: "fff-abcd1234-lab" }],
          untagged: [],
        },
        secrets: {
          removed: [],
          absent: OWNED.map(arn),
          kept: { tagged: [], referenced: [SOURCE] },
        },
      }),
    });
    expect(lines.slice(1)).toEqual([
      "",
      rule("Result"),
      "  Infrastructure    already absent: the destroy plan destroyed no resource",
      "  Tailnet devices   none found",
      "  Owned secrets     none found",
      `  Already absent    ${OWNED.map(arn).join(", ")}`,
      `  State bucket      ${BUCKET}, deleted`,
      "",
      rule("Kept"),
      "  Possibly its devices   n2CNTRL (fff-abcd1234-lab)",
      `  Referenced             ${SOURCE}`,
      "",
      rule("Next"),
      `  ${CHECK_LISTED_DEVICES}`,
      `  ${REVOKE_SOURCES}`,
      `  ${FACTORY_JSON_KEPT}`,
    ]);
  });

  test("without a state bucket: not found by EC2, the bucket not found, no lock, and IAM to check", () => {
    const { lines } = outcome({
      kind: "done",
      report: report({
        infrastructure: "not_found_by_ec2",
        changes: [],
        machines: [],
        devices: { removed: [], possible: [], untagged: [] },
        devicesUnchecked: DEVICES_NOT_CHECKED,
        bucket: { name: BUCKET, outcome: "not_found" },
        withoutLock: ranWithoutLock(BUCKET),
      }),
    });
    expect(lines).toEqual([
      "✔ Removed what was left of factory fff-abcd1234",
      "",
      rule("Result"),
      "  Infrastructure    not found by EC2: no instance or VPC is tagged with the factory ID",
      `  Tailnet devices   ${DEVICES_NOT_CHECKED}`,
      `  Owned secrets     deleted ${OWNED.join(", ")}, each confirmed gone`,
      `  State bucket      ${BUCKET}: not found by this run, so not deleted by it`,
      "",
      `  ${ranWithoutLock(BUCKET)}`,
      "",
      rule("Next"),
      `  ${CHECK_UNCHECKED_DEVICES}`,
      `  ${checkOutsideEc2(FACTORY)}`,
      `  ${REVOKE_SOURCES}`,
      `  ${FACTORY_JSON_KEPT}`,
    ]);
    expect(lines.join("\n")).not.toMatch(/destroyed|, deleted$/m);
  });

  test("the commands it names repeat the instance and profile given", () => {
    const { lines } = outcome({ kind: "done", report: report() }, { instance: "/x/f.json" });
    expect(lines.at(-1)).toBe(
      "  factory.json is left as it is: teardown never changes it. It still describes the factory, so `fffactory apply --instance /x/f.json` would create a new one. Remove it yourself once you no longer need it.",
    );
  });
});

describe("refusals, a decline and failures (teardown §Refusals)", () => {
  test("no terminal and no --confirm", () => {
    expect(outcome({ kind: "unconfirmable" })).toEqual({
      stream: "err",
      lines: [`✖ ${TEARDOWN_UNCONFIRMABLE}`],
    });
  });

  test("a wrong --confirm, on standard error, never echoing the value", () => {
    expect(
      outcome({
        kind: "refused",
        refusals: [teardownConfirmMismatch(FACTORY)],
        operation: undefined,
        dispatchStopped: [],
      }),
    ).toEqual({
      stream: "err",
      lines: [
        "✖ Refusing to remove the factory: --confirm does not name the factory fff-abcd1234",
        "",
        rule("Next"),
        "  Pass --confirm fff-abcd1234 to remove it, or type the factory ID when asked at a terminal.",
      ],
    });
  });

  test("an incomplete factory.json lists each missing field", () => {
    const { lines } = outcome({ kind: "incomplete", missing: ["tailscale.tag"] });
    expect(lines).toEqual([
      "✖ Refusing to remove the factory: factory.json is not ready:",
      "  tailscale.tag: is required to remove a factory",
    ]);
  });

  test("every gate that refuses, the workers dispatch was left stopped on, and the record", () => {
    const { lines } = outcome(
      {
        kind: "refused",
        refusals: [
          {
            summary: "Agents are active on fff-abcd1234-builder-1",
            details: ["2 agents"],
            nextAction:
              "Wait, then rerun `fffactory teardown`. To remove the worker anyway, run `fffactory worker terminate builder-1 --force` first.",
          },
        ],
        operation: { bucket: BUCKET, key: "fff-abcd1234-operations/x.json" },
        dispatchStopped: ["fff-abcd1234-builder-1"],
        recordFailure: undefined,
      },
      { profile: "factory" },
    );
    expect(lines).toEqual([
      "✖ Refusing to remove the factory: Agents are active on fff-abcd1234-builder-1",
      "  2 agents",
      "",
      "Dispatch is stopped on fff-abcd1234-builder-1: `fffactory apply --profile factory` restarts it.",
      `Operation record: s3://${BUCKET}/fff-abcd1234-operations/x.json`,
      "",
      rule("Next"),
      "  Wait, then rerun `fffactory teardown --profile factory`. To remove the worker anyway, run `fffactory worker terminate builder-1 --force --profile factory` first.",
    ]);
  });

  test("declined: nothing removed", () => {
    expect(
      outcome({ kind: "declined", operation: undefined, recordFailure: undefined }).lines,
    ).toEqual(["Not confirmed: nothing was removed."]);
  });

  test("failed before the destroy: its diagnostics file, never Terraform's output", () => {
    const { lines } = outcome({
      kind: "failed",
      refusal: {
        summary: "Planning the factory's destruction failed: terraform plan exited 1",
        details: ["Nothing was removed."],
        nextAction: "Rerun `fffactory teardown`.",
      },
      operation: undefined,
      dispatchStopped: [],
      recordFailure: "AccessDenied",
      diagnosticsFile: "/cache/diagnostics/plan.log",
    });
    expect(lines).toEqual([
      "✖ Teardown failed: Planning the factory's destruction failed: terraform plan exited 1",
      "  Nothing was removed.",
      "",
      "Terraform's diagnostics: /cache/diagnostics/plan.log",
      "The operation record could not be finished: AccessDenied",
      "",
      rule("Next"),
      "  Rerun `fffactory teardown`.",
    ]);
  });
});

describe("stopped part way (teardown §Partial failure)", () => {
  test("what failed and what remains of each kind, then the rerun", () => {
    const remaining = remainingAt("secrets", {
      devices: [],
      listedDevices: { possible: [{ id: "n2CNTRL", hostname: undefined }], untagged: [] },
      secrets: [OWNED[0] as string],
      bucket: BUCKET,
    });
    const { stream, lines } = outcome({
      kind: "partial",
      stoppedAt: "secrets",
      remaining,
      refusal: stoppedPartWay(
        secretsRemain([{ name: OWNED[0] as string, reason: "AccessDeniedException" }]),
        remaining,
      ),
      operation: undefined,
      recordFailure: undefined,
    });
    expect(stream).toBe("err");
    expect(lines).toEqual([
      "✖ Teardown stopped part way, at the owned secrets: Not every secret the factory owns is gone",
      `  ${OWNED[0]}: AccessDeniedException`,
      "  Listed, not deleted: tailnet devices n2CNTRL",
      `  ${CHECK_LISTED_DEVICES}`,
      `  Remains: owned secrets ${OWNED[0]}`,
      "  Remains: the local saved plans",
      `  Remains: the state bucket ${BUCKET}`,
      "",
      rule("Next"),
      "  Check the credentials may delete and describe them, then rerun `fffactory teardown`.",
    ]);
  });
});

describe("interrupted (teardown §Interruption)", () => {
  test("holding the lock: interruptedTeardown's words, and the record", () => {
    const { lines } = outcome({
      kind: "interrupted",
      locked: true,
      record: { bucket: BUCKET, key: "fff-abcd1234-operations/x.json" },
      reached: "removing_devices",
      removing: true,
      dispatchStopped: [],
      listedDevices: NO_LISTED_DEVICES,
      lock: "held",
    });
    expect(lines).toEqual([
      "✖ Interrupted: the factory stays locked, with a record of this teardown",
      "  Teardown had begun removing the factory, and was deleting the tailnet devices: a rerun inventories again and finishes from what remains.",
      "",
      `Operation record: s3://${BUCKET}/fff-abcd1234-operations/x.json`,
      "",
      rule("Next"),
      "  Once fffactory has exited, break the lock with `fffactory lock break`, then rerun `fffactory teardown`.",
    ]);
  });

  test("before removing, where dispatch was left stopped", () => {
    const { lines } = outcome({
      kind: "interrupted",
      locked: true,
      record: undefined,
      reached: "inspecting",
      removing: false,
      dispatchStopped: ["fff-abcd1234-builder-1"],
      listedDevices: NO_LISTED_DEVICES,
      lock: "held",
    });
    expect(lines.slice(0, 3)).toEqual([
      "✖ Interrupted: the factory stays locked by this teardown, which may have no operation record",
      "  Nothing was removed.",
      "  Dispatch is stopped on fff-abcd1234-builder-1: `fffactory apply` restarts it.",
    ]);
  });

  test("without a state bucket: no lock, and never a lock break", () => {
    const { lines } = outcome({
      kind: "interrupted",
      locked: false,
      withoutLock: {
        reached: "removing_secrets",
        removing: true,
        record: false,
        dispatchStopped: [],
        listedDevices: NO_LISTED_DEVICES,
        lock: "none",
      },
    });
    expect(lines[0]).toBe(
      "✖ Interrupted: the factory is not locked, since it has no state bucket to hold a lock",
    );
    expect(lines.at(-1)).toBe("  Once fffactory has exited, rerun `fffactory teardown`.");
    expect(lines.join("\n")).not.toContain("lock break");
  });

  test("before the lock: nothing locked, nothing removed, no lock break", () => {
    expect(outcome({ kind: "interrupted", locked: false }).lines).toEqual([
      "✖ Interrupted before the factory was locked: it is not locked, and nothing was removed",
    ]);
  });
});

test("an unready state bucket is refused as plan refuses it", () => {
  const bucket = unreadyBucket(
    { bucket: BUCKET, accountId: "123456789012", region: "eu-west-2" },
    { versioning: "Enabled", publicAccessBlocked: true, encrypted: false, tlsOnly: true },
  );
  if (bucket === undefined) throw new Error("the bucket is ready");
  const { stream, lines } = outcome({ kind: "unready_bucket", bucket });
  expect(stream).toBe("err");
  expect(lines.slice(0, 2)).toEqual([
    `✖ The state bucket ${BUCKET} exists, but backend bootstrap did not finish it. It lacks:`,
    "  default encryption",
  ]);
});

test("a release mismatch and a held lock are refusals, on standard error", () => {
  expect(outcome({ kind: "release_mismatch", message: "factory.json pins 0.2.0" })).toEqual({
    stream: "err",
    lines: ["✖ Refusing to remove the factory: factory.json pins 0.2.0"],
  });
  expect(outcome({ kind: "locked", held: undefined }).stream).toBe("err");
});
