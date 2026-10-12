import type { EC2ClientConfig } from "@aws-sdk/client-ec2";
import type {
  MachineControl,
  MachineRequest,
  MachineStateRead,
  MachineTarget,
} from "../application/machine-control";
import { FACTORY_ID_TAG } from "../domain/resource-naming";
import type { ObservedMachineState } from "../domain/worker-lifecycle";
import {
  type AwsCalls,
  AwsFailure,
  clientSettings,
  type OpenCalls,
  withAwsSession,
} from "./aws-session";
import type { InstancePage } from "./ec2-inventory";

/** The deadline of each call: one request, or one state read. */
export const EC2_CONTROL_TIMEOUT_MS = 15_000;

export interface InstanceIdsInput {
  readonly InstanceIds: readonly string[];
}

export interface InstanceStateInput {
  readonly Filters: readonly { readonly Name: string; readonly Values: readonly string[] }[];
}

export interface Ec2ControlCalls extends AwsCalls {
  stopInstances(input: InstanceIdsInput): Promise<unknown>;
  startInstances(input: InstanceIdsInput): Promise<unknown>;
  describeInstances(input: InstanceStateInput): Promise<InstancePage>;
}

/**
 * The calls over AWS SDK for JavaScript v3, imported on first use so commands that never
 * call AWS never load it. `config` adds client configuration, such as a test endpoint.
 */
export function sdkEc2ControlCalls(
  config: Partial<EC2ClientConfig> = {},
): OpenCalls<Ec2ControlCalls> {
  return async (session) => {
    const ec2 = await import("@aws-sdk/client-ec2");
    const client = new ec2.EC2Client({ ...(await clientSettings(session)), ...config });
    const options = { abortSignal: session.abortSignal };
    return {
      stopInstances: ({ InstanceIds }) =>
        client.send(new ec2.StopInstancesCommand({ InstanceIds: [...InstanceIds] }), options),
      startInstances: ({ InstanceIds }) =>
        client.send(new ec2.StartInstancesCommand({ InstanceIds: [...InstanceIds] }), options),
      describeInstances: ({ Filters }) =>
        client.send(
          new ec2.DescribeInstancesCommand({
            Filters: Filters.map(({ Name, Values }) => ({ Name, Values: [...Values] })),
          }),
          options,
        ),
      close: () => client.destroy(),
    };
  };
}

/** Every state EC2 reports for an instance, `terminated` included. */
const KNOWN_STATES: readonly string[] = [
  "pending",
  "running",
  "stopping",
  "stopped",
  "shutting-down",
  "terminated",
];

/** The target's state in one DescribeInstances page: `absent` when EC2 does not list it. */
function stateOf(page: InstancePage, instanceId: string): MachineStateRead {
  const instance = (page.Reservations ?? [])
    .flatMap((reservation) => reservation.Instances ?? [])
    .find((listed) => listed.InstanceId === instanceId);
  if (instance === undefined) return { kind: "state", state: "absent" };
  const state = instance.State?.Name ?? "";
  if (!KNOWN_STATES.includes(state))
    return {
      kind: "unavailable",
      reason: "EC2 DescribeInstances answered a state fffactory does not know",
    };
  return { kind: "state", state: state as ObservedMachineState };
}

/**
 * The power of one factory instance over EC2 StopInstances, StartInstances and
 * DescribeInstances, each call within `timeoutMs`. A state is read only for the instance ID
 * that also carries the factory's ID tag. Failures are `failed`, `unanswered` or `unavailable`,
 * described by error name or network code only.
 */
export function ec2MachineControl(
  open: OpenCalls<Ec2ControlCalls> = sdkEc2ControlCalls(),
  timeoutMs: number = EC2_CONTROL_TIMEOUT_MS,
): MachineControl {
  const session = <T>(
    target: MachineTarget,
    what: string,
    work: (calls: Ec2ControlCalls) => Promise<T>,
  ) => withAwsSession(open, target, timeoutMs, what, work);
  const request = async (
    target: MachineTarget,
    what: string,
    call: (calls: Ec2ControlCalls, input: InstanceIdsInput) => Promise<unknown>,
  ): Promise<MachineRequest> => {
    try {
      await session(target, what, (calls) => call(calls, { InstanceIds: [target.instanceId] }));
      return { kind: "requested" };
    } catch (error) {
      if (error instanceof AwsFailure)
        return { kind: error.timedOut ? "unanswered" : "failed", reason: error.message };
      throw error;
    }
  };
  return {
    stop: (target) =>
      request(target, "EC2 StopInstances", (calls, input) => calls.stopInstances(input)),
    start: (target) =>
      request(target, "EC2 StartInstances", (calls, input) => calls.startInstances(input)),
    async state(target) {
      const Filters = [
        { Name: "instance-id", Values: [target.instanceId] },
        { Name: `tag:${FACTORY_ID_TAG}`, Values: [target.factoryId] },
      ];
      try {
        const page = await session(target, "EC2 DescribeInstances", (calls) =>
          calls.describeInstances({ Filters }),
        );
        return stateOf(page, target.instanceId);
      } catch (error) {
        if (error instanceof AwsFailure) return { kind: "unavailable", reason: error.message };
        throw error;
      }
    },
  };
}
