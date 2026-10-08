import { describe, expect, test } from "bun:test";
import {
  dispatchAdoptionExitCode,
  dispatchInspectionExitCode,
  dispatchProjection,
  dispatchProjectionJson,
  parseDispatchAdoption,
  parseDispatchInspection,
  parseDispatchProjection,
} from "../../src/domain/dispatch-projection";

const HOSTNAME = "fff-abcd1234-builder-1";
const SETTINGS = {
  enabled: true,
  cron: "*/15 * * * *",
  timezone: "America/Chicago",
  provider: "codex",
  model: "configured-model",
  mode: "default",
  cwd: "/home/factory",
} as const;

describe("the versioned dispatch host protocol", () => {
  test("round-trips the complete authoritative schedule as canonical JSON", () => {
    const projection = dispatchProjection(HOSTNAME, SETTINGS, true, []);
    expect(parseDispatchProjection(dispatchProjectionJson(projection))).toEqual({
      ok: true,
      projection,
    });
    expect(projection.schedule).toEqual({
      cron: "*/15 * * * *",
      timezone: "America/Chicago",
      provider: "codex",
      model: "configured-model",
      mode: "default",
      cwd: "/home/factory",
    });
  });

  test("represents disabled dispatch only as an unblocked absent schedule", () => {
    const projection = dispatchProjection(HOSTNAME, undefined, false, []);
    expect(projection).toMatchObject({
      requested: false,
      active: false,
      blockers: [],
      schedule: null,
    });
    expect(parseDispatchProjection(dispatchProjectionJson(projection)).ok).toBe(true);
  });

  test("refuses incomplete, contradictory, and noncanonical desired state", () => {
    expect(() =>
      dispatchProjection(HOSTNAME, { enabled: true, cron: "* * * * *" }, false, ["worker_release"]),
    ).toThrow("incomplete");
    expect(() => dispatchProjection(HOSTNAME, SETTINGS, true, ["worker_release"])).toThrow(
      "unblocked",
    );

    const pending = dispatchProjection(HOSTNAME, SETTINGS, false, ["worker_release"]);
    const contradictory = { ...pending, blockers: [] };
    expect(parseDispatchProjection(dispatchProjectionJson(contradictory))).toEqual({
      ok: false,
      reason: "inactive requested dispatch has no blocker",
    });
    expect(parseDispatchProjection(JSON.stringify(pending))).toEqual({
      ok: false,
      reason: "the dispatch projection is not canonical",
    });
  });

  test("reads only coherent observations and adoption results", () => {
    const active = {
      protocol_version: 1 as const,
      state: "active" as const,
      blockers: [] as const,
      changed: false,
    };
    expect(parseDispatchInspection(JSON.stringify(active))).toEqual(active);
    expect(
      parseDispatchInspection(
        JSON.stringify({ protocol_version: 1, state: "pending", blockers: [], changed: false }),
      ),
    ).toBeUndefined();
    expect(parseDispatchAdoption('{"protocol_version":1,"state":"passed"}')).toEqual({
      protocol_version: 1,
      state: "passed",
    });
    expect(parseDispatchAdoption('{"protocol_version":2,"state":"passed"}')).toBeUndefined();
  });

  test("binds each observed state to its host-command exit status", () => {
    expect(dispatchAdoptionExitCode({ protocol_version: 1, state: "passed" })).toBe(0);
    expect(dispatchAdoptionExitCode({ protocol_version: 1, state: "failed" })).toBe(2);
    expect(dispatchInspectionExitCode({ protocol_version: 1, state: "none" })).toBe(2);
    expect(
      dispatchInspectionExitCode({
        protocol_version: 1,
        state: "failed",
        blockers: [],
        reason: "drift",
      }),
    ).toBe(1);
  });
});
