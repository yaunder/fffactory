import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretStore } from "../../src/application/secret-store";
import { run } from "../../src/cli/run";
import { isolatedAwsEnvironment } from "../support/aws-isolation";
import { harness } from "../support/cli-harness";
import { FAKE_CALLER, fakeCallerIdentity } from "../support/doctor-fakes";
import { fakePrompt, fakeSecretStore } from "../support/fake-secrets";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { spawnCli } from "../support/spawn-cli";
import { type StubSecretsManager, stubSecretsManager } from "../support/stub-secrets-manager";
import { EXAMPLE_CREDENTIALS, type StubSts, stubSts } from "../support/stub-sts";

const PATH = "/work/repo/.fffactory/factory.json";
/** A value shaped like a Tailscale auth key, which must never leave the secret store. */
const VALUE = "tskey-auth-kSECRETVALUE-0123456789abcdef";
const DOCUMENT = {
  schema_version: 1,
  factory_id: "fff-abcd1234",
  aws: { account_id: "123456789012", region: "eu-west-2" },
  tailscale: { tag: "tag:factory" },
  hosts: [{ key: "builder-1" }],
};
const ARN =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/tailscale-auth-key-AbCdEf";

function setup(
  options: {
    prompt?: ReturnType<typeof fakePrompt>;
    identity?: ReturnType<typeof fakeCallerIdentity>;
    secrets?: SecretStore;
    document?: object;
  } = {},
) {
  const store = new MemoryInstanceStore({
    [PATH]: `${JSON.stringify(options.document ?? DOCUMENT, null, 2)}\n`,
  });
  const secrets = fakeSecretStore();
  const prompt = options.prompt ?? fakePrompt({ input: `${VALUE}\n` });
  const identity = options.identity ?? fakeCallerIdentity();
  const cli = harness(
    store,
    {},
    {
      secrets: options.secrets ?? secrets.store,
      prompt: prompt.prompt,
      identity: identity.identity,
    },
  );
  /** Everything the command wrote: standard output and error, and every file's contents. */
  const everything = () => [...cli.out, ...cli.err, ...Object.values(store.files)].join("\n");
  return { ...cli, store, secrets, prompt, identity, everything };
}

