import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { PlanRefusal } from "../../../src/application/plan-factory";
import { type Block, type Report, render } from "../../../src/cli/presentation/blocks";
import {
  d11Report,
  damagedPlanReport,
  describeRemovalPlan,
  describeStaleReason,
  describeUnexpectedPlan,
  planRefusalReport,
  planSection,
  reviewBlocks,
  savedBootstrapPlanReport,
  savedPlanReport,
  staleReport,
  unknownPlanReport,
} from "../../../src/cli/presentation/plan";
import { ansiStyle, plainStyle } from "../../../src/cli/presentation/style";
import { tlsOnlyPolicy, unreadyBucket } from "../../../src/domain/backend-bootstrap";
import type { FactoryId, HostKey, Release } from "../../../src/domain/instance";
import {
  type FactoryPlanReview,
  hostKeyRemovalRefusal,
  hostMachineRefusal,
  type PlannedWorker,
  type ResizeGuard,
  type ResourceChange,
  type StaleReason,
} from "../../../src/domain/plan";
import {
  assessUpgrade,
  pinMove,
  type ReleaseCompatibility,
  schemaVersionChange,
} from "../../../src/domain/release-compatibility";

const TARGET = {
  instancePath: "/work/.fffactory/factory.json",
  name: "Test factory",
  factoryId: "fff-abcd1234" as FactoryId,
  accountId: "123456789012",
  region: "eu-west-2",
  release: "0.3.0" as Release,
};
const HOST = 'module.hosts.aws_instance.host["builder-1"]';
const release = (value: string) => value as Release;

/** A section's rule line, 53 columns wide, as `render` draws it. */
const rule = (title: string) => `── ${title} ${"─".repeat(Math.max(2, 49 - title.length))}`;
const PLAN = rule("Plan");
const NEXT = rule("Next");
const TARGET_ROWS = [
  "  Factory   Test factory (fff-abcd1234)",
  "  Account   123456789012 · eu-west-2",
  "  Release   0.3.0",
];

/** A block as plain text. */
const plain = (block: Block) => render(plainStyle, [block]);
/** A report as plain text: its blocks, then its Next block. */
const shown = (report: Report) => render(plainStyle, report.blocks, report.next);

function change(address: string, actions: string[], type?: string): ResourceChange {
  return type === undefined ? { address, actions } : { address, type, actions };
}

