import { parseArgs } from "node:util";
import {
  credentialSelection,
  PROFILE_ENVIRONMENT_VARIABLE,
} from "../../application/caller-identity";
import { breakFactoryLock, lockHolder, stateBucketOf } from "../../application/factory-lock";
import type { StateBucket } from "../../application/lock-store";
import {
  type AllowedAccount,
  requireExpectedAccount,
} from "../../application/require-expected-account";
import { accountExpectation } from "../../domain/aws-account";
import { describeHeldLock, type HeldLock } from "../../domain/factory-lock";
import type { CliContext, Command } from "../context";
import { loadInstance, printAccountRefusal, printIssues } from "./selected-instance";

const USAGE = [
  "Usage: fffactory lock break [--instance PATH] [--profile NAME] [--lock-id ID]",
  "",
  "Breaks the factory-wide lock that an operation left behind, such as an apply",
  "that was interrupted or whose machine went away. Every mutating operation holds",
  "this lock through all of its stages, so a second one is refused while it is",
  "held; break it only when you are sure its holder is no longer running.",
  "",
  "The command shows who holds the lock, for which operation and since when, and",
  "breaks it only when you confirm with its lock ID: typed at the prompt, or given",
  "with --lock-id ID when there is no terminal. A lock that changed since it was",
  "shown is never broken. Each break is logged in the state bucket, with the lock",
  "it removed and who broke it, before the lock is removed.",
  "",
  "Like every command that changes AWS, it first checks that the credentials",
  "belong to the factory's account.",
];

async function confirmation(
  lockId: string | undefined,
  context: CliContext,
): Promise<string | undefined> {
  if (lockId !== undefined) return lockId;
  if (!context.prompt.interactive) {
    context.err(
      "Breaking the lock needs confirmation: rerun at a terminal, or pass --lock-id ID with " +
        "the lock ID shown above.",
    );
    return undefined;
  }
  return (await context.prompt.ask("Type the lock ID shown above to break the lock: ")) ?? "";
}

async function breakShown(
  bucket: StateBucket,
  held: HeldLock,
  account: AllowedAccount,
  typed: string,
  context: CliContext,
): Promise<number> {
  const result = await breakFactoryLock(context.lockStore, {
    bucket,
    held,
    confirmation: typed,
    breaker: lockHolder(account, context.hostname),
    now: context.now(),
    release: context.release,
  });
  switch (result.kind) {
    case "not_confirmed":
      context.err("That is not the lock ID shown above; the lock is unchanged.");
      return 1;
    case "changed":
      context.err(
        "The lock changed after it was shown, so nothing was broken. Rerun " +
          "`fffactory lock break` to see the lock now in place.",
      );
      return 1;
    case "broken":
      context.out(`Broke the lock. The break is logged in the state bucket at ${result.logKey}.`);
      return 0;
  }
}

/**
 * Not guarded by the CLI/pin match guard: breaking the lock changes no factory state, and an
 * upgrade interrupted before it moved the pin leaves a lock that only its later release, not
 * the pinned one, is at hand to break. Confirming the lock ID is what guards it.
 */
async function breakLock(args: readonly string[], context: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      instance: { type: "string" },
      profile: { type: "string" },
      "lock-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.profile === "") {
    context.err("fffactory lock break: --profile needs a profile name");
    return 1;
  }
  const loaded = await loadInstance(values.instance, context);
  if (!loaded) return 1;
  const credentials = credentialSelection(
    values.profile,
    context.env[PROFILE_ENVIRONMENT_VARIABLE],
  );
  const location = stateBucketOf(loaded.instance, credentials);
  if (!location.ok) {
    printIssues(
      "Refusing to break the lock: factory.json cannot locate it:",
      location.issues,
      context,
    );
    return 1;
  }
  const expectation = accountExpectation(loaded.instance);
  const account = await requireExpectedAccount(context.identity, { expectation, credentials });
  if (!account.allowed) {
    printAccountRefusal("break the lock", account, context, { expectation, credentials });
    return 1;
  }
  const held = await context.lockStore.read(location.bucket);
  if (held === undefined) {
    context.out("The factory is not locked: there is nothing to break.");
    return 0;
  }
  context.out("The factory is locked:");
  for (const line of describeHeldLock(held, context.now())) context.out(`  ${line}`);
  const typed = await confirmation(values["lock-id"], context);
  if (typed === undefined) return 1;
  return breakShown(location.bucket, held, account, typed, context);
}

async function lock(args: readonly string[], context: CliContext): Promise<number> {
  const [action, ...rest] = args;
  if (action === "break") return breakLock(rest, context);
  context.err("fffactory lock: expected a subcommand: break");
  for (const line of USAGE) context.err(line);
  return 1;
}

export const lockCommand: Command = {
  summary: "Break a factory-wide lock left by an interrupted operation, after confirmation",
  usage: USAGE,
  run: lock,
};
