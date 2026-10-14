import { afterEach, describe, expect, test } from "bun:test";
import type { MachineTarget } from "../../src/application/machine-control";
import type { FactoryId } from "../../src/domain/instance";
import type { AwsSession } from "../../src/infrastructure/aws-session";
import {
  type Ec2ControlCalls,
  ec2MachineControl,
  sdkEc2ControlCalls,
} from "../../src/infrastructure/ec2-machine-control";
import type { InstancePage } from "../../src/infrastructure/ec2-inventory";
import { type StubEc2Instances, stubEc2Instances } from "../support/stub-ec2-instances";
import { EXAMPLE_CREDENTIALS } from "../support/stub-sts";

const FACTORY = "fff-aaaa1111" as FactoryId;
const ID = "i-0123456789abcdef0";
const TARGET: MachineTarget = {
  credentials: { source: "--profile", profile: "factory" },
  region: "eu-west-2",
  factoryId: FACTORY,
  instanceId: ID,
};

function page(state: string, instanceId = ID): InstancePage {
  return { Reservations: [{ Instances: [{ InstanceId: instanceId, State: { Name: state } }] }] };
}

/** Calls that record what they were asked and answer `page`, or reject with `failure`. */
function stubbed(answer: InstancePage | Error = page("running")) {
  const sessions: AwsSession[] = [];
  const calls: unknown[] = [];
  const events: string[] = [];
  const respond = async <T>(call: unknown, value: T): Promise<T> => {
    calls.push(call);
    if (answer instanceof Error) throw answer;
    return value;
  };
  const open = async (session: AwsSession): Promise<Ec2ControlCalls> => {
    sessions.push(session);
    return {
      stopInstances: (input) => respond({ stop: input }, {}),
      startInstances: (input) => respond({ start: input }, {}),
      terminateInstances: (input) => respond({ terminate: input }, {}),
      describeInstances: (input) => respond({ describe: input }, answer as InstancePage),
      close: () => events.push("close"),
    };
  };
  return { open, sessions, calls, events };
}

const DENIED = Object.assign(new Error("AWS message about wJalrXUtnFEMI"), {
  name: "UnauthorizedOperation",
  $fault: "client",
});

describe("EC2 machine control over stubbed calls", () => {
  test("stops, starts and terminates exactly the target instance, in the factory Region and profile", async () => {
    const stub = stubbed();
    const control = ec2MachineControl(stub.open);
    expect(await control.stop(TARGET)).toEqual({ kind: "requested" });
    expect(await control.start(TARGET)).toEqual({ kind: "requested" });
    expect(await control.terminate(TARGET)).toEqual({ kind: "requested" });
    expect(stub.calls).toEqual([
      { stop: { InstanceIds: [ID] } },
      { start: { InstanceIds: [ID] } },
      { terminate: { InstanceIds: [ID] } },
    ]);
    expect(stub.sessions.map(({ region, profile }) => ({ region, profile }))).toEqual([
      { region: "eu-west-2", profile: "factory" },
      { region: "eu-west-2", profile: "factory" },
      { region: "eu-west-2", profile: "factory" },
    ]);
    expect(stub.events).toEqual(["close", "close", "close"]);
  });

  test("reads the instance's state by its ID and the factory ID tag, terminated included", async () => {
    const stub = stubbed(page("stopping"));
    expect(await ec2MachineControl(stub.open).state(TARGET)).toEqual({
      kind: "state",
      state: "stopping",
    });
    expect(stub.calls).toEqual([
      {
        describe: {
          Filters: [
            { Name: "instance-id", Values: [ID] },
            { Name: `tag:fffactory:factory-id`, Values: [FACTORY] },
          ],
        },
      },
    ]);
    expect(await ec2MachineControl(stubbed(page("terminated")).open).state(TARGET)).toEqual({
      kind: "state",
      state: "terminated",
    });
  });

  test("an instance EC2 no longer lists, or lists only under another ID, is absent", async () => {
    for (const answer of [{}, page("running", "i-0fedcba9876543210")])
      expect(await ec2MachineControl(stubbed(answer).open).state(TARGET)).toEqual({
        kind: "state",
        state: "absent",
      });
  });

  test("a state fffactory does not know is unavailable, never guessed", async () => {
    expect(await ec2MachineControl(stubbed(page("rebooting")).open).state(TARGET)).toEqual({
      kind: "unavailable",
      reason: "EC2 DescribeInstances answered a state fffactory does not know",
    });
  });

  test("a failure is named without AWS's message", async () => {
    const control = ec2MachineControl(stubbed(DENIED).open);
    expect(await control.stop(TARGET)).toEqual({
      kind: "failed",
      reason: "EC2 StopInstances failed: UnauthorizedOperation",
    });
    expect(await control.start(TARGET)).toEqual({
      kind: "failed",
      reason: "EC2 StartInstances failed: UnauthorizedOperation",
    });
    expect(await control.terminate(TARGET)).toEqual({
      kind: "failed",
      reason: "EC2 TerminateInstances failed: UnauthorizedOperation",
    });
    expect(await control.state(TARGET)).toEqual({
      kind: "unavailable",
      reason: "EC2 DescribeInstances failed: UnauthorizedOperation",
    });
  });

  test("every call has a deadline; a request past it may have reached EC2", async () => {
    const open = async (): Promise<Ec2ControlCalls> => ({
      stopInstances: () => new Promise(() => {}),
      startInstances: () => new Promise(() => {}),
      terminateInstances: () => new Promise(() => {}),
      describeInstances: () => new Promise(() => {}),
      close: () => {},
    });
    const control = ec2MachineControl(open, 20);
    expect(await control.stop(TARGET)).toEqual({
      kind: "unanswered",
      reason: "EC2 StopInstances failed: timed out after 0.02 s",
    });
    expect(await control.start(TARGET)).toEqual({
      kind: "unanswered",
      reason: "EC2 StartInstances failed: timed out after 0.02 s",
    });
    expect(await control.terminate(TARGET)).toEqual({
      kind: "unanswered",
      reason: "EC2 TerminateInstances failed: timed out after 0.02 s",
    });
    expect(await control.state(TARGET)).toEqual({
      kind: "unavailable",
      reason: "EC2 DescribeInstances failed: timed out after 0.02 s",
    });
  });
});

