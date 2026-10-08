import { describe, expect, test } from "bun:test";
import {
  attentionCount,
  type CheckStatus,
  capability,
  doctorReport,
  exitCodeFor,
  failed,
  notReady,
  ready,
  thenRerun,
  worstStatus,
} from "../../src/domain/check-result";

const A = { id: "a", title: "A" };
const B = { id: "b", title: "B" };

describe("check results", () => {
  test("a ready check has no next action and empty details by default", () => {
    expect(ready(A, "fine")).toEqual({
      id: "a",
      title: "A",
      status: "ready",
      summary: "fine",
      details: [],
      nextAction: null,
    });
  });

  test("a not-ready or error check carries its next action and details", () => {
    expect(notReady(A, "absent", "Install it.", ["x"])).toEqual({
      id: "a",
      title: "A",
      status: "not_ready",
      summary: "absent",
      details: ["x"],
      nextAction: "Install it.",
    });
    expect(failed(B, "crashed", "Look.").status).toBe("error");
    expect(failed(B, "crashed", "Look.").nextAction).toBe("Look.");
  });

  test("next actions end by asking the operator to rerun doctor", () => {
    expect(thenRerun("Log in with `tailscale login`")).toBe(
      "Log in with `tailscale login`, then rerun `fffactory doctor`.",
    );
  });
});

describe("severity", () => {
  const cases: [CheckStatus[], CheckStatus][] = [
    [[], "ready"],
    [["ready", "ready"], "ready"],
    [["ready", "not_ready"], "not_ready"],
    [["not_ready", "error", "ready"], "error"],
    [["error", "not_ready"], "error"],
  ];
  for (const [statuses, expected] of cases) {
    test(`${JSON.stringify(statuses)} is ${expected}`, () => {
      expect(worstStatus(statuses)).toBe(expected);
    });
  }

  test("a capability takes the worst status of its checks", () => {
    const grouped = capability({ id: "tools", title: "Tools" }, [
      ready(A, "ok"),
      notReady(B, "absent", "Install it."),
    ]);
    expect(grouped.status).toBe("not_ready");
    expect(grouped.checks.map((check) => check.id)).toEqual(["a", "b"]);
  });

  test("a report takes the worst status of its capabilities and keeps their order", () => {
    const report = doctorReport([
      capability({ id: "one", title: "One" }, [ready(A, "ok")]),
      capability({ id: "two", title: "Two" }, [failed(B, "crashed", "Look.")]),
    ]);
    expect(report.status).toBe("error");
    expect(report.capabilities.map((group) => group.id)).toEqual(["one", "two"]);
  });

  test("counts the checks that are not ready", () => {
    const report = doctorReport([
      capability({ id: "one", title: "One" }, [ready(A, "ok"), notReady(B, "x", "y")]),
      capability({ id: "two", title: "Two" }, [failed(B, "crashed", "Look.")]),
    ]);
    expect(attentionCount(report)).toEqual({ attention: 2, total: 3 });
  });
});

describe("exit codes", () => {
  test("ready exits 0, not ready exits 2, error exits 1", () => {
    expect(exitCodeFor("ready")).toBe(0);
    expect(exitCodeFor("not_ready")).toBe(2);
    expect(exitCodeFor("error")).toBe(1);
  });
});
