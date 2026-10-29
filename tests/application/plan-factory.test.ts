import { describe, expect, test } from "bun:test";
import { planFactory } from "../../src/application/plan-factory";
import type { AllowedAccount } from "../../src/application/require-expected-account";
import { newLockRecord } from "../../src/domain/factory-lock";
import type { HostKey, Release } from "../../src/domain/instance";
import { PLAN_KEPT_MS, PLAN_TTL_MS } from "../../src/domain/plan";
import { FAKE_CALLER } from "../support/doctor-fakes";
import {
  ARCHIVE,
  archiving,
  BUCKET,
  currentWorker,
  declaring,
  FACTORY,
  factory,
  NOW,
  planRequest,
  TERRAFORM,
  workerFleet,
} from "../support/factory-world";
import { appliedRecord, installableWorker, machine } from "../support/fake-workers";
import {
  ARCHIVE_ADDRESSES,
  hostAddress,
  NETWORK,
  STATE_BUCKET_ADDRESS,
} from "../support/fake-provisioner";
import { READY_ARCHIVE, READY_BUCKET } from "../support/memory-lock-store";

/** What every plan review shows first. */
const TARGET = {
  instancePath: "/work/.fffactory/factory.json",
  name: "Test factory",
  factoryId: FACTORY,
  accountId: "123456789012",
  region: "eu-west-2",
  release: "0.3.0" as Release,
};
const BUILDER_1 = { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" };
const BUILDER_2 = { key: "builder-2" as HostKey, hostname: "fff-abcd1234-builder-2" };

/** The infrastructure changes a planned review shows, as `ACTIONS ADDRESS`. */
function shownChanges(result: Awaited<ReturnType<typeof planFactory>>): string[] {
  if (result.kind !== "planned") throw new Error(`expected planned, got ${result.kind}`);
  return result.review.changes.map(({ address, actions }) => `${actions.join()} ${address}`);
}

describe("fffactory plan (plan-apply §Plan)", () => {
  test("a first plan reads no host keys, plans the factory root and saves the plan", async () => {
    const { deps, terraform, planStore, lockStore } = factory();
    const result = await planFactory(deps, planRequest());
    expect(result).toEqual({
      kind: "planned",
      review: {
        kind: "factory",
        target: TARGET,
        changes: [
          { address: NETWORK, type: "aws_vpc", actions: ["create"] },
          { address: hostAddress("builder-1"), type: "aws_instance", actions: ["create"] },
        ],
        workers: [BUILDER_1],
        repositories: [{ ...BUILDER_1, placed: [] }],
        controlPlane: [
          {
            ...BUILDER_1,
            observation: "no-release",
            changes: ["paseo-package", "service-definition", "listen-address", "password"],
          },
        ],
        dispatch: [{ ...BUILDER_1, requested: false, schedule: null }],
        stopped: [],
      },
      saved: {
        schema_version: 1,
        plan_id: "aaaaaaaa",
        factory_id: FACTORY,
        instance_path: "/work/.fffactory/factory.json",
        configuration_sha256: "a".repeat(64),
        release: "0.3.0" as Release,
        assets_sha256: "b".repeat(64),
        account_id: "123456789012",
        state_revision: null,
        created_at: NOW.toISOString(),
        expires_at: new Date(NOW.getTime() + PLAN_TTL_MS).toISOString(),
        changes: [
          { address: NETWORK, type: "aws_vpc", actions: ["create"] },
          { address: hostAddress("builder-1"), type: "aws_instance", actions: ["create"] },
        ],
        control_plane: [
          {
            key: "builder-1" as HostKey,
            hostname: "fff-abcd1234-builder-1",
            observation: "no-release",
            changes: ["paseo-package", "service-definition", "listen-address", "password"],
          },
        ],
        dispatch: [
          {
            key: "builder-1" as HostKey,
            hostname: "fff-abcd1234-builder-1",
            requested: false,
            schedule: null,
          },
        ],
        stopped_workers: [],
      },
    });
    const target = {
      configuration: { directory: TERRAFORM, root: "factory" },
      credentials: { source: "--profile" as const, profile: "factory" },
      region: "eu-west-2",
      backend: { bucket: BUCKET },
    };
    const planFile = "/plans/fff-abcd1234/aaaaaaaa/factory.tfplan";
    expect(terraform.calls.map(({ call }) => call)).toEqual(["output", "plan", "showPlan"]);
    expect(terraform.calls[0]?.request).toEqual(target);
    expect(terraform.calls[1]?.request).toMatchObject({
      ...target,
      planFile,
      variables: { factory_id: FACTORY, hosts: { "builder-1": { instance_type: "t3.large" } } },
      // Planning takes no lock, not even Terraform's own on the state.
      stateLock: false,
    });
    expect(planStore.saved.get("fff-abcd1234/aaaaaaaa")).toEqual(
      result.kind === "planned" ? result.saved : undefined,
    );
    expect(lockStore.calls).toEqual([
      `bucketExists ${BUCKET}`,
      `bucketReadiness ${BUCKET}`,
      `read ${BUCKET}`,
      `stateRevision ${BUCKET}`,
    ]);
    expect(lockStore.locks.size).toBe(0);
  });

  test("the plan is bound to the state revision read before planning", async () => {
    const { deps } = factory({ hosts: ["builder-1"] });
    const result = await planFactory(deps, planRequest({ instance: declaring("builder-1", "b2") }));
    expect(result).toMatchObject({ kind: "planned", saved: { state_revision: "revision-0" } });
  });

  test("without infrastructure changes, the plan is the workers' install, and is saved", async () => {
    const { deps, planStore } = factory({ hosts: ["builder-1"] });
    const result = await planFactory(deps, planRequest());
    expect(result).toMatchObject({
      kind: "planned",
      review: {
        changes: [],
        workers: [BUILDER_1],
        repositories: [{ ...BUILDER_1, placed: [] }],
        controlPlane: [
          {
            ...BUILDER_1,
            changes: ["paseo-package", "service-definition", "listen-address", "password"],
          },
        ],
        dispatch: [{ ...BUILDER_1, requested: false, schedule: null }],
        stopped: [],
      },
      saved: { changes: [] },
    });
    expect(planStore.directories.size).toBe(1);
  });

  test("an inspected worker on the desired release and projection plans no Paseo action", async () => {
    const hostname = "fff-abcd1234-builder-1";
    const workers = workerFleet(["builder-1"], {
      [hostname]: installableWorker(appliedRecord(hostname), {
        inspection: currentWorker("builder-1"),
      }),
    });
    const { deps } = factory({ hosts: ["builder-1"], workers });
    const result = await planFactory(deps, planRequest());
    expect(result).toMatchObject({
      kind: "planned",
      saved: {
        control_plane: [{ key: "builder-1", hostname, changes: [] }],
      },
    });
    expect(result).toMatchObject({
      review: { controlPlane: [{ key: "builder-1", hostname, changes: [] }] },
    });
  });

  test("the CLI/pin match guard refuses before anything is read", async () => {
    const { deps, terraform, lockStore, planStore } = factory();
    const result = await planFactory(deps, planRequest({ release: "0.3.1" as Release }));
    expect(result).toMatchObject({ kind: "release_mismatch" });
    expect(terraform.calls).toEqual([]);
    expect(lockStore.calls).toEqual([]);
    expect(planStore.calls).toEqual([]);
  });

  test("an incomplete factory.json is refused with each missing field", async () => {
    const { deps, terraform } = factory();
    const { network: _, ...incomplete } = declaring("builder-1");
    expect(await planFactory(deps, planRequest({ instance: incomplete }))).toEqual({
      kind: "refused",
      issues: [
        { path: "network.vpc_cidr", message: "is required to plan" },
        { path: "network.public_subnet_cidr", message: "is required to plan" },
        { path: "network.availability_zone", message: "is required to plan" },
      ],
    });
    expect(terraform.calls).toEqual([]);
  });

  test("an account the check did not allow is refused", async () => {
    const { deps, lockStore } = factory();
    const other: AllowedAccount = {
      allowed: true,
      verdict: { kind: "match", caller: { ...FAKE_CALLER, account: "210987654321" } },
    };
    expect(await planFactory(deps, planRequest({ account: other }))).toMatchObject({
      kind: "refused",
      issues: [{ path: "aws.account_id" }],
    });
    expect(lockStore.calls).toEqual([]);
  });

  test("without a state bucket, backend bootstrap's plan is saved as a bootstrap plan", async () => {
    const { deps, terraform, planStore, lockStore } = factory({ bucket: false });
    const result = await planFactory(deps, planRequest());
    expect(result).toEqual({
      kind: "bootstrap_planned",
      review: {
        kind: "backend_bootstrap",
        target: { ...TARGET, bucket: BUCKET },
        creates: [STATE_BUCKET_ADDRESS],
      },
      saved: {
        schema_version: 1,
        kind: "bootstrap",
        plan_id: "aaaaaaaa",
        factory_id: FACTORY,
        instance_path: "/work/.fffactory/factory.json",
        configuration_sha256: "a".repeat(64),
        release: "0.3.0" as Release,
        assets_sha256: "b".repeat(64),
        account_id: "123456789012",
        created_at: NOW.toISOString(),
        expires_at: new Date(NOW.getTime() + PLAN_TTL_MS).toISOString(),
        changes: [{ address: STATE_BUCKET_ADDRESS, type: "aws_s3_bucket", actions: ["create"] }],
      },
    });
    // backend.tfplan is planned into the saved plan's own directory, and read back from it.
    expect(
      terraform.calls.map(({ call, request }) => [
        call,
        request.configuration.root,
        "planFile" in request ? request.planFile : undefined,
      ]),
    ).toEqual([
      ["plan", "backend", "/plans/fff-abcd1234/aaaaaaaa/backend.tfplan"],
      ["showPlan", "backend", "/plans/fff-abcd1234/aaaaaaaa/backend.tfplan"],
    ]);
    expect(planStore.saved.get("fff-abcd1234/aaaaaaaa")).toEqual(
      result.kind === "bootstrap_planned" ? result.saved : undefined,
    );
    expect(planStore.calls).toEqual([
      "prune fff-abcd1234",
      "create fff-abcd1234/aaaaaaaa",
      "save fff-abcd1234/aaaaaaaa",
    ]);
    // Planning changes nothing and takes no lock: the bucket is only looked for.
    expect(lockStore.calls).toEqual([`bucketExists ${BUCKET}`]);
    expect(lockStore.buckets.size).toBe(0);
  });

  test("a bootstrap plan that does more than create is refused and saves nothing", async () => {
    const { deps, terraform, planStore } = factory({ bucket: false });
    terraform.world.shown = {
      resource_changes: [
        {
          address: STATE_BUCKET_ADDRESS,
          type: "aws_s3_bucket",
          change: { actions: ["delete", "create"] },
        },
      ],
    };
    expect(await planFactory(deps, planRequest())).toEqual({
      kind: "unexpected_plan",
      unexpected: [
        {
          kind: "not_create",
          change: {
            address: STATE_BUCKET_ADDRESS,
            type: "aws_s3_bucket",
            actions: ["delete", "create"],
          },
        },
      ],
    });
    expect(planStore.saved.size).toBe(0);
    expect(planStore.directories.size).toBe(0);
    expect(planStore.calls.at(-1)).toBe("remove fff-abcd1234/aaaaaaaa");
  });

  test("a failing bootstrap plan leaves no plan behind", async () => {
    const { deps, terraform, planStore } = factory({ bucket: false });
    terraform.world.failNext = "plan";
    await expect(planFactory(deps, planRequest())).rejects.toThrow(
      "`terraform plan` exited with status 1",
    );
    expect(planStore.directories.size).toBe(0);
  });

  test("a bucket bootstrap did not finish is refused", async () => {
    const { deps, lockStore, terraform } = factory();
    lockStore.readiness.set(BUCKET, { ...READY_BUCKET, encrypted: false });
    expect(await planFactory(deps, planRequest())).toMatchObject({ kind: "unready" });
    expect(terraform.calls).toEqual([]);
  });

  test("while another operation holds the lock, planning is refused with its holder", async () => {
    const { deps, lockStore, terraform } = factory({ hosts: ["builder-1"] });
    const held = lockStore.hold(
      BUCKET,
      newLockRecord({
        factoryId: FACTORY,
        operation: "apply",
        holder: { principal: "arn:aws:iam::123456789012:user/other", host: "desk" },
        now: NOW,
        release: "0.3.0" as Release,
        randomBytes: (count) => new Uint8Array(count).fill(3),
      }),
    );
    expect(await planFactory(deps, planRequest())).toEqual({ kind: "locked", held });
    expect(terraform.calls).toEqual([]);
  });

  test("D11: removing a provisioned host key is refused before Terraform plans", async () => {
    const { deps, terraform, planStore } = factory({ hosts: ["builder-1", "builder-2"] });
    const result = await planFactory(deps, planRequest({ instance: declaring("builder-1") }));
    expect(result).toMatchObject({
      kind: "d11",
      refusal: {
        capability: "host removal",
        command: "fffactory worker terminate KEY",
        reasons: [expect.stringContaining('host key "builder-2" is provisioned')],
      },
    });
    expect(terraform.calls.map(({ call }) => call)).toEqual(["output"]);
    expect(planStore.saved.size).toBe(0);
    expect(planStore.directories.size).toBe(0);
  });

  test("D11: a plan that replaces a host is refused and never saved", async () => {
    const { deps, terraform, planStore } = factory({ hosts: ["builder-1"] });
    terraform.world.replace.add("builder-1");
    expect(await planFactory(deps, planRequest())).toEqual({
      kind: "d11",
      refusal: {
        capability: "host replacement",
        reasons: [`${hostAddress("builder-1")} would be replaced`],
        instead: "Change factory.json so the plan keeps every host machine, then plan again.",
      },
    });
    expect(planStore.saved.size).toBe(0);
  });

  test("host keys the state records that cannot be read are refused", async () => {
    const { deps, terraform } = factory({ hosts: ["builder-1"] });
    terraform.world.outputs = { host_keys: "builder-1" };
    expect(await planFactory(deps, planRequest())).toEqual({
      kind: "unexpected_plan",
      unexpected: [{ kind: "unreadable_host_keys" }],
    });
  });

  test("a Terraform plan that cannot be read is refused and never saved", async () => {
    const { deps, terraform, planStore } = factory();
    terraform.world.shown = { resource_changes: "garbled" };
    expect(await planFactory(deps, planRequest())).toEqual({
      kind: "unexpected_plan",
      unexpected: [{ kind: "unreadable_plan" }],
    });
    expect(planStore.directories.size).toBe(0);
  });

  test("a failing Terraform plan fails planning and leaves no plan behind", async () => {
    const { deps, terraform, planStore } = factory();
    terraform.world.failNext = "plan";
    await expect(planFactory(deps, planRequest())).rejects.toThrow(
      "`terraform plan` exited with status 1",
    );
    expect(planStore.directories.size).toBe(0);
  });

  test("a stopped worker's install is shown skipped, and saved with the plan (plan-apply §Stopped workers)", async () => {
    const { deps, fleet, planStore } = factory({ hosts: ["builder-1", "builder-2"] });
    fleet.machines.inventory = {
      kind: "machines",
      machines: [
        machine("builder-1", "running", "i-0000000000000000a"),
        machine("builder-2", "stopped", "i-0000000000000000b"),
      ],
    };
    const result = await planFactory(
      deps,
      planRequest({ instance: declaring("builder-1", "builder-2") }),
    );
    expect(result).toMatchObject({ kind: "planned", saved: { stopped_workers: ["builder-2"] } });
    if (result.kind !== "planned") return;
    // Every stage still lists the stopped worker, which the review shows skipped.
    expect(result.review).toMatchObject({
      workers: [BUILDER_1, BUILDER_2],
      repositories: [BUILDER_1, BUILDER_2],
      controlPlane: [BUILDER_1, BUILDER_2],
      dispatch: [BUILDER_1, BUILDER_2],
      stopped: ["builder-2"],
    });
    const record = planStore.saved.get("fff-abcd1234/aaaaaaaa");
    expect(record?.kind === undefined ? record?.stopped_workers : "a bootstrap plan").toEqual([
      "builder-2" as HostKey,
    ]);
    expect(fleet.machines.reads).toBe(1);
    // Never inspected, even while the tailnet still shows it online: it is sent nothing.
    expect(result.saved.control_plane?.[1]).toEqual({
      key: "builder-2" as HostKey,
      hostname: "fff-abcd1234-builder-2",
      observation: "stopped",
      changes: [],
    });
    expect(fleet.transport.calls.map(({ worker }) => worker.hostname)).not.toContain(
      "fff-abcd1234-builder-2",
    );
  });

  test("an instance type change on a stopped worker is refused, naming the start command, and never saved", async () => {
    const { deps, fleet, terraform, planStore } = factory({ hosts: ["builder-1"] });
    terraform.world.resize.add("builder-1");
    fleet.machines.inventory = { kind: "machines", machines: [machine("builder-1", "stopped")] };
    expect(await planFactory(deps, planRequest())).toEqual({
      kind: "stopped_resize",
      inventory: "read",
      workers: [
        { key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1", machine: "stopped" },
      ],
    });
    expect(planStore.directories.size).toBe(0);
    // A stopping one too: the provider waits for it to stop, then starts it.
    fleet.machines.inventory = { kind: "machines", machines: [machine("builder-1", "stopping")] };
    expect(await planFactory(deps, planRequest())).toMatchObject({
      kind: "stopped_resize",
      workers: [{ key: "builder-1" as HostKey, machine: "stopping" }],
    });
    expect(planStore.directories.size).toBe(0);
    // A running worker's resize is planned as before: Terraform stops and starts it.
    fleet.machines.inventory = { kind: "machines", machines: [machine("builder-1", "running")] };
    const running = await planFactory(deps, planRequest());
    expect(running).toMatchObject({ kind: "planned" });
    expect(shownChanges(running)).toContain(`update ${hostAddress("builder-1")}`);
  });

  test("an EC2 inventory it cannot read refuses any resize, failing closed", async () => {
    const { deps, fleet, terraform, planStore } = factory({ hosts: ["builder-1"] });
    terraform.world.resize.add("builder-1");
    fleet.machines.inventory = { kind: "unavailable", reason: "EC2 DescribeInstances failed: x" };
    expect(await planFactory(deps, planRequest())).toEqual({
      kind: "stopped_resize",
      inventory: "unreadable",
      workers: [{ key: "builder-1" as HostKey, hostname: "fff-abcd1234-builder-1" }],
    });
    expect(planStore.directories.size).toBe(0);
  });

  test("an EC2 inventory it cannot read plans every install, as before", async () => {
    const { deps, fleet } = factory({ hosts: ["builder-1"] });
    fleet.machines.inventory = { kind: "unavailable", reason: "EC2 DescribeInstances failed: x" };
    const result = await planFactory(deps, planRequest());
    expect(result).toMatchObject({ kind: "planned", saved: { stopped_workers: [] } });
    expect(result).toMatchObject({ review: { workers: [BUILDER_1], stopped: [] } });
  });

  test("plans long expired are pruned first", async () => {
    const { deps, planStore } = factory();
    await planFactory(deps, planRequest());
    const later = new Date(NOW.getTime() + PLAN_TTL_MS + PLAN_KEPT_MS + 1);
    await planFactory(
      deps,
      planRequest({ now: later, randomBytes: (n) => new Uint8Array(n).fill(1) }),
    );
    expect([...planStore.saved.keys()]).toEqual(["fff-abcd1234/bbbbbbbb"]);
  });
});

describe("the log archive (plan-apply §The infrastructure stage)", () => {
  const ARCHIVE_PLAN = "/plans/fff-abcd1234/aaaaaaaa/archive.tfplan";
  const ARCHIVE_TARGET = {
    configuration: { directory: TERRAFORM, root: "archive" },
    credentials: { source: "--profile" as const, profile: "factory" },
    region: "eu-west-2",
    backend: {},
  };

  test("without it, S3 is asked nothing of it, no archive root is planned and nothing is recorded", async () => {
    const { deps, lockStore, terraform } = factory({ hosts: ["builder-1"] });
    const result = await planFactory(deps, planRequest());
    expect(result).toMatchObject({ kind: "planned" });
    if (result.kind !== "planned") return;
    expect("archive" in result.review).toBe(false);
    expect("creates_archive" in result.saved).toBe(false);
    expect(lockStore.calls.filter((call) => call.includes(ARCHIVE))).toEqual([]);
    expect(terraform.calls.map(({ request }) => request.configuration.root)).not.toContain(
      "archive",
    );
  });

  test("a missing archive is planned create-only into archive.tfplan, and the plan says it creates it", async () => {
    const { deps, lockStore, terraform } = factory({ hosts: ["builder-1"] });
    const result = await planFactory(deps, planRequest({ instance: archiving("builder-1") }));
    expect(result).toMatchObject({
      kind: "planned",
      review: { archive: { bucket: ARCHIVE, creates: true } },
      saved: { creates_archive: true },
    });
    expect(lockStore.calls).toEqual([
      `bucketExists ${BUCKET}`,
      `bucketReadiness ${BUCKET}`,
      `read ${BUCKET}`,
      `stateRevision ${BUCKET}`,
      `bucketExists ${ARCHIVE}`,
    ]);
    expect(
      terraform.calls.map(({ call, request }) => `${call} ${request.configuration.root}`),
    ).toEqual([
      "plan archive",
      "showPlan archive",
      "output factory",
      "plan factory",
      "showPlan factory",
    ]);
    expect(terraform.calls[0]?.request).toEqual({
      ...ARCHIVE_TARGET,
      planFile: ARCHIVE_PLAN,
      variables: {
        factory_id: FACTORY,
        account_id: "123456789012",
        region: "eu-west-2",
        archive_bucket_suffix: "logs-123456789012-eu-west-2-an",
      },
    });
    expect(terraform.calls[1]?.request).toEqual({ ...ARCHIVE_TARGET, planFile: ARCHIVE_PLAN });
    // The archive's resources are the archive root's, never among the factory root's changes.
    expect(shownChanges(result)).not.toContain(`create ${ARCHIVE_ADDRESSES[0]}`);
  });

  test("a present, ready archive plans nothing for it: an apply after teardown adopts it", async () => {
    const { deps, lockStore, terraform } = factory({ hosts: ["builder-1"] });
    lockStore.buckets.add(ARCHIVE);
    const result = await planFactory(deps, planRequest({ instance: archiving("builder-1") }));
    expect(result).toMatchObject({
      kind: "planned",
      review: { archive: { bucket: ARCHIVE, creates: false } },
      saved: { creates_archive: false },
    });
    expect(lockStore.calls.slice(-2)).toEqual([
      `bucketExists ${ARCHIVE}`,
      `archiveReadiness ${ARCHIVE}`,
    ]);
    expect(terraform.calls.map(({ request }) => request.configuration.root)).not.toContain(
      "archive",
    );
  });

  test("a present archive lacking any of its settings is refused, as an unready state bucket is", async () => {
    const { deps, lockStore, terraform, planStore } = factory({ hosts: ["builder-1"] });
    lockStore.buckets.add(ARCHIVE);
    const readiness = { ...READY_ARCHIVE, abac: undefined, ownership: "ObjectWriter" };
    lockStore.archives.set(ARCHIVE, readiness);
    expect(await planFactory(deps, planRequest({ instance: archiving("builder-1") }))).toEqual({
      kind: "unready_archive",
      bucket: {
        location: { bucket: ARCHIVE, accountId: "123456789012", region: "eu-west-2" },
        readiness,
        missing: ["bucket_owner_enforced", "abac"],
      },
    });
    expect(terraform.calls).toEqual([]);
    expect(planStore.directories.size).toBe(0);
  });

  test("an archive plan that does more than create, or creates nothing, is refused and never saved", async () => {
    const { deps, terraform, planStore } = factory({ hosts: ["builder-1"] });
    const update = {
      address: ARCHIVE_ADDRESSES[1],
      type: "aws_s3_bucket_policy",
      actions: ["update"],
    };
    terraform.world.archiveShown = {
      resource_changes: [{ ...update, change: { actions: update.actions } }],
    };
    expect(await planFactory(deps, planRequest({ instance: archiving("builder-1") }))).toEqual({
      kind: "unexpected_plan",
      unexpected: [{ kind: "not_create", change: update }],
    });
    terraform.world.archiveShown = { resource_changes: [] };
    expect(await planFactory(deps, planRequest({ instance: archiving("builder-1") }))).toEqual({
      kind: "unexpected_plan",
      unexpected: [{ kind: "creates_nothing" }],
    });
    expect(planStore.directories.size).toBe(0);
    expect(terraform.calls.map(({ request }) => request.configuration.root)).not.toContain(
      "factory",
    );
  });
});
