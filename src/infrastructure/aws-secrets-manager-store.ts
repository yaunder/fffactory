import type {
  FilterNameStringType,
  SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import type {
  SecretDescription,
  SecretListing,
  SecretListRequest,
  SecretLookup,
  SecretPresence,
  SecretRemoval,
  SecretStore,
} from "../application/secret-store";
import { parseSecretReference, type SecretReference } from "../domain/instance";
import { FACTORY_ID_TAG } from "../domain/resource-naming";
import { type ListedSecret, SecretMaterial } from "../domain/secrets";
import {
  AdapterRefusal,
  type AwsCalls,
  AwsFailure,
  clientSettings,
  errorName,
  type OpenCalls,
  withAwsSession,
} from "./aws-session";

/**
 * Each call's deadline: a write, whether it creates the secret or adds a value to it, a read,
 * a restore, a deletion or a look; and one for a whole listing, every page included.
 */
export const SECRETS_MANAGER_TIMEOUT_MS = 30_000;

/** ListSecrets' largest page. */
const PAGE_SIZE = 100;

export interface CreateSecretInput {
  readonly Name: string;
  readonly Description: string;
  readonly SecretString: string;
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

export interface PutSecretValueInput {
  readonly SecretId: string;
  readonly SecretString: string;
}

export interface GetSecretValueInput {
  readonly SecretId: string;
}

/** The fields of a CreateSecret or PutSecretValue answer the adapter reads. */
export interface SecretAnswer {
  readonly ARN?: string | undefined;
}

/** The field of a GetSecretValue answer the adapter reads. */
export interface SecretValueAnswer extends SecretAnswer {
  readonly SecretString?: string | undefined;
}

export interface ListSecretsInput {
  readonly Filters: readonly { readonly Key: string; readonly Values: readonly string[] }[];
  readonly IncludePlannedDeletion: boolean;
  readonly MaxResults: number;
  readonly NextToken: string | undefined;
}

/** The fields of one listed secret, or of a DescribeSecret answer, the adapter reads. */
export interface SecretEntry {
  readonly ARN?: string | undefined;
  readonly Name?: string | undefined;
  readonly Tags?:
    | readonly { readonly Key?: string | undefined; readonly Value?: string | undefined }[]
    | undefined;
  readonly DeletedDate?: Date | undefined;
}

/** The fields of one ListSecrets page the adapter reads. */
export interface SecretListPage {
  readonly SecretList?: readonly SecretEntry[] | undefined;
  readonly NextToken?: string | undefined;
}

export interface SecretIdInput {
  readonly SecretId: string;
}

export interface DeleteSecretInput extends SecretIdInput {
  readonly ForceDeleteWithoutRecovery: true;
}

export interface SecretsManagerCalls extends AwsCalls {
  createSecret(input: CreateSecretInput): Promise<SecretAnswer>;
  putSecretValue(input: PutSecretValueInput): Promise<SecretAnswer>;
  getSecretValue(input: GetSecretValueInput): Promise<SecretValueAnswer>;
  listSecrets(input: ListSecretsInput): Promise<SecretListPage>;
  restoreSecret(input: SecretIdInput): Promise<unknown>;
  deleteSecret(input: DeleteSecretInput): Promise<unknown>;
  describeSecret(input: SecretIdInput): Promise<SecretEntry>;
}

/**
 * The calls over AWS SDK for JavaScript v3, imported on first use so commands that never
 * call AWS never load it. `config` adds client configuration, such as a test endpoint.
 */
export function sdkSecretsManagerCalls(
  config: Partial<SecretsManagerClientConfig> = {},
): OpenCalls<SecretsManagerCalls> {
  return async (session) => {
    const sm = await import("@aws-sdk/client-secrets-manager");
    const client = new sm.SecretsManagerClient({ ...(await clientSettings(session)), ...config });
    const options = { abortSignal: session.abortSignal };
    return {
      createSecret: (input) =>
        client.send(new sm.CreateSecretCommand({ ...input, Tags: [...input.Tags] }), options),
      putSecretValue: (input) => client.send(new sm.PutSecretValueCommand(input), options),
      getSecretValue: (input) => client.send(new sm.GetSecretValueCommand(input), options),
      listSecrets: (input) =>
        client.send(
          new sm.ListSecretsCommand({
            ...input,
            Filters: input.Filters.map(({ Key, Values }) => ({
              Key: Key as FilterNameStringType,
              Values: [...Values],
            })),
          }),
          options,
        ),
      restoreSecret: (input) => client.send(new sm.RestoreSecretCommand(input), options),
      deleteSecret: (input) => client.send(new sm.DeleteSecretCommand(input), options),
      describeSecret: (input) => client.send(new sm.DescribeSecretCommand(input), options),
      close: () => client.destroy(),
    };
  };
}

function arnOf(answer: SecretAnswer): SecretReference {
  const parsed = parseSecretReference(answer.ARN ?? "");
  if (!parsed.ok) throw new AdapterRefusal("Secrets Manager returned no usable secret ARN");
  return parsed.value;
}

/** A listed or described secret; undefined without a usable name or ARN. */
function secretOf(entry: SecretEntry): ListedSecret | undefined {
  const arn = parseSecretReference(entry.ARN ?? "");
  if (!arn.ok || !entry.Name) return undefined;
  const tags = (entry.Tags ?? []).flatMap(({ Key, Value }) =>
    Key === undefined ? [] : [[Key, Value ?? ""] as const],
  );
  return {
    name: entry.Name,
    arn: arn.value,
    tags: Object.fromEntries(tags),
    pendingDeletion: entry.DeletedDate !== undefined && entry.DeletedDate !== null,
  };
}

/** One page's secrets; an entry without a usable name or ARN fails the listing. */
function secretsOf(page: SecretListPage): ListedSecret[] {
  return (page.SecretList ?? []).map((entry) => {
    const secret = secretOf(entry);
    if (secret === undefined)
      throw new AdapterRefusal("Secrets Manager listed a secret without a usable name or ARN");
    return secret;
  });
}

async function listSecrets(
  calls: SecretsManagerCalls,
  request: SecretListRequest,
): Promise<ListedSecret[]> {
  const Filters = [
    { Key: "tag-key", Values: [FACTORY_ID_TAG] },
    { Key: "tag-value", Values: [request.factoryId] },
  ];
  const secrets: ListedSecret[] = [];
  let NextToken: string | undefined;
  do {
    const page = await calls.listSecrets({
      Filters,
      IncludePlannedDeletion: true,
      MaxResults: PAGE_SIZE,
      NextToken,
    });
    secrets.push(...secretsOf(page));
    NextToken = page.NextToken || undefined;
  } while (NextToken !== undefined);
  return secrets;
}

/** A failure of a session as `failed`, described by error name only. */
function failed(error: unknown): { readonly kind: "failed"; readonly reason: string } {
  if (error instanceof AwsFailure || error instanceof AdapterRefusal)
    return { kind: "failed", reason: error.message };
  throw error;
}

/**
 * One call on one secret by its ARN, answering `call`'s result: `absent` when Secrets Manager
 * does not find it (`ResourceNotFoundException`), `invalid`'s answer to an
 * `InvalidRequestException` when it is given one, described as the session describes a failure,
 * and `failed` for any other failure, an answer `call` cannot use (`AdapterRefusal`) included.
 */
async function onSecret<T extends SecretRemoval | SecretPresence | SecretDescription>(
  open: OpenCalls<SecretsManagerCalls>,
  timeoutMs: number,
  request: SecretLookup,
  operation: string,
  call: (calls: SecretsManagerCalls, input: SecretIdInput) => Promise<T>,
  invalid?: (reason: string) => T,
): Promise<T | { readonly kind: "absent" } | { readonly kind: "failed"; readonly reason: string }> {
  try {
    return await withAwsSession(
      open,
      request,
      timeoutMs,
      `Secrets Manager ${operation}`,
      async (calls) => {
        try {
          return await call(calls, { SecretId: request.reference });
        } catch (error) {
          const name = errorName(error);
          if (name === "ResourceNotFoundException") return { kind: "absent" } as const;
          if (invalid && name === "InvalidRequestException")
            return invalid(`Secrets Manager ${operation} failed: ${name}`);
          throw error;
        }
      },
    );
  } catch (error) {
    return failed(error);
  }
}

/**
 * Secrets Manager: creates the secret, tagged, or adds a new value to it when it already
 * exists, and reads a secret's current value by its ARN. The material is only ever the
 * `SecretString` of one request or answer, and leaves a read only as `SecretMaterial`;
 * failures are described by error name, never by a message that could echo it. For teardown
 * it lists the secrets by the factory-ID tag, scheduled ones included, describes one by its ARN
 * (name, ARN, tags and deleted date, never its value), restores and force-deletes one, and looks
 * for it with DescribeSecret.
 */
export function secretsManagerStore(
  open: OpenCalls<SecretsManagerCalls> = sdkSecretsManagerCalls(),
  timeoutMs: number = SECRETS_MANAGER_TIMEOUT_MS,
): SecretStore {
  return {
    write: (request) =>
      withAwsSession(
        open,
        request,
        timeoutMs,
        "Storing the secret in Secrets Manager",
        async (calls) => {
          const SecretString = request.material.reveal();
          try {
            const created = await calls.createSecret({
              Name: request.name,
              Description: request.description,
              SecretString,
              Tags: Object.entries(request.tags).map(([Key, Value]) => ({ Key, Value })),
            });
            return { arn: arnOf(created), created: true };
          } catch (error) {
            if (errorName(error) !== "ResourceExistsException") throw error;
          }
          const updated = await calls.putSecretValue({ SecretId: request.name, SecretString });
          return { arn: arnOf(updated), created: false };
        },
      ),
    read: (request) =>
      withAwsSession(
        open,
        request,
        timeoutMs,
        "Reading the secret from Secrets Manager",
        async (calls) => {
          const { SecretString } = await calls.getSecretValue({ SecretId: request.reference });
          if (typeof SecretString !== "string" || SecretString === "")
            throw new AdapterRefusal("Secrets Manager holds no text value for the secret");
          return new SecretMaterial(SecretString);
        },
      ),
    async list(request): Promise<SecretListing> {
      try {
        const secrets = await withAwsSession(
          open,
          request,
          timeoutMs,
          "Secrets Manager ListSecrets",
          (calls) => listSecrets(calls, request),
        );
        return { kind: "listed", secrets };
      } catch (error) {
        return failed(error);
      }
    },
    restore: (request) =>
      onSecret(open, timeoutMs, request, "RestoreSecret", async (calls, input) => {
        await calls.restoreSecret(input);
        return { kind: "done" } as const;
      }),
    remove: (request) =>
      onSecret<SecretRemoval>(
        open,
        timeoutMs,
        request,
        "DeleteSecret",
        async (calls, input) => {
          await calls.deleteSecret({ ...input, ForceDeleteWithoutRecovery: true });
          return { kind: "done" };
        },
        (reason) => ({ kind: "invalid", reason }),
      ),
    describe: (request) =>
      onSecret<SecretDescription>(
        open,
        timeoutMs,
        request,
        "DescribeSecret",
        async (calls, input) => {
          const secret = secretOf(await calls.describeSecret(input));
          return secret === undefined ? { kind: "unusable" } : { kind: "found", secret };
        },
      ),
    exists: (request) =>
      onSecret(open, timeoutMs, request, "DescribeSecret", async (calls, input) => {
        await calls.describeSecret(input);
        return { kind: "present" } as const;
      }),
  };
}
