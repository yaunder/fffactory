/**
 * Builds zip archives like the ones HashiCorp publishes Terraform in, so tests never
 * download one. Entries are stored or deflated; nothing here validates what it writes, so
 * tests can also build broken archives by patching the bytes.
 */
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array | string;
  /** Deflate the entry (method 8) instead of storing it (method 0). */
  readonly deflate?: boolean;
  /** General purpose flags; bit 0 marks an encrypted entry. */
  readonly flags?: number;
  /** Compression method recorded in the headers; overrides the one `deflate` implies. */
  readonly method?: number;
}

const encoder = new TextEncoder();

function header(size: number, fill: (view: DataView) => void, name: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(size + name.length);
  fill(new DataView(bytes.buffer));
  bytes.set(name, size);
  return bytes;
}

interface Prepared {
  readonly name: Uint8Array;
  readonly stored: Uint8Array;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly size: number;
}

function prepare(entry: ZipEntry): Prepared {
  const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
  return {
    name: encoder.encode(entry.name),
    stored: entry.deflate ? new Uint8Array(deflateRawSync(data)) : data,
    method: entry.method ?? (entry.deflate ? 8 : 0),
    flags: entry.flags ?? 0,
    crc: Bun.hash.crc32(data),
    size: data.length,
  };
}

function localHeader(entry: Prepared): Uint8Array {
  return header(
    30,
    (view) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, entry.flags, true);
      view.setUint16(8, entry.method, true);
      view.setUint16(12, 0x21, true);
      view.setUint32(14, entry.crc, true);
      view.setUint32(18, entry.stored.length, true);
      view.setUint32(22, entry.size, true);
      view.setUint16(26, entry.name.length, true);
    },
    entry.name,
  );
}

function centralHeader(entry: Prepared, offset: number): Uint8Array {
  return header(
    46,
    (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 0x031e, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, entry.flags, true);
      view.setUint16(10, entry.method, true);
      view.setUint16(14, 0x21, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.stored.length, true);
      view.setUint32(24, entry.size, true);
      view.setUint16(28, entry.name.length, true);
      view.setUint32(38, (0o100755 << 16) >>> 0, true);
      view.setUint32(42, offset, true);
    },
    entry.name,
  );
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  return header(
    22,
    (view) => {
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, count, true);
      view.setUint16(10, count, true);
      view.setUint32(12, size, true);
      view.setUint32(16, offset, true);
    },
    new Uint8Array(),
  );
}

/** A zip archive holding `entries` in order. */
export function zipArchive(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries.map(prepare)) {
    central.push(centralHeader(entry, offset));
    const local = localHeader(entry);
    parts.push(local, entry.stored);
    offset += local.length + entry.stored.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = endOfCentralDirectory(entries.length, centralSize, offset);
  return Buffer.concat([...parts, ...central, end]);
}
