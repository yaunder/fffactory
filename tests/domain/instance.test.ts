import { describe, expect, test } from "bun:test";
import {
  assessCompleteness,
  type FactoryInstance,
  parseFactoryId,
  parseFactoryInstance,
  parseHostKey,
} from "../../src/domain/instance";

const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:factory/tailscale-AbCdEf";

function completeDocument(): Record<string, unknown> {
  return {
    schema_version: 1,
    release: "0.1.0",
    factory_id: "yaunder-v2",
    name: "Yaunder factory",
    aws: { account_id: "123456789012", region: "us-east-1" },
    state_backend: { bucket: "yaunder-v2-fffactory-state" },
    network: {
      vpc_cidr: "10.78.0.0/16",
      public_subnet_cidr: "10.78.1.0/24",
      availability_zone: "us-east-1a",
    },
    tailscale: { tag: "tag:software-factory", auth_key_secret: SECRET_ARN },
    repositories: [
      {
        key: "factory",
        remote: "https://github.com/yaunder/fffactory.git",
        path: "factory",
        branch: "main",
      },
    ],
    hosts: [
      {
        key: "builder-1",
        instance_type: "m7i.xlarge",
        root_volume_gib: 200,
        paseo_password_secret: SECRET_ARN,
        repositories: ["factory"],
        dispatch: {
          enabled: false,
          cron: "*/15 * * * *",
          timezone: "UTC",
          provider: "claude",
          model: "claude-sonnet-5",
          mode: "default",
          cwd: "/home/factory",
        },
      },
    ],
  };
}

function issuesFor(document: unknown) {
  const result = parseFactoryInstance(document);
  if (result.valid) throw new Error("expected the document to be invalid");
  return result.issues;
}

function parsed(document: unknown): FactoryInstance {
  const result = parseFactoryInstance(document);
  if (!result.valid) throw new Error(`expected valid: ${JSON.stringify(result.issues)}`);
  return result.instance;
}

describe("factory ID", () => {
  test.each(["abc", "yaunder-v2", "f7k2q9x", "a1-b2-c3", "abcdefghijklmnopqrst"])(
    "accepts %p",
    (id) => {
      expect(parseFactoryId(id).ok).toBe(true);
    },
  );

  test.each([
    ["too short", "ab"],
    ["too long", "abcdefghijklmnopqrstu"],
    ["uppercase", "Yaunder"],
    ["leading digit", "1factory"],
    ["trailing hyphen", "factory-"],
    ["double hyphen", "fac--tory"],
    ["underscore", "fac_tory"],
    ["dot", "fac.tory"],
  ])("rejects %s", (_reason, id) => {
    expect(parseFactoryId(id).ok).toBe(false);
  });
});

describe("host key", () => {
  test.each(["b", "builder-1", "gpu2"])("accepts %p", (key) => {
    expect(parseHostKey(key).ok).toBe(true);
  });

  test.each(["", "Builder", "1builder", "builder_1", "builder-", "b".repeat(33)])(
    "rejects %p",
    (key) => {
      expect(parseHostKey(key).ok).toBe(false);
    },
  );
});

