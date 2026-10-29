/**
 * `fffactory teardown`'s human output (`docs/specs/teardown.md` §Output and exit codes), laid out
 * from what the use case returns as data: what will be removed and kept, before the confirmation;
 * each step as it runs; and how it ended. Its words for refusals, what remains and the advice it
 * leaves are the domain's (`src/domain/teardown.ts`); this lays them out. Only printable fields
 * reach it (`ShownMachine`, `ShownDevice`, `ShownSecret`): never a tag, a malformed host key, a
 * mismatched `--confirm` or a typed answer.
 */
import type { FactoryTeardown, TeardownProgress } from "../../application/teardown-factory";
import type { FactoryId } from "../../domain/instance";
import { changesSomething, changeTally, type ResourceChange } from "../../domain/plan";
import {
  archiveKept,
  CHECK_LISTED_DEVICES,
  CHECK_UNCHECKED_DEVICES,
  checkOutsideEc2,
  dispatchLeftStopped,
  factoryJsonKept,
  interruptedTeardown,
  type KeptSecrets,
  type ListedDevices,
  REVOKE_SOURCES,
  type ShownDevice,
  type ShownMachine,
  type ShownSecret,
  TEARDOWN_UNCONFIRMABLE,
  type TeardownBucket,
  type TeardownReport,
  type TeardownReview,
} from "../../domain/teardown";
import type { Refusal } from "../../domain/worker-lifecycle";
import {
  type Block,
  type Inline,
  type Next,
  type Report,
  type Row,
  step,
  verbatim,
} from "./blocks";
import { type Selection, withCommands } from "./command-line";
import { lockRefusalReport } from "./lock";
import { changeLine, planRefusalReport, targetRows } from "./plan";

/** What a refusal of teardown is called, as `plan` and `apply` call theirs. */
const ACTION = "remove the factory";

/** Data in a line, never read for inline code. */
const shown = (text: string): Inline => [verbatim(text)];

const listed = (items: readonly string[]): string => items.join(", ");

/** `ID (HOSTNAME)`, the hostname only when teardown derived it. */
const deviceText = ({ id, hostname }: ShownDevice): string =>
  hostname === undefined ? id : `${id} (${hostname})`;

/** `ID (KEY, STATE)`: the host key only when well-formed, a malformed one only marked. */
function machineText({ instanceId, state, hostKey, malformedHostKey }: ShownMachine): string {
  const key =
    hostKey !== undefined
      ? `${hostKey}, `
      : malformedHostKey
        ? "a host key tag that is not well-formed, "
        : "";
  return `${instanceId} (${key}${state})`;
}

const secretText = ({ name, arn }: ShownSecret): string => `${name} (${arn})`;

/** The destroy plan's deletes, each after its glyph. */
function changeLines(changes: readonly ResourceChange[]): Block[] {
  const changing = changes.filter(changesSomething);
  return changing.length === 0 ? [] : [{ kind: "text", lines: changing.map(changeLine) }];
}

/** A row only when it has something to list. */
const listRow = (label: string, items: readonly string[]): Row[] =>
  items.length === 0 ? [] : [{ label, value: shown(listed(items)) }];

/** The devices listed but kept (D9): possibly the factory's, or named like it without its tag. */
function listedDeviceRows({ possible, untagged }: ListedDevices): Row[] {
  return [
    ...listRow("Possibly its devices", possible.map(deviceText)),
    ...listRow("Untagged look-alikes", untagged.map(deviceText)),
  ];
}

/** The secrets kept: tagged but not owned, and referenced but not owned. */
function keptSecretRows(kept: KeptSecrets): Row[] {
  return [
    ...listRow("Tagged, not owned", kept.tagged.map(secretText)),
    ...listRow("Referenced", kept.referenced),
  ];
}

function bucketValue({ name, outcome }: TeardownBucket, done: boolean): Inline {
  if (outcome === "not_found")
    return [verbatim(name), ": not found by this run, so not deleted by it"];
  return [verbatim(name), done ? ", deleted" : ", deleted last, with the lock"];
}

/** The review's infrastructure: the destroy plan's deletes, or why there are none. */
function plannedInfrastructure(review: TeardownReview): Row {
  if (review.withoutLock !== undefined)
    return {
      label: "Infrastructure",
      value: "no destroy plan: EC2 lists nothing tagged with the factory ID",
    };
  const tally = changeTally(review.changes);
  if (tally.changing === 0)
    return { label: "Infrastructure", value: "nothing to destroy: the factory root is gone" };
  return {
    label: "Infrastructure",
    value: `${tally.destroy} to destroy`,
    details: changeLines(review.changes),
  };
}

