import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bunProcessRunner,
  killRunningTools,
  localToolProbe,
  type ProcessOutcome,
  type ProcessRunner,
  stopsGracefully,
  TOOL_TIMEOUT_MS,
} from "../../src/infrastructure/local-tool-probe";
import { goneWithin, killSurvivors, recordedPids } from "../support/processes";
import type { StopScenario } from "../support/stop-tools-main";

/** A runner that answers from a table keyed by the command line, recording each call. */
function scripted(answers: Record<string, ProcessOutcome>) {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = [];
  const run: ProcessRunner = async (argv, timeoutMs) => {
    calls.push({ argv, timeoutMs });
    const answer = answers[argv.join(" ")];
    if (!answer) throw new Error(`unexpected command ${argv.join(" ")}`);
    return answer;
  };
  return { run, calls };
}

function exited(exitCode: number, stdout = "", stderr = ""): ProcessOutcome {
  return { kind: "exited", exitCode, stdout, stderr };
}

/** How a stand-in tool answers SIGINT. */
type OnInterrupt = "exits" | "ignores" | "dies";

/**
 * A stand-in tool in `directory`: a shell that traps SIGINT as told, starts a long sleep,
 * records `"$$ $!"` in its pid file and waits. A trap records `INT` in its signals file.
 * The sleep, started in the background, ignores SIGINT, so only a SIGKILL of the group
 * ends it.
 */
async function standIn(directory: string, name: string, onInterrupt: OnInterrupt) {
  const sleep = Bun.which("sleep");
  if (!sleep) throw new Error("sleep is not on PATH");
  const script = join(directory, `${name}.sh`);
  const pidFile = join(directory, `${name}.pid`);
  const signalsFile = join(directory, `${name}.signals`);
  // Appended through a rename, so the file appears only with the signal in it: a scenario
  // waiting for it (`killWhen`) could otherwise kill the tool between creation and write.
  const record = `{ cat '${signalsFile}' 2>/dev/null; echo INT; } > '${signalsFile}.tmp' && mv '${signalsFile}.tmp' '${signalsFile}'`;
  const trap = {
    exits: `trap "${record}; exit 0" INT`,
    ignores: `trap "${record}" INT`,
    dies: "",
  }[onInterrupt];
  // After an ignored interrupt `wait` returns early, so wait again.
  const wait = onInterrupt === "ignores" ? "while :; do wait; done" : "wait";
  await writeFile(
    script,
    ["#!/bin/sh", trap, `${sleep} 30 &`, `echo "$$ $!" > '${pidFile}'`, wait, ""].join("\n"),
  );
  await chmod(script, 0o755);
  return {
    script,
    pidFile,
    signalsFile,
    signals: () => readFile(signalsFile, "utf8").catch(() => ""),
  };
}

const SSH = "ssh -V";
const TAILSCALE = "tailscale status --json --peers=false";

describe("localToolProbe OpenSSH", () => {
  async function observe(outcome: ProcessOutcome) {
    return localToolProbe(scripted({ [SSH]: outcome }).run).openSsh();
  }

  test("runs `ssh -V` with the timeout", async () => {
    const runner = scripted({ [SSH]: exited(0, "", "OpenSSH_9.9p1, OpenSSL 3.5.7 9 Jun 2026\n") });
    await localToolProbe(runner.run).openSsh();
    expect(runner.calls).toEqual([{ argv: ["ssh", "-V"], timeoutMs: TOOL_TIMEOUT_MS }]);
    expect(TOOL_TIMEOUT_MS).toBe(5000);
  });

  test("reads the OpenSSH version token from standard error", async () => {
    expect(
      await observe(exited(0, "", "OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13\n")),
    ).toEqual({ kind: "openssh", version: "OpenSSH_9.6p1" });
  });

  test("also accepts the version on standard output", async () => {
    expect(await observe(exited(0, "OpenSSH_8.1p1, LibreSSL 2.7.3\n"))).toEqual({
      kind: "openssh",
      version: "OpenSSH_8.1p1",
    });
  });

  test("a missing binary is not found", async () => {
    expect(await observe({ kind: "not_found" })).toEqual({ kind: "not_found" });
  });

  test("an ssh that is not OpenSSH is reported as such", async () => {
    expect(await observe(exited(0, "", "Dropbear v2022.83\n"))).toEqual({ kind: "not_openssh" });
  });

  test("a non-zero exit, timeout or start failure is unusable, without echoing output", async () => {
    expect(await observe(exited(255, "", "secret-looking output"))).toEqual({
      kind: "unusable",
      reason: "`ssh -V` exited with status 255",
    });
    expect(await observe({ kind: "timed_out" })).toEqual({
      kind: "unusable",
      reason: "`ssh -V` did not finish within 5 s",
    });
    expect(await observe({ kind: "not_started", code: "EACCES" })).toEqual({
      kind: "unusable",
      reason: "`ssh -V` could not be started (EACCES)",
    });
  });
});

