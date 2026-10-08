/** Port: where factory instance documents live. Paths are absolute. */
export interface InstanceStore {
  /** True when `path` names an existing regular file. */
  isFile(path: string): Promise<boolean>;
  /** Reads the document at `path` as UTF-8 text. */
  read(path: string): Promise<string>;
  /**
   * Replaces the document at `path` with `contents`, creating missing parent directories.
   * The replacement is atomic: on failure the previous document, if any, is left intact.
   */
  write(path: string, contents: string): Promise<void>;
}
