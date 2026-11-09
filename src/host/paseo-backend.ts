/**
 * The Paseo execution backend (`docs/specs/execution-backend.md` §The `ExecutionBackend`
 * contract): the only worker code that names Paseo's CLI, its auth wrapper, its setup program,
 * its unit and its password's bcrypt cost. It runs the Paseo CLI only as `factory`,
 * authenticated by the active release's `paseo-auth.sh`: from root through `runuser` in
 * `factory`'s clean environment, otherwise the wrapper itself in that environment. Every command
 * it runs is within the one budget it was made with. No Paseo output reaches its results: a
 * failure is said in fffactory's words.
 */
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
import {
  type CheckoutRegistration,
  repositoryRegistration,
} from "../domain/repository-registration";
import type { SecretMaterial } from "../domain/secrets";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { ApplySystem } from "./apply";
import type { ExecutionBackend } from "./execution-backend";
import { ended } from "./failures";

/** Paseo's own cost: `DAEMON_PASSWORD_BCRYPT_COST` in `@getpaseo/server`'s auth.js. */
const PASEO_BCRYPT_COST = 12;
/** Root's environment for the commands it runs. */
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

/** Runs the Paseo CLI with `args`, as `factory` and authenticated. */
type PaseoCommand = (args: readonly string[]) => Promise<ProcessOutcome>;
/** Where, and in what environment, a caller already running as `factory` runs the Paseo CLI. */
export interface PaseoCaller {
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
}
/** Runs the Paseo CLI with `args`, authenticated, from where and in the environment `caller` says. */
export type CallerPaseoCommand = (
  args: readonly string[],
  caller: PaseoCaller,
) => Promise<ProcessOutcome>;
/** Runs `argv` as the caller, with root's environment and `stdin` when given. */
type Command = (argv: readonly string[], stdin?: string) => Promise<ProcessOutcome>;

/** A command run, every run of it within one budget from now. */
function budgeted(
  system: ApplySystem,
  budgetMs: number,
): (
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  stdin?: string,
) => Promise<ProcessOutcome> {
  const deadline = system.now().getTime() + budgetMs;
  return async (argv, env, stdin) => {
    const left = deadline - system.now().getTime();
    if (left <= 0) return { kind: "timed_out" };
    return system.run(argv, left, {
      env,
      ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
    });
  };
}

/** The active release's Paseo auth wrapper, the only way fffactory runs the Paseo CLI. */
function authWrapper(system: ApplySystem): string {
  return join(system.root, WORKER_PATHS.activeRelease, "steps/control-plane/paseo-auth.sh");
}

/**
 * The Paseo CLI as `factory`: from root, dropped to it with `runuser` into its clean
 * environment; run as anyone else (the dispatcher's `host agents`, as `factory`), the wrapper
 * itself in that environment, since Paseo's state is `factory`'s.
 */
function paseoCli(system: ApplySystem): {
  argv: readonly string[];
  env: typeof ENV | typeof FACTORY_ENV;
} {
  if (!system.isRoot()) return { argv: [authWrapper(system)], env: FACTORY_ENV };
  const clean = Object.entries(FACTORY_ENV).map(([name, value]) => `${name}=${value}`);
  return {
    argv: [
      "/usr/sbin/runuser",
      "-u",
      "factory",
      "--",
      "/usr/bin/env",
      "-i",
      ...clean,
      authWrapper(system),
    ],
    env: ENV,
  };
}

function failure(outcome: ProcessOutcome, what: string): ControlPlaneAction {
  if (outcome.kind === "exited")
    return outcome.exitCode === 0
      ? { kind: "done" }
      : { kind: "failed", reason: `${what} exited ${outcome.exitCode}` };
  return { kind: "failed", reason: `${what} ${outcome.kind}` };
}

// TODO(re-evaluate when task 5 lands): through startRun/runs
/**
 * The Paseo CLI for the dispatcher's launch and duplicate check (`src/host/dispatcher.ts`), which
 * already runs as `factory`: the active release's auth wrapper itself, from the directory and in
 * the environment the dispatcher gives, as the Python dispatcher ran it, each run within
 * `timeoutMs`.
 */
