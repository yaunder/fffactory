/**
 * A local stand-in for S3, so tests exercise the real AWS SDK without reaching AWS. It keeps
 * versioned objects in memory and implements what the lock store uses: HeadBucket, reads of
 * the bucket's versioning, public access block, default encryption and policy, PutObject,
 * conditional or not (`If-None-Match: *`), GetObject, HeadObject, DeleteObject by version, and
 * `x-amz-expected-bucket-owner`. Point an S3 client at `endpoint` with `forcePathStyle`.
 */

export interface StubBucket {
  readonly owner: string;
  /**
   * Versioning: enabled by default. A never-versioned bucket (`false`) stores each object as
   * its `null` version and answers without a version ID; a `"suspended"` one stores the
   * `null` version and names it. Either removes an object by its `null` version, or with no
   * version ID.
   */
  readonly versioned?: boolean | "suspended";
  /**
   * Settings backend bootstrap applies that this bucket lacks, as an interrupted bootstrap
   * leaves them. Every other one is as bootstrap sets it.
   */
  readonly lacks?: readonly BucketSetting[];
}

export type BucketSetting = "publicAccessBlock" | "encryption" | "policy";

export interface StubS3Options {
  readonly buckets?: Readonly<Record<string, StubBucket>>;
  /** Buckets that exist in another account: HeadBucket answers 403. */
  readonly foreign?: readonly string[];
  /** Answers every request with this S3 error. */
  readonly error?: { readonly status: number; readonly code: string };
  /** Never answers, as an unreachable endpoint would not. */
  readonly hang?: boolean;
}

export interface StubObject {
  readonly version: string;
  readonly body: string;
  /** Changes with every write. */
  readonly etag: string;
}

export interface StubS3 {
  readonly endpoint: string;
  /** `METHOD /bucket/key` of each request, with its conditional and owner headers. */
  readonly requests: readonly string[];
  /** Current object per `bucket/key`. */
  readonly objects: Map<string, StubObject>;
  /** Makes the next conditional PutObject answer 409 ConditionalRequestConflict. */
  conflictNextPut(): void;
  stop(): void;
}

