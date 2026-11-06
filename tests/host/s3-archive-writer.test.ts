/**
 * docs/specs/collector.md §Credentials and publishing: the `ArchiveWriter` over S3, signed only
 * with the instance role's credentials from instance metadata, against the real AWS SDK pointed
 * at a loopback IMDS (`support/loopback-imds.ts`), `support/stub-sts.ts` and
 * `support/stub-s3.ts`. Nothing here reaches AWS.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CLOSED_ENDPOINT } from "../support/aws-isolation";
import {
  IMDS_SESSION_TOKEN,
  type LoopbackImds,
  loopbackImds,
  withMetadataEndpoint,
} from "../support/loopback-imds";
import { type StubS3, stubS3 } from "../support/stub-s3";
import { type StubSts, type StubStsAnswer, stubSts } from "../support/stub-sts";
import {
  type ArchiveSession,
  openInstanceArchive,
  type OpenedArchive,
} from "../../src/host/s3-archive-writer";

const ACCOUNT = "123456789012";
const BUCKET = "fff-aaaa1111-logs-123456789012-us-east-1-an";
const ROLE_ID = "AROAEXAMPLEROLEID1234";
const INSTANCE_ID = "i-0123456789abcdef0";
const CALLER: StubStsAnswer = {
  kind: "caller",
  account: ACCOUNT,
  arn: `arn:aws:sts::${ACCOUNT}:assumed-role/fff-aaaa1111-hosts/${INSTANCE_ID}`,
  userId: `${ROLE_ID}:${INSTANCE_ID}`,
};
const KEY = `archive/1/fff-aaaa1111/workers/${ROLE_ID}:${INSTANCE_ID}/incarnation.json`;

let imds: LoopbackImds | undefined;
let sts: StubSts | undefined;
let s3: StubS3 | undefined;
const sessions: OpenedArchive[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  imds?.stop();
  sts?.stop();
  s3?.stop();
  imds = sts = s3 = undefined;
});

interface World {
  readonly imds?: { readonly failing?: boolean };
  readonly caller?: StubStsAnswer;
  /** The S3 endpoint, when not the stub's. */
  readonly s3Endpoint?: string;
  readonly deadlineMs?: number;
  readonly hangS3?: boolean;
}

async function open(world: World = {}): Promise<ArchiveSession> {
  imds = loopbackImds(world.imds);
  sts = stubSts(world.caller ?? CALLER);
  s3 = stubS3({
    buckets: { [BUCKET]: { owner: ACCOUNT } },
    requireIfNoneMatch: true,
    hang: world.hangS3,
  });
  const endpoints = { s3: world.s3Endpoint ?? s3.endpoint, sts: sts.endpoint };
  const session = await withMetadataEndpoint(imds.endpoint, () =>
    openInstanceArchive(
      { bucket: BUCKET, region: "us-east-1" },
      { endpoints, deadlineMs: world.deadlineMs },
    ),
  );
  if (session.kind === "opened") sessions.push(session);
  return session;
}

