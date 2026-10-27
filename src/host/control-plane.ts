import { join } from "node:path";
import { hashSync } from "bcryptjs";
import {
  AGENT_ID,
  type Agent,
  type AgentState,
  type ControlPlaneAction,
  type WorkerAgents,
} from "../domain/control-plane";
import { WORKER_PATHS } from "../domain/host-protocol";
import { parseHostProjection } from "../domain/host-projection";
import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "../domain/installation";
import type { SecretReference } from "../domain/instance";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { ApplySystem } from "./apply";
import { AWS_ENV, readSecretValue } from "./secret-value";

const TIMEOUT_MS = 2 * 60_000;
/**
 * The whole agent list's budget, every Paseo call in it together: under the CLI's two-minute
 * wait for the activity answer, so the worker answers, and frees the activator's lock, first.
 * `host agents` keeps the same bound, so a dispatch tick never hangs on Paseo.
 */
const ACTIVITY_BUDGET_MS = 90_000;
/** Paseo's own cost: `DAEMON_PASSWORD_BCRYPT_COST` in `@getpaseo/server`'s auth.js. */
const PASEO_BCRYPT_COST = 12;
const ENV = {
  PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
};
/** The Paseo CLI's entire environment as `factory`. */
const FACTORY_ENV = {
  HOME: "/home/factory",
  PATH: "/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
};

function failure(outcome: ProcessOutcome, what: string): ControlPlaneAction {
  if (outcome.kind === "exited")
    return outcome.exitCode === 0
      ? { kind: "done" }
      : { kind: "failed", reason: `${what} exited ${outcome.exitCode}` };
  return { kind: "failed", reason: `${what} ${outcome.kind}` };
}

/**
 * The bcrypt hash of the host's Paseo password, made as Paseo's `daemon set-password` makes it
 * (bcryptjs's `hashSync`, its cost), or why the password could not be had. The password is read
 * as root with the instance role and reaches only the hash function: never an argument, an
 * environment, a log or a file. It is hashed as `paseo-auth.sh` sends it, its final line endings
 * dropped (`$(...)`), so fffactory's own CLI calls keep authenticating.
 */
async function passwordHash(
  system: ApplySystem,
  arn: SecretReference,
): Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  const read = await readSecretValue(
    (argv) => system.run(argv, CREDENTIAL_COMMAND_TIMEOUT_MS, { env: AWS_ENV }),
    arn,
  );
  if (!read.ok) return { ok: false, reason: `Paseo password: ${read.reason}` };
  const password = read.value.reveal().replace(/\n+$/, "");
  if (password.trim() === "") return { ok: false, reason: "Paseo password: its secret is empty" };
  return { ok: true, hash: hashSync(password, PASEO_BCRYPT_COST) };
}

/** Runs the Paseo CLI with `args`, as `factory` and authenticated. */
export type PaseoCommand = (args: readonly string[]) => Promise<ProcessOutcome>;

/**
 * fffactory's state for each Paseo status but `running`, which is `working` or `needs_input`
 * by its pending permissions. Any status not here is unreadable.
 */
const STATE_OF: Readonly<Record<string, AgentState | "running">> = {
  initializing: "working",
  running: "running",
  idle: "finished",
  error: "failed",
  closed: "stopped",
};
/** Every agent, background workspaces' too; `--label` keeps the ones dispatch launched. */
const LIST = ["ls", "--global", "--background"] as const;
const DISPATCHED = ["--label", "factory-dispatch=true"] as const;

type Unread = Extract<WorkerAgents, { kind: "unknown" }>;
const unread = (reason: string): Unread => ({ kind: "unknown", reason });

