import type { CredentialSelection } from "../domain/aws-account";
import type { FactoryId } from "../domain/instance";
import type { VpcQuotaObservation } from "../domain/vpc-quota";

/** Port: reads the Region's "VPCs per Region" quota and its VPCs. Read-only. */
export interface VpcQuotaProbe {
  /**
   * Reads the quota from Service Quotas and lists the VPCs in `region` with EC2, noting
   * whether one is tagged as `factoryId`'s. Every credential, AWS, network and timeout
   * failure resolves to an observation; it rejects only on a defect.
   */
  inspect(
    credentials: CredentialSelection,
    region: string,
    factoryId: FactoryId,
  ): Promise<VpcQuotaObservation>;
}
