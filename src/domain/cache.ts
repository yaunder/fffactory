import { type CheckResult, notReady, ready, thenRerun } from "./check-result";

/** What the FFFactory cache directory path currently holds. */
export type CacheDirectoryState = "absent" | "writable" | "not_writable" | "not_directory";

export const CACHE_DIRECTORY_CHECK = {
  id: "cache_directory",
  title: "FFFactory cache directory",
} as const;

/** The cache is usable when FFFactory can create it or already can write into it. */
export function cacheDirectoryCheck(path: string, state: CacheDirectoryState): CheckResult {
  switch (state) {
    case "absent":
      return ready(
        CACHE_DIRECTORY_CHECK,
        `${path} does not exist yet; FFFactory creates it when first needed`,
      );
    case "writable":
      return ready(CACHE_DIRECTORY_CHECK, `${path} is a writable directory`);
    case "not_writable":
      return notReady(
        CACHE_DIRECTORY_CHECK,
        `${path} is not writable by the current user`,
        thenRerun(`Make it writable, for example \`chmod u+rwx ${path}\``),
      );
    case "not_directory":
      return notReady(
        CACHE_DIRECTORY_CHECK,
        `${path} is not a directory`,
        thenRerun(`Move or remove ${path} so FFFactory can create its cache directory there`),
      );
  }
}
