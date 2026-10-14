import { describe, expect, test } from "bun:test";
import {
  describeBootstrapPlan,
  describeD11Refusal,
  describeInfrastructure,
  describePinMove,
  describePlan,
  describeRemovalPlan,
  describeRepositories,
  describeReview,
  describeStaleReason,
  describeStoppedResizeRefusal,
  describeTarget,
  describeUnexpectedPlan,
  describeWorkers,
  staleRefusal,
  unreadyBucketRefusal,
} from "../../../src/cli/presentation/plan";
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
const TARGET_LINES = [
  "  Configuration: /work/.fffactory/factory.json",
  "  Factory: Test factory (fff-abcd1234)",
  "  AWS account: 123456789012, Region: eu-west-2",
  "  Release: 0.3.0",
];
const release = (value: string) => value as Release;

function change(address: string, actions: string[], type?: string): ResourceChange {
  return type === undefined ? { address, actions } : { address, type, actions };
}

/** The plan's line for a factory that declares no worker. */
const NO_WORKERS =
  "Workers: none declared. Declare a host in factory.json's hosts, then create it with `fffactory apply`.";

const WORKERS: PlannedWorker[] = [
  { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" },
  { key: "builder-2" as HostKey, hostname: "fff-abcd1234-builder-2" },
];

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

describe("the plan's presentation (plan-apply §Layer mapping)", () => {
  test("the target shows the configuration path, factory, account, Region and release", () => {
    expect(describeTarget(TARGET)).toEqual(TARGET_LINES);
    const { name: _, ...unnamed } = TARGET;
    expect(describeTarget(unnamed)[1]).toBe("  Factory: fff-abcd1234");
  });

  test("each change is shown with its action, and reads and no-ops are left out", () => {
    expect(
      describeInfrastructure([
        change(HOST, ["create"]),
        change("module.network.aws_vpc.this", ["update"]),
        change("module.network.aws_subnet.public", ["delete", "create"]),
        change("module.network.aws_route_table.public", ["create", "delete"]),
        change("module.host_identity.aws_iam_role_policy.read_secrets", ["delete"]),
        change("module.x.aws_thing.gone", ["forget"]),
        change("data.aws_ssm_parameter.al2023", ["read"]),
        change("module.network.aws_internet_gateway.this", ["no-op"]),
      ]),
    ).toEqual([
      "Infrastructure changes:",
      `  + ${HOST}`,
      "  ~ module.network.aws_vpc.this",
      "  -/+ module.network.aws_subnet.public",
      "  +/- module.network.aws_route_table.public",
      "  - module.host_identity.aws_iam_role_policy.read_secrets",
      "  module.x.aws_thing.gone (forget)",
      "  3 to add, 1 to change, 3 to destroy.",
    ]);
  });

  test("a plan that changes nothing says so", () => {
    expect(describeInfrastructure([change("data.aws_ssm_parameter.al2023", ["read"])])).toEqual([
      "Infrastructure: no changes.",
    ]);
  });

  test("the whole plan is its title, target and infrastructure changes", () => {
    expect(describePlan(review({ changes: [change(HOST, ["create"])] }))).toEqual([
      "Factory plan:",
      ...TARGET_LINES,
      "Infrastructure changes:",
      `  + ${HOST}`,
      "  1 to add, 0 to change, 0 to destroy.",
      NO_WORKERS,
    ]);
  });

  test("an empty factory's plan says it declares no worker, and how to add one", () => {
    expect(describePlan(review())).toEqual([
      "Factory plan:",
      ...TARGET_LINES,
      "Infrastructure: no changes.",
      NO_WORKERS,
    ]);
  });

  test("then each worker's install of the release, in the order they are updated", () => {
    expect(describePlan(review({ workers: WORKERS }))).toEqual([
      "Factory plan:",
      ...TARGET_LINES,
      "Infrastructure: no changes.",
      "Worker changes, one worker at a time:",
      "  ~ builder-1 (fff-abcd1234-builder-1): install release 0.3.0 and its host configuration, then verify it",
      "  ~ builder-2 (fff-abcd1234-builder-2): install release 0.3.0 and its host configuration, then verify it",
    ]);
    expect(describeWorkers([], release("0.3.0"))).toEqual([NO_WORKERS]);
    expect(
      describeRepositories([
        { ...(WORKERS[0] as PlannedWorker), placed: ["factory"] },
        { ...(WORKERS[1] as PlannedWorker), placed: [] },
      ]),
    ).toEqual([
      "Repository changes, one worker at a time:",
      "  ~ builder-1 (fff-abcd1234-builder-1): reconcile 1 placed repository as factory; preserve and report unmanaged checkouts",
      "  ~ builder-2 (fff-abcd1234-builder-2): reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
    ]);
    expect(describeRepositories([])).toEqual([]);
  });

  test("a stopped worker's install, and every later stage's change, is shown skipped (plan-apply §Stopped workers)", () => {
    const shown = review({
      workers: WORKERS,
      repositories: WORKERS.map((worker) => ({ ...worker, placed: [] })),
      controlPlane: WORKERS.map((worker) => ({
        ...worker,
        observation: "unavailable:blocked",
        changes: ["listen-address" as const],
      })),
      dispatch: WORKERS.map((worker) => ({ ...worker, requested: false, schedule: null })),
      stopped: ["builder-2" as HostKey],
    });
    expect(describePlan(shown)).toEqual([
      "Factory plan:",
      ...TARGET_LINES,
      "Infrastructure: no changes.",
      "Worker changes, one worker at a time:",
      "  ~ builder-1 (fff-abcd1234-builder-1): install release 0.3.0 and its host configuration, then verify it",
      "  = builder-2 (fff-abcd1234-builder-2): skipped: stopped; start it with `fffactory worker start builder-2`, then apply again to install it",
      "Control-plane changes, before worker activation:",
      "  ~ builder-1 (fff-abcd1234-builder-1): listen-address",
      "  = builder-2 (fff-abcd1234-builder-2): skipped: stopped",
      "Repository changes, one worker at a time:",
      "  ~ builder-1 (fff-abcd1234-builder-1): reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts",
      "  = builder-2 (fff-abcd1234-builder-2): skipped: stopped",
      "Dispatch changes, after every readiness gate:",
      "  ~ builder-1 (fff-abcd1234-builder-1): remove the factory dispatch schedule if it exists",
      "  = builder-2 (fff-abcd1234-builder-2): skipped: stopped",
      "End-to-end verification: observe each worker's release, repositories, Paseo and actual dispatch schedule.",
    ]);
  });

  test("an unchanged control plane and a requested dispatch schedule are shown as planned", () => {
    const [builder] = WORKERS as [PlannedWorker];
    const shown = review({
      workers: [builder],
      controlPlane: [{ ...builder, observation: "{}", changes: [] }],
      dispatch: [
        {
          ...builder,
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
    expect(describePlan(shown).slice(-5)).toEqual([
      "Control-plane changes, before worker activation:",
      "  = builder-1 (fff-abcd1234-builder-1): Paseo is unchanged",
      "Dispatch changes, after every readiness gate:",
      "  ~ builder-1 (fff-abcd1234-builder-1): install the dispatcher and skill, then reconcile */15 * * * * UTC with codex/configured-model, mode workspace-write, cwd /home/factory",
      "End-to-end verification: observe each worker's release, repositories, Paseo and actual dispatch schedule.",
    ]);
  });

  test("an upgrade's review shows its pin move first", () => {
    const shown = review({ pinMove: pinMove("0.2.0", release("0.3.0")) });
    expect(describePlan(shown).slice(0, 2)).toEqual([
      "Upgrade: factory.json's release pin moves from 0.2.0 to 0.3.0. It is written once you approve this plan, before anything is applied.",
      "Factory plan:",
    ]);
    expect(describeReview(shown)).toEqual(describePlan(shown));
  });
});

describe("the pin move's preview", () => {
  test("names both releases when the pin is a plain release", () => {
    expect(describePinMove(pinMove("0.2.0", release("0.3.0")))).toEqual([
      "Upgrade: factory.json's release pin moves from 0.2.0 to 0.3.0. It is written once you approve this plan, before anything is applied.",
    ]);
  });

  test("never echoes a pin whose prerelease text could hold anything", () => {
    const lines = describePinMove(pinMove("0.2.9-SECRETLIKE", release("0.3.0")));
    expect(lines).toEqual([
      "Upgrade: factory.json's release pin moves from the release it pins now to 0.3.0. It is written once you approve this plan, before anything is applied.",
    ]);
    expect(lines.join("\n")).not.toContain("SECRETLIKE");
  });
});

describe("the backend bootstrap plan (provisioning §Backend bootstrap)", () => {
  const CONTEXT = { ...TARGET, bucket: "fff-abcd1234-state" };

  test("names the configuration, factory, account, Region, release and each creation", () => {
    const lines = [
      "Backend bootstrap: the state bucket fff-abcd1234-state does not exist yet.",
      ...TARGET_LINES,
      "Terraform will create:",
      "  + module.state_bucket.aws_s3_bucket.state",
    ];
    expect(describeBootstrapPlan(CONTEXT, ["module.state_bucket.aws_s3_bucket.state"])).toEqual(
      lines,
    );
    expect(
      describeReview({
        kind: "backend_bootstrap",
        target: CONTEXT,
        creates: ["module.state_bucket.aws_s3_bucket.state"],
      }),
    ).toEqual(lines);
  });

  test("a factory without a name shows its ID alone", () => {
    const { name: _, ...unnamed } = CONTEXT;
    expect(describeBootstrapPlan(unnamed, [])[2]).toBe("  Factory: fff-abcd1234");
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

  function refusal(readiness: typeof READY | Record<string, unknown>): string[] {
    const unready = unreadyBucket(LOCATION, { ...READY, ...readiness });
    if (unready === undefined) throw new Error("the bucket is ready");
    return unreadyBucketRefusal(unready);
  }

  test("names what is missing and the commands that complete it", () => {
    expect(refusal({ versioning: undefined, tlsOnly: false })).toEqual([
      `The state bucket ${BUCKET} exists, but backend bootstrap did not finish it. It lacks:`,
      "  versioning (never enabled)",
      "  TLS-only bucket policy",
      "If another first apply is still bootstrapping it, wait for that to finish, then retry.",
      "Otherwise complete the bucket with these AWS CLI commands, using credentials for account " +
        "123456789012, then retry:",
      `  aws s3api put-bucket-versioning ${AT} --versioning-configuration Status=Enabled`,
      `  aws s3api put-bucket-policy ${AT} --policy '${tlsOnlyPolicy(BUCKET)}'`,
      "put-bucket-policy replaces the whole bucket policy: add any statements it already has.",
    ]);
  });

  test("the commands restore every setting, in the order bootstrap applies them", () => {
    const lines = refusal({
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
      `  aws s3api put-bucket-versioning ${AT} --versioning-configuration Status=Enabled`,
      `  aws s3api put-public-access-block ${AT} --public-access-block-configuration ` +
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
      `  aws s3api put-bucket-encryption ${AT} --server-side-encryption-configuration ` +
        '\'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}\'',
      `  aws s3api put-bucket-policy ${AT} --policy '${tlsOnlyPolicy(BUCKET)}'`,
      "put-bucket-policy replaces the whole bucket policy: add any statements it already has.",
    ]);
  });

  test("without the policy missing there is no whole-policy warning", () => {
    expect(refusal({ encrypted: false }).at(-1)).toBe(
      `  aws s3api put-bucket-encryption ${AT} --server-side-encryption-configuration ` +
        '\'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}\'',
    );
  });
});

describe("D11 refusals", () => {
  test("destroying or replacing a host machine names the missing capability", () => {
    const refusal = hostMachineRefusal([
      change(HOST, ["delete", "create"], "aws_instance"),
      change('module.hosts.aws_instance.host["old"]', ["delete"], "aws_instance"),
    ]);
    expect(describeD11Refusal(refusal as NonNullable<typeof refusal>)).toEqual([
      "Refusing: this change needs host replacement, which fffactory does not " +
        "have yet (D11; it arrives in milestone M3):",
      `  ${HOST} would be replaced`,
      '  module.hosts.aws_instance.host["old"] would be destroyed',
      "Nothing was applied. Change factory.json so the plan keeps every host machine, then plan again.",
    ]);
  });

  test("removing a provisioned host key by hand names the command that removes one", () => {
    const refusal = hostKeyRemovalRefusal([
      { path: "hosts", message: 'host key "builder-1" is provisioned but no longer declared' },
    ]);
    expect(describeD11Refusal(refusal as NonNullable<typeof refusal>)).toEqual([
      "Refusing: this change needs host removal, which only `fffactory worker terminate KEY` " +
        "does (D11):",
      '  hosts: host key "builder-1" is provisioned but no longer declared',
      "Nothing was applied. Declare every provisioned host key in factory.json again, then " +
        "remove a host with `fffactory worker terminate KEY`.",
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
    const lines = describeD11Refusal(assessment.refusal);
    expect(lines).toEqual([
      "Refusing: this change needs base migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  release 0.3.1 needs base generation 2, which arrived in release 0.3.0: workers set up by the release factory.json pins have an older base",
      "Nothing was applied. factory.json still pins its release; keep using that release until base migration arrives.",
    ]);
    expect(lines.join("\n")).not.toContain("SECRETLIKE");
  });

  test("an earlier schema version names schema migration", () => {
    const change = schemaVersionChange(JSON.stringify({ schema_version: 1 }), {
      ...COMPATIBLE,
      schema_version: 2,
    });
    if (change?.kind !== "d11") throw new Error("expected a D11 refusal");
    expect(describeD11Refusal(change.refusal)).toEqual([
      "Refusing: this change needs schema migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  factory.json has schema version 1, and this release reads and writes schema version 2",
      "Nothing was applied. factory.json still pins its release; keep using that release until schema migration arrives.",
    ]);
  });
});

describe("an instance type change on a stopped worker (plan-apply §Stopped workers)", () => {
  const BUILDER_1 = WORKERS[0] as PlannedWorker;
  const B = { key: "b" as HostKey, hostname: "fff-abcd1234-b" };

  test("is refused: Terraform starts a stopped instance to change its type", () => {
    expect(
      describeStoppedResizeRefusal("plan", {
        inventory: "read",
        workers: [{ ...BUILDER_1, machine: "stopped" }],
      }),
    ).toEqual([
      "Refusing to plan: the plan changes the instance type of a stopped worker, and Terraform starts a stopped instance to change its type:",
      `  builder-1 (fff-abcd1234-builder-1): ${HOST} would be updated in place`,
      "Nothing was applied. Start it first with `fffactory worker start builder-1`, then plan again.",
    ]);
  });

  test("several stopped workers are each named", () => {
    const both: ResizeGuard = {
      inventory: "read",
      workers: [
        { ...BUILDER_1, machine: "stopped" },
        { ...B, machine: "stopped" },
      ],
    };
    expect(describeStoppedResizeRefusal("apply", both).at(-1)).toBe(
      "Nothing was applied. Start each first with `fffactory worker start builder-1` and `fffactory worker start b`, then plan again.",
    );
  });

  test("a stopping worker is named as stopping, to start once it has stopped", () => {
    expect(
      describeStoppedResizeRefusal("plan", {
        inventory: "read",
        workers: [{ ...BUILDER_1, machine: "stopping" }],
      }),
    ).toEqual([
      "Refusing to plan: the plan changes the instance type of a stopped worker, and Terraform starts a stopped instance to change its type:",
      `  builder-1 (fff-abcd1234-builder-1): ${HOST} would be updated in place, and it is stopping`,
      "Nothing was applied. Start it first with `fffactory worker start builder-1` once it has stopped, then plan again.",
    ]);
  });

  test("with the EC2 inventory unreadable, the plan is refused until it can be read", () => {
    expect(
      describeStoppedResizeRefusal("apply", { inventory: "unreadable", workers: [BUILDER_1] }),
    ).toEqual([
      "Refusing to apply: the plan changes the instance type of a worker the EC2 inventory could not be read to check is not stopped, and Terraform starts a stopped instance to change its type:",
      `  builder-1 (fff-abcd1234-builder-1): ${HOST} would be updated in place`,
      "Nothing was applied. Plan again once the EC2 inventory can be read.",
    ]);
  });
});

describe("a stale plan's refusal (plan-apply §Apply)", () => {
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

  test("is refused with every reason and the way forward", () => {
    expect(
      staleRefusal("k3x9q2ab", [{ kind: "configuration_changed" }, { kind: "state_changed" }]),
    ).toEqual([
      "Refusing to apply plan k3x9q2ab: it is no longer the plan to apply:",
      "  factory.json changed after it was planned",
      "  the factory's Terraform state changed after it was planned",
      "Nothing was applied. Review a new plan with `fffactory plan`.",
    ]);
  });
});

describe("the removal plan shown for approval (worker-lifecycle §Terminate (remove))", () => {
  const worker = WORKERS[0] as PlannedWorker;
  const deleting: ResourceChange[] = [{ address: HOST, type: "aws_instance", actions: ["delete"] }];

  test("names the factory, Terraform's changes, the factory.json edit and the devices", () => {
    expect(describeRemovalPlan({ target: TARGET, changes: deleting, worker })).toEqual([
      "Removal plan:",
      ...TARGET_LINES,
      "Infrastructure changes:",
      `  - ${HOST}`,
      "  0 to add, 0 to change, 1 to destroy.",
      "factory.json: remove host builder-1.",
      "Tailnet: delete the devices named fff-abcd1234-builder-1 that carry the factory's tag.",
    ]);
    expect(describeRemovalPlan({ target: TARGET, changes: [], worker })).toContain(
      "Infrastructure: no changes.",
    );
  });
});
