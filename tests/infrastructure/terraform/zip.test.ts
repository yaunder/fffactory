import { describe, expect, test } from "bun:test";
import { extractZipEntry } from "../../../src/infrastructure/terraform/zip";
import { zipArchive } from "../../support/zip";

const EXECUTABLE = "#!/bin/sh\necho terraform\n".repeat(50);
const decoder = new TextDecoder();

function extracted(archive: Uint8Array, name = "terraform"): string {
  return decoder.decode(extractZipEntry(archive, name));
}

describe("extractZipEntry", () => {
  test("extracts a deflated entry by name, among others", () => {
    const archive = zipArchive([
      { name: "LICENSE.txt", data: "license", deflate: true },
      { name: "terraform", data: EXECUTABLE, deflate: true },
    ]);
    expect(extracted(archive)).toBe(EXECUTABLE);
    expect(extracted(archive, "LICENSE.txt")).toBe("license");
  });

  test("extracts a stored entry", () => {
    expect(extracted(zipArchive([{ name: "terraform", data: EXECUTABLE }]))).toBe(EXECUTABLE);
  });

  test("ignores a trailing archive comment", () => {
    const archive = zipArchive([{ name: "terraform", data: EXECUTABLE, deflate: true }]);
    const commented = Buffer.concat([archive, Buffer.from("comment")]);
    new DataView(commented.buffer, commented.byteOffset).setUint16(archive.length - 2, 7, true);
    expect(extracted(commented)).toBe(EXECUTABLE);
  });

  test("rejects an archive without the entry", () => {
    const archive = zipArchive([{ name: "LICENSE.txt", data: "license" }]);
    expect(() => extractZipEntry(archive, "terraform")).toThrow(
      "The zip archive has no entry terraform",
    );
  });

  test.each([
    ["no end of central directory", new Uint8Array(100)],
    ["an empty file", new Uint8Array()],
  ])("rejects %s", (_, archive) => {
    expect(() => extractZipEntry(archive, "terraform")).toThrow("Not a zip archive");
  });

  test("rejects an encrypted entry", () => {
    const archive = zipArchive([{ name: "terraform", data: EXECUTABLE, flags: 1 }]);
    expect(() => extractZipEntry(archive, "terraform")).toThrow(
      "The zip entry terraform is encrypted",
    );
  });

  test("rejects an unsupported compression method", () => {
    const archive = zipArchive([{ name: "terraform", data: EXECUTABLE, method: 12 }]);
    expect(() => extractZipEntry(archive, "terraform")).toThrow(
      "The zip entry terraform uses unsupported compression method 12",
    );
  });

  test("rejects an entry whose contents fail its CRC-32", () => {
    const archive = zipArchive([{ name: "terraform", data: EXECUTABLE }]);
    archive[40] = (archive[40] ?? 0) ^ 0xff;
    expect(() => extractZipEntry(archive, "terraform")).toThrow(
      "The zip entry terraform is corrupt",
    );
  });

  test("rejects a central directory that points outside the archive", () => {
    const archive = zipArchive([{ name: "terraform", data: EXECUTABLE }]);
    const view = new DataView(archive.buffer, archive.byteOffset);
    view.setUint32(archive.length - 6, archive.length, true);
    expect(() => extractZipEntry(archive, "terraform")).toThrow("The zip archive is truncated");
  });

  test("rejects a ZIP64 archive", () => {
    const archive = zipArchive([{ name: "terraform", data: EXECUTABLE }]);
    const view = new DataView(archive.buffer, archive.byteOffset);
    view.setUint32(archive.length - 6, 0xffffffff, true);
    expect(() => extractZipEntry(archive, "terraform")).toThrow("ZIP64 archives are not supported");
  });

  test("rejects an entry whose local header is missing", () => {
    const archive = zipArchive([{ name: "terraform", data: EXECUTABLE }]);
    archive[0] = 0;
    expect(() => extractZipEntry(archive, "terraform")).toThrow("The zip archive is corrupt");
  });
});
