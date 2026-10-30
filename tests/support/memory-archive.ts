/**
 * An in-memory log archive for the collection run (`docs/specs/collector.md` §Run): an
 * `ArchiveWriter` that creates each key once, as S3 does under `If-None-Match: *`, answering
 * `exists` for a key already held. A test injects faults per put: a failure class, or a crash
 * (a thrown `Crash`) before or after the object is stored, and runs code before each put.
 */
import type { ArchiveWriter, PutOutcome } from "../../src/domain/archive-format";

/** What a put does instead of, or after, storing: a failure, or the run dying around it. */
export type PutFault =
  | { readonly kind: "failed"; readonly failure: string }
  | { readonly kind: "crash_before" }
  | { readonly kind: "crash_after" };

/** The run dying at a put, as a killed process would. */
export class Crash extends Error {
  constructor(readonly key: string) {
    super(`crashed at ${key}`);
  }
}

export interface MemoryArchive extends ArchiveWriter {
  /** Every object stored, by key. */
  readonly objects: Map<string, Uint8Array>;
  /** Every key put, in order, stored or not. */
  readonly puts: string[];
  /** Decides the fault, if any, for the `index`th put (from 0) of `key`. */
  fault: (key: string, index: number) => PutFault | undefined;
  /** Runs before each put, after its fault is decided: a test changes the worker here. */
  beforePut: (key: string, index: number) => Promise<void> | void;
}

export function memoryArchive(objects = new Map<string, Uint8Array>()): MemoryArchive {
  const archive: MemoryArchive = {
    objects,
    puts: [],
    fault: () => undefined,
    beforePut: () => {},
    async put(key: string, bytes: Uint8Array): Promise<PutOutcome> {
      const index = archive.puts.length;
      archive.puts.push(key);
      const fault = archive.fault(key, index);
      await archive.beforePut(key, index);
      if (fault?.kind === "failed") return fault;
      if (fault?.kind === "crash_before") throw new Crash(key);
      if (objects.has(key)) return { kind: "exists" };
      objects.set(key, Uint8Array.from(bytes));
      if (fault?.kind === "crash_after") throw new Crash(key);
      return { kind: "created" };
    },
  };
  return archive;
}
