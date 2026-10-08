/**
 * How a running command is interrupted (`docs/specs/plan-apply.md` §Interruption). Tools run
 * in their own session, out of reach of the terminal's signals. While a command runs, the
 * first of `INTERRUPTS` says so on standard error, marks the command interrupted (it starts
 * nothing more and keeps any factory lock it holds), wakes every pending sleep, and stops the
 * running tools, gracefully where a tool allows it (Terraform saves its state and releases its
 * lock). Once they have stopped, `fffactory` exits with 128 + the signal number, whatever the
 * command returned. A command that waits on an interrupt (`waitsOnInterrupt`) first has
 * `RETURN_GRACE_MS` to return and report what the interrupt left; any other is not waited
 * for, since it may not check `interrupted` and would go on with its work. Another signal, at
 * any point after the first, kills the tools and exits at once.
 *
 * The process itself comes in as an `InterruptHost`, which only `cli/main.ts` makes.
 */

export const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type InterruptSignal = (typeof INTERRUPTS)[number];

/**
 * How long an interrupted command that waits on an interrupt has, once its tools have stopped,
 * to return before `fffactory` exits anyway. Returning is quick: an interrupted command starts
 * nothing more and its sleeps are woken, so what remains is reporting what the interrupt left,
 * such as the lock it keeps. The bound is for a command still waiting on something no
 * interrupt reaches.
 */
export const RETURN_GRACE_MS = 5_000;

/**
 * Terraform's output is captured, so without this the operator would see nothing while it
 * stops, for up to its grace period, and might interrupt again and lose state. The second
 * sentence is only for a tool that stops gracefully; any other is killed at once.
 */
const INTERRUPTED_NOTICE = "Interrupted: stopping running tools.";
const KILL_NOTICE = " Interrupt again to kill them at once (Terraform may lose state).";

/** The process a command runs in, as `cli/main.ts` wires it. */
export interface InterruptHost {
  readonly on: (signal: InterruptSignal, handler: (signal: InterruptSignal) => void) => void;
  readonly off: (signal: InterruptSignal, handler: (signal: InterruptSignal) => void) => void;
  readonly exit: (code: number) => void;
  readonly signalNumber: (signal: InterruptSignal) => number;
  readonly stopRunningTools: () => Promise<void>;
  readonly killRunningTools: () => void;
  readonly stopsGracefully: () => boolean;
  readonly err: (line: string) => void;
  /** `RETURN_GRACE_MS`, but for tests. */
  readonly graceMs: number;
}

export interface Interruptible {
  /** Whether the command has been interrupted: `CliContext.interrupted`. */
  readonly interrupted: () => boolean;
  /** Waits `ms`, or less once interrupted: `CliContext.sleep`. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Runs the command, listening for interrupts, then exits as the module comment says. */
  readonly run: (command: () => Promise<number>, options: RunOptions) => Promise<void>;
}

export interface RunOptions {
  /**
   * Whether, once interrupted and its tools stopped, the command is waited for, at most
   * `RETURN_GRACE_MS`, to report what the interrupt left. Only a command that checks
   * `interrupted` and starts nothing more once it is set may wait: any other would go on
   * mutating after the signal.
   */
  readonly waitsOnInterrupt: boolean;
}

const ignore = () => {};

export function interruptible(host: InterruptHost): Interruptible {
  /** Set by the first interrupt; settles once fffactory has exited. */
  let interruption: Promise<void> | undefined;
  /** The running command, settled whether it returns or throws. */
  let returned: Promise<void> = new Promise(ignore);
  /** The running command's `RunOptions.waitsOnInterrupt`. */
  let waits = false;
  let exited = false;
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    host.exit(code);
  };
  const sleepers = new Set<() => void>();

  /** The command's return, or the grace's end, whichever comes first. */
  function returnedWithinGrace(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, host.graceMs);
    });
    return Promise.race([returned, grace]).finally(() => clearTimeout(timer));
  }

  function interrupted(signal: InterruptSignal): void {
    const code = 128 + host.signalNumber(signal);
    if (interruption) {
      try {
        host.killRunningTools();
      } finally {
        exit(code);
      }
      return;
    }
    host.err(host.stopsGracefully() ? INTERRUPTED_NOTICE + KILL_NOTICE : INTERRUPTED_NOTICE);
    const stopped = host.stopRunningTools();
    interruption = (waits ? stopped.then(returnedWithinGrace) : stopped).finally(() => exit(code));
    for (const wake of [...sleepers]) wake();
  }

  function listening(change: InterruptHost["on"]): void {
    for (const signal of INTERRUPTS) change(signal, interrupted);
  }

  return {
    interrupted: () => interruption !== undefined,
    sleep(ms) {
      if (interruption) return Promise.resolve();
      return new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          sleepers.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, ms);
        sleepers.add(wake);
      });
    },
    async run(command, options) {
      waits = options.waitsOnInterrupt;
      listening(host.on);
      const running = command();
      returned = running.then(ignore, ignore);
      let code: number;
      try {
        code = await running;
      } catch (error) {
        if (interruption) return interruption;
        throw error;
      }
      // A command that ends while its tools stop still exits with the signal's status.
      if (interruption) return interruption;
      listening(host.off);
      exit(code);
    },
  };
}
