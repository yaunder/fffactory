import type { ToolProbe } from "../application/tool-probe";
import type { OpenSshObservation, TailscaleObservation } from "../domain/local-tooling";

/** How one command run ended. */
export type ProcessOutcome =
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "timed_out" }
  /** The executable exists but could not be started; `code` is the error code, such as EACCES. */
  | { readonly kind: "not_started"; readonly code: string };

/**
 * How to stop a command that can clean up after itself: send `signal` to its process group,
 * and SIGKILL the group if it is still running `graceMs` later.
 */
export interface GracefulStop {
  readonly signal: NodeJS.Signals;
  readonly graceMs: number;
}

/** Where and with what environment a command runs, and how it is stopped. */
export interface ProcessOptions {
  /** Working directory; the caller's when omitted. */
  readonly cwd?: string;
  /** The command's entire environment; the caller's when omitted. Nothing else is added. */
  readonly env?: Readonly<Record<string, string>>;
  /** Stops the command at its timeout or on interrupt; SIGKILL at once when omitted. */
  readonly stop?: GracefulStop;
  /** Bytes the command reads on standard input, which is closed after them; closed at once without. */
  readonly stdin?: Uint8Array;
  /**
   * An open file descriptor the command writes its standard output and error to directly, as
   * it runs, so what it printed survives a timeout or the caller's death; the outcome then
   * carries no output. Captured through pipes when omitted.
   */
  readonly output?: number;
}

/** Runs `argv` directly, never through a shell, with standard input closed unless given. */
export type ProcessRunner = (
  argv: readonly string[],
  timeoutMs: number,
  options?: ProcessOptions,
) => Promise<ProcessOutcome>;

export const TOOL_TIMEOUT_MS = 5000;

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown error";
}

/** Reads a stream to its end as text; `cancel` stops reading and releases the pipe. */
function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const text = (async () => {
    let result = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      result += decoder.decode(value, { stream: true });
    }
  })();
  return { text, cancel: () => reader.cancel() };
}

/** The command's output, or none when it went straight to a file. */
function collectOutput(stream: ReadableStream<Uint8Array> | number | undefined) {
  if (stream instanceof ReadableStream) return collect(stream);
  return { text: Promise.resolve(""), cancel: async () => {} };
}

/** A command `bunProcessRunner` is running now, which leads its own process group. */
interface RunningTool {
  readonly child: Bun.Subprocess;
  readonly stop: GracefulStop | undefined;
  /** Set once stopping starts, so the stop signal is sent once however often it is asked. */
  stopped?: Promise<void>;
}

/** Commands `bunProcessRunner` is running now, by the pid of their group's leader. */
const running = new Map<number, RunningTool>();

/** Set by `stopRunningTools`: from then on no command starts. */
let refusing = false;

/** Sends `signal` to every process in the group `pid` leads. POSIX only. */
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
    // The group has no processes left.
  }
}

/**
 * Kills the group the command leads, so a wrapper script's own children die with it;
 * the direct kill covers a group that is already gone.
 */
function killProcessGroup(child: Bun.Subprocess) {
  signalGroup(child.pid, "SIGKILL");
  child.kill("SIGKILL");
}

/**
 * Stops a running command: with a graceful stop, signals its group and waits up to the
 * grace period for the command to exit; then kills whatever is left of the group.
 */
function stopTool(tool: RunningTool): Promise<void> {
  tool.stopped ??= (async () => {
    const { child, stop } = tool;
    if (stop) {
      signalGroup(child.pid, stop.signal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, stop.graceMs);
      });
      await Promise.race([child.exited, grace]);
      clearTimeout(timer);
    }
    killProcessGroup(child);
  })();
  return tool.stopped;
}

/**
 * SIGKILLs the process group of every command `bunProcessRunner` is running, at once, so a
 * command outlives no interrupted caller: its own session is out of reach of the
 * terminal's signals.
 */
export function killRunningTools() {
  for (const { child } of running.values()) signalGroup(child.pid, "SIGKILL");
}

/**
 * Whether a command `bunProcessRunner` is running now stops gracefully (it has a `stop`), so
 * stopping it takes a while and a forced kill could still cut it short.
 */
export function stopsGracefully(): boolean {
  return [...running.values()].some(({ stop }) => stop !== undefined);
}

/**
 * Stops every command `bunProcessRunner` is running as its options say, gracefully where
 * they allow, and settles once all have stopped. From the call on, no new command starts:
 * each reports `not_started` with code `EINTR`. For an interrupted caller that exits next.
 */
export async function stopRunningTools(): Promise<void> {
  refusing = true;
  await Promise.all([...running.values()].map(stopTool));
}

