/**
 * `fffactory teardown` in process (`docs/specs/teardown.md` §Command, §Output and exit codes):
 * its arguments, refusals that never echo what was given, what it prints, and each exit code,
 * over the in-memory factory of the use case's tests. The spawned executable against the AWS and
 * Tailscale stand-ins is `teardown-executable.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { MachineInventorySource } from "../../src/application/machine-inventory";
import { run, waitsOnInterrupt } from "../../src/cli/run";
import type { FactoryInstance, SecretReference } from "../../src/domain/instance";
import type { ListedSecret } from "../../src/domain/secrets";
import type { Machine } from "../../src/domain/status";
import {
  archiveKept,
  factoryJsonKept,
  REVOKE_SOURCES,
  TEARDOWN_UNCONFIRMABLE,
  teardownQuestion,
} from "../../src/domain/teardown";
import { harness } from "../support/cli-harness";
import { fakeCallerIdentity } from "../support/doctor-fakes";
import { agentsIn, fakeControlPlane, fakeWorkflowQueue } from "../support/fake-control-plane";
import { fakeFactoryWorld } from "../support/fake-provisioner";
import { fakePrompt, fakeSecretsManager } from "../support/fake-secrets";
import {
  fakeTailnet,
  fakeTailnetAdmin,
  fakeTransport,
  tailnetDevice,
} from "../support/fake-workers";
import { ARCHIVE, BUCKET, declaring, FACTORY, WORKER_TAG } from "../support/factory-world";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { MemoryLockStore } from "../support/memory-lock-store";
import { MemoryPlanStore } from "../support/memory-plan-store";

const PATH = "/work/repo/.fffactory/factory.json";
const KEY = "builder-1";
const HOSTNAME = `${FACTORY}-${KEY}`;
const arn = (name: string) =>
  `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${name}-AbCdEf` as SecretReference;
const AUTH_ARN = arn(`${FACTORY}/tailscale-auth-key`);
const ADMIN_ARN = arn(`${FACTORY}/tailscale-admin-client`);
const ADMIN_SECRET = "tskey-client-kExample1CNTRL-0123456789abcdef";
const SOURCE_ARN = arn("fffv/github-token");
const OWNED_TAGS = { "fffactory:factory-id": FACTORY, "fffactory:managed-by": "fffactory" };
const owned = (name: string): ListedSecret => ({
  name,
  arn: arn(name),
  tags: OWNED_TAGS,
  pendingDeletion: false,
});
/** What a careless operator might paste in place of the factory ID. */
const PASTED = "tskey-auth-kPasted1CNTRL-notthefactoryid";

function instance(archive = false): FactoryInstance {
  const base = declaring(KEY);
  return {
    ...base,
    tailscale: { ...base.tailscale, admin_client_secret: ADMIN_ARN },
    credentials: { github_token_secret: SOURCE_ARN },
    ...(archive ? { log_archive: { enabled: true } } : {}),
  };
}

/**
 * A factory with one stopped worker, provisioned, its device in the tailnet, its two owned
 * secrets, and the CLI context over it. A stopped worker is neither stopped nor inspected.
 */
function world(
  options: {
    interactive?: boolean;
    answers?: string[];
    identity?: ReturnType<typeof fakeCallerIdentity>;
    /** factory.json enables the log archive, `ARCHIVE`. */
    archive?: boolean;
  } = {},
) {
  const store = new MemoryInstanceStore({
    [PATH]: `${JSON.stringify(instance(options.archive), null, 2)}\n`,
  });
  const lockStore = new MemoryLockStore([BUCKET]);
  const terraform = fakeFactoryWorld({
    store: lockStore,
    bucket: BUCKET,
    hosts: [KEY],
    network: true,
  });
  const machines: MachineInventorySource = {
    list: async () => ({
      kind: "machines",
      machines: [...terraform.world.hosts].map(
        (key): Machine => ({ instanceId: `i-${key}`, state: "stopped", hostKey: key }),
      ),
    }),
    listVpcs: async () => ({
      kind: "vpcs",
      vpcIds: terraform.world.network ? ["vpc-0123456789abcdef0"] : [],
    }),
  };
  const secrets = fakeSecretsManager({
    values: { [ADMIN_ARN]: ADMIN_SECRET },
    secrets: [owned(`${FACTORY}/tailscale-auth-key`), owned(`${FACTORY}/tailscale-admin-client`)],
  });
  const admin = fakeTailnetAdmin({ devices: [tailnetDevice("n0CNTRL", HOSTNAME, [WORKER_TAG])] });
  const prompt = fakePrompt({
    interactive: options.interactive ?? false,
    answers: options.answers ?? [],
  });
  const identity = options.identity ?? fakeCallerIdentity();
  const cli = harness(
    store,
    {},
    {
      identity: identity.identity,
      lockStore,
      machines,
      provisioner: terraform.provisioner,
      planStore: new MemoryPlanStore(),
      secrets: secrets.store,
      tailnetAdmin: admin.admin,
      tailnet: fakeTailnet().tailnet,
      transport: fakeTransport().transport,
      controlPlane: fakeControlPlane("healthy", agentsIn()).controlPlane,
      workflowQueue: fakeWorkflowQueue().queue,
      prompt: prompt.prompt,
    },
  );
  return { ...cli, store, lockStore, terraform, secrets, admin, prompt, identity };
}