async function opened(world: World = {}): Promise<OpenedArchive> {
  const session = await open(world);
  if (session.kind !== "opened") throw new Error(`not opened: ${session.failure}`);
  return session;
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** Puts outside any metadata endpoint: the credentials were resolved when it was opened. */
function put(session: OpenedArchive, key: string, text: string) {
  return session.writer.put(key, bytes(text));
}

describe("opening the archive with the instance role", () => {
  test("signs with instance metadata's role credentials and learns its incarnation from STS", async () => {
    const session = await opened();
    expect(session.account).toBe(ACCOUNT);
    expect(session.incarnation).toEqual({ role_id: ROLE_ID, instance_id: INSTANCE_ID });
    expect(imds?.requests).toContain("PUT /latest/api/token");
    expect(sts?.requests).toHaveLength(1);
    expect(sts?.requests[0]).toContain("Action=GetCallerIdentity");
    expect(sts?.sessionTokens).toEqual([IMDS_SESSION_TOKEN]);
  });

  test("instance metadata unavailable fails it by the provider's error name, asking STS nothing", async () => {
    // No session token, and IMDSv1 never used: the SDK names that fallback refused.
    const session = await open({ imds: { failing: true } });
    expect(session).toEqual({ kind: "failed", failure: "InstanceMetadataV1FallbackError" });
    expect(imds?.requests).toEqual(["PUT /latest/api/token"]);
    expect(sts?.requests).toEqual([]);
  });

  test("instance metadata unreachable fails it the same way, never trying another source", async () => {
    sts = stubSts(CALLER);
    const session = await withMetadataEndpoint(CLOSED_ENDPOINT, () =>
      openInstanceArchive(
        { bucket: BUCKET, region: "us-east-1" },
        { endpoints: { s3: CLOSED_ENDPOINT, sts: sts?.endpoint ?? "" } },
      ),
    );
    expect(session).toEqual({ kind: "failed", failure: "InstanceMetadataV1FallbackError" });
    expect(sts.requests).toEqual([]);
  });

  test("a caller that is no instance role fails it, writing nothing", async () => {
    const session = await open({
      caller: { ...CALLER, userId: "AIDAEXAMPLEUSERID" } as StubStsAnswer,
    });
    expect(session).toEqual({ kind: "failed", failure: "NotAnInstanceRole" });
    expect(s3?.requests).toEqual([]);
  });

  test("STS refusing fails it by the error's name, never its message", async () => {
    const session = await open({ caller: { kind: "error", status: 403, code: "AccessDenied" } });
    expect(session).toEqual({ kind: "failed", failure: "AccessDenied" });
  });

  test("STS that never answers fails it at its deadline", async () => {
    const started = Date.now();
    const session = await open({ caller: { kind: "hang" }, deadlineMs: 300 });
    expect(session).toEqual({ kind: "failed", failure: "DeadlineExceeded" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("creating archive objects", () => {
  test("each put creates once with If-None-Match: * and the caller's account as bucket owner", async () => {
    const session = await opened();
    expect(await put(session, KEY, "{}")).toEqual({ kind: "created" });
    expect(await put(session, KEY, "{ }")).toEqual({ kind: "exists" });
    expect(s3?.requests).toEqual([
      `PUT /${BUCKET}/${KEY} if-none-match=* owner=${ACCOUNT}`,
      `PUT /${BUCKET}/${KEY} if-none-match=* owner=${ACCOUNT}`,
    ]);
    expect(s3?.objects.get(`${BUCKET}/${KEY}`)?.body).toBe("{}");
    expect(s3?.sessionTokens).toEqual([IMDS_SESSION_TOKEN, IMDS_SESSION_TOKEN]);
  });

  test("a denied or conflicting put fails by S3's error name", async () => {
    const session = await opened();
    if (s3 === undefined) throw new Error("no stub");
    s3.refuse = () => ({ status: 403, code: "AccessDenied" });
    expect(await put(session, KEY, "{}")).toEqual({ kind: "failed", failure: "AccessDenied" });
    s3.refuse = () => undefined;
    s3.conflictNextPut();
    expect(await put(session, KEY, "{}")).toEqual({
      kind: "failed",
      failure: "ConditionalRequestConflict",
    });
    expect(await put(session, KEY, "{}")).toEqual({ kind: "created" });
  });

  test("a bucket of another account is refused through ExpectedBucketOwner", async () => {
    const session = await opened();
    if (s3 === undefined) throw new Error("no stub");
    s3.stop();
    s3 = stubS3({ buckets: { [BUCKET]: { owner: "210987654321" } } });
    const elsewhere = await withMetadataEndpoint(imds?.endpoint ?? "", () =>
      openInstanceArchive(
        { bucket: BUCKET, region: "us-east-1" },
        { endpoints: { s3: s3?.endpoint ?? "", sts: sts?.endpoint ?? "" } },
      ),
    );
    if (elsewhere.kind !== "opened") throw new Error("not opened");
    sessions.push(elsewhere);
    expect(await put(elsewhere, KEY, "{}")).toEqual({ kind: "failed", failure: "AccessDenied" });
    expect(session.account).toBe(ACCOUNT);
  });

  test("a network failure fails the put by its error code", async () => {
    const session = await opened({ s3Endpoint: CLOSED_ENDPOINT });
    const outcome = await put(session, KEY, "{}");
    expect(outcome).toEqual({ kind: "failed", failure: "ECONNREFUSED" });
  });

  test("S3 that never answers fails the put at its deadline", async () => {
    const session = await opened({ hangS3: true, deadlineMs: 300 });
    const started = Date.now();
    expect(await put(session, KEY, "{}")).toEqual({ kind: "failed", failure: "DeadlineExceeded" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
