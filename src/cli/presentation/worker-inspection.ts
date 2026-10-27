/**
 * `fffactory worker inspect`'s human output (`docs/specs/worker-lifecycle.md` §Inspect), laid out
 * from what the domain makes (`WorkerRemovability`): each worker's verdict and findings, its
 * agents by state, a tally, and one Next block of every refusal's next action; and its refusal of
 * a KEY factory.json does not declare. The words are the domain's; a summary, a detail or a
 * reason may carry a worker's words, so they are data, never read for inline code.
 */
import type { Refusal } from "../../domain/worker-lifecycle";
import type {
  RemovalInspection,
  RemovalVerdict,
  WorkerRemovability,
} from "../../domain/worker-removability";
import { agentsByState, agentsSummary, STATE_WORDS } from "./agents";
import { type Block, type Next, nextSteps, type Report, type Row, step, verbatim } from "./blocks";
import { type Selection, withCommands } from "./command-line";
import type { Status } from "./style";

const VERDICT_WORDS: Readonly<Record<RemovalVerdict, string>> = {
  removable: "removable",
  refused: "refused",
  not_inspected: "not inspected",
};

/** A verdict's glyph; a stopped machine keeps the operator's own state, `stopped`. */
function statusOf(inspection: RemovalInspection): Status {
  switch (inspection.verdict) {
    case "removable":
      return "ready";
    case "refused":
      return "attention";
    case "not_inspected":
      return inspection.not_inspected === "stopped" ? "stopped" : "skipped";
  }
}

/** The agents, counted and then by state, when the inspection read or tried to read them. */
function agentRows(inspection: RemovalInspection): Block[] {
  const { activity } = inspection;
  if (activity.agents === null && activity.reason === null) return [];
  const byState: Row[] = agentsByState(activity).map(({ state, ids }) => ({
    label: STATE_WORDS[state],
    value: [verbatim(ids.join(", "))],
  }));
  return [
    {
      kind: "rows",
      rows: [
        {
          label: "Agents",
          value: [verbatim(agentsSummary(activity))],
          ...(byState.length === 0 ? {} : { details: [{ kind: "rows", rows: byState }] }),
        },
      ],
    },
  ];
}

/** One worker: its verdict and summary, then its findings' details and its agents. */
function workerRows(inspection: RemovalInspection, labelWidth: number): Block {
  const details: Block[] = [
    ...(inspection.details.length === 0
      ? []
      : [{ kind: "text" as const, lines: inspection.details.map((detail) => [verbatim(detail)]) }]),
    ...agentRows(inspection),
  ];
  return {
    kind: "rows",
    labelWidth,
    rows: [
      {
        status: statusOf(inspection),
        label: inspection.key,
        value: [`${VERDICT_WORDS[inspection.verdict]} · `, verbatim(inspection.summary)],
        ...(details.length === 0 ? {} : { details }),
      },
    ],
  };
}

/** How many workers had each verdict, in the order removable, refused, not inspected. */
function tally(inspections: readonly RemovalInspection[]): Block {
  const counted = (["removable", "refused", "not_inspected"] as const)
    .map((verdict) => ({
      verdict,
      count: inspections.filter((inspection) => inspection.verdict === verdict).length,
    }))
    .filter(({ count }) => count > 0)
    .map(({ verdict, count }) => `${count} ${VERDICT_WORDS[verdict]}`);
  const refused = inspections.some((inspection) => inspection.verdict === "refused");
  return {
    kind: "verdict",
    status: refused ? "attention" : "ready",
    text: counted.length === 0 ? "No worker is declared" : counted.join(", "),
  };
}

/** Every refused worker's next action, named by its key, its commands repeating `selection`. */
function nextOf(workers: readonly WorkerRemovability[], selection: Selection): Next | undefined {
  const steps = workers.flatMap(({ inspection: { key }, next_action }) =>
    next_action === null
      ? []
      : [step([{ text: key, tone: "label" }, ": ", ...withCommands(next_action, selection)])],
  );
  return steps.length === 0 ? undefined : { paragraphs: [steps] };
}

/** The inspected workers, in factory.json's order, under a Workers section. */
export function inspectionReport(
  workers: readonly WorkerRemovability[],
  selection: Selection,
): Report {
  const inspections = workers.map(({ inspection }) => inspection);
  const labelWidth = Math.max(0, ...inspections.map(({ key }) => Bun.stringWidth(key)));
  const rows: Block[] =
    inspections.length === 0
      ? [{ kind: "text", lines: ["none declared"] }]
      : inspections.map((inspection) => workerRows(inspection, labelWidth));
  const next = nextOf(workers, selection);
  return {
    blocks: [{ kind: "section", title: "Workers", blocks: rows }, tally(inspections)],
    ...(next === undefined ? {} : { next }),
  };
}

/** Why KEY names no declared host (or is no host key at all), and how to name one. */
export function keyRefusalReport({ summary, details, nextAction }: Refusal): Report {
  return {
    blocks: [
      {
        kind: "verdict",
        status: "error",
        text: ["Refusing to inspect the worker: ", verbatim(summary)],
        ...(details.length === 0
          ? {}
          : { details: [{ kind: "text", lines: details.map((detail) => [verbatim(detail)]) }] }),
      },
    ],
    next: nextSteps(step(nextAction)),
  };
}
