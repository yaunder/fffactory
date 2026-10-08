import { describe, expect, test } from "bun:test";
import type { OperatorPrompt } from "../../src/application/operator-prompt";
import { run } from "../../src/cli/run";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { FactoryId, Release } from "../../src/domain/instance";
import { harness, TEST_HOSTNAME } from "../support/cli-harness";
import { FAKE_CALLER, fakeCallerIdentity } from "../support/doctor-fakes";
import { fakePrompt } from "../support/fake-secrets";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { MemoryLockStore } from "../support/memory-lock-store";

const PATH = "/work/repo/.fffactory/factory.json";
const BUCKET = "fff-abcd1234-state";
const DOCUMENT = {
  schema_version: 1,
  factory_id: "fff-abcd1234",
  aws: { account_id: "123456789012", region: "eu-west-2" },
  state_backend: { bucket: BUCKET },
};
const HOLDER = {
  principal: "arn:aws:sts::123456789012:assumed-role/Admin/gone",
  host: "old-laptop",
};
const RECORD = newLockRecord({
  factoryId: "fff-abcd1234" as FactoryId,
  operation: "apply",
  holder: HOLDER,
  now: new Date("2026-09-30T11:00:00.000Z"),
  release: "0.3.0" as Release,
  randomBytes: (count) => new Uint8Array(count).fill(10),
});
const LOCK_ID = RECORD.lock_id;

function setup(
  options: {
    document?: object;
    locked?: boolean;
    prompt?: OperatorPrompt;
    identity?: ReturnType<typeof fakeCallerIdentity>;
  } = {},
) {
  const store = new MemoryInstanceStore({
    [PATH]: JSON.stringify(options.document ?? DOCUMENT),
  });
  const lockStore = new MemoryLockStore([BUCKET]);
  const held = options.locked === false ? undefined : lockStore.hold(BUCKET, RECORD);
  const identity = options.identity ?? fakeCallerIdentity();
  const cli = harness(
    store,
    {},
    {
      lockStore,
      identity: identity.identity,
      ...(options.prompt ? { prompt: options.prompt } : {}),
    },
  );
  return { ...cli, lockStore, held, identity };
}

