import { describe, expect, test } from "bun:test";
import type { FactoryInstance, HostKey } from "../../src/domain/instance";
import type { Machine } from "../../src/domain/status";
import {
  confirmationQuestion,
  confirmationRule,
  confirms,
  hostKeyRefusal,
  machineGone,
  ONLINE_DEADLINE_MS,
  POWER_DEADLINE_MS,
  powerStep,
  powerTimedOut,
  requestFailed,
  requestUnanswered,
  selectMachine,
  stopGate,
  thenRerunWorker,
  unconfirmable,
  waitStep,
  WORKER_OPERATIONS,
} from "../../src/domain/worker-lifecycle";

const KEY = "builder-1" as HostKey;
const WORKER = { key: KEY, hostname: "fff-abcd1234-builder-1" };
const ID = "i-0123456789abcdef0";

function machine(state: Machine["state"], hostKey = "builder-1", instanceId = ID): Machine {
  return { instanceId, state, hostKey };
}

function declaring(...keys: string[]): FactoryInstance {
  return {
    schema_version: 1,
    hosts: keys.map((key) => ({ key: key as HostKey })),
  };
}

describe("the worker lifecycle commands (worker-lifecycle §Commands)", () => {
  test("hold the lock as operations named for the action", () => {
    expect(WORKER_OPERATIONS).toEqual({ stop: "worker-stop", start: "worker-start" });
  });

  test("complete every next action by rerunning the same command", () => {
    expect(thenRerunWorker("stop", KEY)("Wait")).toBe(
      "Wait, then rerun `fffactory worker stop builder-1`.",
    );
  });
});