export function callerPaseo(system: ApplySystem, timeoutMs: number): CallerPaseoCommand {
  return (args, caller) =>
    system.run([authWrapper(system), ...args], timeoutMs, {
      ...(caller.cwd === undefined ? {} : { cwd: caller.cwd }),
      env: caller.env,
    });
}

// TODO(re-evaluate when no worker runs a release from before #142): stop taking RETIRED_DISPATCH_LOCK
/**
 * The lock the Python dispatcher of releases before #142 holds for its tick, in Paseo's home. A
 * tick still running under it when an upgrade's dispatch reconcile swaps the skill must exclude
 * the next one, so the dispatcher takes it too while its directory is there.
 */
export const RETIRED_DISPATCH_LOCK = `${FACTORY_ENV.HOME}/.paseo/factory-dispatch.lock`;

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
async function paseoAgents(paseo: PaseoCommand): Promise<WorkerAgents> {
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

/** The paths of the projects `project ls --json` printed, or why they could not be read. */
function projectPaths(outcome: ProcessOutcome): ReadonlySet<string> | string {
  const invalid = "Paseo's project list was invalid";
  const failed = ended("listing Paseo's projects", outcome);
  if (failed !== undefined || outcome.kind !== "exited") return failed ?? invalid;
  const rows = json(outcome.stdout);
  if (!Array.isArray(rows)) return invalid;
  const paths = rows.map((value: unknown) => fields(value)?.path);
  return paths.every((path) => typeof path === "string") ? new Set(paths as string[]) : invalid;
}

async function registered(paseo: PaseoCommand, path: string): Promise<CheckoutRegistration> {
  const failed = ended(
    "registering it as a Paseo project",
    await paseo(["project", "create", path, "--json"]),
  );
  return failed === undefined
    ? { path, state: "registered" }
    : { path, state: "failed", reason: failed };
}

/**
 * The setup program's standard input: the password's reference, then the bcrypt hash of the
 * password as Paseo's `daemon set-password` makes it (bcryptjs's `hashSync`, its cost), each line
 * empty without a reference; or why the password cannot be used. It is hashed as `paseo-auth.sh`
 * sends it, its final line endings dropped (`$(...)`), so fffactory's own CLI calls keep
 * authenticating. The password reaches only the hash function.
 */
function setupInput(
  reference: string | undefined,
  password: SecretMaterial | undefined,
): { ok: true; input: string } | { ok: false; reason: string } {
  if (reference === undefined) return { ok: true, input: "\n\n" };
  if (password === undefined) return { ok: false, reason: "Paseo password: it was not read" };
  const value = password.reveal().replace(/\n+$/, "");
  if (value.trim() === "") return { ok: false, reason: "Paseo password: its secret is empty" };
  return { ok: true, input: `${reference}\n${hashSync(value, PASEO_BCRYPT_COST)}\n` };
}

/** The Paseo backend on `system`, every command it runs within `budgetMs` from now. */
export function paseoBackend(system: ApplySystem, budgetMs: number): ExecutionBackend {
  const runWithin = budgeted(system, budgetMs);
  const cli = paseoCli(system);
  const paseo: PaseoCommand = (args) => runWithin([...cli.argv, ...args], cli.env);
  const run: Command = (argv, stdin) => runWithin(argv, ENV, stdin);
  const setup = join(system.root, WORKER_PATHS.activeRelease, "steps/control-plane/setup-host.sh");
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
    agents: () => paseoAgents(paseo),
    async install(projection, password) {
      const input = setupInput(projection.paseo_password_secret, password);
      if (!input.ok) return { kind: "failed", reason: input.reason };
      return failure(await run(["/bin/bash", setup], input.input), "Paseo setup");
    },
    reload: async () => failure(await paseo(["daemon", "reload"]), "Paseo reload"),
    restart: async () =>
      failure(await run(["/usr/bin/systemctl", "restart", "paseo.service"]), "Paseo restart"),
  };
}
