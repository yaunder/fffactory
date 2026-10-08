import { isAbsolute, join } from "node:path";
import type { CacheDirectoryState } from "../domain/cache";

/** Port: inspects the FFFactory cache directory without creating or changing it. */
export interface CacheDirectoryProbe {
  /** Rejects on any I/O error other than the path being absent. */
  inspect(path: string): Promise<CacheDirectoryState>;
}

/**
 * FFFactory's private cache: `$XDG_CACHE_HOME/fffactory`, or `~/.cache/fffactory` when
 * `XDG_CACHE_HOME` is unset, empty or relative (which the XDG specification says to ignore).
 */
export function cacheDirectoryPath(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const base = env.XDG_CACHE_HOME;
  return join(base && isAbsolute(base) ? base : join(home, ".cache"), "fffactory");
}
