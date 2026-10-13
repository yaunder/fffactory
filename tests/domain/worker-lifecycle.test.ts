import { describe, expect, test } from "bun:test";
import type { FactoryInstance, HostKey } from "../../src/domain/instance";
import type { RepositoryObservation } from "../../src/domain/repository-placement";
import type { Machine } from "../../src/domain/status";
import { HOST_PROTOCOL_VERSION } from "../../src/domain/host-protocol";
import {
  adminClientMissing,
  adminClientUnusable,
  adminSecretUnreadable,
  confirmationQuestion,
  confirmMismatch,
  confirmationRule,
  confirms,
  deviceRemovalRefusal,
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
  terminateGate,
  thenRerunWorker,
  typedKeyConfirms,
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
    expect(WORKER_OPERATIONS).toEqual({
      stop: "worker-stop",
      start: "worker-start",
      terminate: "worker-terminate",
    });
  });

  test("complete every next action by rerunning the same command", () => {
    expect(thenRerunWorker("stop", KEY)("Wait")).toBe(
      "Wait, then rerun `fffactory worker stop builder-1`.",
    );
    expect(thenRerunWorker("terminate", KEY)("Wait")).toBe(
      "Wait, then rerun `fffactory worker terminate builder-1`.",
    );
    expect(thenRerunWorker("terminate-keep", KEY)("Wait")).toBe(
      "Wait, then rerun `fffactory worker terminate builder-1 --keep`.",
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

  test("none is refused for stop and start: there is no machine to act on, which apply provisions", () => {
    for (const action of ["stop", "start"] as const)
      expect(selectMachine({ kind: "machines", machines: [] }, KEY, action)).toEqual({
        kind: "refused",
        refusal: {
          summary: "No EC2 instance carries the host key builder-1",
          details: [],
          nextAction: `There is no machine to ${action}: \`fffactory apply\` provisions the worker.`,
        },
      });
  });

  test("none is, to terminate with or without --keep, a machine already gone", () => {
    const none = { kind: "machines" as const, machines: [machine("running", "other")] };
    expect(selectMachine(none, KEY, "terminate")).toEqual({ kind: "absent" });
    expect(selectMachine(none, KEY, "terminate-keep")).toEqual({ kind: "absent" });
  });

  test("an inventory that could not be read is never taken for a machine gone", () => {
    for (const command of ["terminate", "terminate-keep"] as const)
      expect(
        selectMachine(
          { kind: "unavailable", reason: "EC2 DescribeInstances failed: AccessDenied" },
          KEY,
          command,
        ).kind,
      ).toBe("refused");
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
    expect(stopGate({ kind: "unlocated", tailnet: "offline", verdict }, WORKER)).toEqual({
      summary: "fff-abcd1234-builder-1 could not be inspected: Offline in the tailnet",
      details: ["a detail"],
      nextAction:
        "Check that Tailscale is up on it, then rerun `fffactory worker stop builder-1`. " +
        "--force stops it uninspected.",
    });
  });

  test("refuse a worker missing from the tailnet with stop's own next action, never terminate's", () => {
    // Status's next action for a missing worker is the failed first boot's recovery,
    // terminating it: no way on from a refused stop.
    const verdict = {
      status: "not_ready" as const,
      summary: "No Tailscale device named fff-abcd1234-builder-1 is visible from this machine",
      details: [],
      nextAction:
        "If it failed, terminate it uninspected with `fffactory worker terminate builder-1 " +
        "--keep --force`, then rerun `fffactory worker stop builder-1`.",
    };
    expect(stopGate({ kind: "unlocated", tailnet: "missing", verdict }, WORKER)).toEqual({
      summary:
        "fff-abcd1234-builder-1 could not be inspected: No Tailscale device named fff-abcd1234-builder-1 is visible from this machine",
      details: [],
      nextAction:
        "Check the worker with `fffactory status`, then rerun `fffactory worker stop builder-1`. " +
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
    expect(confirmationQuestion("stop", WORKER, machine("running"))).toBe(
      `Stop worker builder-1 (fff-abcd1234-builder-1), EC2 instance ${ID}? [y/N] `,
    );
    expect(confirmationQuestion("start", WORKER, machine("stopped"))).toBe(
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

const TERMINATE_RERUN = "`fffactory worker terminate builder-1 --keep`";

describe("what each EC2 state means for terminate (worker-lifecycle §Terminate (keep))", () => {
  test("acts on a running or a stopped worker, and only waits for one being terminated", () => {
    expect(powerStep("terminate-keep", machine("running"), KEY)).toEqual({ kind: "act" });
    expect(powerStep("terminate-keep", machine("stopped"), KEY)).toEqual({ kind: "act" });
    expect(powerStep("terminate-keep", machine("shutting-down"), KEY)).toEqual({ kind: "await" });
  });

  test("refuses a machine on its way up or down until it gets there", () => {
    expect(powerStep("terminate-keep", machine("pending"), KEY)).toEqual({
      kind: "refused",
      refusal: {
        summary: `EC2 instance ${ID} is pending`,
        details: [],
        nextAction: `Wait until it is running, then rerun ${TERMINATE_RERUN}.`,
      },
    });
    expect(powerStep("terminate-keep", machine("stopping"), KEY)).toMatchObject({
      kind: "refused",
      refusal: { nextAction: `Wait until it has stopped, then rerun ${TERMINATE_RERUN}.` },
    });
  });

  test("waits for terminated, or for EC2 to stop listing the instance", () => {
    expect(waitStep("terminate", "terminated")).toBe("reached");
    expect(waitStep("terminate", "absent")).toBe("reached");
    for (const state of ["running", "stopped", "shutting-down", undefined] as const)
      expect(waitStep("terminate", state)).toBe("waiting");
  });

  test("words its request's failures with TerminateInstances", () => {
    expect(requestFailed("terminate-keep", WORKER, ID, "EC2 TerminateInstances failed: X")).toEqual(
      {
        summary: "EC2 TerminateInstances failed: X",
        details: [],
        nextAction:
          `Check that the credentials may call ec2:TerminateInstances on instance ${ID}, then ` +
          `rerun ${TERMINATE_RERUN}.`,
      },
    );
    expect(requestUnanswered("terminate-keep", WORKER, ID, "timed out").details).toEqual([
      `The request may have reached EC2: instance ${ID} may be shutting down.`,
    ]);
    expect(powerTimedOut("terminate-keep", WORKER, ID, "shutting-down").summary).toBe(
      `EC2 instance ${ID} did not reach terminated within 10 min (last seen: shutting-down)`,
    );
  });
});

describe("terminate's gates (worker-lifecycle §Gates (terminate))", () => {
  const IDLE = { kind: "idle" } as const;
  const synchronized = (unmanaged: readonly string[] = []): RepositoryObservation => ({
    protocol_version: HOST_PROTOCOL_VERSION,
    state: "synchronized",
    unmanaged,
  });

  test("pass an idle worker whose checkouts are all resolved, or that has none", () => {
    for (const repositories of [
      synchronized(),
      { protocol_version: HOST_PROTOCOL_VERSION, state: "none" },
    ] satisfies RepositoryObservation[])
      expect(
        terminateGate(
          { kind: "inspected", activity: IDLE, repositories },
          WORKER,
          "terminate-keep",
        ),
      ).toBeUndefined();
  });

  test("pass a stopped worker uninspected, and anything --force skipped", () => {
    expect(terminateGate({ kind: "stopped" }, WORKER, "terminate-keep")).toBeUndefined();
    expect(terminateGate({ kind: "forced" }, WORKER, "terminate-keep")).toBeUndefined();
  });

  test("refuse while agents are active: terminating would end them", () => {
    expect(
      terminateGate(
        {
          kind: "inspected",
          activity: { kind: "active", count: 2 },
          repositories: synchronized(),
        },
        WORKER,
        "terminate-keep",
      ),
    ).toEqual({
      summary: "2 agents are active on fff-abcd1234-builder-1: terminating it would end them",
      details: [],
      nextAction:
        `Wait until no agent is active there, then rerun ${TERMINATE_RERUN}, ` +
        "or pass --force to terminate it anyway.",
    });
  });

  test("refuse unresolved or unmanaged checkouts, listing the unmanaged ones", () => {
    expect(
      terminateGate(
        {
          kind: "inspected",
          activity: IDLE,
          repositories: {
            protocol_version: HOST_PROTOCOL_VERSION,
            state: "unresolved",
            unmanaged: ["acme/old"],
          },
        },
        WORKER,
        "terminate-keep",
      ),
    ).toEqual({
      summary:
        "Placed repositories on fff-abcd1234-builder-1 are unresolved: terminating it would lose their work",
      details: ["Unmanaged repository: acme/old"],
      nextAction:
        `Resolve the checkouts \`fffactory status\` reports, then rerun ${TERMINATE_RERUN}, ` +
        "or pass --force to terminate it anyway.",
    });
    expect(
      terminateGate(
        { kind: "inspected", activity: IDLE, repositories: synchronized(["acme/a", "acme/b"]) },
        WORKER,
        "terminate-keep",
      ),
    ).toEqual({
      summary: "fff-abcd1234-builder-1 holds unmanaged checkouts: terminating it would lose them",
      details: ["Unmanaged repository: acme/a", "Unmanaged repository: acme/b"],
      nextAction:
        "Copy what you need off them, then terminate it with --force: " +
        "`fffactory worker terminate builder-1 --keep --force`.",
    });
  });

  test("refuse a worker whose activity or repository result could not be read", () => {
    expect(
      terminateGate(
        {
          kind: "inspected",
          activity: { kind: "unknown", reason: "Paseo activity could not be read" },
          repositories: synchronized(),
        },
        WORKER,
        "terminate-keep",
      ),
    ).toEqual({
      summary:
        "fff-abcd1234-builder-1 could not be inspected for active agents: Paseo activity could not be read",
      details: [],
      nextAction:
        `Check the worker with \`fffactory status\`, then rerun ${TERMINATE_RERUN}, ` +
        "or pass --force to terminate it uninspected.",
    });
    for (const repositories of [
      { protocol_version: HOST_PROTOCOL_VERSION, state: "unreadable" },
      { state: "unknown", reason: "the worker's repository result could not be read" },
    ] satisfies RepositoryObservation[])
      expect(
        terminateGate(
          { kind: "inspected", activity: IDLE, repositories },
          WORKER,
          "terminate-keep",
        ),
      ).toMatchObject({
        summary: expect.stringMatching(
          /^fff-abcd1234-builder-1 could not be inspected for checkouts: /,
        ),
        nextAction: expect.stringContaining("or pass --force to terminate it uninspected."),
      });
  });

  test("refuse a running worker the tailnet cannot locate, naming --force for a failed bootstrap", () => {
    // Its own next action, never status's verdict: a worker whose bootstrap failed never
    // joins the tailnet, so rerunning without --force would only be refused again.
    const verdict = {
      status: "not_ready" as const,
      summary: "No Tailscale device named fff-abcd1234-builder-1 is visible from this machine",
      details: ["See the Tailscale client check."],
      nextAction: `If it failed, terminate it with ${TERMINATE_RERUN}, then rerun ${TERMINATE_RERUN}.`,
    };
    expect(terminateGate({ kind: "unlocated", verdict }, WORKER, "terminate-keep")).toEqual({
      summary:
        "fff-abcd1234-builder-1 could not be inspected: No Tailscale device named fff-abcd1234-builder-1 is visible from this machine",
      details: ["See the Tailscale client check."],
      nextAction:
        `Check the worker with \`fffactory status\`, then rerun ${TERMINATE_RERUN}. If the ` +
        "instance's EC2 console output shows its bootstrap failed, it never joined the " +
        "tailnet: rerun with --force, which terminates it uninspected.",
    });
  });
});

describe("terminate's confirmation (worker-lifecycle §Confirmation (typed key))", () => {
  test("only the host key itself, typed, confirms", () => {
    for (const answer of ["builder-1", " builder-1\n"])
      expect(typedKeyConfirms(answer, KEY)).toBe(true);
    for (const answer of ["y", "yes", "BUILDER-1", "builder-2", "", undefined])
      expect(typedKeyConfirms(answer, KEY)).toBe(false);
  });

  test("the question names the worker, its instance and what is destroyed", () => {
    for (const state of ["running", "stopped"] as const)
      expect(confirmationQuestion("terminate-keep", WORKER, machine(state))).toBe(
        `Terminate worker builder-1 (fff-abcd1234-builder-1), EC2 instance ${ID}? ` +
          "Its machine and root volume are destroyed. Type the host key to confirm: ",
      );
  });

  test("with --keep and the machine already being terminated, the question is to wait, then delete its devices", () => {
    expect(confirmationQuestion("terminate-keep", WORKER, machine("shutting-down"))).toBe(
      `Wait for EC2 instance ${ID}, already being terminated, then delete the Tailscale devices ` +
        "of worker builder-1 (fff-abcd1234-builder-1)? Type the host key to confirm: ",
    );
  });

  test("removing the host whose machine was already being terminated, it says so", () => {
    expect(confirmationQuestion("terminate", WORKER, machine("running"))).toBe(
      `Terminate worker builder-1 (fff-abcd1234-builder-1), EC2 instance ${ID}, and remove it ` +
        "from factory.json? Its machine and root volume are destroyed. Type the host key to confirm: ",
    );
    expect(confirmationQuestion("terminate", WORKER, machine("shutting-down"))).toBe(
      "Remove worker builder-1 (fff-abcd1234-builder-1) from factory.json? Its EC2 instance " +
        `${ID} was already being terminated, and is now terminated. Type the host key to confirm: `,
    );
  });

  test("with --keep and the machine already gone, the question is only to delete its devices", () => {
    expect(confirmationQuestion("terminate-keep", WORKER, undefined)).toBe(
      "Delete the Tailscale devices of worker builder-1 (fff-abcd1234-builder-1)? No EC2 " +
        "instance carries its key: its machine is already gone. Type the host key to confirm: ",
    );
  });

  test("--confirm naming another key refuses, never echoing it", () => {
    const refusal = confirmMismatch(KEY);
    expect(refusal).toEqual({
      summary: "--confirm does not name the host builder-1",
      details: [],
      nextAction:
        "Pass --confirm builder-1 to terminate it, or type the host key when asked at a terminal.",
    });
  });

  test("without a terminal or --confirm, the command says how to confirm", () => {
    expect(unconfirmable("terminate")).toBe(
      "Terminating a worker needs your confirmation: rerun at a terminal, or pass --confirm KEY.",
    );
  });
});

describe("the Tailscale admin client (worker-lifecycle §Tailnet device removal)", () => {
  test("is required before anything reaches AWS", () => {
    expect(adminClientMissing("terminate-keep", KEY)).toEqual({
      summary:
        "factory.json has no Tailscale admin client (tailscale.admin_client_secret): terminate deletes the worker's tailnet device with it",
      details: [],
      nextAction: `Store it with \`fffactory secret set tailscale-admin-client\`, then rerun ${TERMINATE_RERUN}.`,
    });
  });

  test("a secret that cannot be read, or a client Tailscale refuses, is refused", () => {
    expect(
      adminSecretUnreadable(
        "terminate-keep",
        KEY,
        "Reading the secret failed: AccessDeniedException",
      ),
    ).toEqual({
      summary: "Reading the secret failed: AccessDeniedException",
      details: [],
      nextAction:
        "Check that the credentials may call secretsmanager:GetSecretValue on the secret " +
        `tailscale.admin_client_secret refers to, then rerun ${TERMINATE_RERUN}.`,
    });
    expect(
      adminClientUnusable("terminate-keep", KEY, "Tailscale refused the admin client (HTTP 401)"),
    ).toEqual({
      summary:
        "The Tailscale admin client could not be used: Tailscale refused the admin client (HTTP 401)",
      details: [],
      nextAction:
        "Check the OAuth client at https://login.tailscale.com/admin/settings/trust-credentials " +
        "(scope devices:core) and store its secret with `fffactory secret set " +
        `tailscale-admin-client\`, then rerun ${TERMINATE_RERUN}.`,
    });
  });
});

describe("the tailnet device removal's outcome (worker-lifecycle §Tailnet device removal)", () => {
  const LEFT =
    "Remove the remaining devices named fff-abcd1234-builder-1 at " +
    "https://login.tailscale.com/admin/machines yourself (one without the factory's tag only " +
    "if it was this worker), then run `fffactory apply`, which creates the worker afresh.";

  test("is complete when every tagged device was deleted and no untagged one remains", () => {
    expect(
      deviceRemovalRefusal(
        { kind: "listed", removed: ["nA"], failed: [], untagged: [] },
        WORKER,
        "terminate-keep",
      ),
    ).toBeUndefined();
    expect(
      deviceRemovalRefusal(
        { kind: "listed", removed: [], failed: [], untagged: [] },
        WORKER,
        "terminate-keep",
      ),
    ).toBeUndefined();
  });

  test("names each device it could not delete, and each untagged one, never the tag", () => {
    expect(
      deviceRemovalRefusal(
        {
          kind: "listed",
          removed: ["nA"],
          failed: [{ id: "nB", reason: "Tailscale answered HTTP 500" }],
          untagged: ["nC"],
        },
        WORKER,
        "terminate-keep",
      ),
    ).toEqual({
      summary: "Not every Tailscale device named fff-abcd1234-builder-1 was deleted",
      details: [
        "Deleting device nB failed: Tailscale answered HTTP 500",
        "Device nC does not carry the factory's tag (tailscale.tag in factory.json): not deleted",
      ],
      nextAction: LEFT,
    });
  });

  test("a listing that failed deleted nothing", () => {
    expect(
      deviceRemovalRefusal(
        { kind: "unlisted", reason: "Tailscale answered HTTP 503" },
        WORKER,
        "terminate-keep",
      ),
    ).toEqual({
      summary: "The tailnet's devices could not be listed: Tailscale answered HTTP 503",
      details: [],
      nextAction: LEFT,
    });
  });
});
