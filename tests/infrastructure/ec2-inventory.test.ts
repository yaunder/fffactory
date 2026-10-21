import { afterEach, describe, expect, test } from "bun:test";
import type { AwsSession } from "../../src/infrastructure/aws-session";
import {
  type DescribeInstancesInput,
  type DescribeVpcsInput,
  type Ec2InventoryCalls,
  ec2MachineInventory,
  type InstancePage,
  sdkEc2InventoryCalls,
  type VpcListPage,
} from "../../src/infrastructure/ec2-inventory";
import type { FactoryId } from "../../src/domain/instance";
import { type StubEc2Instances, stubEc2Instances } from "../support/stub-ec2-instances";
import { EXAMPLE_CREDENTIALS } from "../support/stub-sts";

const FACTORY = "fff-aaaa1111" as FactoryId;
const TAGS = { "fffactory:factory-id": FACTORY, "fffactory:host-key": "builder-1" };

function stubbed(pages: InstancePage[] | Error, vpcPages: VpcListPage[] | Error = []) {
  const sessions: AwsSession[] = [];
  const inputs: DescribeInstancesInput[] = [];
  const vpcInputs: DescribeVpcsInput[] = [];
  const events: string[] = [];
  const open = async (session: AwsSession): Promise<Ec2InventoryCalls> => {
    sessions.push(session);
    return {
      describeInstances: async (input) => {
        inputs.push(input);
        if (pages instanceof Error) throw pages;
        return pages[inputs.length - 1] ?? {};
      },
      describeVpcs: async (input) => {
        vpcInputs.push(input);
        if (vpcPages instanceof Error) throw vpcPages;
        return vpcPages[vpcInputs.length - 1] ?? {};
      },
      close: () => events.push("close"),
    };
  };
  return { open, sessions, inputs, vpcInputs, events };
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
      describeVpcs: () => new Promise<VpcListPage>(() => {}),
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

describe("the factory's tagged VPCs over stubbed calls (provisioning §Destroy plan)", () => {
  test("lists the VPCs carrying the factory ID tag, page by page", async () => {
    const stub = stubbed(
      [],
      [
        { Vpcs: [{ VpcId: "vpc-0123456789abcdef0" }], NextToken: "next" },
        { Vpcs: [{ VpcId: "vpc-0fedcba98" }] },
        {},
      ],
    );
    expect(
      await ec2MachineInventory(stub.open).listVpcs(
        { source: "--profile", profile: "factory" },
        "eu-west-2",
        FACTORY,
      ),
    ).toEqual({ kind: "vpcs", vpcIds: ["vpc-0123456789abcdef0", "vpc-0fedcba98"] });
    expect(stub.sessions.map(({ region, profile }) => ({ region, profile }))).toEqual([
      { region: "eu-west-2", profile: "factory" },
    ]);
    const Filters = [{ Name: "tag:fffactory:factory-id", Values: [FACTORY] }];
    expect(stub.vpcInputs).toEqual([
      { Filters, MaxResults: 1000, NextToken: undefined },
      { Filters, MaxResults: 1000, NextToken: "next" },
    ]);
    expect(stub.inputs).toEqual([]);
    expect(stub.events).toEqual(["close"]);
  });

  test("a factory with no tagged VPC lists none", async () => {
    const stub = stubbed([], [{ Vpcs: [] }]);
    expect(
      await ec2MachineInventory(stub.open).listVpcs({ source: "chain" }, "us-east-1", FACTORY),
    ).toEqual({ kind: "vpcs", vpcIds: [] });
  });

  test("a VPC without a well-formed ID is never skipped: the listing is unavailable", async () => {
    for (const vpc of [{}, { VpcId: "" }, { VpcId: "subnet-0123456789abcdef0" }]) {
      const stub = stubbed([], [{ Vpcs: [{ VpcId: "vpc-0123456789abcdef0" }, vpc] }]);
      expect(
        await ec2MachineInventory(stub.open).listVpcs({ source: "chain" }, "us-east-1", FACTORY),
      ).toEqual({
        kind: "unavailable",
        reason: "EC2 DescribeVpcs listed a VPC without a well-formed ID",
      });
    }
  });

  test("a failure is unavailable, named without AWS's message", async () => {
    const denied = Object.assign(new Error("AWS message about wJalrXUtnFEMI"), {
      name: "UnauthorizedOperation",
      $fault: "client",
    });
    expect(
      await ec2MachineInventory(stubbed([], denied).open).listVpcs(
        { source: "chain" },
        "us-east-1",
        FACTORY,
      ),
    ).toEqual({ kind: "unavailable", reason: "EC2 DescribeVpcs failed: UnauthorizedOperation" });
  });

  test("a listing past its deadline is unavailable", async () => {
    const open = async (): Promise<Ec2InventoryCalls> => ({
      describeInstances: () => new Promise<InstancePage>(() => {}),
      describeVpcs: () => new Promise<VpcListPage>(() => {}),
      close: () => {},
    });
    expect(
      await ec2MachineInventory(open, 20).listVpcs({ source: "chain" }, "us-east-1", FACTORY),
    ).toEqual({ kind: "unavailable", reason: "EC2 DescribeVpcs failed: timed out after 0.02 s" });
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
    expect(
      await inventory(stub.endpoint).listVpcs({ source: "chain" }, "us-east-1", FACTORY),
    ).toEqual({ kind: "unavailable", reason: "EC2 DescribeVpcs failed: UnauthorizedOperation" });
  });

  test("reads the factory's tagged VPCs, page by page, from a local stub", async () => {
    stub = stubEc2Instances({
      vpcPages: [
        [
          { id: "vpc-0123456789abcdef0", tags: { "fffactory:factory-id": FACTORY } },
          { id: "vpc-0aaaaaaaaaaaaaaaa", tags: { "fffactory:factory-id": "fff-bbbb2222" } },
        ],
        [
          { id: "vpc-0bbbbbbbbbbbbbbbb", tags: {} },
          { id: "vpc-0fedcba9876543210", tags: { Name: "x", "fffactory:factory-id": FACTORY } },
        ],
      ],
    });
    expect(
      await inventory(stub.endpoint).listVpcs({ source: "chain" }, "us-east-1", FACTORY),
    ).toEqual({ kind: "vpcs", vpcIds: ["vpc-0123456789abcdef0", "vpc-0fedcba9876543210"] });
    const first = new URLSearchParams(stub.requests[0]);
    expect(first.get("Action")).toBe("DescribeVpcs");
    expect(first.get("Filter.1.Name")).toBe("tag:fffactory:factory-id");
    expect(first.get("Filter.1.Value.1")).toBe(FACTORY);
    expect(first.get("MaxResults")).toBe("1000");
    expect(stub.requests).toHaveLength(2);
  });
});
