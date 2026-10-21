/**
 * `fffactory teardown` as the spawned `main.ts`, with the real AWS SDK and Tailscale adapter,
 * against local stand-ins only: STS, S3, Secrets Manager, EC2 and Tailscale's API stubs in this
 * process, the stand-in Terraform installed as the managed one's cache hit, and stand-in
 * `tailscale` and `ssh` on a private PATH. Its environment is built from nothing: no inherited
 * `AWS_*` variable, profile or credential, AWS's config files and instance metadata sealed
 * (`isolatedAwsEnvironment`), every endpoint on 127.0.0.1, and a private HOME and cache. It never
 * reaches AWS, Tailscale, a worker or the operator's own files. A full teardown of a factory
 * with one stopped worker, a refusal, and a teardown stopped part way then finished by a rerun;
 * no secret material in any output, nor in Terraform's arguments or environment.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../../package.json";
import { SUPPORTED_TERRAFORM } from "../../src/domain/managed-terraform";
import { TAILSCALE_API_VARIABLE } from "../../src/infrastructure/tailscale-api-admin";
import { isolatedAwsEnvironment } from "../support/aws-isolation";
import { BUCKET, declaring, FACTORY } from "../support/factory-world";
import { type FakeTerraform, fakeTerraform } from "../support/fake-terraform";
import { spawnCli } from "../support/spawn-cli";
import { type StubEc2Instances, stubEc2Instances } from "../support/stub-ec2-instances";
import { type StubS3, stubS3 } from "../support/stub-s3";
import {
  type StubSecretsManager,
  stubArn,
  stubSecretsManager,
} from "../support/stub-secrets-manager";
import { EXAMPLE_CREDENTIALS, type StubSts, stubSts } from "../support/stub-sts";
import { type StubTailscaleApi, stubTailscaleApi, TOKEN } from "../support/stub-tailscale-api";

const ACCOUNT = "123456789012";
const KEY = "builder-1";
const HOSTNAME = `${FACTORY}-${KEY}`;
const INSTANCE_ID = "i-0123456789abcdef0";
const VPC_ID = "vpc-0123456789abcdef0";
const DEVICE = "nWorker1CNTRL";
const HOST = `module.hosts.aws_instance.host["${KEY}"]`;
const AUTH = `${FACTORY}/tailscale-auth-key`;
const ADMIN = `${FACTORY}/tailscale-admin-client`;
/** A harness source the factory only refers to: never its to delete. */
const SOURCE = "fffv/github-token";
const ADMIN_SECRET = "tskey-client-kSpawned1CNTRL-adminclientSECRETvalue";
const AUTH_KEY = "tskey-auth-kSpawned1CNTRL-authkeySECRETvalue";
const OWNED_TAGS = { "fffactory:factory-id": FACTORY, "fffactory:managed-by": "fffactory" };
/** Every secret value the run could leak: none may appear in any output or Terraform's input. */
const SECRETS = [ADMIN_SECRET, AUTH_KEY, TOKEN, EXAMPLE_CREDENTIALS.secretAccessKey];

/** The destroy plan Terraform shows while the factory exists: its host machine and network. */
const DESTROY_PLAN = JSON.stringify({
  format_version: "1.2",
  resource_changes: [
    {
      address: HOST,
      mode: "managed",
      type: "aws_instance",
      change: { actions: ["delete"], before: { id: INSTANCE_ID }, after: null },
    },
    {
      address: "module.network.aws_vpc.this",
      mode: "managed",
      type: "aws_vpc",
      change: { actions: ["delete"], before: { id: VPC_ID }, after: null },
    },
  ],
});
/** Once the factory root is destroyed, its plan changes nothing. */
const EMPTY_PLAN = JSON.stringify({ format_version: "1.2", resource_changes: [] });

