import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { InstanceStore } from "../application/instance-store";

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

function isAbsent(error: unknown): boolean {
  return ABSENT.has((error as NodeJS.ErrnoException).code ?? "");
}

/** Links followed before a chain counts as a loop; Linux's own limit. */
const MAX_LINKS = 40;

function symlinkLoop(path: string): Error {
  return new Error(`${path}: symbolic link loop (more than ${MAX_LINKS} links to follow)`);
}

/**
 * The file a write replaces. Symbolic links are followed, each relative target resolved
 * against its link's directory, so a dangling link names the file to create. An existing
 * file keeps its mode.
 */
async function replacementTarget(path: string): Promise<{ path: string; mode?: number }> {
  let current = path;
  for (let followed = 0; followed <= MAX_LINKS; followed++) {
    const info = await lstat(current).catch((error: unknown) => {
      if (isAbsent(error)) return undefined;
      throw error;
    });
    if (!info) return { path: current };
    if (!info.isSymbolicLink()) return { path: current, mode: info.mode & 0o7777 };
    current = resolve(await realpath(dirname(current)), await readlink(current));
  }
  throw symlinkLoop(path);
}

async function writeDurably(path: string, contents: string, mode?: number): Promise<void> {
  const handle = await open(path, "wx", mode ?? 0o666);
  try {
    await handle.writeFile(contents, "utf8");
    if (mode !== undefined) await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** InstanceStore adapter over the local filesystem. */
export const filesystemInstanceStore: InstanceStore = {
  async isFile(path) {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (isAbsent(error)) return false;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw symlinkLoop(path);
      throw error;
    }
  },

  read(path) {
    return readFile(path, "utf8");
  },

  /** Writes a sibling temporary file, then renames it over the target. */
  async write(path, contents) {
    const target = await replacementTarget(path);
    const directory = dirname(target.path);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${basename(target.path)}.${randomUUID()}.tmp`);
    try {
      await writeDurably(temporary, contents, target.mode);
      await rename(temporary, target.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  },
};
