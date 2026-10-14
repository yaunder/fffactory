import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
  type Block,
  type Next,
  type Row,
  render,
  renderInSection,
} from "../../../src/cli/presentation/blocks";
import { ansiStyle, plainStyle } from "../../../src/cli/presentation/style";

const HEADER: Block = {
  kind: "text",
  lines: [
    [{ text: "fffactory apply", tone: "heading" }, " · release 0.0.0"],
    [{ text: "Instance", tone: "label" }, "  ~/…/test-factory/.fffactory/factory.json (nearest)"],
  ],
};

const TARGET: Block = {
  kind: "rows",
  rows: [
    { label: "Factory", value: "Test factory (fff-aaaa1111)" },
    { label: "Account", value: "123456789012 · us-east-1" },
    { label: "Release", value: "0.0.0" },
  ],
};

const STAGES: Block = {
  kind: "rows",
  rows: [
    { label: "Infrastructure", value: "no changes" },
    {
      label: "Workers",
      value: "one at a time",
      details: [
        {
          kind: "rows",
          rows: [
            {
              status: "update",
              label: "test-builder-1",
              value: "install release 0.0.0 and host configuration, then verify",
            },
          ],
        },
      ],
    },
  ],
};

const RESULT: Block = {
  kind: "rows",
  rows: [
    { label: "Infrastructure", value: "no changes" },
    {
      status: "attention",
      label: "test-builder-1",
      value: [
        "installed and verified · ",
        { text: "enrollment pending", tone: "attention" },
        " (3)",
      ],
    },
    { label: "Operation record", value: "s3://fff-aaaa1111-state/…/mlrqnb5n.json" },
  ],
};

const STALE: Block = {
  kind: "verdict",
  status: "error",
  text: "Refusing to apply: the saved plan is stale",
  details: [{ kind: "text", lines: ["factory.json changed since the plan was made"] }],
};

const HOST = "fff-aaaa1111-test-builder-1";
const ENROLL: Next = {
  title: "enroll 3 accounts on test-builder-1",
  paragraphs: [
    [
      {
        kind: "step",
        text: "Log in as factory (tailnet SSH policy must allow it):",
        commands: [`tailscale ssh factory@${HOST}`],
      },
    ],
    [
      {
        kind: "numbered",
        groups: [
          {
            title: "GitHub",
            commands: [
              "gh auth login --hostname github.com --git-protocol https --web",
              "gh auth status",
            ],
          },
          { title: "OpenAI Codex", commands: ["codex login --device-auth", "codex login status"] },
          { title: "Claude Code", commands: ["claude auth login", "claude auth status"] },
        ],
      },
    ],
    [
      { kind: "step", text: "Return to your workstation:", commands: ["exit"] },
      {
        kind: "step",
        text: "Refresh enrollment verification, reviewing the new plan:",
        commands: ["fffactory apply"],
      },
      { kind: "step", text: "Then confirm:", commands: ["fffactory status"] },
      {
        kind: "note",
        text: "Paseo clients: enrollment is checked from each client, not the worker",
      },
    ],
  ],
};

const ENROLL_TEXT = [
  "── Next: enroll 3 accounts on test-builder-1 ────────",
  "  Log in as factory (tailnet SSH policy must allow it):",
  `    $ tailscale ssh factory@${HOST}`,
  "",
  "  1. GitHub",
  "     $ gh auth login --hostname github.com --git-protocol https --web",
  "     $ gh auth status",
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
];

/** Every example of this file, each with any Next block, so a test can go over them all. */
const EXAMPLES: readonly [readonly Block[], Next?][] = [
  [[HEADER]],
  [[{ kind: "section", title: "Plan", blocks: [TARGET, STAGES] }]],
  [[{ kind: "section", title: "Result", blocks: [RESULT] }], ENROLL],
  [
    [STALE],
    { paragraphs: [[{ kind: "step", text: "Make a new plan:", commands: ["fffactory plan"] }]] },
  ],
];

