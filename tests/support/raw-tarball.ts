import { ustarHeader } from "../../src/infrastructure/release-tarball";

export interface RawEntry {
  /** Recorded verbatim in the header's name field, unvalidated. */
  readonly path: string;
  readonly prefix?: string;
  /** The typeflag; a regular file unless given. */
  readonly type?: string;
  readonly data?: Uint8Array;
  /** The size the header claims; the data's length unless given. */
  readonly size?: number;
  /**
   * Raw text for octal fields, written after the header is built; the checksum is then
   * recomputed so the header stays valid. `checksum` maps the correct six-digit octal sum
   * to the checksum field's text.
   */
  readonly fields?: {
    readonly mode?: string;
    readonly size?: string;
    readonly checksum?: (sum: string) => string;
  };
}

export interface RawOptions {
  /** Change a header byte after its checksum was computed. */
  readonly corruptChecksum?: boolean;
  /** Write GNU tar's pre-POSIX magic instead of ustar's, with a valid checksum. */
  readonly magic?: "gnu";
  /** Leave out the two zero blocks that end an archive. */
  readonly omitEnd?: boolean;
}

const encoder = new TextEncoder();

/** Recomputes the header's checksum; `format` turns the octal sum into the field's text. */
function resum(header: Uint8Array, format = (sum: string) => `${sum}\0 `): Uint8Array {
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.set(encoder.encode(format(sum.toString(8).padStart(6, "0"))), 148);
  return header;
}

function withGnuMagic(header: Uint8Array): Uint8Array {
  header.set(encoder.encode("ustar  \0"), 257);
  return resum(header);
}

function withFields(header: Uint8Array, fields: NonNullable<RawEntry["fields"]>): Uint8Array {
  const place = (offset: number, length: number, value: string | undefined) => {
    if (value === undefined) return;
    header.fill(0, offset, offset + length);
    header.set(encoder.encode(value), offset);
  };
  place(100, 8, fields.mode);
  place(124, 12, fields.size);
  return resum(header, fields.checksum);
}

function rawHeader(entry: RawEntry, data: Uint8Array, options: RawOptions): Uint8Array {
  let header = ustarHeader({
    name: entry.path,
    prefix: entry.prefix,
    size: entry.size ?? data.length,
    type: entry.type,
  });
  if (entry.fields) header = withFields(header, entry.fields);
  if (options.magic === "gnu") header = withGnuMagic(header);
  if (options.corruptChecksum) header[0] = (header[0] ?? 0) ^ 0x01;
  return header;
}

/**
 * A gzipped tarball built from raw headers, bypassing every check `packTarball` makes, so
 * tests can hand `unpackTarball` what a hostile or broken bundle would hold.
 */
export function rawTarball(
  entries: readonly RawEntry[],
  options: RawOptions = {},
): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array();
    const header = rawHeader(entry, data, options);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  if (!options.omitEnd) blocks.push(new Uint8Array(1024));
  return Bun.gzipSync(new Uint8Array(Buffer.concat(blocks)));
}

export type UnpackOutcome = { entries: number } | { error: string } | "timed out";

/**
 * Runs `unpackTarball` in a worker and terminates it after `ms`, so a parser that loops
 * forever fails its test instead of hanging the suite: a synchronous loop in the test's
 * own thread would block the test runner's timeout too.
 */
export async function unpackWithin(
  ms: number,
  gzipped: Uint8Array<ArrayBuffer>,
): Promise<UnpackOutcome> {
  const worker = new Worker(new URL("./unpack-worker.ts", import.meta.url).href);
  let timer: Timer | undefined;
  try {
    return await new Promise<UnpackOutcome>((resolve, reject) => {
      timer = setTimeout(() => resolve("timed out"), ms);
      worker.onmessage = (event: MessageEvent<UnpackOutcome>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage(gzipped);
    });
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}
