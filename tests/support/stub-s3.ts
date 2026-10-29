/**
 * A local stand-in for S3, so tests exercise the real AWS SDK without reaching AWS. It keeps
 * versioned objects in memory and implements what the lock store uses: HeadBucket, reads of
 * the bucket's versioning, public access block, default encryption and policy (and, as the log
 * archive's readiness reads them, its object ownership and ABAC status), PutObject,
 * conditional or not (`If-None-Match: *`), GetObject, HeadObject, DeleteObject by version (or,
 * on a versioned bucket, without one, which writes a delete marker), ListObjectsV2 (the current
 * objects under a prefix, by key, in pages of `listPageSize` resumed from its continuation
 * token), and
 * `x-amz-expected-bucket-owner`; and for deleting the bucket, ListObjectVersions (versions and
 * delete markers, by key and then newest first, each with `IsLatest` and `LastModified`, in
 * pages of `max-keys` resumed from the key and version markers, even once the version named is
 * deleted, and refused with `InvalidArgument` for a version marker never given out),
 * DeleteObjects by version (at most 1000 keys, quiet or verbose, each key's failure in the
 * answer) and DeleteBucket (refused with `BucketNotEmpty` while any version or delete marker
 * is left). Deleting a key's current version, or current delete marker, makes the newest left
 * current. Point an S3 client at `endpoint` with `forcePathStyle`.
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
   * Settings backend bootstrap, or the archive root, applies that this bucket lacks, as an
   * interrupted bootstrap leaves them. Every other one is as they set it. A bucket lacking ABAC
   * answers that it is `Disabled`.
   */
  readonly lacks?: readonly BucketSetting[];
}

export type BucketSetting =
  | "publicAccessBlock"
  | "encryption"
  | "policy"
  | "ownershipControls"
  | "abac";

export interface StubS3Options {
  readonly buckets?: Readonly<Record<string, StubBucket>>;
  /** Buckets that exist in another account: HeadBucket answers 403. */
  readonly foreign?: readonly string[];
  /** Answers every request with this S3 error. */
  readonly error?: { readonly status: number; readonly code: string };
  /** Never answers, as an unreachable endpoint would not. */
  readonly hang?: boolean;
  /** Keys DeleteObjects reports it could not delete, each with this S3 error code. */
  readonly undeletable?: Readonly<Record<string, string>>;
  /** Keys per ListObjectsV2 page; 1000, S3's own, unless set. */
  readonly listPageSize?: number;
  /** Runs after each ListObjectVersions answer is made, as a write racing the deletion would. */
  readonly afterListing?: () => void;
}

export interface StubObject {
  readonly version: string;
  readonly body: string;
  /** Changes with every write. */
  readonly etag: string;
}

/** A version no longer current, or a delete marker. */
export interface StubVersion extends StubObject {
  /** `bucket/key`. */
  readonly path: string;
  readonly deleteMarker: boolean;
}

export interface StubS3 {
  readonly endpoint: string;
  /** `METHOD /bucket/key` of each request, with its conditional and owner headers. */
  readonly requests: readonly string[];
  /** Current object per `bucket/key`. */
  readonly objects: Map<string, StubObject>;
  /**
   * Every other version and delete marker: a versioned write moves the object it replaces
   * here, and deleting the current version, or the current delete marker, makes the newest one
   * here current.
   */
  readonly versions: StubVersion[];
  /** `key version` of each version named in each DeleteObjects call, in order. */
  readonly deleteBatches: readonly (readonly string[])[];
  /**
   * Adds `count` versions of `key` that are no longer current, or delete markers, each older
   * than every version stored before it: their version IDs, newest first.
   */
  addVersions(bucket: string, key: string, count: number, deleteMarker?: boolean): string[];
  /**
   * Deletes `key` as a DeleteObject without a version ID does on a versioned bucket: writes a
   * delete marker newer than every version, current from then on. Its version ID.
   */
  markDeleted(bucket: string, key: string): string;
  /** How many versions and delete markers, current or not, the bucket holds. */
  stored(bucket: string): number;
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

/** A bucket-level request's subresource, such as `versioning` or `delete`. */
const BUCKET_QUERIES = [
  "versioning",
  "publicAccessBlock",
  "encryption",
  "policy",
  "ownershipControls",
  "abac",
  "versions",
  "delete",
  "list-type",
];

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);

function unescapeXml(text: string): string {
  const entities = Object.entries(XML_ESCAPES);
  return text.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (entity) => (entities.find(([, escaped]) => escaped === entity) as [string, string])[0],
  );
}

