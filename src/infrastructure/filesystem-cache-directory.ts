import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import type { CacheDirectoryProbe } from "../application/cache-directory";
import type { CacheDirectoryState } from "../domain/cache";

const NOT_PERMITTED = new Set(["EACCES", "EPERM", "EROFS"]);

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Absent, unless a dangling symbolic link occupies the path. */
async function absentOrLink(path: string): Promise<CacheDirectoryState> {
  try {
    await lstat(path);
    return "not_directory";
  } catch (error) {
    if (code(error) === "ENOENT") return "absent";
    throw error;
  }
}

/** CacheDirectoryProbe over the local filesystem. It only reads metadata. */
export const filesystemCacheDirectory: CacheDirectoryProbe = {
  async inspect(path) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch (error) {
      if (code(error) === "ENOENT") return absentOrLink(path);
      throw error;
    }
    if (!info.isDirectory()) return "not_directory";
    try {
      await access(path, constants.W_OK | constants.X_OK);
      return "writable";
    } catch (error) {
      if (NOT_PERMITTED.has(code(error) ?? "")) return "not_writable";
      throw error;
    }
  },
};
