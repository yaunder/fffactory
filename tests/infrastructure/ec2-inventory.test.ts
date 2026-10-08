import { afterEach, describe, expect, test } from "bun:test";
import type { AwsSession } from "../../src/infrastructure/aws-session";
import {
  type DescribeInstancesInput,
  type Ec2InventoryCalls,
  ec2MachineInventory,
  type InstancePage,
  sdkEc2InventoryCalls,
} from "../../src/infrastructure/ec2-inventory";
import type { FactoryId } from "../../src/domain/instance";
import { type StubEc2Instances, stubEc2Instances } from "../support/stub-ec2-instances";
import { EXAMPLE_CREDENTIALS } from "../support/stub-sts";

const FACTORY = "fff-aaaa1111" as FactoryId;
const TAGS = { "fffactory:factory-id": FACTORY, "fffactory:host-key": "builder-1" };

function stubbed(pages: InstancePage[] | Error) {
  const sessions: AwsSession[] = [];
  const inputs: DescribeInstancesInput[] = [];
  const events: string[] = [];
  const open = async (session: AwsSession): Promise<Ec2InventoryCalls> => {
    sessions.push(session);
    return {
      describeInstances: async (input) => {
        inputs.push(input);
        if (pages instanceof Error) throw pages;
        return pages[inputs.length - 1] ?? {};
      },
      close: () => events.push("close"),
    };
  };
  return { open, sessions, inputs, events };
}

describe("the EC2 inventory over stubbed calls", () => {
  test("lists the factory's instances in every state but terminated, page by page", async () => {
    const stub = stubbed([
      {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-0123456789abcdef0",
                State: { Name: "running" },
                Tags: [
                  { Key: "fffactory:host-key", Value: "builder-1" },
                  { Key: "Name", Value: "fff-aaaa1111-builder-1" },
                ],
              },
            ],
          },
        ],
        NextToken: "next",
      },
      {
        Reservations: [
          { Instances: [{ InstanceId: "i-0fedcba9876543210", State: { Name: "stopped" } }] },
          {},
        ],
      },
    ]);
    const inventory = ec2MachineInventory(stub.open);
    expect(
      await inventory.list({ source: "--profile", profile: "factory" }, "eu-west-2", FACTORY),
    ).toEqual({
      kind: "machines",
      machines: [
        { instanceId: "i-0123456789abcdef0", state: "running", hostKey: "builder-1" },
        { instanceId: "i-0fedcba9876543210", state: "stopped", hostKey: undefined },
      ],
    });
    expect(stub.sessions.map(({ region, profile }) => ({ region, profile }))).toEqual([
      { region: "eu-west-2", profile: "factory" },
    ]);
    const filters = [
      { Name: "tag:fffactory:factory-id", Values: [FACTORY] },
      {
        Name: "instance-state-name",
        Values: ["pending", "running", "stopping", "stopped", "shutting-down"],
      },
    ];
    expect(stub.inputs).toEqual([
      { Filters: filters, MaxResults: 1000, NextToken: undefined },
      { Filters: filters, MaxResults: 1000, NextToken: "next" },
    ]);
    expect(stub.events).toEqual(["close"]);
  });

  test("skips instances with a malformed ID or an unlisted state", async () => {
    const stub = stubbed([
      {
        Reservations: [
          {
            Instances: [
              { InstanceId: "vol-0123456789abcdef0", State: { Name: "running" } },
              { InstanceId: "i-0123456789abcdef0", State: { Name: "terminated" } },
              { State: { Name: "running" } },
            ],
          },
        ],
      },
    ]);
    expect(
      await ec2MachineInventory(stub.open).list({ source: "chain" }, "us-east-1", FACTORY),
    ).toEqual({ kind: "machines", machines: [] });
  });

  test("a failure is unavailable, named without AWS's message", async () => {
    const denied = Object.assign(new Error("AWS message about wJalrXUtnFEMI"), {
      name: "UnauthorizedOperation",
      $fault: "client",
    });
    const result = await ec2MachineInventory(stubbed(denied).open).list(
      { source: "chain" },
      "us-east-1",
      FACTORY,
    );
    expect(result).toEqual({
      kind: "unavailable",
      reason: "EC2 DescribeInstances failed: UnauthorizedOperation",
    });
  });

  test("a listing past its deadline is unavailable", async () => {
    const open = async (): Promise<Ec2InventoryCalls> => ({
      describeInstances: () => new Promise<InstancePage>(() => {}),
      close: () => {},
    });
    expect(
      await ec2MachineInventory(open, 20).list({ source: "chain" }, "us-east-1", FACTORY),
    ).toEqual({
      kind: "unavailable",
      reason: "EC2 DescribeInstances failed: timed out after 0.02 s",
    });
  });

  test("a defect is not hidden as unavailable", async () => {
    const open = async (): Promise<Ec2InventoryCalls> => {
      throw new TypeError("defect");
    };
    // withAwsSession reports every failure of the session, a defect included, by name.
    expect(await ec2MachineInventory(open).list({ source: "chain" }, "us-east-1", FACTORY)).toEqual(
      {
        kind: "unavailable",
        reason: "EC2 DescribeInstances failed: unexpected TypeError",
      },
    );
  });
});

describe("the EC2 inventory over the real SDK", () => {
  let stub: StubEc2Instances | undefined;
  afterEach(() => stub?.stop());

  function inventory(endpoint: string) {
    return ec2MachineInventory(
      sdkEc2InventoryCalls({ endpoint, credentials: EXAMPLE_CREDENTIALS }),
    );
  }

  test("reads DescribeInstances pages from a local stub", async () => {
    stub = stubEc2Instances({
      pages: [
        [{ id: "i-0123456789abcdef0", state: "running", tags: TAGS }],
        [
          {
            id: "i-0fedcba9876543210",
            state: "stopping",
            tags: { ...TAGS, "fffactory:host-key": "builder-2" },
          },
        ],
      ],
    });
    expect(await inventory(stub.endpoint).list({ source: "chain" }, "us-east-1", FACTORY)).toEqual({
      kind: "machines",
      machines: [
        { instanceId: "i-0123456789abcdef0", state: "running", hostKey: "builder-1" },
        { instanceId: "i-0fedcba9876543210", state: "stopping", hostKey: "builder-2" },
      ],
    });
    const first = new URLSearchParams(stub.requests[0]);
    expect(first.get("Action")).toBe("DescribeInstances");
    expect(first.get("Filter.1.Name")).toBe("tag:fffactory:factory-id");
    expect(first.get("Filter.1.Value.1")).toBe(FACTORY);
    expect(first.get("Filter.2.Name")).toBe("instance-state-name");
    expect(stub.requests).toHaveLength(2);
  });

  test("reports an EC2 error by its code", async () => {
    stub = stubEc2Instances({ error: "UnauthorizedOperation" });
    expect(await inventory(stub.endpoint).list({ source: "chain" }, "us-east-1", FACTORY)).toEqual({
      kind: "unavailable",
      reason: "EC2 DescribeInstances failed: UnauthorizedOperation",
    });
  });
});
