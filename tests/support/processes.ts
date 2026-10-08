import { readFile } from "node:fs/promises";

/** Whether a process with this pid exists. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `read` every 20 ms until it yields a value or `ms` elapse; undefined at the deadline. */
export async function eventually<T>(
  ms: number,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await Bun.sleep(20);
  }
}

/** Whether the process `pid` has exited within `ms`. */
export async function goneWithin(pid: number, ms: number): Promise<boolean> {
  return (await eventually(ms, () => (alive(pid) ? undefined : true))) === true;
}

/**
 * The `count` space-separated pids a stand-in script writes to `file` with `echo`,
 * once the whole line is there; undefined if it is not within `ms`.
 */
export function recordedPids(file: string, count: number, ms: number) {
  return eventually(ms, async () => {
    const text = await readFile(file, "utf8").catch(() => "");
    const pids = text.endsWith("\n") ? text.trim().split(" ").map(Number) : [];
    return pids.length === count && pids.every(Number.isInteger) ? pids : undefined;
  });
}

/** SIGKILLs and forgets every listed process still running. For `afterEach`. */
export function killSurvivors(pids: number[]) {
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
}
