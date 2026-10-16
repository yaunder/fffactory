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
import { lockRefusal } from "../../domain/factory-lock";
import { describeD11Refusal, describeStoppedResizeRefusal } from "../../domain/plan";
import { sha256Hex } from "../../infrastructure/release-tarball";
import type { CliContext } from "../context";
import {
  type LoadedInstance,
  loadInstance,
  printAccountRefusal,
  printIssues,
} from "./selected-instance";

export type PlanningBasis = Omit<FactoryPlanRequest, "now" | "randomBytes">;

/** The `--instance` and `--profile` a command was given, which the commands it names repeat. */
export interface SelectionFlags {
  readonly instance?: string;
  readonly profile?: string;
}

/** A word for a POSIX shell: as is when it is plainly safe, else single-quoted. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The command `words`, then the `--instance` and `--profile` given, quoted for a POSIX shell
 * where needed: the commands `plan` and `apply` name next repeat them.
 */
export function commandLine(words: readonly string[], flags: SelectionFlags): string {
  const all = [...words];
  if (flags.instance !== undefined) all.push("--instance", flags.instance);
  if (flags.profile !== undefined) all.push("--profile", flags.profile);
  return all.map(shellWord).join(" ");
}

/**
 * Loads factory.json and runs the account check, refusing (and saying why) unless the caller
 * is in the factory's account; then materializes this release's assets. `action` names what
 * is refused, such as `plan`.
 */
export async function planningBasis(
  action: string,
  flags: { readonly instance?: string; readonly profile?: string },
  context: CliContext,
): Promise<PlanningBasis | undefined> {
  const loaded = await loadInstance(flags.instance, context);
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

/** Why `action` was refused before anything changed, one line per element. */
function refusalLines(
  action: string,
  refusal: Exclude<PlanRefusal, { readonly kind: "refused" }>,
  now: Date,
): readonly string[] {
  switch (refusal.kind) {
    case "release_mismatch":
      return [`Refusing to ${action}: ${refusal.message}`];
    case "d11":
      return describeD11Refusal(refusal.refusal);
    case "stopped_resize":
      return describeStoppedResizeRefusal(action, refusal);
    case "unready":
      return refusal.refusal;
    case "unexpected_plan":
      return [
        `Refusing to ${action}: Terraform's plan is not one fffactory can apply:`,
        ...refusal.unexpected.map((reason) => `  ${reason}`),
      ];
    case "locked":
      return lockRefusal(refusal.held, now);
  }
}

/** Prints why `action` was refused before anything changed, to standard error. */
export function printPlanRefusal(action: string, refusal: PlanRefusal, context: CliContext): void {
  if (refusal.kind === "refused") {
    printIssues(`Refusing to ${action}: factory.json is not ready:`, refusal.issues, context);
    return;
  }
  for (const line of refusalLines(action, refusal, context.now())) context.err(line);
}
