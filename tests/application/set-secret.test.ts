import { describe, expect, test } from "bun:test";
import { type SetSecretRequest, setSecret } from "../../src/application/set-secret";
import type { Release } from "../../src/domain/instance";
import { MAX_SECRET_BYTES } from "../../src/domain/secrets";
import { FAKE_CALLER, fakeCallerIdentity } from "../support/doctor-fakes";
import { fakePrompt, fakeSecretStore } from "../support/fake-secrets";
import { MemoryInstanceStore } from "../support/memory-instance-store";

const PATH = "/work/.fffactory/factory.json";
const VALUE = "tskey-auth-kSECRETVALUE-0123456789";
const ARN =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/tailscale-auth-key-AbCdEf";

const DOCUMENT = {
  schema_version: 1,
  factory_id: "fff-abcd1234",
  aws: { account_id: "123456789012", region: "eu-west-2" },
  tailscale: { tag: "tag:factory" },
  hosts: [{ key: "builder-1" }],
};

function files(document: object = DOCUMENT) {
  return new MemoryInstanceStore({ [PATH]: `${JSON.stringify(document, null, 2)}\n` });
}

function request(overrides: Partial<SetSecretRequest> = {}): SetSecretRequest {
  return {
    path: PATH,
    name: "tailscale-auth-key",
    host: undefined,
    credentials: { source: "chain" },
    release: "0.3.0" as Release,
    ...overrides,
  };
}

function setup(
  options: {
    store?: MemoryInstanceStore;
    prompt?: ReturnType<typeof fakePrompt>;
    identity?: ReturnType<typeof fakeCallerIdentity>;
  } = {},
) {
  const store = options.store ?? files();
  const secrets = fakeSecretStore();
  const prompt = options.prompt ?? fakePrompt({ input: `${VALUE}\n` });
  const identity = options.identity ?? fakeCallerIdentity();
  const deps = {
    identity: identity.identity,
    store,
    secrets: secrets.store,
    prompt: prompt.prompt,
  };
  return { deps, store, secrets, prompt, identity };
}