describe("localToolProbe Tailscale", () => {
  async function observe(outcome: ProcessOutcome) {
    return localToolProbe(scripted({ [TAILSCALE]: outcome }).run).tailscale();
  }

  test("runs `tailscale status --json --peers=false` with the timeout", async () => {
    const runner = scripted({ [TAILSCALE]: exited(0, '{"BackendState":"Running"}') });
    await localToolProbe(runner.run, 1234).tailscale();
    expect(runner.calls).toEqual([
      { argv: ["tailscale", "status", "--json", "--peers=false"], timeoutMs: 1234 },
    ]);
  });

  for (const state of ["Running", "NeedsLogin", "Stopped", "NeedsMachineAuth", "NoState"]) {
    test(`reports BackendState ${state}`, async () => {
      const status = JSON.stringify({ Version: "1.102.3", BackendState: state, Self: {} });
      expect(await observe(exited(0, status))).toEqual({ kind: "backend", backendState: state });
    });
  }

  test("a missing binary is not found", async () => {
    expect(await observe({ kind: "not_found" })).toEqual({ kind: "not_found" });
  });

  const unreachable = [
    "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)",
    "failed to connect to local tailscaled (which appears to be running as tailscaled, pid 1). Got error: Failed to connect to local Tailscale daemon for /localapi/v0/status; not running?",
    "failed to connect to local Tailscale service; is Tailscale running?",
  ];
  for (const stderr of unreachable) {
    test(`a daemon that cannot be reached is reported: ${stderr.slice(0, 50)}`, async () => {
      expect(await observe(exited(1, "", `${stderr}\n`))).toEqual({ kind: "daemon_unreachable" });
    });
  }

  test("any other non-zero exit is unusable, without echoing output", async () => {
    expect(await observe(exited(3, "", "tskey-secret-looking"))).toEqual({
      kind: "unusable",
      reason: "`tailscale status --json --peers=false` exited with status 3",
    });
  });

  test("output that is not JSON, or has no BackendState, is unusable", async () => {
    expect(await observe(exited(0, "Logged out."))).toEqual({
      kind: "unusable",
      reason: "`tailscale status --json --peers=false` printed output that is not JSON",
    });
    for (const stdout of ["[]", "null", '{"BackendState": 3}', "{}"]) {
      expect(await observe(exited(0, stdout))).toEqual({
        kind: "unusable",
        reason: "`tailscale status --json --peers=false` reported no BackendState",
      });
    }
  });

  test("a timeout or start failure is unusable", async () => {
    expect(await observe({ kind: "timed_out" })).toEqual({
      kind: "unusable",
      reason: "`tailscale status --json --peers=false` did not finish within 5 s",
    });
    expect(await observe({ kind: "not_started", code: "EACCES" })).toEqual({
      kind: "unusable",
      reason: "`tailscale status --json --peers=false` could not be started (EACCES)",
    });
  });
});

