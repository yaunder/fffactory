/**
 * `fffactory worker inspect`'s human output (`docs/specs/worker-lifecycle.md` §Inspect), laid out
 * from the inspection documents the domain makes. Pure: exact plain text.
 */
import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { render } from "../../../src/cli/presentation/blocks";
import { ansiStyle, plainStyle } from "../../../src/cli/presentation/style";
import {
  inspectionReport,
  keyRefusalReport,
} from "../../../src/cli/presentation/worker-inspection";
import type { HostKey } from "../../../src/domain/instance";
import {
  inspectGateActions,
  type WorkerRemovability,
  workerRemovability,
} from "../../../src/domain/worker-removability";
import { HOST_PROTOCOL_VERSION } from "../../../src/domain/host-protocol";

const rule = (title: string) => `── ${title} ${"─".repeat(Math.max(2, 49 - title.length))}`;

function worker(key: string) {
  return { key: key as HostKey, hostname: `fff-abcd1234-${key}` };
}

const SYNCHRONIZED = {
  protocol_version: HOST_PROTOCOL_VERSION,
  state: "synchronized",
  unmanaged: [],
} as const;
const NO_WORK = {
  kind: "inspected",
  inspection: {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname: "fff-abcd1234-builder-1",
    complete: true,
    repositories: [],
  },
} as const;

const REMOVABLE = workerRemovability(
  worker("builder-1"),
  {
    kind: "inspected",
    agents: [{ id: "agent-1", state: "finished", dispatched: true }],
    repositories: SYNCHRONIZED,
    work: NO_WORK,
    placed: [],
  },
  inspectGateActions("builder-1" as HostKey),
);
const BUSY = workerRemovability(
  worker("builder-2"),
  {
    kind: "activity",
    activity: { kind: "busy", working: 1, needsInput: 0 },
    agents: {
      kind: "listed",
      agents: [
        { id: "agent-1", state: "working", dispatched: true },
        { id: "agent-2", state: "finished", dispatched: false },
        { id: "agent-3", state: "finished", dispatched: true },
      ],
    },
  },
  inspectGateActions("builder-2" as HostKey),
);
const GONE = workerRemovability(
  worker("b"),
  { kind: "absent" },
  inspectGateActions("b" as HostKey),
);

function plain(workers: readonly WorkerRemovability[], instance?: string) {
  const report = inspectionReport(workers, { instance });
  return render(plainStyle, report.blocks, report.next);
}

