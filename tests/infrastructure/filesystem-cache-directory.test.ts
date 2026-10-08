import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemCacheDirectory as probe } from "../../src/infrastructure/filesystem-cache-directory";

let root: string;
const isRoot = process.getuid?.() === 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-cache-"));
});

afterAll(async () => {
  await chmod(join(root, "read-only"), 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe("filesystemCacheDirectory", () => {
  test("an absent path is absent, and inspecting it creates nothing", async () => {
    const path = join(root, "absent", "fffactory");
    expect(await probe.inspect(path)).toBe("absent");
    expect(await Bun.file(join(root, "absent")).exists()).toBe(false);
  });

  test("a writable directory is writable", async () => {
    const path = join(root, "writable");
    await mkdir(path);
    expect(await probe.inspect(path)).toBe("writable");
  });

  test.skipIf(isRoot)("a directory without write permission is not writable", async () => {
    const path = join(root, "read-only");
    await mkdir(path);
    await chmod(path, 0o555);
    expect(await probe.inspect(path)).toBe("not_writable");
  });

  test("a regular file is not a directory", async () => {
    const path = join(root, "file");
    await writeFile(path, "");
    expect(await probe.inspect(path)).toBe("not_directory");
  });

  test("a dangling symbolic link is not a directory FFFactory could create", async () => {
    const path = join(root, "dangling");
    await symlink(join(root, "nowhere"), path);
    expect(await probe.inspect(path)).toBe("not_directory");
  });

  test("any other error is thrown", async () => {
    const file = join(root, "parent-file");
    await writeFile(file, "");
    await expect(probe.inspect(join(file, "fffactory"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
