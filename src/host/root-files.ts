/**
 * Root-owned files an install step writes outside the runtime account's home: whole or not at
 * all, 0644 in a 0755 directory, so `factory` can read them and never change them.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Writes `text` to the root-owned `path` whole or not at all, in a root 0755 directory. */
export async function writeRootFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await chmod(dirname(path), 0o755);
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(staging, "wx", 0o644);
    try {
      await handle.chmod(0o644);
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}
