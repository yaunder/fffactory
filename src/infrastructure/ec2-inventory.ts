import type { EC2ClientConfig } from "@aws-sdk/client-ec2";
import type { MachineInventorySource } from "../application/machine-inventory";
import type { FactoryId } from "../domain/instance";
import { FACTORY_ID_TAG, HOST_KEY_TAG } from "../domain/resource-naming";
import type { Machine, MachineState } from "../domain/status";
import type { VpcInventory } from "../domain/teardown";
import {
  AdapterRefusal,
  type AwsCalls,
  AwsFailure,
  clientSettings,
  type OpenCalls,
  withAwsSession,
} from "./aws-session";

/** One deadline for every page of the listing. */
export const EC2_INVENTORY_TIMEOUT_MS = 15_000;

/** DescribeInstances' and DescribeVpcs' largest page. */
const PAGE_SIZE = 1000;

/** Every state but `terminated`: a terminated instance is gone. */
export const LISTED_STATES: readonly MachineState[] = [
  "pending",
  "running",
  "stopping",
  "stopped",
  "shutting-down",
];

export interface DescribeInstancesInput {
  readonly Filters: readonly { readonly Name: string; readonly Values: readonly string[] }[];
  readonly MaxResults: number;
  readonly NextToken: string | undefined;
}

type Tags = readonly { readonly Key?: string | undefined; readonly Value?: string | undefined }[];

/** The fields of one DescribeInstances page the adapter reads. */
export interface InstancePage {
  readonly Reservations?:
    | readonly {
        readonly Instances?:
          | readonly {
              readonly InstanceId?: string | undefined;
              readonly State?: { readonly Name?: string | undefined } | undefined;
              readonly Tags?: Tags | undefined;
            }[]
          | undefined;
      }[]
    | undefined;
  readonly NextToken?: string | undefined;
}

export type DescribeVpcsInput = DescribeInstancesInput;

/** The fields of one DescribeVpcs page the adapter reads. */
export interface VpcListPage {
  readonly Vpcs?: readonly { readonly VpcId?: string | undefined }[] | undefined;
  readonly NextToken?: string | undefined;
}

export interface Ec2InventoryCalls extends AwsCalls {
  describeInstances(input: DescribeInstancesInput): Promise<InstancePage>;
  describeVpcs(input: DescribeVpcsInput): Promise<VpcListPage>;
}

/** Filters as the SDK's commands take them: mutable copies. */
function sdkFilters(filters: DescribeInstancesInput["Filters"]) {
  return filters.map(({ Name, Values }) => ({ Name, Values: [...Values] }));
}

/**
 * The calls over AWS SDK for JavaScript v3, imported on first use so commands that never
 * call AWS never load it. `config` adds client configuration, such as a test endpoint.
 */
export function sdkEc2InventoryCalls(
  config: Partial<EC2ClientConfig> = {},
): OpenCalls<Ec2InventoryCalls> {
  return async (session) => {
    const ec2 = await import("@aws-sdk/client-ec2");
    const client = new ec2.EC2Client({ ...(await clientSettings(session)), ...config });
    const options = { abortSignal: session.abortSignal };
    return {
      describeInstances: (input) =>
        client.send(
          new ec2.DescribeInstancesCommand({ ...input, Filters: sdkFilters(input.Filters) }),
          options,
        ),
      describeVpcs: (input) =>
        client.send(
          new ec2.DescribeVpcsCommand({ ...input, Filters: sdkFilters(input.Filters) }),
          options,
        ),
      close: () => client.destroy(),
    };
  };
}

const INSTANCE_ID = /^i-[0-9a-f]{8,32}$/;

function tag(tags: Tags | undefined, key: string): string | undefined {
  return tags?.find((entry) => entry.Key === key)?.Value;
}

/** Instances with a well-formed ID and a listed state; anything else is not one of ours. */
function machinesOf(page: InstancePage): Machine[] {
  return (page.Reservations ?? []).flatMap((reservation) =>
    (reservation.Instances ?? []).flatMap((instance) => {
      const instanceId = instance.InstanceId ?? "";
      const state = instance.State?.Name as MachineState;
      if (!INSTANCE_ID.test(instanceId) || !LISTED_STATES.includes(state)) return [];
      return [{ instanceId, state, hostKey: tag(instance.Tags, HOST_KEY_TAG) }];
    }),
  );
}

async function listMachines(calls: Ec2InventoryCalls, factoryId: FactoryId): Promise<Machine[]> {
  const Filters = [
    { Name: `tag:${FACTORY_ID_TAG}`, Values: [factoryId] },
    { Name: "instance-state-name", Values: LISTED_STATES },
  ];
  const machines: Machine[] = [];
  let NextToken: string | undefined;
  do {
    const page = await calls.describeInstances({ Filters, MaxResults: PAGE_SIZE, NextToken });
    machines.push(...machinesOf(page));
    NextToken = page.NextToken || undefined;
  } while (NextToken !== undefined);
  return machines;
}

const VPC_ID = /^vpc-[0-9a-f]{8,32}$/;

/**
 * The VPCs carrying the factory ID tag, whatever their state. One without a well-formed ID is
 * never skipped: the listing proves a factory's VPCs absent, so it fails rather than miss one.
 */
async function listVpcs(calls: Ec2InventoryCalls, factoryId: FactoryId): Promise<string[]> {
  const Filters = [{ Name: `tag:${FACTORY_ID_TAG}`, Values: [factoryId] }];
  const vpcIds: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await calls.describeVpcs({ Filters, MaxResults: PAGE_SIZE, NextToken });
    for (const { VpcId } of page.Vpcs ?? []) {
      if (VpcId === undefined || !VPC_ID.test(VpcId))
        throw new AdapterRefusal("EC2 DescribeVpcs listed a VPC without a well-formed ID");
      vpcIds.push(VpcId);
    }
    NextToken = page.NextToken || undefined;
  } while (NextToken !== undefined);
  return vpcIds;
}

/**
 * The factory's instances from EC2 DescribeInstances, and its VPCs from DescribeVpcs, read-only,
 * by the factory ID tag. A failure is `unavailable`, described by error name or network code
 * only.
 */
export function ec2MachineInventory(
  open: OpenCalls<Ec2InventoryCalls> = sdkEc2InventoryCalls(),
  timeoutMs: number = EC2_INVENTORY_TIMEOUT_MS,
): MachineInventorySource {
  return {
    async list(credentials, region, factoryId) {
      try {
        const machines = await withAwsSession(
          open,
          { credentials, region },
          timeoutMs,
          "EC2 DescribeInstances",
          (calls) => listMachines(calls, factoryId),
        );
        return { kind: "machines", machines };
      } catch (error) {
        if (error instanceof AwsFailure) return { kind: "unavailable", reason: error.message };
        throw error;
      }
    },

    async listVpcs(credentials, region, factoryId): Promise<VpcInventory> {
      try {
        const vpcIds = await withAwsSession(
          open,
          { credentials, region },
          timeoutMs,
          "EC2 DescribeVpcs",
          (calls) => listVpcs(calls, factoryId),
        );
        return { kind: "vpcs", vpcIds };
      } catch (error) {
        if (error instanceof AwsFailure || error instanceof AdapterRefusal)
          return { kind: "unavailable", reason: error.message };
        throw error;
      }
    },
  };
}
