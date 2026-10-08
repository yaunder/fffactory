/**
 * The install lock (`docs/specs/host-protocol.md` §apply): `host apply` holds an exclusive
 * `flock(2)` on `WORKER_PATHS.applyLock` while it installs, so two installs never overlap on one
 * worker, even when the operator's factory lock was broken or an interrupted apply left one
 * running. The kernel releases it when its holder exits, however it ends. The file is opened
 * close-on-exec, so no step inherits it and a step left running cannot keep it.
 */
import { closeSync, openSync } from "node:fs";
import { platform } from "node:os";

/** A lock this process holds until `release`, or until it exits. */
export interface HeldLock {
  release(): void;
}

/** Takes an exclusive lock on `path` without waiting; undefined when another holder has it. */
export type ExclusiveLock = (path: string) => Promise<HeldLock | undefined>;

const LOCK_EX = 2;
const LOCK_NB = 4;

/** libc, and how to read `errno` after a call and which value means "would block". */
function libc() {
  return platform() === "darwin"
    ? { library: "libSystem.B.dylib", errno: "__error", wouldBlock: 35 }
    : { library: "libc.so.6", errno: "__errno_location", wouldBlock: 11 };
}

type Flock = (fd: number) => { readonly result: number; readonly errno: number };

let flock: Flock | undefined;

/** `flock(fd, LOCK_EX | LOCK_NB)` through libc, loaded at first use: Bun has no flock of its own. */
async function loadFlock(): Promise<Flock> {
  if (flock !== undefined) return flock;
  const { dlopen, FFIType, read } = await import("bun:ffi");
  const { library, errno } = libc();
  const { symbols } = dlopen(library, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errno]: { args: [], returns: FFIType.ptr },
  });
  const errnoLocation = symbols[errno];
  if (errnoLocation === undefined) throw new Error(`${library} has no ${errno}`);
  flock = (fd) => {
    const result = symbols.flock(fd, LOCK_EX | LOCK_NB);
    const pointer = result === 0 ? null : errnoLocation();
    return { result, errno: pointer === null ? 0 : read.i32(pointer, 0) };
  };
  return flock;
}

/** The install lock over `flock(2)`. Another error than "held elsewhere" is thrown. */
export const flockExclusive: ExclusiveLock = async (path) => {
  const take = await loadFlock();
  // Node opens files close-on-exec, so the steps `host apply` runs never inherit it.
  const fd = openSync(path, "w", 0o600);
  const { result, errno } = take(fd);
  if (result === 0) return { release: () => closeSync(fd) };
  closeSync(fd);
  if (errno === libc().wouldBlock) return undefined;
  throw Object.assign(new Error(`flock failed with errno ${errno}`), { code: `ERRNO${errno}` });
};
