import { describe, expect, test } from "bun:test";
import { run } from "../../src/cli/run";
import type { Release } from "../../src/domain/instance";
import type { ReleaseCompatibility } from "../../src/domain/release-compatibility";
import { newLockRecord } from "../../src/domain/factory-lock";
import { harness, TEST_NOW } from "../support/cli-harness";
import { fakeCallerIdentity } from "../support/doctor-fakes";
import { BUCKET, declaring, FACTORY, workerFleet } from "../support/factory-world";
import { fakeFactoryWorld } from "../support/fake-provisioner";
import { fakePrompt } from "../support/fake-secrets";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { MemoryLockStore } from "../support/memory-lock-store";
import { MemoryPlanStore } from "../support/memory-plan-store";

const PATH = "/work/repo/.fffactory/factory.json";
/** What `fffactory upgrade` prints first: its release, and the instance it acts on. */
const HEADER = [
  "fffactory upgrade · release 0.3.0",
  `Instance  ${PATH} (nearest .fffactory/factory.json)`,
];
/** A section's rule line, 53 columns wide. */
const rule = (title: string) => `── ${title} ${"─".repeat(Math.max(2, 49 - title.length))}`;
const NEXT = rule("Next");
const NOT_MOVED = "factory.json's pin was not moved: it still pins the release it pinned.";
const RESULT = rule("Result");
const RECORD_LINE =
  /^ {4}Operation record {3}s3:\/\/fff-abcd1234-state\/fff-abcd1234-operations\/.+\.json$/;
const QUESTION = 'Move the pin and apply this plan? Only "yes" does: ';
const COMPATIBLE: ReleaseCompatibility = {
  schema_version: 1,
  base_generation: 1,
  base_generation_since: "0.0.0" as Release,
};

function text(release: string | undefined, overrides: object = {}): string {
  return `${JSON.stringify({ ...declaring("builder-1"), release, ...overrides }, null, 2)}\n`;
}

/** The CLI over a provisioned factory whose factory.json pins `pin`; the CLI is 0.3.0. */
function cli(
  options: {
    pin?: string;
    document?: string;
    answers?: (string | undefined)[];
    interactive?: boolean;
    compatibility?: ReleaseCompatibility;
    bucket?: boolean;
  } = {},
) {
  const store = new MemoryInstanceStore({
    [PATH]: options.document ?? text("pin" in options ? options.pin : "0.2.0"),
  });
  const lockStore = new MemoryLockStore(options.bucket === false ? [] : [BUCKET]);
  const terraform = fakeFactoryWorld({ store: lockStore, bucket: BUCKET, hosts: ["builder-1"] });
  lockStore.states.set(BUCKET, "revision-0");
  const prompt = fakePrompt({
    interactive: options.interactive ?? true,
    answers: options.answers ?? ["yes"],
  });
  const identity = fakeCallerIdentity();
  const fleet = workerFleet();
  const context = harness(
    store,
    {},
    {
      lockStore,
      provisioner: terraform.provisioner,
      planStore: new MemoryPlanStore(),
      prompt: prompt.prompt,
      identity: identity.identity,
      tailnet: fleet.deps.peers,
      transport: fleet.deps.transport,
      compatibility: options.compatibility ?? COMPATIBLE,
    },
  );
  const pin = () => JSON.parse(store.files[PATH] ?? "{}").release;
  return { ...context, store, lockStore, terraform, prompt, identity, pin };
}

