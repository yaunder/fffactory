/**
 * `fffactory apply` interrupted for real: the spawned `main.ts` over the stand-in Terraform
 * (installed in its cache, so nothing is downloaded), the S3 and STS stubs, and SIGINT while
 * Terraform applies. Shows, end to end, the interrupt notice, apply's report of what the
 * interrupt left, the lock and the operation record outliving the interrupted process, and a
 * rerun going through after a break. That the lock is kept however the exit races the work is
 * `tests/application`'s to prove. And SIGINT while apply waits for a new worker's first boot,
 * which `main.ts` run from source never reaches: `support/apply-first-boot-main.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../../package.json";
import { SUPPORTED_TERRAFORM } from "../../src/domain/managed-terraform";
import { isolatedAwsEnvironment } from "../support/aws-isolation";
import { declaring } from "../support/factory-world";
import { type FakeTerraform, fakeTerraform } from "../support/fake-terraform";
import { eventually, killSurvivors } from "../support/processes";
import { MAIN, spawnCli } from "../support/spawn-cli";
import { type StubS3, stubS3 } from "../support/stub-s3";
import { EXAMPLE_CREDENTIALS, type StubSts, stubSts } from "../support/stub-sts";

const BUCKET = "fff-abcd1234-state";
const B1 = "fff-abcd1234-builder-1";
const FIRST_BOOT_MAIN = resolve(import.meta.dir, "../support/apply-first-boot-main.ts");
const LOCK = `${BUCKET}/fff-abcd1234-lock.json`;
const HOST = 'module.hosts.aws_instance.host["builder-1"]';
const PLAN_JSON = JSON.stringify({
  format_version: "1.2",
  resource_changes: [{ address: HOST, type: "aws_instance", change: { actions: ["create"] } }],
});

let scratch: string;
let sts: StubSts;
let s3: StubS3;
let terraform: FakeTerraform;
let env: Record<string, string>;
let instance: string;
const survivors: number[] = [];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-apply-"));
  sts = stubSts({
    kind: "caller",
    account: "123456789012",
    arn: "arn:aws:sts::123456789012:assumed-role/FactoryAdmin/operator",
  });
  s3 = stubS3({ buckets: { [BUCKET]: { owner: "123456789012" } } });
  // The managed Terraform's cache hit: the stand-in where the verified download would be.
  const cache = join(scratch, "cache");
  const installed = join(cache, "fffactory", "terraform", SUPPORTED_TERRAFORM.version);
  await mkdir(installed, { recursive: true });
  terraform = await fakeTerraform(installed);
  instance = join(scratch, "factory.json");
  const document = { ...declaring("builder-1"), release: manifest.version };
  await writeFile(instance, `${JSON.stringify(document, null, 2)}\n`);
  const credentials = join(scratch, "credentials");
  await writeFile(
    credentials,
    `[default]\naws_access_key_id = ${EXAMPLE_CREDENTIALS.accessKeyId}\n` +
      `aws_secret_access_key = ${EXAMPLE_CREDENTIALS.secretAccessKey}\n`,
  );
  env = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    XDG_CACHE_HOME: cache,
    ...isolatedAwsEnvironment(scratch),
    AWS_SHARED_CREDENTIALS_FILE: credentials,
    AWS_ENDPOINT_URL_STS: sts.endpoint,
    AWS_ENDPOINT_URL_S3: s3.endpoint,
  };
});

afterEach(() => killSurvivors(survivors));

afterAll(async () => {
  sts.stop();
  s3.stop();
  await rm(scratch, { recursive: true, force: true });
});

/** Everything a stream has delivered so far, and whether it has ended. */
function collected(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const sink = { text: "", done: Promise.resolve() };
  sink.done = (async () => {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
  })();
  return sink;
}

/** Saves a plan with `fffactory plan` and returns its ID. */
async function savedPlan(): Promise<string> {
  const planned = await spawnCli(["plan", "--instance", instance], { cwd: scratch, env });
  expect(planned.stderr).toBe("");
  expect(planned.code).toBe(0);
  const id = /Saved as plan ([a-z0-9]{8})/.exec(planned.stdout)?.[1];
  expect(id).toBeDefined();
  return id ?? "";
}

/** The operation records in the state bucket. */
function operationRecords() {
  return [...s3.objects.entries()]
    .filter(([key]) => key.startsWith(`${BUCKET}/fff-abcd1234-operations/`))
    .map(([, object]) => JSON.parse(object.body));
}