describe("text (cli output §Text)", () => {
  test("lines are printed as they are", () => {
    expect(render(plainStyle, [HEADER])).toEqual([
      "fffactory apply · release 0.0.0",
      "Instance  ~/…/test-factory/.fffactory/factory.json (nearest)",
    ]);
  });

  test("marked spans take their role in color", () => {
    expect(render(ansiStyle, [HEADER])[0]).toBe(
      `${ansiStyle.heading("fffactory apply")} · release 0.0.0`,
    );
  });
});

describe("sections (cli output §Section)", () => {
  test("a 53-column rule with the title, then the section's blocks indented, a blank line apart", () => {
    expect(
      render(plainStyle, [HEADER, { kind: "section", title: "Plan", blocks: [TARGET, STAGES] }]),
    ).toEqual([
      "fffactory apply · release 0.0.0",
      "Instance  ~/…/test-factory/.fffactory/factory.json (nearest)",
      "",
      "── Plan ─────────────────────────────────────────────",
      "  Factory   Test factory (fff-aaaa1111)",
      "  Account   123456789012 · us-east-1",
      "  Release   0.0.0",
      "",
      "  Infrastructure   no changes",
      "  Workers          one at a time",
      "    ~ test-builder-1   install release 0.0.0 and host configuration, then verify",
    ]);
  });

  test("an empty line in a section is blank, with no indentation left on it", () => {
    const notes: Block = { kind: "text", lines: ["first", "", "second"] };
    expect(
      render(plainStyle, [{ kind: "section", title: "Notes", blocks: [notes] }]).slice(1),
    ).toEqual(["  first", "", "  second"]);
  });

  test("a title too long for the width still ends in two rule characters", () => {
    const title = "x".repeat(60);
    expect(render(plainStyle, [{ kind: "section", title, blocks: [] }])).toEqual([
      `── ${title} ──`,
    ]);
  });

  test("in color the rule is dim and the title a heading", () => {
    const [rule] = render(ansiStyle, [{ kind: "section", title: "Plan", blocks: [] }]);
    expect(rule).toBe(
      `${ansiStyle.rule("──")} ${ansiStyle.heading("Plan")} ${ansiStyle.rule("─".repeat(45))}`,
    );
    expect(Bun.stringWidth(rule ?? "")).toBe(53);
  });
});

