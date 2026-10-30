/**
 * docs/specs/collector.md §Credentials and publishing, and docs/specs/host-protocol.md §collect:
 * `host collect --once` on a worker laid out in a temporary directory, writing through the real
 * S3 archive writer and AWS SDK to `support/stub-s3.ts` (which refuses any PutObject without
 * `If-None-Match: *`, as the hosts' policy does), signed with credentials from
 * `support/loopback-imds.ts`, its incarnation from `support/stub-sts.ts`. Nothing reaches AWS.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CLAUDE_ROOT,
  type Heartbeat,
  type Incarnation,
  parseHeartbeat,
  parseIncarnation,
} from "../../src/domain/archive-format";
import { COLLECTOR_CONFIGURATION, parseCheckpoint } from "../../src/domain/collector";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import { COLLECTOR_STATE } from "../../src/host/collect";
import {
  BOOT_ID,
  type CollectionSystem,
  localCollectionSystem,
  OPEN_FILES,
  workerCollection,
} from "../../src/host/collection";
import { flockExclusive } from "../../src/host/install-lock";
import {
  type ArchiveSession,
  type ArchiveTarget,
  openInstanceArchive,
} from "../../src/host/s3-archive-writer";
import { CLOSED_ENDPOINT } from "../support/aws-isolation";
import {
  IMDS_SESSION_TOKEN,
  type LoopbackImds,
  loopbackImds,
  withMetadataEndpoint,
} from "../support/loopback-imds";
import { type StubS3, stubS3 } from "../support/stub-s3";
import { EXAMPLE_CREDENTIALS, type StubSts, stubSts } from "../support/stub-sts";

const RELEASE = "0.0.9" as Release;
const ACCOUNT = "123456789012";
const BUCKET = "fff-r29c2un6-logs-123456789012-us-east-1-an";
const ROLE_ID = "AROAEXAMPLEROLEID1234";
const INSTANCE_ID = "i-0123456789abcdef0";
const PREFIX = `archive/1/fff-r29c2un6/workers/${ROLE_ID}:${INSTANCE_ID}/`;
const BOOT = "0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
const SESSION = `${CLAUDE_ROOT}/projects/-home-factory-x/0b6e1c3a.jsonl`;
const SIDECAR = `${CLAUDE_ROOT}/projects/-home-factory-x/0b6e1c3a/subagents/agent-1.meta.json`;
const CONFIGURATION = {
  format: 1,
  factory_id: "fff-r29c2un6",
  host_key: "builder-1",
  bucket: BUCKET,
  region: "us-east-1",
};

let root: string;
let imds: LoopbackImds;
let sts: StubSts;
let s3: StubS3;
let clock: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-collection-"));
  imds = loopbackImds();
  sts = stubSts({
    kind: "caller",
    account: ACCOUNT,
    arn: `arn:aws:sts::${ACCOUNT}:assumed-role/fff-r29c2un6-hosts/${INSTANCE_ID}`,
    userId: `${ROLE_ID}:${INSTANCE_ID}`,
  });
  s3 = stubS3({ buckets: { [BUCKET]: { owner: ACCOUNT } }, requireIfNoneMatch: true });
  clock = Date.parse("2026-10-30T10:15:00.000Z");
  await put(
    `${WORKER_PATHS.releases}/${RELEASE}/steps/versions.env`,
    "CLAUDE_CODE_VERSION=2.1.302\n",
  );
  await put(BOOT_ID, `${BOOT}\n`);
  await put(COLLECTOR_CONFIGURATION, JSON.stringify(CONFIGURATION));
  await put(SESSION, '{"type":"user"}\n');
  await put(SIDECAR, '{"agentType":"general-purpose"}');
});

afterEach(async () => {
  imds.stop();
  sts.stop();
  s3.stop();
  await rm(root, { recursive: true, force: true });
});

const at = (path: string) => join(root, path);

async function put(path: string, content: string) {
  await mkdir(dirname(at(path)), { recursive: true });
  await writeFile(at(path), content);
}

/** Opens the archive through the stand-ins: the real adapter, only its endpoints changed. */
function openThroughStubs(s3Endpoint = s3.endpoint) {
  return (target: ArchiveTarget) =>
    withMetadataEndpoint(imds.endpoint, () =>
      openInstanceArchive(target, { endpoints: { s3: s3Endpoint, sts: sts.endpoint } }),
    );
}

function collectionSystem(overrides: Partial<CollectionSystem> = {}): CollectionSystem {
  return {
    ...localCollectionSystem(RELEASE, root),
    now: () => {
      clock += 1_000;
      return new Date(clock);
    },
    openArchive: openThroughStubs(),
    // Where /proc is not, a source's open path cannot be verified; there, check none.
    ...(platform() === "linux" ? {} : { openFiles: null }),
    ...overrides,
  };
}

const collect = (overrides: Partial<CollectionSystem> = {}) =>
  workerCollection(collectionSystem(overrides)).collect();

const keys = () => [...s3.objects.keys()].map((path) => path.slice(BUCKET.length + 1));
const body = (key: string) => s3.objects.get(`${BUCKET}/${key}`)?.body ?? "";

