import { parseArgs } from "node:util";
import { planFactory } from "../../application/plan-factory";
import type { CliContext, Command } from "../context";
import { sha256Text } from "../../infrastructure/release-tarball";
import { savedBootstrapPlanReport, savedPlanReport } from "../presentation/plan";
import { planningBasis, printPlanRefusal, printReport } from "./planning";

const USAGE = [
  "Usage: fffactory plan [--instance PATH] [--profile NAME]",
  "",
  "Plans the factory from factory.json and what exists now, and shows the plan:",
  "the factory, AWS account, Region and release, the infrastructure changes, then",
  "every stage's changes for each worker. Planning changes nothing.",
  "",
  "Every plan is saved under a plan ID for an hour, and ends with the command that",
  "applies exactly it, `fffactory apply --plan-id ID`, which refuses it once",
  "factory.json, the fffactory release, the AWS account or the factory's Terraform",
  "state has changed.",
  "",
  "Before the first apply the state bucket does not exist yet, and the plan is",
  "backend bootstrap's, saved like any plan, so `apply --plan-id` can create the",
  "bucket without a terminal. It is refused once the bucket exists. Rerun `fffactory",
  "plan` after applying it: the factory is planned once the bucket exists. At a",
  "terminal, `fffactory apply` still creates the bucket after its own approval, then",
  "plans the factory.",
  "",
  "Refused, naming what is missing, when this fffactory is not the release",
  "factory.json pins, when factory.json no longer declares a provisioned host key",
  "(only `fffactory worker terminate KEY` removes a host), and until host",
  "replacement exists (milestone M3) when the plan would destroy or replace a host",
  "machine. Like every command that plans or changes AWS, it first checks that the",
  "credentials belong to the factory's account.",
];

async function plan(args: readonly string[], context: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { instance: { type: "string" }, profile: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (values.profile === "") {
    context.err("fffactory plan: --profile needs a profile name");
    return 1;
  }
  const basis = await planningBasis("plan", values, context);
  if (!basis) return 1;
  const result = await planFactory(
    {
      lockStore: context.lockStore,
      provisioner: context.provisioner,
      planStore: context.planStore,
      machines: context.machines,
      peers: context.tailnet,
      transport: context.transport,
      sha256: sha256Text,
    },
    { ...basis, now: context.now(), randomBytes: context.randomBytes },
  );
  switch (result.kind) {
    case "bootstrap_planned":
      printReport(context.out, savedBootstrapPlanReport(result.review, result.saved, values));
      return 0;
    case "planned":
      printReport(context.out, savedPlanReport(result.review, result.saved, values));
      return 0;
    default:
      printPlanRefusal("plan", result, context, values);
      return 1;
  }
}

export const planCommand: Command = {
  summary:
    "Show the factory's plan from factory.json and live state, and save it (changes nothing)",
  usage: USAGE,
  run: plan,
};
