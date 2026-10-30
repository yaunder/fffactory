/**
 * The `collector` install step (host protocol §The collector step) over a worker laid out in a
 * temporary directory, `systemctl` answered by a scripted runner that may write to the step's
 * log as the real one would. Nothing reaches systemd, a network or AWS.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTOR_CONFIGURATION } from "../../src/domain/collector";
import {
  COLLECTOR_COMMAND_TIMEOUT_MS,
  COLLECTOR_SERVICE_UNIT,
  COLLECTOR_STATE,
  COLLECTOR_TIMER_UNIT,
} from "../../src/domain/collector-installation";
import type { HostLogArchive } from "../../src/domain/host-projection";
import type { FactoryId, HostKey } from "../../src/domain/instance";
import { type CollectorInput, workerCollectorStep } from "../../src/host/collector-step";
import type {
  ProcessOptions,
  ProcessOutcome,
  ProcessRunner,
} from "../../src/infrastructure/local-tool-probe";
import { system } from "./worker-scenarios";

const SERVICE = "/etc/systemd/system/fffactory-collector.service";
const TIMER = "/etc/systemd/system/fffactory-collector.timer";
const ARCHIVE: HostLogArchive = {
  bucket: "fff-r29c2un6-logs-123456789012-us-east-1-an",
  region: "us-east-1",
};
const ENABLED: CollectorInput = {
  factory_id: "fff-r29c2un6" as FactoryId,
  host_key: "builder-1" as HostKey,
  log_archive: ARCHIVE,
};
const DISABLED: CollectorInput = {
  factory_id: "fff-r29c2un6" as FactoryId,
  host_key: "builder-1" as HostKey,
};
const BUDGET_MS = 2 * 60_000;
const SYSTEMCTL_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
const FIXTURES = join(import.meta.dir, "..", "domain", "fixtures", "archive");

let root: string;
let log: FileHandle;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-collector-step-"));
  log = await open(join(root, "collector.log"), "w");
});
afterEach(async () => {
  await log.close();
  await rm(root, { recursive: true, force: true });
});

const at = (path: string) => join(root, path);
const exited = (exitCode: number): ProcessOutcome => ({
  kind: "exited",
  exitCode,
  stdout: "",
  stderr: "",
});

interface Call {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly options: ProcessOptions | undefined;
}

/**
 * systemctl, answering exit 0 unless `answers` names the command (its arguments joined), and
 * writing a line of its own to the output it is given, as the real one does on its stderr.
 */
function systemctl(answers: Record<string, ProcessOutcome> = {}) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (argv, timeoutMs, options) => {
    calls.push({ argv, timeoutMs, options });
    const command = argv.slice(1).join(" ");
    if (options?.output !== undefined) writeSync(options.output, `systemctl said: ${command}\n`);
    return answers[command] ?? exited(0);
  };
  const commands = () => calls.map(({ argv }) => argv.join(" "));
  return { run, calls, commands };
}

async function step(
  run: ProcessRunner,
  input: CollectorInput = ENABLED,
  budgetMs = BUDGET_MS,
): Promise<string | undefined> {
  return workerCollectorStep(system(root, { run }), input, budgetMs, {
    output: log.fd,
    note: async (line) => {
      await log.write(`${line}\n`);
    },
  });
}

const logged = () => readFile(at("collector.log"), "utf8");
const present = (path: string) =>
  stat(at(path)).then(
    () => true,
    () => false,
  );
const mode = async (path: string) => (await stat(at(path))).mode & 0o777;