describe("parseFactoryInstance", () => {
  test("accepts a complete document", () => {
    expect(parseFactoryInstance(completeDocument()).valid).toBe(true);
  });

  test("accepts a partial document holding only the schema version", () => {
    expect(parseFactoryInstance({ schema_version: 1 }).valid).toBe(true);
  });

  test("accepts an editor $schema reference", () => {
    expect(parseFactoryInstance({ $schema: "../schemas/x.json", schema_version: 1 }).valid).toBe(
      true,
    );
  });

  test("rejects a document that is not an object", () => {
    expect(issuesFor([])).toEqual([{ path: "(root)", message: "must be an object" }]);
  });

  test("requires the schema version", () => {
    expect(issuesFor({})).toEqual([{ path: "schema_version", message: "is required" }]);
  });

  test("rejects an unsupported schema version", () => {
    expect(issuesFor({ schema_version: 2 })).toEqual([
      { path: "schema_version", message: "must be 1" },
    ]);
  });

  test("rejects an invalid factory ID with its field path", () => {
    const [issue] = issuesFor({ ...completeDocument(), factory_id: "Not_Valid" });
    expect(issue?.path).toBe("factory_id");
  });

  test("rejects unrecognized fields", () => {
    expect(issuesFor({ schema_version: 1, tailscale: { auth_key: "x" } })).toEqual([
      { path: "tailscale.auth_key", message: "is not a recognized field" },
    ]);
  });

  test.each([
    ["constructor", { schema_version: 1, constructor: 1 }],
    ["toString", { schema_version: 1, toString: "x" }],
    ["__proto__", JSON.parse('{"schema_version":1,"__proto__":{"a":1}}')],
    ["hosts[0].hasOwnProperty", { schema_version: 1, hosts: [{ key: "a", hasOwnProperty: "x" }] }],
    ["hosts[0].constructor", { schema_version: 1, hosts: [{ key: "a", constructor: "x" }] }],
    ["network.valueOf", { schema_version: 1, network: { valueOf: "x" } }],
    ["hosts[0].__proto__", JSON.parse('{"schema_version":1,"hosts":[{"key":"a","__proto__":{}}]}')],
  ])("rejects the built-in object property %s as an unrecognized field", (path, document) => {
    expect(issuesFor(document)).toEqual([{ path, message: "is not a recognized field" }]);
  });

  test.each([
    ["release", { release: "latest" }],
    ["aws.account_id", { aws: { account_id: "12345" } }],
    ["aws.region", { aws: { region: "US East" } }],
    ["state_backend.bucket", { state_backend: { bucket: "Bad_Bucket" } }],
    ["network.vpc_cidr", { network: { vpc_cidr: "10.0.0.300/16" } }],
    ["network.public_subnet_cidr", { network: { public_subnet_cidr: "10.0.0.0/33" } }],
    ["network.vpc_cidr", { network: { vpc_cidr: "10.0.0.0/08" } }],
    ["network.availability_zone", { network: { availability_zone: "us-east-1" } }],
    ["tailscale.tag", { tailscale: { tag: "software-factory" } }],
    ["name", { name: "" }],
    ["hosts", { hosts: {} }],
    ["hosts[0].key", { hosts: [{}] }],
    ["hosts[0].instance_type", { hosts: [{ key: "a", instance_type: "big" }] }],
    ["hosts[0].root_volume_gib", { hosts: [{ key: "a", root_volume_gib: 4 }] }],
    ["hosts[0].dispatch.enabled", { hosts: [{ key: "a", dispatch: { enabled: "yes" } }] }],
    ["hosts[0].dispatch.cwd", { hosts: [{ key: "a", dispatch: { cwd: "home/factory" } }] }],
    ["hosts[0].dispatch.cwd", { hosts: [{ key: "a", dispatch: { cwd: "/bad\npath" } }] }],
    ["repositories[0].remote", { repositories: [{ key: "r", remote: "git@github.com:a/b" }] }],
  ])("rejects an invalid %s", (path, fields) => {
    const paths = issuesFor({ schema_version: 1, ...fields }).map((issue) => issue.path);
    expect(paths).toContain(path);
  });

  describe("secret references", () => {
    test("accepts a Secrets Manager ARN", () => {
      const instance = parsed({ schema_version: 1, tailscale: { auth_key_secret: SECRET_ARN } });
      expect(String(instance.tailscale?.auth_key_secret)).toBe(SECRET_ARN);
    });

    test.each([
      [
        "tailscale.auth_key_secret",
        { tailscale: { auth_key_secret: "tskey-auth-kX1234CNTRL-abc" } },
      ],
      [
        "hosts[0].paseo_password_secret",
        { hosts: [{ key: "a", paseo_password_secret: "correct horse battery staple" }] },
      ],
    ])("rejects a raw secret value in %s without echoing it", (path, fields) => {
      const issues = issuesFor({ schema_version: 1, ...fields });
      expect(issues.map((issue) => issue.path)).toEqual([path]);
      expect(issues[0]?.message).toContain("Secrets Manager secret ARN");
      expect(JSON.stringify(issues)).not.toMatch(/tskey|horse/);
    });

    const elsewhere = {
      Region: "arn:aws:secretsmanager:eu-west-2:123456789012:secret:factory/elsewhere-AbCdEf",
      account: "arn:aws:secretsmanager:us-east-1:210987654321:secret:factory/elsewhere-AbCdEf",
    };
    const messages = {
      Region: "must be a secret in the factory Region, aws.region",
      account: "must be a secret in the factory account, aws.account_id",
    };

    test.each(["Region", "account"] as const)(
      "rejects a secret in another %s in every secret field, without echoing it",
      (kind) => {
        const document = completeDocument();
        const arn = elsewhere[kind];
        const issues = issuesFor({
          ...document,
          tailscale: { tag: "tag:software-factory", auth_key_secret: arn },
          hosts: [
            (document.hosts as Record<string, unknown>[])[0],
            { key: "builder-2", paseo_password_secret: arn },
          ],
        });
        expect(issues).toEqual([
          { path: "tailscale.auth_key_secret", message: messages[kind] },
          { path: "hosts[1].paseo_password_secret", message: messages[kind] },
        ]);
        expect(JSON.stringify(issues)).not.toContain("elsewhere");
      },
    );

    test("checks a secret's Region and account only once aws declares them", () => {
      for (const arn of Object.values(elsewhere)) {
        expect(
          parseFactoryInstance({ schema_version: 1, tailscale: { auth_key_secret: arn } }).valid,
        ).toBe(true);
      }
      expect(
        issuesFor({
          schema_version: 1,
          aws: { region: "us-east-1" },
          tailscale: { auth_key_secret: elsewhere.Region },
        }),
      ).toEqual([{ path: "tailscale.auth_key_secret", message: messages.Region }]);
      expect(
        issuesFor({
          schema_version: 1,
          aws: { account_id: "123456789012" },
          hosts: [{ key: "a", paseo_password_secret: elsewhere.account }],
        }),
      ).toEqual([{ path: "hosts[0].paseo_password_secret", message: messages.account }]);
    });
  });

  describe("host keys", () => {
    test("rejects duplicate host keys", () => {
      const issues = issuesFor({
        schema_version: 1,
        hosts: [{ key: "a" }, { key: "b" }, { key: "a" }],
      });
      expect(issues).toEqual([{ path: "hosts[2].key", message: 'duplicates host key "a"' }]);
    });

    test("rejects placement of an undeclared repository", () => {
      const issues = issuesFor({
        schema_version: 1,
        hosts: [{ key: "a", repositories: ["nope"] }],
      });
      expect(issues).toEqual([
        { path: "hosts[0].repositories[0]", message: 'references undeclared repository "nope"' },
      ]);
    });
  });

  describe("state bucket", () => {
    test("rejects a bucket name that does not start with the factory ID and a hyphen", () => {
      for (const bucket of ["fffactory-state", "yaunder-v2state", "yaunder-v2x-state"]) {
        const issues = issuesFor({ ...completeDocument(), state_backend: { bucket } });
        expect(issues).toEqual([
          {
            path: "state_backend.bucket",
            message:
              "must start with the factory ID and a hyphen, so its name carries the factory ID",
          },
        ]);
      }
    });

    test("accepts a bucket without a factory ID yet, and a factory ID without a bucket", () => {
      expect(
        parseFactoryInstance({ schema_version: 1, state_backend: { bucket: "abc" } }).valid,
      ).toBe(true);
      expect(parseFactoryInstance({ schema_version: 1, factory_id: "abc" }).valid).toBe(true);
    });
  });

  describe("repositories", () => {
    const repository = (key: string, path: string) => ({
      key,
      remote: `https://github.com/yaunder/${key}.git`,
      path,
      branch: "main",
    });

    test("rejects duplicate repository keys", () => {
      const issues = issuesFor({
        schema_version: 1,
        repositories: [repository("a", "a"), repository("a", "b")],
      });
      expect(issues).toEqual([
        { path: "repositories[1].key", message: 'duplicates repository key "a"' },
      ]);
    });

    test("rejects duplicate checkout paths", () => {
      const issues = issuesFor({
        schema_version: 1,
        repositories: [repository("a", "shared"), repository("b", "shared")],
      });
      expect(issues).toEqual([
        { path: "repositories[1].path", message: 'duplicates checkout path "shared"' },
      ]);
    });

    test.each(["../escape", "/absolute", "a/./b", "a//b"])("rejects checkout path %p", (path) => {
      const paths = issuesFor({ schema_version: 1, repositories: [repository("a", path)] }).map(
        (issue) => issue.path,
      );
      expect(paths).toEqual(["repositories[0].path"]);
    });

    test("requires every field of a declared repository", () => {
      const paths = issuesFor({ schema_version: 1, repositories: [{ key: "a" }] }).map(
        (issue) => issue.path,
      );
      expect(paths).toEqual([
        "repositories[0].remote",
        "repositories[0].path",
        "repositories[0].branch",
      ]);
    });
  });

  test("reports every issue rather than only the first", () => {
    expect(issuesFor({ schema_version: 1, factory_id: "X", release: "x" })).toHaveLength(2);
  });
});

