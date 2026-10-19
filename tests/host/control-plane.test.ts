import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compareSync } from "bcryptjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "../../src/domain/installation";
import type { FactoryId, HostKey, Release, SecretReference } from "../../src/domain/instance";
import type { ApplySystem } from "../../src/host/apply";
import { workerControlPlane } from "../../src/host/control-plane";
import type {
  ProcessOptions,
  ProcessOutcome,
  ProcessRunner,
} from "../../src/infrastructure/local-tool-probe";
import { system } from "./worker-scenarios";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-control-plane-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:fff-aaaa1111/paseo-AbCdEf" as SecretReference;
const PROJECTION = hostProjectionJson(
  hostProjection("fff-aaaa1111" as FactoryId, "builder-1" as HostKey, "0.3.0" as Release, ARN),
);
const WITHOUT_PASSWORD = hostProjectionJson(
  hostProjection("fff-aaaa1111" as FactoryId, "builder-1" as HostKey, "0.3.0" as Release),
);
const PASSWORD = "Paseo-pw 7f3e9a\u00e9";
const SETUP = "/opt/fffactory/current/steps/control-plane/setup-host.sh";

interface Call {
  readonly argv: readonly string[];
  readonly timeout: number;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string | undefined;
}

/** Answers Secrets Manager with `secret` (its JSON `SecretString`), and every other command 0. */
function recording(secret: ProcessOutcome | string | null = PASSWORD) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (argv, timeout, options?: ProcessOptions) => {
    calls.push({
      argv: [...argv],
      timeout,
      env: { ...(options?.env ?? {}) },
      stdin: options?.stdin === undefined ? undefined : new TextDecoder().decode(options.stdin),
    });
    if (argv[0] !== "/usr/bin/aws") return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    if (typeof secret === "object" && secret !== null) return secret;
    return { kind: "exited", exitCode: 0, stdout: `${JSON.stringify(secret)}\n`, stderr: "" };
  };
  return { calls, run };
}

/** The bcrypt hash setup was sent, after checking the reference line before it. */
function sentHash(calls: readonly Call[]): string {
  const setup = calls.find((call) => call.argv[0] === "/bin/bash");
  const [reference, hash, rest] = (setup?.stdin ?? "").split("\n");
  expect({ reference, rest }).toEqual({ reference: ARN, rest: "" });
  return hash ?? "";
}

function endpoint(
  run: ProcessRunner,
  input = PROJECTION,
  isRoot = true,
  hostname = "fff-aaaa1111-builder-1",
) {
  const worker: ApplySystem = {
    ...system(root),
    run,
    now: () => new Date(),
    isRoot: () => isRoot,
    hostname: () => hostname,
    readInput: async () => input,
    release: "0.3.0" as Release,
    lock: async () => ({ release: () => {} }),
  };
  return workerControlPlane(worker);
}