describe("the collector step with the log archive (host protocol §The collector step)", () => {
  test("writes the configuration and both units, reloads systemd and enables the timer", async () => {
    const { run, calls, commands } = systemctl();
    expect(await step(run)).toBeUndefined();
    expect(await readFile(at(COLLECTOR_CONFIGURATION), "utf8")).toBe(
      await readFile(join(FIXTURES, "collector.json"), "utf8"),
    );
    expect(await mode(COLLECTOR_CONFIGURATION)).toBe(0o644);
    expect(await mode("/etc/fffactory")).toBe(0o755);
    expect(await readFile(at(SERVICE), "utf8")).toBe(COLLECTOR_SERVICE_UNIT);
    expect(await readFile(at(TIMER), "utf8")).toBe(COLLECTOR_TIMER_UNIT);
    expect(await mode(SERVICE)).toBe(0o644);
    expect(await mode(TIMER)).toBe(0o644);
    expect(commands()).toEqual([
      "/usr/bin/systemctl daemon-reload",
      "/usr/bin/systemctl enable --now fffactory-collector.timer",
    ]);
    for (const { timeoutMs, options } of calls) {
      expect(timeoutMs).toBeLessThanOrEqual(COLLECTOR_COMMAND_TIMEOUT_MS);
      expect(timeoutMs).toBeGreaterThan(0);
      expect(options).toEqual({ env: SYSTEMCTL_ENV, output: log.fd });
    }
    expect(await logged()).toBe(
      "log_archive: collector.json written\n" +
        "log_archive: fffactory-collector.service and fffactory-collector.timer written\n" +
        "systemctl said: daemon-reload\n" +
        "systemctl said: enable --now fffactory-collector.timer\n" +
        "log_archive: fffactory-collector.timer enabled; collection is not waited for\n",
    );
  });

  test("never starts, checks or waits for a collection", async () => {
    const { run, commands } = systemctl();
    await step(run);
    for (const command of commands()) {
      expect(command).not.toContain("fffactory-collector.service");
      expect(command).not.toMatch(/is-active|is-failed|status|start |restart|--wait|--block/);
    }
  });

  test("a rerun converges on the same files and commands", async () => {
    const first = systemctl();
    expect(await step(first.run)).toBeUndefined();
    const files = [COLLECTOR_CONFIGURATION, SERVICE, TIMER];
    const before = await Promise.all(files.map((path) => readFile(at(path), "utf8")));
    await writeFile(at(SERVICE), "[Service]\nExecStart=/bin/false\n");
    const second = systemctl();
    expect(await step(second.run)).toBeUndefined();
    expect(await Promise.all(files.map((path) => readFile(at(path), "utf8")))).toEqual(before);
    expect(second.commands()).toEqual(first.commands());
  });

  test("bounds each command by its deadline and what is left of the step's budget", async () => {
    const { run, calls } = systemctl();
    await step(run, ENABLED, 5_000);
    for (const { timeoutMs } of calls) expect(timeoutMs).toBeLessThanOrEqual(5_000);
    const unbounded = systemctl();
    await step(unbounded.run);
    for (const { timeoutMs } of unbounded.calls)
      expect(timeoutMs).toBe(COLLECTOR_COMMAND_TIMEOUT_MS);
  });
});

describe("the collector step without the log archive", () => {
  async function installed() {
    expect(await step(systemctl().run)).toBeUndefined();
    await mkdir(at(COLLECTOR_STATE), { recursive: true });
    await writeFile(at(`${COLLECTOR_STATE}/checkpoint.json`), "{}");
    await log.truncate(0);
  }

  test("disables and stops the timer, stops a run, removes units and configuration, keeps state", async () => {
    await installed();
    const { run, commands } = systemctl();
    expect(await step(run, DISABLED)).toBeUndefined();
    expect(commands()).toEqual([
      "/usr/bin/systemctl disable --now fffactory-collector.timer",
      "/usr/bin/systemctl stop fffactory-collector.service",
      "/usr/bin/systemctl daemon-reload",
    ]);
    for (const path of [COLLECTOR_CONFIGURATION, SERVICE, TIMER])
      expect({ path, present: await present(path) }).toEqual({ path, present: false });
    expect(await readFile(at(`${COLLECTOR_STATE}/checkpoint.json`), "utf8")).toBe("{}");
    expect(await logged()).toContain(
      "log_archive: not enabled; the collector removed, its state kept\n",
    );
  });

  test("on a worker that never had the collector, does nothing at all", async () => {
    const { run, commands } = systemctl();
    expect(await step(run, DISABLED)).toBeUndefined();
    expect(commands()).toEqual([]);
    for (const path of [COLLECTOR_CONFIGURATION, SERVICE, TIMER, "/etc/fffactory"])
      expect({ path, present: await present(path) }).toEqual({ path, present: false });
    expect(await logged()).toBe("log_archive: not enabled; no collector to remove\n");
  });

  test("a rerun after the units are gone removes what is left without asking systemd to", async () => {
    await installed();
    await rm(at(TIMER));
    await rm(at(SERVICE));
    const { run, commands } = systemctl();
    expect(await step(run, DISABLED)).toBeUndefined();
    expect(commands()).toEqual([]);
    expect(await present(COLLECTOR_CONFIGURATION)).toBe(false);
  });
});

