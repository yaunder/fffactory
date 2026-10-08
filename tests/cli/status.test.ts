import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import schema from "../../schemas/status-report.schema.json";
import { run } from "../../src/cli/run";
import type { SecretReference } from "../../src/domain/instance";
import { harness } from "../support/cli-harness";
import { fakeCallerIdentity } from "../support/doctor-fakes";
import {
  statusAnswers,
  fakeMachineInventory,
  fakeTailnet,
  fakeTransport,
  inspection,
  installed,
  machine,
  peer,
  peers,
  readyWorker,
  verification,
} from "../support/fake-workers";
import { MemoryInstanceStore } from "../support/memory-instance-store";
import { MemoryLockStore } from "../support/memory-lock-store";
import expected from "./fixtures/status-report.json";

const NEAREST = "/work/repo/.fffactory/factory.json";
const EXAMPLE = JSON.parse(await Bun.file("examples/factory.json").text());
const B1 = "example-builder-1";
const B2 = "example-builder-2";
const B1_PASEO_SECRET = EXAMPLE.hosts[0].paseo_password_secret as SecretReference;
const schemaAccepts = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function store(overrides: Record<string, unknown> = {}) {
  const document = {
    ...EXAMPLE,
    hosts: [
      EXAMPLE.hosts[0],
      { key: "builder-2", instance_type: "m7i.large", root_volume_gib: 100 },
    ],
    ...overrides,
  };
  return new MemoryInstanceStore({ [NEAREST]: JSON.stringify(document) });
}

const RUNNING = fakeMachineInventory({
  kind: "machines",
  machines: [
    machine("builder-1", "running", "i-0000000000000000a"),
    machine("builder-2", "running", "i-0000000000000000b"),
  ],
}).machines;

function ready() {
  return fakeTransport({
    [B1]: statusAnswers(readyWorker("example", "builder-1", "0.1.0", B1_PASEO_SECRET)),
    [B2]: statusAnswers(readyWorker("example", "builder-2", "0.1.0")),
  });
}

/** builder-1 offline in the tailnet, builder-2 ready: the fixture's scenario. */
function offlineScenario() {
  return harness(
    store(),
    {},
    {
      machines: RUNNING,
      tailnet: fakeTailnet(peers(peer(B1, { online: false }), peer(B2))).tailnet,
      transport: ready().transport,
    },
  );
}

