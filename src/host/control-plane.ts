/**
 * The worker's control-plane endpoint (`docs/specs/control-plane.md` §Worker protocol and
 * privilege boundary): the activator's fixed `activity`, `install`, `reload` and `restart`
 * actions, and `host agents`, the dispatcher's read of the same agents as `factory`. It decides
 * privilege, reads the host projection and the password it references, and hands everything
 * else to the worker's execution backend from the one selection point, never a backend's
 * commands of its own: the agents are the backend's runs, read as agents.
 */
import type { ControlPlaneAction, WorkerAgents } from "../domain/control-plane";
import { type HostProjection, parseHostProjection } from "../domain/host-projection";
import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "../domain/installation";
import { workerAgents } from "../domain/run";
import type { SecretMaterial } from "../domain/secrets";
import type { ApplySystem } from "./apply";
import { type BackendSelection, executionBackend } from "./execution-backend";
import { AWS_ENV, readSecretValue } from "./secret-value";

/** Each maintenance action's budget, every command of it together. */
const ACTION_BUDGET_MS = 2 * 60_000;
/**
 * The whole agent list's budget, every backend call in it together: under the CLI's two-minute
 * wait for the activity answer, so the worker answers, and frees the activator's lock, first.
 * `host agents` keeps the same bound, so a dispatch tick never hangs on the backend.
 */
const ACTIVITY_BUDGET_MS = 90_000;

export interface ControlPlaneEndpoint {
  /** The worker's agents, read as root through the activator. */
  activity(): Promise<WorkerAgents>;
  /** The same agents, read as `factory` without the activator, for the dispatcher. */
  agents(): Promise<WorkerAgents>;
  install(): Promise<ControlPlaneAction>;
  reload(): Promise<ControlPlaneAction>;
  restart(): Promise<ControlPlaneAction>;
}

/**
 * The password `projection` references, read by that reference as root with the instance role
 * (none without one), or why it could not be read. Read, never judged: what the backend accepts
 * is the backend's.
 */
async function passwordOf(
  system: ApplySystem,
  projection: HostProjection,
): Promise<{ ok: true; value: SecretMaterial | undefined } | { ok: false; reason: string }> {
  const reference = projection.paseo_password_secret;
  if (reference === undefined) return { ok: true, value: undefined };
  const read = await readSecretValue(
    (argv) => system.run(argv, CREDENTIAL_COMMAND_TIMEOUT_MS, { env: AWS_ENV }),
    reference,
  );
  return read.ok ? read : { ok: false, reason: `Paseo password: ${read.reason}` };
}

/** `select` is the worker's backend selection point; tests give a fake backend's. */
export function workerControlPlane(
  system: ApplySystem,
  select: BackendSelection = executionBackend,
): ControlPlaneEndpoint {
  const backend = (budgetMs: number) => select(system, budgetMs);
  return {
    async activity() {
      if (!system.isRoot()) return { kind: "unknown", reason: "not root" };
      return workerAgents(await backend(ACTIVITY_BUDGET_MS).runs());
    },
    async agents() {
      // The backend's state is factory's: as root its files there would become root's.
      if (system.isRoot()) return { kind: "unknown", reason: "run as root" };
      return workerAgents(await backend(ACTIVITY_BUDGET_MS).runs());
    },
    async install() {
      if (!system.isRoot()) return { kind: "failed", reason: "not root" };
      const parsed = parseHostProjection(await system.readInput());
      if (!parsed.ok) return { kind: "failed", reason: "invalid host projection" };
      if (parsed.document.hostname.toLowerCase() !== system.hostname().toLowerCase())
        return { kind: "failed", reason: "host projection is for another worker" };
      const password = await passwordOf(system, parsed.document);
      if (!password.ok) return { kind: "failed", reason: password.reason };
      return backend(ACTION_BUDGET_MS).install(parsed.document, password.value);
    },
    async reload() {
      if (!system.isRoot()) return { kind: "failed", reason: "not root" };
      return backend(ACTION_BUDGET_MS).reload();
    },
    async restart() {
      if (!system.isRoot()) return { kind: "failed", reason: "not root" };
      return backend(ACTION_BUDGET_MS).restart();
    },
  };
}
