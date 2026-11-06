import { describe, expect, test } from "bun:test";
import {
  deleteOwnedSecret,
  SECRET_DELETION_DEADLINE_MS,
  SECRET_DELETION_POLL_MS,
} from "../../src/application/delete-owned-secret";
import type { SecretLookup, SecretPresence, SecretStore } from "../../src/application/secret-store";
import type { FactoryId, SecretReference } from "../../src/domain/instance";
import { classifySecrets, type OwnedSecret } from "../../src/domain/secrets";
import { fakeSecretStore } from "../support/fake-secrets";
import { fakeTime } from "../support/fake-workers";

const ID = "fff-abcd1234" as FactoryId;
const NAME = "fff-abcd1234/github-token";
const ARN =
  `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${NAME}-AbCdEf` as SecretReference;
const START = new Date("2026-10-21T12:00:00Z");
const PRESENT: SecretPresence = { kind: "present" };
const ABSENT: SecretPresence = { kind: "absent" };

/** An owned secret, made as only the classification makes one. */
function owned(pendingDeletion = false, arn = ARN): OwnedSecret {
  const [secret] = classifySecrets(
    ID,
    [
      {
        name: NAME,
        arn,
        tags: { "fffactory:factory-id": ID, "fffactory:managed-by": "fffactory" },
        pendingDeletion,
      },
    ],
    [],
  ).owned;
  if (secret === undefined) throw new Error("not owned");
  return secret;
}

function setup(options: Parameters<typeof fakeSecretStore>[0] = {}, interruptAfter?: number) {
  const secrets = fakeSecretStore(options);
  let interrupted = false;
  const time = fakeTime(START, (sleeps) => {
    if (sleeps === interruptAfter) interrupted = true;
  });
  const deps = {
    secrets: secrets.store,
    clock: time.clock,
    sleep: time.sleep,
    interrupted: () => interrupted,
  };
  return { deps, secrets, time };
}

/**
 * `setup`, whose interrupt lands while the `nth` call of `operation` is in flight, as Ctrl-C
 * during a Secrets Manager request: the call still completes and answers.
 */
function interruptedDuring(
  options: Parameters<typeof fakeSecretStore>[0],
  operation: "restore" | "remove",
  nth = 1,
) {
  const { deps, secrets } = setup(options);
  let interrupted = false;
  let calls = 0;
  const landing = (called: string) => {
    if (called === operation && ++calls === nth) interrupted = true;
  };
  const store: SecretStore = {
    ...secrets.store,
    restore: async (lookup: SecretLookup) => {
      landing("restore");
      return secrets.store.restore(lookup);
    },
    remove: async (lookup: SecretLookup) => {
      landing("remove");
      return secrets.store.remove(lookup);
    },
  };
  return { deps: { ...deps, secrets: store, interrupted: () => interrupted }, secrets };
}

const REQUEST = { credentials: { source: "chain" } } as const;
const LOOKUP = { reference: ARN, region: "eu-west-2", ...REQUEST } as const;

