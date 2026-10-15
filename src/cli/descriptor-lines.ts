/**
 * Writes `fffactory`'s output lines straight to a file descriptor (`docs/specs/cli-output.md`
 * §Plain output). Never through the runtime console: Bun's `console.error` wraps each line in
 * its own red whenever it thinks standard error can take color, a terminal or any
 * `FORCE_COLOR`, whatever `NO_COLOR` or `TERM=dumb` say.
 *
 * Each write is synchronous, so the lines of both streams reach a shared terminal or pipe in
 * the order written, and nothing is lost when `fffactory` exits right after: Bun's own
 * streams write a pipe asynchronously and drop what is pending at `process.exit`. Bun makes
 * the standard descriptors non-blocking once its stream objects exist, so a full pipe answers
 * EAGAIN, and the line waits until the reader drains it, as a blocking write would.
 */
import { writeSync } from "node:fs";

/** The descriptor calls a line writer makes, replaceable in tests. */
export interface DescriptorIo {
  /** Writes up to `length` bytes of `bytes` from `offset`; gives how many were written. */
  write(fd: number, bytes: Uint8Array, offset: number, length: number): number;
  /** Waits briefly before retrying a descriptor that was full. */
  wait(): void;
}

/** The real descriptor: `writeSync`, and a millisecond's sleep while it is full. */
export const systemDescriptorIo: DescriptorIo = {
  write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length),
  wait: () => Bun.sleepSync(1),
};

const encoder = new TextEncoder();

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * Writes what it can of `bytes` from `offset` to `fd`: how many bytes went, 0 after a full
 * (once waited) or interrupted write, or `undefined` once the stream is gone.
 */
function attempt(io: DescriptorIo, fd: number, bytes: Uint8Array, offset: number) {
  try {
    const written = io.write(fd, bytes, offset, bytes.length - offset);
    if (written === 0) io.wait();
    return written;
  } catch (error) {
    const code = errorCode(error);
    if (code === "EAGAIN") io.wait();
    return code === "EAGAIN" || code === "EINTR" ? 0 : undefined;
  }
}

/**
 * A line writer for descriptor `fd`: each line as given, then a newline. Once the stream is
 * gone (its reader closed, or any error but a full or interrupted write), later lines are
 * dropped rather than thrown, as the console drops them.
 */
// TODO(re-evaluate when a command's --json output is read from a redirected file): exit non-zero
// once the standard output writer has failed, so a full disk (ENOSPC) cannot pass truncated
// JSON off as success.
export function descriptorLines(
  fd: number,
  io: DescriptorIo = systemDescriptorIo,
): (line: string) => void {
  let gone = false;
  return (line) => {
    const bytes = encoder.encode(`${line}\n`);
    for (let offset = 0; !gone && offset < bytes.length; ) {
      const written = attempt(io, fd, bytes, offset);
      if (written === undefined) gone = true;
      else offset += written;
    }
  };
}
