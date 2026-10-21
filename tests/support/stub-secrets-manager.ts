/**
 * A local stand-in for Secrets Manager's CreateSecret, PutSecretValue and GetSecretValue, and
 * for teardown's ListSecrets, RestoreSecret, DeleteSecret and DescribeSecret, so tests
 * exercise the real AWS SDK without reaching AWS. Point a client at `endpoint`, or a spawned
 * CLI at it with `AWS_ENDPOINT_URL_SECRETS_MANAGER`.
 *
 * It answers as AWS documents: ListSecrets filters `tag-key` and `tag-value` by prefix, leaves
 * out secrets scheduled for deletion unless `IncludePlannedDeletion`, and pages by
 * `MaxResults` (at most `pageSize`); DeleteSecret without `ForceDeleteWithoutRecovery`
 * schedules the deletion, and with it refuses a secret already scheduled
 * (`InvalidRequestException`) and succeeds for one that does not exist; a forced deletion
 * goes on being described, scheduled, for `lingering` looks, as AWS deletes asynchronously.
 */

const TARGET = "secretsmanager.";
const JSON_TYPE = { "content-type": "application/x-amz-json-1.1" };
/** The deleted date the stub reports for a secret scheduled for deletion. */
const DELETED_DATE = 1_792_540_800;

export interface StubSecretsManagerOptions {
  /** Answers every request with this error type, such as AccessDeniedException. */
  readonly error?: string;
  /** Answers the operations named with these error types, such as `{ DeleteSecret: "AccessDeniedException" }`. */
  readonly failing?: Readonly<Record<string, string>>;
  /** Never answers, as an unreachable endpoint would not. */
  readonly hang?: boolean;
  /** The largest ListSecrets page, whatever `MaxResults` asks for. */
  readonly pageSize?: number;
  /** How many DescribeSecret calls still find a secret after its forced deletion. */
  readonly lingering?: number;
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
  /** Each secret's tags by name. */
  readonly tags: Map<string, Record<string, string>>;
  /** The names of the secrets scheduled for deletion. */
  readonly scheduled: Set<string>;
  /** Adds a secret with tags, and scheduled for deletion when `scheduled`. */
  add(name: string, tags: Record<string, string>, scheduled?: boolean): void;
  stop(): void;
}

export function stubArn(name: string): string {
  return `arn:aws:secretsmanager:eu-west-2:123456789012:secret:${name}-AbCdEf`;
}

function failure(type: string): Response {
  return Response.json(
    { __type: type, message: `stub ${type}` },
    { status: 400, headers: JSON_TYPE },
  );
}

const answer = (body: Record<string, unknown>) => Response.json(body, { headers: JSON_TYPE });

type Tag = { Key: string; Value: string };

function tagList(tags: Record<string, string> | undefined): Tag[] {
  return Object.entries(tags ?? {}).map(([Key, Value]) => ({ Key, Value }));
}

/** Whether the secret's tags pass ListSecrets' tag filters, each a prefix match. */
function matches(tags: Tag[], filters: { Key?: string; Values?: string[] }[]): boolean {
  return filters.every(({ Key, Values = [] }) => {
    const field = Key === "tag-key" ? "Key" : Key === "tag-value" ? "Value" : undefined;
    if (field === undefined) return true;
    return tags.some((tag) => Values.some((value) => tag[field].startsWith(value)));
  });
}

