import { afterEach, describe, expect, test } from "bun:test";
import type { SecretWrite } from "../../src/application/secret-store";
import type { SecretReference } from "../../src/domain/instance";
import { SecretMaterial } from "../../src/domain/secrets";
import {
  SECRETS_MANAGER_TIMEOUT_MS,
  type SecretsManagerCalls,
  sdkSecretsManagerCalls,
  secretsManagerStore,
} from "../../src/infrastructure/aws-secrets-manager-store";
import type { AwsSession } from "../../src/infrastructure/aws-session";
import {
  type StubSecretsManager,
  type StubSecretsManagerOptions,
  stubSecretsManager,
} from "../support/stub-secrets-manager";
import { EXAMPLE_CREDENTIALS } from "../support/stub-sts";

const VALUE = "tskey-auth-kSECRETVALUE-0123456789";
const NAME = "fff-abcd1234/tailscale-auth-key";
const ARN =
  `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${NAME}-AbCdEf` as SecretReference;

const WRITE: SecretWrite = {
  name: NAME,
  description: "Tailscale auth key of factory fff-abcd1234",
  tags: { "fffactory:factory-id": "fff-abcd1234", "fffactory:managed-by": "fffactory" },
  material: new SecretMaterial(VALUE),
  region: "eu-west-2",
  credentials: { source: "chain" },
};

function sdkError(name: string, extra: Record<string, unknown> = { $fault: "client" }) {
  return Object.assign(new Error(`AWS message echoing ${VALUE}`), { name, ...extra });
}

function stubbed(script: Partial<SecretsManagerCalls> = {}) {
  const sessions: AwsSession[] = [];
  const calls: string[] = [];
  const open = async (session: AwsSession): Promise<SecretsManagerCalls> => {
    sessions.push(session);
    return {
      createSecret: async (input) => {
        calls.push(`CreateSecret ${input.Name}`);
        return { ARN };
      },
      putSecretValue: async (input) => {
        calls.push(`PutSecretValue ${input.SecretId}`);
        return { ARN };
      },
      ...script,
      close: () => calls.push("close"),
    };
  };
  return { open, sessions, calls };
}

describe("Secrets Manager store over stubbed calls", () => {
  test("creates the secret in the factory Region with the selected profile", async () => {
    const stub = stubbed();
    const stored = await secretsManagerStore(stub.open).write({
      ...WRITE,
      credentials: { source: "AWS_PROFILE", profile: "factory" },
    });
    expect(stored).toEqual({ arn: ARN, created: true });
    expect(stub.sessions.map(({ region, profile }) => ({ region, profile }))).toEqual([
      { region: "eu-west-2", profile: "factory" },
    ]);
    expect(stub.calls).toEqual([`CreateSecret ${NAME}`, "close"]);
  });

  test("an existing secret gets a new value instead", async () => {
    const stub = stubbed({
      createSecret: async () => {
        throw sdkError("ResourceExistsException");
      },
    });
    expect(await secretsManagerStore(stub.open).write(WRITE)).toEqual({ arn: ARN, created: false });
    expect(stub.calls).toEqual([`PutSecretValue ${NAME}`, "close"]);
  });

  test("an answer without a secret ARN is refused", async () => {
    const stub = stubbed({ createSecret: async () => ({ ARN: "not-an-arn" }) });
    await expect(secretsManagerStore(stub.open).write(WRITE)).rejects.toThrow(
      "Secrets Manager returned no usable secret ARN",
    );
  });

  test("a failure is named, never quoted, so the material cannot leak through it", async () => {
    const stub = stubbed({
      createSecret: async () => {
        throw sdkError("AccessDeniedException");
      },
    });
    const error = await secretsManagerStore(stub.open)
      .write(WRITE)
      .catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      "Storing the secret in Secrets Manager failed: AccessDeniedException",
    );
    expect(JSON.stringify(error)).not.toContain(VALUE);
    expect(SECRETS_MANAGER_TIMEOUT_MS).toBe(30_000);
  });
});

describe("Secrets Manager store with the real SDK against a local stub", () => {
  let stub: StubSecretsManager | undefined;

  afterEach(() => {
    stub?.stop();
    stub = undefined;
  });

  function againstStub(options: StubSecretsManagerOptions = {}, timeoutMs?: number) {
    stub = stubSecretsManager(options);
    const config = { endpoint: stub.endpoint, credentials: EXAMPLE_CREDENTIALS };
    return secretsManagerStore(sdkSecretsManagerCalls(config), timeoutMs);
  }

  test("creates a tagged secret, then adds values to it", async () => {
    const store = againstStub();
    expect(await store.write(WRITE)).toEqual({ arn: ARN, created: true });
    expect(await store.write({ ...WRITE, material: new SecretMaterial("second") })).toEqual({
      arn: ARN,
      created: false,
    });
    expect(stub?.secrets.get(NAME)).toEqual([VALUE, "second"]);
    const [create, ...rest] = stub?.requests ?? [];
    expect(create?.operation).toBe("CreateSecret");
    expect(create?.body).toMatchObject({
      Name: NAME,
      Description: "Tailscale auth key of factory fff-abcd1234",
      SecretString: VALUE,
      Tags: [
        { Key: "fffactory:factory-id", Value: "fff-abcd1234" },
        { Key: "fffactory:managed-by", Value: "fffactory" },
      ],
    });
    expect(rest.map(({ operation }) => operation)).toEqual(["CreateSecret", "PutSecretValue"]);
  });

  test("a service error is reported by its type", async () => {
    const store = againstStub({ error: "AccessDeniedException" });
    await expect(store.write(WRITE)).rejects.toThrow(
      "Storing the secret in Secrets Manager failed: AccessDeniedException",
    );
  });

  test("a stub that never answers times out", async () => {
    const store = againstStub({ hang: true }, 300);
    await expect(store.write(WRITE)).rejects.toThrow("timed out after 0.3 s");
  });
});