function heartbeats(): Heartbeat[] {
  return keys()
    .filter((key) => key.startsWith(`${PREFIX}heartbeat/`))
    .sort()
    .map((key) => {
      const parsed = parseHeartbeat(body(key));
      if (!parsed.ok) throw new Error("a heartbeat does not parse");
      return parsed.document;
    });
}

async function checkpointSources() {
  const text = await readFile(at(`${COLLECTOR_STATE}/checkpoint.json`), "utf8");
  const parsed = parseCheckpoint(text);
  if (!parsed.ok) throw new Error("the checkpoint does not parse");
  return parsed.document.sources.map((source) => source.path).sort();
}

describe("a run on a configured worker", () => {
  test("writes incarnation, blobs, a journal record and a heartbeat under its own prefix, each create-once", async () => {
    const result = await collect();

    expect(result).toMatchObject({ kind: "ran", report: { outcome: "succeeded", failure: null } });
    expect(keys().every((key) => key.startsWith(PREFIX))).toBe(true);
    expect(keys().filter((key) => key.includes("/blobs/sha256/"))).toHaveLength(2);
    expect(keys().filter((key) => key.includes("/journal/"))).toHaveLength(1);
    expect(heartbeats()).toHaveLength(1);
    expect(s3.requests.length).toBe(5);
    for (const request of s3.requests)
      expect(request).toMatch(
        new RegExp(`^PUT /${BUCKET}/\\S+ if-none-match=\\* owner=${ACCOUNT}$`),
      );
    expect(s3.requests[0]).toContain(`${PREFIX}incarnation.json`);
    expect(s3.requests.at(-1)).toContain(`${PREFIX}heartbeat/2026-10-30/`);

    const incarnation = parseIncarnation(body(`${PREFIX}incarnation.json`));
    expect(incarnation).toEqual({
      ok: true,
      document: {
        format: 1,
        factory_id: "fff-r29c2un6" as FactoryId,
        host_key: "builder-1" as HostKey,
        role_id: ROLE_ID,
        instance_id: INSTANCE_ID,
        created_at: expect.any(String),
        release: RELEASE,
        claude_code_version: "2.1.302",
        claude_root: CLAUDE_ROOT,
      } satisfies Incarnation,
    });
    const [heartbeat] = heartbeats();
    expect(heartbeat).toMatchObject({
      boot_id: BOOT,
      release: RELEASE,
      claude_code_version: "2.1.302",
      outcome: "succeeded",
      failure: null,
      budget_hit: null,
      journal_seq: 1,
      backlog: { files: 0, bytes: 0 },
    });
    expect(heartbeat?.last_success_at).toBe(heartbeat?.at ?? "");
    if (result.kind !== "ran") throw new Error("did not run");
    expect(heartbeat?.at).toBe(result.report.ended_at);
    expect(heartbeat?.uploaded_bytes).toBe(result.report.uploaded_bytes);
    expect(result.heartbeat).toEqual({ kind: "created" });
    const written = [JSON.stringify(result), ...keys().map(body)].join("\n");
    for (const secret of [EXAMPLE_CREDENTIALS.secretAccessKey, IMDS_SESSION_TOKEN])
      expect(written).not.toContain(secret);
  });

  test("the next run finds incarnation.json already written (412) and still succeeds", async () => {
    await collect();
    const incarnation = body(`${PREFIX}incarnation.json`);

    const result = await collect();

    expect(result).toMatchObject({ kind: "ran", report: { outcome: "succeeded" } });
    expect(body(`${PREFIX}incarnation.json`)).toBe(incarnation);
    expect(heartbeats()).toHaveLength(2);
    expect(heartbeats()[1]).toMatchObject({ journal_seq: null, outcome: "succeeded" });
  });

  test("Claude Code's version unread is null, and the run goes on", async () => {
    await rm(at(`${WORKER_PATHS.releases}/${RELEASE}/steps/versions.env`));
    await collect();
    expect(heartbeats()[0]?.claude_code_version).toBeNull();
    expect(parseIncarnation(body(`${PREFIX}incarnation.json`))).toMatchObject({
      document: { claude_code_version: null },
    });
  });
});

