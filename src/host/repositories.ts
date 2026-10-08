/** Worker-side repository reconciliation and observation (`docs/specs/repositories.md`). */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HOST_PROTOCOL_VERSION } from "../domain/host-protocol";
import {
  type RepositoryInspection,
  parseRepositoryInspection,
  REPOSITORY_MANIFEST_PATH,
  REPOSITORY_RESULT_PATH,
  repositoryInspectionJson,
  SYNC_SCRIPT,
} from "../domain/repository-placement";
import { RUNTIME_ACCOUNT } from "../domain/readiness";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { ApplySystem } from "./apply";

export const REPOSITORY_SYNC_TIMEOUT_MS = 15 * 60_000;

export interface HostRepositories {
  inspectRepositories(): Promise<RepositoryInspection>;
  reconcileRepositories(): Promise<RepositoryInspection>;
}

function pathAt(root: string, path: string): string {
  return join(root, path);
}

async function atomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.new`;
  try {
    await writeFile(temporary, text, { mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readResult(root: string): Promise<RepositoryInspection> {
  try {
    const parsed = parseRepositoryInspection(
      await readFile(pathAt(root, REPOSITORY_RESULT_PATH), "utf8"),
    );
    return parsed.ok
      ? parsed.inspection
      : { protocol_version: HOST_PROTOCOL_VERSION, state: "unreadable" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { protocol_version: HOST_PROTOCOL_VERSION, state: "none" }
      : { protocol_version: HOST_PROTOCOL_VERSION, state: "unreadable" };
  }
}

function failure(outcome: Exclude<ProcessOutcome, { readonly kind: "exited" }>): Error {
  if (outcome.kind === "timed_out") return new Error("repository synchronization timed out");
  if (outcome.kind === "not_found") return new Error("runuser is not installed");
  return new Error(`repository synchronization could not start (${outcome.code})`);
}

function completedResult(outcome: ProcessOutcome): RepositoryInspection {
  if (outcome.kind !== "exited") throw failure(outcome);
  const parsed = parseRepositoryInspection(outcome.stdout);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (parsed.inspection.state !== "synchronized" && parsed.inspection.state !== "unresolved")
    throw new Error("repository synchronization returned no completed result");
  if ((outcome.exitCode === 0) !== (parsed.inspection.state === "synchronized"))
    throw new Error("repository synchronization exit status disagrees with its result");
  return parsed.inspection;
}

async function runRepositorySync(
  system: ApplySystem,
  manifestPath: string,
): Promise<RepositoryInspection> {
  const script = pathAt(system.root, SYNC_SCRIPT);
  const outcome = await system.run(
    [
      "runuser",
      "-u",
      RUNTIME_ACCOUNT,
      "--",
      "env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      `HOME=/home/${RUNTIME_ACCOUNT}`,
      "LANG=C.UTF-8",
      script,
      "--apply",
      "--manifest",
      manifestPath,
      "--json",
    ],
    REPOSITORY_SYNC_TIMEOUT_MS,
    { cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } },
  );
  return completedResult(outcome);
}

export function workerRepositories(system: ApplySystem): HostRepositories {
  return {
    inspectRepositories: () => readResult(system.root),
    async reconcileRepositories() {
      if (!system.isRoot())
        throw new Error("host repositories --apply must run through the activator");
      const manifest = await system.readInput();
      const manifestPath = pathAt(system.root, REPOSITORY_MANIFEST_PATH);
      await atomically(manifestPath, manifest);
      const result = await runRepositorySync(system, manifestPath);
      await atomically(
        pathAt(system.root, REPOSITORY_RESULT_PATH),
        `${repositoryInspectionJson(result)}\n`,
      );
      return result;
    },
  };
}