type World = ReturnType<typeof world>;

const teardown = (w: World, ...args: string[]) => run(["teardown", ...args], w.context);
const everything = (w: World) => [...w.out, ...w.err].join("\n");

/** Nothing was asked of AWS, Terraform, Secrets Manager or the tailnet. */
function expectNothingAsked(w: World) {
  expect(w.identity.requests).toEqual([]);
  expect(w.lockStore.calls).toEqual([]);
  expect(w.terraform.calls).toEqual([]);
  expect(w.secrets.calls).toEqual([]);
  expect(w.admin.calls).toEqual([]);
}

describe("fffactory teardown: a finished teardown exits 0", () => {
  test("with --confirm and no terminal: the review, each step, what was removed, the advice", async () => {
    const w = world();
    expect(await teardown(w, "--confirm", FACTORY)).toBe(0);
    expect(w.err).toEqual([]);
    const out = w.out.join("\n");
    expect(w.out[0]).toBe("fffactory teardown · release 0.3.0");
    expect(out).toContain("── Teardown ──");
    expect(out).toContain("  Tailnet devices   delete n0CNTRL (fff-abcd1234-builder-1)");
    expect(out).toContain("── Removing ──");
    expect(out).toContain(
      "  fff-abcd1234-builder-1 is stopped: it is not inspected, and unpushed work on its disk is destroyed with it.",
    );
    expect(out).toContain("✔ Removed factory fff-abcd1234: only what it kept remains");
    expect(out).toContain(`  Referenced   ${SOURCE_ARN}`);
    expect(out).toContain(`  ${REVOKE_SOURCES}`);
    expect(w.out.at(-1)).toBe(`  ${factoryJsonKept(undefined)}`);
    expect(out).not.toMatch(/archive/i);
    // The review comes before any step, and the report after the last.
    expect(out.indexOf("── Teardown ──")).toBeLessThan(out.indexOf("── Removing ──"));
    expect(out.indexOf("── Removing ──")).toBeLessThan(out.indexOf("── Result ──"));
    expect(w.lockStore.buckets.has(BUCKET)).toBe(false);
    expect(w.store.writes).toEqual([]);
    expect(everything(w)).not.toContain(ADMIN_SECRET);
    expect(w.prompt.asked).toEqual([]);
  });

  test("at a terminal: the review, then the question, confirmed by the factory ID typed", async () => {
    const w = world({ interactive: true, answers: [` ${FACTORY} `] });
    expect(await teardown(w)).toBe(0);
    expect(w.prompt.asked).toEqual([teardownQuestion(FACTORY)]);
    expect(w.out.join("\n")).toContain("✔ Removed factory fff-abcd1234");
  });

  test("with the log archive: the question, review, report and advice name it kept", async () => {
    const w = world({ interactive: true, answers: [FACTORY], archive: true });
    expect(await teardown(w)).toBe(0);
    expect(w.prompt.asked).toEqual([teardownQuestion(FACTORY, false, ARCHIVE)]);
    expect(w.prompt.asked[0]).toContain(archiveKept(ARCHIVE));
    const out = w.out.join("\n");
    // Once in the review's Kept section, once in the report's, and in the advice.
    expect(out.split(`\n  ${archiveKept(ARCHIVE)}`)).toHaveLength(3);
    expect(out.indexOf(archiveKept(ARCHIVE))).toBeLessThan(out.indexOf("── Removing ──"));
    expect(w.out.at(-1)).toBe(`  ${factoryJsonKept(ARCHIVE)}`);
    // Named from factory.json alone: S3 was never asked about the archive.
    expect(w.lockStore.calls.filter((call) => call.includes(ARCHIVE))).toEqual([]);
  });

  test("the commands it names repeat the instance and profile given", async () => {
    const w = world();
    expect(await teardown(w, "--confirm", FACTORY, "--instance", PATH, "--profile", "op")).toBe(0);
    expect(w.out.at(-1)).toContain(`\`fffactory apply --instance ${PATH} --profile op\``);
  });
});

