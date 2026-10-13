/**
 * Stable host keys: a host key, once provisioned, is never renamed, and is removed from
 * factory.json only by `fffactory worker terminate KEY`, which removes the host's machine with
 * it (`host-removal.ts`). Replacing a host means declaring a new key beside the old one. A
 * rename is indistinguishable from removing one key and adding another, so editing factory.json
 * to do either is rejected by comparing it with the keys the factory's Terraform state records.
 */
import { type FactoryInstance, type Issue, parseHostKey } from "./instance";

/** Why `key` (`KEY` when it is not one to quote) may not go missing from factory.json. */
const renamed = (key: string) =>
  "is provisioned but no longer declared: host keys cannot be renamed, and only " +
  `\`fffactory worker terminate ${key}\` removes a host. Restore it, and declare any new host ` +
  "under a new key beside it";

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
        ? `host key "${key}" ${renamed(key)}`
        : `a provisioned host key ${renamed("KEY")}`,
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