function plannedDevices(review: TeardownReview, selection: Selection): Row {
  const { devices, devicesUnchecked } = review;
  if (devicesUnchecked !== undefined)
    return {
      label: "Tailnet devices",
      value: devicesUnchecked,
      details: [{ kind: "text", lines: [withCommands(CHECK_UNCHECKED_DEVICES, selection)] }],
    };
  const deleted = devices.deleted.map(deviceText);
  return {
    label: "Tailnet devices",
    value: deleted.length === 0 ? "none to delete" : shown(`delete ${listed(deleted)}`),
  };
}

function plannedSecrets(review: TeardownReview): Row[] {
  const { owned, absent } = review.secrets;
  return [
    {
      label: "Owned secrets",
      value:
        owned.length === 0
          ? "none to delete"
          : shown(`delete ${listed(owned.map(({ name }) => name))}, each confirmed gone`),
    },
    ...listRow("Already absent", absent),
  ];
}

/**
 * What teardown will remove and keep, shown before it is confirmed (§Order, step 10): its target,
 * the destroy plan's deletes, the instances and VPCs, the devices, the secrets and the state
 * bucket, then what it keeps, the log archive among it; without a state bucket, why it runs
 * without the lock.
 */
export function teardownReviewBlocks(review: TeardownReview, selection: Selection): Block[] {
  const remove: Row[] = [
    plannedInfrastructure(review),
    ...listRow("EC2 instances", review.machines.map(machineText)),
    ...listRow("VPCs", review.vpcIds),
    plannedDevices(review, selection),
    ...plannedSecrets(review),
    { label: "State bucket", value: bucketValue(review.bucket, false) },
  ];
  return [
    {
      kind: "section",
      title: "Teardown",
      blocks: [
        targetRows(review.target),
        { kind: "rows", rows: remove },
        ...withoutLockNote(review.withoutLock, selection),
      ],
    },
    ...keptSection(review.devices, review.secrets.kept, review.archive),
  ];
}

/**
 * What teardown keeps (D7, D9): the devices listed but not deleted, the kept secrets, then the log
 * archive, when factory.json enables one.
 */
function keptSection(
  devices: ListedDevices,
  kept: KeptSecrets,
  archive: string | undefined,
): Block[] {
  const rows = [...listedDeviceRows(devices), ...keptSecretRows(kept)];
  const blocks: Block[] = [
    ...(rows.length === 0 ? [] : [{ kind: "rows" as const, rows }]),
    ...(archive === undefined
      ? []
      : [{ kind: "text" as const, lines: [shown(archiveKept(archive))] }]),
  ];
  return blocks.length === 0 ? [] : [{ kind: "section", title: "Kept", blocks }];
}

/** Without a state bucket, why teardown runs without the lock (`ranWithoutLock`). */
function withoutLockNote(withoutLock: string | undefined, selection: Selection): Block[] {
  return withoutLock === undefined
    ? []
    : [{ kind: "text", lines: [withCommands(withoutLock, selection)] }];
}

/** The Removing section's rule, each step streamed under it as it starts. */
export const removingSection = (): Block => ({ kind: "section", title: "Removing", blocks: [] });

/** One step as it starts, after the review. */
export function teardownProgressLine(
  event: Exclude<TeardownProgress, { readonly kind: "review" }>,
): Block {
  const line = (text: Inline): Block => ({ kind: "text", lines: [text] });
  switch (event.kind) {
    case "stopping_dispatch":
      return line(shown(`Stopping dispatch on ${event.hostname}.`));
    case "uninspected_stopped":
      return line(
        shown(
          `${event.hostname} is stopped: it is not inspected, and unpushed work on its disk is destroyed with it.`,
        ),
      );
    case "destroying":
      return line(
        "Destroying the factory's resources. Terraform's output is not shown; this can take several minutes.",
      );
    case "removing_devices":
      return line("Deleting the factory's tailnet devices.");
    case "removing_secrets":
      return line("Deleting the owned secrets, confirming each is gone.");
    case "deleting_bucket":
      return line([verbatim(`Deleting the state bucket ${event.bucket}`), ", the lock last."]);
  }
}

/** How a teardown that ended was reported: its blocks and Next block, and on which stream. */
export interface TeardownOutcome {
  readonly stream: "out" | "err";
  readonly report: Report;
}