describe("a failing write", () => {
  test("denied, shows its error name in the heartbeat, leaves the checkpoint behind the data, and is retried", async () => {
    s3.refuse = (_method, key) =>
      key.includes("/blobs/") ? { status: 403, code: "AccessDenied" } : undefined;

    const denied = await collect();

    expect(denied).toMatchObject({
      kind: "ran",
      report: { outcome: "failed", failure: "AccessDenied", journal_seq: null },
      heartbeat: { kind: "created" },
    });
    expect(heartbeats()[0]).toMatchObject({
      outcome: "failed",
      failure: "AccessDenied",
      last_success_at: null,
      backlog: { files: 2 },
    });
    expect(keys().some((key) => key.includes("/journal/"))).toBe(false);
    expect(await checkpointSources()).toEqual([]);

    s3.refuse = () => undefined;
    const retried = await collect();

    expect(retried).toMatchObject({
      kind: "ran",
      report: { outcome: "succeeded", journal_seq: 1 },
    });
    expect(heartbeats()[1]).toMatchObject({
      outcome: "succeeded",
      backlog: { files: 0, bytes: 0 },
    });
    expect(await checkpointSources()).toEqual([SESSION, SIDECAR].sort());
  });

  test("failing on the network, shows its error code in the heartbeat", async () => {
    // Blobs go to a closed port; everything else reaches the stub.
    const openArchive = async (target: ArchiveTarget): Promise<ArchiveSession> => {
      const reachable = await openThroughStubs()(target);
      const unreachable = await openThroughStubs(CLOSED_ENDPOINT)(target);
      if (reachable.kind !== "opened" || unreachable.kind !== "opened") throw new Error("closed");
      return {
        ...reachable,
        writer: {
          put: (key, bytes) =>
            (key.includes("/blobs/") ? unreachable : reachable).writer.put(key, bytes),
        },
        close: () => {
          reachable.close();
          unreachable.close();
        },
      };
    };

    const result = await collect({ openArchive });

    expect(result).toMatchObject({ kind: "ran", report: { failure: "ECONNREFUSED" } });
    expect(heartbeats()[0]).toMatchObject({ outcome: "failed", failure: "ECONNREFUSED" });
  });

  test("a heartbeat that cannot be written fails the run, which says so", async () => {
    s3.refuse = (_method, key) =>
      key.includes("/heartbeat/") ? { status: 403, code: "AccessDenied" } : undefined;
    const result = await collect();
    expect(result).toMatchObject({
      kind: "ran",
      report: { outcome: "succeeded" },
      heartbeat: { kind: "failed", failure: "AccessDenied" },
    });
  });
});

describe("a run that cannot start", () => {
  test("without its configuration does nothing at all", async () => {
    await rm(at(COLLECTOR_CONFIGURATION));
    expect(await collect()).toEqual({ kind: "not_configured" });
    expect(imds.requests).toEqual([]);
    expect(sts.requests).toEqual([]);
    expect(s3.requests).toEqual([]);
    expect(await stat(at(COLLECTOR_STATE)).catch(() => undefined)).toBeUndefined();
  });

  test("with a malformed configuration fails, naming the field and never its value", async () => {
    await put(
      COLLECTOR_CONFIGURATION,
      JSON.stringify({ ...CONFIGURATION, bucket: "Not_A_Bucket" }),
    );
    const result = await collect();
    expect(result).toEqual({
      kind: "failed",
      reason: "collector.json is malformed: bucket is missing or malformed",
    });
    expect(imds.requests).toEqual([]);
  });

  test("without instance metadata fails by the provider's error name, writing nothing", async () => {
    imds.stop();
    imds = loopbackImds({ failing: true });
    const result = await collect();
    expect(result).toEqual({
      kind: "failed",
      reason: "the archive could not be opened (InstanceMetadataV1FallbackError)",
    });
    expect(sts.requests).toEqual([]);
    expect(s3.requests).toEqual([]);
    expect(await stat(at(COLLECTOR_STATE)).catch(() => undefined)).toBeUndefined();
  });

  test("without a boot ID fails before the archive is opened", async () => {
    await rm(at(BOOT_ID));
    expect(await collect()).toEqual({ kind: "failed", reason: "the boot ID could not be read" });
    expect(imds.requests).toEqual([]);
  });

  test("while another run holds the collector's lock ends quietly, writing nothing", async () => {
    await mkdir(at(COLLECTOR_STATE), { recursive: true });
    const held = await flockExclusive(at(`${COLLECTOR_STATE}/collect.lock`));
    try {
      expect(await collect()).toEqual({ kind: "busy" });
    } finally {
      held?.release();
    }
    expect(s3.requests).toEqual([]);
  });
});

describe("the worker's own collector", () => {
  test("checks where the kernel finds each source open, in /proc/self/fd, under /", () => {
    expect(OPEN_FILES).toBe("/proc/self/fd");
    const local = localCollectionSystem(RELEASE);
    expect(local.root).toBe("/");
    expect(local.openFiles).toBe(OPEN_FILES);
    expect(localCollectionSystem(RELEASE, root).openFiles).toBe(OPEN_FILES);
  });

  test("opens the archive with instance metadata's credentials alone, and its own clock and randomness", async () => {
    const local = localCollectionSystem(RELEASE);
    expect(local.randomBytes(8)).toHaveLength(8);
    expect(Math.abs(local.now().getTime() - Date.now())).toBeLessThan(60_000);
    // Instance metadata closed and the default chain's sources sealed: nothing else is tried.
    const session = await withMetadataEndpoint(CLOSED_ENDPOINT, () =>
      local.openArchive({ bucket: BUCKET, region: "us-east-1" }),
    );
    expect(session).toEqual({ kind: "failed", failure: "InstanceMetadataV1FallbackError" });
  });

  test("is what the CLI wires: the running release's, on this machine", async () => {
    const main = await readFile(resolve(import.meta.dir, "../../src/cli/main.ts"), "utf8");
    expect(main).toContain("workerCollection(localCollectionSystem(RELEASE))");
  });
});
