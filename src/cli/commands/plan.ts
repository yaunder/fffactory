import { parseArgs } from "node:util";
import { planFactory } from "../../application/plan-factory";
import type { CliContext, Command } from "../context";
import { sha256Text } from "../../infrastructure/release-tarball";
import { commandLine, planningBasis, printPlanRefusal, type SelectionFlags } from "./planning";

const USAGE = [
  "Usage: fffactory plan [--instance PATH] [--profile NAME]",
  "",
  "Plans the factory from factory.json and what exists now, and shows the plan:",
  "the configuration path, factory, AWS account, Region and release, then the",
  "infrastructure changes. Planning changes nothing.",
  "",
  "A plan with changes is saved under a plan ID for an hour. `fffactory apply",
  "--plan-id ID` applies exactly that plan, and refuses it once factory.json, the",
  "fffactory release, the AWS account or the factory's Terraform state has changed.",
  "",
  "Before the first apply the state bucket does not exist yet, and the plan is",
  "backend bootstrap's: `fffactory apply` creates the bucket first, then plans the",
  "factory.",
  "",
  "Refused, naming what is missing, when this fffactory is not the release",
  "factory.json pins, when factory.json no longer declares a provisioned host key",
  "(only `fffactory worker terminate KEY` removes a host), and until host",
  "replacement exists (milestone M3) when the plan would destroy or replace a host",
  "machine. Like every command that plans or changes AWS, it first checks that the",
  "credentials belong to the factory's account.",
];

/** The command that applies exactly this plan, with the instance and profile it was made with. */
function applyCommandFor(planId: string, flags: SelectionFlags): string {
  return commandLine(["fffactory", "apply", "--plan-id", planId], flags);
}

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
    case "bootstrap_first":
      for (const line of result.plan) context.out(line);
      context.out(
        "The factory itself is planned once the state bucket exists: `fffactory apply` asks " +
          "you to approve this bootstrap first, then plans the factory for its own approval.",
      );
      return 0;
    case "planned": {
      for (const line of result.plan) context.out(line);
      const { saved } = result;
      context.out(
        `Saved as plan ${saved.plan_id}, until ${saved.expires_at}. To apply exactly it:`,
      );
      context.out(`  ${applyCommandFor(saved.plan_id, values)}`);
      return 0;
    }
    default:
      printPlanRefusal("plan", result, context);
      return 1;
  }
}

export const planCommand: Command = {
  summary:
    "Show the factory's plan from factory.json and live state, and save it (changes nothing)",
  usage: USAGE,
  run: plan,
};
