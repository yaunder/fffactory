import type { OpenSshObservation, TailscaleObservation } from "../domain/local-tooling";

/** Port: inspects the local tools doctor requires. Read-only; never changes tool state. */
export interface ToolProbe {
  /** Observes `ssh -V`. */
  openSsh(): Promise<OpenSshObservation>;
  /** Observes `tailscale status --json --peers=false`. */
  tailscale(): Promise<TailscaleObservation>;
}