const WORKERS: PlannedWorker[] = [
  { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" },
  { key: "builder-2" as HostKey, hostname: "fff-abcd1234-builder-2" },
];
const [BUILDER_1, BUILDER_2] = WORKERS as [PlannedWorker, PlannedWorker];

/** A factory review with nothing but its target and the given fields. */
function review(fields: Partial<FactoryPlanReview> = {}): FactoryPlanReview {
  return {
    kind: "factory",
    target: TARGET,
    changes: [],
    workers: [],
    repositories: [],
    controlPlane: [],
    dispatch: [],
    stopped: [],
    ...fields,
  };
}

/** Every stage of one or more workers, as `planFactory` reviews them. */
function staged(workers: readonly PlannedWorker[], fields: Partial<FactoryPlanReview> = {}) {
  return review({
    workers: [...workers],
    repositories: workers.map((worker) => ({ ...worker, placed: [] })),
    controlPlane: workers.map((worker) => ({
      ...worker,
      observation: "no-release",
      changes: ["paseo-package" as const, "service-definition" as const],
    })),
    dispatch: workers.map((worker) => ({ ...worker, requested: false, schedule: null })),
    ...fields,
  });
}

const NO_WORKERS =
  "  Workers          none declared. Declare a host in factory.json's hosts, then create it with `fffactory apply`.";

describe("the plan section (plan-apply §Plan)", () => {
  test("shows the factory, account, Region and release, then infrastructure and every stage", () => {
    expect(
      plain(planSection(staged([BUILDER_1], { changes: [change(HOST, ["create"])] }), {})),
    ).toEqual([
      PLAN,
      ...TARGET_ROWS,
      "",
      "  Infrastructure   1 to add, 0 to change, 0 to destroy",
      `    + ${HOST}`,
      "  Workers          one at a time",
      "    ~ builder-1   install release 0.3.0 and host configuration, then verify",
      "  Control plane    before worker activation",
      "    ~ builder-1   paseo-package, service-definition",
      "  Repositories     one worker at a time",
      "    ~ builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
      "  Dispatch         after every readiness gate",
      "    ~ builder-1   remove the factory dispatch schedule if it exists",
      "  Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule",
    ]);
  });

  test("a factory without a name shows its ID alone", () => {
    const { name: _, ...unnamed } = TARGET;
    expect(plain(planSection(review({ target: unnamed }), {}))[1]).toBe("  Factory   fff-abcd1234");
  });

  test("each change is shown with its glyph, under its tally, and reads and no-ops are left out", () => {
    const changes = [
      change(HOST, ["create"]),
      change("module.network.aws_vpc.this", ["update"]),
      change("module.network.aws_subnet.public", ["delete", "create"]),
      change("module.network.aws_route_table.public", ["create", "delete"]),
      change("module.host_identity.aws_iam_role_policy.read_secrets", ["delete"]),
      change("module.x.aws_thing.gone", ["forget"]),
      change("data.aws_ssm_parameter.al2023", ["read"]),
      change("module.network.aws_internet_gateway.this", ["no-op"]),
    ];
    expect(plain(planSection(review({ changes }), {})).slice(5)).toEqual([
      "  Infrastructure   3 to add, 1 to change, 3 to destroy",
      `    + ${HOST}`,
      "    ~ module.network.aws_vpc.this",
      "    -/+ module.network.aws_subnet.public",
      "    +/- module.network.aws_route_table.public",
      "    - module.host_identity.aws_iam_role_policy.read_secrets",
      "    module.x.aws_thing.gone (forget)",
      NO_WORKERS,
    ]);
  });

  test("a plan that changes nothing says so", () => {
    const changes = [change("data.aws_ssm_parameter.al2023", ["read"])];
    expect(plain(planSection(review({ changes }), {})).slice(5, 6)).toEqual([
      "  Infrastructure   no changes",
    ]);
  });

  test("an empty factory's plan says it declares no worker, and how to add one (plan-apply §An empty factory)", () => {
    expect(plain(planSection(review(), {}))).toEqual([
      PLAN,
      ...TARGET_ROWS,
      "",
      "  Infrastructure   no changes",
      NO_WORKERS,
    ]);
  });

  test("each worker in the order they are updated, its hostname not repeated", () => {
    const repositories = [
      { ...BUILDER_1, placed: ["factory"] },
      { ...BUILDER_2, placed: [] },
    ];
    expect(plain(planSection(staged(WORKERS, { repositories }), {})).slice(5, 15)).toEqual([
      "  Infrastructure   no changes",
      "  Workers          one at a time",
      "    ~ builder-1   install release 0.3.0 and host configuration, then verify",
      "    ~ builder-2   install release 0.3.0 and host configuration, then verify",
      "  Control plane    before worker activation",
      "    ~ builder-1   paseo-package, service-definition",
      "    ~ builder-2   paseo-package, service-definition",
      "  Repositories     one worker at a time",
      "    ~ builder-1   reconcile 1 placed repository as factory; preserve and report unmanaged checkouts",
      "    ~ builder-2   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
    ]);
  });

  test("a stopped worker's install, and every later stage's change, is shown skipped (plan-apply §Stopped workers)", () => {
    const stopped = staged(WORKERS, { stopped: ["builder-2" as HostKey] });
    expect(plain(planSection(stopped, {})).slice(5)).toEqual([
      "  Infrastructure   no changes",
      "  Workers          one at a time",
      "    ~ builder-1   install release 0.3.0 and host configuration, then verify",
      "      builder-2   skipped: stopped; start it with `fffactory worker start builder-2`, then apply again to install it",
      "  Control plane    before worker activation",
      "    ~ builder-1   paseo-package, service-definition",
      "      builder-2   skipped: stopped",
      "  Repositories     one worker at a time",
      "    ~ builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
      "      builder-2   skipped: stopped",
      "  Dispatch         after every readiness gate",
      "    ~ builder-1   remove the factory dispatch schedule if it exists",
      "      builder-2   skipped: stopped",
      "  Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule",
    ]);
  });

  test("an unchanged control plane and a requested dispatch schedule are shown as planned", () => {
    const shown = staged([BUILDER_1], {
      controlPlane: [{ ...BUILDER_1, observation: "{}", changes: [] }],
      dispatch: [
        {
          ...BUILDER_1,
          requested: true,
          schedule: {
            cron: "*/15 * * * *",
            timezone: "UTC",
            provider: "codex",
            model: "configured-model",
            mode: "workspace-write",
            cwd: "/home/factory",
          },
        },
      ],
    });
    const lines = plain(planSection(shown, {}));
    expect(lines.slice(8, 10)).toEqual([
      "  Control plane    before worker activation",
      "    builder-1   Paseo is unchanged",
    ]);
    expect(lines.slice(-3, -1)).toEqual([
      "  Dispatch         after every readiness gate",
      "    ~ builder-1   install the dispatcher and skill, then reconcile */15 * * * * UTC with codex/configured-model, mode workspace-write, cwd /home/factory",
    ]);
  });

  test("an upgrade's plan shows its pin move beside the release (plan-apply §The pin move and the plan)", () => {
    const shown = review({ pinMove: pinMove("0.2.0", release("0.3.0")) });
    expect(plain(planSection(shown, {})).slice(0, 6)).toEqual([
      PLAN,
      "  Factory   Test factory (fff-abcd1234)",
      "  Account   123456789012 · eu-west-2",
      "  Release   0.3.0",
      "  Pin       factory.json's release pin moves from 0.2.0 to 0.3.0, written once you approve this plan, before anything is applied",
      "",
    ]);
    expect(reviewBlocks(shown, {})).toEqual([planSection(shown, {})]);
  });

  test("never echoes a pin whose prerelease text could hold anything", () => {
    const lines = plain(
      planSection(review({ pinMove: pinMove("0.2.9-SECRETLIKE", release("0.3.0")) }), {}),
    );
    expect(lines[4]).toBe(
      "  Pin       factory.json's release pin moves from the release it pins now to 0.3.0, written once you approve this plan, before anything is applied",
    );
    expect(lines.join("\n")).not.toContain("SECRETLIKE");
  });

  test("in color, the rule is dim, the title and labels bold, and each change glyph in its color", () => {
    const lines = render(ansiStyle, [
      planSection(staged([BUILDER_1], { changes: [change(HOST, ["create"])] }), {}),
    ]);
    expect(lines[0]).toBe(
      `${ansiStyle.rule("──")} ${ansiStyle.heading("Plan")} ${ansiStyle.rule("─".repeat(45))}`,
    );
    expect(lines[1]).toBe(`  ${ansiStyle.label("Factory")}   Test factory (fff-abcd1234)`);
    expect(lines[5]).toBe(
      `  ${ansiStyle.label("Infrastructure")}   1 to add, 0 to change, 0 to destroy`,
    );
    expect(lines[6]).toBe(`    ${ansiStyle.status("create", "+")} ${HOST}`);
    expect(lines[8]).toBe(
      `    ${ansiStyle.glyph("update")} ${ansiStyle.label("builder-1")}   install release 0.3.0 and host configuration, then verify`,
    );
    expect(lines[6]).toContain("\x1b[32m");
    expect(lines[8]).toContain("\x1b[33m");
    expect(lines.map((line) => stripVTControlCharacters(line))).toEqual(
      render(plainStyle, [
        planSection(staged([BUILDER_1], { changes: [change(HOST, ["create"])] }), {}),
      ]),
    );
  });
});

describe("data in the plan is shown verbatim (cli output §Layout blocks)", () => {
  const ODD = "/work/`odd` dir";
  const odd = staged([BUILDER_1], {
    target: { ...TARGET, name: "my `odd` factory" },
    dispatch: [
      {
        ...BUILDER_1,
        requested: true,
        schedule: {
          cron: "*/15 * * * *",
          timezone: "UTC",
          provider: "codex",
          model: "a`model",
          mode: "workspace-write",
          cwd: ODD,
        },
      },
    ],
  });
  const DISPATCH = `install the dispatcher and skill, then reconcile */15 * * * * UTC with codex/a\`model, mode workspace-write, cwd ${ODD}`;

  test("the factory name and dispatch values keep their backticks, plain and in color", () => {
    const lines = plain(planSection(odd, {}));
    expect(lines[1]).toBe("  Factory   my `odd` factory (fff-abcd1234)");
    expect(lines.at(-2)).toBe(`    ~ builder-1   ${DISPATCH}`);
    const colored = render(ansiStyle, [planSection(odd, {})]);
    expect(colored[1]).toBe(`  ${ansiStyle.label("Factory")}   my \`odd\` factory (fff-abcd1234)`);
    expect(colored.at(-2)).toBe(
      `    ${ansiStyle.glyph("update")} ${ansiStyle.label("builder-1")}   ${DISPATCH}`,
    );
  });

  test("a stale plan's other factory.json, and an issue's path, keep their backticks in color", () => {
    const stale = render(
      ansiStyle,
      staleReport("k3x9q2ab", [{ kind: "other_instance", instancePath: ODD }], {}).blocks,
    );
    expect(stale[1]).toBe(`  it was planned for another factory.json, ${ODD}`);
    const issues = render(
      ansiStyle,
      planRefusalReport(
        {
          kind: "refused",
          issues: [{ path: "hosts[0].`x`", message: "is not a recognized field" }],
        },
        { action: "plan", now: new Date(0), selection: {} },
      ).blocks,
    );
    expect(issues[1]).toBe("  hosts[0].`x`: is not a recognized field");
  });

  test("the commands a plan row names carry the instance and profile given", () => {
    const selection = { instance: "/a b/factory.json", profile: "factory" };
    const stopped = staged(WORKERS, { stopped: ["builder-2" as HostKey] });
    expect(plain(planSection(stopped, selection))[8]).toBe(
      "      builder-2   skipped: stopped; start it with `fffactory worker start builder-2 --instance '/a b/factory.json' --profile factory`, then apply again to install it",
    );
    expect(plain(planSection(review(), selection))[6]).toBe(
      "  Workers          none declared. Declare a host in factory.json's hosts, then create it with `fffactory apply --instance '/a b/factory.json' --profile factory`.",
    );
    expect(render(ansiStyle, [planSection(review(), selection)])[6]).toEndWith(
      `${ansiStyle.code("fffactory apply --instance '/a b/factory.json' --profile factory")}.`,
    );
  });
});

describe("what `fffactory plan` prints after the plan (plan-apply §Plan, §Saved plans)", () => {
  const SAVED = { plan_id: "k3x9q2ab", expires_at: "2026-09-30T13:00:00.000Z" };

  test("the spec's example: the plan's every stage, the plan saved, and how to apply it", () => {
    const first = staged([BUILDER_1], {
      changes: [change("module.network.aws_vpc.this", ["create"]), change(HOST, ["create"])],
      controlPlane: [
        {
          ...BUILDER_1,
          observation: "no-release",
          changes: ["paseo-package", "service-definition", "listen-address", "password"],
        },
      ],
    });
    expect(shown(savedPlanReport(first, SAVED, {}))).toEqual([
      PLAN,
      ...TARGET_ROWS,
      "",
      "  Infrastructure   2 to add, 0 to change, 0 to destroy",
      "    + module.network.aws_vpc.this",
      `    + ${HOST}`,
      "  Workers          one at a time",
      "    ~ builder-1   install release 0.3.0 and host configuration, then verify",
      "  Control plane    before worker activation",
      "    ~ builder-1   paseo-package, service-definition, listen-address, password",
      "  Repositories     one worker at a time",
      "    ~ builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
      "  Dispatch         after every readiness gate",
      "    ~ builder-1   remove the factory dispatch schedule if it exists",
      "  Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule",
      "",
      "Saved as plan k3x9q2ab, until 2026-09-30T13:00:00.000Z.",
      "",
      NEXT,
      "  Apply exactly this plan:",
      "    $ fffactory apply --plan-id k3x9q2ab",
    ]);
  });

  test("the saved plan, then a Next block applying exactly it", () => {
    expect(shown(savedPlanReport(review(), SAVED, {})).slice(-5)).toEqual([
      "Saved as plan k3x9q2ab, until 2026-09-30T13:00:00.000Z.",
      "",
      NEXT,
      "  Apply exactly this plan:",
      "    $ fffactory apply --plan-id k3x9q2ab",
    ]);
  });

  test("the apply command repeats the instance and profile, quoted for a POSIX shell", () => {
    const selection = { instance: "/elsewhere/it's my factory.json", profile: "factory" };
    expect(shown(savedPlanReport(review(), SAVED, selection)).at(-1)).toBe(
      "    $ fffactory apply --plan-id k3x9q2ab --instance '/elsewhere/it'\\''s my factory.json' --profile factory",
    );
  });

  test("before the bucket exists, bootstrap's plan saved, then applying it and planning the factory", () => {
    const report = savedBootstrapPlanReport(
      {
        kind: "backend_bootstrap",
        target: { ...TARGET, bucket: "fff-abcd1234-state" },
        creates: ["module.state_bucket.aws_s3_bucket.state"],
      },
      { plan_id: "b00tstr4", expires_at: "2026-09-30T13:00:00.000Z" },
      { profile: "factory" },
    );
    expect(shown(report)).toEqual([
      rule("Plan: backend bootstrap"),
      ...TARGET_ROWS,
      "",
      "  State bucket     fff-abcd1234-state, which does not exist yet",
      "  Infrastructure   1 to add, 0 to change, 0 to destroy",
      "    + module.state_bucket.aws_s3_bucket.state",
      "",
      "Saved as plan b00tstr4, until 2026-09-30T13:00:00.000Z.",
      "The factory itself is planned once the state bucket exists.",
      "",
      NEXT,
      "  Apply exactly this plan:",
      "    $ fffactory apply --plan-id b00tstr4 --profile factory",
      "  Then plan the factory:",
      "    $ fffactory plan --profile factory",
    ]);
  });
});

describe("the backend bootstrap plan (provisioning §Backend bootstrap)", () => {
  test("is reviewed as its own plan section", () => {
    const bootstrap = {
      kind: "backend_bootstrap" as const,
      target: { ...TARGET, bucket: "fff-abcd1234-state" },
      creates: ["module.state_bucket.aws_s3_bucket.state"],
    };
    const [section] = reviewBlocks(bootstrap, {});
    expect(plain(section as Block)[0]).toBe(rule("Plan: backend bootstrap"));
  });

  test("a plan that is not create-only, or not readable, is refused with each reason", () => {
    expect(
      [
        { kind: "unreadable_plan" } as const,
        { kind: "unreadable_host_keys" } as const,
        { kind: "creates_nothing" } as const,
        { kind: "not_create", change: change("a.z", ["delete", "create"]) } as const,
      ].map(describeUnexpectedPlan),
    ).toEqual([
      "Terraform's plan could not be read",
      "the factory's Terraform state records host keys that cannot be read",
      "the plan creates nothing, though the state bucket does not exist",
      "a.z (delete, create)",
    ]);
  });
});

/** A plan refusal of `plan`, with no instance or profile given. */
const refusal = (refused: PlanRefusal, action = "plan") =>
  shown(planRefusalReport(refused, { action, now: new Date(0), selection: {} }));

describe("refusals to plan (plan-apply §Before anything reaches AWS)", () => {
  test("the CLI/pin match guard is an error status line", () => {
    expect(refusal({ kind: "release_mismatch", message: "factory.json pins another" })).toEqual([
      "✖ Refusing to plan: factory.json pins another",
    ]);
  });

  test("an incomplete factory.json names each missing field", () => {
    expect(
      refusal({
        kind: "refused",
        issues: [{ path: "network.vpc_cidr", message: "is required to plan" }],
      }),
    ).toEqual([
      "✖ Refusing to plan: factory.json is not ready:",
      "  network.vpc_cidr: is required to plan",
    ]);
  });

  test("a Terraform plan fffactory cannot apply names each reason", () => {
    expect(refusal({ kind: "unexpected_plan", unexpected: [{ kind: "unreadable_plan" }] })).toEqual(
      [
        "✖ Refusing to plan: Terraform's plan is not one fffactory can apply:",
        "  Terraform's plan could not be read",
      ],
    );
  });

  test("a held lock shows its holder, and how to break it with the instance and profile given", () => {
    const held = {
      version: "v1",
      record: {
        schema_version: 1 as const,
        lock_id: "aaaaaaaa",
        factory_id: "fff-abcd1234" as FactoryId,
        operation: "apply",
        holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
        acquired_at: "1970-01-01T00:00:00.000Z",
        release: release("0.3.0"),
      },
    };
    const report = planRefusalReport(
      { kind: "locked", held },
      { action: "plan", now: new Date(5 * 60_000), selection: { instance: "/a b/factory.json" } },
    );
    expect(shown(report)).toEqual([
      "✖ The factory is locked by another operation:",
      "  Lock aaaaaaaa: apply by arn:aws:iam::123456789012:user/other on desk",
      "  Acquired 1970-01-01T00:00:00.000Z (5 min ago) by fffactory 0.3.0",
      "",
      NEXT,
      "  Wait for it to finish. If its holder is no longer running, break the lock:",
      "    $ fffactory lock break --instance '/a b/factory.json'",
    ]);
  });
});

describe("an unready state bucket's refusal (provisioning §Backend bootstrap)", () => {
  const BUCKET = "fff-abcd1234-state";
  const LOCATION = { bucket: BUCKET, accountId: "123456789012", region: "eu-west-2" };
  const READY = {
    versioning: "Enabled",
    publicAccessBlocked: true,
    encrypted: true,
    tlsOnly: true,
  };
  const AT = `--region eu-west-2 --bucket ${BUCKET} --expected-bucket-owner 123456789012`;

  function unready(readiness: typeof READY | Record<string, unknown>): string[] {
    const bucket = unreadyBucket(LOCATION, { ...READY, ...readiness });
    if (bucket === undefined) throw new Error("the bucket is ready");
    return refusal({ kind: "unready", bucket });
  }

  test("names what is missing, then the commands that complete it", () => {
    expect(unready({ versioning: undefined, tlsOnly: false })).toEqual([
      `✖ The state bucket ${BUCKET} exists, but backend bootstrap did not finish it. It lacks:`,
      "  versioning (never enabled)",
      "  TLS-only bucket policy",
      "",
      NEXT,
      "  If another first apply is still bootstrapping it, wait for that to finish, then retry.",
      "",
      "  Otherwise complete the bucket with these AWS CLI commands, using credentials for " +
        "account 123456789012, then retry:",
      `    $ aws s3api put-bucket-versioning ${AT} --versioning-configuration Status=Enabled`,
      `    $ aws s3api put-bucket-policy ${AT} --policy '${tlsOnlyPolicy(BUCKET)}'`,
      "  put-bucket-policy replaces the whole bucket policy: add any statements it already has.",
    ]);
  });

  test("the commands restore every setting, in the order bootstrap applies them", () => {
    const lines = unready({
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
      `    $ aws s3api put-bucket-versioning ${AT} --versioning-configuration Status=Enabled`,
      `    $ aws s3api put-public-access-block ${AT} --public-access-block-configuration ` +
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
      `    $ aws s3api put-bucket-encryption ${AT} --server-side-encryption-configuration ` +
        '\'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}\'',
      `    $ aws s3api put-bucket-policy ${AT} --policy '${tlsOnlyPolicy(BUCKET)}'`,
      "  put-bucket-policy replaces the whole bucket policy: add any statements it already has.",
    ]);
  });

  test("without the policy missing there is no whole-policy warning", () => {
    expect(unready({ encrypted: false }).at(-1)).toBe(
      `    $ aws s3api put-bucket-encryption ${AT} --server-side-encryption-configuration ` +
        '\'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}\'',
    );
  });
});

describe("D11 refusals (plan-apply §Refusals until lifecycle work lands (D11))", () => {
  test("destroying or replacing a host machine names the missing capability", () => {
    const refused = hostMachineRefusal([
      change(HOST, ["delete", "create"], "aws_instance"),
      change('module.hosts.aws_instance.host["old"]', ["delete"], "aws_instance"),
    ]);
    expect(refusal({ kind: "d11", refusal: refused as NonNullable<typeof refused> })).toEqual([
      "✖ Refusing: this change needs host replacement, which fffactory does not have yet " +
        "(D11; it arrives in milestone M3):",
      `  ${HOST} would be replaced`,
      '  module.hosts.aws_instance.host["old"] would be destroyed',
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Change factory.json so the plan keeps every host machine, then plan again.",
    ]);
  });

  test("removing a provisioned host key by hand names the command that removes one", () => {
    const refused = hostKeyRemovalRefusal([
      { path: "hosts", message: 'host key "builder-1" is provisioned but no longer declared' },
    ]);
    expect(shown(d11Report(refused as NonNullable<typeof refused>))).toEqual([
      "✖ Refusing: this change needs host removal, which only `fffactory worker terminate KEY` " +
        "does (D11):",
      '  hosts: host key "builder-1" is provisioned but no longer declared',
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Declare every provisioned host key in factory.json again, then remove a host with " +
        "`fffactory worker terminate KEY`.",
    ]);
  });

  const COMPATIBLE: ReleaseCompatibility = {
    schema_version: 1,
    base_generation: 1,
    base_generation_since: release("0.0.0"),
  };

  test("an upgrade needing a newer base generation names base migration, never the pin", () => {
    const assessment = assessUpgrade("0.2.9-SECRETLIKE", release("0.3.1"), {
      ...COMPATIBLE,
      base_generation: 2,
      base_generation_since: release("0.3.0"),
    });
    if (assessment.kind !== "d11") throw new Error("expected a D11 refusal");
    const lines = shown(d11Report(assessment.refusal));
    expect(lines).toEqual([
      "✖ Refusing: this change needs base migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  release 0.3.1 needs base generation 2, which arrived in release 0.3.0: workers set up by the release factory.json pins have an older base",
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  factory.json still pins its release; keep using that release until base migration arrives.",
    ]);
    expect(lines.join("\n")).not.toContain("SECRETLIKE");
  });

  test("an earlier schema version names schema migration", () => {
    const change = schemaVersionChange(JSON.stringify({ schema_version: 1 }), {
      ...COMPATIBLE,
      schema_version: 2,
    });
    if (change?.kind !== "d11") throw new Error("expected a D11 refusal");
    expect(shown(d11Report(change.refusal)).slice(0, 2)).toEqual([
      "✖ Refusing: this change needs schema migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  factory.json has schema version 1, and this release reads and writes schema version 2",
    ]);
  });

  test("in color, the refusal's status line is bold red and its inline code cyan", () => {
    const refused = hostKeyRemovalRefusal([{ path: "hosts", message: "gone" }]);
    const [line] = render(ansiStyle, d11Report(refused as NonNullable<typeof refused>).blocks);
    expect(line).toStartWith(
      `${ansiStyle.verdict("error", "✖")} ${ansiStyle.verdict("error", "Refusing: this change needs host removal, which only ")}${ansiStyle.code("fffactory worker terminate KEY")}`,
    );
  });

  test("removal commands preserve literal backticks in the selection, plain and colored", () => {
    const refused = hostKeyRemovalRefusal([
      { path: "hosts", message: "Restore it, then run `fffactory worker terminate builder-1`." },
    ]);
    if (refused === undefined) throw new Error("expected a D11 refusal");
    const report = planRefusalReport(
      { kind: "d11", refusal: refused },
      {
        action: "plan",
        now: new Date(0),
        selection: { instance: "/my `factory`/it's.json", profile: "production's `account`" },
      },
    );
    const selection =
      " --instance '/my `factory`/it'\\''s.json' --profile 'production'\\''s `account`'";
    const command = `fffactory worker terminate KEY${selection}`;
    const keyed = `fffactory worker terminate builder-1${selection}`;
    const plain = shown(report);
    expect(plain[0]).toContain(`\`${command}\``);
    expect(plain[1]).toContain(`\`${keyed}\``);
    expect(plain.at(-1)).toContain(`\`${command}\``);
    const colored = render(ansiStyle, report.blocks, report.next);
    expect(colored[0]).toContain(ansiStyle.code(command));
    expect(colored[1]).toContain(ansiStyle.code(keyed));
    expect(colored.at(-1)).toContain(ansiStyle.code(command));
  });

  test("selection leaves host replacement and migration guidance unchanged", () => {
    const replacement = hostMachineRefusal([change(HOST, ["delete"], "aws_instance")]);
    const base = assessUpgrade("0.2.9", release("0.3.1"), {
      ...COMPATIBLE,
      base_generation: 2,
      base_generation_since: release("0.3.0"),
    });
    const schema = schemaVersionChange(JSON.stringify({ schema_version: 1 }), {
      ...COMPATIBLE,
      schema_version: 2,
    });
    if (replacement === undefined || base.kind !== "d11" || schema?.kind !== "d11")
      throw new Error("expected D11 refusals");
    for (const refused of [replacement, base.refusal, schema.refusal]) {
      expect(
        shown(d11Report(refused, { instance: "/other/factory.json", profile: "production" })),
      ).toEqual(shown(d11Report(refused)));
    }
  });
});

describe("an instance type change on a stopped worker (plan-apply §Instance type of a stopped worker)", () => {
  const B = { key: "b" as HostKey, hostname: "fff-abcd1234-b" };
  const resize = (guard: ResizeGuard, action = "plan") =>
    refusal({ kind: "stopped_resize", ...guard }, action);

  test("is refused: Terraform starts a stopped instance to change its type", () => {
    expect(resize({ inventory: "read", workers: [{ ...BUILDER_1, machine: "stopped" }] })).toEqual([
      "✖ Refusing to plan: the plan changes the instance type of a stopped worker, and Terraform starts a stopped instance to change its type:",
      `  builder-1   ${HOST} would be updated in place`,
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Start it first:",
      "    $ fffactory worker start builder-1",
      "  Then plan again:",
      "    $ fffactory plan",
    ]);
  });

  test("several stopped workers are each named and started", () => {
    const both: ResizeGuard = {
      inventory: "read",
      workers: [
        { ...BUILDER_1, machine: "stopped" },
        { ...B, machine: "stopped" },
      ],
    };
    expect(resize(both, "apply").slice(-5)).toEqual([
      "  Start each first:",
      "    $ fffactory worker start builder-1",
      "    $ fffactory worker start b",
      "  Then plan again:",
      "    $ fffactory plan",
    ]);
  });

  test("a stopping worker is named as stopping, to start once it has stopped", () => {
    expect(resize({ inventory: "read", workers: [{ ...BUILDER_1, machine: "stopping" }] })).toEqual(
      [
        "✖ Refusing to plan: the plan changes the instance type of a stopped worker, and Terraform starts a stopped instance to change its type:",
        `  builder-1   ${HOST} would be updated in place, and it is stopping`,
        "",
        "Nothing was applied.",
        "",
        NEXT,
        "  Start it first, once it has stopped:",
        "    $ fffactory worker start builder-1",
        "  Then plan again:",
        "    $ fffactory plan",
      ],
    );
  });

  test("with the EC2 inventory unreadable, the plan is refused until it can be read", () => {
    expect(resize({ inventory: "unreadable", workers: [BUILDER_1] }, "apply")).toEqual([
      "✖ Refusing to apply: the plan changes the instance type of a worker the EC2 inventory could not be read to check is not stopped, and Terraform starts a stopped instance to change its type:",
      `  builder-1   ${HOST} would be updated in place`,
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Plan again once the EC2 inventory can be read:",
      "    $ fffactory plan",
    ]);
  });

  test("an upgrade's refusal plans again with upgrade", () => {
    expect(resize({ inventory: "unreadable", workers: [BUILDER_1] }, "upgrade").at(-1)).toBe(
      "    $ fffactory upgrade",
    );
  });
});

describe("a saved plan's refusal (plan-apply §Freshness)", () => {
  const key = "builder-1" as HostKey;

  test.each<[StaleReason, string]>([
    [
      { kind: "expired", expiresAt: "2026-09-30T13:00:00.000Z" },
      "it expired at 2026-09-30T13:00:00.000Z",
    ],
    [
      { kind: "other_instance", instancePath: "/work/.fffactory/factory.json" },
      "it was planned for another factory.json, /work/.fffactory/factory.json",
    ],
    [{ kind: "configuration_changed" }, "factory.json changed after it was planned"],
    [
      { kind: "other_release", release: release("0.2.0") },
      "it was planned by fffactory 0.2.0, not this release",
    ],
    [{ kind: "other_assets" }, "it was planned with other release assets than this fffactory's"],
    [
      { kind: "other_account", accountId: "123456789012" },
      "it was planned in AWS account 123456789012, not this one",
    ],
    [{ kind: "state_changed" }, "the factory's Terraform state changed after it was planned"],
    [{ kind: "state_bucket_missing" }, "the state bucket no longer exists"],
    [{ kind: "state_bucket_created" }, "the state bucket was created after it was planned"],
    [
      { kind: "inventory_unreadable", key },
      "the EC2 inventory could not be read to check that worker builder-1 is still stopped",
    ],
    [
      { kind: "worker_started", key },
      "worker builder-1 was stopped when it was planned, and is not now",
    ],
    [
      { kind: "worker_stopped", key },
      "worker builder-1 is stopped now, and was not when it was planned",
    ],
    [
      { kind: "paseo_changed", key, hostname: "fff-abcd1234-builder-1" },
      "Paseo state on fff-abcd1234-builder-1 changed after it was planned",
    ],
  ])("%p reads as its reason", (reason, line) => {
    expect(describeStaleReason(reason)).toBe(line);
  });

  test("a stale plan is refused with its reason and a new plan as the way forward", () => {
    expect(shown(staleReport("k3x9q2ab", [{ kind: "configuration_changed" }], {}))).toEqual([
      "✖ Refusing to apply plan k3x9q2ab: it is no longer the plan to apply:",
      "  factory.json changed after it was planned",
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Review a new plan:",
      "    $ fffactory plan",
    ]);
  });

  test("every reason is named, and the new plan repeats the instance and profile given", () => {
    const reasons: StaleReason[] = [{ kind: "configuration_changed" }, { kind: "state_changed" }];
    const lines = shown(staleReport("k3x9q2ab", reasons, { profile: "factory" }));
    expect(lines.slice(1, 3)).toEqual([
      "  factory.json changed after it was planned",
      "  the factory's Terraform state changed after it was planned",
    ]);
    expect(lines.at(-1)).toBe("    $ fffactory plan --profile factory");
  });

  test("a stale bootstrap plan is refused like any other, with the bucket's reason", () => {
    expect(shown(staleReport("b00tstr4", [{ kind: "state_bucket_created" }], {}))).toEqual([
      "✖ Refusing to apply plan b00tstr4: it is no longer the plan to apply:",
      "  the state bucket was created after it was planned",
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Review a new plan:",
      "    $ fffactory plan",
    ]);
  });

  test("a worker's Paseo state that changed refuses the plan", () => {
    const reasons: StaleReason[] = [
      { kind: "paseo_changed", key, hostname: "fff-abcd1234-builder-1" },
    ];
    // TODO(re-evaluate when #12 lands): update this expectation to #12's corrected outcome.
    // This refusal fires after Terraform has applied the plan's infrastructure changes, so
    // "Nothing was applied." is known to be misleading here: it is today's wording, not the
    // intended contract.
    expect(shown(staleReport("k3x9q2ab", reasons, {}))).toEqual([
      "✖ Refusing to apply plan k3x9q2ab: it is no longer the plan to apply:",
      "  Paseo state on fff-abcd1234-builder-1 changed after it was planned",
      "",
      "Nothing was applied.",
      "",
      NEXT,
      "  Review a new plan:",
      "    $ fffactory plan",
    ]);
  });

  test("an unknown or damaged plan ID is refused, with a new plan as the way forward", () => {
    expect(shown(unknownPlanReport("zzzzzzzz", {}))).toEqual([
      "✖ There is no saved plan zzzzzzzz for this factory here: it expired, was applied, or " +
        "was saved elsewhere",
      "",
      NEXT,
      "  Review a new plan:",
      "    $ fffactory plan",
    ]);
    expect(shown(damagedPlanReport("k3x9q2ab", {}))[0]).toBe(
      "✖ Saved plan k3x9q2ab cannot be applied: its record cannot be read, or its Terraform " +
        "plan changed after it was saved",
    );
  });
});

describe("the removal plan shown for approval (worker-lifecycle §Terminate (remove))", () => {
  const deleting: ResourceChange[] = [{ address: HOST, type: "aws_instance", actions: ["delete"] }];

  // TODO(re-evaluate when epic #18 restyles `worker terminate`): replace these unstyled lines
  // with the removal plan's blocks.
  test("names the factory, Terraform's changes, the factory.json edit and the devices", () => {
    expect(describeRemovalPlan({ target: TARGET, changes: deleting, worker: BUILDER_1 })).toEqual([
      "Removal plan:",
      "  Configuration: /work/.fffactory/factory.json",
      "  Factory: Test factory (fff-abcd1234)",
      "  AWS account: 123456789012, Region: eu-west-2",
      "  Release: 0.3.0",
      "Infrastructure changes:",
      `  - ${HOST}`,
      "  0 to add, 0 to change, 1 to destroy.",
      "factory.json: remove host builder-1.",
      "Tailnet: delete the devices named fff-abcd1234-builder-1 that carry the factory's tag.",
    ]);
    expect(describeRemovalPlan({ target: TARGET, changes: [], worker: BUILDER_1 })).toContain(
      "Infrastructure: no changes.",
    );
  });
});
