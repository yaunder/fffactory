import type { InstanceStore } from "../../src/application/instance-store";

/** In-memory InstanceStore keyed by absolute path. */
export class MemoryInstanceStore implements InstanceStore {
  readonly reads: string[] = [];
  readonly writes: string[] = [];

  constructor(readonly files: Record<string, string> = {}) {}

  async isFile(path: string): Promise<boolean> {
    return path in this.files;
  }

  async read(path: string): Promise<string> {
    this.reads.push(path);
    const contents = this.files[path];
    if (contents === undefined) throw new Error(`no such file: ${path}`);
    return contents;
  }

  async write(path: string, contents: string): Promise<void> {
    this.writes.push(path);
    this.files[path] = contents;
  }
}
