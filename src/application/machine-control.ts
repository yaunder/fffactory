import type { CredentialSelection } from "../domain/aws-account";
import type { FactoryId } from "../domain/instance";
import type { ObservedMachineState } from "../domain/worker-lifecycle";

/** The one EC2 instance of the factory a power command acts on, in the factory's Region. */
export interface MachineTarget {
  readonly credentials: CredentialSelection;
  readonly region: string;
  /** The factory whose `fffactory:factory-id` tag the instance carries. */
  readonly factoryId: FactoryId;
  readonly instanceId: string;
}

/** How asking EC2 to change the machine's state ended. */
export type MachineRequest =
  | { readonly kind: "requested" }
  /** `reason` names the error or network code, never quoting AWS. */
  | { readonly kind: "failed"; readonly reason: string }
  /** No answer within the deadline: the request may have reached EC2. */
  | { readonly kind: "unanswered"; readonly reason: string };

/** One read of the machine's state, as the waits make it. */
export type MachineStateRead =
  | { readonly kind: "state"; readonly state: ObservedMachineState }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Port: the power of one factory EC2 instance (`docs/specs/worker-lifecycle.md`). Each call
 * has its own deadline, and every credential, AWS, network and timeout failure resolves to
 * `failed`, `unanswered` (a request past its deadline) or `unavailable`. A request only asks
 * EC2: the use case waits for the state with `state`, through its injected `sleep`.
 */
export interface MachineControl {
  /** Asks EC2 to stop the instance (StopInstances). */
  stop(target: MachineTarget): Promise<MachineRequest>;
  /** Asks EC2 to start the instance (StartInstances). */
  start(target: MachineTarget): Promise<MachineRequest>;
  /** The instance's state now, `absent` once EC2 no longer lists it with the factory's tag. */
  state(target: MachineTarget): Promise<MachineStateRead>;
}