describe("assessCompleteness", () => {
  test("a complete document has nothing missing", () => {
    expect(assessCompleteness(parsed(completeDocument()))).toEqual({ complete: true, missing: [] });
  });

  test("a minimal partial document lists every field still needed", () => {
    expect(assessCompleteness(parsed({ schema_version: 1 }))).toEqual({
      complete: false,
      missing: [
        "release",
        "factory_id",
        "name",
        "aws.account_id",
        "aws.region",
        "state_backend.bucket",
        "network.vpc_cidr",
        "network.public_subnet_cidr",
        "network.availability_zone",
        "tailscale.tag",
        "tailscale.auth_key_secret",
        "hosts",
      ],
    });
  });

  test("lists machine fields missing from a declared host", () => {
    const document = { ...completeDocument(), hosts: [{ key: "a" }] };
    expect(assessCompleteness(parsed(document)).missing).toEqual([
      "hosts[0].instance_type",
      "hosts[0].root_volume_gib",
    ]);
  });

  test("an enabled dispatch declaration requires every real schedule input", () => {
    const complete = completeDocument();
    const [host] = complete.hosts as Record<string, unknown>[];
    const report = assessCompleteness(
      parsed({ ...complete, hosts: [{ ...host, dispatch: { enabled: true } }] }),
    );
    expect(report.missing).toEqual([
      "hosts[0].dispatch.cron",
      "hosts[0].dispatch.timezone",
      "hosts[0].dispatch.provider",
      "hosts[0].dispatch.model",
      "hosts[0].dispatch.mode",
      "hosts[0].dispatch.cwd",
    ]);
  });
});
