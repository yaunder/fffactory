import { afterEach, describe, expect, test } from "bun:test";
import type { SecretWrite } from "../../src/application/secret-store";
import type { FactoryId, SecretReference } from "../../src/domain/instance";
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
  stubArn,
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
      getSecretValue: async (input) => {
        calls.push(`GetSecretValue ${input.SecretId}`);
        return { ARN, SecretString: VALUE };
      },
      listSecrets: async (input) => {
        calls.push(`ListSecrets ${input.NextToken ?? "-"}`);
        return { SecretList: [] };
      },
      restoreSecret: async (input) => {
        calls.push(`RestoreSecret ${input.SecretId}`);
        return {};
      },
      deleteSecret: async (input) => {
        calls.push(`DeleteSecret ${input.SecretId} ${input.ForceDeleteWithoutRecovery}`);
        return {};
      },
      describeSecret: async (input) => {
        calls.push(`DescribeSecret ${input.SecretId}`);
        return {};
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

describe("reading a secret (secrets §The Tailscale admin client)", () => {
  const LOOKUP = {
    reference: ARN,
    region: "eu-west-2",
    credentials: { source: "--profile", profile: "factory" },
  } as const;

  test("reads the secret by its ARN in the factory Region, as SecretMaterial", async () => {
    const stub = stubbed();
    const material = await secretsManagerStore(stub.open).read(LOOKUP);
    expect(material).toBeInstanceOf(SecretMaterial);
    expect(material.reveal()).toBe(VALUE);
    expect(String(material)).toBe("[secret]");
    expect(stub.calls).toEqual([`GetSecretValue ${ARN}`, "close"]);
    expect(stub.sessions.map(({ region, profile }) => ({ region, profile }))).toEqual([
      { region: "eu-west-2", profile: "factory" },
    ]);
  });

  test("a secret without a text value is refused", async () => {
    const stub = stubbed({ getSecretValue: async () => ({ ARN }) });
    await expect(secretsManagerStore(stub.open).read(LOOKUP)).rejects.toThrow(
      "Secrets Manager holds no text value for the secret",
    );
  });

  test("a failure is named, never quoted", async () => {
    const stub = stubbed({
      getSecretValue: async () => {
        throw sdkError("AccessDeniedException");
      },
    });
    const error = await secretsManagerStore(stub.open)
      .read(LOOKUP)
      .catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      "Reading the secret from Secrets Manager failed: AccessDeniedException",
    );
    expect(JSON.stringify(error)).not.toContain(VALUE);
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

  test("reads back the current value of a secret by its ARN", async () => {
    const store = againstStub();
    await store.write(WRITE);
    await store.write({ ...WRITE, material: new SecretMaterial("second") });
    const read = await store.read({
      reference: ARN,
      region: "eu-west-2",
      credentials: { source: "chain" },
    });
    expect(read.reveal()).toBe("second");
    expect(stub?.requests.at(-1)).toEqual({
      operation: "GetSecretValue",
      body: { SecretId: ARN },
    });
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

const FACTORY_ID = "fff-abcd1234" as FactoryId;
const TAGS = { "fffactory:factory-id": "fff-abcd1234", "fffactory:managed-by": "fffactory" };
const LOOKUP = {
  reference: ARN,
  region: "eu-west-2",
  credentials: { source: "chain" },
} as const;
const LIST = {
  factoryId: FACTORY_ID,
  region: "eu-west-2",
  credentials: { source: "chain" },
} as const;

describe("deleting a factory's secrets over stubbed calls (secrets §Deleting a factory's secrets)", () => {
  test("lists by the factory-ID tag, scheduled secrets included, every page", async () => {
    const inputs: unknown[] = [];
    const pages = [
      {
        SecretList: [
          {
            ARN,
            Name: NAME,
            Tags: [
              { Key: "fffactory:factory-id", Value: "fff-abcd1234" },
              { Key: "fffactory:managed-by", Value: "fffactory" },
            ],
          },
        ],
        NextToken: "page-2",
      },
      { SecretList: [], NextToken: "page-3" },
      {
        SecretList: [
          {
            ARN: stubArn("fffv/github-token"),
            Name: "fffv/github-token",
            Tags: [{ Key: "fffactory:factory-id" }],
            DeletedDate: new Date("2026-10-20T00:00:00Z"),
          },
        ],
      },
    ];
    const stub = stubbed({
      listSecrets: async (input) => {
        inputs.push(input);
        return pages[inputs.length - 1] ?? {};
      },
    });
    const listing = await secretsManagerStore(stub.open).list(LIST);
    expect(listing).toEqual({
      kind: "listed",
      secrets: [
        { name: NAME, arn: ARN, tags: TAGS, pendingDeletion: false },
        {
          name: "fffv/github-token",
          arn: stubArn("fffv/github-token") as SecretReference,
          tags: { "fffactory:factory-id": "" },
          pendingDeletion: true,
        },
      ],
    });
    const filters = [
      { Key: "tag-key", Values: ["fffactory:factory-id"] },
      { Key: "tag-value", Values: ["fff-abcd1234"] },
    ];
    expect(inputs).toEqual([
      { Filters: filters, IncludePlannedDeletion: true, MaxResults: 100, NextToken: undefined },
      { Filters: filters, IncludePlannedDeletion: true, MaxResults: 100, NextToken: "page-2" },
      { Filters: filters, IncludePlannedDeletion: true, MaxResults: 100, NextToken: "page-3" },
    ]);
    expect(stub.calls).toEqual(["close"]);
  });

  test("a listed secret without a usable name or ARN fails the listing", async () => {
    const stub = stubbed({
      listSecrets: async () => ({ SecretList: [{ ARN: "not-an-arn", Name: NAME }] }),
    });
    expect(await secretsManagerStore(stub.open).list(LIST)).toEqual({
      kind: "failed",
      reason: "Secrets Manager listed a secret without a usable name or ARN",
    });
  });

  test("a listing that fails is named, never quoted", async () => {
    const stub = stubbed({
      listSecrets: async () => {
        throw sdkError("AccessDeniedException");
      },
    });
    expect(await secretsManagerStore(stub.open).list(LIST)).toEqual({
      kind: "failed",
      reason: "Secrets Manager ListSecrets failed: AccessDeniedException",
    });
  });

  test("restores and deletes by ARN, the deletion without a recovery window", async () => {
    const stub = stubbed();
    const store = secretsManagerStore(stub.open);
    expect(await store.restore(LOOKUP)).toEqual({ kind: "done" });
    expect(await store.remove(LOOKUP)).toEqual({ kind: "done" });
    expect(stub.calls).toEqual([
      `RestoreSecret ${ARN}`,
      "close",
      `DeleteSecret ${ARN} true`,
      "close",
    ]);
  });

  test("DescribeSecret's answer is present; ResourceNotFoundException is absent", async () => {
    const stub = stubbed();
    expect(await secretsManagerStore(stub.open).exists(LOOKUP)).toEqual({ kind: "present" });
    const gone = stubbed({
      describeSecret: async () => {
        throw sdkError("ResourceNotFoundException");
      },
      restoreSecret: async () => {
        throw sdkError("ResourceNotFoundException");
      },
      deleteSecret: async () => {
        throw sdkError("ResourceNotFoundException");
      },
    });
    const store = secretsManagerStore(gone.open);
    expect(await store.exists(LOOKUP)).toEqual({ kind: "absent" });
    expect(await store.describe(LOOKUP)).toEqual({ kind: "absent" });
    expect(await store.restore(LOOKUP)).toEqual({ kind: "absent" });
    expect(await store.remove(LOOKUP)).toEqual({ kind: "absent" });
  });

  test("every other failure is failed, by its name, never quoting AWS", async () => {
    const denied = async () => {
      throw sdkError("AccessDeniedException");
    };
    const stub = stubbed({ restoreSecret: denied, deleteSecret: denied, describeSecret: denied });
    const store = secretsManagerStore(stub.open);
    const results = [
      await store.restore(LOOKUP),
      await store.remove(LOOKUP),
      await store.exists(LOOKUP),
      await store.describe(LOOKUP),
    ];
    expect(results).toEqual([
      { kind: "failed", reason: "Secrets Manager RestoreSecret failed: AccessDeniedException" },
      { kind: "failed", reason: "Secrets Manager DeleteSecret failed: AccessDeniedException" },
      { kind: "failed", reason: "Secrets Manager DescribeSecret failed: AccessDeniedException" },
      { kind: "failed", reason: "Secrets Manager DescribeSecret failed: AccessDeniedException" },
    ]);
    expect(JSON.stringify(results)).not.toContain(VALUE);
  });

  test("InvalidRequestException on a deletion is invalid, by its name; on any other call failed", async () => {
    const invalid = async () => {
      throw sdkError("InvalidRequestException");
    };
    const stub = stubbed({
      restoreSecret: invalid,
      deleteSecret: invalid,
      describeSecret: invalid,
    });
    const store = secretsManagerStore(stub.open);
    const results = [
      await store.remove(LOOKUP),
      await store.restore(LOOKUP),
      await store.exists(LOOKUP),
    ];
    expect(results).toEqual([
      { kind: "invalid", reason: "Secrets Manager DeleteSecret failed: InvalidRequestException" },
      { kind: "failed", reason: "Secrets Manager RestoreSecret failed: InvalidRequestException" },
      { kind: "failed", reason: "Secrets Manager DescribeSecret failed: InvalidRequestException" },
    ]);
    expect(JSON.stringify(results)).not.toContain(VALUE);
  });

  test("DescribeSecret's answer describes the secret by name, ARN, tags and deleted date", async () => {
    const stub = stubbed({
      describeSecret: async (input) => {
        stub.calls.push(`DescribeSecret ${input.SecretId}`);
        return {
          ARN,
          Name: NAME,
          Tags: [
            { Key: "fffactory:factory-id", Value: "fff-abcd1234" },
            { Key: "fffactory:managed-by", Value: "fffactory" },
          ],
          DeletedDate: new Date("2026-10-21T00:00:00Z"),
        };
      },
    });
    expect(await secretsManagerStore(stub.open).describe(LOOKUP)).toEqual({
      kind: "found",
      secret: { name: NAME, arn: ARN, tags: TAGS, pendingDeletion: true },
    });
    expect(stub.calls).toEqual([`DescribeSecret ${ARN}`, "close"]);
    expect(stub.sessions.map(({ region }) => region)).toEqual(["eu-west-2"]);
  });

  test("a description without a usable name or ARN is unusable, never judged", async () => {
    const answers = [{ Name: NAME }, { ARN: "not an ARN", Name: NAME }, { ARN }];
    for (const answer of answers) {
      const stub = stubbed({ describeSecret: async () => answer });
      expect(await secretsManagerStore(stub.open).describe(LOOKUP)).toEqual({ kind: "unusable" });
    }
  });

  test("a call past its deadline is failed: it is no proof of deletion", async () => {
    const stub = stubbed({ deleteSecret: () => new Promise(() => {}) });
    expect(await secretsManagerStore(stub.open, 20).remove(LOOKUP)).toEqual({
      kind: "failed",
      reason: "Secrets Manager DeleteSecret failed: timed out after 0.02 s",
    });
  });
});

describe("deleting a factory's secrets with the real SDK against a local stub", () => {
  let stub: StubSecretsManager | undefined;

  afterEach(() => {
    stub?.stop();
    stub = undefined;
  });

  function againstStub(options: StubSecretsManagerOptions = {}, timeoutMs?: number) {
    stub = stubSecretsManager(options);
    const config = { endpoint: stub.endpoint, credentials: EXAMPLE_CREDENTIALS };
    return { store: secretsManagerStore(sdkSecretsManagerCalls(config), timeoutMs), stub };
  }

  test("lists the tagged secrets across pages, scheduled ones included, with their tags", async () => {
    const { store, stub } = againstStub({ pageSize: 2 });
    stub.add(NAME, TAGS);
    stub.add("fff-abcd1234/github-token", TAGS, true);
    stub.add("other/github-token", { "fffactory:factory-id": "other" });
    stub.add("fffv/anthropic-api-key", { "fffactory:factory-id": "fff-abcd1234" });
    stub.add("fff-abcd1234-lab/github-token", {
      ...TAGS,
      "fffactory:factory-id": "fff-abcd1234-lab",
    });
    stub.add("untagged", {});
    const listing = await store.list(LIST);
    expect(listing).toEqual({
      kind: "listed",
      secrets: [
        { name: NAME, arn: ARN, tags: TAGS, pendingDeletion: false },
        {
          name: "fff-abcd1234/github-token",
          arn: stubArn("fff-abcd1234/github-token") as SecretReference,
          tags: TAGS,
          pendingDeletion: true,
        },
        {
          name: "fffv/anthropic-api-key",
          arn: stubArn("fffv/anthropic-api-key") as SecretReference,
          tags: { "fffactory:factory-id": "fff-abcd1234" },
          pendingDeletion: false,
        },
        {
          name: "fff-abcd1234-lab/github-token",
          arn: stubArn("fff-abcd1234-lab/github-token") as SecretReference,
          tags: { ...TAGS, "fffactory:factory-id": "fff-abcd1234-lab" },
          pendingDeletion: false,
        },
      ],
    });
    const lists = stub.requests.filter(({ operation }) => operation === "ListSecrets");
    expect(lists.map(({ body }) => body.NextToken)).toEqual([undefined, "2"]);
    expect(lists[0]?.body).toMatchObject({ IncludePlannedDeletion: true, MaxResults: 100 });
  });

  test("a secret scheduled for deletion cannot be force-deleted until it is restored", async () => {
    const { store, stub } = againstStub();
    stub.add(NAME, TAGS, true);
    expect(await store.remove(LOOKUP)).toEqual({
      kind: "invalid",
      reason: "Secrets Manager DeleteSecret failed: InvalidRequestException",
    });
    expect(await store.exists(LOOKUP)).toEqual({ kind: "present" });
    expect(await store.restore(LOOKUP)).toEqual({ kind: "done" });
    expect(await store.remove(LOOKUP)).toEqual({ kind: "done" });
    expect(await store.exists(LOOKUP)).toEqual({ kind: "absent" });
    expect(stub.requests.at(-2)).toEqual({
      operation: "DeleteSecret",
      body: { SecretId: ARN, ForceDeleteWithoutRecovery: true },
    });
    expect(stub.requests.at(-1)).toEqual({ operation: "DescribeSecret", body: { SecretId: ARN } });
  });

  test("a forced deletion is described until Secrets Manager finishes it", async () => {
    const { store, stub } = againstStub({ lingering: 2 });
    stub.add(NAME, TAGS);
    expect(await store.remove(LOOKUP)).toEqual({ kind: "done" });
    expect(await store.exists(LOOKUP)).toEqual({ kind: "present" });
    expect(await store.exists(LOOKUP)).toEqual({ kind: "present" });
    expect(await store.exists(LOOKUP)).toEqual({ kind: "absent" });
    expect(await store.restore(LOOKUP)).toEqual({ kind: "absent" });
  });

  test("a forced deletion of a secret already gone succeeds, so only the look proves absence", async () => {
    const { store } = againstStub();
    expect(await store.remove(LOOKUP)).toEqual({ kind: "done" });
    expect(await store.exists(LOOKUP)).toEqual({ kind: "absent" });
  });

  test("AccessDenied is failed, by its name", async () => {
    const { store, stub } = againstStub({
      failing: { ListSecrets: "AccessDeniedException", DescribeSecret: "AccessDeniedException" },
    });
    stub.add(NAME, TAGS);
    expect(await store.list(LIST)).toEqual({
      kind: "failed",
      reason: "Secrets Manager ListSecrets failed: AccessDeniedException",
    });
    expect(await store.exists(LOOKUP)).toEqual({
      kind: "failed",
      reason: "Secrets Manager DescribeSecret failed: AccessDeniedException",
    });
  });

  test("describes a secret the listing would not show: its tags, scheduled or not, or absent", async () => {
    const { store, stub } = againstStub();
    stub.add(NAME, TAGS, true);
    stub.add("fff-abcd1234/hand-made", {});
    expect(await store.describe(LOOKUP)).toEqual({
      kind: "found",
      secret: { name: NAME, arn: ARN, tags: TAGS, pendingDeletion: true },
    });
    const handMade = stubArn("fff-abcd1234/hand-made") as SecretReference;
    expect(await store.describe({ ...LOOKUP, reference: handMade })).toEqual({
      kind: "found",
      secret: { name: "fff-abcd1234/hand-made", arn: handMade, tags: {}, pendingDeletion: false },
    });
    const gone = stubArn("fff-abcd1234/github-token") as SecretReference;
    expect(await store.describe({ ...LOOKUP, reference: gone })).toEqual({ kind: "absent" });
    expect(stub.requests.at(0)).toEqual({ operation: "DescribeSecret", body: { SecretId: ARN } });
    // A description carries no value: the stub's secret value never leaves it.
    expect(JSON.stringify(await store.describe(LOOKUP))).not.toContain("stub value");
  });

  test("a description refused is failed, by its name", async () => {
    const { store, stub } = againstStub({ failing: { DescribeSecret: "AccessDeniedException" } });
    stub.add(NAME, TAGS);
    expect(await store.describe(LOOKUP)).toEqual({
      kind: "failed",
      reason: "Secrets Manager DescribeSecret failed: AccessDeniedException",
    });
  });

  test("a stub that never answers is failed at the deadline", async () => {
    const { store } = againstStub({ hang: true }, 300);
    expect(await store.exists(LOOKUP)).toEqual({
      kind: "failed",
      reason: "Secrets Manager DescribeSecret failed: timed out after 0.3 s",
    });
  });
});