describe("the worker control-plane endpoint", () => {
  test("reads activity by dropping to factory and using the active release auth wrapper", async () => {
    const calls: readonly string[][] = [];
    const run: ProcessRunner = async (argv) => {
      (calls as string[][]).push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: '{"agents":[{"id":"one"}]}', stderr: "" };
    };
    expect(await endpoint(run).activity()).toEqual({ kind: "active", count: 1 });
    expect(calls[0]).toContain("/usr/sbin/runuser");
    expect(calls[0]).toContain(
      join(root, "/opt/fffactory/current/steps/control-plane/paseo-auth.sh"),
    );
    expect(calls[0]).toContain("factory");
  });

  test.each([
    ["[]", { kind: "idle" as const }],
    ['{"agents":[]}', { kind: "idle" as const }],
    [
      '{"agents":"not-an-array"}',
      { kind: "unknown" as const, reason: "Paseo activity was invalid" },
    ],
    ["not json", { kind: "unknown" as const, reason: "Paseo activity was invalid" }],
  ])("conservatively interprets Paseo activity %s", async (stdout, expected) => {
    const run: ProcessRunner = async () => ({ kind: "exited", exitCode: 0, stdout, stderr: "" });
    expect(await endpoint(run).activity()).toEqual(expected);
  });

  test("treats a failed Paseo activity command as unknown", async () => {
    const run: ProcessRunner = async () => ({ kind: "timed_out" });
    expect(await endpoint(run).activity()).toEqual({
      kind: "unknown",
      reason: "Paseo activity could not be read",
    });
  });

  test("reads the Paseo password by its reference as root and sends setup only the reference and Paseo's bcrypt hash", async () => {
    const { calls, run } = recording();
    expect(await endpoint(run).install()).toEqual({ kind: "done" });
    expect(calls.map((call) => call.argv)).toEqual([
      [
        "/usr/bin/aws",
        "secretsmanager",
        "get-secret-value",
        "--region",
        "us-east-1",
        "--secret-id",
        ARN,
        "--query",
        "SecretString",
        "--output",
        "json",
      ],
      ["/bin/bash", join(root, SETUP)],
    ]);
    expect(calls[0]?.timeout).toBe(CREDENTIAL_COMMAND_TIMEOUT_MS);
    expect(calls[0]?.env).toEqual({
      PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/root",
      LANG: "C.UTF-8",
      AWS_PAGER: "",
    });
    const hash = sentHash(calls);
    // Paseo's own form and cost: bcryptjs's hashSync(password, 12), as `paseo daemon set-password`.
    expect(hash).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{53}$/);
    expect(compareSync(PASSWORD, hash)).toBe(true);
    expect(compareSync(`${PASSWORD}x`, hash)).toBe(false);
  });

  test("the password reaches no argument, environment or setup input, only its hash", async () => {
    const { calls, run } = recording();
    await endpoint(run).install();
    const seen = calls.flatMap((call) => [
      ...call.argv,
      ...Object.values(call.env),
      call.stdin ?? "",
    ]);
    expect(seen.filter((text) => text.includes(PASSWORD))).toEqual([]);
    expect(seen.filter((text) => text.includes("Paseo-pw"))).toEqual([]);
  });

  test("hashes the password as paseo-auth.sh sends it: final line endings dropped, all else kept", async () => {
    const { calls, run } = recording(`  ${PASSWORD} \n\n`);
    expect(await endpoint(run).install()).toEqual({ kind: "done" });
    expect(compareSync(`  ${PASSWORD} `, sentHash(calls))).toBe(true);
  });

  test("a host without a Paseo password reads no secret and sends setup two empty lines", async () => {
    const { calls, run } = recording();
    expect(await endpoint(run, WITHOUT_PASSWORD).install()).toEqual({ kind: "done" });
    expect(calls).toEqual([
      {
        argv: ["/bin/bash", join(root, SETUP)],
        timeout: expect.any(Number),
        env: expect.any(Object),
        stdin: "\n\n",
      },
    ]);
  });

  test.each([
    [
      {
        kind: "exited" as const,
        exitCode: 254,
        stdout: "",
        stderr:
          "An error occurred (AccessDeniedException) when calling the GetSecretValue operation: no",
      },
      "Paseo password: reading its secret failed (AccessDeniedException)",
    ],
    [
      { kind: "exited" as const, exitCode: 255, stdout: "", stderr: "Could not connect" },
      "Paseo password: reading its secret failed (exit status 255)",
    ],
    [{ kind: "timed_out" as const }, "Paseo password: reading its secret timed out"],
    [
      { kind: "not_found" as const },
      "Paseo password: reading its secret failed (the AWS CLI is not installed)",
    ],
    [
      { kind: "not_started" as const, code: "EACCES" },
      "Paseo password: reading its secret failed (EACCES)",
    ],
    [
      { kind: "not_started" as const, code: "not a code" },
      "Paseo password: reading its secret failed (unexpected error)",
    ],
    [
      { kind: "exited" as const, exitCode: 0, stdout: "not json", stderr: "" },
      "Paseo password: Secrets Manager's answer could not be read",
    ],
    ["", "Paseo password: its secret is empty"],
    [" \t\n", "Paseo password: its secret is empty"],
    [null, "Paseo password: its secret is empty"],
  ])(
    "a password it cannot read or use fails the install before setup runs (%#)",
    async (secret, reason) => {
      const { calls, run } = recording(secret);
      expect(await endpoint(run).install()).toEqual({ kind: "failed", reason });
      expect(calls.map((call) => call.argv[0])).toEqual(["/usr/bin/aws"]);
    },
  );

  test("restarts only through the fixed systemd action", async () => {
    const calls: readonly string[][] = [];
    const run: ProcessRunner = async (argv) => {
      (calls as string[][]).push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await endpoint(run).restart()).toEqual({ kind: "done" });
    expect(calls).toEqual([["/usr/bin/systemctl", "restart", "paseo.service"]]);
  });

  test("reloads through the active release authentication wrapper", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await endpoint(run).reload()).toEqual({ kind: "done" });
    expect(calls[0]).toContain(
      join(root, "/opt/fffactory/current/steps/control-plane/paseo-auth.sh"),
    );
    expect(calls[0]?.slice(-2)).toEqual(["daemon", "reload"]);
  });

  test("reports process failures without exposing process output", async () => {
    const exited: ProcessRunner = async () => ({
      kind: "exited",
      exitCode: 7,
      stdout: "secret output",
      stderr: "secret error",
    });
    expect(await endpoint(exited).restart()).toEqual({
      kind: "failed",
      reason: "Paseo restart exited 7",
    });
    const timedOut: ProcessRunner = async () => ({ kind: "timed_out" });
    expect(await endpoint(timedOut).reload()).toEqual({
      kind: "failed",
      reason: "Paseo reload timed_out",
    });
  });

  test("refuses an invalid projection before setup runs", async () => {
    let ran = false;
    const result = await endpoint(async () => {
      ran = true;
      return { kind: "not_found" };
    }, "{}\n").install();
    expect(result).toEqual({ kind: "failed", reason: "invalid host projection" });
    expect(ran).toBe(false);
  });

  test("refuses a projection addressed to another worker before setup runs", async () => {
    let ran = false;
    const result = await endpoint(
      async () => {
        ran = true;
        return { kind: "not_found" };
      },
      PROJECTION,
      true,
      "fff-aaaa1111-builder-2",
    ).install();
    expect(result).toEqual({ kind: "failed", reason: "host projection is for another worker" });
    expect(ran).toBe(false);
  });

  test("refuses every privileged control-plane action outside the root activator", async () => {
    let ran = false;
    const controlPlane = endpoint(
      async () => {
        ran = true;
        return { kind: "not_found" };
      },
      PROJECTION,
      false,
    );
    expect(await controlPlane.activity()).toEqual({ kind: "unknown", reason: "not root" });
    expect(await controlPlane.install()).toEqual({ kind: "failed", reason: "not root" });
    expect(await controlPlane.reload()).toEqual({ kind: "failed", reason: "not root" });
    expect(await controlPlane.restart()).toEqual({ kind: "failed", reason: "not root" });
    expect(ran).toBe(false);
  });
});