describe("fffactory secret set", () => {
  test("stores standard input in Secrets Manager and only its ARN in factory.json", async () => {
    const { context, out, err, store, secrets, everything } = setup();
    expect(await run(["secret", "set", "tailscale-auth-key"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([
      `Instance: ${PATH} (nearest .fffactory/factory.json)`,
      "Stored the Tailscale auth key of factory fff-abcd1234 in Secrets Manager as fff-abcd1234/tailscale-auth-key (a new secret).",
      `tailscale.auth_key_secret now refers to it: ${ARN}`,
    ]);
    expect(secrets.writes.map(({ value }) => value)).toEqual([VALUE]);
    expect(JSON.parse(store.files[PATH] ?? "").tailscale.auth_key_secret).toBe(ARN);
    expect(everything()).not.toContain(VALUE);
  });

  test("at a terminal, asks with a hidden prompt; the answer is never printed", async () => {
    const prompt = fakePrompt({ interactive: true, answers: [VALUE] });
    const { context, secrets, everything } = setup({ prompt });
    expect(await run(["secret", "set", "tailscale-auth-key"], context)).toBe(0);
    expect(prompt.hidden).toEqual([
      "Tailscale auth key of factory fff-abcd1234 (input is hidden): ",
    ]);
    expect(secrets.writes.map(({ value }) => value)).toEqual([VALUE]);
    expect(everything()).not.toContain(VALUE);
  });

  test("a second set stores a new value and keeps the reference", async () => {
    const { context, out } = setup();
    await run(["secret", "set", "tailscale-auth-key"], context);
    out.length = 0;
    expect(await run(["secret", "set", "tailscale-auth-key"], context)).toBe(0);
    expect(out.slice(1)).toEqual([
      "Stored the Tailscale auth key of factory fff-abcd1234 in Secrets Manager as fff-abcd1234/tailscale-auth-key (a new value).",
      `tailscale.auth_key_secret already referred to it: ${ARN}`,
    ]);
  });

  test("replaces a different reference without echoing it", async () => {
    const previous = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:hand-made-XyZabc";
    const { context, out } = setup({
      document: { ...DOCUMENT, tailscale: { tag: "tag:factory", auth_key_secret: previous } },
    });
    expect(await run(["secret", "set", "tailscale-auth-key"], context)).toBe(0);
    expect(out.at(-1)).toBe(
      `tailscale.auth_key_secret now refers to it, in place of its previous reference: ${ARN}`,
    );
    expect(out.join("\n")).not.toContain(previous);
  });

  test("stores a host's Paseo password", async () => {
    const { context, out } = setup();
    expect(await run(["secret", "set", "paseo-password", "--host", "builder-1"], context)).toBe(0);
    expect(out.at(-1)).toStartWith("hosts[0].paseo_password_secret now refers to it: ");
  });

  test.each([
    ["the value as an extra argument", ["secret", "set", "tailscale-auth-key", VALUE]],
    ["the value in place of the name", ["secret", "set", VALUE]],
    ["the value as an unknown option", ["secret", "set", "tailscale-auth-key", `--${VALUE}`]],
    ["the value as an option's value", ["secret", "set", `--key=${VALUE}`]],
    ["the value as the host", ["secret", "set", "paseo-password", "--host", VALUE]],
    ["no subcommand", ["secret", VALUE]],
  ])("refuses %s without echoing it or storing anything", async (_, args) => {
    const { context, err, secrets, store, everything } = setup();
    expect(await run(args, context)).toBe(1);
    expect(err.length).toBeGreaterThan(0);
    expect(everything()).not.toContain(VALUE);
    expect(secrets.writes).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  test("refuses another account before reading the secret", async () => {
    const identity = fakeCallerIdentity({
      kind: "caller",
      caller: { ...FAKE_CALLER, account: "210987654321" },
    });
    const prompt = fakePrompt({ input: VALUE });
    const { context, err, secrets } = setup({ identity, prompt });
    expect(await run(["secret", "set", "tailscale-auth-key"], context)).toBe(1);
    expect(err[0]).toBe(
      "Refusing to store the secret: Account 210987654321 is not the factory's account 123456789012",
    );
    expect(err).toContain("  Region: eu-west-2 (factory.json)");
    expect(prompt.limits).toEqual([]);
    expect(secrets.writes).toEqual([]);
  });

  test.each([
    [fakePrompt({ interactive: true, answers: [undefined] }), "Cancelled: nothing was stored."],
    [
      fakePrompt({ input: "" }),
      "No secret was given: the answer or standard input was empty. Nothing was stored.",
    ],
    [
      fakePrompt({ input: "a".repeat(70_000) }),
      "The secret is larger than Secrets Manager's 65536-byte limit. Nothing was stored.",
    ],
  ])("reports why nothing was stored", async (prompt, message) => {
    const { context, err } = setup({ prompt });
    expect(await run(["secret", "set", "tailscale-auth-key"], context)).toBe(1);
    expect(err).toEqual([message]);
  });

  test("reports the ARN when factory.json can no longer take it", async () => {
    let store: MemoryInstanceStore | undefined;
    const inner = fakeSecretStore().store;
    const secrets: SecretStore = {
      write: async (request) => {
        if (store) store.files[PATH] = '{"schema_version": 2}';
        return inner.write(request);
      },
    };
    const cli = setup({ secrets });
    store = cli.store;
    expect(await run(["secret", "set", "tailscale-auth-key"], cli.context)).toBe(1);
    expect(cli.err).toEqual([
      "Stored the Tailscale auth key of factory fff-abcd1234 in Secrets Manager as fff-abcd1234/tailscale-auth-key, but factory.json changed meanwhile and no longer takes the reference. " +
        `Set tailscale.auth_key_secret to ${ARN} yourself.`,
    ]);
  });

  test("refuses when factory.json pins another release (plan-apply §CLI/pin match guard)", async () => {
    const { context, err, secrets, identity } = setup({
      document: { ...DOCUMENT, release: "0.2.0" },
    });
    expect(await run(["secret", "set", "tailscale-auth-key"], context)).toBe(1);
    expect(err).toEqual([
      "Refusing to store the secret: factory.json pins another fffactory release than this " +
        "one, 0.3.0: only the pinned release may plan or change this factory. Install the " +
        "release factory.json pins, or move the pin to 0.3.0 with `fffactory upgrade`.",
    ]);
    expect(identity.requests).toEqual([]);
    expect(secrets.writes).toEqual([]);
  });

  test("refuses an unknown host by its key", async () => {
    const { context, err } = setup();
    expect(await run(["secret", "set", "paseo-password", "--host", "builder-9"], context)).toBe(1);
    expect(err).toEqual(['fffactory secret set: host "builder-9" is not declared in factory.json']);
  });

  test("refuses an invalid factory.json", async () => {
    const { context, err } = setup({ document: { schema_version: 2 } });
    expect(await run(["secret", "set", "tailscale-auth-key"], context)).toBe(1);
    expect(err[0]).toBe("Invalid factory.json:");
  });

  test("refuses when there is no instance", async () => {
    const { context, err } = harness(new MemoryInstanceStore());
    expect(await run(["secret", "set", "tailscale-auth-key"], context)).toBe(1);
    expect(err.join("\n")).toContain("fffactory init");
  });

  test("rejects an empty --profile", async () => {
    const { context, err } = setup();
    expect(await run(["secret", "set", "tailscale-auth-key", "--profile", ""], context)).toBe(1);
    expect(err).toEqual(["fffactory secret set: --profile needs a profile name"]);
  });

  test("is listed in the command usage and prints its own usage", async () => {
    const { context, out } = setup();
    expect(await run(["--help"], context)).toBe(0);
    expect(out.some((line) => line.startsWith("  secret "))).toBe(true);
    const help = setup();
    expect(await run(["secret", "--help"], help.context)).toBe(0);
    expect(help.out[0]).toBe(
      "Usage: fffactory secret set NAME [--host KEY] [--instance PATH] [--profile NAME]",
    );
  });
});

describe("fffactory secret set, spawned with the real SDK against local stubs", () => {
  let scratch: string;
  let sts: StubSts | undefined;
  let secretsManager: StubSecretsManager | undefined;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fffactory-secret-"));
  });

  afterEach(() => {
    sts?.stop();
    secretsManager?.stop();
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("the secret reaches Secrets Manager and never stdout, stderr, argv or factory.json", async () => {
    sts = stubSts({
      kind: "caller",
      account: "123456789012",
      arn: "arn:aws:sts::123456789012:assumed-role/FactoryAdmin/operator",
    });
    secretsManager = stubSecretsManager();
    const instance = join(scratch, "factory.json");
    await writeFile(instance, `${JSON.stringify(DOCUMENT, null, 2)}\n`);
    const credentials = join(scratch, "credentials");
    await writeFile(
      credentials,
      `[default]\naws_access_key_id = ${EXAMPLE_CREDENTIALS.accessKeyId}\n` +
        `aws_secret_access_key = ${EXAMPLE_CREDENTIALS.secretAccessKey}\n`,
    );
    const args = ["secret", "set", "tailscale-auth-key", "--instance", instance];
    const result = await spawnCli(args, {
      cwd: scratch,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scratch,
        ...isolatedAwsEnvironment(scratch),
        AWS_SHARED_CREDENTIALS_FILE: credentials,
        AWS_ENDPOINT_URL_STS: sts.endpoint,
        AWS_ENDPOINT_URL_SECRETS_MANAGER: secretsManager.endpoint,
      },
      stdin: `${VALUE}\n`,
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`tailscale.auth_key_secret now refers to it: ${ARN}`);
    expect(secretsManager.secrets.get("fff-abcd1234/tailscale-auth-key")).toEqual([VALUE]);
    const written = await readFile(instance, "utf8");
    expect(JSON.parse(written).tailscale.auth_key_secret).toBe(ARN);
    for (const output of [result.stdout, result.stderr, written, args.join(" ")])
      expect(output).not.toContain(VALUE);
    expect(sts.requests).toHaveLength(1);
  });
});
