import { parseArgs } from "node:util";
import { type Upgrade, upgradeFactory } from "../../application/upgrade";
import { describeD11Refusal } from "../../domain/plan";
import {
  assessUpgrade,
  schemaVersionChange,
  type UpgradeAssessment,
} from "../../domain/release-compatibility";
import type { CliContext, Command } from "../context";
import { sha256Text } from "../../infrastructure/release-tarball";
import { operatorApproval, progressLine, reportApply } from "./apply";
import { basisOf } from "./planning";
import { printIssues, selectInstance, validatedInstance } from "./selected-instance";

const USAGE = [
  "Usage: fffactory upgrade [--instance PATH] [--profile NAME]",
  "",
  "Moves the factory to this fffactory's release. Run by a later fffactory than",
  "the release factory.json pins, it shows the pin move with the factory's complete",
  "plan made for this release (the configuration path, factory, AWS account, Region",
  "and release, the infrastructure changes, then each worker's install) and, once",
  "you type yes, writes the new pin to factory.json under the factory-wide lock and",
  "applies exactly that plan, as `fffactory apply` does, so it needs a terminal.",
  "Declining, or a factory.json that changed meanwhile, moves nothing. An upgrade",
  "never creates the state bucket: a factory without one is refused, and",
  "`fffactory apply` with the release factory.json pins creates it.",
  "",
  "The pin is written before anything is applied: from then on factory.json pins",
  "this release even when applying fails, is interrupted or skips a worker, and",
  "`fffactory apply` with this release converges what remains.",
  "",
  "Refused, naming what is missing, until milestone M3 brings schema and base",
  "migrations: when this release reads and writes another factory.json schema",
  "version, or needs a newer base generation than the pinned release's workers",
  "have. A factory.json that pins this release has nothing to upgrade, and one that",
  "pins a later release is never moved back. Like every command that plans or",
  "changes AWS, it first checks that the credentials belong to the factory's account.",
  "",
  "Exits as apply does: 0 once every worker is installed, 2 when a worker was",
  "skipped, and 1 when anything failed or was refused.",
];

const QUESTION = 'Move the pin and apply this plan? Only "yes" does: ';

/** Says why the pin does not move, and returns the exit code. */
function reportNoUpgrade(
  assessment: Exclude<UpgradeAssessment, { readonly kind: "upgrade" }>,
  context: CliContext,
): number {
  switch (assessment.kind) {
    case "current":
      context.out(
        `factory.json already pins this release, ${context.release}: there is nothing to ` +
          "upgrade. `fffactory apply` converges the factory to it.",
      );
      return 0;
    case "downgrade":
      context.err(
        "Refusing to upgrade: factory.json pins a later fffactory release than this one, " +
          `${context.release}: fffactory never moves a pin back to an earlier release ` +
          "(downgrade is not supported). Install the release factory.json pins.",
      );
      return 1;
    case "unpinned":
      printIssues(
        "Refusing to upgrade: factory.json is not ready:",
        [{ path: "release", message: "is required to upgrade" }],
        context,
      );
      return 1;
    case "d11":
      for (const line of describeD11Refusal(assessment.refusal)) context.err(line);
      return 1;
  }
}

function report(result: Upgrade, context: CliContext): number {
  if (result.kind !== "upgrade") return reportNoUpgrade(result, context);
  const { apply, pinned } = result;
  const code = reportApply(apply, context, {
    action: "upgrade",
    rerun: pinned ? "apply" : "upgrade",
  });
  if (!pinned)
    context.err("factory.json's pin was not moved: it still pins the release it pinned.");
  else if (apply.kind === "failed" && (apply.step === "pinning" || apply.step === "pinned"))
    context.err(
      `factory.json pins release ${context.release}: rerun \`fffactory apply\` with this ` +
        "release to finish.",
    );
  return code;
}

async function upgrade(args: readonly string[], context: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { instance: { type: "string" }, profile: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (values.profile === "") {
    context.err("fffactory upgrade: --profile needs a profile name");
    return 1;
  }
  if (!context.prompt.interactive) {
    context.err("Upgrading needs your approval of the pin move and the plan: rerun at a terminal.");
    return 1;
  }
  const selected = await selectInstance(values.instance, context);
  if (!selected) return 1;
  // Before validation, which a factory.json of another schema version would fail.
  const schema = schemaVersionChange(
    await context.store.read(selected.path),
    context.compatibility,
  );
  if (schema !== undefined) return reportNoUpgrade(schema, context);
  const loaded = await validatedInstance(selected.path, context);
  if (!loaded) return 1;
  // Refusals that need no AWS come first: they plan and change nothing.
  const assessment = assessUpgrade(loaded.instance.release, context.release, context.compatibility);
  if (assessment.kind !== "upgrade") return reportNoUpgrade(assessment, context);
  const basis = await basisOf(loaded, "upgrade", values, context);
  if (!basis) return 1;
  const result = await upgradeFactory(
    {
      lockStore: context.lockStore,
      provisioner: context.provisioner,
      planStore: context.planStore,
      approval: operatorApproval(undefined, context, QUESTION),
      interrupted: context.interrupted,
      peers: context.tailnet,
      transport: context.transport,
      assets: context.assets,
      progress: (event) => context.out(progressLine(event, context.release)),
      sleep: context.sleep,
      sha256: sha256Text,
      store: context.store,
      pinned: () => context.out(`factory.json now pins release ${context.release}.`),
    },
    {
      ...basis,
      text: loaded.text,
      compatibility: context.compatibility,
      host: context.hostname,
      clock: context.now,
      randomBytes: context.randomBytes,
    },
  );
  return report(result, context);
}

export const upgradeCommand: Command = {
  summary: "Move factory.json's release pin to this release and apply the plan, after approval",
  usage: USAGE,
  run: upgrade,
  waitsOnInterrupt: true,
};