let scratch: string;
let run = 0;
const stubs: { stop(): void }[] = [];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-teardown-"));
});
afterEach(() => {
  for (const stub of stubs.splice(0)) stub.stop();
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Factory {
  readonly directory: string;
  readonly instance: string;
  readonly env: Record<string, string>;
  readonly sts: StubSts;
  readonly s3: StubS3;
  readonly secrets: StubSecretsManager;
  readonly ec2: StubEc2Instances;
  readonly tailscale: StubTailscaleApi;
  readonly terraform: FakeTerraform;
  /** HTTP statuses Tailscale answers, by device ID's deletion: change it between runs. */
  readonly statuses: Record<string, number>;
  /** Whether the stand-in Terraform has applied the destroy. */
  readonly destroyed: () => boolean;
}

/**
 * A private directory of stand-ins: `tailscale` lists no peer, `ssh` refuses every connection.
 * A stopped worker is neither stopped nor inspected, so neither is expected to run.
 */
async function standIns(directory: string): Promise<string> {
  const bin = join(directory, "bin");
  await mkdir(bin, { recursive: true });
  const peers = JSON.stringify({
    BackendState: "Running",
    Self: { HostName: "operator-laptop", DNSName: "operator-laptop.ts.net.", Online: true },
    Peer: {},
  });
  await writeFile(join(directory, "peers.json"), peers);
  const scripts = { tailscale: `cat '${directory}/peers.json'`, ssh: "exit 255" };
  for (const [tool, script] of Object.entries(scripts)) {
    await writeFile(join(bin, tool), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, tool), 0o755);
  }
  // Only the real tool the stand-ins use: the host's own ssh and tailscale stay out.
  const cat = Bun.which("cat");
  if (!cat) throw new Error("cat is not on PATH");
  await symlink(cat, join(bin, "cat"));
  return bin;
}

/**
 * A factory with one stopped worker, its network, its device in the tailnet, its two owned
 * secrets and a source it refers to, a ready state bucket, and the environment that points the
 * spawned CLI at all of them and nothing else.
 */
async function factory(): Promise<Factory> {
  run += 1;
  const directory = join(scratch, `run-${run}`);
  const home = join(directory, "home");
  const cache = join(directory, "cache");
  const temporary = join(directory, "tmp");
  for (const path of [home, cache, temporary]) await mkdir(path, { recursive: true });
  // The managed Terraform's cache hit: the stand-in where the verified download would be.
  const installed = join(cache, "fffactory", "terraform", SUPPORTED_TERRAFORM.version);
  await mkdir(installed, { recursive: true });
  const terraform = await fakeTerraform(installed);
  await terraform.behave({ plan: { exitCode: 2 }, show: { stdout: DESTROY_PLAN } });
  const log = join(installed, "invocations.jsonl");
  const destroyed = () =>
    existsSync(log) &&
    readFileSync(log, "utf8")
      .split("\n")
      .some((line) => line.startsWith('{"args":["apply"'));

  const sts = stubSts({ kind: "caller", account: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/op` });
  const s3 = stubS3({ buckets: { [BUCKET]: { owner: ACCOUNT } } });
  const secrets = stubSecretsManager();
  secrets.add(AUTH, OWNED_TAGS);
  secrets.secrets.set(AUTH, [AUTH_KEY]);
  secrets.add(ADMIN, OWNED_TAGS);
  secrets.secrets.set(ADMIN, [ADMIN_SECRET]);
  secrets.add(SOURCE, {});
  // EC2 lists the worker's stopped instance and the network until Terraform destroys them.
  const ec2 = stubEc2Instances(() =>
    destroyed()
      ? {}
      : {
          pages: [
            [
              {
                id: INSTANCE_ID,
                state: "stopped",
                tags: { "fffactory:factory-id": FACTORY, "fffactory:host-key": KEY },
              },
            ],
          ],
          vpcPages: [[{ id: VPC_ID, tags: { "fffactory:factory-id": FACTORY } }]],
        },
  );
  const statuses: Record<string, number> = {};
  const tailscale = stubTailscaleApi({
    secret: ADMIN_SECRET,
    devices: [
      {
        nodeId: DEVICE,
        hostname: HOSTNAME,
        name: `${HOSTNAME}.example-tailnet.ts.net`,
        tags: ["tag:factory"],
      },
    ],
    statuses,
  });
  stubs.push(sts, s3, secrets, ec2, tailscale);

  const instance = join(directory, "factory.json");
  const base = declaring(KEY);
  const document = {
    ...base,
    release: manifest.version,
    tailscale: {
      ...base.tailscale,
      auth_key_secret: stubArn(AUTH),
      admin_client_secret: stubArn(ADMIN),
    },
    credentials: { github_token_secret: stubArn(SOURCE) },
  };
  await writeFile(instance, `${JSON.stringify(document, null, 2)}\n`);
  const credentials = join(directory, "credentials");
  await writeFile(
    credentials,
    `[default]\naws_access_key_id = ${EXAMPLE_CREDENTIALS.accessKeyId}\n` +
      `aws_secret_access_key = ${EXAMPLE_CREDENTIALS.secretAccessKey}\n`,
  );
  const env: Record<string, string> = {
    PATH: await standIns(directory),
    HOME: home,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: temporary,
    ...isolatedAwsEnvironment(directory),
    AWS_SHARED_CREDENTIALS_FILE: credentials,
    AWS_ENDPOINT_URL_STS: sts.endpoint,
    AWS_ENDPOINT_URL_S3: s3.endpoint,
    AWS_ENDPOINT_URL_SECRETS_MANAGER: secrets.endpoint,
    AWS_ENDPOINT_URL_EC2: ec2.endpoint,
    [TAILSCALE_API_VARIABLE]: tailscale.url,
  };
  return {
    directory,
    instance,
    env,
    sts,
    s3,
    secrets,
    ec2,
    tailscale,
    terraform,
    statuses,
    destroyed,
  };
}

/** Runs `fffactory teardown` with `args`, never in the inherited environment. */
async function teardown(world: Factory, ...args: string[]) {
  // Every endpoint the run may reach is a stand-in on this machine.
  for (const [name, value] of Object.entries(world.env))
    if (name.startsWith("AWS_ENDPOINT_URL") || name === TAILSCALE_API_VARIABLE)
      expect(value).toStartWith("http://127.0.0.1:");
  expect(Object.keys(world.env).filter((name) => name.startsWith("AWS_PROFILE"))).toEqual([]);
  return spawnCli(["teardown", "--instance", world.instance, ...args], {
    cwd: world.directory,
    env: world.env,
  });
}

/** No secret value in either stream, nor in any argument or environment Terraform was given. */
async function expectNoSecretMaterial(
  world: Factory,
  ...results: { stdout: string; stderr: string }[]
) {
  const invocations = await world.terraform.invocations();
  // The stand-in recorded each run's whole environment, so the check below reads something.
  for (const { env } of invocations) expect(env.PATH).toBeDefined();
  const args = invocations.flatMap(({ args }) => args).join(" ");
  const env = JSON.stringify(invocations.map(({ env }) => env));
  for (const text of [...results.flatMap(({ stdout, stderr }) => [stdout, stderr]), args, env])
    for (const secret of SECRETS) expect(text).not.toContain(secret);
}

/** Nothing the factory owns remains; the source it refers to is kept. */
function expectNothingOwned(world: Factory) {
  expect(world.destroyed()).toBe(true);
  expect(world.tailscale.remaining()).toEqual([]);
  expect([...world.secrets.secrets.keys()]).toEqual([SOURCE]);
  expect(world.secrets.scheduled.size).toBe(0);
  expect(world.s3.stored(BUCKET)).toBe(0);
  expect(world.s3.requests.some((line) => line.startsWith(`DELETE /${BUCKET} `))).toBe(true);
}

describe("fffactory teardown executable", () => {
  test("--confirm without a terminal removes the whole factory and exits 0", async () => {
    const world = await factory();
    const result = await teardown(world, "--confirm", FACTORY);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`  Tailnet devices   delete ${DEVICE} (${HOSTNAME})`);
    expect(result.stdout).toContain(`✔ Removed factory ${FACTORY}: nothing it owns remains`);
    expect(result.stdout).toContain(`  Referenced   ${stubArn(SOURCE)}`);
    expectNothingOwned(world);
    // The destroy applied exactly the plan it saved.
    const applies = (await world.terraform.invocations()).filter(({ args }) => args[0] === "apply");
    expect(applies).toHaveLength(1);
    // The secrets were deleted permanently and their absence confirmed.
    const deletions = world.secrets.requests.filter(
      ({ operation }) => operation === "DeleteSecret",
    );
    expect(deletions.map(({ body }) => body.ForceDeleteWithoutRecovery)).toEqual([true, true]);
    await expectNoSecretMaterial(world, result);
  });

  test("a --confirm that is not the factory ID is refused before anything is asked, unechoed", async () => {
    const world = await factory();
    const result = await teardown(world, "--confirm", AUTH_KEY);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `✖ Refusing to remove the factory: --confirm does not name the factory ${FACTORY}`,
    );
    expect(world.sts.requests).toEqual([]);
    expect(world.s3.requests).toEqual([]);
    expect(world.secrets.requests).toEqual([]);
    expect(world.ec2.requests).toEqual([]);
    expect(world.tailscale.requests).toEqual([]);
    expect(await world.terraform.invocations()).toEqual([]);
    await expectNoSecretMaterial(world, result);
  });

  test("a device not deleted stops it part way, exit 2; a rerun finishes it, exit 0", async () => {
    const world = await factory();
    world.statuses[DEVICE] = 500;
    const partial = await teardown(world, "--confirm", FACTORY);
    expect(partial.code).toBe(2);
    expect(partial.stderr).toContain(
      "✖ Teardown stopped part way, at the tailnet devices: Not every Tailscale device of the factory was deleted",
    );
    expect(partial.stderr).toContain(`  Remains: tailnet devices ${DEVICE}`);
    expect(partial.stderr).toContain(`  Remains: owned secrets ${AUTH}, ${ADMIN}`);
    expect(partial.stderr).toContain(`  Remains: the state bucket ${BUCKET}`);
    expect(world.destroyed()).toBe(true);
    expect([...world.secrets.secrets.keys()].sort()).toEqual([ADMIN, AUTH, SOURCE].sort());
    expect(world.s3.stored(BUCKET)).toBeGreaterThan(0);

    // Tailscale deletes devices again, and the factory root's state is now empty.
    delete world.statuses[DEVICE];
    await world.terraform.behave({ plan: { exitCode: 0 }, show: { stdout: EMPTY_PLAN } });
    const rerun = await teardown(world, "--confirm", FACTORY);
    expect(rerun.stderr).toBe("");
    expect(rerun.code).toBe(0);
    expect(rerun.stdout).toContain(
      "  Infrastructure    already absent: the destroy plan destroyed no resource",
    );
    expectNothingOwned(world);
    await expectNoSecretMaterial(world, partial, rerun);
  });
});
