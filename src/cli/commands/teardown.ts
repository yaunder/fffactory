import { parseArgs } from "node:util";
import {
  credentialSelection,
  PROFILE_ENVIRONMENT_VARIABLE,
} from "../../application/caller-identity";
import {
  type FactoryTeardown,
  type TeardownDependencies,
  type TeardownProgress,
  teardownFactory,
} from "../../application/teardown-factory";
import { render, renderInSection } from "../presentation/blocks";
import type { Selection } from "../presentation/command-line";
import type { Writer } from "../presentation/style";
import {
  removingSection,
  teardownOutcome,
  teardownProgressLine,
  teardownReviewBlocks,
} from "../presentation/teardown";
import type { CliContext, Command } from "../context";
import { printReport, terraformDirectory } from "./planning";
import { loadInstance, printAccountRefusal } from "./selected-instance";

// TODO(re-evaluate when a caller must parse teardown's result): add `--json`, a versioned
// report of the outcome with its schema, as `status --json` has.
const USAGE = [
  "Usage: fffactory teardown [--confirm FACTORY_ID] [--instance PATH] [--profile NAME]",
  "",
  "Removes the whole factory and everything it owns but its log archive, under the",
  "factory-wide lock: every worker's EC2 instance and root volume, the network, IAM",
  "and everything else its Terraform state holds, its tailnet devices, the secrets",
  "it owns (deleted without a recovery window, each confirmed gone), its local saved",
  "plans and, last, the state bucket with its state, lock and operation records.",
  "Admin-tier: it needs AWS credentials that can destroy the factory and the",
  "factory's Tailscale admin client (`fffactory secret set tailscale-admin-client`).",
  "",
  "It first shows what it will remove and keep: the factory, the destroy plan, the",
  "instances and VPCs, the devices, the secrets and, when factory.json enables one,",
  "the log archive. You confirm by typing the factory ID at a terminal, or with",
  "--confirm FACTORY_ID. Once confirmed, it stops dispatch on every running worker",
  "and inspects each once: busy agents, work not pushed to any remote, unresolved",
  "or unmanaged checkouts, or a worker that cannot be inspected refuse it, naming",
  "the worker. Teardown has no --force: remove such a worker first with",
  "`fffactory worker terminate KEY --force`. A stopped worker is not inspected, and",
  "unpushed work on its disk is destroyed. A refusal leaves dispatch stopped where",
  "it stopped it: `fffactory apply` restarts it.",
  "",
  "It keeps every secret factory.json only refers to, tagged secrets it does not",
  "own, tailnet devices that are not provably the factory's, the Tailscale auth",
  "key and OAuth client themselves, the log archive when factory.json enables",
  "one, which fffactory never removes, and factory.json, which still describes",
  "the factory: `fffactory apply` would create it again, adopting the archive if",
  "it exists. Revoke the persistent sources at their providers yourself once",
  "nothing else uses them.",
  "",
  "When a deletion fails part way, it reports what remains, and rerunning it",
  "finishes from what actually remains. Without a state bucket, it deletes only",
  "the factory's tailnet devices, owned secrets and local saved plans, without a",
  "lock, and refuses while EC2 lists anything tagged with the factory ID.",
  "",
  "Refused, removing nothing, without a terminal or --confirm, when --confirm does",
  "not name the factory ID (never echoed), when factory.json is incomplete or has",
  "no admin client, the credentials belong to another account, this fffactory is",
  "not the release factory.json pins, another operation holds the lock, or a",
  "listing fails. Interrupted, it says what it left and what to do next: under",
  "the lock, the factory usually stays locked, for `fffactory lock break` once",
  "fffactory has exited, then a rerun.",
  "",
  "  --confirm FACTORY_ID  Confirm without asking, naming the factory ID.",
  "  --instance PATH       Select the instance, as for `fffactory validate`.",
  "  --profile NAME        Use this AWS profile. Otherwise AWS_PROFILE, or else the",
  "                        standard AWS credential chain.",
  "",
  "Exits 0 once only what it keeps remains, 1 when refused or declined",
  "(nothing removed) or failed before removing anything, 2 when it stopped part",
  "way, with what remains and the next action, and 128 plus the signal's number",
  "when interrupted.",
];