describe("fffactory apply, interrupted (plan-apply §Interruption)", () => {
  test("SIGINT while Terraform applies leaves the lock and the record; a rerun after a break applies", async () => {
    await terraform.behave({
      output: { stdout: "{}" },
      show: { stdout: PLAN_JSON },
      apply: { sleepMs: 60_000 },
    });
    const planId = await savedPlan();

    const apply = Bun.spawn(
      [process.execPath, MAIN, "apply", "--instance", instance, "--plan-id", planId],
      { cwd: scratch, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    survivors.push(apply.pid);
    const applying = await eventually(15_000, async () =>
      (await terraform.invocations()).some(({ args }) => args[0] === "apply") ? true : undefined,
    );
    expect(applying).toBe(true);
    apply.kill("SIGINT");

    expect(await apply.exited).toBe(130);
    const [stdout, stderr] = await Promise.all([
      new Response(apply.stdout).text(),
      new Response(apply.stderr).text(),
    ]);
    // fffactory exits only once apply has said what the interrupt left.
    expect(stderr).toBe(
      "Interrupted: stopping running tools. Interrupt again to kill them at once " +
        "(Terraform may lose state).\n" +
        "Interrupted: the factory stays locked, with a record of this operation. Once " +
        "fffactory has exited, break the lock with `fffactory lock break`, then rerun " +
        "`fffactory apply`.\n",
    );
    expect(await terraform.signals()).toEqual([{ subcommand: "apply", signal: "SIGINT" }]);
    const lock = JSON.parse(s3.objects.get(LOCK)?.body ?? "null");
    expect(lock).toMatchObject({ operation: "apply", factory_id: "fff-abcd1234" });
    expect(stdout).toMatch(
      new RegExp(
        `Operation record: s3://${BUCKET}/fff-abcd1234-operations/[^/\\n]+-${lock.lock_id}\\.json\\n$`,
      ),
    );
    expect(operationRecords()).toEqual([
      expect.objectContaining({
        operation_id: lock.lock_id,
        plan_id: planId,
        status: "running",
        stages: [{ name: "infrastructure", status: "applying" }],
      }),
    ]);

    // A rerun is refused while the lock is held, and goes through once it is broken.
    await terraform.behave({ output: { stdout: "{}" }, show: { stdout: PLAN_JSON } });
    const locked = await spawnCli(["plan", "--instance", instance], { cwd: scratch, env });
    expect(locked.code).toBe(1);
    expect(locked.stderr).toContain("The factory is locked by another operation:");
    const broken = await spawnCli(
      ["lock", "break", "--instance", instance, "--lock-id", lock.lock_id],
      { cwd: scratch, env },
    );
    expect(broken.code).toBe(0);
    const rerunId = await savedPlan();
    const rerun = await spawnCli(["apply", "--instance", instance, "--plan-id", rerunId], {
      cwd: scratch,
      env,
    });
    expect(rerun.stderr).toBe("");
    expect(rerun.stdout).toContain("Applied: the factory's infrastructure matches factory.json.");
    // Run from source, fffactory carries no worker executable: the worker is skipped, and
    // dispatch, sending it nothing, skips it too (dispatch §Skipped workers): exit 2, not 1.
    const noExecutable =
      "This fffactory carries no worker executable: it runs from source, not from a built release";
    expect(rerun.stdout).toContain(
      `  skipped    builder-1 (fff-abcd1234-builder-1): ${noExecutable}`,
    );
    expect(rerun.stdout).toContain(
      `  skipped  builder-1 (fff-abcd1234-builder-1): ${noExecutable}`,
    );
    expect(rerun.code).toBe(2);
    expect(s3.objects.has(LOCK)).toBe(false);
    expect(
      operationRecords()
        .map(({ status }) => status)
        .sort(),
    ).toEqual(["partial", "running"]);
  }, 60_000);

  test("SIGINT while apply waits for a new worker's first boot says so, keeps the lock, exits 130", async () => {
    const apply = Bun.spawn([process.execPath, FIRST_BOOT_MAIN], {
      cwd: scratch,
      env: { PATH: process.env.PATH ?? "", HOME: scratch, ...isolatedAwsEnvironment(scratch) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    survivors.push(apply.pid);
    const stdout = collected(apply.stdout);
    const waiting = await eventually(15_000, () =>
      stdout.text.includes(`Waiting for builder-1 (${B1}) to finish its first boot`)
        ? true
        : undefined,
    );
    expect(waiting).toBe(true);
    apply.kill("SIGINT");

    expect(await apply.exited).toBe(130);
    expect(apply.signalCode).toBeNull();
    expect(await new Response(apply.stderr).text()).toBe(
      "Interrupted: stopping running tools.\n" +
        `Interrupted while waiting for builder-1 (${B1}) to finish its first boot: no install ` +
        "step ran on it.\n" +
        "Interrupted: the factory stays locked, with a record of this operation. Once " +
        "fffactory has exited, break the lock with `fffactory lock break`, then rerun " +
        "`fffactory apply`.\n",
    );
    await stdout.done;
    expect(stdout.text).toMatch(/Operation record: s3:\/\/[^\n]+\n$/);
  }, 30_000);
});
