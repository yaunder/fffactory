import { describe, expect, test } from "bun:test";
import {
  type ArchiveReadiness,
  bootstrapPlanVerdict,
  createOnlyRefusal,
  deniesInsecureTransport,
  missingArchiveHardening,
  missingHardening,
  type StateBucketReadiness,
  tlsOnlyPolicy,
  unreadyArchive,
  unreadyBucket,
} from "../../src/domain/backend-bootstrap";
import { resourceChanges } from "../../src/domain/plan";

const change = (address: string, ...actions: string[]) => ({
  address,
  type: address.split(".").at(-2),
  change: { actions },
});

describe("resourceChanges", () => {
  test("reads each resource's address, type and actions from a JSON plan", () => {
    expect(
      resourceChanges({
        format_version: "1.2",
        resource_changes: [
          change("module.state_bucket.aws_s3_bucket.state", "create"),
          change("data.aws_iam_policy_document.tls_only", "read"),
        ],
      }),
    ).toEqual([
      {
        address: "module.state_bucket.aws_s3_bucket.state",
        type: "aws_s3_bucket",
        actions: ["create"],
      },
      {
        address: "data.aws_iam_policy_document.tls_only",
        type: "aws_iam_policy_document",
        actions: ["read"],
      },
    ]);
  });

  test("a change without a type is read without one", () => {
    expect(
      resourceChanges({ resource_changes: [{ address: "a.b", change: { actions: ["create"] } }] }),
    ).toEqual([{ address: "a.b", actions: ["create"] }]);
  });

  test("a change's mode is read when the plan names it", () => {
    expect(
      resourceChanges({
        resource_changes: [
          { address: "a.b", type: "t", mode: "managed", change: { actions: ["create"] } },
        ],
      }),
    ).toEqual([{ address: "a.b", type: "t", mode: "managed", actions: ["create"] }]);
  });

  test("a plan without resource changes has none", () => {
    expect(resourceChanges({ format_version: "1.2" })).toEqual([]);
  });

  test.each([
    ["not an object", []],
    ["changes that are not a list", { resource_changes: {} }],
    ["a change without an address", { resource_changes: [{ change: { actions: ["create"] } }] }],
    ["a change without actions", { resource_changes: [{ address: "a.b", change: {} }] }],
    // Terraform names at least one action; an empty list fails closed, never "no change".
    ["a change with an empty list of actions", { resource_changes: [change("a.b")] }],
    [
      "an action that is not a string",
      { resource_changes: [{ address: "a.b", change: { actions: [1] } }] },
    ],
    ["an unprintable address", { resource_changes: [change("a.\u001b[2J", "create")] }],
    ["an unprintable action", { resource_changes: [change("a.b", "\u001b[2J")] }],
    [
      "a mode that is not printable text",
      { resource_changes: [{ address: "a.b", mode: 7, change: { actions: ["create"] } }] },
    ],
    [
      "a type that is not printable text",
      { resource_changes: [{ address: "a.b", type: 7, change: { actions: ["create"] } }] },
    ],
  ])("refuses %s", (_, plan) => {
    expect(resourceChanges(plan)).toBeUndefined();
  });
});

describe("bootstrapPlanVerdict", () => {
  test("backend bootstrap may only create; no-op and reads are ignored", () => {
    expect(
      bootstrapPlanVerdict([
        { address: "a.x", actions: ["create"] },
        { address: "a.y", actions: ["no-op"] },
        { address: "data.a.z", actions: ["read"] },
      ]),
    ).toEqual({ ok: true, creates: ["a.x"] });
  });

  test("any update, delete or replacement is refused and listed", () => {
    expect(
      bootstrapPlanVerdict([
        { address: "a.x", actions: ["create"] },
        { address: "a.y", actions: ["update"] },
        { address: "a.z", actions: ["delete", "create"] },
      ]),
    ).toEqual({
      ok: false,
      unexpected: [
        { address: "a.y", actions: ["update"] },
        { address: "a.z", actions: ["delete", "create"] },
      ],
    });
  });
});

describe("createOnlyRefusal (plan-apply §The infrastructure stage)", () => {
  test("a plan that only creates may be applied", () => {
    expect(createOnlyRefusal([{ address: "a.x", actions: ["create"] }])).toBeUndefined();
  });

  test("an unreadable plan, one doing more than create, and one creating nothing are refused", () => {
    expect(createOnlyRefusal(undefined)).toEqual([{ kind: "unreadable_plan" }]);
    const update = { address: "a.y", actions: ["update"] };
    expect(createOnlyRefusal([{ address: "a.x", actions: ["create"] }, update])).toEqual([
      { kind: "not_create", change: update },
    ]);
    expect(createOnlyRefusal([{ address: "data.a.z", actions: ["read"] }])).toEqual([
      { kind: "creates_nothing" },
    ]);
  });
});

