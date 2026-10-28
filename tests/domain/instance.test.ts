import { describe, expect, test } from "bun:test";
import {
  assessCompleteness,
  deliveredAccounts,
  type FactoryInstance,
  type HostKey,
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
        "tailscale.admin_client_secret",
        { tailscale: { admin_client_secret: "tskey-client-kX1234CNTRL-abc" } },
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
          tailscale: {
            tag: "tag:software-factory",
            auth_key_secret: arn,
            admin_client_secret: arn,
          },
          hosts: [
            (document.hosts as Record<string, unknown>[])[0],
            { key: "builder-2", paseo_password_secret: arn },
          ],
        });
        expect(issues).toEqual([
          { path: "tailscale.auth_key_secret", message: messages[kind] },
          { path: "tailscale.admin_client_secret", message: messages[kind] },
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

  describe("credential references", () => {
    const GITHUB = "arn:aws:secretsmanager:us-east-1:123456789012:secret:f/github-token-AbCdEf";
    const ANTHROPIC = "arn:aws:secretsmanager:us-east-1:123456789012:secret:f/anthropic-AbCdEf";
    const OPENAI = "arn:aws:secretsmanager:us-east-1:123456789012:secret:f/openai-AbCdEf";

    test("accepts all three references and every interactive login", () => {
      const instance = parsed({
        ...completeDocument(),
        credentials: {
          github_token_secret: GITHUB,
          anthropic_api_key_secret: ANTHROPIC,
          openai_api_key_secret: OPENAI,
        },
        hosts: [{ key: "a", interactive_logins: ["github", "anthropic", "openai"] }],
      });
      expect(String(instance.credentials?.github_token_secret)).toBe(GITHUB);
      expect(instance.hosts?.[0]?.interactive_logins).toEqual(["github", "anthropic", "openai"]);
    });

    test("accepts an empty credentials object and an empty interactive login list", () => {
      expect(
        parseFactoryInstance({
          schema_version: 1,
          credentials: {},
          hosts: [{ key: "a", interactive_logins: [] }],
        }).valid,
      ).toBe(true);
    });

    test.each([
      "credentials.github_token_secret",
      "credentials.anthropic_api_key_secret",
      "credentials.openai_api_key_secret",
    ])("rejects a raw secret value in %s without echoing it", (path) => {
      const field = path.split(".")[1] as string;
      const issues = issuesFor({
        schema_version: 1,
        credentials: { [field]: "sk-ant-api03-pasted-material" },
      });
      expect(issues).toEqual([{ path, message: expect.stringContaining("Secrets Manager") }]);
      expect(JSON.stringify(issues)).not.toContain("pasted");
    });

    test("rejects an unknown credential", () => {
      expect(
        issuesFor({ schema_version: 1, credentials: { gitlab_token_secret: GITHUB } }),
      ).toEqual([
        { path: "credentials.gitlab_token_secret", message: "is not a recognized field" },
      ]);
    });

    test("rejects credentials that are not an object", () => {
      expect(issuesFor({ schema_version: 1, credentials: [GITHUB] })).toEqual([
        { path: "credentials", message: "must be an object" },
      ]);
    });

    test.each(["Region", "account"] as const)(
      "rejects a credential in another %s, naming the field only",
      (kind) => {
        const arn =
          kind === "Region"
            ? "arn:aws:secretsmanager:eu-west-2:123456789012:secret:f/elsewhere-AbCdEf"
            : "arn:aws:secretsmanager:us-east-1:210987654321:secret:f/elsewhere-AbCdEf";
        const message =
          kind === "Region"
            ? "must be a secret in the factory Region, aws.region"
            : "must be a secret in the factory account, aws.account_id";
        const issues = issuesFor({
          ...completeDocument(),
          credentials: {
            github_token_secret: arn,
            anthropic_api_key_secret: arn,
            openai_api_key_secret: arn,
          },
        });
        expect(issues).toEqual([
          { path: "credentials.github_token_secret", message },
          { path: "credentials.anthropic_api_key_secret", message },
          { path: "credentials.openai_api_key_secret", message },
        ]);
        expect(JSON.stringify(issues)).not.toContain("elsewhere");
      },
    );

    test("rejects an unknown interactive login without echoing it", () => {
      expect(
        issuesFor({ schema_version: 1, hosts: [{ key: "a", interactive_logins: ["gitlab"] }] }),
      ).toEqual([
        {
          path: "hosts[0].interactive_logins[0]",
          message: "must be one of github, openai, anthropic",
        },
      ]);
    });

    test.each([
      ["a string", "github", "hosts[0].interactive_logins", "must be an array"],
      ["a number", [1], "hosts[0].interactive_logins[0]", "must be a string"],
    ])("rejects interactive logins holding %s", (_kind, logins, path, message) => {
      expect(
        issuesFor({ schema_version: 1, hosts: [{ key: "a", interactive_logins: logins }] }),
      ).toEqual([{ path, message }]);
    });

    test("rejects a duplicate interactive login", () => {
      expect(
        issuesFor({
          schema_version: 1,
          hosts: [{ key: "a", interactive_logins: ["openai", "github", "openai"] }],
        }),
      ).toEqual([
        { path: "hosts[0].interactive_logins[2]", message: 'duplicates account "openai"' },
      ]);
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

  describe("log archive", () => {
    const inRegion = (region: string, enabled: unknown) => ({
      schema_version: 1,
      aws: { account_id: "123456789012", region },
      log_archive: { enabled },
    });

    test.each([true, false])("accepts enabled %p", (enabled) => {
      expect(parsed({ ...completeDocument(), log_archive: { enabled } }).log_archive).toEqual({
        enabled,
      });
    });

    test("rejects an enabled flag that is not a boolean", () => {
      expect(issuesFor({ schema_version: 1, log_archive: { enabled: "true" } })).toEqual([
        { path: "log_archive.enabled", message: "must be a boolean" },
      ]);
    });

    test("requires the enabled flag of a declared archive", () => {
      expect(issuesFor({ schema_version: 1, log_archive: {} })).toEqual([
        { path: "log_archive.enabled", message: "is required" },
      ]);
    });

    test("rejects a configured bucket: the archive's name is derived, never chosen", () => {
      expect(
        issuesFor({ schema_version: 1, log_archive: { enabled: true, bucket: "logs" } }),
      ).toEqual([{ path: "log_archive.bucket", message: "is not a recognized field" }]);
    });

    test("rejects a log archive that is not an object", () => {
      expect(issuesFor({ schema_version: 1, log_archive: true })).toEqual([
        { path: "log_archive", message: "must be an object" },
      ]);
    });

    test.each(["me-south-1", "me-central-1"])(
      "refuses an enabled archive in %s, which lacks the account-regional namespace",
      (region) => {
        expect(issuesFor(inRegion(region, true))).toEqual([
          {
            path: "log_archive.enabled",
            message: `must not be true in ${region}: S3's account-regional namespace, which names the log archive, is not available there`,
          },
        ]);
      },
    );

    describe("its derived bucket name within S3's 63 characters", () => {
      // A 20-character factory ID leaves 21 for the Region: 20 + "-logs-" + 12 + "-" + 21 + "-an".
      const named = (region: string, enabled: unknown) => ({
        ...inRegion(region, enabled),
        factory_id: "a".repeat(20),
      });
      const longest = `us-${"a".repeat(16)}-1`;
      const tooLong = `us-${"a".repeat(17)}-1`;

      test("accepts an enabled archive whose name is exactly 63 characters", () => {
        expect(longest).toHaveLength(21);
        expect(parseFactoryInstance(named(longest, true)).valid).toBe(true);
      });

      test("refuses an enabled archive whose name would exceed them", () => {
        expect(issuesFor(named(tooLong, true))).toEqual([
          {
            path: "log_archive.enabled",
            message:
              "must not be true while the log archive's bucket name, <factory_id>-logs-<aws.account_id>-<aws.region>-an, would be 64 characters, beyond S3's 63",
          },
        ]);
      });

      test("accepts a disabled archive however long the name would be", () => {
        expect(parseFactoryInstance(named(tooLong, false)).valid).toBe(true);
      });
    });

    test("accepts a disabled archive in a Region without the namespace, and one with no Region yet", () => {
      expect(parseFactoryInstance(inRegion("me-south-1", false)).valid).toBe(true);
      expect(
        parseFactoryInstance({ schema_version: 1, log_archive: { enabled: true } }).valid,
      ).toBe(true);
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

describe("deliveredAccounts", () => {
  const GITHUB = "arn:aws:secretsmanager:us-east-1:123456789012:secret:f/github-token-AbCdEf";
  const ANTHROPIC = "arn:aws:secretsmanager:us-east-1:123456789012:secret:f/anthropic-AbCdEf";
  const OPENAI = "arn:aws:secretsmanager:us-east-1:123456789012:secret:f/openai-AbCdEf";
  const ALL = {
    github_token_secret: GITHUB,
    anthropic_api_key_secret: ANTHROPIC,
    openai_api_key_secret: OPENAI,
  };
  const key = (value: string) => value as HostKey;

  function delivered(credentials: unknown, hosts: unknown[], host = "a") {
    const document = { ...completeDocument(), hosts };
    if (credentials !== undefined) Object.assign(document, { credentials });
    return deliveredAccounts(parsed(document), key(host)).map(({ id, secret }) => [
      id,
      String(secret),
    ]);
  }

  test("a factory without credentials delivers nothing", () => {
    expect(delivered(undefined, [{ key: "a" }])).toEqual([]);
    expect(delivered({}, [{ key: "a" }])).toEqual([]);
  });

  test("every referenced account is delivered to a host listing no interactive login, in enrollment order", () => {
    expect(delivered(ALL, [{ key: "a" }])).toEqual([
      ["github", GITHUB],
      ["openai", OPENAI],
      ["anthropic", ANTHROPIC],
    ]);
    expect(delivered(ALL, [{ key: "a", interactive_logins: [] }])).toHaveLength(3);
  });

  test("an account the host keeps on interactive login is not delivered to it", () => {
    expect(delivered(ALL, [{ key: "a", interactive_logins: ["anthropic", "github"] }])).toEqual([
      ["openai", OPENAI],
    ]);
    expect(
      delivered(ALL, [{ key: "a", interactive_logins: ["github", "openai", "anthropic"] }]),
    ).toEqual([]);
  });

  test("an account without a reference is never delivered, listed or not", () => {
    const githubOnly = { github_token_secret: GITHUB };
    expect(delivered(githubOnly, [{ key: "a" }])).toEqual([["github", GITHUB]]);
    expect(delivered(githubOnly, [{ key: "a", interactive_logins: ["openai"] }])).toEqual([
      ["github", GITHUB],
    ]);
  });

  test("each host's interactive logins apply to that host alone", () => {
    const hosts = [{ key: "a", interactive_logins: ["github"] }, { key: "b" }];
    expect(delivered({ github_token_secret: GITHUB }, hosts, "a")).toEqual([]);
    expect(delivered({ github_token_secret: GITHUB }, hosts, "b")).toEqual([["github", GITHUB]]);
  });

  test("a host factory.json does not declare is delivered nothing", () => {
    expect(delivered(ALL, [{ key: "a" }], "gone")).toEqual([]);
  });
});

describe("assessCompleteness", () => {
  test("a complete document has nothing missing", () => {
    expect(assessCompleteness(parsed(completeDocument()))).toEqual({
      complete: true,
      missing: [],
      commands: {},
    });
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
      commands: {},
    });
  });

  test("the Tailscale admin client is optional: no command needs it to plan", () => {
    const complete = completeDocument();
    const tailscale = complete.tailscale as Record<string, unknown>;
    const document = { ...complete, tailscale: { ...tailscale, admin_client_secret: SECRET_ARN } };
    expect(assessCompleteness(parsed(document))).toEqual({
      complete: true,
      missing: [],
      commands: {},
    });
  });

  test("the log archive is optional, enabled or not", () => {
    for (const enabled of [true, false]) {
      const document = { ...completeDocument(), log_archive: { enabled } };
      expect(assessCompleteness(parsed(document)).complete).toBe(true);
    }
  });

  test("credential references and interactive logins are optional", () => {
    const complete = completeDocument();
    const [host] = complete.hosts as Record<string, unknown>[];
    const document = {
      ...complete,
      credentials: { github_token_secret: SECRET_ARN },
      hosts: [{ ...host, interactive_logins: ["openai"] }],
    };
    expect(assessCompleteness(parsed(document))).toEqual({
      complete: true,
      missing: [],
      commands: {},
    });
  });

  test("an empty host list is complete: a factory may declare no worker", () => {
    expect(assessCompleteness(parsed({ ...completeDocument(), hosts: [] }))).toEqual({
      complete: true,
      missing: [],
      commands: {},
    });
  });

  test("an absent host list is still needed: an empty one declares no worker on purpose", () => {
    const { hosts: _hosts, ...document } = completeDocument();
    expect(assessCompleteness(parsed(document))).toEqual({
      complete: false,
      missing: ["hosts"],
      commands: {},
    });
  });

  test("lists machine fields and the Paseo password missing from a declared host", () => {
    const document = { ...completeDocument(), hosts: [{ key: "a" }] };
    expect(assessCompleteness(parsed(document)).missing).toEqual([
      "hosts[0].instance_type",
      "hosts[0].root_volume_gib",
      "hosts[0].paseo_password_secret",
    ]);
  });

  test("every host needs a Paseo password, named with the command that stores it", () => {
    const complete = completeDocument();
    const [host] = complete.hosts as Record<string, unknown>[];
    const { paseo_password_secret: _password, ...passwordless } = host ?? {};
    const document = { ...complete, hosts: [host, { ...passwordless, key: "builder-2" }] };
    expect(assessCompleteness(parsed(document))).toEqual({
      complete: false,
      missing: ["hosts[1].paseo_password_secret"],
      commands: {
        "hosts[1].paseo_password_secret": "fffactory secret set paseo-password --host builder-2",
      },
    });
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