export function stubSecretsManager(options: StubSecretsManagerOptions = {}): StubSecretsManager {
  const requests: { operation: string; body: Record<string, unknown> }[] = [];
  const secrets = new Map<string, string[]>();
  const tags = new Map<string, Record<string, string>>();
  const scheduled = new Set<string>();
  /** Secrets deleted by force, by how many more looks still find them. */
  const deleting = new Map<string, number>();

  function nameOf(secretId: string): string | undefined {
    return [...secrets.keys()].find((known) => known === secretId || stubArn(known) === secretId);
  }

  function create(body: Record<string, unknown>): Response {
    const name = String(body.Name ?? "");
    if (secrets.has(name)) return failure("ResourceExistsException");
    secrets.set(name, [String(body.SecretString ?? "")]);
    const given = (body.Tags ?? []) as Tag[];
    tags.set(name, Object.fromEntries(given.map(({ Key, Value }) => [Key, Value])));
    return answer({ ARN: stubArn(name), Name: name, VersionId: "stub" });
  }

  function put(body: Record<string, unknown>): Response {
    const name = String(body.SecretId ?? "");
    const existing = secrets.get(name);
    if (!existing) return failure("ResourceNotFoundException");
    existing.push(String(body.SecretString ?? ""));
    return answer({ ARN: stubArn(name), Name: name, VersionId: "stub" });
  }

  /** The current value of the secret named, or referred to by its ARN. */
  function get(body: Record<string, unknown>): Response {
    const name = nameOf(String(body.SecretId ?? ""));
    const value = name === undefined ? undefined : secrets.get(name)?.at(-1);
    if (name === undefined || value === undefined) return failure("ResourceNotFoundException");
    return answer({ ARN: stubArn(name), Name: name, VersionId: "stub", SecretString: value });
  }

  function entry(name: string): Record<string, unknown> {
    return {
      ARN: stubArn(name),
      Name: name,
      Tags: tagList(tags.get(name)),
      ...(scheduled.has(name) ? { DeletedDate: DELETED_DATE } : {}),
    };
  }

  function list(body: Record<string, unknown>): Response {
    const filters = (body.Filters ?? []) as { Key?: string; Values?: string[] }[];
    const listed = [...secrets.keys()].filter(
      (name) =>
        (body.IncludePlannedDeletion === true || !scheduled.has(name)) &&
        matches(tagList(tags.get(name)), filters),
    );
    const start = Number(body.NextToken ?? 0);
    const size = Math.min(Number(body.MaxResults ?? 100), options.pageSize ?? 100);
    const end = start + size;
    return answer({
      SecretList: listed.slice(start, end).map(entry),
      ...(end < listed.length ? { NextToken: String(end) } : {}),
    });
  }

  function restore(body: Record<string, unknown>): Response {
    const name = nameOf(String(body.SecretId ?? ""));
    if (name === undefined) return failure("ResourceNotFoundException");
    scheduled.delete(name);
    return answer({ ARN: stubArn(name), Name: name });
  }

  /** DeleteSecret without `ForceDeleteWithoutRecovery`: the deletion is scheduled. */
  function schedule(name: string | undefined): Response {
    if (name === undefined) return failure("ResourceNotFoundException");
    scheduled.add(name);
    return answer({ ARN: stubArn(name), Name: name, DeletionDate: DELETED_DATE });
  }

  function remove(body: Record<string, unknown>): Response {
    const secretId = String(body.SecretId ?? "");
    const name = nameOf(secretId);
    if (body.ForceDeleteWithoutRecovery !== true) return schedule(name);
    // A forced deletion of a secret that does not exist succeeds, as AWS documents.
    if (name === undefined) return answer({ ARN: secretId, Name: secretId });
    if (scheduled.has(name)) return failure("InvalidRequestException");
    secrets.delete(name);
    deleting.set(name, options.lingering ?? 0);
    return answer({ ARN: stubArn(name), Name: name, DeletionDate: DELETED_DATE });
  }

  function describe(body: Record<string, unknown>): Response {
    const secretId = String(body.SecretId ?? "");
    const name = nameOf(secretId);
    if (name !== undefined) return answer(entry(name));
    const gone = [...deleting.keys()].find(
      (known) => known === secretId || stubArn(known) === secretId,
    );
    const left = gone === undefined ? 0 : (deleting.get(gone) ?? 0);
    if (gone === undefined || left === 0) return failure("ResourceNotFoundException");
    deleting.set(gone, left - 1);
    return answer({ ARN: stubArn(gone), Name: gone, DeletedDate: DELETED_DATE });
  }

  const OPERATIONS: Record<string, (body: Record<string, unknown>) => Response> = {
    CreateSecret: create,
    PutSecretValue: put,
    GetSecretValue: get,
    ListSecrets: list,
    RestoreSecret: restore,
    DeleteSecret: remove,
    DescribeSecret: describe,
  };

  function handle(operation: string, body: Record<string, unknown>): Response {
    const error = options.error ?? options.failing?.[operation];
    if (error) return failure(error);
    const run = OPERATIONS[operation];
    return run ? run(body) : failure("InvalidAction");
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
    tags,
    scheduled,
    add: (name, given, isScheduled = false) => {
      secrets.set(name, ["stub value"]);
      tags.set(name, { ...given });
      if (isScheduled) scheduled.add(name);
    },
    stop: () => server.stop(true),
  };
}