describe("bunProcessRunner", () => {
  // Runs the Bun executable itself: never the host's ssh or tailscale.
  const bun = process.execPath;
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fffactory-runner-"));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("captures the exit code, standard output and standard error", async () => {
    const script = 'console.log("out"); console.error("err"); process.exit(7)';
    expect(await bunProcessRunner([bun, "-e", script], 5000)).toEqual({
      kind: "exited",
      exitCode: 7,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  test("runs in the given working directory with exactly the given environment", async () => {
    const script = "console.log(JSON.stringify({ cwd: process.cwd(), env: process.env }))";
    const outcome = await bunProcessRunner([bun, "-e", script], 5000, {
      cwd: scratch,
      env: { ONLY: "this" },
    });
    if (outcome.kind !== "exited") throw new Error(`unexpected outcome ${outcome.kind}`);
    const { cwd, env } = JSON.parse(outcome.stdout);
    expect(cwd).toBe(await realpath(scratch));
    expect(env.ONLY).toBe("this");
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBeUndefined();
  });

  test("closes standard input", async () => {
    const script = "const input = await Bun.stdin.text(); console.log(input.length)";
    expect(await bunProcessRunner([bun, "-e", script], 5000)).toMatchObject({ stdout: "0\n" });
  });

  test("streams the given bytes to standard input, then closes it", async () => {
    const script =
      "const input = await Bun.stdin.bytes(); console.log(input.length, input[0], input.at(-1))";
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(7);
    bytes[bytes.length - 1] = 9;
    expect(await bunProcessRunner([bun, "-e", script], 10_000, { stdin: bytes })).toMatchObject({
      kind: "exited",
      stdout: `${bytes.length} 7 9\n`,
    });
  });

  test("writes standard output and error to a given file as the command runs, even past its timeout", async () => {
    const log = join(scratch, "streamed.log");
    const handle = await open(log, "w");
    try {
      const script = 'console.log("printed"); console.error("complained"); await Bun.sleep(10000)';
      expect(await bunProcessRunner([bun, "-e", script], 500, { output: handle.fd })).toEqual({
        kind: "timed_out",
      });
    } finally {
      await handle.close();
    }
    const text = await readFile(log, "utf8");
    expect(text).toContain("printed\n");
    expect(text).toContain("complained\n");
  });

  test("with an output file, the outcome carries no output", async () => {
    const log = join(scratch, "exited.log");
    const handle = await open(log, "w");
    try {
      const outcome = await bunProcessRunner([bun, "-e", 'console.log("x")'], 5000, {
        output: handle.fd,
      });
      expect(outcome).toEqual({ kind: "exited", exitCode: 0, stdout: "", stderr: "" });
    } finally {
      await handle.close();
    }
    expect(await readFile(log, "utf8")).toBe("x\n");
  });

  test("kills a command that outlives the timeout", async () => {
    const started = Date.now();
    expect(await bunProcessRunner([bun, "-e", "await Bun.sleep(10000)"], 200)).toEqual({
      kind: "timed_out",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  describe("a wrapper whose own child holds the output open", () => {
    const strays: number[] = [];

    /** The grandchild's pid, once the wrapper has recorded it. */
    async function recorded(pidFile: string): Promise<number> {
      const [pid] = (await recordedPids(pidFile, 1, 2000)) ?? [];
      if (pid === undefined) throw new Error(`the wrapper never recorded its child in ${pidFile}`);
      strays.push(pid);
      return pid;
    }

    afterEach(() => killSurvivors(strays));

    // A shell wrapper, which starts in milliseconds, runs a long-sleeping grandchild
    // that inherits its standard output and error, records the grandchild's pid, and
    // then either waits for it, as a script that does not `exec` its command does, or
    // exits at once.
    async function wrapper(name: string, waits: boolean) {
      const sleep = Bun.which("sleep");
      if (!sleep) throw new Error("sleep is not on PATH");
      const script = join(scratch, `${name}.sh`);
      const pidFile = join(scratch, `${name}.pid`);
      await writeFile(
        script,
        [
          "#!/bin/sh",
          `${sleep} 30 &`,
          `echo $! > '${pidFile}'`,
          waits ? "wait" : "exit 0",
          "",
        ].join("\n"),
      );
      await chmod(script, 0o755);
      return { script, pidFile };
    }

    for (const waits of [true, false]) {
      test(`returns at the timeout and kills the grandchild (wrapper ${waits ? "waits" : "exits"})`, async () => {
        const { script, pidFile } = await wrapper(waits ? "waits" : "exits", waits);
        const started = Date.now();
        const outcome = await bunProcessRunner([script], 1000);
        const elapsed = Date.now() - started;
        const grandchild = await recorded(pidFile);
        expect(outcome).toEqual({ kind: "timed_out" });
        expect(elapsed).toBeLessThan(3000);
        expect(await goneWithin(grandchild, 1000)).toBe(true);
      });
    }

    test("killRunningTools kills every running command's group before its timeout", async () => {
      const { script, pidFile } = await wrapper("interrupted", true);
      const started = Date.now();
      const outcome = bunProcessRunner([script], 10000);
      const grandchild = await recorded(pidFile);
      killRunningTools();
      expect((await outcome).kind).toBe("exited");
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await goneWithin(grandchild, 1000)).toBe(true);
      expect(() => killRunningTools()).not.toThrow();
    });
  });

  describe("with a graceful stop", () => {
    const strays: number[] = [];

    afterEach(() => killSurvivors(strays));

    async function pidsOf(pidFile: string): Promise<number[]> {
      const pids = (await recordedPids(pidFile, 2, 2000)) ?? [];
      strays.push(...pids);
      return pids;
    }

    test("at the timeout the group gets the stop signal first, and may exit on its own", async () => {
      const tool = await standIn(scratch, "graceful", "exits");
      const started = Date.now();
      const outcome = await bunProcessRunner([tool.script], 1000, {
        stop: { signal: "SIGINT", graceMs: 10_000 },
      });
      const pids = await pidsOf(tool.pidFile);
      expect(outcome).toEqual({ kind: "timed_out" });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await tool.signals()).toBe("INT\n");
      // What the tool left running in its group is killed once it has exited.
      for (const pid of pids) expect(await goneWithin(pid, 1000)).toBe(true);
    });

    test("stopsGracefully tells whether a running command has a graceful stop", async () => {
      expect(stopsGracefully()).toBe(false);
      const plain = await standIn(scratch, "plain-running", "dies");
      const running = bunProcessRunner([plain.script], 500);
      await pidsOf(plain.pidFile);
      expect(stopsGracefully()).toBe(false);
      await running;
      const tool = await standIn(scratch, "graceful-running", "exits");
      const stopping = bunProcessRunner([tool.script], 500, {
        stop: { signal: "SIGINT", graceMs: 10_000 },
      });
      await pidsOf(tool.pidFile);
      expect(stopsGracefully()).toBe(true);
      await stopping;
      expect(stopsGracefully()).toBe(false);
    });

    test("a group still running when the grace period ends is killed", async () => {
      const tool = await standIn(scratch, "stubborn", "ignores");
      const started = Date.now();
      const outcome = await bunProcessRunner([tool.script], 500, {
        stop: { signal: "SIGINT", graceMs: 1500 },
      });
      const elapsed = Date.now() - started;
      const pids = await pidsOf(tool.pidFile);
      expect(outcome).toEqual({ kind: "timed_out" });
      expect(elapsed).toBeGreaterThanOrEqual(1900);
      expect(elapsed).toBeLessThan(5000);
      expect(await tool.signals()).toBe("INT\n");
      for (const pid of pids) expect(await goneWithin(pid, 1000)).toBe(true);
    });
  });

  test("reports a missing executable as not found", async () => {
    expect(await bunProcessRunner([join(scratch, "no-such-tool"), "-V"], 5000)).toEqual({
      kind: "not_found",
    });
  });

  test("reports an executable that cannot be started with its error code", async () => {
    const file = join(scratch, "not-executable");
    await writeFile(file, "#!/bin/sh\n", { mode: 0o644 });
    expect(await bunProcessRunner([file], 5000)).toEqual({ kind: "not_started", code: "EACCES" });
  });
});

describe("stopRunningTools", () => {
  const SCENARIO = resolve(import.meta.dir, "../support/stop-tools-main.ts");
  const strays: number[] = [];
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fffactory-stop-tools-"));
  });

  afterEach(() => killSurvivors(strays));

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** Runs `scenario` in its own process; see `support/stop-tools-main.ts`. */
  async function stop(scenario: StopScenario) {
    const child = Bun.spawn([process.execPath, SCENARIO, JSON.stringify(scenario)], {
      env: { PATH: process.env.PATH ?? "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    strays.push(child.pid);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`the scenario failed: ${stderr}`);
    for (const { pidFile } of scenario.tools)
      strays.push(...((await recordedPids(pidFile, 2, 1000)) ?? []));
    return JSON.parse(stdout) as {
      elapsedMs: number;
      outcomes: ProcessOutcome[];
      after: ProcessOutcome;
    };
  }

  async function allGone(pidFiles: readonly string[]): Promise<boolean> {
    for (const file of pidFiles)
      for (const pid of (await recordedPids(file, 2, 1000)) ?? [])
        if (!(await goneWithin(pid, 1000))) return false;
    return true;
  }

  test("signals a tool that has a graceful stop, kills one that has none, then refuses new commands", async () => {
    const graceful = await standIn(scratch, "graceful", "exits");
    const plain = await standIn(scratch, "plain", "dies");
    const result = await stop({
      tools: [
        {
          argv: [graceful.script],
          timeoutMs: 30_000,
          stop: { signal: "SIGINT", graceMs: 10_000 },
          pidFile: graceful.pidFile,
        },
        { argv: [plain.script], timeoutMs: 30_000, pidFile: plain.pidFile },
      ],
    });
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.outcomes[0]).toEqual({ kind: "exited", exitCode: 0, stdout: "", stderr: "" });
    expect(result.outcomes[1]?.kind).toBe("exited");
    expect(result.after).toEqual({ kind: "not_started", code: "EINTR" });
    expect(await graceful.signals()).toBe("INT\n");
    expect(await plain.signals()).toBe("");
    expect(await allGone([graceful.pidFile, plain.pidFile])).toBe(true);
  }, 15_000);

  test("killRunningTools while tools stop gracefully kills them at once", async () => {
    const stubborn = await standIn(scratch, "forced", "ignores");
    const result = await stop({
      tools: [
        {
          argv: [stubborn.script],
          timeoutMs: 30_000,
          stop: { signal: "SIGINT", graceMs: 30_000 },
          pidFile: stubborn.pidFile,
        },
      ],
      killWhen: stubborn.signalsFile,
    });
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(await stubborn.signals()).toBe("INT\n");
    expect(await allGone([stubborn.pidFile])).toBe(true);
  }, 15_000);

  test("a tool its timeout is already stopping is not signalled twice", async () => {
    const stubborn = await standIn(scratch, "twice", "ignores");
    const result = await stop({
      tools: [
        {
          argv: [stubborn.script],
          timeoutMs: 300,
          stop: { signal: "SIGINT", graceMs: 3000 },
          pidFile: stubborn.pidFile,
        },
      ],
      stopWhen: stubborn.signalsFile,
    });
    expect(result.outcomes).toEqual([{ kind: "timed_out" }]);
    expect(result.elapsedMs).toBeLessThan(4500);
    expect(await stubborn.signals()).toBe("INT\n");
    expect(await allGone([stubborn.pidFile])).toBe(true);
  }, 15_000);
});
