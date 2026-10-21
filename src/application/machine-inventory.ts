import type { CredentialSelection } from "../domain/aws-account";
import type { FactoryId } from "../domain/instance";
import type { MachineInventory } from "../domain/status";
import type { VpcInventory } from "../domain/teardown";

/** Port: the factory's EC2 instances and VPCs, found by their factory ID tag. Read-only. */
export interface MachineInventorySource {
  /**
   * Lists the instances in `region` tagged with `factoryId` that are not terminated. Every
   * credential, AWS, network and timeout failure resolves to `unavailable`.
   */
  list(
    credentials: CredentialSelection,
    region: string,
    factoryId: FactoryId,
  ): Promise<MachineInventory>;
  /**
   * Lists the VPCs in `region` tagged with `factoryId`: what teardown proves gone once the
   * factory's root is destroyed, and finds none of before cleaning up without a state bucket
   * (`docs/specs/provisioning.md` §Destroy plan). Every credential, AWS, network and timeout
   * failure, and a VPC listed without a well-formed ID, resolves to `unavailable`.
   */
  listVpcs(
    credentials: CredentialSelection,
    region: string,
    factoryId: FactoryId,
  ): Promise<VpcInventory>;
}
