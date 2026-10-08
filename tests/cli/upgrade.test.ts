import { describe, expect, test } from "bun:test";
import { run } from "../../src/cli/run";
import type { Release } from "../../src/domain/instance";
import type { ReleaseCompatibility } from "../../src/domain/release-compatibility";
import { harness } from "../support/cli-harness";
import { fakeCallerIdentity } from "../support/doctor-fakes";
import { BUCKET, declaring, FACTORY, workerFleet } from "../support/factory-world";
import { fakeFactoryWorld } from "../support/fake-provisioner";
import { fakePrompt } from "../support/fake-secrets";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { MemoryLockStore } from "../support/memory-lock-store";
import { MemoryPlanStore } from "../support/memory-plan-store";

const PATH = "/work/repo/.fffactory/factory.json";
const INSTANCE_LINE = `Instance: ${PATH} (nearest .fffactory/factory.json)`;
const B1 = "fff-abcd1234-builder-1";
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
    expect(out.slice(0, 18)).toEqual([
      INSTANCE_LINE,
      "Upgrade: factory.json's release pin moves from 0.2.0 to 0.3.0. It is written once you approve this plan, before anything is applied.",
      "Factory plan:",
      `  Configuration: ${PATH}`,
      "  Factory: Test factory (fff-abcd1234)",
      "  AWS account: 123456789012, Region: eu-west-2",
      "  Release: 0.3.0",
      "Infrastructure: no changes.",
      "Worker changes, one worker at a time:",
      `  ~ builder-1 (${B1}): install release 0.3.0 and its host configuration, then verify it`,
      "Control-plane changes, before worker activation:",
      `  ~ builder-1 (${B1}): paseo-package, service-definition, listen-address`,
      "Repository changes, one worker at a time:",
      `  ~ builder-1 (${B1}): reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts`,
      "Dispatch changes, after every readiness gate:",
      `  ~ builder-1 (${B1}): remove the factory dispatch schedule if it exists`,
      "End-to-end verification: observe each worker's release, repositories, Paseo and actual dispatch schedule.",
      "Applying. Terraform's output is not shown; this can take several minutes.",
    ]);
    expect(out[18]).toBe("factory.json now pins release 0.3.0.");
    expect(out).toContain("Infrastructure: no changes to apply.");
    expect(out.at(-1)).toStartWith(`Operation record: s3://${BUCKET}/${FACTORY}-operations/`);
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
    expect(err).toEqual([
      "Not approved: nothing was applied.",
      "factory.json's pin was not moved: it still pins the release it pinned.",
    ]);
    expect(pin()).toBe("0.2.0");
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
  });

  test("a failed apply after the pin moved says so and names apply as the rerun", async () => {
    const { context, err, pin, terraform } = cli({ answers: ["yes"] });
    terraform.world.hosts.delete("builder-1");
    terraform.world.failNext = "applyPlan";
    expect(await run(["upgrade"], context)).toBe(1);
    expect(err).toEqual([
      "Applying failed: `terraform apply` exited with status 1.",
      "Terraform may have changed some of the infrastructure before it stopped.",
      "Rerun `fffactory apply`: it plans again from what exists now and converges what remains.",
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
    expect(out).toContain("factory.json now pins release 0.3.0.");
    expect(err).toEqual([
      "Upgrading failed once factory.json's pin moved: S3 answered SlowDown. Nothing was applied.",
      "factory.json pins release 0.3.0: rerun `fffactory apply` with this release to finish.",
    ]);
    expect(pin()).toBe("0.3.0");
  });

  test("a factory without its state bucket yet is refused: nothing is created, asked or moved", async () => {
    const { context, out, err, pin, prompt, lockStore, terraform } = cli({ bucket: false });
    expect(await run(["upgrade"], context)).toBe(1);
    expect(out).toEqual([INSTANCE_LINE]);
    expect(err).toEqual([
      "Refusing to upgrade: the factory has no state bucket yet, and an upgrade never creates " +
        "it. Nothing was created or applied. Run `fffactory apply` with the release " +
        "factory.json pins first, then rerun `fffactory upgrade`.",
      "factory.json's pin was not moved: it still pins the release it pinned.",
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
      "Refusing to upgrade: factory.json changed after the plan was made. Nothing was " +
        "applied. Review a new plan with `fffactory upgrade`.",
      "factory.json's pin was not moved: it still pins the release it pinned.",
    ]);
    expect(store.files[PATH]).toBe(edited);
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
      INSTANCE_LINE,
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
      "Refusing: this change needs base migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  release 0.3.0 needs base generation 2, which arrived in release 0.2.5: workers set up by the release factory.json pins have an older base",
      "Nothing was applied. factory.json still pins its release; keep using that release until base migration arrives.",
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
      "Refusing: this change needs schema migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  factory.json has schema version 1, and this release reads and writes schema version 2",
      "Nothing was applied. factory.json still pins its release; keep using that release until schema migration arrives.",
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