describe("setSecret", () => {
  test("stores standard input in Secrets Manager and only its ARN in factory.json", async () => {
    const { deps, store, secrets } = setup();
    const result = await setSecret(deps, request());
    expect(result).toMatchObject({ kind: "stored", arn: ARN, created: true, reference: "added" });
    expect(secrets.writes).toEqual([
      {
        name: "fff-abcd1234/tailscale-auth-key",
        description: "Tailscale auth key of factory fff-abcd1234",
        tags: { "fffactory:factory-id": "fff-abcd1234", "fffactory:managed-by": "fffactory" },
        region: "eu-west-2",
        credentials: { source: "chain" },
        value: VALUE,
      },
    ]);
    const written = store.files[PATH] ?? "";
    expect(JSON.parse(written).tailscale).toEqual({ tag: "tag:factory", auth_key_secret: ARN });
    expect(written).not.toContain(VALUE);
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  test("at a terminal, reads the material from a hidden prompt", async () => {
    const prompt = fakePrompt({ interactive: true, answers: [VALUE] });
    const { deps, secrets } = setup({ prompt });
    const result = await setSecret(deps, request());
    expect(result.kind).toBe("stored");
    expect(prompt.hidden).toEqual([
      "Tailscale auth key of factory fff-abcd1234 (input is hidden): ",
    ]);
    expect(prompt.asked).toEqual([]);
    expect(prompt.limits).toEqual([]);
    expect(secrets.writes[0]?.value).toBe(VALUE);
  });

  test("a Paseo password is stored for its host", async () => {
    const { deps, store, secrets } = setup();
    const result = await setSecret(deps, request({ name: "paseo-password", host: "builder-1" }));
    expect(result).toMatchObject({ kind: "stored", reference: "added" });
    expect(secrets.writes[0]?.name).toBe("fff-abcd1234/builder-1/paseo-password");
    expect(JSON.parse(store.files[PATH] ?? "").hosts).toEqual([
      {
        key: "builder-1",
        paseo_password_secret:
          "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-abcd1234/builder-1/paseo-password-AbCdEf",
      },
    ]);
  });

  test("setting it again stores a new value and leaves factory.json as it is", async () => {
    const { deps, store } = setup();
    await setSecret(deps, request());
    const writes = store.writes.length;
    const again = await setSecret(deps, request());
    expect(again).toMatchObject({ kind: "stored", created: false, reference: "unchanged" });
    expect(store.writes).toHaveLength(writes);
  });

  test("a different reference already in factory.json is replaced", async () => {
    const other = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:hand-made-XyZabc";
    const { deps, store } = setup({
      store: files({ ...DOCUMENT, tailscale: { tag: "tag:factory", auth_key_secret: other } }),
    });
    const result = await setSecret(deps, request());
    expect(result).toMatchObject({ kind: "stored", reference: "replaced" });
    expect(JSON.parse(store.files[PATH] ?? "").tailscale.auth_key_secret).toBe(ARN);
  });

  test("the account check comes before any material is read or written", async () => {
    const identity = fakeCallerIdentity({
      kind: "caller",
      caller: { ...FAKE_CALLER, account: "210987654321" },
    });
    const prompt = fakePrompt({ input: VALUE });
    const { deps, secrets, store } = setup({ identity, prompt });
    const result = await setSecret(deps, request());
    expect(result).toMatchObject({
      kind: "wrong_account",
      requirement: { allowed: false, verdict: { kind: "mismatch", expected: "123456789012" } },
    });
    expect(identity.requests).toEqual([{ credentials: { source: "chain" }, region: "eu-west-2" }]);
    expect(prompt.limits).toEqual([]);
    expect(secrets.writes).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  test.each([
    [
      "a missing factory ID",
      { ...DOCUMENT, factory_id: undefined },
      "factory.json needs factory_id before a secret can be named",
    ],
    [
      "a missing Region",
      { ...DOCUMENT, aws: { account_id: "123456789012" } },
      "factory.json needs aws.region: secrets are stored in the factory Region",
    ],
  ])("refuses %s before reaching AWS", async (_, document, message) => {
    const { deps, identity, secrets } = setup({ store: files(document) });
    expect(await setSecret(deps, request())).toEqual({ kind: "refused", message });
    expect(identity.requests).toEqual([]);
    expect(secrets.writes).toEqual([]);
  });

  test("the CLI/pin match guard refuses another release before reaching AWS (plan-apply §CLI/pin match guard)", async () => {
    const { deps, identity, secrets, store, prompt } = setup({
      store: files({ ...DOCUMENT, release: "0.2.0" }),
    });
    const result = await setSecret(deps, request());
    expect(result).toMatchObject({ kind: "release_mismatch" });
    expect(result.kind === "release_mismatch" && result.message).toStartWith(
      "factory.json pins another fffactory release than this one, 0.3.0:",
    );
    expect(identity.requests).toEqual([]);
    expect(prompt.limits).toEqual([]);
    expect(secrets.writes).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  test("the pinned release, or a factory.json that pins none yet, may store a secret", async () => {
    for (const release of ["0.3.0", undefined]) {
      const { deps } = setup({ store: files({ ...DOCUMENT, release }) });
      expect((await setSecret(deps, request())).kind).toBe("stored");
    }
  });

  test("an invalid factory.json is refused with its issues", async () => {
    const { deps, identity } = setup({ store: files({ schema_version: 2 }) });
    const result = await setSecret(deps, request());
    expect(result).toMatchObject({ kind: "invalid", issues: [{ path: "schema_version" }] });
    expect(identity.requests).toEqual([]);
  });

  test.each([
    ["a cancelled prompt", fakePrompt({ interactive: true, answers: [undefined] }), "cancelled"],
    ["an empty prompt answer", fakePrompt({ interactive: true, answers: [""] }), "empty"],
    ["empty standard input", fakePrompt({ input: "\n" }), "empty"],
    [
      "oversized standard input",
      fakePrompt({ input: "a".repeat(MAX_SECRET_BYTES + 3) }),
      "too_large",
    ],
  ])("%s stores nothing", async (_, prompt, reason) => {
    const { deps, secrets, store } = setup({ prompt });
    expect((await setSecret(deps, request())) as unknown).toEqual({ kind: "no_material", reason });
    expect(secrets.writes).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  test("standard input may carry one line ending past the size limit", async () => {
    const prompt = fakePrompt({ input: `${"a".repeat(MAX_SECRET_BYTES)}\r\n` });
    const { deps } = setup({ prompt });
    expect((await setSecret(deps, request())).kind).toBe("stored");
    expect(prompt.limits).toEqual([MAX_SECRET_BYTES + 2]);
  });

  test("a factory.json that became invalid meanwhile keeps its contents; the ARN is reported", async () => {
    const { deps, store } = setup();
    const invalid = '{"schema_version": 2}\n';
    const write = deps.secrets.write;
    const racing = {
      ...deps,
      secrets: {
        write: async (...args: Parameters<typeof write>) => {
          store.files[PATH] = invalid;
          return write(...args);
        },
      },
    };
    const result = await setSecret(racing, request());
    expect(result).toMatchObject({ kind: "stored_unreferenced", arn: ARN });
    expect(store.files[PATH]).toBe(invalid);
  });

  test("a host removed meanwhile keeps factory.json as it is; the ARN is reported", async () => {
    const { deps, store } = setup();
    const write = deps.secrets.write;
    const racing = {
      ...deps,
      secrets: {
        write: async (...args: Parameters<typeof write>) => {
          store.files[PATH] = `${JSON.stringify({ ...DOCUMENT, hosts: [] })}\n`;
          return write(...args);
        },
      },
    };
    const result = await setSecret(racing, request({ name: "paseo-password", host: "builder-1" }));
    expect(result.kind).toBe("stored_unreferenced");
    expect(store.writes).toEqual([]);
  });
});