interface Row {
  readonly id: string;
  readonly status: string;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function fields(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function row(value: unknown): Row | undefined {
  const { id, status } = fields(value) ?? {};
  return typeof id === "string" && AGENT_ID.test(id) && typeof status === "string"
    ? { id, status }
    : undefined;
}

/** A Paseo agent list's rows, or why it could not be read. */
function listed(outcome: ProcessOutcome): readonly Row[] | Unread {
  if (outcome.kind !== "exited" || outcome.exitCode !== 0)
    return unread("Paseo activity could not be read");
  const parsed = json(outcome.stdout);
  if (!Array.isArray(parsed)) return unread("Paseo activity was invalid");
  const rows = parsed.map(row);
  return rows.includes(undefined) ? unread("Paseo activity was invalid") : (rows as Row[]);
}

/** A listed agent's state; a running one's from its pending permissions (`agent inspect`). */
async function stateOf(paseo: PaseoCommand, agent: Row): Promise<AgentState | Unread> {
  const state = STATE_OF[agent.status] as AgentState | "running";
  if (state !== "running") return state;
  const outcome = await paseo(["agent", "inspect", agent.id, "--json"]);
  if (outcome.kind !== "exited" || outcome.exitCode !== 0)
    return unread("a Paseo agent could not be inspected");
  const inspection = fields(json(outcome.stdout));
  const pending = inspection?.Id === agent.id ? inspection.PendingPermissions : undefined;
  if (!Array.isArray(pending)) return unread("a Paseo agent's inspection was invalid");
  return pending.length > 0 ? "needs_input" : "working";
}

/**
 * The worker's agents in fffactory's states (`docs/specs/control-plane.md` §Agent states). The
 * only code that knows Paseo's statuses: it lists every agent, marks the ones dispatch
 * labelled, and inspects only the running ones for a pending permission. Anything it cannot
 * read makes the whole answer unknown, never a guess.
 */
export async function paseoAgents(paseo: PaseoCommand): Promise<WorkerAgents> {
  const all = listed(await paseo([...LIST, "--json"]));
  if ("kind" in all) return all;
  const dispatched = listed(await paseo([...LIST, ...DISPATCHED, "--json"]));
  if ("kind" in dispatched) return dispatched;
  if (all.some((agent) => !Object.hasOwn(STATE_OF, agent.status)))
    return unread("Paseo reported an agent status fffactory does not know");
  const launched = new Set(dispatched.map((agent) => agent.id));
  const agents: Agent[] = [];
  for (const agent of all) {
    const state = await stateOf(paseo, agent);
    if (typeof state !== "string") return state;
    agents.push({ id: agent.id, state, dispatched: launched.has(agent.id) });
  }
  return { kind: "listed", agents };
}

export interface HostControlPlane {
  activity(): Promise<WorkerAgents>;
  /** The same agents, read as `factory` without the activator, for the dispatcher. */
  agents(): Promise<WorkerAgents>;
  install(): Promise<ControlPlaneAction>;
  reload(): Promise<ControlPlaneAction>;
  restart(): Promise<ControlPlaneAction>;
}

export function workerControlPlane(system: ApplySystem): HostControlPlane {
  const release = join(system.root, WORKER_PATHS.activeRelease);
  const auth = join(release, "steps/control-plane/paseo-auth.sh");
  const setup = join(release, "steps/control-plane/setup-host.sh");
  const run = (argv: readonly string[], stdin?: string) =>
    system.run(argv, TIMEOUT_MS, {
      env: ENV,
      ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
    });
  // The Paseo CLI as factory, in a clean environment, through the active release's auth wrapper.
  const asFactory = [
    "/usr/sbin/runuser",
    "-u",
    "factory",
    "--",
    "/usr/bin/env",
    "-i",
    ...Object.entries(FACTORY_ENV).map(([name, value]) => `${name}=${value}`),
    auth,
  ];
  // The adapter over `command`, every call of one answer within one budget.
  const agents = (command: readonly string[], env: Readonly<Record<string, string>>) => {
    const deadline = system.now().getTime() + ACTIVITY_BUDGET_MS;
    return paseoAgents(async (args) => {
      const left = deadline - system.now().getTime();
      if (left <= 0) return { kind: "timed_out" };
      return system.run([...command, ...args], left, { env });
    });
  };
  return {
    async activity() {
      if (!system.isRoot()) return { kind: "unknown", reason: "not root" };
      return agents(asFactory, ENV);
    },
    async agents() {
      // Paseo's state is factory's: as root its CLI would leave root-owned files there.
      if (system.isRoot()) return { kind: "unknown", reason: "run as root" };
      return agents([auth], FACTORY_ENV);
    },
    async install() {
      if (!system.isRoot()) return { kind: "failed", reason: "not root" };
      const input = await system.readInput();
      const parsed = parseHostProjection(input);
      if (!parsed.ok) return { kind: "failed", reason: "invalid host projection" };
      if (parsed.document.hostname.toLowerCase() !== system.hostname().toLowerCase())
        return { kind: "failed", reason: "host projection is for another worker" };
      // Setup's standard input: the reference, then the hash, each line empty without one.
      const arn = parsed.document.paseo_password_secret;
      if (arn === undefined) return failure(await run(["/bin/bash", setup], "\n\n"), "Paseo setup");
      const hashed = await passwordHash(system, arn);
      if (!hashed.ok) return { kind: "failed", reason: hashed.reason };
      return failure(await run(["/bin/bash", setup], `${arn}\n${hashed.hash}\n`), "Paseo setup");
    },
    async reload() {
      if (!system.isRoot()) return { kind: "failed", reason: "not root" };
      return failure(await run([...asFactory, "daemon", "reload"]), "Paseo reload");
    },
    async restart() {
      if (!system.isRoot()) return { kind: "failed", reason: "not root" };
      return failure(
        await run(["/usr/bin/systemctl", "restart", "paseo.service"]),
        "Paseo restart",
      );
    },
  };
}
