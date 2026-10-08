import { parseArgs } from "node:util";
import {
  credentialSelection,
  PROFILE_ENVIRONMENT_VARIABLE,
} from "../../application/caller-identity";
import { type SetSecretResult, setSecret } from "../../application/set-secret";
import type { CredentialSelection } from "../../domain/aws-account";
import { MAX_SECRET_BYTES } from "../../domain/secrets";
import type { CliContext, Command } from "../context";
import { printAccountRefusal, printIssues, selectInstance } from "./selected-instance";

const USAGE = [
  "Usage: fffactory secret set NAME [--host KEY] [--instance PATH] [--profile NAME]",
  "",
  "Stores a secret in AWS Secrets Manager and puts only its ARN in factory.json.",
  "NAME is one of:",
  "  tailscale-auth-key   the factory's Tailscale enrollment key",
  "                       (tailscale.auth_key_secret)",
  "  paseo-password       a host's Paseo password, with --host KEY",
  "                       (hosts[].paseo_password_secret)",
  "",
  "The secret itself is never an argument. At a terminal it is asked for with a",
  "hidden prompt; otherwise it is read from standard input, without one final line",
  "ending, for example `fffactory secret set tailscale-auth-key < key.txt`. It",
  "goes straight to Secrets Manager in the factory's account and Region, as",
  "<factory ID>/tailscale-auth-key or <factory ID>/<host key>/paseo-password,",
  "tagged with the factory ID; setting it again stores a new value. It is never",
  "printed, logged or written to factory.json.",
  "",
  "Only the fffactory release factory.json pins may store a secret. Like every",
  "command that changes AWS, it first checks that the credentials belong to the",
  "factory's account.",
];

/** Arguments that do not parse may hold a pasted secret, so they are never echoed. */
const BAD_ARGUMENTS =
  "fffactory secret: expected `secret set NAME [--host KEY] [--instance PATH] [--profile NAME]`. " +
  "A secret is never taken as an argument: it is read from a hidden prompt or standard input.";

function parse(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      options: {
        instance: { type: "string" },
        profile: { type: "string" },
        host: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch {
    return undefined;
  }
}

const NO_MATERIAL: Readonly<Record<"cancelled" | "empty" | "too_large", string>> = {
  cancelled: "Cancelled: nothing was stored.",
  empty: "No secret was given: the answer or standard input was empty. Nothing was stored.",
  too_large: `The secret is larger than Secrets Manager's ${MAX_SECRET_BYTES}-byte limit. Nothing was stored.`,
};

const REFERENCE: Readonly<Record<"added" | "unchanged" | "replaced", string>> = {
  added: "now refers to it",
  unchanged: "already referred to it",
  replaced: "now refers to it, in place of its previous reference",
};

function report(result: SetSecretResult, credentials: CredentialSelection, context: CliContext) {
  switch (result.kind) {
    case "invalid":
      printIssues("Invalid factory.json:", result.issues, context);
      return 1;
    case "refused":
      context.err(`fffactory secret set: ${result.message}`);
      return 1;
    case "release_mismatch":
      context.err(`Refusing to store the secret: ${result.message}`);
      return 1;
    case "wrong_account":
      printAccountRefusal("store the secret", result.requirement, context, {
        expectation: result.expectation,
        credentials,
      });
      return 1;
    case "no_material":
      context.err(NO_MATERIAL[result.reason]);
      return 1;
    case "stored_unreferenced":
      context.err(
        `Stored the ${result.target.description} in Secrets Manager as ` +
          `${result.target.secretName}, but factory.json changed meanwhile and no longer ` +
          `takes the reference. Set ${result.target.field} to ${result.arn} yourself.`,
      );
      return 1;
    case "stored":
      context.out(
        `Stored the ${result.target.description} in Secrets Manager as ` +
          `${result.target.secretName} (${result.created ? "a new secret" : "a new value"}).`,
      );
      context.out(`${result.target.field} ${REFERENCE[result.reference]}: ${result.arn}`);
      return 0;
  }
}

async function secret(args: readonly string[], context: CliContext): Promise<number> {
  const parsed = parse(args);
  const [action, name, ...extra] = parsed?.positionals ?? [];
  if (parsed === undefined || action !== "set" || name === undefined || extra.length > 0) {
    context.err(BAD_ARGUMENTS);
    return 1;
  }
  const { values } = parsed;
  if (values.profile === "") {
    context.err("fffactory secret set: --profile needs a profile name");
    return 1;
  }
  const selected = await selectInstance(values.instance, context);
  if (!selected) return 1;
  const credentials = credentialSelection(
    values.profile,
    context.env[PROFILE_ENVIRONMENT_VARIABLE],
  );
  const result = await setSecret(
    {
      identity: context.identity,
      store: context.store,
      secrets: context.secrets,
      prompt: context.prompt,
    },
    { path: selected.path, name, host: values.host, credentials, release: context.release },
  );
  return report(result, credentials, context);
}

export const secretCommand: Command = {
  summary: "Store a secret in Secrets Manager, keeping only its ARN in factory.json",
  usage: USAGE,
  run: secret,
};
