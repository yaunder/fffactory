import { parseArgs } from "node:util";
import { hostInspectionJson } from "../../domain/host-protocol";
import { hostApplyJson } from "../../domain/installation";
import { verificationJson } from "../../domain/readiness";
import { repositoryInspectionJson } from "../../domain/repository-placement";
import { activityJson, controlPlaneActionJson } from "../../domain/control-plane";
import {
  dispatchAdoptionExitCode,
  dispatchAdoptionJson,
  dispatchInspectionExitCode,
  dispatchInspectionJson,
} from "../../domain/dispatch-projection";
import { workInspectionJson } from "../../domain/work-inspection";
import type { CliContext, Command } from "../context";

const USAGE = [
  "Usage: fffactory host inspect --json",
  "       fffactory host apply",
  "       fffactory host verify --json",
  "       fffactory host repositories (--json | --apply)",
  "       fffactory host control-plane (activity | install | reload | restart)",
  "       fffactory host dispatch (adoption | reconcile | inspect)",
  "       fffactory host work inspect",
  "       fffactory host agents --json",
  "",
  "The worker side of the host protocol. The operator's fffactory runs these on a",
  "worker over SSH as fffactory-admin, and the dispatcher runs agents as factory;",
  "there is no need to run them yourself.",
  "",
  "  inspect --json  Print the worker's active release, configuration digest, last",
  "                  install, service states and readiness evidence as one",
  "                  versioned JSON document. Reads only; changes nothing.",
  "  apply           As root, run by the activator from the release it unpacked:",
  "                  read the host configuration on standard input, make this",
  "                  release active, run the install steps in order, then verify.",
  "                  Prints its versioned JSON record; exits 0 once it succeeded.",
  "  verify --json   As root: run the verifiers and check which accounts factory",
  "                  has enrolled. Changes nothing.",
  "  repositories    Read the last repository result (--json), or as root reconcile",
  "                  the manifest on standard input (--apply).",
  "  work inspect    As root, run by the activator: report, as the factory account,",
  "                  the uncommitted, unpushed and stashed work in every checkout",
  "                  and worktree. Reads only; changes nothing.",
  "  agents --json   As factory, run by the dispatcher: print the worker's agents in",
  "                  fffactory's states as the activity document; exits 1 when they",
  "                  cannot be read, the reason on standard error. Reads only;",
  "                  changes nothing.",
];

function jsonOnly(args: readonly string[]): boolean {
  const { values } = parseArgs({
    args: [...args],
    options: { json: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: false,
  });
  return values.json;
}

async function inspect(args: readonly string[], context: CliContext): Promise<number> {
  if (!jsonOnly(args)) {
    context.err("fffactory host inspect: the host protocol is JSON; pass --json");
    return 1;
  }
  context.out(hostInspectionJson(await context.worker.inspect()));
  return 0;
}

/** No arguments: the activator passes none, and the configuration comes on standard input. */
async function apply(args: readonly string[], context: CliContext): Promise<number> {
  parseArgs({ args: [...args], options: {}, strict: true, allowPositionals: false });
  const result = await context.worker.apply();
  context.out(hostApplyJson(result));
  return result.state === "succeeded" ? 0 : 1;
}

async function verify(args: readonly string[], context: CliContext): Promise<number> {
  if (!jsonOnly(args)) {
    context.err("fffactory host verify: the host protocol is JSON; pass --json");
    return 1;
  }
  if (!context.worker.isRoot()) {
    context.err(
      "fffactory host verify: run it as root; `fffactory apply` runs it on every install, within host apply",
    );
    return 1;
  }
  context.out(verificationJson(await context.worker.verify()));
  return 0;
}

async function repositories(args: readonly string[], context: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      json: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.json === values.apply) throw new Error("pass exactly one of --json or --apply");
  const result = values.apply
    ? await context.worker.reconcileRepositories()
    : await context.worker.inspectRepositories();
  context.out(repositoryInspectionJson(result));
  return result.state === "unresolved" || result.state === "unreadable" ? 1 : 0;
}

