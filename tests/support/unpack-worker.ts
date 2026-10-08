/** Worker for `unpackWithin`: unpacks the tarball it is sent and posts what happened. */
import { unpackTarball } from "../../src/infrastructure/release-tarball";

declare const self: Worker;

self.onmessage = (event: MessageEvent<Uint8Array<ArrayBuffer>>) => {
  try {
    self.postMessage({ entries: unpackTarball(event.data).length });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