describe("deleteOwnedSecret (secrets §Deleting a factory's secrets)", () => {
  test("deleted without a recovery window and absent at once", async () => {
    const { deps, secrets, time } = setup();
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
      kind: "absent",
    });
    expect(secrets.calls).toEqual([`remove ${ARN}`, `exists ${ARN}`]);
    expect(secrets.lookups).toEqual([LOOKUP, LOOKUP]);
    expect(time.sleeps).toEqual([]);
  });

  test("asks about the secret in the Region its ARN names, and no other", async () => {
    const arn = ARN.replace("eu-west-2", "us-east-1") as SecretReference;
    const { deps, secrets } = setup({ presence: [PRESENT, ABSENT] });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned(true, arn) })).toEqual({
      kind: "absent",
    });
    expect(secrets.lookups).toHaveLength(4);
    expect(secrets.lookups).toEqual(
      Array(4).fill({ reference: arn, region: "us-east-1", ...REQUEST }),
    );
  });

  test("absent after polling while Secrets Manager still finds it", async () => {
    const { deps, secrets, time } = setup({ presence: [PRESENT, PRESENT, PRESENT, ABSENT] });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
      kind: "absent",
    });
    expect(secrets.calls).toEqual([
      `remove ${ARN}`,
      `exists ${ARN}`,
      `exists ${ARN}`,
      `exists ${ARN}`,
      `exists ${ARN}`,
    ]);
    expect(time.sleeps).toEqual([
      SECRET_DELETION_POLL_MS,
      SECRET_DELETION_POLL_MS,
      SECRET_DELETION_POLL_MS,
    ]);
  });

  test("a secret pending deletion is restored, then deleted, and ends absent", async () => {
    const { deps, secrets } = setup({ presence: [PRESENT, ABSENT] });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned(true) })).toEqual({
      kind: "absent",
    });
    expect(secrets.calls).toEqual([
      `restore ${ARN}`,
      `remove ${ARN}`,
      `exists ${ARN}`,
      `exists ${ARN}`,
    ]);
  });

  test("a pending secret already gone when restored is only confirmed absent", async () => {
    const { deps, secrets } = setup({ restored: { kind: "absent" } });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned(true) })).toEqual({
      kind: "absent",
    });
    expect(secrets.calls).toEqual([`restore ${ARN}`, `exists ${ARN}`]);
  });

  test("a secret already gone when deleted is confirmed absent", async () => {
    const { deps, secrets } = setup({ removed: { kind: "absent" } });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
      kind: "absent",
    });
    expect(secrets.calls).toEqual([`remove ${ARN}`, `exists ${ARN}`]);
  });

  test("a restore refused remains, by the error's name, and is never deleted", async () => {
    const reason = "Secrets Manager RestoreSecret failed: AccessDeniedException";
    const { deps, secrets } = setup({ restored: { kind: "failed", reason } });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned(true) })).toEqual({
      kind: "remains",
      reason,
    });
    expect(secrets.calls).toEqual([`restore ${ARN}`]);
  });

  test("AccessDenied on the deletion remains, with only the error's name", async () => {
    const reason = "Secrets Manager DeleteSecret failed: AccessDeniedException";
    const { deps, secrets } = setup({ removed: { kind: "failed", reason } });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
      kind: "remains",
      reason,
    });
    expect(secrets.calls).toEqual([`remove ${ARN}`]);
  });

  describe("a secret scheduled for deletion after it was listed", () => {
    const reason = "Secrets Manager DeleteSecret failed: InvalidRequestException";
    const INVALID = { kind: "invalid", reason } as const;

    test("is restored once, deleted again, and ends absent", async () => {
      const { deps, secrets } = setup({ removed: [INVALID, { kind: "done" }] });
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
        kind: "absent",
      });
      expect(secrets.calls).toEqual([
        `remove ${ARN}`,
        `restore ${ARN}`,
        `remove ${ARN}`,
        `exists ${ARN}`,
      ]);
    });

    test("refused again after the restore: remains, with only the error's name", async () => {
      const { deps, secrets } = setup({ removed: INVALID });
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
        kind: "remains",
        reason,
      });
      expect(secrets.calls).toEqual([`remove ${ARN}`, `restore ${ARN}`, `remove ${ARN}`]);
    });

    test("a restore refused remains, and is never deleted again", async () => {
      const denied = "Secrets Manager RestoreSecret failed: AccessDeniedException";
      const { deps, secrets } = setup({
        removed: INVALID,
        restored: { kind: "failed", reason: denied },
      });
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
        kind: "remains",
        reason: denied,
      });
      expect(secrets.calls).toEqual([`remove ${ARN}`, `restore ${ARN}`]);
    });

    test("gone when restored: only confirmed absent", async () => {
      const { deps, secrets } = setup({ removed: INVALID, restored: { kind: "absent" } });
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
        kind: "absent",
      });
      expect(secrets.calls).toEqual([`remove ${ARN}`, `restore ${ARN}`, `exists ${ARN}`]);
    });

    test("a secret listed as pending is restored only once", async () => {
      const { deps, secrets } = setup({ removed: INVALID });
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned(true) })).toEqual({
        kind: "remains",
        reason,
      });
      expect(secrets.calls).toEqual([`restore ${ARN}`, `remove ${ARN}`]);
    });
  });

  test("a deletion timed out remains: it is no proof of deletion", async () => {
    const reason = "Secrets Manager DeleteSecret failed: timed out after 30 s";
    const { deps } = setup({ removed: { kind: "failed", reason } });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
      kind: "remains",
      reason,
    });
  });

  test("a look that fails remains: AccessDenied on DescribeSecret is not absence", async () => {
    const reason = "Secrets Manager DescribeSecret failed: AccessDeniedException";
    const { deps } = setup({ presence: [PRESENT, { kind: "failed", reason }] });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
      kind: "remains",
      reason,
    });
  });

  test("still found when the deadline passes: remains", async () => {
    const { deps, secrets, time } = setup({ presence: [PRESENT] });
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
      kind: "remains",
      reason: `Secrets Manager still finds it ${SECRET_DELETION_DEADLINE_MS / 1000} s after its deletion`,
    });
    const polls = SECRET_DELETION_DEADLINE_MS / SECRET_DELETION_POLL_MS;
    expect(time.sleeps).toHaveLength(polls);
    expect(secrets.calls.filter((call) => call.startsWith("exists"))).toHaveLength(polls + 1);
  });

  test("a deadline given in place of the default, and a clock that stalls, still end the wait", async () => {
    const secrets = fakeSecretStore({ presence: [PRESENT] });
    const sleeps: number[] = [];
    const deps = {
      secrets: secrets.store,
      clock: () => START,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      interrupted: () => false,
    };
    const result = await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() }, 6_000);
    expect(result).toEqual({
      kind: "remains",
      reason: "Secrets Manager still finds it 6 s after its deletion",
    });
    expect(sleeps).toEqual([
      SECRET_DELETION_POLL_MS,
      SECRET_DELETION_POLL_MS,
      SECRET_DELETION_POLL_MS,
    ]);
  });

  test("an interrupt while waiting ends the wait: the secret remains unconfirmed", async () => {
    const { deps, secrets, time } = setup({ presence: [PRESENT] }, 2);
    expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
      kind: "remains",
      reason: "interrupted before its absence was confirmed",
    });
    expect(time.sleeps).toHaveLength(2);
    expect(secrets.calls.filter((call) => call.startsWith("exists"))).toHaveLength(2);
  });

  describe("an interrupt starts no further Secrets Manager call (teardown §Interruption)", () => {
    const reason = "Secrets Manager DeleteSecret failed: InvalidRequestException";
    const INVALID = { kind: "invalid", reason } as const;
    const UNCONFIRMED = "interrupted before its absence was confirmed";
    const RESTORED = "interrupted once restored, before its deletion: no longer pending deletion";

    test.each([false, true])(
      "interrupted before it starts (pending: %p), nothing is asked",
      async (pending) => {
        const { deps, secrets } = setup();
        const result = await deleteOwnedSecret(
          { ...deps, interrupted: () => true },
          { ...REQUEST, secret: owned(pending) },
        );
        expect(result).toEqual({
          kind: "remains",
          reason: "interrupted before its deletion started",
        });
        expect(secrets.calls).toEqual([]);
      },
    );

    test("during the restore of a pending secret: restored, never deleted", async () => {
      const { deps, secrets } = interruptedDuring({}, "restore");
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned(true) })).toEqual({
        kind: "remains",
        reason: RESTORED,
      });
      expect(secrets.calls).toEqual([`restore ${ARN}`]);
    });

    test("during a restore that finds it gone: never looked for", async () => {
      const { deps, secrets } = interruptedDuring({ restored: { kind: "absent" } }, "restore");
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned(true) })).toEqual({
        kind: "remains",
        reason: UNCONFIRMED,
      });
      expect(secrets.calls).toEqual([`restore ${ARN}`]);
    });

    test("during the deletion: never looked for", async () => {
      const { deps, secrets } = interruptedDuring({}, "remove");
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
        kind: "remains",
        reason: UNCONFIRMED,
      });
      expect(secrets.calls).toEqual([`remove ${ARN}`]);
    });

    test("during a deletion refused as invalid: never restored", async () => {
      const { deps, secrets } = interruptedDuring({ removed: INVALID }, "remove");
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
        kind: "remains",
        reason:
          "interrupted once its deletion was refused, before its restore: it may be pending deletion",
      });
      expect(secrets.calls).toEqual([`remove ${ARN}`]);
    });

    test("during the restore before the retry: restored, never deleted again", async () => {
      const { deps, secrets } = interruptedDuring({ removed: INVALID }, "restore");
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
        kind: "remains",
        reason: RESTORED,
      });
      expect(secrets.calls).toEqual([`remove ${ARN}`, `restore ${ARN}`]);
    });

    test("during the retried deletion: never looked for", async () => {
      const { deps, secrets } = interruptedDuring(
        { removed: [INVALID, { kind: "done" }] },
        "remove",
        2,
      );
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
        kind: "remains",
        reason: UNCONFIRMED,
      });
      expect(secrets.calls).toEqual([`remove ${ARN}`, `restore ${ARN}`, `remove ${ARN}`]);
    });

    test("a call that fails as the interrupt lands remains by its failure", async () => {
      const denied = "Secrets Manager DeleteSecret failed: AccessDeniedException";
      const { deps, secrets } = interruptedDuring(
        { removed: { kind: "failed", reason: denied } },
        "remove",
      );
      expect(await deleteOwnedSecret(deps, { ...REQUEST, secret: owned() })).toEqual({
        kind: "remains",
        reason: denied,
      });
      expect(secrets.calls).toEqual([`remove ${ARN}`]);
    });
  });

  test("the deadline and poll", () => {
    expect(SECRET_DELETION_DEADLINE_MS).toBe(60_000);
    expect(SECRET_DELETION_POLL_MS).toBe(2_000);
  });
});
