import { describe, expect, test } from "bun:test";
import {
  CHANGE_TYPES,
  type ChangeClass,
  type ChangeType,
  classifyChange,
  controlPlaneActions,
} from "../../src/domain/change-classification";

/** Every change type the spec's classification table names, with its expected class. */
const EXPECTED: Readonly<Record<ChangeType, ChangeClass>> = {
  schedule: "live",
  repository: "live",
  "dispatch-helper": "live",
  skill: "live",
  configuration: "live",
  "paseo-configuration": "reload-safe",
  "paseo-package": "maintenance",
  "service-definition": "maintenance",
  "listen-address": "maintenance",
  password: "maintenance",
  reboot: "maintenance",
};

describe("change classification", () => {
  test("names exactly the change types the spec table lists", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CHANGE_TYPES].sort());
  });

  test("classifies every change type as the spec table says", () => {
    for (const type of CHANGE_TYPES) {
      expect({ type, class: classifyChange(type) }).toEqual({ type, class: EXPECTED[type] });
    }
  });

  test("live changes are live: schedules, repositories, the dispatch helper, skills, configuration", () => {
    for (const type of [
      "schedule",
      "repository",
      "dispatch-helper",
      "skill",
      "configuration",
    ] as const)
      expect(classifyChange(type)).toBe("live");
  });

  test("a reload-safe Paseo configuration change is reload-safe", () => {
    expect(classifyChange("paseo-configuration")).toBe("reload-safe");
  });

  test("the package, service definition, listen address, password and reboot are maintenance", () => {
    for (const type of [
      "paseo-package",
      "service-definition",
      "listen-address",
      "password",
      "reboot",
    ] as const)
      expect(classifyChange(type)).toBe("maintenance");
  });
});

describe("the actions a plan's changes call for", () => {
  test("applies live changes and needs no reload or maintenance", () => {
    const actions = controlPlaneActions(["schedule", "repository"], false);
    expect(actions.live).toEqual(["schedule", "repository"]);
    expect(actions.reload).toBe(false);
    expect(actions.maintenance).toEqual({ kind: "none" });
  });

  test("a reload-safe change reloads, never restarts", () => {
    const actions = controlPlaneActions(["paseo-configuration"], false);
    expect(actions.reload).toBe(true);
    expect(actions.maintenance).toEqual({ kind: "none" });
  });

  test("a reload-safe change reloads even while agents are active", () => {
    expect(controlPlaneActions(["paseo-configuration"], true).reload).toBe(true);
  });

  test("a maintenance change with no active agents is applied", () => {
    const actions = controlPlaneActions(["paseo-package"], false);
    expect(actions.maintenance).toEqual({ kind: "apply", changes: ["paseo-package"] });
  });

  test("a maintenance change with active agents is deferred as pending, never applied", () => {
    const actions = controlPlaneActions(["service-definition", "password"], true);
    expect(actions.maintenance).toEqual({
      kind: "deferred",
      pending: ["service-definition", "password"],
    });
  });

  test("a restart supersedes a reload: an applied maintenance change does not also reload", () => {
    const actions = controlPlaneActions(["paseo-configuration", "paseo-package"], false);
    expect(actions.maintenance.kind).toBe("apply");
    expect(actions.reload).toBe(false);
  });

  test("a deferred maintenance change still lets a reload-safe change reload", () => {
    const actions = controlPlaneActions(["paseo-configuration", "paseo-package"], true);
    expect(actions.maintenance.kind).toBe("deferred");
    expect(actions.reload).toBe(true);
  });
});
