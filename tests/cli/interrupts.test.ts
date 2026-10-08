/**
 * `cli/interrupts.ts` over a stand-in process: signals delivered by calling the handler it
 * registers, and an exit that is recorded instead of ending the test. The real signals, end
 * to end, are `cli/apply-interrupted.test.ts`'s and `cli/main.test.ts`'s
 * (plan-apply §Interruption, provisioning §Environment and credentials).
 */
import { describe, expect, test } from "bun:test";
import { constants } from "node:os";
import {
  INTERRUPTS,
  type InterruptSignal,
  interruptible,
  RETURN_GRACE_MS,
} from "../../src/cli/interrupts";

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets every pending promise callback run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function standIn(options: { graceMs?: number; graceful?: boolean } = {}) {
  const handlers = new Map<InterruptSignal, (signal: InterruptSignal) => void>();
  const exited = deferred<number>();
  const exits: number[] = [];
  const err: string[] = [];
  const stopping = deferred<void>();
  const calls: string[] = [];
  const interrupts = interruptible({
    on: (signal, handler) => handlers.set(signal, handler),
    off: (signal) => handlers.delete(signal),
    exit: (code) => {
      exits.push(code);
      exited.resolve(code);
    },
    signalNumber: (signal) => constants.signals[signal],
    stopRunningTools: () => {
      calls.push("stop");
      return stopping.promise;
    },
    killRunningTools: () => {
      calls.push("kill");
    },
    stopsGracefully: () => options.graceful ?? false,
    err: (line) => err.push(line),
    graceMs: options.graceMs ?? 60_000,
  });
  const signal = (name: InterruptSignal) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    handler(name);
  };
  return { interrupts, handlers, signal, exited: exited.promise, exits, err, stopping, calls };
}

/** A command that reports what an interrupt left: `apply`, `upgrade`, `doctor`, `status`. */
const WAITS = { waitsOnInterrupt: true } as const;
/** Any other command, such as `host apply`, `secret set` or `lock break`. */
const EXITS = { waitsOnInterrupt: false } as const;

