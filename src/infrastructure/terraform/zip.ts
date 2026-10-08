/**
 * Just enough of the zip format to take the `terraform` executable out of HashiCorp's
 * release archive, so no `unzip` needs to be installed. It reads the central directory,
 * accepts stored and deflated entries, and checks each extracted entry's size and CRC-32.
 * The archive's SHA-256 is verified before it gets here; these checks catch a defect, not
 * an attacker.
 */
import { inflateRawSync } from "node:zlib";

const END_SIGNATURE = 0x06054b50;
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_SIZE = 30;
const ZIP64_MARKER = 0xffffffff;
const ENCRYPTED = 0x1;
const STORED = 0;
const DEFLATED = 8;

interface CentralEntry {
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

const decoder = new TextDecoder();

function endOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - END_SIZE;
  for (let at = last; at >= 0 && at >= last - MAX_COMMENT; at--) {
    if (view.getUint32(at, true) === END_SIGNATURE) return at;
  }
  throw new Error("Not a zip archive");
}

function inBounds(view: DataView, start: number, length: number): void {
  if (start + length > view.byteLength) throw new Error("The zip archive is truncated");
}

function findEntry(view: DataView, name: string): CentralEntry {
  const end = endOfCentralDirectory(view);
  const count = view.getUint16(end + 10, true);
  const offset = view.getUint32(end + 16, true);
  if (offset === ZIP64_MARKER) throw new Error("ZIP64 archives are not supported");
  let at = offset;
  for (let index = 0; index < count; index++) {
    inBounds(view, at, CENTRAL_SIZE);
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE)
      throw new Error("The zip archive is corrupt");
    const nameLength = view.getUint16(at + 28, true);
    inBounds(view, at + CENTRAL_SIZE, nameLength);
    const entryName = decoder.decode(
      new Uint8Array(view.buffer, view.byteOffset + at + CENTRAL_SIZE, nameLength),
    );
    if (entryName === name) {
      return {
        flags: view.getUint16(at + 8, true),
        method: view.getUint16(at + 10, true),
        crc: view.getUint32(at + 16, true),
        compressedSize: view.getUint32(at + 20, true),
        size: view.getUint32(at + 24, true),
        localOffset: view.getUint32(at + 42, true),
      };
    }
    at += CENTRAL_SIZE + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  throw new Error(`The zip archive has no entry ${name}`);
}

function storedData(view: DataView, entry: CentralEntry): Uint8Array {
  const at = entry.localOffset;
  inBounds(view, at, LOCAL_SIZE);
  if (view.getUint32(at, true) !== LOCAL_SIGNATURE) throw new Error("The zip archive is corrupt");
  const start = at + LOCAL_SIZE + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  inBounds(view, start, entry.compressedSize);
  return new Uint8Array(view.buffer, view.byteOffset + start, entry.compressedSize);
}

function decompress(stored: Uint8Array, method: number): Uint8Array {
  if (method === STORED) return stored;
  try {
    return new Uint8Array(inflateRawSync(stored));
  } catch {
    return new Uint8Array();
  }
}

/** The contents of the entry called `name` in the zip archive `archive`. */
export function extractZipEntry(archive: Uint8Array, name: string): Uint8Array {
  if (archive.length < END_SIZE) throw new Error("Not a zip archive");
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const entry = findEntry(view, name);
  if (entry.flags & ENCRYPTED) throw new Error(`The zip entry ${name} is encrypted`);
  if (entry.method !== STORED && entry.method !== DEFLATED)
    throw new Error(`The zip entry ${name} uses unsupported compression method ${entry.method}`);
  const data = decompress(storedData(view, entry), entry.method);
  if (data.length !== entry.size || Bun.hash.crc32(data) !== entry.crc)
    throw new Error(`The zip entry ${name} is corrupt`);
  return data;
}