describe("EC2 machine control over the real SDK", () => {
  let stub: StubEc2Instances | undefined;
  afterEach(() => stub?.stop());

  function control(endpoint: string) {
    return ec2MachineControl(sdkEc2ControlCalls({ endpoint, credentials: EXAMPLE_CREDENTIALS }));
  }

  test("sends StopInstances, StartInstances, TerminateInstances and DescribeInstances to a local stub", async () => {
    stub = stubEc2Instances({
      pages: [[{ id: ID, state: "stopped", tags: { "fffactory:factory-id": FACTORY } }]],
    });
    const ec2 = control(stub.endpoint);
    expect(await ec2.stop({ ...TARGET, credentials: { source: "chain" } })).toEqual({
      kind: "requested",
    });
    expect(await ec2.start({ ...TARGET, credentials: { source: "chain" } })).toEqual({
      kind: "requested",
    });
    expect(await ec2.terminate({ ...TARGET, credentials: { source: "chain" } })).toEqual({
      kind: "requested",
    });
    expect(await ec2.state({ ...TARGET, credentials: { source: "chain" } })).toEqual({
      kind: "state",
      state: "stopped",
    });
    const [stop, start, terminate, describe] = stub.requests.map(
      (body) => new URLSearchParams(body),
    );
    expect(terminate?.get("Action")).toBe("TerminateInstances");
    expect(terminate?.get("InstanceId.1")).toBe(ID);
    expect(stop?.get("Action")).toBe("StopInstances");
    expect(stop?.get("InstanceId.1")).toBe(ID);
    expect(start?.get("Action")).toBe("StartInstances");
    expect(start?.get("InstanceId.1")).toBe(ID);
    expect(describe?.get("Action")).toBe("DescribeInstances");
    expect(describe?.get("Filter.1.Name")).toBe("instance-id");
    expect(describe?.get("Filter.1.Value.1")).toBe(ID);
    expect(describe?.get("Filter.2.Name")).toBe("tag:fffactory:factory-id");
  });

  test("reports an EC2 error by its code", async () => {
    stub = stubEc2Instances({ error: "UnauthorizedOperation" });
    expect(
      await control(stub.endpoint).stop({ ...TARGET, credentials: { source: "chain" } }),
    ).toEqual({ kind: "failed", reason: "EC2 StopInstances failed: UnauthorizedOperation" });
  });
});
