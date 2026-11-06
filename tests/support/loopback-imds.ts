/**
 * A loopback stand-in for the EC2 instance metadata service (IMDSv2), so tests exercise the
 * real AWS SDK's instance metadata credential provider without an EC2 host: a session token
 * (`PUT /latest/api/token`), the instance role's name and its temporary credentials (AWS's
 * documentation example keys), and the instance identity document. Every request but the token's
 * must carry the token it gave, as IMDSv2 requires, or it answers 401. Point the SDK at
 * `endpoint` with `AWS_EC2_METADATA_SERVICE_ENDPOINT`, never at the real one.
 */
import { EXAMPLE_CREDENTIALS } from "./stub-sts";

export const IMDS_ROLE = "fff-aaaa1111-hosts";
export const IMDS_INSTANCE_ID = "i-0123456789abcdef0";
export const IMDS_SESSION_TOKEN = "example-session-token";
const TOKEN = "example-imds-token";

export interface LoopbackImdsOptions {
  /** Answers every request with HTTP 500, as a metadata service that cannot serve would. */
  readonly failing?: boolean;
  readonly accountId?: string;
  readonly region?: string;
}

export interface LoopbackImds {
  readonly endpoint: string;
  /** `METHOD path` of each request, in order. */
  readonly requests: readonly string[];
  stop(): void;
}

const CREDENTIALS_PATH = "/latest/meta-data/iam/security-credentials/";

function answer(pathname: string, options: LoopbackImdsOptions): Response {
  if (pathname === CREDENTIALS_PATH) return new Response(IMDS_ROLE);
  if (pathname === `${CREDENTIALS_PATH}${IMDS_ROLE}`)
    return Response.json({
      Code: "Success",
      Type: "AWS-HMAC",
      AccessKeyId: EXAMPLE_CREDENTIALS.accessKeyId,
      SecretAccessKey: EXAMPLE_CREDENTIALS.secretAccessKey,
      Token: IMDS_SESSION_TOKEN,
      Expiration: new Date(Date.now() + 3_600_000).toISOString(),
    });
  if (pathname === "/latest/dynamic/instance-identity/document")
    return Response.json({
      accountId: options.accountId ?? "123456789012",
      instanceId: IMDS_INSTANCE_ID,
      region: options.region ?? "us-east-1",
    });
  return new Response("not found", { status: 404 });
}

/** Starts the stand-in on a free loopback port. */
export function loopbackImds(options: LoopbackImdsOptions = {}): LoopbackImds {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      requests.push(`${request.method} ${pathname}`);
      if (options.failing) return new Response("unavailable", { status: 500 });
      if (pathname === "/latest/api/token")
        return request.method === "PUT"
          ? new Response(TOKEN)
          : new Response("method not allowed", { status: 405 });
      if (request.headers.get("x-aws-ec2-metadata-token") !== TOKEN)
        return new Response("unauthorized", { status: 401 });
      return answer(pathname, options);
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/**
 * Runs `work` with this test process's SDK pointed at `endpoint` for instance metadata, which it
 * reads only from the environment, and restores the sealed environment after, whatever happens.
 */
export async function withMetadataEndpoint<T>(
  endpoint: string,
  work: () => Promise<T>,
): Promise<T> {
  const sealed = process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT;
  process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = endpoint;
  try {
    return await work();
  } finally {
    if (sealed === undefined) delete process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT;
    else process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = sealed;
  }
}
