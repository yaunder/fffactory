/**
 * The Paseo execution backend (`docs/specs/execution-backend.md` §The `ExecutionBackend`
 * contract): the only worker code that names Paseo's CLI, its auth wrapper, its setup program,
 * its unit, its password's bcrypt cost, the labels that carry a run's launch identity, the
 * environment a launch must not inherit, and its layout: where it keeps its worktrees and its
 * configuration. It runs the Paseo CLI only as `factory`, authenticated
 * by the active release's `paseo-auth.sh`: from root through `runuser` in `factory`'s clean
 * environment, otherwise the wrapper itself in the environment of the process it acts for, or
 * that clean one. Every command it runs is within the one budget it was made with. No Paseo
 * output reaches its results: a failure is said in fffactory's words.
 */
import { join } from "node:path";
import { hashSync } from "bcryptjs";
import { AGENT_ID, type AgentState, type ControlPlaneAction } from "../domain/control-plane";
import { WORKER_PATHS } from "../domain/host-protocol";
import {
  type CheckoutRegistration,
  repositoryRegistration,
} from "../domain/repository-registration";
import type { LaunchedWork, Run, RunRequest, RunStart, WorkerRuns } from "../domain/run";
import type { SecretMaterial } from "../domain/secrets";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { ApplySystem } from "./apply";
import type { BackendLayout, ExecutionBackend } from "./execution-backend";
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

type Environment = Readonly<Record<string, string>>;
/** Runs the Paseo CLI with `args`, as `factory` and authenticated. */
type PaseoCommand = (args: readonly string[]) => Promise<ProcessOutcome>;
/** Runs `argv` as the caller, with root's environment and `stdin` when given. */
type Command = (argv: readonly string[], stdin?: string) => Promise<ProcessOutcome>;

interface Within {
  readonly env: Environment;
  readonly stdin?: string;
  readonly cwd?: string;
}

/** A command run, every run of it within one budget from now. */
function budgeted(
  system: ApplySystem,
  budgetMs: number,
): (argv: readonly string[], options: Within) => Promise<ProcessOutcome> {
  const deadline = system.now().getTime() + budgetMs;
  return async (argv, { env, stdin, cwd }) => {
    const left = deadline - system.now().getTime();
    if (left <= 0) return { kind: "timed_out" };
    return system.run(argv, left, {
      env,
      ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
      ...(cwd === undefined ? {} : { cwd }),
    });
  };
}

/** The active release's Paseo auth wrapper, the only way fffactory runs the Paseo CLI. */
function authWrapper(system: ApplySystem): string {
  return join(system.root, WORKER_PATHS.activeRelease, "steps/control-plane/paseo-auth.sh");
}

/**
 * The Paseo CLI as `factory`: from root, dropped to it with `runuser` into its clean
 * environment; run as anyone else (as `factory`: `host agents`, the dispatcher), the wrapper
 * itself, since Paseo's state is `factory`'s, in the environment of the process it acts for
 * (`caller`, the dispatcher's), or else that clean one.
 */