describe("fffactory upgrade (plan-apply §Upgrade)", () => {
  test("previews the pin move with the plan for this release, then pins and applies it once approved", async () => {
    const { context, out, err, prompt, pin, lockStore } = cli();
    expect(await run(["upgrade"], context)).toBe(0);
    expect(err).toEqual([]);
    // The plan shows every stage it approves, control plane and dispatch included; that upgrade
    // then skips them is #11's, not this presentation's (below).
    expect(out.slice(0, 20)).toEqual([
      ...HEADER,
      "",
      rule("Plan"),
      "  Factory   Test factory (fff-abcd1234)",
      "  Account   123456789012 · eu-west-2",
      "  Release   0.3.0",
      "  Pin       factory.json's release pin moves from 0.2.0 to 0.3.0, written once you approve " +
        "this plan, before anything is applied",
      "",
      "  Infrastructure   no changes",
      "  Workers          one at a time",
      "    ~ builder-1   install release 0.3.0 and host configuration, then verify",
      "  Control plane    before worker activation",
      "    ~ builder-1   paseo-package, service-definition, listen-address, password",
      "  Repositories     one worker at a time",
      "    ~ builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
      "  Dispatch         after every readiness gate",
      "    ~ builder-1   remove the factory dispatch schedule if it exists",
      "  Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule",
      "",
    ]);
    // The pin is written first, then the worker installs: the Applying section says so as it
    // happens, the Result and its Next block follow.
    // TODO(re-evaluate when #11 lands): expect the Result's control-plane, dispatch and
    // verification rows too: upgrade does not run those stages yet, so the Result has none.
    expect(out.slice(20, 33)).toEqual([
      "",
      rule("Applying"),
      "  Pin         factory.json now pins release 0.3.0",
      "  builder-1   uploading 0.0 MiB",
      "  builder-1   installing and verifying (can take many minutes)",
      "",
      RESULT,
      "    Infrastructure     no changes",
      "  ! builder-1          installed and verified · enrollment pending (3)",
      "    ✔ Repositories    synchronized",
      expect.stringMatching(RECORD_LINE),
      "",
      rule("Next: enroll 3 accounts on builder-1"),
    ]);
    expect(out.slice(-6)).toEqual([
      "    $ exit",
      "  Refresh enrollment verification, reviewing the new plan:",
      "    $ fffactory apply",
      "  Then confirm:",
      "    $ fffactory status",
      "  Paseo clients: enrollment is checked from each client, not the worker",
    ]);
    expect(prompt.asked).toEqual([QUESTION]);
    expect(pin()).toBe("0.3.0");
    expect(lockStore.operationWrites[0]?.operation).toBe("upgrade");
  });

  test("once upgraded, apply by this release passes the CLI/pin match guard", async () => {
    const { context, err } = cli();
    expect(await run(["upgrade"], context)).toBe(0);
    expect(await run(["plan"], context)).toBe(0);
    expect(err).toEqual([]);
  });

  test("declined: nothing is applied and the pin is not moved", async () => {
    const { context, err, pin, terraform } = cli({ answers: ["no"] });
    expect(await run(["upgrade"], context)).toBe(1);
    expect(err).toEqual(["", "✖ Not approved: nothing was applied", "", NOT_MOVED]);
    expect(pin()).toBe("0.2.0");
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
  });

  test("a failed apply after the pin moved says so and names apply as the rerun", async () => {
    const { context, err, pin, terraform } = cli({ answers: ["yes"] });
    terraform.world.hosts.delete("builder-1");
    terraform.world.failNext = "applyPlan";
    expect(await run(["upgrade"], context)).toBe(1);
    // The pin moved: the rerun is apply's, by this release.
    expect(err).toEqual([
      "",
      RESULT,
      "  ✖ Applying failed: `terraform apply` exited with status 1",
      "    Terraform may have changed some of the infrastructure before it stopped.",
      "",
      NEXT,
      "  Rerun: it plans again from what exists now and converges what remains:",
      "    $ fffactory apply",
    ]);
    expect(pin()).toBe("0.3.0");
  });

  test("a failure once the pin was written, before anything is applied, names apply to finish", async () => {
    const { context, err, out, pin, lockStore } = cli();
    const write = lockStore.writeOperation.bind(lockStore);
    let failed = false;
    lockStore.writeOperation = async (bucket, record) => {
      const written = record.stages.some(
        ({ name, status }) => name === "pin" && status === "written",
      );
      if (written && !failed) {
        failed = true;
        throw new Error("S3 answered SlowDown");
      }
      return write(bucket, record);
    };
    expect(await run(["upgrade"], context)).toBe(1);
    expect(out.slice(-5)).toEqual([
      "",
      rule("Applying"),
      "  Pin         factory.json now pins release 0.3.0",
      "",
      "  Operation record   s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json",
    ]);
    // The pin's state, then how to finish, after the failure and the record.
    expect(err).toEqual([
      "",
      RESULT,
      "  ✖ Upgrading failed once factory.json's pin moved: S3 answered SlowDown",
      "    Nothing was applied.",
      "",
      "factory.json pins release 0.3.0.",
      "",
      NEXT,
      "  Finish with this release:",
      "    $ fffactory apply",
    ]);
    expect(pin()).toBe("0.3.0");
  });

  test("a factory without its state bucket yet is refused: nothing is created, asked or moved", async () => {
    const { context, out, err, pin, prompt, lockStore, terraform } = cli({ bucket: false });
    expect(await run(["upgrade"], context)).toBe(1);
    expect(out).toEqual(HEADER);
    expect(err).toEqual([
      "",
      "✖ Refusing to upgrade: the factory has no state bucket yet, and an upgrade never creates it",
      "",
      "Nothing was created or applied.",
      "",
      NOT_MOVED,
      "",
      NEXT,
      "  Create it with the release factory.json pins, which applies the factory:",
      "    $ fffactory apply",
      "  Then upgrade again:",
      "    $ fffactory upgrade",
    ]);
    expect(prompt.asked).toEqual([]);
    expect(terraform.calls).toEqual([]);
    expect(lockStore.buckets.size).toBe(0);
    expect(lockStore.locks.size).toBe(0);
    expect(pin()).toBe("0.2.0");
  });

  test("factory.json changed while the plan was shown: nothing is moved or applied", async () => {
    const { context, err, store } = cli();
    const edited = `${store.files[PATH]}\n`;
    const prompt = context.prompt;
    const editing = {
      ...context,
      prompt: {
        ...prompt,
        ask: async (question: string) => {
          store.files[PATH] = edited;
          return prompt.ask(question);
        },
      },
    };
    expect(await run(["upgrade"], editing)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing to upgrade: factory.json changed after the plan was made",
      "",
      "Nothing was applied.",
      "",
      NOT_MOVED,
      "",
      NEXT,
      "  Review a new plan:",
      "    $ fffactory upgrade",
    ]);
    expect(store.files[PATH]).toBe(edited);
  });

  test("a held lock refuses it, saying the pin was not moved before the Next block", async () => {
    const { context, err, pin, lockStore } = cli();
    lockStore.hold(
      BUCKET,
      newLockRecord({
        factoryId: FACTORY,
        operation: "apply",
        holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
        now: new Date(TEST_NOW.getTime() - 5 * 60_000),
        release: "0.2.0" as Release,
        randomBytes: (count) => new Uint8Array(count).fill(9),
      }),
    );
    expect(await run(["upgrade", "--profile", "factory"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ The factory is locked by another operation:",
      "  Lock jjjjjjjj: apply by arn:aws:iam::123456789012:user/other on desk",
      "  Acquired 2026-09-30T11:55:00.000Z (5 min ago) by fffactory 0.2.0",
      "",
      NOT_MOVED,
      "",
      NEXT,
      "  Wait for it to finish. If its holder is no longer running, break the lock:",
      "    $ fffactory lock break --profile factory",
    ]);
    expect(pin()).toBe("0.2.0");
  });

  test("rejects an empty --profile", async () => {
    const { context, err } = cli();
    expect(await run(["upgrade", "--profile", ""], context)).toBe(1);
    expect(err).toEqual(["fffactory upgrade: --profile needs a profile name"]);
  });

  test("without a terminal, refuses before reaching AWS", async () => {
    const { context, err, identity, pin } = cli({ interactive: false });
    expect(await run(["upgrade"], context)).toBe(1);
    expect(err).toEqual([
      "Upgrading needs your approval of the pin move and the plan: rerun at a terminal.",
    ]);
    expect(identity.requests).toEqual([]);
    expect(pin()).toBe("0.2.0");
  });

  test("a factory.json pinning this release has nothing to upgrade, and reaches no AWS", async () => {
    const { context, out, err, identity } = cli({ pin: "0.3.0" });
    expect(await run(["upgrade"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([
      ...HEADER,
      "factory.json already pins this release, 0.3.0: there is nothing to upgrade. " +
        "`fffactory apply` converges the factory to it.",
    ]);
    expect(identity.requests).toEqual([]);
  });

  test("downgrade: a later pin is never moved back", async () => {
    const { context, err, identity, pin } = cli({ pin: "0.4.0-SECRETLIKE" });
    expect(await run(["upgrade"], context)).toBe(1);
    expect(err).toEqual([
      "Refusing to upgrade: factory.json pins a later fffactory release than this one, 0.3.0: " +
        "fffactory never moves a pin back to an earlier release (downgrade is not supported). " +
        "Install the release factory.json pins.",
    ]);
    expect(identity.requests).toEqual([]);
    expect(pin()).toBe("0.4.0-SECRETLIKE");
  });

  test("a factory.json that pins no release is not ready", async () => {
    const { context, err } = cli({ pin: undefined });
    expect(await run(["upgrade"], context)).toBe(1);
    expect(err).toEqual([
      "Refusing to upgrade: factory.json is not ready:",
      "  release: is required to upgrade",
    ]);
  });

  test("D11: a release that needs a newer base generation is refused, naming base migration", async () => {
    const { context, err, identity, pin } = cli({
      compatibility: {
        schema_version: 1,
        base_generation: 2,
        base_generation_since: "0.2.5" as Release,
      },
    });
    expect(await run(["upgrade"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing: this change needs base migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  release 0.3.0 needs base generation 2, which arrived in release 0.2.5: workers set up by the release factory.json pins have an older base",
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  factory.json still pins its release; keep using that release until base migration arrives.",
    ]);
    expect(identity.requests).toEqual([]);
    expect(pin()).toBe("0.2.0");
  });

  test("D11: a release of another factory.json schema version is refused before validation, naming schema migration", async () => {
    const { context, err, identity, pin } = cli({
      compatibility: {
        schema_version: 2,
        base_generation: 1,
        base_generation_since: "0.0.0" as Release,
      },
    });
    expect(await run(["upgrade"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing: this change needs schema migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  factory.json has schema version 1, and this release reads and writes schema version 2",
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  factory.json still pins its release; keep using that release until schema migration arrives.",
    ]);
    expect(identity.requests).toEqual([]);
    expect(pin()).toBe("0.2.0");
  });

  test("is listed in the command usage and prints its own usage", async () => {
    const { context, out } = cli();
    expect(await run(["--help"], context)).toBe(0);
    expect(out.some((line) => /^ {2}upgrade +\S/.test(line))).toBe(true);
    const usage = cli();
    expect(await run(["upgrade", "--help"], usage.context)).toBe(0);
    expect(usage.out[0]).toBe("Usage: fffactory upgrade [--instance PATH] [--profile NAME]");
  });
});
