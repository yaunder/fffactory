import { describe, expect, test } from "bun:test";
import { ended, errorCode, systemCode } from "../../src/host/failures";
import type { ProcessOutcome } from "../../src/infrastructure/local-tool-probe";

describe("a system error code, as fffactory says it", () => {
  test.each([
    ["EACCES", "EACCES"],
    ["ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_TYPE"],
    ["_UNDERSCORED", "_UNDERSCORED"],
    ["0DIGIT", "0DIGIT"],
    ["A".repeat(32), "A".repeat(32)],
    ["A".repeat(33), "unexpected error"],
    ["", "unexpected error"],
    ["eacces", "unexpected error"],
    ["EACCES secret", "unexpected error"],
    ["EACCES\n", "unexpected error"],
    [undefined, "unexpected error"],
    [13, "unexpected error"],
  ])("%p is said as %p", (code, said) => {
    expect(systemCode(code)).toBe(said);
  });

  test("an error's code is its `code`, or none", () => {
    expect(errorCode(Object.assign(new Error("denied"), { code: "EISDIR" }))).toBe("EISDIR");
    expect(errorCode(Object.assign(new Error("EISDIR"), { code: "not a code" }))).toBe(
      "unexpected error",
    );
    expect(errorCode(new Error("EISDIR"))).toBe("unexpected error");
    expect(errorCode(undefined)).toBe("unexpected error");
    expect(errorCode(null)).toBe("unexpected error");
  });
});

describe("how a command ended", () => {
  const exited = (exitCode: number): ProcessOutcome => ({
    kind: "exited",
    exitCode,
    stdout: "out secret",
    stderr: "err secret",
  });

  test.each([
    [exited(0), undefined],
    [exited(1), "running it exited with status 1"],
    [exited(137), "running it exited with status 137"],
    [{ kind: "timed_out" } as const, "running it timed out"],
    [{ kind: "not_found" } as const, "running it could not be started (ENOENT)"],
    [{ kind: "not_started", code: "EACCES" } as const, "running it could not be started (EACCES)"],
    [
      { kind: "not_started", code: "not a code" } as const,
      "running it could not be started (unexpected error)",
    ],
  ])("%p: %p, never the command's output", (outcome, said) => {
    expect(ended("running it", outcome)).toBe(said);
  });
});