/** What the report needs beyond the result: the factory, the time, the instance and profile. */
export interface TeardownReporting {
  readonly factoryId: FactoryId | undefined;
  readonly now: Date;
  readonly selection: Selection;
}

const failed = (text: Inline, details: readonly Inline[] = []): Block => ({
  kind: "verdict",
  status: "error",
  text,
  ...(details.length === 0 ? {} : { details: [{ kind: "text", lines: details }] }),
});

/** A refusal's summary under `heading`, its details under it: data, never inline code. */
const refusalVerdict = (heading: string, refusal: Refusal): Block =>
  failed([`${heading}: `, verbatim(refusal.summary)], refusal.details.map(shown));

/** One Next block of every next action, each once, in order. */
function nextOf(actions: readonly string[], selection: Selection): Next | undefined {
  const unique = [...new Set(actions)];
  if (unique.length === 0) return undefined;
  return { paragraphs: [unique.map((action) => step(withCommands(action, selection)))] };
}

/** Where dispatch was left stopped, which `fffactory apply` restarts, and the record. */
function aftermath(
  result: {
    readonly operation?: { readonly bucket: string; readonly key: string } | undefined;
    readonly recordFailure?: string | undefined;
    readonly dispatchStopped?: readonly string[];
    readonly diagnosticsFile?: string | undefined;
  },
  selection: Selection,
): Block[] {
  const stopped = result.dispatchStopped ?? [];
  const lines: Inline[] = [
    ...(stopped.length === 0 ? [] : [withCommands(dispatchLeftStopped(stopped), selection)]),
    ...(result.diagnosticsFile === undefined
      ? []
      : [["Terraform's diagnostics: ", verbatim(result.diagnosticsFile)]]),
    ...(result.operation === undefined
      ? []
      : [
          [
            "Operation record: ",
            verbatim(`s3://${result.operation.bucket}/${result.operation.key}`),
          ],
        ]),
    ...(result.recordFailure === undefined
      ? []
      : [["The operation record could not be finished: ", verbatim(result.recordFailure)]]),
  ];
  return lines.length === 0 ? [] : [{ kind: "text", lines }];
}

/** What the finished teardown removed, by kind, and the references it did not find. */
function resultRows(report: TeardownReport): Row[] {
  const { devices, secrets } = report;
  const infrastructure: Row =
    report.infrastructure === "destroyed"
      ? {
          label: "Infrastructure",
          value: `destroyed: ${changeTally(report.changes).destroy} resources`,
          details: changeLines(report.changes),
        }
      : report.infrastructure === "absent"
        ? {
            label: "Infrastructure",
            value: "already absent: the destroy plan destroyed no resource",
          }
        : {
            label: "Infrastructure",
            value: "not found by EC2: no instance or VPC is tagged with the factory ID",
          };
  return [
    infrastructure,
    ...listRow("EC2 instances", report.machines.map(machineText)),
    {
      label: "Tailnet devices",
      value:
        report.devicesUnchecked ??
        (devices.removed.length === 0 ? "none found" : shown(`deleted ${listed(devices.removed)}`)),
    },
    {
      label: "Owned secrets",
      value:
        secrets.removed.length === 0
          ? "none found"
          : shown(`deleted ${listed(secrets.removed)}, each confirmed gone`),
    },
    ...listRow("Already absent", secrets.absent),
    { label: "State bucket", value: bucketValue(report.bucket, true) },
  ];
}

/**
 * The advice a finished teardown leaves (§Report): factory.json kept, with the log archive it
 * names, the persistent sources to revoke, the devices listed or not checked to check, and
 * without a state bucket the IAM outside EC2.
 */
function adviceNext(
  report: TeardownReport,
  factoryId: FactoryId | undefined,
  selection: Selection,
) {
  const listedAny = report.devices.possible.length + report.devices.untagged.length > 0;
  const advice = [
    ...(report.devicesUnchecked === undefined ? [] : [CHECK_UNCHECKED_DEVICES]),
    ...(listedAny ? [CHECK_LISTED_DEVICES] : []),
    ...(report.withoutLock === undefined || factoryId === undefined
      ? []
      : [checkOutsideEc2(factoryId)]),
    REVOKE_SOURCES,
    factoryJsonKept(report.archive),
  ];
  return nextOf(advice, selection);
}

/**
 * A finished teardown: what it removed and kept, then the advice it leaves. Its verdict claims
 * only what it removed: what it kept, the log archive among it, remains.
 */