describe("fffactory teardown: refused or declined exits 1, nothing removed", () => {
  test("a --confirm that is not the factory ID is refused before AWS, never echoed", async () => {
    const w = world();
    expect(await teardown(w, "--confirm", PASTED)).toBe(1);
    expect(w.err).toContain(
      "✖ Refusing to remove the factory: --confirm does not name the factory fff-abcd1234",
    );
    expect(everything(w)).not.toContain(PASTED);
    expectNothingAsked(w);
  });

  test("a typed answer that is not the factory ID declines, never echoed", async () => {
    const w = world({ interactive: true, answers: [PASTED] });
    expect(await teardown(w)).toBe(1);
    expect(w.err[w.err.indexOf("Not confirmed: nothing was removed.")]).toBeDefined();
    expect(everything(w)).not.toContain(PASTED);
    expect(w.terraform.calls.filter(({ call }) => call === "applyPlan")).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  test("without a terminal or --confirm", async () => {
    const w = world();
    expect(await teardown(w)).toBe(1);
    expect(w.err).toContain(`✖ ${TEARDOWN_UNCONFIRMABLE}`);
    expectNothingAsked(w);
  });

  test("another account: the account check's refusal", async () => {
    const w = world({
      identity: fakeCallerIdentity({
        kind: "caller",
        caller: { account: "999999999999", arn: "arn:aws:iam::999999999999:user/op" },
      }),
    });
    expect(await teardown(w, "--confirm", FACTORY)).toBe(1);
    expect(w.err[0]).toStartWith("Refusing to remove the factory: ");
    expect(w.err.join("\n")).toContain("999999999999");
    expect(w.lockStore.calls).toEqual([]);
    expect(w.lockStore.buckets.has(BUCKET)).toBe(true);
  });

  for (const args of [[PASTED], ["--confirm", FACTORY, PASTED], [`--${PASTED}`], ["--confirm"]])
    test(`anything else is refused before anything is read, never echoed (${args.length} args)`, async () => {
      const w = world();
      expect(await teardown(w, ...args)).toBe(1);
      expect(w.err).toEqual([
        "fffactory teardown takes only --confirm FACTORY_ID, --instance PATH and --profile NAME.",
      ]);
      expect(w.out).toEqual([]);
      expect(w.store.reads).toEqual([]);
      expectNothingAsked(w);
    });

  test("--force is not an option: a worker it refuses is terminated with --force first", async () => {
    const w = world();
    expect(await teardown(w, "--confirm", FACTORY, "--force")).toBe(1);
    expect(w.err).toEqual([
      "fffactory teardown has no --force: remove a worker it refuses with `fffactory worker terminate KEY --force` first.",
    ]);
    expect(w.store.reads).toEqual([]);
  });

  test("an empty --profile", async () => {
    const w = world();
    expect(await teardown(w, "--profile", "")).toBe(1);
    expect(w.err).toEqual(["fffactory teardown: --profile needs a profile name"]);
  });
});

describe("fffactory teardown: part way exits 2, interrupted 128+N", () => {
  test("a secret not deleted: what remains and the rerun, on standard error", async () => {
    const w = world();
    w.secrets.removeFails.set(AUTH_ARN, { kind: "failed", reason: "AccessDeniedException" });
    expect(await teardown(w, "--confirm", FACTORY)).toBe(2);
    expect(w.err).toContain(
      "✖ Teardown stopped part way, at the owned secrets: Not every secret the factory owns is gone",
    );
    expect(w.err).toContain(`  Remains: owned secrets ${FACTORY}/tailscale-auth-key`);
    expect(w.err).toContain(`  Remains: the state bucket ${BUCKET}`);
    expect(w.err.at(-1)).toBe(
      "  Check the credentials may delete and describe them, then rerun `fffactory teardown`.",
    );
    // A rerun finishes it.
    w.secrets.removeFails.clear();
    w.out.length = 0;
    w.err.length = 0;
    expect(await teardown(w, "--confirm", FACTORY)).toBe(0);
    expect(w.out.join("\n")).toContain("✔ Removed factory fff-abcd1234");
    expect(w.lockStore.buckets.has(BUCKET)).toBe(false);
  });

  test("interrupted: interruptedTeardown's words, and it waits to report them", async () => {
    const w = world();
    const context = { ...w.context, interrupted: () => true };
    expect(await run(["teardown", "--confirm", FACTORY], context)).toBe(1);
    expect(w.err).toEqual([
      "",
      "✖ Interrupted before the factory was locked: it is not locked, and nothing was removed",
    ]);
    expect(waitsOnInterrupt(["teardown", "--confirm", FACTORY])).toBe(true);
  });
});

describe("fffactory teardown: help", () => {
  test("is listed, and its usage says it is admin-tier and how it exits", async () => {
    const w = world();
    expect(await run(["--help"], w.context)).toBe(0);
    expect(w.out.join("\n")).toMatch(
      / {2}teardown +Remove the whole factory, all it owns but its log archive, after you confirm its ID/,
    );
    const usage = world();
    expect(await teardown(usage, "--help")).toBe(0);
    const text = usage.out.join("\n");
    expect(usage.out[0]).toBe(
      "Usage: fffactory teardown [--confirm FACTORY_ID] [--instance PATH] [--profile NAME]",
    );
    expect(text).toContain("Admin-tier");
    expect(text).toContain("Exits 0 once only what it keeps remains");
    expect(text).toContain("everything it owns but its log archive");
    expect(text).toContain("the secrets and, when factory.json enables one,\nthe log archive");
    expect(text).toContain("adopting the archive if\nit exists");
    // An interrupt need not leave the lock: before it, without a state bucket, or with the bucket.
    expect(text).toContain("Interrupted, it says what it left and what to do next");
    expect(text).not.toContain("Interrupting it leaves the factory locked");
  });
});
