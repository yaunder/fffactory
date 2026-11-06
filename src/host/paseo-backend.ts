/**
 * The Paseo execution backend (`docs/specs/dispatch.md` §Repository registration): a placed
 * checkout is available for supervision once it is a Paseo project. The only code that names
 * Paseo's project commands. It runs them through the `PaseoCommand` it is given (as `factory`,
 * authenticated by the active release's `paseo-auth.sh`), never a command of its own, lists
 * first and creates only the projects missing, so a rerun changes nothing. No Paseo output
 * reaches its result: a failure is said in fffactory's words.
 */
import {
  type CheckoutRegistration,
  repositoryRegistration,
} from "../domain/repository-registration";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { PaseoCommand } from "./control-plane";
import type { ExecutionBackend } from "./execution-backend";
import { ended } from "./failures";

/** The paths of the projects `project ls --json` printed, or why they could not be read. */
function projectPaths(outcome: ProcessOutcome): ReadonlySet<string> | string {
  const invalid = "Paseo's project list was invalid";
  const failure = ended("listing Paseo's projects", outcome);
  if (failure !== undefined || outcome.kind !== "exited") return failure ?? invalid;
  let rows: unknown;
  try {
    rows = JSON.parse(outcome.stdout);
  } catch {
    return invalid;
  }
  if (!Array.isArray(rows)) return invalid;
  const paths = rows.map((row: unknown) =>
    typeof row === "object" && row !== null ? (row as { path?: unknown }).path : undefined,
  );
  return paths.every((path) => typeof path === "string") ? new Set(paths as string[]) : invalid;
}

async function registered(paseo: PaseoCommand, path: string): Promise<CheckoutRegistration> {
  const failure = ended(
    "registering it as a Paseo project",
    await paseo(["project", "create", path, "--json"]),
  );
  return failure === undefined
    ? { path, state: "registered" }
    : { path, state: "failed", reason: failure };
}

export function paseoBackend(paseo: PaseoCommand): ExecutionBackend {
  return {
    async registerRepositories(checkouts) {
      if (checkouts.length === 0) return repositoryRegistration("paseo", []);
      const known = projectPaths(await paseo(["project", "ls", "--json"]));
      if (typeof known === "string")
        return repositoryRegistration(
          "paseo",
          checkouts.map((path) => ({ path, state: "failed", reason: known })),
        );
      const results: CheckoutRegistration[] = [];
      for (const path of checkouts)
        results.push(known.has(path) ? { path, state: "present" } : await registered(paseo, path));
      return repositoryRegistration("paseo", results);
    },
  };
}
