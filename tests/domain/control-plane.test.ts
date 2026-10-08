import { describe, expect, test } from "bun:test";
import {
  activityJson,
  controlPlaneActionJson,
  parseActivityDocument,
  parseControlPlaneActionDocument,
} from "../../src/domain/control-plane";

describe("control-plane protocol documents", () => {
  test.each([
    { kind: "idle" as const },
    { kind: "active" as const, count: 2 },
    { kind: "unknown" as const, reason: "Paseo did not answer" },
  ])("round-trips activity $kind", (activity) => {
    expect(parseActivityDocument(activityJson(activity))).toEqual({
      ok: true,
      document: { protocol_version: 1, activity },
    });
  });

  test.each([{ kind: "done" as const }, { kind: "failed" as const, reason: "reload failed" }])(
    "round-trips action $kind",
    (result) => {
      expect(parseControlPlaneActionDocument(controlPlaneActionJson(result))).toEqual({
        ok: true,
        document: { protocol_version: 1, result },
      });
    },
  );

  test.each([
    [{ kind: "active", count: 0 }, "positive count"],
    [{ kind: "active", count: 1.5 }, "positive count"],
    [{ kind: "unknown", reason: "" }, "short reason"],
    [{ kind: "unknown", reason: "x".repeat(201) }, "short reason"],
    [{ kind: "surprising" }, "known state"],
  ])("rejects invalid activity %#", (activity, problem) => {
    const parsed = parseActivityDocument(JSON.stringify({ protocol_version: 1, activity }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.kind === "invalid") expect(parsed.problem).toContain(problem);
  });

  test.each([
    [{ kind: "failed", reason: 42 }, "short reason"],
    [{ kind: "failed", reason: "" }, "short reason"],
    [{ kind: "surprising" }, "known state"],
  ])("rejects invalid action %#", (result, problem) => {
    const parsed = parseControlPlaneActionDocument(JSON.stringify({ protocol_version: 1, result }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.kind === "invalid") expect(parsed.problem).toContain(problem);
  });
});