async function controlPlane(args: readonly string[], context: CliContext): Promise<number> {
  const [action, ...rest] = args;
  parseArgs({ args: rest, options: {}, strict: true, allowPositionals: false });
  if (!context.worker.isRoot())
    throw new Error("host control-plane runs only through the activator");
  if (action === "activity") {
    context.out(activityJson(await context.worker.activity()));
    return 0;
  }
  const result =
    action === "install"
      ? await context.worker.install()
      : action === "reload"
        ? await context.worker.reload()
        : action === "restart"
          ? await context.worker.restart()
          : undefined;
  if (result === undefined) throw new Error("name a control-plane action");
  context.out(controlPlaneActionJson(result));
  return result.kind === "done" ? 0 : 1;
}

async function adoption(context: CliContext): Promise<number> {
  const result = await context.worker.adoption();
  context.out(dispatchAdoptionJson(result));
  return dispatchAdoptionExitCode(result);
}

async function dispatchStateAction(
  action: string | undefined,
  context: CliContext,
): Promise<number> {
  const result =
    action === "reconcile"
      ? await context.worker.reconcileDispatch()
      : action === "inspect"
        ? await context.worker.inspectDispatch()
        : undefined;
  if (result === undefined) throw new Error("name a dispatch action");
  context.out(dispatchInspectionJson(result));
  return dispatchInspectionExitCode(result);
}

async function dispatch(args: readonly string[], context: CliContext): Promise<number> {
  const [action, ...rest] = args;
  parseArgs({ args: rest, options: {}, strict: true, allowPositionals: false });
  if (!context.worker.isRoot()) throw new Error("host dispatch runs only through the activator");
  return action === "adoption" ? adoption(context) : dispatchStateAction(action, context);
}

/** The current work in every checkout and worktree, read as the runtime account. */
async function work(args: readonly string[], context: CliContext): Promise<number> {
  const [action, ...rest] = args;
  parseArgs({ args: rest, options: {}, strict: true, allowPositionals: false });
  if (action !== "inspect") throw new Error("name a work action: inspect");
  if (!context.worker.isRoot()) throw new Error("host work runs only through the activator");
  context.out(workInspectionJson(await context.worker.inspectWork()));
  return 0;
}

/**
 * The worker's agents for its dispatcher, which runs this as `factory`: never through the
 * activator, so a dispatch tick never waits on its lock. Unreadable agents exit 1, so
 * dispatch fails safe rather than reading no agents, with their reason on one line on standard
 * error for the tick's error; standard output keeps the document.
 */
async function agents(args: readonly string[], context: CliContext): Promise<number> {
  if (!jsonOnly(args)) {
    context.err("fffactory host agents: the host protocol is JSON; pass --json");
    return 1;
  }
  if (context.worker.isRoot()) {
    context.err("fffactory host agents: run it as factory, never root; the dispatcher runs it");
    return 1;
  }
  const result = await context.worker.agents();
  context.out(activityJson(result));
  if (result.kind === "listed") return 0;
  context.err(`fffactory host agents: ${result.reason}`);
  return 1;
}

const SUBCOMMANDS: Readonly<
  Record<string, (args: readonly string[], context: CliContext) => Promise<number>>
> = {
  inspect,
  apply,
  verify,
  repositories,
  "control-plane": controlPlane,
  dispatch,
  work,
  agents,
};

async function host(args: readonly string[], context: CliContext): Promise<number> {
  const [subcommand, ...rest] = args;
  const known = subcommand !== undefined && Object.hasOwn(SUBCOMMANDS, subcommand);
  const run = known ? SUBCOMMANDS[subcommand] : undefined;
  if (run !== undefined) return run(rest, context);
  context.err(
    subcommand === undefined
      ? "fffactory host: name a subcommand"
      : `fffactory host: unknown subcommand "${subcommand}"`,
  );
  for (const line of USAGE) context.err(line);
  return 1;
}

export const hostCommand: Command = {
  summary: "Worker side of the host protocol, run over SSH by fffactory (inspect, apply, verify)",
  usage: USAGE,
  run: host,
};