describe("log archive readiness (provisioning §Backend bootstrap)", () => {
  const LOCATION = {
    bucket: "fff-abcd1234-logs-123456789012-eu-west-2-an",
    accountId: "123456789012",
    region: "eu-west-2",
  };
  const READY: ArchiveReadiness = {
    versioning: "Enabled",
    publicAccessBlocked: true,
    encrypted: true,
    tlsOnly: true,
    ownership: "BucketOwnerEnforced",
    sseS3: true,
    abac: "Enabled",
  };

  test("an archive the archive root finished is ready", () => {
    expect(missingArchiveHardening(READY)).toEqual([]);
    expect(unreadyArchive(LOCATION, READY)).toBeUndefined();
  });

  test("names each of its settings it lacks, SSE-S3 rather than any encryption", () => {
    const bare: ArchiveReadiness = {
      versioning: "Suspended",
      publicAccessBlocked: false,
      // S3 encrypts every new bucket by default: that alone is not SSE-S3 as the root sets it.
      encrypted: true,
      tlsOnly: false,
      ownership: "ObjectWriter",
      sseS3: false,
      abac: "Disabled",
    };
    expect(missingArchiveHardening(bare)).toEqual([
      "versioning",
      "public_access_block",
      "bucket_owner_enforced",
      "sse_s3",
      "abac",
      "tls_only_policy",
    ]);
    expect(missingArchiveHardening({ ...READY, ownership: undefined, abac: undefined })).toEqual([
      "bucket_owner_enforced",
      "abac",
    ]);
  });

  test("an unready archive carries only where it is, what S3 reports and what it lacks", () => {
    const readiness = { ...READY, sseS3: false };
    const archive = { ...LOCATION, kind: "archive", credentials: { source: "chain" } };
    expect(unreadyArchive(archive, readiness)).toEqual({
      location: LOCATION,
      readiness,
      missing: ["sse_s3"],
    });
  });
});

describe("state bucket readiness", () => {
  const BUCKET = "fff-abcd1234-state";
  const READY: StateBucketReadiness = {
    versioning: "Enabled",
    publicAccessBlocked: true,
    encrypted: true,
    tlsOnly: true,
  };

  test("a bucket backend bootstrap finished is ready", () => {
    expect(missingHardening(READY)).toEqual([]);
  });

  test("names each setting an interrupted bootstrap left out", () => {
    const bare = {
      versioning: undefined,
      publicAccessBlocked: false,
      encrypted: false,
      tlsOnly: false,
    };
    expect(missingHardening(bare)).toEqual([
      "versioning",
      "public_access_block",
      "default_encryption",
      "tls_only_policy",
    ]);
    expect(missingHardening({ ...READY, versioning: "Suspended" })).toEqual(["versioning"]);
  });

  test("the policy backend bootstrap writes denies insecure transport", () => {
    expect(deniesInsecureTransport(tlsOnlyPolicy(BUCKET), BUCKET)).toBe(true);
    const terraform = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyInsecureTransport",
          Effect: "Deny",
          Principal: { AWS: ["*"] },
          Action: ["s3:*"],
          Resource: [`arn:aws:s3:::${BUCKET}/*`, `arn:aws:s3:::${BUCKET}`],
          Condition: { Bool: { "aws:SecureTransport": ["false"] } },
        },
      ],
    };
    expect(deniesInsecureTransport(JSON.stringify(terraform), BUCKET)).toBe(true);
  });

  test.each([
    ["no policy", undefined],
    ["an unreadable policy", "{"],
    ["an Allow statement", tlsOnlyPolicy(BUCKET).replace('"Deny"', '"Allow"')],
    ["another bucket's objects", tlsOnlyPolicy("fff-other111-state")],
    ["a narrower action", tlsOnlyPolicy(BUCKET).replace('"s3:*"', '"s3:GetObject"')],
    ["no transport condition", tlsOnlyPolicy(BUCKET).replace("aws:SecureTransport", "aws:Other")],
    [
      "one principal only",
      tlsOnlyPolicy(BUCKET).replace(
        '"Principal":"*"',
        '"Principal":{"AWS":"arn:aws:iam::123456789012:root"}',
      ),
    ],
  ])("%s does not make the bucket TLS-only", (_, policy) => {
    expect(deniesInsecureTransport(policy, BUCKET)).toBe(false);
  });

  const CONTEXT = { bucket: BUCKET, accountId: "123456789012", region: "eu-west-2" };

  test("an unready bucket carries where it is, what S3 reports and what it lacks, in bootstrap's order", () => {
    const readiness = {
      versioning: "Suspended",
      publicAccessBlocked: true,
      encrypted: false,
      tlsOnly: false,
    };
    // Only the location is carried, never anything else the caller's bucket holds.
    const bucket = { ...CONTEXT, factoryId: "fff-abcd1234" };
    expect(unreadyBucket(bucket, readiness)).toEqual({
      location: CONTEXT,
      readiness,
      missing: ["versioning", "default_encryption", "tls_only_policy"],
    });
    expect(unreadyBucket(CONTEXT, READY)).toBeUndefined();
  });

  test("the policy command writes the bucket's TLS-only policy", () => {
    expect(JSON.parse(tlsOnlyPolicy(BUCKET))).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyInsecureTransport",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:*",
          Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        },
      ],
    });
  });
});
