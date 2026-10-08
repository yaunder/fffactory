/**
 * `fffactory secret set`: guided secret entry. The material is read from a hidden prompt at
 * a terminal, or from standard input otherwise, never from a command argument. It goes
 * straight to Secrets Manager in the factory's account and Region, and factory.json keeps
 * only the resulting ARN. Like every command that changes the factory, only the release
 * factory.json pins may run it (the CLI/pin match guard).
 */
import {
  type AccountExpectation,
  accountExpectation,
  type CredentialSelection,
} from "../domain/aws-account";
import type { Issue, Release, SecretReference } from "../domain/instance";
import { serializeInstance } from "../domain/instance";
import { pinRefusal } from "../domain/plan";
import {
  MAX_SECRET_BYTES,
  type MaterialRead,
  readSecretMaterial,
  resolveSecretTarget,
  type SecretTarget,
  secretReference,
  secretTags,
  withSecretReference,
} from "../domain/secrets";
import type { CallerIdentity } from "./caller-identity";
import type { InstanceStore } from "./instance-store";
import type { OperatorPrompt } from "./operator-prompt";
import { type AccountRequirement, requireExpectedAccount } from "./require-expected-account";
import type { SecretStore } from "./secret-store";
import { validateInstance } from "./validate-instance";

export interface SetSecretDependencies {
  readonly identity: CallerIdentity;
  readonly store: InstanceStore;
  readonly secrets: SecretStore;
  readonly prompt: OperatorPrompt;
}

export interface SetSecretRequest {
  /** The resolved factory.json. */
  readonly path: string;
  /** The secret's name as the operator gave it, such as `tailscale-auth-key`. */
  readonly name: string;
  /** `--host KEY`, for a host's secret. */
  readonly host: string | undefined;
  readonly credentials: CredentialSelection;
  /** The running fffactory's release, which must be the one factory.json pins. */
  readonly release: Release;
}

export type SetSecretResult =
  | { readonly kind: "invalid"; readonly issues: readonly Issue[] }
  | { readonly kind: "refused"; readonly message: string }
  /** The CLI/pin match guard: this fffactory is not the release factory.json pins. */
  | { readonly kind: "release_mismatch"; readonly message: string }
  | {
      readonly kind: "wrong_account";
      readonly requirement: Extract<AccountRequirement, { readonly allowed: false }>;
      readonly expectation: AccountExpectation;
    }
  | { readonly kind: "no_material"; readonly reason: "cancelled" | "empty" | "too_large" }
  | {
      readonly kind: "stored";
      readonly target: SecretTarget;
      readonly arn: SecretReference;
      readonly created: boolean;
      /** What happened to the factory.json field. */
      readonly reference: "added" | "unchanged" | "replaced";
    }
  /** Stored, but factory.json changed meanwhile and can no longer take the reference. */
  | {
      readonly kind: "stored_unreferenced";
      readonly target: SecretTarget;
      readonly arn: SecretReference;
      readonly created: boolean;
    };

type Material = MaterialRead | { readonly ok: false; readonly reason: "cancelled" };

/** Standard input may end with one line ending beyond the secret itself. */
const INPUT_LIMIT = MAX_SECRET_BYTES + 2;

async function readMaterial(prompt: OperatorPrompt, target: SecretTarget): Promise<Material> {
  if (prompt.interactive) {
    const answer = await prompt.askHidden(`${target.description} (input is hidden): `);
    return answer === undefined
      ? { ok: false, reason: "cancelled" }
      : readSecretMaterial(answer, "prompt");
  }
  const input = await prompt.readInput(INPUT_LIMIT);
  return input === undefined
    ? { ok: false, reason: "too_large" }
    : readSecretMaterial(input, "input");
}

/** Points factory.json at the stored secret, if it is still valid and still names the target. */
async function reference(
  store: InstanceStore,
  request: SetSecretRequest,
  arn: SecretReference,
): Promise<"added" | "unchanged" | "replaced" | undefined> {
  const current = await validateInstance(store, request.path);
  if (!current.valid) return undefined;
  const target = resolveSecretTarget(current.instance, request.name, request.host);
  if (!target.ok) return undefined;
  const previous = secretReference(current.instance, target.target);
  if (previous === arn) return "unchanged";
  const updated = withSecretReference(current.instance, target.target, arn);
  await store.write(request.path, serializeInstance(updated));
  return previous === undefined ? "added" : "replaced";
}

export async function setSecret(
  deps: SetSecretDependencies,
  request: SetSecretRequest,
): Promise<SetSecretResult> {
  const validation = await validateInstance(deps.store, request.path);
  if (!validation.valid) return { kind: "invalid", issues: validation.issues };
  const { instance } = validation;
  const mismatch = pinRefusal(instance.release, request.release);
  if (mismatch !== undefined) return { kind: "release_mismatch", message: mismatch };
  const resolution = resolveSecretTarget(instance, request.name, request.host);
  if (!resolution.ok) return { kind: "refused", message: resolution.message };
  const { target } = resolution;
  const region = instance.aws?.region;
  if (region === undefined)
    return {
      kind: "refused",
      message: "factory.json needs aws.region: secrets are stored in the factory Region",
    };
  const expectation = accountExpectation(instance);
  const requirement = await requireExpectedAccount(deps.identity, {
    expectation,
    credentials: request.credentials,
  });
  if (!requirement.allowed) return { kind: "wrong_account", requirement, expectation };

  const material = await readMaterial(deps.prompt, target);
  if (!material.ok) return { kind: "no_material", reason: material.reason };
  const stored = await deps.secrets.write({
    name: target.secretName,
    description: target.description,
    tags: secretTags(target.factoryId),
    material: material.material,
    region,
    credentials: request.credentials,
  });
  const outcome = await reference(deps.store, request, stored.arn);
  if (outcome === undefined)
    return { kind: "stored_unreferenced", target, arn: stored.arn, created: stored.created };
  return { kind: "stored", target, arn: stored.arn, created: stored.created, reference: outcome };
}
