import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  packTarball,
  sha256Hex,
  type TarballEntry,
  unpackTarball,
} from "../../src/infrastructure/release-tarball";
import { rawTarball, unpackWithin } from "../support/raw-tarball";

const text = (value: string) => new TextEncoder().encode(value);

const ENTRIES: TarballEntry[] = [
  { path: "release.json", executable: false, data: text('{"release":"0.3.0"}\n') },
  { path: "bin/setup.sh", executable: true, data: text("#!/bin/sh\necho set up\n") },
  { path: "terraform/empty.tf", executable: false, data: new Uint8Array() },
];

const byPath = (a: TarballEntry, b: TarballEntry) => (a.path < b.path ? -1 : 1);

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-tarball-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("packTarball and unpackTarball", () => {
  test("round-trip every entry, in path order, keeping the executable bit", () => {
    expect(unpackTarball(packTarball(ENTRIES))).toEqual([...ENTRIES].sort(byPath));
  });

  test("pack deterministically: the same entries in any order give the same bytes", () => {
    const first = packTarball(ENTRIES);
    const second = packTarball([...ENTRIES].reverse());
    expect(sha256Hex(second)).toBe(sha256Hex(first));
  });

  test("hold a path longer than 100 bytes in the ustar prefix", () => {
    const path = `${"d".repeat(120)}/${"f".repeat(90)}`;
    const entries = [{ path, executable: false, data: text("long") }];
    expect(unpackTarball(packTarball(entries))).toEqual(entries);
  });

  test("unpack reads octal fields padded with spaces", () => {
    const tarball = rawTarball([{ path: "a", data: text("hello"), fields: { size: "     5 " } }]);
    expect(unpackTarball(tarball)).toEqual([{ path: "a", executable: false, data: text("hello") }]);
  });

  test("pack refuses a path no ustar header can hold", () => {
    const entries = [{ path: "f".repeat(101), executable: false, data: new Uint8Array() }];
    expect(() => packTarball(entries)).toThrow(`is too long for a ustar header`);
  });

  test("pack refuses an unsafe or duplicate path", () => {
    const unsafe = [{ path: "../outside", executable: false, data: new Uint8Array() }];
    expect(() => packTarball(unsafe)).toThrow(`"../outside" must not contain '.' or '..'`);
    const duplicate = [ENTRIES[0], ENTRIES[0]] as TarballEntry[];
    expect(() => packTarball(duplicate)).toThrow(`"release.json" appears more than once`);
  });

  test("system tar lists and extracts the tarball with its modes", async () => {
    const tarball = join(scratch, "bundle.tar.gz");
    await writeFile(tarball, packTarball(ENTRIES));
    const listed = Bun.spawnSync(["tar", "-tvzf", tarball]).stdout.toString();
    expect(listed).toMatch(/-rwxr-xr-x .*bin\/setup\.sh/);
    expect(listed).toMatch(/-rw-r--r-- .*release\.json/);
    const out = await mkdtemp(join(scratch, "extract-"));
    expect(Bun.spawnSync(["tar", "-xzf", tarball, "-C", out]).exitCode).toBe(0);
    expect(await readFile(join(out, "release.json"), "utf8")).toBe('{"release":"0.3.0"}\n');
    expect((await stat(join(out, "bin/setup.sh"))).mode & 0o111).toBe(0o111);
  });
});

describe("unpackTarball refuses", () => {
  test.each([
    ["a traversing path", [{ path: "../../outside" }], `"../../outside" must not contain`],
    ["an absolute path", [{ path: "/etc/cron.d/x" }], `"/etc/cron.d/x" must be relative`],
    ["a symbolic link", [{ path: "link", type: "2" }], `"link" is not a regular file`],
    ["a hard link", [{ path: "link", type: "1" }], `"link" is not a regular file`],
    ["a directory", [{ path: "dir/", type: "5" }], `"dir/" is not a regular file`],
    ["a duplicate", [{ path: "a" }, { path: "a" }], `"a" appears more than once`],
    [
      "a traversing prefix",
      [{ path: "x", prefix: ".." }],
      `"../x" must not contain '.' or '..' segments`,
    ],
  ])("%s", (_, entries, message) => {
    expect(() => unpackTarball(rawTarball(entries))).toThrow(message);
  });

  test("a header whose checksum does not match", () => {
    expect(() => unpackTarball(rawTarball([{ path: "a" }], { corruptChecksum: true }))).toThrow(
      "Tarball header checksum mismatch",
    );
  });

  test("a header that is not ustar", () => {
    expect(() => unpackTarball(rawTarball([{ path: "a" }], { magic: "gnu" }))).toThrow(
      "Tarball entry is not a ustar header",
    );
  });

  test("a tarball without its end-of-archive blocks", () => {
    expect(() => unpackTarball(rawTarball([{ path: "a" }], { omitEnd: true }))).toThrow(
      "Tarball is truncated",
    );
  });

  test("an entry whose data runs past the end", () => {
    expect(() => unpackTarball(rawTarball([{ path: "a", size: 4096 }], { omitEnd: true }))).toThrow(
      "Tarball is truncated",
    );
  });

  test.each([
    ["a size that is not a number", { size: "zz" }, "size"],
    ["a size with trailing junk", { size: "12x" }, "size"],
    ["a mode that is not octal", { mode: "0000648" }, "mode"],
    ["a checksum with trailing junk", { checksum: (sum: string) => `${sum}x ` }, "checksum"],
  ])("%s, though its checksum is valid", (_, fields, name) => {
    const tarball = rawTarball([{ path: "a", fields }, { path: "b" }]);
    expect(() => unpackTarball(tarball)).toThrow(`Tarball header has a malformed ${name} field`);
  });

  test("a negative size, which would point back at its own header", async () => {
    const tarball = rawTarball([{ path: "a", fields: { size: "-1000" } }]);
    expect(await unpackWithin(2_000, tarball)).toEqual({
      error: "Tarball header has a malformed size field",
    });
  }, 5_000);

  test("bytes that are not gzip", () => {
    expect(() => unpackTarball(text("plain text"))).toThrow();
  });
});

describe("sha256Hex", () => {
  test("is the lowercase hexadecimal SHA-256", () => {
    expect(sha256Hex(text("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
