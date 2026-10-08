import type { SecretsManagerClientConfig } from "@aws-sdk/client-secrets-manager";
import type { SecretStore } from "../application/secret-store";
import { parseSecretReference, type SecretReference } from "../domain/instance";
import {
  AdapterRefusal,
  type AwsCalls,
  clientSettings,
  errorName,
  type OpenCalls,
  withAwsSession,
} from "./aws-session";

/** Each write's deadline, whether it creates the secret or adds a value to it. */
export const SECRETS_MANAGER_TIMEOUT_MS = 30_000;

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

/** The fields of a CreateSecret or PutSecretValue answer the adapter reads. */
export interface SecretAnswer {
  readonly ARN?: string | undefined;
}

export interface SecretsManagerCalls extends AwsCalls {
  createSecret(input: CreateSecretInput): Promise<SecretAnswer>;
  putSecretValue(input: PutSecretValueInput): Promise<SecretAnswer>;
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
      close: () => client.destroy(),
    };
  };
}

function arnOf(answer: SecretAnswer): SecretReference {
  const parsed = parseSecretReference(answer.ARN ?? "");
  if (!parsed.ok) throw new AdapterRefusal("Secrets Manager returned no usable secret ARN");
  return parsed.value;
}

/**
 * Secrets Manager: creates the secret, tagged, or adds a new value to it when it already
 * exists. The material is only ever the `SecretString` of one request; failures are
 * described by error name, never by a message that could echo it.
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
  };
}