describe("worker inspect's report (worker-lifecycle §Inspect)", () => {
  test("each worker's verdict and findings, its agents by state, a tally, and the next actions", () => {
    expect(plain([REMOVABLE, BUSY, GONE])).toEqual([
      rule("Workers"),
      "  ✔ builder-1   removable · fff-abcd1234-builder-1 can be terminated: no agent is working or needs input, and no work or checkout would be lost",
      "    Agents   1 finished (idle)",
      "      finished   agent-1 (dispatched)",
      "",
      "  ! builder-2   refused · 1 agent is working on fff-abcd1234-builder-2: terminating it would end it",
      "    Agents   1 working, 2 finished (busy)",
      "      working    agent-1 (dispatched)",
      "      finished   agent-2, agent-3 (dispatched)",
      "",
      "  ↷ b           not inspected · No EC2 instance carries its key: its machine is already gone.",
      "",
      "! 1 removable, 1 refused, 1 not inspected",
      "",
      rule("Next"),
      "  builder-2: Wait until no agent there is working or needs input, then rerun `fffactory worker inspect builder-2`, or terminate it anyway with `fffactory worker terminate builder-2 --force`.",
    ]);
  });

  test("a refusal's details are listed under it, and its commands repeat the instance given", () => {
    const dirty = workerRemovability(
      worker("builder-1"),
      {
        kind: "inspected",
        agents: [],
        repositories: SYNCHRONIZED,
        work: {
          kind: "unknown",
          reason: "no answer within 2 min",
          unsupported: false,
        },
        placed: [],
      },
      inspectGateActions("builder-1" as HostKey),
    );
    const lines = plain(
      [
        {
          ...dirty,
          inspection: {
            ...dirty.inspection,
            details: ["/workspace/repos/acme/widget: unreadable"],
          },
        },
      ],
      "/w/f.json",
    );
    expect(lines.slice(1, 5)).toEqual([
      "  ! builder-1   refused · fff-abcd1234-builder-1 could not be inspected for unpushed work: no answer within 2 min",
      "    /workspace/repos/acme/widget: unreadable",
      "",
      "    Agents   none (idle)",
    ]);
    expect(lines.at(-1)).toBe(
      "  builder-1: Check the worker with `fffactory status --instance /w/f.json`, then rerun " +
        "`fffactory worker inspect builder-1 --instance /w/f.json`, or terminate it uninspected " +
        "with `fffactory worker terminate builder-1 --force --instance /w/f.json`.",
    );
  });

  test("a stopped worker, never inspected, shows no agents; every worker removable is ready", () => {
    const stopped = workerRemovability(
      worker("builder-2"),
      { kind: "stopped" },
      inspectGateActions("builder-2" as HostKey),
    );
    expect(plain([REMOVABLE, stopped]).slice(-3)).toEqual([
      "  ◼ builder-2   not inspected · The machine is stopped: the worker is not inspected, and unpushed work on its disk is not reported.",
      "",
      "✔ 1 removable, 1 not inspected",
    ]);
  });

  test("its agents' states read as the count reads them: needing input", () => {
    const waiting = workerRemovability(
      worker("builder-1"),
      {
        kind: "activity",
        activity: { kind: "busy", working: 0, needsInput: 1 },
        agents: {
          kind: "listed",
          agents: [{ id: "agent-1", state: "needs_input", dispatched: true }],
        },
      },
      inspectGateActions("builder-1" as HostKey),
    );
    expect(plain([waiting]).slice(2, 4)).toEqual([
      "    Agents   1 needing input (busy)",
      "      needing input   agent-1 (dispatched)",
    ]);
  });

  test("a factory that declares no worker says so", () => {
    expect(plain([])).toEqual([rule("Workers"), "  none declared", "", "✔ No worker is declared"]);
  });

  test("a worker's own words are data, never inline code", () => {
    const odd = {
      ...BUSY,
      inspection: {
        ...BUSY.inspection,
        summary: "a `reason` from the worker",
        activity: { state: "unknown" as const, reason: "`odd`", agents: null },
      },
    };
    const report = inspectionReport([odd], {});
    const colored = render(ansiStyle, report.blocks);
    expect(colored.join("\n")).toContain("a `reason` from the worker");
    expect(stripVTControlCharacters(colored.join("\n"))).toContain("Agents   unknown (`odd`)");
  });
});

describe("worker inspect's refusal of KEY (worker-lifecycle §Inspect)", () => {
  test("says why, lists its details, and ends with its next action", () => {
    const report = keyRefusalReport({
      summary: "factory.json declares no host builder-9",
      details: ["Declared hosts: builder-1, builder-2"],
      nextAction: "Name a host factory.json declares (hosts[].key)",
    });
    expect(render(plainStyle, report.blocks, report.next)).toEqual([
      "✖ Refusing to inspect the worker: factory.json declares no host builder-9",
      "  Declared hosts: builder-1, builder-2",
      "",
      rule("Next"),
      "  Name a host factory.json declares (hosts[].key)",
    ]);
  });

  test("without details, only why and the next action; its words are data", () => {
    const report = keyRefusalReport({
      summary: "The KEY argument is not a `host key`",
      details: [],
      nextAction: "Name a host factory.json declares (hosts[].key)",
    });
    const colored = render(ansiStyle, report.blocks, report.next);
    expect(colored.map((line) => stripVTControlCharacters(line))).toEqual([
      "✖ Refusing to inspect the worker: The KEY argument is not a `host key`",
      "",
      rule("Next"),
      "  Name a host factory.json declares (hosts[].key)",
    ]);
    expect(colored[0]).toContain("`host key`");
  });
});
