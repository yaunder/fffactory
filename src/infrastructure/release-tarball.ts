/**
 * The release bundle's on-disk format: a gzipped POSIX ustar tarball of regular files, which
 * any `tar` can extract and whose single SHA-256 digest identifies the release (D4). Packing
 * is deterministic: entries sorted by path, owner 0, mtime 0, mode 0644 or 0755. Unpacking
 * is self-contained, so no `tar` needs to be installed, and accepts only regular files at
 * safe relative paths.
 */
import { bundlePathProblem } from "../domain/release-assets";

export interface TarballEntry {
  /** Relative path, obeying `bundlePathProblem`. */
  readonly path: string;
  readonly executable: boolean;
  readonly data: Uint8Array;
}

const BLOCK = 512;
const NAME = { offset: 0, length: 100 };
const PREFIX = { offset: 345, length: 155 };
const CHECKSUM = { offset: 148, length: 8 };
const TYPE_OFFSET = 156;
const MAGIC_OFFSET = 257;
const USTAR_MAGIC = "ustar\u000000";
const REGULAR_FILE = "0";
const LEGACY_REGULAR_FILE = "\0";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** The SHA-256 of `text`'s UTF-8 bytes: the domain's `Sha256`. */
export function sha256Text(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

function put(header: Uint8Array, offset: number, value: string): void {
  header.set(encoder.encode(value), offset);
}

/** A zero-padded octal field that ends in NUL. */
function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

export interface UstarFields {
  readonly name: string;
  readonly prefix?: string;
  readonly size: number;
  readonly executable?: boolean;
  /** The typeflag; a regular file unless given. */
  readonly type?: string;
}

/** One ustar header block with its checksum. It does not validate the path it records. */
export function ustarHeader(fields: UstarFields): Uint8Array {
  const header = new Uint8Array(BLOCK);
  put(header, NAME.offset, fields.name);
  put(header, 100, octal(fields.executable ? 0o755 : 0o644, 8));
  put(header, 108, octal(0, 8));
  put(header, 116, octal(0, 8));
  put(header, 124, octal(fields.size, 12));
  put(header, 136, octal(0, 12));
  put(header, CHECKSUM.offset, " ".repeat(CHECKSUM.length));
  put(header, TYPE_OFFSET, fields.type ?? REGULAR_FILE);
  put(header, MAGIC_OFFSET, USTAR_MAGIC);
  put(header, PREFIX.offset, fields.prefix ?? "");
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(header, CHECKSUM.offset, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** Splits `path` into ustar name and prefix fields, or rejects it as too long. */
function nameAndPrefix(path: string): { name: string; prefix: string } {
  if (path.length <= NAME.length) return { name: path, prefix: "" };
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (prefix.length <= PREFIX.length && name.length <= NAME.length) return { name, prefix };
  }
  throw new Error(`Bundle entry ${JSON.stringify(path)} is too long for a ustar header`);
}

function checkedPaths(entries: readonly { readonly path: string }[]): void {
  const seen = new Set<string>();
  for (const { path } of entries) {
    const problem = bundlePathProblem(path);
    if (problem) throw new Error(`Bundle entry ${JSON.stringify(path)} ${problem}`);
    if (seen.has(path))
      throw new Error(`Bundle entry ${JSON.stringify(path)} appears more than once`);
    seen.add(path);
  }
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** The deterministic gzipped tarball of `entries`. Rejects unsafe or duplicate paths. */
export function packTarball(entries: readonly TarballEntry[]): Uint8Array<ArrayBuffer> {
  checkedPaths(entries);
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
  const size = sorted.reduce(
    (total, e) => total + BLOCK + e.data.length + padding(e.data.length),
    0,
  );
  const tar = new Uint8Array(size + 2 * BLOCK);
  let offset = 0;
  for (const entry of sorted) {
    const fields = { ...nameAndPrefix(entry.path), size: entry.data.length };
    tar.set(ustarHeader({ ...fields, executable: entry.executable }), offset);
    tar.set(entry.data, offset + BLOCK);
    offset += BLOCK + entry.data.length + padding(entry.data.length);
  }
  return Bun.gzipSync(tar, { level: 9 });
}

function field(header: Uint8Array, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

const OCTAL_FIELDS = {
  mode: { offset: 100, length: 8 },
  size: { offset: 124, length: 12 },
  checksum: CHECKSUM,
} as const;

/**
 * An octal number field: octal digits, padded with spaces and ended by NUL; empty is 0.
 * Anything else, such as a sign or trailing junk, makes the header corrupt.
 */
function octalField(header: Uint8Array, name: keyof typeof OCTAL_FIELDS): number {
  const { offset, length } = OCTAL_FIELDS[name];
  const digits = field(header, offset, length).replace(/^ +| +$/g, "");
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw new Error(`Tarball header has a malformed ${name} field`);
  return Number.parseInt(digits, 8);
}

function verifiedHeader(header: Uint8Array): void {
  const recorded = octalField(header, "checksum");
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const inChecksum = index >= CHECKSUM.offset && index < CHECKSUM.offset + CHECKSUM.length;
    sum += inChecksum ? 0x20 : (header[index] ?? 0);
  }
  if (sum !== recorded) throw new Error("Tarball header checksum mismatch");
  if (decoder.decode(header.subarray(MAGIC_OFFSET, MAGIC_OFFSET + 8)) !== USTAR_MAGIC) {
    throw new Error("Tarball entry is not a ustar header");
  }
}

function entryPath(header: Uint8Array): string {
  const name = field(header, NAME.offset, NAME.length);
  const prefix = field(header, PREFIX.offset, PREFIX.length);
  return prefix ? `${prefix}/${name}` : name;
}

function readEntry(tar: Uint8Array, offset: number): { entry: TarballEntry; next: number } {
  const header = tar.subarray(offset, offset + BLOCK);
  verifiedHeader(header);
  const path = entryPath(header);
  const type = field(header, TYPE_OFFSET, 1) || LEGACY_REGULAR_FILE;
  if (type !== REGULAR_FILE && type !== LEGACY_REGULAR_FILE) {
    throw new Error(`Bundle entry ${JSON.stringify(path)} is not a regular file`);
  }
  const size = octalField(header, "size");
  const start = offset + BLOCK;
  if (start + size > tar.length) throw new Error("Tarball is truncated");
  const executable = (octalField(header, "mode") & 0o111) !== 0;
  const entry = { path, executable, data: tar.slice(start, start + size) };
  return { entry, next: start + size + padding(size) };
}

/**
 * Every entry of a gzipped ustar tarball, in archive order. Rejects anything but regular
 * files, any path `bundlePathProblem` refuses, duplicates, a bad header and truncation.
 */
export function unpackTarball(gzipped: Uint8Array<ArrayBuffer>): TarballEntry[] {
  const tar = Bun.gunzipSync(gzipped);
  const entries: TarballEntry[] = [];
  for (let offset = 0; ; ) {
    if (offset + BLOCK > tar.length) throw new Error("Tarball is truncated");
    if (tar.subarray(offset, offset + BLOCK).every((byte) => byte === 0)) break;
    const { entry, next } = readEntry(tar, offset);
    entries.push(entry);
    offset = next;
  }
  checkedPaths(entries);
  return entries;
}