function doneReport(report: TeardownReport, reporting: TeardownReporting): Report {
  const { factoryId, selection } = reporting;
  const named = factoryId === undefined ? "the factory" : `factory ${factoryId}`;
  const next = adviceNext(report, factoryId, selection);
  return {
    blocks: [
      {
        kind: "verdict",
        status: "ready",
        text:
          report.withoutLock === undefined
            ? `Removed ${named}: only what it kept remains`
            : `Removed what was left of ${named}`,
      },
      {
        kind: "section",
        title: "Result",
        blocks: [
          { kind: "rows", rows: resultRows(report) },
          ...withoutLockNote(report.withoutLock, selection),
        ],
      },
      ...keptSection(report.devices, report.secrets.kept, report.archive),
    ],
    ...(next === undefined ? {} : { next }),
  };
}

type Interrupted = Extract<FactoryTeardown, { readonly kind: "interrupted" }>;

/** An interruption as `interruptedTeardown` words it; before the lock, nothing to say but that. */
function interruptedReport(result: Interrupted, selection: Selection): Report {
  const at = result.locked
    ? {
        reached: result.reached,
        removing: result.removing,
        record: result.record !== undefined,
        dispatchStopped: result.dispatchStopped,
        listedDevices: result.listedDevices,
        lock: result.lock,
      }
    : result.withoutLock;
  if (at === undefined)
    return {
      blocks: [
        failed(
          "Interrupted before the factory was locked: it is not locked, and nothing was removed",
        ),
      ],
    };
  const words = interruptedTeardown(at);
  const record = result.locked ? aftermath({ operation: result.record }, selection) : [];
  const next = nextOf([words.nextAction], selection);
  return {
    blocks: [failed(shown(words.summary), words.details.map(shown)), ...record],
    ...(next === undefined ? {} : { next }),
  };
}

/** What teardown reports when its result is not the account check's refusal. */
export type ReportedTeardown = Exclude<FactoryTeardown, { readonly kind: "account_refused" }>;

/**
 * How the teardown ended, as one report on one stream: a finished one on standard output, with
 * what it removed and kept and the advice it leaves; any other on standard error, with what was
 * refused, failed or interrupted, what remains, and its next actions.
 */
export function teardownOutcome(
  result: ReportedTeardown,
  reporting: TeardownReporting,
): TeardownOutcome {
  const { selection, now } = reporting;
  const err = (report: Report): TeardownOutcome => ({ stream: "err", report });
  const context = { action: ACTION, now, selection };
  switch (result.kind) {
    case "done":
      return { stream: "out", report: doneReport(result.report, reporting) };
    case "unconfirmable":
      return err({ blocks: [failed(TEARDOWN_UNCONFIRMABLE)] });
    case "incomplete":
      return err(
        planRefusalReport(
          {
            kind: "refused",
            issues: result.missing.map((path) => ({
              path,
              message: "is required to remove a factory",
            })),
          },
          context,
        ),
      );
    case "release_mismatch":
      return err(planRefusalReport(result, context));
    case "unready_bucket":
      return err(planRefusalReport({ kind: "unready", bucket: result.bucket }, context));
    case "locked":
      return err(lockRefusalReport(result.held, now, selection));
    case "interrupted":
      return err(interruptedReport(result, selection));
    case "refused": {
      const next = nextOf(
        result.refusals.map(({ nextAction }) => nextAction),
        selection,
      );
      return err({
        blocks: [
          ...result.refusals.map((refusal) =>
            refusalVerdict("Refusing to remove the factory", refusal),
          ),
          ...aftermath(result, selection),
        ],
        ...(next === undefined ? {} : { next }),
      });
    }
    case "declined":
      return err({
        blocks: [
          { kind: "text", lines: ["Not confirmed: nothing was removed."] },
          ...aftermath(result, selection),
        ],
      });
    case "failed":
    case "partial": {
      const heading =
        result.kind === "failed"
          ? "Teardown failed"
          : `Teardown stopped part way, at ${STOPS[result.stoppedAt]}`;
      const next = nextOf([result.refusal.nextAction], selection);
      return err({
        blocks: [refusalVerdict(heading, result.refusal), ...aftermath(result, selection)],
        ...(next === undefined ? {} : { next }),
      });
    }
  }
}

/** Where a partial teardown stopped, in words. */
const STOPS: Readonly<Record<Extract<FactoryTeardown, { kind: "partial" }>["stoppedAt"], string>> =
  {
    destroy: "the destroy",
    leftovers: "the check that nothing tagged remains",
    devices: "the tailnet devices",
    secrets: "the owned secrets",
    plans: "the local saved plans",
    bucket: "the state bucket",
  };