describe("fffactory status exit codes", () => {
  test("exits 0 when every worker is ready on the pinned release", async () => {
    const { context, out, err } = harness(
      store(),
      {},
      {
        machines: RUNNING,
        tailnet: fakeTailnet(peers(peer(B1), peer(B2))).tailnet,
        transport: ready().transport,
      },
    );
    expect(await run(["status"], context)).toBe(0);
    expect(err).toEqual([]);
    expect(out.at(-1)).toBe("Ready: all 2 workers are ready.");
  });

  test("an offline worker exits 2 with an unknown release", async () => {
    const { context, out } = offlineScenario();
    expect(await run(["status"], context)).toBe(2);
    expect(out).toContain(
      "             Machine: running (i-0000000000000000a); Tailscale: offline; Release: unknown; Repositories: unknown; Dispatch: unknown",
    );
    expect(out.at(-1)).toBe("Not ready: 1 of 4 entries needs attention.");
  });

  test("interrupted, prints no report: what it saw was cut short (plan-apply §Interruption)", async () => {
    const { context, out } = harness(
      store(),
      {},
      {
        machines: RUNNING,
        tailnet: fakeTailnet(peers(peer(B1), peer(B2))).tailnet,
        transport: ready().transport,
        interrupted: () => true,
      },
    );
    expect(await run(["status"], context)).toBe(1);
    expect(await run(["status", "--json"], context)).toBe(1);
    expect(out.filter((line) => !line.startsWith("Instance: "))).toEqual([]);
  });

  test("a duplicate hostname exits 2, names the next action and connects to neither", async () => {
    const transport = ready();
    const { context, out } = harness(
      store(),
      {},
      {
        machines: RUNNING,
        tailnet: fakeTailnet(peers(peer(B1), peer(B1, { dnsName: `${B1}-1.ts.net.` }), peer(B2)))
          .tailnet,
        transport: transport.transport,
      },
    );
    expect(await run(["status"], context)).toBe(2);
    expect(out.join("\n")).toContain(
      `  not ready  builder-1 (${B1}): 2 Tailscale devices are named ${B1}; fffactory never guesses which is the worker`,
    );
    expect(out.join("\n")).toContain(
      `Next: Remove the stale devices named ${B1} at https://login.tailscale.com/admin/machines`,
    );
    expect(transport.calls.map((call) => call.worker.hostname)).toEqual([B2, B2, B2]);
  });

  test("exits 1 when an inventory could not be read", async () => {
    const { context } = harness(
      store(),
      {},
      {
        machines: fakeMachineInventory({
          kind: "unavailable",
          reason: "EC2 DescribeInstances failed: x",
        }).machines,
        tailnet: fakeTailnet(peers(peer(B1), peer(B2))).tailnet,
        transport: ready().transport,
      },
    );
    expect(await run(["status"], context)).toBe(1);
  });

  test("exits 1 and inspects nothing in another account", async () => {
    const inventory = fakeMachineInventory();
    const identity = fakeCallerIdentity({
      kind: "caller",
      caller: { account: "210987654321", arn: "arn:aws:iam::210987654321:user/other" },
    });
    const { context, out, err } = harness(
      store(),
      {},
      {
        identity: identity.identity,
        machines: inventory.machines,
      },
    );
    expect(await run(["status"], context)).toBe(1);
    expect(err[0]).toStartWith("Refusing to inspect the factory: ");
    expect(inventory.requests).toEqual([]);
    expect(out).toEqual([`Instance: ${NEAREST} (nearest .fffactory/factory.json)`]);
  });

  test("exits 1 for an incomplete or missing factory.json, or bad arguments", async () => {
    const incomplete = harness(store({ hosts: undefined }));
    expect(await run(["status"], incomplete.context)).toBe(1);
    expect(incomplete.err).toEqual([
      "Refusing to inspect the factory: factory.json is not ready:",
      "  hosts: is required for status",
    ]);
    const missing = harness(new MemoryInstanceStore());
    expect(await run(["status"], missing.context)).toBe(1);
    const bogus = harness(store());
    expect(await run(["status", "--bogus"], bogus.context)).toBe(1);
    expect(await run(["status", "--profile", ""], bogus.context)).toBe(1);
    expect(bogus.err).toContain("fffactory status: --profile needs a profile name");
  });

  test("takes no lock and writes nothing", async () => {
    const lockStore = new MemoryLockStore();
    const { context } = harness(store(), {}, { lockStore, machines: RUNNING });
    await run(["status"], context);
    expect(JSON.stringify(lockStore)).toBe(JSON.stringify(new MemoryLockStore()));
  });
});

describe("fffactory status human output", () => {
  test("shows the factory, the inventories and each worker with its next action", async () => {
    const { context, out } = offlineScenario();
    expect(await run(["status"], context)).toBe(2);
    expect(out.join("\n")).toBe(
      [
        `Instance: ${NEAREST} (nearest .fffactory/factory.json)`,
        "fffactory status, release 0.3.0",
        "Factory example in AWS account 123456789012, us-east-1; factory.json pins release 0.1.0",
        "",
        "Inventories:",
        "  ready      EC2 instances: 2 instances carry the factory ID",
        "  ready      Tailscale client: Logged in and running; 2 devices visible",
        "",
        "Workers:",
        `  not ready  builder-1 (${B1}): Offline in the tailnet`,
        "             Machine: running (i-0000000000000000a); Tailscale: offline; Release: unknown; Repositories: unknown; Dispatch: unknown",
        "             Next: Check that the instance is running and that Tailscale is up on it, then rerun `fffactory status`.",
        `  ready      builder-2 (${B2}): Ready on release 0.1.0`,
        "             Machine: running (i-0000000000000000b); Tailscale: online; Release: 0.1.0; Repositories: synchronized; Dispatch: not_requested",
        "",
        "Not ready: 1 of 4 entries needs attention.",
      ].join("\n"),
    );
  });

  test("shows details under a worker, and a machine without an instance", async () => {
    const { context, out } = harness(
      store(),
      {},
      {
        machines: fakeMachineInventory({ kind: "machines", machines: [] }).machines,
      },
    );
    expect(await run(["status"], context)).toBe(2);
    expect(out).toContain(
      "             Machine: absent; Tailscale: not_checked; Release: unknown; Repositories: unknown; Dispatch: unknown",
    );
    const damaged = harness(
      store(),
      {},
      {
        machines: RUNNING,
        tailnet: fakeTailnet(peers(peer(B1), peer(B2))).tailnet,
        transport: fakeTransport({
          [B1]: statusAnswers(inspection(B1, { configuration: { state: "none" } }, "0.0.9")),
          [B2]: statusAnswers(inspection(B2, {}, "0.1.0")),
        }).transport,
      },
    );
    expect(await run(["status"], damaged.context)).toBe(2);
    expect(damaged.out).toContain("               It has no host configuration");
  });
});