describe("rows (cli output §Rows)", () => {
  test("labels are padded to the widest, then three spaces, then the value", () => {
    expect(render(plainStyle, [TARGET])).toEqual([
      "Factory   Test factory (fff-aaaa1111)",
      "Account   123456789012 · us-east-1",
      "Release   0.0.0",
    ]);
  });

  test("when any row has a status, every row has the status column", () => {
    expect(render(plainStyle, [RESULT])).toEqual([
      "  Infrastructure     no changes",
      "! test-builder-1     installed and verified · enrollment pending (3)",
      "  Operation record   s3://fff-aaaa1111-state/…/mlrqnb5n.json",
    ]);
  });

  test("a row without a value is its label alone, with no trailing space", () => {
    expect(
      render(plainStyle, [
        { kind: "rows", rows: [{ label: "Workers" }, { label: "Infrastructure", value: "none" }] },
      ]),
    ).toEqual(["Workers", "Infrastructure   none"]);
  });

  test("a fixed label width aligns rows rendered one at a time", () => {
    const progress = (value: string): Block => ({
      kind: "rows",
      labelWidth: 14,
      rows: [{ label: "builder-1", value }],
    });
    expect([
      ...render(plainStyle, [progress("uploading 35.3 MiB")]),
      ...render(plainStyle, [progress("installing and verifying")]),
    ]).toEqual([
      "builder-1        uploading 35.3 MiB",
      "builder-1        installing and verifying",
    ]);
  });

  test("rows streamed one at a time into a section align, indented under its rule", () => {
    const uploading = { label: "test-builder-1", value: "uploading 35.3 MiB" };
    const installing = {
      label: "test-builder-1",
      value: "installing and verifying (can take many minutes)",
    };
    const progress = (...rows: Row[]): Block => ({ kind: "rows", labelWidth: 14, rows });
    const streamed = [
      ...render(plainStyle, [{ kind: "section", title: "Applying", blocks: [] }]),
      ...renderInSection(plainStyle, [progress(uploading)]),
      ...renderInSection(plainStyle, [progress(installing)]),
    ];
    expect(streamed).toEqual([
      "── Applying ─────────────────────────────────────────",
      "  test-builder-1   uploading 35.3 MiB",
      "  test-builder-1   installing and verifying (can take many minutes)",
    ]);
    expect(
      render(plainStyle, [
        { kind: "section", title: "Applying", blocks: [progress(uploading, installing)] },
      ]),
    ).toEqual(streamed);
  });

  test("a row with a status and no text is its glyph alone, with no trailing space", () => {
    expect(
      render(plainStyle, [
        { kind: "rows", rows: [{ status: "ready", label: "" }, { label: "" }, { label: "b-1" }] },
      ]),
    ).toEqual(["✔", "", "  b-1"]);
  });

  test("columns align in color, escape sequences and glyphs measured as the terminal shows them", () => {
    const rows: Block = {
      kind: "rows",
      rows: [
        { status: "ready", label: "builder-1", value: "ready" },
        { status: "error", label: "`b-2`", value: "failed" },
        { label: [{ text: "Operation record", tone: "muted" }], value: "s3://bucket/key" },
      ],
    };
    const columns = (lines: string[]) =>
      lines.map((line) => stripVTControlCharacters(line).search(/ (ready|failed|s3:)/));
    const colored = render(ansiStyle, [rows]);
    expect(colored.every((line) => line.includes("\x1b["))).toBe(true);
    expect(new Set(columns(colored)).size).toBe(1);
    expect(new Set(columns(render(plainStyle, [rows]))).size).toBe(1);
    expect(stripVTControlCharacters(colored[0] ?? "")).toBe("✔ builder-1          ready");
    expect(stripVTControlCharacters(colored[1] ?? "")).toBe("✖ b-2                failed");
  });

  test("in color a status colors its glyph and marked text, and labels are bold", () => {
    expect(render(ansiStyle, [RESULT])[1]).toBe(
      `${ansiStyle.glyph("attention")} ${ansiStyle.label("test-builder-1")}     ` +
        `installed and verified · ${ansiStyle.status("attention", "enrollment pending")} (3)`,
    );
  });
});

describe("details and verdicts (cli output §Details, §Verdict)", () => {
  test("a verdict is its glyph and text, its details indented under it", () => {
    expect(render(plainStyle, [STALE])).toEqual([
      "✖ Refusing to apply: the saved plan is stale",
      "  factory.json changed since the plan was made",
    ]);
  });

  test("a verdict without text is its glyph alone, with no trailing space", () => {
    const empty: Block = { kind: "verdict", status: "error", text: "" };
    expect(render(plainStyle, [empty])).toEqual(["✖"]);
    expect(render(ansiStyle, [empty])).toEqual([ansiStyle.verdict("error", "✖")]);
  });

  test("in color a verdict's glyph and text are bold in its status's color", () => {
    expect(render(ansiStyle, [STALE])[0]).toBe(
      `${ansiStyle.verdict("error", "✖")} ${ansiStyle.verdict("error", "Refusing to apply: the saved plan is stale")}`,
    );
  });
});

