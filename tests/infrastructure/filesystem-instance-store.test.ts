import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInstance } from "../../src/application/resolve-instance";
import { filesystemInstanceStore as store } from "../../src/infrastructure/filesystem-instance-store";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-store-"));
  await mkdir(join(root, "repo", ".fffactory"), { recursive: true });
  await mkdir(join(root, "repo", "nested", ".fffactory", "factory.json"), { recursive: true });
  await writeFile(join(root, "repo", ".fffactory", "factory.json"), '{"schema_version": 1}');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("filesystemInstanceStore", () => {
  test("recognizes a regular file", async () => {
    expect(await store.isFile(join(root, "repo", ".fffactory", "factory.json"))).toBe(true);
  });

  test("does not treat a directory as a file", async () => {
    expect(await store.isFile(join(root, "repo", ".fffactory"))).toBe(false);
  });

  test("reports a missing path, including one below a file, as not a file", async () => {
    expect(await store.isFile(join(root, "missing.json"))).toBe(false);
    expect(await store.isFile(join(root, "repo", ".fffactory", "factory.json", "x"))).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)("surfaces errors other than absence", async () => {
    const locked = join(root, "locked");
    await mkdir(locked, { mode: 0o000 });
    try {
      await expect(store.isFile(join(locked, "factory.json"))).rejects.toThrow("EACCES");
    } finally {
      await chmod(locked, 0o700);
    }
  });

  test("reads UTF-8 contents", async () => {
    expect(await store.read(join(root, "repo", ".fffactory", "factory.json"))).toBe(
      '{"schema_version": 1}',
    );
  });

  test("supports the upward search on a real directory tree", async () => {
    const result = await resolveInstance(store, {
      cwd: join(root, "repo", "nested"),
      home: join(root, "home"),
    });
    expect(result).toEqual({
      found: true,
      path: join(root, "repo", ".fffactory", "factory.json"),
      source: "nearest",
    });
  });

  test("write creates the document and any missing parent directories", async () => {
    const path = join(root, "fresh", ".fffactory", "factory.json");
    await store.write(path, '{"schema_version": 1}\n');
    expect(await readFile(path, "utf8")).toBe('{"schema_version": 1}\n');
  });

  test("write replaces an existing document and leaves no temporary file behind", async () => {
    const directory = join(root, "replace");
    await mkdir(directory);
    const path = join(directory, "factory.json");
    await writeFile(path, "old");
    await store.write(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
    expect(await readdir(directory)).toEqual(["factory.json"]);
  });

  test("write keeps the permissions of the document it replaces", async () => {
    const path = join(root, "private.json");
    await writeFile(path, "old", { mode: 0o600 });
    await chmod(path, 0o600);
    await store.write(path, "new");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("write through a symbolic link replaces the linked document, not the link", async () => {
    const target = join(root, "linked-target.json");
    const link = join(root, "linked.json");
    await writeFile(target, "old");
    await symlink(target, link);
    await store.write(link, "new");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new");
  });

  test("write through a dangling relative link creates the file it names, resolved against the link's directory", async () => {
    const directory = join(root, "dangling-relative");
    await mkdir(directory);
    const link = join(directory, "factory.json");
    await symlink(join("nowhere", "x.json"), link);
    await store.write(link, "new");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(directory, "nowhere", "x.json"), "utf8")).toBe("new");
    expect(await store.isFile(link)).toBe(true);
  });

  test("write through a dangling absolute link creates the file it names", async () => {
    const target = join(root, "dangling-absolute-target", "deep", "factory.json");
    const link = join(root, "dangling-absolute.json");
    await symlink(target, link);
    await store.write(link, "new");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new");
  });

  test("write follows a chain of links, each resolved against its own directory", async () => {
    const first = join(root, "chain", "a", "factory.json");
    const second = join(root, "chain", "b", "link.json");
    await mkdir(join(root, "chain", "a"), { recursive: true });
    await mkdir(join(root, "chain", "b"), { recursive: true });
    await symlink(join("..", "b", "link.json"), first);
    await symlink(join("c", "factory.json"), second);
    await store.write(first, "new");
    expect((await lstat(first)).isSymbolicLink()).toBe(true);
    expect((await lstat(second)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "chain", "b", "c", "factory.json"), "utf8")).toBe("new");
  });

  test("a symbolic link loop is refused with a clear error and changes nothing", async () => {
    const directory = join(root, "loop");
    await mkdir(directory);
    await symlink("b.json", join(directory, "a.json"));
    await symlink("a.json", join(directory, "b.json"));
    const loop = `${join(directory, "a.json")}: symbolic link loop`;
    await expect(store.isFile(join(directory, "a.json"))).rejects.toThrow(loop);
    await expect(store.write(join(directory, "a.json"), "new")).rejects.toThrow(loop);
    expect((await readdir(directory)).sort()).toEqual(["a.json", "b.json"]);
  });

  test("a failed write leaves the target and its directory as they were", async () => {
    const directory = join(root, "occupied");
    await mkdir(join(directory, "factory.json"), { recursive: true });
    await expect(store.write(join(directory, "factory.json"), "new")).rejects.toThrow();
    expect((await stat(join(directory, "factory.json"))).isDirectory()).toBe(true);
    expect(await readdir(directory)).toEqual(["factory.json"]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a write that cannot start leaves the existing document intact",
    async () => {
      const directory = join(root, "read-only");
      await mkdir(directory);
      const path = join(directory, "factory.json");
      await writeFile(path, "old");
      await chmod(directory, 0o500);
      try {
        await expect(store.write(path, "new")).rejects.toThrow("EACCES");
      } finally {
        await chmod(directory, 0o700);
      }
      expect(await readFile(path, "utf8")).toBe("old");
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "a write surfaces errors other than absence while locating the target",
    async () => {
      const locked = join(root, "locked-write");
      await mkdir(locked, { mode: 0o000 });
      try {
        await expect(store.write(join(locked, "factory.json"), "new")).rejects.toThrow("EACCES");
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );
});
