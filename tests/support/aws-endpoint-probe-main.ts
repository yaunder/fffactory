/**
 * Prints, as JSON, where the AWS SDK in this process's environment would send the collector's
 * calls: the instance metadata endpoint its credentials come from, and the S3 and STS endpoints
 * of a PutObject and a GetCallerIdentity in `eu-west-2`. Nothing is sent: each request is stopped
 * once it is built, before signing or any network, and resolving the metadata endpoint asks
 * nothing. `tests/host/collector-step.test.ts` runs it under the collector unit's environment.
 */
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getInstanceMetadataEndpoint } from "@smithy/credential-provider-imds";

const REGION = "eu-west-2";
/** AWS's documentation example keys: nothing is signed with them. */
const CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const STOP = new Error("stopped before sending");

interface Built {
  readonly protocol?: string;
  readonly hostname?: string;
  readonly port?: number;
}

function origin({ protocol, hostname, port }: Built): string {
  return `${protocol ?? ""}//${hostname ?? ""}${port === undefined ? "" : `:${port}`}`;
}

/** A build-step middleware that records where the request would go, then stops it. */
function stopWhenBuilt(record: (where: string) => void) {
  return () => async (args: { readonly request: unknown }) => {
    record(origin(args.request as Built));
    throw STOP;
  };
}

/** Runs `send` and swallows only the probe's own stop. */
async function stopped(send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (error) {
    if (error !== STOP) throw error;
  }
}

const AT_BUILD = { step: "build", name: "probeDestination" } as const;

const imds = origin(await getInstanceMetadataEndpoint());
let s3 = "";
const s3Client = new S3Client({ region: REGION, credentials: CREDENTIALS, maxAttempts: 1 });
s3Client.middlewareStack.add(
  stopWhenBuilt((where) => {
    s3 = where;
  }),
  AT_BUILD,
);
await stopped(() =>
  s3Client.send(new PutObjectCommand({ Bucket: "fff-aaaa1111-logs", Key: "probe", Body: "" })),
);
s3Client.destroy();
let sts = "";
const stsClient = new STSClient({ region: REGION, credentials: CREDENTIALS, maxAttempts: 1 });
stsClient.middlewareStack.add(
  stopWhenBuilt((where) => {
    sts = where;
  }),
  AT_BUILD,
);
await stopped(() => stsClient.send(new GetCallerIdentityCommand({})));
stsClient.destroy();
console.log(JSON.stringify({ imds, s3, sts }));
