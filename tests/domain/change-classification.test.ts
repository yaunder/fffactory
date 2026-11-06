import { describe, expect, test } from "bun:test";
import {
  CHANGE_TYPES,
  type ChangeClass,
  type ChangeType,
  classifyChange,
  controlPlaneActions,
  maintenanceDeferral,
  preActivationDeferral,
} from "../../src/domain/change-classification";
import { OUTDATED_AGENTS, type WorkerActivity } from "../../src/domain/control-plane";
import type { HostKey } from "../../src/domain/instance";
import { replaceOutdatedWorker } from "../../src/domain/worker-lifecycle";

const IDLE: WorkerActivity = { kind: "idle" };
const WORKING: WorkerActivity = { kind: "busy", working: 1, needsInput: 0 };
const WORKER = { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" };

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
    const actions = controlPlaneActions(["schedule", "repository"], IDLE);
    expect(actions.live).toEqual(["schedule", "repository"]);
    expect(actions.reload).toBe(false);
    expect(actions.maintenance).toEqual({ kind: "none" });
  });

  test("a reload-safe change reloads, never restarts", () => {
    const actions = controlPlaneActions(["paseo-configuration"], IDLE);
    expect(actions.reload).toBe(true);
    expect(actions.maintenance).toEqual({ kind: "none" });
  });

  test("a reload-safe change reloads even while agents are busy", () => {
    expect(controlPlaneActions(["paseo-configuration"], WORKING).reload).toBe(true);
  });

  test("a maintenance change with no busy agent is applied", () => {
    const actions = controlPlaneActions(["paseo-package"], IDLE);
    expect(actions.maintenance).toEqual({ kind: "apply", changes: ["paseo-package"] });
  });

  test("a maintenance change with busy agents is deferred as pending, never applied", () => {
    const actions = controlPlaneActions(["service-definition", "password"], WORKING);
    expect(actions.maintenance).toEqual({
      kind: "deferred",
      pending: ["service-definition", "password"],
      activity: WORKING,
    });
  });

  test("a restart supersedes a reload: an applied maintenance change does not also reload", () => {
    const actions = controlPlaneActions(["paseo-configuration", "paseo-package"], IDLE);
    expect(actions.maintenance.kind).toBe("apply");
    expect(actions.reload).toBe(false);
  });

  test("a deferred maintenance change still lets a reload-safe change reload", () => {
    const actions = controlPlaneActions(["paseo-configuration", "paseo-package"], WORKING);
    expect(actions.maintenance.kind).toBe("deferred");
    expect(actions.reload).toBe(true);
  });

  test("a maintenance change on a worker with only finished agents is applied", () => {
    // The busy rule decides: finished, failed and stopped agents never defer maintenance (#92).
    expect(controlPlaneActions(["paseo-package"], IDLE).maintenance.kind).toBe("apply");
  });

  test("activity that could not be read defers like busy activity", () => {
    const unknown: WorkerActivity = { kind: "unknown", reason: "no answer", outdated: false };
    expect(controlPlaneActions(["paseo-package"], unknown).maintenance).toEqual({
      kind: "deferred",
      pending: ["paseo-package"],
      activity: unknown,
    });
  });
});

describe("how a deferral is worded (control-plane §Pre-activation deferral)", () => {
  test("busy agents are named, how many of each, and waited for", () => {
    expect(
      maintenanceDeferral(WORKER, ["paseo-package", "password"], {
        kind: "busy",
        working: 2,
        needsInput: 1,
      }),
    ).toEqual({
      summary:
        "Maintenance (paseo-package, password) was deferred while 2 agents are working and 1 needs input on fff-abcd1234-builder-1; it stays on its complete current release",
      nextAction:
        "Wait until no agent on fff-abcd1234-builder-1 is working or needs input, then rerun `fffactory apply`",
    });
  });

  test("agents that could not be read may be busy: the worker is checked, then apply rerun", () => {
    expect(
      maintenanceDeferral(WORKER, ["paseo-package"], {
        kind: "unknown",
        reason: "Paseo activity could not be read",
        outdated: false,
      }),
    ).toEqual({
      summary:
        "Maintenance (paseo-package) was deferred while agents may be busy on fff-abcd1234-builder-1 (Paseo activity could not be read); it stays on its complete current release",
      nextAction: "Check the worker with `fffactory status`, then rerun `fffactory apply`",
    });
  });

  test("a worker on a release from before agent states is replaced (D4)", () => {
    expect(
      maintenanceDeferral(WORKER, ["paseo-package"], {
        kind: "unknown",
        reason: OUTDATED_AGENTS,
        outdated: true,
      }),
    ).toEqual({
      summary:
        "Maintenance (paseo-package) was deferred while agents may be busy on fff-abcd1234-builder-1 (its release predates fffactory's agent states); it stays on its complete current release",
      nextAction: replaceOutdatedWorker(WORKER),
    });
  });

  test("the workers and dispatch stages skip a deferred worker with the deferral's next action", () => {
    const deferral = maintenanceDeferral(WORKER, ["paseo-package"], WORKING);
    expect(preActivationDeferral(deferral)).toEqual({
      summary: "Paseo maintenance is deferred while agents may be busy",
      nextAction: deferral.nextAction,
    });
  });
});