describe("the Next block (cli output §Next)", () => {
  test("a shared preamble, numbered groups of command lines, then the closing steps and a note", () => {
    expect(render(plainStyle, [], ENROLL)).toEqual(ENROLL_TEXT);
  });

  test("in color, `$ ` is dim and commands bold cyan, the title a heading, the note muted", () => {
    const lines = render(ansiStyle, [], ENROLL);
    expect(lines[0]).toStartWith(
      `${ansiStyle.rule("──")} ${ansiStyle.heading("Next: enroll 3 accounts on test-builder-1")} `,
    );
    expect(lines[2]).toBe(`    ${ansiStyle.command(`tailscale ssh factory@${HOST}`)}`);
    expect(lines[5]).toBe(
      `     ${ansiStyle.command("gh auth login --hostname github.com --git-protocol https --web")}`,
    );
    expect(lines.at(-1)).toBe(
      `  ${ansiStyle.muted("Paseo clients: enrollment is checked from each client, not the worker")}`,
    );
    expect(lines.map((line) => stripVTControlCharacters(line))).toEqual(ENROLL_TEXT);
  });

  test("numbered groups align their commands past two-digit numbers", () => {
    const groups = Array.from({ length: 10 }, (_, index) => ({
      title: `Account ${index + 1}`,
      commands: ["true"],
    }));
    const lines = render(plainStyle, [], { paragraphs: [[{ kind: "numbered", groups }]] });
    expect(lines.slice(1, 3)).toEqual(["   1. Account 1", "      $ true"]);
    expect(lines.slice(-2)).toEqual(["  10. Account 10", "      $ true"]);
  });

  test("a render prints at most one Next block, always last and a blank line after the rest", () => {
    const [blocks, next] = EXAMPLES[3] ?? [[]];
    expect(render(plainStyle, blocks, next)).toEqual([
      "✖ Refusing to apply: the saved plan is stale",
      "  factory.json changed since the plan was made",
      "",
      "── Next ─────────────────────────────────────────────",
      "  Make a new plan:",
      "    $ fffactory plan",
    ]);
    expect(render(plainStyle, blocks).some((line) => line.includes("Next"))).toBe(false);
  });
});

describe("inline code (cli output §Layout blocks, §Style roles)", () => {
  const message: Block = {
    kind: "text",
    lines: ["break the lock with `fffactory lock break`, or wait", "a lone ` stays"],
  };

  test("plain output keeps the backticks", () => {
    expect(render(plainStyle, [message])).toEqual([
      "break the lock with `fffactory lock break`, or wait",
      "a lone ` stays",
    ]);
  });

  test("color drops a matched pair's backticks and makes the code cyan; a lone backtick stays", () => {
    expect(render(ansiStyle, [message])).toEqual([
      `break the lock with ${ansiStyle.code("fffactory lock break")}, or wait`,
      "a lone ` stays",
    ]);
  });

  test("a span marked as code is inline code, in a Next block's title too", () => {
    const next: Next = {
      title: ["run ", { text: "fffactory status", tone: "code" }],
      paragraphs: [[{ kind: "note", text: [{ text: "--json", tone: "code" }, " for a document"] }]],
    };
    expect(render(plainStyle, [], next)).toEqual([
      "── Next: run `fffactory status` ─────────────────────",
      "  `--json` for a document",
    ]);
    expect(render(ansiStyle, [], next)[0]).toStartWith(
      `${ansiStyle.rule("──")} ${ansiStyle.heading("Next: ")}${ansiStyle.heading("run ")}${ansiStyle.code("fffactory status")} `,
    );
  });
});

describe("plain output (cli output §Plain output)", () => {
  test("no example writes an escape sequence or a trailing space", () => {
    for (const [blocks, next] of EXAMPLES)
      for (const line of render(plainStyle, blocks, next)) {
        expect(line).not.toContain("\x1b");
        expect(line).toBe(line.trimEnd());
      }
  });

  test("color changes no example's layout: without escapes it is the plain text", () => {
    for (const [blocks, next] of EXAMPLES) {
      const colored = render(ansiStyle, blocks, next);
      expect(colored.join("\n")).toContain("\x1b[");
      expect(colored.map((line) => stripVTControlCharacters(line))).toEqual(
        render(plainStyle, blocks, next),
      );
      for (const line of colored) expect(line).toBe(line.trimEnd());
    }
  });

  test("color drops only inline code's backticks: without escapes it is the plain text without them", () => {
    const line: Block = {
      kind: "text",
      lines: ["break the lock with `fffactory lock break`, or wait"],
    };
    const [plain] = render(plainStyle, [line]);
    const [colored] = render(ansiStyle, [line]);
    expect(colored).toContain("\x1b[");
    expect(stripVTControlCharacters(colored ?? "")).toBe((plain ?? "").replaceAll("`", ""));
  });
});