/**
 * ProcessRunner over `Bun.spawn`. The command runs in its own session and process group,
 * tracked until it finishes for `killRunningTools` and `stopRunningTools`. At the timeout
 * the group is stopped (see `ProcessOptions.stop`) and the runner returns without waiting
 * for output: a grandchild could otherwise hold the pipes open.
 */
export const bunProcessRunner: ProcessRunner = async (argv, timeoutMs, options = {}) => {
  if (refusing) return { kind: "not_started", code: "EINTR" };
  let child: Bun.Subprocess<"ignore" | Uint8Array, "pipe" | number, "pipe" | number>;
  const output = options.output ?? "pipe";
  try {
    child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: options.env === undefined ? undefined : { ...options.env },
      stdin: options.stdin ?? "ignore",
      stdout: output,
      stderr: output,
      detached: true,
    });
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? { kind: "not_found" } : { kind: "not_started", code };
  }
  const tool: RunningTool = { child, stop: options.stop };
  running.set(child.pid, tool);
  const stdout = collectOutput(child.stdout);
  const stderr = collectOutput(child.stderr);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const finished = await Promise.race([
      Promise.all([child.exited, stdout.text, stderr.text]),
      timeout,
    ]);
    if (finished) {
      const [exitCode, out, err] = finished;
      return { kind: "exited", exitCode, stdout: out, stderr: err };
    }
    await stopTool(tool);
    await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
    return { kind: "timed_out" };
  } finally {
    clearTimeout(timer);
    running.delete(child.pid);
  }
};

type Unusable = { readonly kind: "unusable"; readonly reason: string };
type Uninterpretable = Exclude<ProcessOutcome, { readonly kind: "not_found" }>;

function describe(outcome: Uninterpretable, timeoutMs: number): string {
  if (outcome.kind === "exited") return `exited with status ${outcome.exitCode}`;
  if (outcome.kind === "timed_out") return `did not finish within ${timeoutMs / 1000} s`;
  return `could not be started (${outcome.code})`;
}

/** Describes an outcome doctor cannot interpret. Never quotes the command's output. */
function unusable(command: string, outcome: Uninterpretable, timeoutMs: number): Unusable {
  return { kind: "unusable", reason: `\`${command}\` ${describe(outcome, timeoutMs)}` };
}

const OPENSSH_VERSION = /^OpenSSH_[^\s,]+/;
const SSH = ["ssh", "-V"] as const;

function openSshFrom(outcome: ProcessOutcome, timeoutMs: number): OpenSshObservation {
  if (outcome.kind === "not_found") return { kind: "not_found" };
  if (outcome.kind !== "exited" || outcome.exitCode !== 0)
    return unusable(SSH.join(" "), outcome, timeoutMs);
  // OpenSSH prints its version to standard error.
  const version =
    OPENSSH_VERSION.exec(outcome.stderr.trim()) ?? OPENSSH_VERSION.exec(outcome.stdout.trim());
  return version ? { kind: "openssh", version: version[0] } : { kind: "not_openssh" };
}

/** `--peers=false` keeps other devices' details out of the output. */
const TAILSCALE = ["tailscale", "status", "--json", "--peers=false"] as const;
const TAILSCALE_COMMAND = TAILSCALE.join(" ");
/** Linux: "local tailscaled"; macOS and others: "local Tailscale service" or "daemon". */
const DAEMON_UNREACHABLE = /failed to connect to local tailscale/i;

function backendState(stdout: string): TailscaleObservation {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    return { kind: "unusable", reason: `\`${TAILSCALE_COMMAND}\` printed output that is not JSON` };
  }
  const state =
    typeof status === "object" && status !== null
      ? (status as Record<string, unknown>).BackendState
      : undefined;
  return typeof state === "string"
    ? { kind: "backend", backendState: state }
    : { kind: "unusable", reason: `\`${TAILSCALE_COMMAND}\` reported no BackendState` };
}

function tailscaleFrom(outcome: ProcessOutcome, timeoutMs: number): TailscaleObservation {
  if (outcome.kind === "not_found") return { kind: "not_found" };
  if (outcome.kind === "exited" && outcome.exitCode === 0) return backendState(outcome.stdout);
  if (outcome.kind === "exited" && DAEMON_UNREACHABLE.test(`${outcome.stderr}\n${outcome.stdout}`))
    return { kind: "daemon_unreachable" };
  return unusable(TAILSCALE_COMMAND, outcome, timeoutMs);
}

/** ToolProbe that runs the local `ssh` and `tailscale` commands found on PATH. */
export function localToolProbe(
  run: ProcessRunner = bunProcessRunner,
  timeoutMs: number = TOOL_TIMEOUT_MS,
): ToolProbe {
  return {
    openSsh: async () => openSshFrom(await run(SSH, timeoutMs), timeoutMs),
    tailscale: async () => tailscaleFrom(await run(TAILSCALE, timeoutMs), timeoutMs),
  };
}