function error(status: number, code: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>` +
      `<Message>stub ${code}</Message><RequestId>stub</RequestId></Error>`,
    { status, headers: { "content-type": "application/xml" } },
  );
}

/** Decodes an `aws-chunked` body, which the SDK sends when it trails a checksum. */
function decodeChunked(raw: string): string {
  let body = "";
  let rest = raw;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, lineEnd).split(";")[0] ?? "0", 16);
    if (!size) return body;
    body += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

interface Addressed {
  readonly method: string;
  readonly bucket: string;
  readonly path: string;
  readonly settings: StubBucket;
  readonly condition: string | null;
  readonly version: string | null;
  /** The bucket setting a bucket-level GET reads, such as `versioning`. */
  readonly setting: string | undefined;
  readonly chunked: boolean;
  readonly raw: string;
}

/** An `aws-chunked` body, which the SDK sends when it trails a checksum, decoded. */
function bodyOf(request: Addressed): string {
  return request.chunked ? decodeChunked(request.raw) : request.raw;
}

/** How a request is recorded: `METHOD /bucket/key`, then its conditional and owner headers. */
function requestLine(
  method: string,
  bucket: string,
  key: string,
  setting: string | undefined,
  headers: { condition: string | null; version: string | null; owner: string | null },
): string {
  const { condition, version, owner } = headers;
  return [
    `${method} /${bucket}${key ? `/${key}` : ""}${setting ? `?${setting}` : ""}`,
    condition && `if-none-match=${condition}`,
    version && `versionId=${version}`,
    owner && `owner=${owner}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function stubS3(options: StubS3Options = {}): StubS3 {
  const requests: string[] = [];
  const objects = new Map<string, StubObject>();
  let versions = 0;
  let conflict = false;

  const versionHeader = (settings: StubBucket, id: string): Record<string, string> =>
    settings.versioned === false ? {} : { "x-amz-version-id": id };

  const versioning = (settings: StubBucket) => settings.versioned ?? true;

  function put(request: Addressed): Response {
    if (conflict) {
      conflict = false;
      return error(409, "ConditionalRequestConflict");
    }
    if (request.condition === "*" && objects.has(request.path))
      return error(412, "PreconditionFailed");
    versions += 1;
    const id = versioning(request.settings) === true ? `stub-version-${versions}` : "null";
    const etag = `stub-etag-${versions}`;
    objects.set(request.path, { version: id, body: bodyOf(request), etag });
    return new Response(null, {
      headers: { etag: `"${etag}"`, ...versionHeader(request.settings, id) },
    });
  }

  function get(request: Addressed): Response {
    const object = objects.get(request.path);
    if (!object) return error(404, "NoSuchKey");
    return new Response(object.body, {
      headers: {
        "content-type": "application/json",
        ...versionHeader(request.settings, object.version),
      },
    });
  }

  /** HeadObject: the object's version and entity tag, or a bodiless 404. */
  function head(request: Addressed): Response {
    const object = objects.get(request.path);
    if (!object) return new Response(null, { status: 404 });
    return new Response(null, {
      headers: { etag: `"${object.etag}"`, ...versionHeader(request.settings, object.version) },
    });
  }

  function remove(request: Addressed): Response {
    const unversioned = request.version === null && versioning(request.settings) !== true;
    if (unversioned || objects.get(request.path)?.version === request.version)
      objects.delete(request.path);
    return new Response(null, { status: 204 });
  }

  const xml = (body: string) =>
    new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
      headers: { "content-type": "application/xml" },
    });

  const VERSIONING: Record<string, string> = { true: "Enabled", suspended: "Suspended" };

  /** A bucket setting's answer, or S3's error when the bucket lacks it. */
  const SETTINGS: Record<string, (request: Addressed) => Response> = {
    versioning: ({ settings }) => {
      const status = VERSIONING[String(versioning(settings))];
      return xml(
        `<VersioningConfiguration>${status ? `<Status>${status}</Status>` : ""}</VersioningConfiguration>`,
      );
    },
    publicAccessBlock: () =>
      xml(
        "<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls>" +
          "<IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy>" +
          "<RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>",
      ),
    encryption: () =>
      xml(
        "<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault>" +
          "<SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule>" +
          "</ServerSideEncryptionConfiguration>",
      ),
    policy: ({ bucket }) =>
      new Response(
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "DenyInsecureTransport",
              Effect: "Deny",
              Principal: "*",
              Action: "s3:*",
              Resource: [`arn:aws:s3:::${bucket}/*`, `arn:aws:s3:::${bucket}`],
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  };

  const LACKING: Record<BucketSetting, readonly [number, string]> = {
    publicAccessBlock: [404, "NoSuchPublicAccessBlockConfiguration"],
    encryption: [404, "ServerSideEncryptionConfigurationNotFoundError"],
    policy: [404, "NoSuchBucketPolicy"],
  };

  function setting(request: Addressed, name: string): Response {
    const lacking = request.settings.lacks?.includes(name as BucketSetting)
      ? LACKING[name as BucketSetting]
      : undefined;
    if (lacking) return error(...lacking);
    return (SETTINGS[name] as (request: Addressed) => Response)(request);
  }

  const METHODS: Record<string, (request: Addressed) => Response> = {
    HEAD: (request) => (request.path.endsWith("/") ? new Response(null) : head(request)),
    PUT: put,
    GET: (request) => (request.setting ? setting(request, request.setting) : get(request)),
    DELETE: remove,
  };

  /** S3's answer to a request it refuses: HEAD answers carry no body. */
  const refuse = (method: string, status: number, code: string) =>
    method === "HEAD" ? new Response(null, { status }) : error(status, code);

  /** A refusal before any object is touched: forced errors, unknown buckets, wrong owners. */
  function refusal(method: string, bucket: string, owner: string | null): Response | undefined {
    if (options.error) return error(options.error.status, options.error.code);
    if (options.foreign?.includes(bucket)) return new Response(null, { status: 403 });
    const known = options.buckets?.[bucket];
    if (!known) return refuse(method, 404, "NoSuchBucket");
    if (owner !== null && owner !== known.owner) return refuse(method, 403, "AccessDenied");
    return undefined;
  }

  function handle(request: Request, raw: string): Response {
    const url = new URL(request.url);
    const [, bucket = "", ...keyParts] = url.pathname.split("/");
    const key = decodeURIComponent(keyParts.join("/"));
    const owner = request.headers.get("x-amz-expected-bucket-owner");
    const condition = request.headers.get("if-none-match");
    const version = url.searchParams.get("versionId");
    const setting = key
      ? undefined
      : Object.keys(SETTINGS).find((name) => url.searchParams.has(name));
    requests.push(requestLine(request.method, bucket, key, setting, { condition, version, owner }));
    const refused = refusal(request.method, bucket, owner);
    if (refused) return refused;
    const method = METHODS[request.method] ?? (() => error(405, "MethodNotAllowed"));
    return method({
      method: request.method,
      bucket,
      path: `${bucket}/${key}`,
      settings: options.buckets?.[bucket] as StubBucket,
      condition,
      version,
      setting,
      chunked: (request.headers.get("content-encoding") ?? "").includes("aws-chunked"),
      raw,
    });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const raw = await request.text();
      if (options.hang) return new Promise<Response>(() => {});
      return handle(request, raw);
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    objects,
    conflictNextPut: () => {
      conflict = true;
    },
    stop: () => server.stop(true),
  };
}