describe("the host key (worker-lifecycle §Order)", () => {
  test("a declared key is accepted", () => {
    expect(hostKeyRefusal("builder-2", declaring("builder-1", "builder-2"))).toBeUndefined();
  });

  test("an undeclared key is refused, naming the keys factory.json declares", () => {
    expect(hostKeyRefusal("builder-3", declaring("builder-1", "builder-2"))).toEqual({
      summary: "factory.json declares no host builder-3",
      details: ["Declared hosts: builder-1, builder-2"],
      nextAction: "Name a host factory.json declares (hosts[].key)",
    });
    expect(hostKeyRefusal("builder-1", declaring())?.details).toEqual([
      "factory.json declares no hosts",
    ]);
  });

  test("an argument that is not a host key is refused without echoing it", () => {
    const refusal = hostKeyRefusal("AKIAIOSFODNN7EXAMPLE", declaring("builder-1"));
    expect(refusal?.summary).toBe("The KEY argument is not a host key");
    expect(JSON.stringify(refusal)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("the target machine (worker-lifecycle §Order)", () => {
  test("is the one instance carrying the host key", () => {
    const inventory = {
      kind: "machines" as const,
      machines: [machine("running", "other", "i-1111111111111111a"), machine("stopped")],
    };
    expect(selectMachine(inventory, KEY, "start")).toEqual({
      kind: "found",
      machine: machine("stopped"),
    });
  });

  test("none is refused: there is nothing to act on", () => {
    expect(selectMachine({ kind: "machines", machines: [] }, KEY, "stop")).toEqual({
      kind: "refused",
      refusal: {
        summary: "No EC2 instance carries the host key builder-1",
        details: [],
        nextAction:
          "Provision it with `fffactory apply`, then rerun `fffactory worker stop builder-1`.",
      },
    });
  });

  test("several are refused, each listed: fffactory never guesses", () => {
    const selection = selectMachine(
      { kind: "machines", machines: [machine("running"), machine("stopped", KEY, "i-0fedcba98")] },
      KEY,
      "start",
    );
    expect(selection).toEqual({
      kind: "refused",
      refusal: {
        summary:
          "2 EC2 instances carry the host key builder-1; fffactory never guesses which is the worker",
        details: [`Instance: ${ID}`, "Instance: i-0fedcba98"],
        nextAction:
          "Find the instance that is not this worker in the EC2 console and remove it yourself, " +
          "then rerun `fffactory worker start builder-1`.",
      },
    });
  });

  test("an inventory that could not be read is refused, naming the failure", () => {
    expect(
      selectMachine(
        { kind: "unavailable", reason: "EC2 DescribeInstances failed: AccessDenied" },
        KEY,
        "stop",
      ),
    ).toEqual({
      kind: "refused",
      refusal: {
        summary: "EC2 DescribeInstances failed: AccessDenied",
        details: [],
        nextAction:
          "Check your network connection and that the credentials may call " +
          "ec2:DescribeInstances, then rerun `fffactory worker stop builder-1`.",
      },
    });
  });
});

describe("what each EC2 state means for an action (worker-lifecycle §Stop, §Start)", () => {
  test("stop acts on a running worker, waits for a stopping one, and is done with a stopped one", () => {
    expect(powerStep("stop", machine("running"), KEY)).toEqual({ kind: "act" });
    expect(powerStep("stop", machine("stopping"), KEY)).toEqual({ kind: "await" });
    expect(powerStep("stop", machine("stopped"), KEY)).toEqual({ kind: "done" });
  });

  test("start acts on a stopped worker, waits for a pending one, and is done with a running one", () => {
    expect(powerStep("start", machine("stopped"), KEY)).toEqual({ kind: "act" });
    expect(powerStep("start", machine("pending"), KEY)).toEqual({ kind: "await" });
    expect(powerStep("start", machine("running"), KEY)).toEqual({ kind: "done" });
  });

  test("a machine on its way to the other state is refused until it gets there", () => {
    expect(powerStep("stop", machine("pending"), KEY)).toEqual({
      kind: "refused",
      refusal: {
        summary: `EC2 instance ${ID} is pending`,
        details: [],
        nextAction: "Wait until it is running, then rerun `fffactory worker stop builder-1`.",
      },
    });
    expect(powerStep("start", machine("stopping"), KEY)).toEqual({
      kind: "refused",
      refusal: {
        summary: `EC2 instance ${ID} is stopping`,
        details: [],
        nextAction: "Wait until it has stopped, then rerun `fffactory worker start builder-1`.",
      },
    });
  });

  test("a machine being terminated is refused by both", () => {
    for (const action of ["stop", "start"] as const)
      expect(powerStep(action, machine("shutting-down"), KEY)).toMatchObject({
        kind: "refused",
        refusal: {
          summary: `EC2 instance ${ID} is shutting down: it is being terminated`,
          nextAction: `Check instance ${ID} in the EC2 console, then rerun \`fffactory worker ${action} builder-1\`.`,
        },
      });
  });
});

describe("stop's gates (worker-lifecycle §Gates)", () => {
  test("pass when no agent is active, or when --force skipped the inspection", () => {
    expect(stopGate({ kind: "activity", activity: { kind: "idle" } }, WORKER)).toBeUndefined();
    expect(stopGate({ kind: "forced" }, WORKER)).toBeUndefined();
  });

  test("refuse while agents are active: stopping would end them", () => {
    expect(stopGate({ kind: "activity", activity: { kind: "active", count: 2 } }, WORKER)).toEqual({
      summary: "2 agents are active on fff-abcd1234-builder-1: stopping it would end them",
      details: [],
      nextAction:
        "Wait until no agent is active there, then rerun `fffactory worker stop builder-1`, " +
        "or pass --force to stop it anyway.",
    });
    expect(
      stopGate({ kind: "activity", activity: { kind: "active", count: 1 } }, WORKER)?.summary,
    ).toBe("1 agent is active on fff-abcd1234-builder-1: stopping it would end it");
  });

  test("refuse when the activity could not be read", () => {
    expect(
      stopGate(
        {
          kind: "activity",
          activity: { kind: "unknown", reason: "Paseo activity could not be read" },
        },
        WORKER,
      ),
    ).toEqual({
      summary:
        "fff-abcd1234-builder-1 could not be inspected for active agents: Paseo activity could not be read",
      details: [],
      nextAction:
        "Check the worker with `fffactory status`, then rerun `fffactory worker stop builder-1`, " +
        "or pass --force to stop it uninspected.",
    });
  });

  test("refuse a running worker the tailnet cannot locate, with the tailnet's next action", () => {
    const verdict = {
      status: "not_ready" as const,
      summary: "Offline in the tailnet",
      details: ["a detail"],
      nextAction: "Check that Tailscale is up on it, then rerun `fffactory worker stop builder-1`.",
    };
    expect(stopGate({ kind: "unlocated", verdict }, WORKER)).toEqual({
      summary: "fff-abcd1234-builder-1 could not be inspected: Offline in the tailnet",
      details: ["a detail"],
      nextAction:
        "Check that Tailscale is up on it, then rerun `fffactory worker stop builder-1`. " +
        "--force stops it uninspected.",
    });
  });
});

describe("confirmation (worker-lifecycle §Confirmation)", () => {
  test("--yes confirms; a terminal is asked; anything else cannot confirm", () => {
    expect(confirmationRule(true, false)).toBe("confirmed");
    expect(confirmationRule(true, true)).toBe("confirmed");
    expect(confirmationRule(false, true)).toBe("ask");
    expect(confirmationRule(false, false)).toBe("unavailable");
  });

  test("only y or yes, in any case, confirms; the default is no", () => {
    for (const answer of ["y", "Y", "yes", " YES "]) expect(confirms(answer)).toBe(true);
    for (const answer of ["", "n", "no", "yeah", undefined]) expect(confirms(answer)).toBe(false);
  });

  test("the question names the worker, its instance and the default", () => {
    expect(confirmationQuestion("stop", WORKER, ID)).toBe(
      `Stop worker builder-1 (fff-abcd1234-builder-1), EC2 instance ${ID}? [y/N] `,
    );
    expect(confirmationQuestion("start", WORKER, ID)).toBe(
      `Start worker builder-1 (fff-abcd1234-builder-1), EC2 instance ${ID}? [y/N] `,
    );
  });

  test("without a terminal or --yes, the command says how to confirm", () => {
    expect(unconfirmable("stop")).toBe(
      "Stopping a worker needs your confirmation: rerun at a terminal, or pass --yes.",
    );
    expect(unconfirmable("start")).toBe(
      "Starting a worker needs your confirmation: rerun at a terminal, or pass --yes.",
    );
  });
});

describe("waiting for the target state (worker-lifecycle §Stop, §Start)", () => {
  test("is bounded", () => {
    expect(POWER_DEADLINE_MS).toBe(10 * 60_000);
    expect(ONLINE_DEADLINE_MS).toBe(5 * 60_000);
  });

  test("ends once the machine reaches the action's state", () => {
    expect(waitStep("stop", "stopped")).toBe("reached");
    expect(waitStep("start", "running")).toBe("reached");
  });

  test("goes on through every state on the way, and a read that failed", () => {
    for (const state of ["running", "stopping", "pending", undefined] as const)
      expect(waitStep("stop", state)).toBe("waiting");
    for (const state of ["stopped", "pending", "stopping", undefined] as const)
      expect(waitStep("start", state)).toBe("waiting");
  });

  test("stops at a machine being terminated or gone", () => {
    for (const state of ["shutting-down", "terminated", "absent"] as const)
      expect(waitStep("stop", state)).toBe("gone");
  });

  test("words a timeout, a vanished machine and a failed request with the command to rerun", () => {
    expect(powerTimedOut("stop", WORKER, ID, "stopping")).toEqual({
      summary: `EC2 instance ${ID} did not reach stopped within 10 min (last seen: stopping)`,
      details: [],
      nextAction: `Check instance ${ID} in the EC2 console, then rerun \`fffactory worker stop builder-1\`.`,
    });
    expect(powerTimedOut("start", WORKER, ID, undefined).summary).toBe(
      `EC2 instance ${ID} did not reach running within 10 min (last seen: unknown)`,
    );
    expect(machineGone("start", WORKER, ID, "terminated")).toEqual({
      summary: `EC2 instance ${ID} is terminated while fffactory waited for it to be running`,
      details: [],
      nextAction: `Check instance ${ID} in the EC2 console, then rerun \`fffactory worker start builder-1\`.`,
    });
    expect(
      requestFailed("stop", WORKER, ID, "EC2 StopInstances failed: UnauthorizedOperation"),
    ).toEqual({
      summary: "EC2 StopInstances failed: UnauthorizedOperation",
      details: [],
      nextAction:
        `Check that the credentials may call ec2:StopInstances on instance ${ID}, then rerun ` +
        "`fffactory worker stop builder-1`.",
    });
  });

  test("words a request EC2 did not answer in time as one that may have reached it", () => {
    expect(
      requestUnanswered("start", WORKER, ID, "EC2 StartInstances failed: timed out after 15 s"),
    ).toEqual({
      summary: "EC2 StartInstances failed: timed out after 15 s",
      details: [`The request may have reached EC2: instance ${ID} may be starting.`],
      nextAction:
        "Check the worker with `fffactory status`, then rerun `fffactory worker start builder-1`.",
    });
  });
});
