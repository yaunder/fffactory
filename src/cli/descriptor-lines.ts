/**
 * Writes raw lines to descriptors, never through the runtime console (cli-output §Plain
 * output). One queue preserves both streams' order, including when they share a pipe.
 * A full pipe yields to signals and timers; normal exit must await `flush`. An interrupted
 * exit can `cancel` pending output so a reader that never drains cannot prevent shutdown.
 */
import { writeSync } from "node:fs";

/** The descriptor calls a line writer makes, replaceable in tests. */
export interface DescriptorIo {
  /** Writes up to `length` bytes of `bytes` from `offset`; gives how many were written. */
  write(fd: number, bytes: Uint8Array, offset: number, length: number): number;
  /** Yields briefly before retrying a descriptor that was full or interrupted. */
  wait(): Promise<void>;
}

export const systemDescriptorIo: DescriptorIo = {
  write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length),
  wait: () => Bun.sleep(1),
};

const encoder = new TextEncoder();

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/** Bytes written, zero when a retry must yield, or undefined once the stream is gone. */
function attempt(io: DescriptorIo, fd: number, bytes: Uint8Array, offset: number) {
  try {
    return io.write(fd, bytes, offset, bytes.length - offset);
  } catch (error) {
    const code = errorCode(error);
    return code === "EAGAIN" || code === "EINTR" ? 0 : undefined;
  }
}

/**
 * Raw line writers sharing one ordered queue. A closed or failed descriptor drops its later
 * lines without throwing; other descriptors keep writing. Available descriptors are written
 * immediately. Once one fills, later lines queue until it drains or output is cancelled.
 */
// TODO(re-evaluate when a command's --json output is read from a redirected file): exit non-zero
// once the standard output writer has failed, so a full disk (ENOSPC) cannot pass truncated
// JSON off as success.
export function descriptorOutput(io: DescriptorIo = systemDescriptorIo) {
  const queue: { fd: number; bytes: Uint8Array; offset: number }[] = [];
  const gone = new Set<number>();
  const flushed = new Set<() => void>();
  let waiting = false;
  let cancelled = false;

  /** True once this line is finished or its descriptor failed; false when it must wait. */
  function writeLine(line: (typeof queue)[number]): boolean {
    if (gone.has(line.fd)) return true;
    while (line.offset < line.bytes.length) {
      const written = attempt(io, line.fd, line.bytes, line.offset);
      if (written === undefined) {
        gone.add(line.fd);
        return true;
      }
      if (written === 0) return false;
      line.offset += written;
    }
    return true;
  }

  function drain(): void {
    let line = queue[0];
    while (line) {
      if (!writeLine(line)) {
        waiting = true;
        void io.wait().then(() => {
          waiting = false;
          drain();
        });
        return;
      }
      queue.shift();
      line = queue[0];
    }
    for (const resolve of flushed) resolve();
    flushed.clear();
  }

  function write(fd: number, text: string): void {
    if (cancelled || gone.has(fd)) return;
    queue.push({ fd, bytes: encoder.encode(text), offset: 0 });
    if (!waiting) drain();
  }

  return {
    /** Raw prompt bytes share the same queue as report lines. */
    write,
    lines(fd: number): (line: string) => void {
      return (line) => write(fd, `${line}\n`);
    },
    /** Keep signal handlers installed while waiting: the reader may never drain. */
    flush(): Promise<void> {
      if (!queue.length) return Promise.resolve();
      return new Promise((resolve) => flushed.add(resolve));
    },
    /** Discards queued and future lines and releases every pending flush. */
    cancel(): void {
      cancelled = true;
      queue.length = 0;
      drain();
    },
  };
}
