import { describe, expect, test } from "bun:test";
import {
  bootstrapPlanVerdict,
  deniesInsecureTransport,
  describeBootstrapPlan,
  missingHardening,
  type StateBucketReadiness,
  tlsOnlyPolicy,
  unreadyBucketRefusal,
} from "../../src/domain/backend-bootstrap";
import type { FactoryId, Release } from "../../src/domain/instance";
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
    ).toEqual({ ok: false, unexpected: ["a.y (update)", "a.z (delete, create)"] });
  });
});

describe("describeBootstrapPlan", () => {
  test("names the configuration, factory, account, Region, release and each creation", () => {
    expect(
      describeBootstrapPlan(
        {
          instancePath: "/work/.fffactory/factory.json",
          name: "Test factory",
          factoryId: "fff-abcd1234" as FactoryId,
          accountId: "123456789012",
          region: "eu-west-2",
          release: "0.3.0" as Release,
          bucket: "fff-abcd1234-state",
        },
        ["module.state_bucket.aws_s3_bucket.state"],
      ),
    ).toEqual([
      "Backend bootstrap: the state bucket fff-abcd1234-state does not exist yet.",
      "  Configuration: /work/.fffactory/factory.json",
      "  Factory: Test factory (fff-abcd1234)",
      "  AWS account: 123456789012, Region: eu-west-2",
      "  Release: 0.3.0",
      "Terraform will create:",
      "  + module.state_bucket.aws_s3_bucket.state",
    ]);
  });

  test("a factory without a name shows its ID alone", () => {
    const lines = describeBootstrapPlan(
      {
        instancePath: "/f.json",
        factoryId: "fff-abcd1234" as FactoryId,
        accountId: "123456789012",
        region: "eu-west-2",
        release: "0.3.0" as Release,
        bucket: "fff-abcd1234-state",
      },
      [],
    );
    expect(lines[2]).toBe("  Factory: fff-abcd1234");
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
  const TARGET = `--region eu-west-2 --bucket ${BUCKET} --expected-bucket-owner 123456789012`;

  test("the refusal names what is missing and the commands that complete it", () => {
    const lines = unreadyBucketRefusal(CONTEXT, {
      ...READY,
      versioning: undefined,
      tlsOnly: false,
    });
    expect(lines).toEqual([
      `The state bucket ${BUCKET} exists, but backend bootstrap did not finish it. It lacks:`,
      "  versioning (never enabled)",
      "  TLS-only bucket policy",
      "If another first apply is still bootstrapping it, wait for that to finish, then retry.",
      "Otherwise complete the bucket with these AWS CLI commands, using credentials for account " +
        "123456789012, then retry:",
      `  aws s3api put-bucket-versioning ${TARGET} --versioning-configuration Status=Enabled`,
      `  aws s3api put-bucket-policy ${TARGET} --policy '${tlsOnlyPolicy(BUCKET)}'`,
      "put-bucket-policy replaces the whole bucket policy: add any statements it already has.",
    ]);
  });

  test("the commands restore every setting, in the order bootstrap applies them", () => {
    const lines = unreadyBucketRefusal(CONTEXT, {
      versioning: "Suspended",
      publicAccessBlocked: false,
      encrypted: false,
      tlsOnly: false,
    });
    expect(lines.slice(1, 5)).toEqual([
      "  versioning (Suspended)",
      "  public access block",
      "  default encryption",
      "  TLS-only bucket policy",
    ]);
    expect(lines.slice(-5)).toEqual([
      `  aws s3api put-bucket-versioning ${TARGET} --versioning-configuration Status=Enabled`,
      `  aws s3api put-public-access-block ${TARGET} --public-access-block-configuration ` +
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
      `  aws s3api put-bucket-encryption ${TARGET} --server-side-encryption-configuration ` +
        '\'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}\'',
      `  aws s3api put-bucket-policy ${TARGET} --policy '${tlsOnlyPolicy(BUCKET)}'`,
      "put-bucket-policy replaces the whole bucket policy: add any statements it already has.",
    ]);
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
