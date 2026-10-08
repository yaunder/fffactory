import type { AccountRequirement } from "../../application/require-expected-account";
import {
  describeSource,
  INSTANCE_ENVIRONMENT_VARIABLE,
  type InstanceResolution,
  resolveInstance,
} from "../../application/resolve-instance";
import { validateInstance } from "../../application/validate-instance";
import {
  type AccountExpectation,
  awsAccountCheck,
  type CredentialSelection,
} from "../../domain/aws-account";
import type { FactoryInstance, Issue } from "../../domain/instance";
import type { CliContext } from "../context";

type Found = Extract<InstanceResolution, { readonly found: true }>;

/**
 * Resolves the instance a command acts on and prints which it is, or prints why there is
 * none. The same precedence as every command: --instance, FFFACTORY_INSTANCE, the nearest
 * .fffactory/factory.json, then ~/.fffactory/factory.json.
 */
export async function selectInstance(
  flag: string | undefined,
  context: CliContext,
): Promise<Found | undefined> {
  const resolution = await resolveInstance(context.store, {
    flag,
    environment: context.env[INSTANCE_ENVIRONMENT_VARIABLE],
    cwd: context.cwd,
    home: context.home,
  });
  if (!resolution.found) {
    context.err(resolution.message);
    return undefined;
  }
  context.out(`Instance: ${resolution.path} (${describeSource(resolution.source)})`);
  return resolution;
}

/** Prints every issue by field path, under a heading, to standard error. */
export function printIssues(heading: string, issues: readonly Issue[], context: CliContext): void {
  context.err(heading);
  for (const issue of issues) context.err(`  ${issue.path}: ${issue.message}`);
}

export interface LoadedInstance {
  readonly path: string;
  readonly instance: FactoryInstance;
  /** factory.json's exact text, as validated. */
  readonly text: string;
}

/** Reads and validates the selected instance, printing why when it cannot be used. */
export async function validatedInstance(
  path: string,
  context: CliContext,
): Promise<LoadedInstance | undefined> {
  const validation = await validateInstance(context.store, path);
  if (validation.valid) return { path, instance: validation.instance, text: validation.text };
  printIssues("Invalid factory.json:", validation.issues, context);
  return undefined;
}

/** Selects, reads and validates the instance, printing why when it cannot be used. */
export async function loadInstance(
  flag: string | undefined,
  context: CliContext,
): Promise<LoadedInstance | undefined> {
  const selected = await selectInstance(flag, context);
  if (!selected) return undefined;
  return validatedInstance(selected.path, context);
}

/** Prints why the account check refused `action`, and what to do next. */
export function printAccountRefusal(
  action: string,
  requirement: Extract<AccountRequirement, { readonly allowed: false }>,
  context: CliContext,
  check: { readonly expectation: AccountExpectation; readonly credentials: CredentialSelection },
): void {
  const result = awsAccountCheck(requirement.verdict, check);
  context.err(`Refusing to ${action}: ${result.summary}`);
  for (const detail of result.details) context.err(`  ${detail}`);
  if (result.nextAction !== null) context.err(`Next: ${result.nextAction}`);
}