/** The first `<tag>` element's text in `xml`, unescaped. */
function element(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? unescapeXml(match[1] as string) : undefined;
}

/** The objects a DeleteObjects body names: each key, and its version (`null` when none). */
function deleteRequest(body: string): { key: string; version: string }[] {
  return [...body.matchAll(/<Object>([\s\S]*?)<\/Object>/g)].map(([, object = ""]) => ({
    key: element(object, "Key") ?? "",
    version: element(object, "VersionId") ?? "null",
  }));
}

/** S3's limit on one DeleteObjects call. */
const DELETE_LIMIT = 1000;

/** When the version of age 0 was written; each age is a second apart. */
const WRITTEN = Date.parse("2026-09-30T10:00:00.000Z");

export function stubS3(options: StubS3Options = {}): StubS3 {
  const requests: string[] = [];
  const objects = new Map<string, StubObject>();
  const history: StubVersion[] = [];
  const deleteBatches: string[][] = [];
  const deletedBuckets = new Set<string>();
  /** How new each version is, by `bucket/key version`, kept once it is deleted. */
  const ages = new Map<string, number>();
  const age = (path: string, version: string) => ages.get(`${path} ${version}`) ?? 0;
  let versions = 0;
  /** The age of the oldest version `addVersions` added. */
  let oldest = 0;
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
    ages.set(`${request.path} ${id}`, versions);
    const replaced = objects.get(request.path);
    if (replaced && replaced.version !== id)
      history.push({ ...replaced, path: request.path, deleteMarker: false });
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

  /** The newest version or delete marker of `path` that is no longer current. */
  function newestOlder(path: string): StubVersion | undefined {
    return history
      .filter((entry) => entry.path === path)
      .reduce<StubVersion | undefined>(
        (newest, entry) =>
          newest && age(path, newest.version) > age(path, entry.version) ? newest : entry,
        undefined,
      );
  }

  /** Makes the newest version or delete marker left of `path` current. */
  function promote(path: string): void {
    const promoted = newestOlder(path);
    if (promoted && !promoted.deleteMarker) {
      history.splice(history.indexOf(promoted), 1);
      objects.set(path, { version: promoted.version, body: promoted.body, etag: promoted.etag });
    }
  }

  /** Whether `entry`, just taken out of `history`, was the current delete marker of `path`. */
  function wasCurrentMarker(path: string, entry: StubVersion | undefined): boolean {
    if (!entry?.deleteMarker || objects.has(path)) return false;
    const newer = newestOlder(path);
    return newer === undefined || age(path, newer.version) < age(path, entry.version);
  }

  /**
   * Deletes one version or delete marker. Deleting the current version, or the current delete
   * marker, makes the newest left current: an object again, unless that is a delete marker.
   */
  function removeVersion(path: string, version: string): void {
    if (objects.get(path)?.version === version) {
      objects.delete(path);
      promote(path);
      return;
    }
    const index = history.findIndex((entry) => entry.path === path && entry.version === version);
    if (index < 0) return;
    const [removed] = history.splice(index, 1);
    if (wasCurrentMarker(path, removed)) promote(path);
  }

  /** A delete without a version ID on a versioned bucket: a new delete marker, current. */
  function markDeleted(path: string): string {
    versions += 1;
    const id = `stub-version-${versions}`;
    ages.set(`${path} ${id}`, versions);
    const replaced = objects.get(path);
    if (replaced) history.push({ ...replaced, path, deleteMarker: false });
    objects.delete(path);
    history.push({
      path,
      version: id,
      body: "",
      etag: `stub-etag-${versions}`,
      deleteMarker: true,
    });
    return id;
  }

  function remove(request: Addressed): Response {
    if (request.path === `${request.bucket}/`) return deleteBucket(request.bucket);
    const unversioned = request.version === null && versioning(request.settings) !== true;
    if (unversioned) objects.delete(request.path);
    else if (request.version !== null) removeVersion(request.path, request.version);
    else
      return new Response(null, {
        status: 204,
        headers: { "x-amz-delete-marker": "true", "x-amz-version-id": markDeleted(request.path) },
      });
    return new Response(null, { status: 204 });
  }

  /** The bucket's versions and delete markers, by key, then newest first: the first current. */
  function listing(
    bucket: string,
  ): (StubVersion & { readonly key: string; readonly latest: boolean })[] {
    const prefix = `${bucket}/`;
    const current = [...objects].map(([path, object]) => ({
      ...object,
      path,
      deleteMarker: false,
    }));
    const sorted = [...current, ...history]
      .filter(({ path }) => path.startsWith(prefix))
      .map((entry) => ({ ...entry, key: entry.path.slice(prefix.length) }))
      .sort((a, b) =>
        a.key === b.key ? age(b.path, b.version) - age(a.path, a.version) : a.key < b.key ? -1 : 1,
      );
    return sorted.map((entry, index) => ({
      ...entry,
      latest: sorted[index - 1]?.key !== entry.key,
    }));
  }

  /**
   * Where a page starts: after the place the markers name, as S3 resumes, even once the version
   * they name is deleted; with no version marker, after every version of the key.
   */
  function pageStart(
    bucket: string,
    entries: readonly { key: string; path: string; version: string }[],
    url: URL,
  ): number {
    const key = url.searchParams.get("key-marker");
    if (!key) return 0;
    const version = url.searchParams.get("version-id-marker");
    const marked = version !== null ? ages.get(`${bucket}/${key} ${version}`) : undefined;
    const after = entries.findIndex(
      (entry) =>
        entry.key > key ||
        (entry.key === key && marked !== undefined && age(entry.path, entry.version) < marked),
    );
    return after < 0 ? entries.length : after;
  }

  function listVersions(request: Addressed, url: URL): Response {
    const key = url.searchParams.get("key-marker");
    const version = url.searchParams.get("version-id-marker");
    if (key && version !== null && !ages.has(`${request.bucket}/${key} ${version}`))
      return error(400, "InvalidArgument");
    const entries = listing(request.bucket);
    const max = Number(url.searchParams.get("max-keys") ?? DELETE_LIMIT);
    const start = pageStart(request.bucket, entries, url);
    const page = entries.slice(start, start + max);
    const truncated = start + max < entries.length;
    const last = page.at(-1);
    const next =
      truncated && last
        ? `<NextKeyMarker>${escapeXml(last.key)}</NextKeyMarker>` +
          `<NextVersionIdMarker>${escapeXml(last.version)}</NextVersionIdMarker>`
        : "";
    const items = page.map((entry) => {
      const tag = entry.deleteMarker ? "DeleteMarker" : "Version";
      const written = new Date(WRITTEN + age(entry.path, entry.version) * 1000).toISOString();
      return (
        `<${tag}><Key>${escapeXml(entry.key)}</Key>` +
        `<VersionId>${escapeXml(entry.version)}</VersionId><IsLatest>${entry.latest}</IsLatest>` +
        `<LastModified>${written}</LastModified></${tag}>`
      );
    });
    const answer = xml(
      `<ListVersionsResult><Name>${request.bucket}</Name><IsTruncated>${truncated}</IsTruncated>` +
        `${next}${items.join("")}</ListVersionsResult>`,
    );
    options.afterListing?.();
    return answer;
  }

  /**
   * ListObjectsV2: the bucket's current objects under `prefix`, by key, a page at a time; the
   * continuation token is the last key of the page before, as S3's is opaque.
   */
  function listObjects(request: Addressed, url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const after = url.searchParams.get("continuation-token");
    const keys = [...objects.keys()]
      .filter((path) => path.startsWith(`${request.bucket}/${prefix}`))
      .map((path) => path.slice(request.bucket.length + 1))
      .sort()
      .filter((key) => after === null || key > after);
    const size = options.listPageSize ?? DELETE_LIMIT;
    const page = keys.slice(0, size);
    const truncated = keys.length > size;
    const next = truncated
      ? `<NextContinuationToken>${escapeXml(page.at(-1) as string)}</NextContinuationToken>`
      : "";
    const contents = page.map((key) => `<Contents><Key>${escapeXml(key)}</Key></Contents>`);
    return xml(
      `<ListBucketResult><Name>${request.bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix>` +
        `<KeyCount>${page.length}</KeyCount><MaxKeys>${size}</MaxKeys>` +
        `<IsTruncated>${truncated}</IsTruncated>${next}${contents.join("")}</ListBucketResult>`,
    );
  }

  function deleteObjects(request: Addressed): Response {
    const body = bodyOf(request);
    const named = deleteRequest(body);
    if (named.length > DELETE_LIMIT) return error(400, "MalformedXML");
    deleteBatches.push(named.map(({ key, version }) => `${key} ${version}`));
    const quiet = element(body, "Quiet") === "true";
    const results = named.map(({ key, version }) => {
      const identity = `<Key>${escapeXml(key)}</Key><VersionId>${escapeXml(version)}</VersionId>`;
      const code = options.undeletable?.[key];
      if (code)
        return `<Error>${identity}<Code>${code}</Code><Message>stub ${code}</Message></Error>`;
      removeVersion(`${request.bucket}/${key}`, version);
      return quiet ? "" : `<Deleted>${identity}</Deleted>`;
    });
    return xml(`<DeleteResult>${results.join("")}</DeleteResult>`);
  }

  function deleteBucket(bucket: string): Response {
    if (listing(bucket).length > 0) return error(409, "BucketNotEmpty");
    deletedBuckets.add(bucket);
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
    ownershipControls: () =>
      xml(
        "<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule>" +
          "</OwnershipControls>",
      ),
    abac: ({ settings }) =>
      xml(
        `<AbacStatus><Status>${settings.lacks?.includes("abac") ? "Disabled" : "Enabled"}</Status></AbacStatus>`,
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

  const LACKING: Partial<Record<BucketSetting, readonly [number, string]>> = {
    publicAccessBlock: [404, "NoSuchPublicAccessBlockConfiguration"],
    encryption: [404, "ServerSideEncryptionConfigurationNotFoundError"],
    policy: [404, "NoSuchBucketPolicy"],
    ownershipControls: [404, "OwnershipControlsNotFoundError"],
  };

  function setting(request: Addressed, name: string): Response {
    const lacking = request.settings.lacks?.includes(name as BucketSetting)
      ? LACKING[name as BucketSetting]
      : undefined;
    if (lacking) return error(...lacking);
    return (SETTINGS[name] as (request: Addressed) => Response)(request);
  }

  const METHODS: Record<string, (request: Addressed, url: URL) => Response> = {
    HEAD: (request) => (request.path.endsWith("/") ? new Response(null) : head(request)),
    PUT: put,
    GET: (request, url) => {
      if (request.setting === "versions") return listVersions(request, url);
      if (request.setting === "list-type") return listObjects(request, url);
      return request.setting ? setting(request, request.setting) : get(request);
    },
    POST: (request) =>
      request.setting === "delete" ? deleteObjects(request) : error(405, "MethodNotAllowed"),
    DELETE: remove,
  };

  /** S3's answer to a request it refuses: HEAD answers carry no body. */
  const refuse = (method: string, status: number, code: string) =>
    method === "HEAD" ? new Response(null, { status }) : error(status, code);

  /** The bucket's settings, while it exists. */
  const existing = (bucket: string) =>
    deletedBuckets.has(bucket) ? undefined : options.buckets?.[bucket];

  /** A refusal before any object is touched: forced errors, unknown buckets, wrong owners. */
  function refusal(method: string, bucket: string, owner: string | null): Response | undefined {
    if (options.error) return error(options.error.status, options.error.code);
    if (options.foreign?.includes(bucket)) return new Response(null, { status: 403 });
    const known = existing(bucket);
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
    const setting = key ? undefined : BUCKET_QUERIES.find((name) => url.searchParams.has(name));
    requests.push(requestLine(request.method, bucket, key, setting, { condition, version, owner }));
    const refused = refusal(request.method, bucket, owner);
    if (refused) return refused;
    const method = METHODS[request.method] ?? (() => error(405, "MethodNotAllowed"));
    return method(
      {
        method: request.method,
        bucket,
        path: `${bucket}/${key}`,
        settings: options.buckets?.[bucket] as StubBucket,
        condition,
        version,
        setting,
        chunked: (request.headers.get("content-encoding") ?? "").includes("aws-chunked"),
        raw,
      },
      url,
    );
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
    versions: history,
    deleteBatches,
    addVersions: (bucket, key, count, deleteMarker = false) =>
      Array.from({ length: count }, () => {
        versions += 1;
        oldest -= 1;
        const version = `stub-version-${versions}`;
        ages.set(`${bucket}/${key} ${version}`, oldest);
        history.push({
          path: `${bucket}/${key}`,
          version,
          body: deleteMarker ? "" : "{}",
          etag: `stub-etag-${versions}`,
          deleteMarker,
        });
        return version;
      }),
    markDeleted: (bucket, key) => markDeleted(`${bucket}/${key}`),
    stored: (bucket) => listing(bucket).length,
    conflictNextPut: () => {
      conflict = true;
    },
    stop: () => server.stop(true),
  };
}