describe("fffactory lock break", () => {
  test("says so when the factory is not locked", async () => {
    const { context, out, lockStore } = setup({ locked: false });
    expect(await run(["lock", "break"], context)).toBe(0);
    expect(out).toEqual([
      `Instance: ${PATH} (nearest .fffactory/factory.json)`,
      "The factory is not locked: there is nothing to break.",
    ]);
    expect(lockStore.logs.size).toBe(0);
  });

  test("without a terminal or --lock-id, shows the holder and breaks nothing", async () => {
    const { context, out, err, lockStore, held } = setup();
    expect(await run(["lock", "break"], context)).toBe(1);
    expect(out).toEqual([
      `Instance: ${PATH} (nearest .fffactory/factory.json)`,
      "The factory is locked:",
      `  Lock ${LOCK_ID}: apply by ${HOLDER.principal} on old-laptop`,
      "  Acquired 2026-09-30T11:00:00.000Z (1 h 0 min ago) by fffactory 0.3.0",
    ]);
    expect(err).toEqual([
      "Breaking the lock needs confirmation: rerun at a terminal, or pass --lock-id ID with the lock ID shown above.",
    ]);
    expect(lockStore.locks.get(BUCKET)).toBe(held);
    expect(lockStore.logs.size).toBe(0);
  });

  // Not guarded by the CLI/pin match guard (plan-apply §CLI/pin match guard): an upgrade
  // interrupted before it moved the pin leaves a lock that only its newer release may hold.
  test.each([
    ["an earlier", "0.2.0"],
    ["a later", "0.4.0"],
  ])("breaks the lock when factory.json pins %s release than this one", async (_, release) => {
    const { context, lockStore } = setup({ document: { ...DOCUMENT, release } });
    expect(await run(["lock", "break", "--lock-id", LOCK_ID], context)).toBe(0);
    expect(lockStore.locks.size).toBe(0);
    expect(lockStore.logs.size).toBe(1);
  });

  test("a wrong --lock-id breaks nothing", async () => {
    const { context, err, lockStore, held } = setup();
    expect(await run(["lock", "break", "--lock-id", "aaaaaaaa"], context)).toBe(1);
    expect(err).toEqual(["That is not the lock ID shown above; the lock is unchanged."]);
    expect(lockStore.locks.get(BUCKET)).toBe(held);
    expect(lockStore.logs.size).toBe(0);
  });

  test("the right --lock-id breaks the lock and logs who broke it", async () => {
    const { context, out, lockStore, held } = setup();
    expect(await run(["lock", "break", "--lock-id", LOCK_ID], context)).toBe(0);
    const key = `fff-abcd1234-lock-log/2026-09-30T12:00:00.000Z-broken-${LOCK_ID}.json`;
    expect(out.at(-1)).toBe(`Broke the lock. The break is logged in the state bucket at ${key}.`);
    expect(lockStore.locks.has(BUCKET)).toBe(false);
    expect(lockStore.logs.get(key)).toMatchObject({
      event: "broken",
      lock_version: held?.version,
      lock: RECORD,
      broken_by: { principal: FAKE_CALLER.arn, host: TEST_HOSTNAME },
      broken_at: "2026-09-30T12:00:00.000Z",
    });
  });

  test("at a terminal, breaks only when the lock ID is typed", async () => {
    const typed = fakePrompt({ interactive: true, answers: [LOCK_ID] });
    const confirmed = setup({ prompt: typed.prompt });
    expect(await run(["lock", "break"], confirmed.context)).toBe(0);
    expect(typed.asked).toEqual(["Type the lock ID shown above to break the lock: "]);
    expect(confirmed.lockStore.locks.has(BUCKET)).toBe(false);

    for (const answer of ["yes", undefined]) {
      const declined = setup({
        prompt: fakePrompt({ interactive: true, answers: [answer] }).prompt,
      });
      expect(await run(["lock", "break"], declined.context)).toBe(1);
      expect(declined.lockStore.locks.get(BUCKET)).toBe(declined.held);
      expect(declined.lockStore.logs.size).toBe(0);
    }
  });

  test("a lock replaced while the operator confirmed is never broken", async () => {
    let lockStore: MemoryLockStore | undefined;
    const prompt: OperatorPrompt = {
      ...fakePrompt({ interactive: true }).prompt,
      ask: async () => {
        lockStore?.locks.delete(BUCKET);
        lockStore?.hold(BUCKET, { ...RECORD, lock_id: "bbbbbbbb" });
        return LOCK_ID;
      },
    };
    const cli = setup({ prompt });
    lockStore = cli.lockStore;
    expect(await run(["lock", "break"], cli.context)).toBe(1);
    expect(cli.err).toEqual([
      "The lock changed after it was shown, so nothing was broken. Rerun `fffactory lock break` to see the lock now in place.",
    ]);
    expect(cli.lockStore.locks.get(BUCKET)?.record?.lock_id).toBe("bbbbbbbb");
  });

  test("refuses another account before reading the lock", async () => {
    const identity = fakeCallerIdentity({
      kind: "caller",
      caller: { ...FAKE_CALLER, account: "210987654321" },
    });
    const { context, err, lockStore } = setup({ identity });
    expect(await run(["lock", "break", "--lock-id", LOCK_ID], context)).toBe(1);
    expect(err[0]).toBe(
      "Refusing to break the lock: Account 210987654321 is not the factory's account 123456789012",
    );
    expect(err.at(-1)).toStartWith("Next: Select credentials for account 123456789012");
    expect(lockStore.calls).toEqual([]);
  });

  test("refuses a factory.json that cannot locate the lock", async () => {
    const { context, err, identity } = setup({ document: { schema_version: 1 } });
    expect(await run(["lock", "break"], context)).toBe(1);
    expect(err).toEqual([
      "Refusing to break the lock: factory.json cannot locate it:",
      "  factory_id: is required to reach the state bucket",
      "  aws.account_id: is required to reach the state bucket",
      "  aws.region: is required to reach the state bucket",
      "  state_backend.bucket: is required to reach the state bucket",
    ]);
    expect(identity.requests).toEqual([]);
  });

  test("refuses an invalid factory.json", async () => {
    const { context, err } = setup({ document: { schema_version: 2 } });
    expect(await run(["lock", "break"], context)).toBe(1);
    expect(err[0]).toBe("Invalid factory.json:");
  });

  test("refuses when there is no instance", async () => {
    const { context, err } = harness(new MemoryInstanceStore());
    expect(await run(["lock", "break"], context)).toBe(1);
    expect(err.join("\n")).toContain("fffactory init");
  });

  test("uses the selected profile", async () => {
    const { context, identity } = setup();
    await run(["lock", "break", "--profile", "factory", "--lock-id", LOCK_ID], context);
    expect(identity.requests).toEqual([
      { credentials: { source: "--profile", profile: "factory" }, region: "eu-west-2" },
    ]);
  });

  test("rejects an empty --profile", async () => {
    const { context, err } = setup();
    expect(await run(["lock", "break", "--profile", ""], context)).toBe(1);
    expect(err).toEqual(["fffactory lock break: --profile needs a profile name"]);
  });

  test("needs its subcommand", async () => {
    const { context, err } = setup();
    expect(await run(["lock"], context)).toBe(1);
    expect(err[0]).toBe("fffactory lock: expected a subcommand: break");
    expect(err).toContain(
      "Usage: fffactory lock break [--instance PATH] [--profile NAME] [--lock-id ID]",
    );
  });

  test("is listed in the command usage and prints its own usage", async () => {
    const { context, out } = setup();
    expect(await run(["--help"], context)).toBe(0);
    expect(out.some((line) => line.startsWith("  lock "))).toBe(true);
    const help = setup();
    expect(await run(["lock", "--help"], help.context)).toBe(0);
    expect(help.out[0]).toBe(
      "Usage: fffactory lock break [--instance PATH] [--profile NAME] [--lock-id ID]",
    );
  });
});
