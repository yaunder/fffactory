import type { CredentialSelection } from "../domain/aws-account";
import type { FactoryId } from "../domain/instance";
import type { MachineInventory } from "../domain/status";

/** Port: the factory's EC2 instances, found by their factory ID tag. Read-only. */
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
}
