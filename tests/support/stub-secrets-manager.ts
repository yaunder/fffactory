/**
 * A local stand-in for Secrets Manager's CreateSecret and PutSecretValue, so tests exercise
 * the real AWS SDK without reaching AWS. Point a client at `endpoint`, or a spawned CLI at
 * it with `AWS_ENDPOINT_URL_SECRETS_MANAGER`.
 */

const TARGET = "secretsmanager.";
const JSON_TYPE = { "content-type": "application/x-amz-json-1.1" };

export interface StubSecretsManagerOptions {
  /** Answers every request with this error type, such as AccessDeniedException. */
  readonly error?: string;
  /** Never answers, as an unreachable endpoint would not. */
  readonly hang?: boolean;
}

export interface StubSecretsManager {
  readonly endpoint: string;
  /** Operation and JSON body of each request, in order. */
  readonly requests: readonly {
    readonly operation: string;
    readonly body: Record<string, unknown>;
  }[];
  /** Each secret's values by name, oldest first. */
  readonly secrets: Map<string, string[]>;
  stop(): void;
}

function arn(name: string): string {
  return `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${name}-AbCdEf`;
}

function failure(type: string): Response {
  return Response.json(
    { __type: type, message: `stub ${type}` },
    { status: 400, headers: JSON_TYPE },
  );
}

export function stubSecretsManager(options: StubSecretsManagerOptions = {}): StubSecretsManager {
  const requests: { operation: string; body: Record<string, unknown> }[] = [];
  const secrets = new Map<string, string[]>();

  function create(name: string, value: string): Response | undefined {
    if (secrets.has(name)) return failure("ResourceExistsException");
    secrets.set(name, [value]);
    return undefined;
  }

  function put(name: string, value: string): Response | undefined {
    const existing = secrets.get(name);
    if (!existing) return failure("ResourceNotFoundException");
    existing.push(value);
    return undefined;
  }

  const OPERATIONS: Record<string, (name: string, value: string) => Response | undefined> = {
    CreateSecret: create,
    PutSecretValue: put,
  };

  function handle(operation: string, body: Record<string, unknown>): Response {
    if (options.error) return failure(options.error);
    const run = OPERATIONS[operation];
    if (!run) return failure("InvalidAction");
    const name = String(body.Name ?? body.SecretId ?? "");
    const refused = run(name, String(body.SecretString ?? ""));
    return (
      refused ??
      Response.json({ ARN: arn(name), Name: name, VersionId: "stub" }, { headers: JSON_TYPE })
    );
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      const operation = (request.headers.get("x-amz-target") ?? "").replace(TARGET, "");
      requests.push({ operation, body });
      if (options.hang) return new Promise<Response>(() => {});
      return handle(operation, body);
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    secrets,
    stop: () => server.stop(true),
  };
}