function paseoCli(
  system: ApplySystem,
  caller: Environment | undefined,
): { argv: readonly string[]; env: Environment } {
  if (!system.isRoot()) return { argv: [authWrapper(system)], env: caller ?? FACTORY_ENV };
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

/** Paseo's home, `factory`'s `~/.paseo`. */
const PASEO_HOME = `${FACTORY_ENV.HOME}/.paseo`;

/**
 * Paseo's layout (`docs/specs/execution-backend.md` §Layout): its worktrees, searched three
 * levels down (`SDLC.md` §Worktree ownership), and its configuration, which holds the daemon
 * password's hash.
 */
const PASEO_LAYOUT: BackendLayout = {
  workspaceRoots: [{ path: `${PASEO_HOME}/worktrees`, depth: 3 }],
  privateFiles: [`${PASEO_HOME}/config.json`],
};

// TODO(re-evaluate when no worker runs a release from before #142): stop taking RETIRED_DISPATCH_LOCK
/**
 * The lock the Python dispatcher of releases before #142 holds for its tick, in Paseo's home. A
 * tick still running under it when an upgrade's dispatch reconcile swaps the skill must exclude
 * the next one, so the dispatcher takes it too while its directory is there.
 */
export const RETIRED_DISPATCH_LOCK = `${PASEO_HOME}/factory-dispatch.lock`;

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
/**
 * A launch identity as Paseo's labels: every run dispatch launches carries them, and `ls
 * --label` keeps only the agents carrying every label given. Paseo's list prints no label.
 */
const DISPATCHED = ["--label", "factory-dispatch=true"] as const;
const workLabels = (work: LaunchedWork) => [
  ...DISPATCHED,
  "--label",
  `factory-repository=${work.repository}`,
  "--label",
  `factory-epic=${work.workItem}`,
];
/** The scheduled agent's own identity, which would make a launch its child, in its workspace. */
const AGENT_IDENTITY = new Set(["PASEO_AGENT_ID", "PASEO_WORKSPACE_ID"]);

type Unread = Extract<WorkerRuns, { kind: "unknown" }>;
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

/** The listed agents as runs, each marked by `mark`; inspected only once every status is known. */
async function translated(
  paseo: PaseoCommand,
  rows: readonly Row[],
  mark: (row: Row) => Pick<Run, "dispatched" | "work">,
): Promise<WorkerRuns> {
  if (rows.some((agent) => !Object.hasOwn(STATE_OF, agent.status)))
    return unread("Paseo reported an agent status fffactory does not know");
  const runs: Run[] = [];
  for (const agent of rows) {
    const state = await stateOf(paseo, agent);
    if (typeof state !== "string") return state;
    runs.push({ id: agent.id, state, ...mark(agent) });
  }
  return { kind: "listed", runs };
}

/**
 * The worker's runs in fffactory's states (`docs/specs/control-plane.md` §Agent states). The
 * only code that knows Paseo's statuses: it lists every agent, marks the ones dispatch
 * labelled, and inspects only the running ones for a pending permission; given `work`, it lists
 * only the agents labelled for it. Anything it cannot read makes the whole answer unknown, never
 * a guess.
 */
async function paseoRuns(paseo: PaseoCommand, work?: LaunchedWork): Promise<WorkerRuns> {
  if (work !== undefined) {
    const launched = listed(await paseo([...LIST, ...workLabels(work), "--json"]));
    if ("kind" in launched) return launched;
    const { repository, workItem } = work;
    return translated(paseo, launched, () => ({
      dispatched: true,
      work: { repository, workItem },
    }));
  }
  const all = listed(await paseo([...LIST, "--json"]));
  if ("kind" in all) return all;
  const dispatched = listed(await paseo([...LIST, ...DISPATCHED, "--json"]));
  if ("kind" in dispatched) return dispatched;
  const launched = new Set(dispatched.map((agent) => agent.id));
  return translated(paseo, all, (agent) => ({ dispatched: launched.has(agent.id) }));
}

/**
 * `paseo run`'s arguments for `request`: top-level, without waiting (never `--background`, its
 * deprecated alias), in a new branch-off worktree workspace made from the checkout, labelled
 * with its launch identity, the prompt last.
 */
function launchArguments(request: RunRequest): readonly string[] {
  const { launch, agent } = request;
  return [
    ...["run", "--no-wait", "--json", "--provider", `${agent.provider}/${agent.model}`],
    ...["--mode", agent.mode, "--new-workspace", "worktree", "--worktree-mode", "branch-off"],
    ...["--new-branch", request.branch, "--base", request.base, "--cwd", request.checkout],
    ...workLabels(launch),
    ...["--label", `factory-dispatched-at=${launch.attempt}`],
    request.invocation,
  ];
}

/** The launch's environment: `env` without the scheduled agent's identity. */
const withoutAgentIdentity = (env: Environment): Environment =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !AGENT_IDENTITY.has(name)));

/** A launch's handle, from the `agentId` it printed; or why not. */
function started(outcome: ProcessOutcome): RunStart {
  const failed = ended("starting a Paseo run", outcome);
  if (failed !== undefined || outcome.kind !== "exited")
    return { kind: "failed", reason: failed ?? "starting a Paseo run failed" };
  const id = fields(json(outcome.stdout))?.agentId;
  return typeof id === "string" && AGENT_ID.test(id)
    ? { kind: "started", handle: { id } }
    : { kind: "failed", reason: "Paseo's answer to the run was invalid" };
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

/**
 * The Paseo backend on `system`, every command it runs within `budgetMs` from now; as `factory`,
 * in `caller`'s environment when given.
 */
export function paseoBackend(
  system: ApplySystem,
  budgetMs: number,
  caller?: Environment,
): ExecutionBackend {
  const runWithin = budgeted(system, budgetMs);
  const cli = paseoCli(system, caller);
  const paseo: PaseoCommand = (args) => runWithin([...cli.argv, ...args], { env: cli.env });
  const run: Command = (argv, stdin) =>
    runWithin(argv, stdin === undefined ? { env: ENV } : { env: ENV, stdin });
  const setup = join(system.root, WORKER_PATHS.activeRelease, "steps/control-plane/setup-host.sh");
  return {
    layout: () => PASEO_LAYOUT,
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
    async startRun(request) {
      const argv = [...cli.argv, ...launchArguments(request)];
      const env = withoutAgentIdentity(cli.env);
      return started(await runWithin(argv, { env, cwd: request.checkout }));
    },
    runs: (work) => paseoRuns(paseo, work),
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
