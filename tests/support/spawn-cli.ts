import { resolve } from "node:path";

export const MAIN = resolve(import.meta.dir, "../../src/cli/main.ts");

/**
 * Runs `main.ts` with exactly `env`, never the inherited environment, and `stdin` as its
 * standard input when given. Asynchronous, so a stub server in the test process can answer
 * the child while it runs.
 */
export async function spawnCli(
  args: readonly string[],
  { cwd, env, stdin }: { cwd: string; env: Record<string, string>; stdin?: string },
) {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** The status of each check in a `doctor --json` report, by check ID. */
export function checkStatuses(stdout: string): Record<string, string> {
  return Object.fromEntries(doctorChecks(stdout).map((check) => [check.id, check.status] as const));
}

interface ReportedCheck {
  readonly id: string;
  readonly status: string;
  readonly summary: string;
  readonly details: readonly string[];
  readonly next_action: string | null;
}

/** Every check in a `doctor --json` report, in order. */
export function doctorChecks(stdout: string): ReportedCheck[] {
  const report = JSON.parse(stdout) as { capabilities: { checks: ReportedCheck[] }[] };
  return report.capabilities.flatMap((group) => group.checks);
}

/** The check with this ID in a `doctor --json` report. */
export function doctorCheck(stdout: string, id: string): ReportedCheck {
  const found = doctorChecks(stdout).find((check) => check.id === id);
  if (!found) throw new Error(`no check ${id} in the report`);
  return found;
}
