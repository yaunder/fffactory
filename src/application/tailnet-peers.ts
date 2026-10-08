import type { PeerView } from "../domain/tailnet";

/** Port: the devices the operator's local Tailscale client sees. Read-only. */
export interface TailnetPeers {
  /** Every failure resolves to a `PeerView`; it rejects only on a defect. */
  view(): Promise<PeerView>;
}