describe("the collector step failing", () => {
  test("a systemctl that fails fails the step, its own output in the log", async () => {
    const { run, commands } = systemctl({ "daemon-reload": exited(1) });
    expect(await step(run)).toBe("systemctl daemon-reload exited with status 1");
    expect(commands()).toEqual(["/usr/bin/systemctl daemon-reload"]);
    expect(await logged()).toContain("systemctl said: daemon-reload\n");
  });

  test("names how systemctl did not finish", async () => {
    const cases: [ProcessOutcome, string][] = [
      [{ kind: "timed_out" }, "systemctl enable --now fffactory-collector.timer timed out"],
      [
        { kind: "not_found" },
        "systemctl enable --now fffactory-collector.timer could not be started (ENOENT)",
      ],
      [
        { kind: "not_started", code: "EACCES" },
        "systemctl enable --now fffactory-collector.timer could not be started (EACCES)",
      ],
    ];
    for (const [outcome, reason] of cases) {
      const { run } = systemctl({ "enable --now fffactory-collector.timer": outcome });
      expect(await step(run)).toBe(reason);
    }
  });

  test("disabling, a timer systemd cannot disable fails the step and removes nothing", async () => {
    expect(await step(systemctl().run)).toBeUndefined();
    const { run } = systemctl({ "disable --now fffactory-collector.timer": exited(1) });
    expect(await step(run, DISABLED)).toBe(
      "systemctl disable --now fffactory-collector.timer exited with status 1",
    );
    expect(await present(TIMER)).toBe(true);
    expect(await present(COLLECTOR_CONFIGURATION)).toBe(true);
  });

  test("a file it cannot write fails the step by its error code, before systemd is asked", async () => {
    await mkdir(at("/etc"), { recursive: true });
    await writeFile(at("/etc/systemd"), "not a directory");
    const { run, commands } = systemctl();
    expect(await step(run)).toBe(`writing ${SERVICE} failed (ENOTDIR)`);
    expect(commands()).toEqual([]);
  });

  test("a file it cannot remove or look at fails the step by its error code", async () => {
    expect(await step(systemctl().run)).toBeUndefined();
    await chmod(at("/etc/fffactory"), 0o500);
    try {
      expect(await step(systemctl().run, DISABLED)).toBe(
        `removing ${COLLECTOR_CONFIGURATION} failed (EACCES)`,
      );
    } finally {
      await chmod(at("/etc/fffactory"), 0o755);
    }
    await chmod(at("/etc/systemd/system"), 0o000);
    try {
      expect(await step(systemctl().run, DISABLED)).toBe(`reading ${TIMER} failed (EACCES)`);
    } finally {
      await chmod(at("/etc/systemd/system"), 0o755);
    }
  });

  test("an error that is not the step's own is not swallowed", async () => {
    const run: ProcessRunner = async () => {
      throw new Error("the runner broke");
    };
    await expect(step(run)).rejects.toThrow("the runner broke");
  });

  test("a step out of budget runs no command", async () => {
    const { run, commands } = systemctl();
    expect(await step(run, ENABLED, 0)).toBe("systemctl daemon-reload timed out");
    expect(commands()).toEqual([]);
  });
});

describe("the collector unit's environment, against factory's own AWS settings", () => {
  const PROBE = join(import.meta.dir, "..", "support", "aws-endpoint-probe-main.ts");
  /** What the service manager could pass the unit, each setting pointing somewhere hostile. */
  const INHERITED = {
    AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://127.0.0.1:3",
    AWS_ENDPOINT_URL_S3: "http://127.0.0.1:4",
    AWS_PROFILE: "agents",
  };

  /** A home whose `~/.aws` an agent wrote, redirecting every endpoint, the metadata's too. */
  async function agentWrittenHome(): Promise<string> {
    const home = at("/home/factory");
    await mkdir(join(home, ".aws"), { recursive: true });
    const hostile =
      "endpoint_url = http://127.0.0.1:1\nec2_metadata_service_endpoint = http://127.0.0.1:2\n";
    await writeFile(join(home, ".aws/config"), `[default]\n${hostile}[profile agents]\n${hostile}`);
    await writeFile(
      join(home, ".aws/credentials"),
      "[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
    );
    return home;
  }

  /** Where the SDK would send the collector's calls in `env`; nothing is sent. */
  function destinations(env: Record<string, string>) {
    const probe = Bun.spawnSync([process.execPath, PROBE], { env, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: probe.exitCode, stderr: probe.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    return JSON.parse(probe.stdout.toString());
  }

  /**
   * The environment systemd gives the unit's process from `manager`'s, by its rules: the
   * manager's variables, then the unit's `Environment=`, then `UnsetEnvironment=` removing names.
   */
  function unitEnvironment(manager: Record<string, string>): Record<string, string> {
    const lines = COLLECTOR_SERVICE_UNIT.split("\n");
    const env: Record<string, string> = { ...manager };
    for (const line of lines.filter((text) => text.startsWith("Environment="))) {
      const assignment = line.slice("Environment=".length);
      const split = assignment.indexOf("=");
      env[assignment.slice(0, split)] = assignment.slice(split + 1);
    }
    for (const line of lines.filter((text) => text.startsWith("UnsetEnvironment=")))
      for (const name of line.slice("UnsetEnvironment=".length).split(" ")) delete env[name];
    return env;
  }

  test("an agent's ~/.aws redirects the SDK when nothing stops it", async () => {
    const home = await agentWrittenHome();
    expect(destinations({ PATH: process.env.PATH ?? "", HOME: home })).toEqual({
      imds: "http://127.0.0.1:2",
      s3: "http://127.0.0.1:1",
      sts: "http://127.0.0.1:1",
    });
  });

  test("under the unit, the SDK reads neither ~/.aws nor an inherited endpoint", async () => {
    const home = await agentWrittenHome();
    const env = unitEnvironment({ PATH: process.env.PATH ?? "", HOME: home, ...INHERITED });
    for (const name of Object.keys(INHERITED)) expect(env[name]).toBeUndefined();
    expect(destinations(env)).toEqual({
      imds: "http://169.254.169.254",
      s3: "https://fff-aaaa1111-logs.s3.eu-west-2.amazonaws.com",
      sts: "https://sts.eu-west-2.amazonaws.com",
    });
  });
});