describe("interruptible commands (plan-apply §Interruption)", () => {
  test("waits a few seconds for an interrupted command to return", () => {
    expect(RETURN_GRACE_MS).toBe(5_000);
  });

  test("without an interrupt, exits with the command's code and stops listening", async () => {
    const { interrupts, handlers, exited, exits } = standIn();
    const command = deferred<number>();
    const running = interrupts.run(() => command.promise, WAITS);
    expect([...handlers.keys()]).toEqual([...INTERRUPTS]);
    command.resolve(2);
    await running;
    expect(await exited).toBe(2);
    expect(exits).toEqual([2]);
    expect(handlers.size).toBe(0);
  });

  for (const [name, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)
    test(`after ${name}, exits ${code} only once the command has returned`, async () => {
      const { interrupts, signal, exited, exits, err, stopping, calls } = standIn();
      const command = deferred<number>();
      const running = interrupts.run(async () => {
        await interrupts.sleep(60_000);
        expect(interrupts.interrupted()).toBe(true);
        return command.promise;
      }, WAITS);
      signal(name);
      expect(err).toEqual(["Interrupted: stopping running tools."]);
      expect(calls).toEqual(["stop"]);
      stopping.resolve();
      await settled();
      // The tools have stopped, but the command is still reporting what the interrupt left.
      expect(exits).toEqual([]);
      command.resolve(1);
      await running;
      expect(await exited).toBe(code);
      expect(exits).toEqual([code]);
    });

  test("waits for the running tools to stop before it waits for the command", async () => {
    const { interrupts, signal, exited, exits, stopping } = standIn({ graceMs: 1 });
    void interrupts.run(() => new Promise<number>(() => {}), WAITS);
    signal("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual([]);
    stopping.resolve();
    expect(await exited).toBe(130);
  });

  test("exits anyway once a command has not returned within the grace", async () => {
    const { interrupts, signal, exited, stopping } = standIn({ graceMs: 10 });
    stopping.resolve();
    void interrupts.run(() => new Promise<number>(() => {}), WAITS);
    signal("SIGTERM");
    expect(await exited).toBe(143);
  });

  test("a command that ends while its tools stop still exits with the signal's status", async () => {
    const { interrupts, signal, exited, exits, stopping } = standIn();
    const running = interrupts.run(async () => {
      signal("SIGINT");
      return 0;
    }, WAITS);
    await settled();
    expect(exits).toEqual([]);
    stopping.resolve();
    await running;
    expect(await exited).toBe(130);
    expect(exits).toEqual([130]);
  });

  test("a second signal kills the tools and exits at once, with its own status", async () => {
    const { interrupts, signal, exits, err, calls } = standIn({ graceful: true });
    void interrupts.run(() => new Promise<number>(() => {}), WAITS);
    signal("SIGINT");
    expect(err).toEqual([
      "Interrupted: stopping running tools. Interrupt again to kill them at once " +
        "(Terraform may lose state).",
    ]);
    signal("SIGTERM");
    expect(calls).toEqual(["stop", "kill"]);
    expect(exits).toEqual([143]);
    expect(err).toHaveLength(1);
  });

  test("a second signal while the command reports still exits at once", async () => {
    const { interrupts, signal, exits, stopping } = standIn();
    void interrupts.run(() => new Promise<number>(() => {}), WAITS);
    signal("SIGINT");
    stopping.resolve();
    await settled();
    expect(exits).toEqual([]);
    signal("SIGINT");
    expect(exits).toEqual([130]);
  });

  test("an interrupt wakes every pending sleep, and later sleeps return at once", async () => {
    const { interrupts, signal } = standIn();
    void interrupts.run(() => new Promise<number>(() => {}), WAITS);
    expect(interrupts.interrupted()).toBe(false);
    const woken: number[] = [];
    const sleeps = [1, 2].map((n) => interrupts.sleep(60_000).then(() => woken.push(n)));
    await settled();
    expect(woken).toEqual([]);
    signal("SIGHUP");
    await Promise.all(sleeps);
    expect(woken).toEqual([1, 2]);
    expect(interrupts.interrupted()).toBe(true);
    await interrupts.sleep(60_000);
  });

  test("a command that throws still exits once interrupted", async () => {
    const { interrupts, signal, exited, stopping } = standIn();
    stopping.resolve();
    const failing = deferred<number>();
    void interrupts
      .run(() => failing.promise.then(() => Promise.reject(new Error("broke"))), WAITS)
      .catch(() => {});
    signal("SIGINT");
    failing.resolve(0);
    expect(await exited).toBe(130);
  });
});

describe("commands that do not wait on an interrupt (plan-apply §Interruption)", () => {
  test("exit as soon as their tools stop, never waiting for the command to return", async () => {
    const { interrupts, signal, exited, exits, err, stopping, calls } = standIn();
    let returned = false;
    void interrupts.run(async () => {
      await new Promise(() => {});
      returned = true;
      return 0;
    }, EXITS);
    signal("SIGTERM");
    expect(err).toEqual(["Interrupted: stopping running tools."]);
    expect(calls).toEqual(["stop"]);
    await settled();
    expect(exits).toEqual([]);
    stopping.resolve();
    expect(await exited).toBe(143);
    expect(returned).toBe(false);
  });

  test("exit once their tools stop even when the command returns first", async () => {
    const { interrupts, signal, exited, exits, stopping } = standIn();
    const running = interrupts.run(async () => {
      signal("SIGINT");
      return 0;
    }, EXITS);
    await settled();
    expect(exits).toEqual([]);
    stopping.resolve();
    await running;
    expect(await exited).toBe(130);
    expect(exits).toEqual([130]);
  });

  test("without an interrupt, exit with the command's code", async () => {
    const { interrupts, handlers, exited } = standIn();
    await interrupts.run(async () => 2, EXITS);
    expect(await exited).toBe(2);
    expect(handlers.size).toBe(0);
  });

  test("a second signal still kills the tools and exits at once", async () => {
    const { interrupts, signal, exits, calls } = standIn();
    void interrupts.run(() => new Promise<number>(() => {}), EXITS);
    signal("SIGINT");
    signal("SIGHUP");
    expect(calls).toEqual(["stop", "kill"]);
    expect(exits).toEqual([129]);
  });
});
