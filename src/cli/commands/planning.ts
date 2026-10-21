/**
 * What `plan` and `apply` share: the selected factory.json, the account check that comes
 * before anything reaches AWS, the release assets the Terraform comes from, and how a
 * refusal to plan is shown.
 */
import { join } from "node:path";
import { releaseAssetsDirectory } from "../../application/asset-bundle";
import { cacheDirectoryPath } from "../../application/cache-directory";
import {
  credentialSelection,
  PROFILE_ENVIRONMENT_VARIABLE,
} from "../../application/caller-identity";
import type { FactoryPlanRequest, PlanRefusal } from "../../application/plan-factory";
import { requireExpectedAccount } from "../../application/require-expected-account";
import { accountExpectation } from "../../domain/aws-account";
import { render, type Report } from "../presentation/blocks";
import type { Selection } from "../presentation/command-line";
import { planRefusalReport } from "../presentation/plan";
import type { Writer } from "../presentation/style";
import { sha256Hex } from "../../infrastructure/release-tarball";
import type { CliContext } from "../context";
import { type LoadedInstance, loadInstance, printAccountRefusal } from "./selected-instance";

export type PlanningBasis = Omit<FactoryPlanRequest, "now" | "randomBytes">;

/**
 * Loads factory.json, printing the header of the command `action` names, such as `plan`, and
 * runs the account check, refusing (and saying why) unless the caller is in the factory's
 * account; then materializes this release's assets.
 */
export async function planningBasis(
  action: string,
  flags: { readonly instance?: string; readonly profile?: string },
  context: CliContext,
): Promise<PlanningBasis | undefined> {
  const loaded = await loadInstance(flags.instance, context, action);
  if (!loaded) return undefined;
  return basisOf(loaded, action, flags, context);
}

/**
 * The planning basis of an instance already loaded: the account check, refusing (and saying
 * why) unless the caller is in the factory's account, then this release's assets.
 */
export async function basisOf(
  loaded: LoadedInstance,
  action: string,
  flags: { readonly profile?: string },
  context: CliContext,
): Promise<PlanningBasis | undefined> {
  const credentials = credentialSelection(flags.profile, context.env[PROFILE_ENVIRONMENT_VARIABLE]);
  const expectation = accountExpectation(loaded.instance);
  const account = await requireExpectedAccount(context.identity, { expectation, credentials });
  if (!account.allowed) {
    printAccountRefusal(action, account, context, { expectation, credentials });
    return undefined;
  }
  const assets = releaseAssetsDirectory(
    cacheDirectoryPath(context.env, context.home),
    context.release,
  );
  const assetsSha256 = await context.assets.materialize(assets);
  return {
    account,
    instancePath: loaded.path,
    instance: loaded.instance,
    configurationSha256: sha256Hex(new TextEncoder().encode(loaded.text)),
    credentials,
    release: context.release,
    assetsSha256,
    terraformDirectory: join(assets, "terraform"),
  };
}

/**
 * This release's Terraform tree, materialized from its assets in the cache, as `plan` and
 * `apply` use it, for a command that runs Terraform only on some paths (`worker terminate`'s
 * removal, `teardown`'s destroy).
 */
export async function terraformDirectory(context: CliContext): Promise<string> {
  const assets = releaseAssetsDirectory(
    cacheDirectoryPath(context.env, context.home),
    context.release,
  );
  await context.assets.materialize(assets);
  return join(assets, "terraform");
}

/** Prints a restyled report on `writer`, after the blank line that separates it from the header. */
export function printReport(writer: Writer, report: Report): void {
  writer("");
  for (const line of render(writer.style, report.blocks, report.next)) writer(line);
}

/** `report` with `notice` said after its blocks, before its Next block. */
export function withNotice(report: Report, notice: string | undefined): Report {
  if (notice === undefined) return report;
  return { ...report, blocks: [...report.blocks, { kind: "text", lines: [notice] }] };
}

/**
 * Prints why `action` was refused before anything changed, to standard error; its Next block
 * repeats the instance and profile in `selection`.
 */
export function printPlanRefusal(
  action: string,
  refusal: PlanRefusal,
  context: CliContext,
  selection: Selection,
): void {
  printReport(context.err, planRefusalReport(refusal, { action, now: context.now(), selection }));
}
