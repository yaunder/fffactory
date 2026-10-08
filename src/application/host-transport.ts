import type { RemoteCommand } from "../domain/host-protocol";
import type { WorkerAddress } from "../domain/tailnet";

/** How running one command on a worker ended. Never carries the command's standard error. */
export type HostCommandOutcome =
  /** The command ran; `exitCode` is its own. */
  | { readonly kind: "completed"; readonly exitCode: number; readonly stdout: string }
  /** No connection: refused, no route, timed out connecting, or dropped. */
  | { readonly kind: "unreachable"; readonly reason: string }
  /** The worker refused the login: tailnet SSH policy does not allow it. */
  | { readonly kind: "access_denied" }
  /** The worker presented a host key the tailnet does not list for it. */
  | { readonly kind: "host_key_mismatch" }
  /** The command did not finish within its timeout. */
  | { readonly kind: "timed_out" }
  /** The local SSH client is not installed. */
  | { readonly kind: "client_missing" }
  /** The local SSH client could not be started; `code` is the error code, such as EACCES. */
  | { readonly kind: "not_started"; readonly code: string };

export interface HostCommandOptions {
  readonly timeoutMs: number;
  /**
   * Bytes streamed to the remote command's standard input, which is then closed; closed at
   * once without. An upload is one more fixed command reading it.
   */
  readonly stdin?: Uint8Array;
}

/**
 * Port: runs fixed commands on a worker as `fffactory-admin`. Only a `WorkerAddress`, which
 * the hostname-match rule alone makes, can be reached, so nothing connects to a missing or
 * duplicate name. Every connection verifies the worker's host key against the tailnet's.
 */
export interface HostTransport {
  run(
    worker: WorkerAddress,
    command: RemoteCommand,
    options: HostCommandOptions,
  ): Promise<HostCommandOutcome>;
}