const OPTIONS = {
  confirm: { type: "string" },
  instance: { type: "string" },
  profile: { type: "string" },
} as const;

/**
 * The options given, or undefined when anything else was: an argument is never echoed, since
 * one meant for `--confirm` could be a pasted secret.
 */
function options(args: readonly string[]) {
  try {
    return parseArgs({ args: [...args], options: OPTIONS, strict: true, allowPositionals: false })
      .values;
  } catch {
    return undefined;
  }
}

/** Streams each step under the Removing section, its rule written once the first step starts. */
function stepsOn(writer: Writer): (event: Exclude<TeardownProgress, { kind: "review" }>) => void {
  let started = false;
  return (event) => {
    if (!started) {
      writer("");
      for (const line of render(writer.style, [removingSection()])) writer(line);
      started = true;
    }
    for (const line of renderInSection(writer.style, [teardownProgressLine(event)])) writer(line);
  };
}

/**
 * Shows the review, then a blank line before the question when it is asked, as apply leaves
 * before its own; then each step as it starts.
 */
function progressOf(
  writer: Writer,
  selection: Selection,
  asks: boolean,
): (event: TeardownProgress) => void {
  const step = stepsOn(writer);
  return (event) => {
    if (event.kind !== "review") return step(event);
    printReport(writer, { blocks: teardownReviewBlocks(event.review, selection) });
    if (asks) writer("");
  };
}

function dependencies(
  context: CliContext,
  selection: Selection,
  asks: boolean,
): TeardownDependencies {
  const { workflowQueue } = context;
  // `main.ts` always wires the workflow queue; a context without one cannot stop dispatch.
  if (workflowQueue === undefined) throw new Error("teardown needs the workflow queue");
  return {
    identity: context.identity,
    lockStore: context.lockStore,
    machines: context.machines,
    peers: context.tailnet,
    transport: context.transport,
    controlPlane: context.controlPlane,
    workflowQueue,
    prompt: context.prompt,
    secrets: context.secrets,
    tailnetAdmin: context.tailnetAdmin,
    provisioner: context.provisioner,
    planStore: context.planStore,
    terraformDirectory: () => terraformDirectory(context),
    interrupted: context.interrupted,
    sleep: context.sleep,
    progress: progressOf(context.out, selection, asks),
  };
}

/** 0 once only what teardown keeps remains, 2 part way, 1 for anything else. */
function exitCode(result: FactoryTeardown): number {
  if (result.kind === "done") return 0;
  return result.kind === "partial" ? 2 : 1;
}

async function teardown(args: readonly string[], context: CliContext): Promise<number> {
  const values = options(args);
  if (values === undefined) {
    context.err(
      args.includes("--force")
        ? "fffactory teardown has no --force: remove a worker it refuses with `fffactory worker terminate KEY --force` first."
        : "fffactory teardown takes only --confirm FACTORY_ID, --instance PATH and --profile NAME.",
    );
    return 1;
  }
  if (values.profile === "") {
    context.err("fffactory teardown: --profile needs a profile name");
    return 1;
  }
  const selection: Selection = { instance: values.instance, profile: values.profile };
  const loaded = await loadInstance(values.instance, context, "teardown");
  if (!loaded) return 1;
  const credentials = credentialSelection(
    values.profile,
    context.env[PROFILE_ENVIRONMENT_VARIABLE],
  );
  // Without --confirm the factory ID is asked once the review is shown.
  const asks = values.confirm === undefined;
  const result = await teardownFactory(dependencies(context, selection, asks), {
    instance: loaded.instance,
    instancePath: loaded.path,
    credentials,
    release: context.release,
    confirm: values.confirm,
    host: context.hostname,
    clock: context.now,
    randomBytes: context.randomBytes,
  });
  if (result.kind === "account_refused") {
    printAccountRefusal("remove the factory", result.requirement, context, {
      expectation: result.expectation,
      credentials,
    });
    return 1;
  }
  const { stream, report } = teardownOutcome(result, {
    factoryId: loaded.instance.factory_id,
    now: context.now(),
    selection,
  });
  printReport(context[stream], report);
  return exitCode(result);
}

export const teardownCommand: Command = {
  summary: "Remove the whole factory, all it owns but its log archive, after you confirm its ID",
  usage: USAGE,
  run: teardown,
  waitsOnInterrupt: true,
};
