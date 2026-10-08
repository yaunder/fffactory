/**
 * Stable host keys: a host key, once provisioned, is never renamed or removed from
 * factory.json. Replacing a host means declaring a new key beside the old one; removing one
 * waits for host retirement (M3). A rename is indistinguishable from removing one key and
 * adding another, so both are rejected by comparing factory.json with the keys the factory's
 * Terraform state records.
 */
import { type FactoryInstance, type Issue, parseHostKey } from "./instance";

const RENAMED =
  "is provisioned but no longer declared: host keys cannot be renamed or removed. " +
  "Restore it, and declare any new host under a new key beside it";

/**
 * One issue at `hosts` for every recorded key factory.json no longer declares, in recorded
 * order. A recorded key is quoted only when it is a well-formed host key.
 */
export function checkStableHostKeys(
  recorded: readonly string[],
  instance: FactoryInstance,
): Issue[] {
  const declared = new Set<string>((instance.hosts ?? []).map((host) => host.key));
  return recorded
    .filter((key) => !declared.has(key))
    .map((key) => ({
      path: "hosts",
      message: parseHostKey(key).ok
        ? `host key "${key}" ${RENAMED}`
        : `a provisioned host key ${RENAMED}`,
    }));
}

/** The factory root module's output that records the host keys its state has provisioned. */
export const HOST_KEYS_OUTPUT = "host_keys";

/**
 * The host keys the factory's Terraform state records, from the factory root module's
 * outputs: none when there is no such output, as before the first apply; undefined when
 * the output is not a list of strings, so it cannot be read.
 */
export function recordedHostKeys(
  outputs: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  if (!Object.hasOwn(outputs, HOST_KEYS_OUTPUT)) return [];
  const keys = outputs[HOST_KEYS_OUTPUT];
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) return undefined;
  return keys;
}