describe("fffactory status, enrollment pending (readiness §Enrollment)", () => {
  function pendingScenario() {
    const pending = readyWorker("example", "builder-1", "0.1.0", B1_PASEO_SECRET);
    const installation = pending.installation.state === "succeeded" ? pending.installation : null;
    return harness(
      store(),
      {},
      {
        machines: RUNNING,
        tailnet: fakeTailnet(peers(peer(B1), peer(B2))).tailnet,
        transport: fakeTransport({
          [B1]: statusAnswers({
            ...pending,
            installation: {
              ...(installation ?? installed("0.1.0", null)),
              verification: verification(B1, "pending"),
            },
          }),
          [B2]: statusAnswers(readyWorker("example", "builder-2", "0.1.0")),
        }).transport,
      },
    );
  }

  test("exits 2 and lists each account's exact steps under the worker", async () => {
    const { context, out } = pendingScenario();
    expect(await run(["status"], context)).toBe(2);
    expect(out).toContain(
      "  not ready  builder-1 (example-builder-1): Software ready on release 0.1.0; enrollment " +
        "pending: GitHub, OpenAI Codex, Claude Code",
    );
    expect(out).toContain(
      `               GitHub: Authenticate GitHub as factory on ${B1} (tailnet SSH policy must let you log in as \`factory\`): run \`tailscale ssh factory@${B1}\`, then \`gh auth login --hostname github.com --git-protocol https --web\`, then \`gh auth status\``,
    );
    expect(out).toContain(
      `             Next: Enroll each pending account on ${B1} as listed (tailnet SSH policy must let you log in there as \`factory\`), then verify the enrollment with \`fffactory apply\` and rerun \`fffactory status\`.`,
    );
  });

  test("the JSON report carries each account's state and structured next action", async () => {
    const { context, out } = pendingScenario();
    expect(await run(["status", "--json"], context)).toBe(2);
    const document = JSON.parse(out[0] ?? "");
    expect(schemaAccepts(document)).toBe(true);
    expect(document.workers[0].enrollment[0]).toEqual({
      id: "github",
      title: "GitHub",
      state: "pending",
      next_action: {
        summary: `Authenticate GitHub as factory on ${B1} (tailnet SSH policy must let you log in as \`factory\`)`,
        login: `tailscale ssh factory@${B1}`,
        commands: [
          "gh auth login --hostname github.com --git-protocol https --web",
          "gh auth status",
        ],
      },
    });
  });
});

describe("fffactory status --json", () => {
  test("prints the versioned document, and only it, on standard output", async () => {
    const { context, out, err } = offlineScenario();
    expect(await run(["status", "--json"], context)).toBe(2);
    expect(out).toHaveLength(1);
    expect(err).toEqual([`Instance: ${NEAREST} (nearest .fffactory/factory.json)`]);
    const document = JSON.parse(out[0] ?? "");
    expect(document).toEqual(expected);
    expect(`${out[0]}\n`).toBe(
      await Bun.file(`${import.meta.dir}/fixtures/status-report.json`).text(),
    );
    expect(schemaAccepts(document)).toBe(true);
  });

  test("every worker state validates against the schema", async () => {
    const { context, out } = harness(
      store(),
      {},
      {
        machines: fakeMachineInventory({
          kind: "unavailable",
          reason: "EC2 DescribeInstances failed: x",
        }).machines,
        tailnet: fakeTailnet(peers(peer(B1), peer(B2))).tailnet,
        transport: fakeTransport({
          [B1]: { kind: "completed", exitCode: 127, stdout: "" },
          [B2]: statusAnswers(
            inspection(B2, {
              release: { state: "broken" },
              configuration: { state: "unreadable" },
            }),
          ),
        }).transport,
      },
    );
    expect(await run(["status", "--json"], context)).toBe(1);
    const document = JSON.parse(out[0] ?? "");
    expect(schemaAccepts(document)).toBe(true);
    expect(document.workers.map((w: { release: string }) => w.release)).toEqual(["none", "broken"]);
  });
});
