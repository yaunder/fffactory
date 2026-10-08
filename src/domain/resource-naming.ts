/**
 * The namespacing rule: every name a factory gives an AWS resource or a Tailscale device
 * starts with its permanent factory ID and a hyphen, so several factories can share an AWS
 * account, Region and tailnet. The Terraform modules in `assets/terraform/` build every
 * name this way; their guardrail tests hold them to it.
 */
import type { FactoryId, HostKey } from "./instance";

/** The tag every factory resource carries; IAM conditions and inventory select by it. */
export const FACTORY_ID_TAG = "fffactory:factory-id";
/** The tag, with the value `fffactory`, on every resource fffactory manages. */
export const MANAGED_BY_TAG = "fffactory:managed-by";
/** The tag a host's instance and volume carry with the host's stable key. */
export const HOST_KEY_TAG = "fffactory:host-key";

/** `<factory ID>-<name>`: the name `name` in a factory's namespace. */
export function namespaced(factoryId: FactoryId, name: string): string {
  return `${factoryId}-${name}`;
}

/** A host's Tailscale hostname and instance name: `<factory ID>-<host key>`. */
export function hostName(factoryId: FactoryId, hostKey: HostKey): string {
  return namespaced(factoryId, hostKey);
}

/** Whether `name` is in the factory's namespace: its ID, a hyphen, then at least one more character. */
export function carriesFactoryId(name: string, factoryId: FactoryId): boolean {
  const prefix = `${factoryId}-`;
  return name.startsWith(prefix) && name.length > prefix.length;
}

/**
 * What the state bucket's name adds after the factory ID and a hyphen, or undefined when the
 * name does not carry the factory ID.
 */
export function stateBucketSuffix(factoryId: FactoryId, bucket: string): string | undefined {
  return carriesFactoryId(bucket, factoryId) ? bucket.slice(factoryId.length + 1) : undefined;
}
