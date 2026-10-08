import { type CheckResult, failed, notReady, ready, thenRerun } from "./check-result";

/** What running `ssh -V` showed. */
export type OpenSshObservation =
  | { readonly kind: "openssh"; readonly version: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_openssh" }
  /** Doctor could not tell: a non-zero exit, a timeout or a failure to start. */
  | { readonly kind: "unusable"; readonly reason: string };

/** What running `tailscale status --json --peers=false` showed. */
export type TailscaleObservation =
  | { readonly kind: "backend"; readonly backendState: string }
  | { readonly kind: "not_found" }
  /** The client ran but could not reach the local Tailscale daemon or service. */
  | { readonly kind: "daemon_unreachable" }
  | { readonly kind: "unusable"; readonly reason: string };

export const OPENSSH_CHECK = { id: "openssh", title: "OpenSSH client" } as const;
export const TAILSCALE_CHECK = { id: "tailscale", title: "Tailscale client" } as const;
/** What to do when a tool could not be inspected, before `thenRerun`. */
export const OPENSSH_DIAGNOSIS = "Run `ssh -V` to see why it fails";
export const TAILSCALE_DIAGNOSIS = "Run `tailscale status` to see the error";

export function openSshCheck(observation: OpenSshObservation): CheckResult {
  switch (observation.kind) {
    case "openssh":
      return ready(OPENSSH_CHECK, observation.version);
    case "not_found":
      return notReady(
        OPENSSH_CHECK,
        "ssh is not on PATH",
        thenRerun(
          "Install the system OpenSSH client (`openssh-client` or `openssh-clients` on Linux; " +
            "built into macOS) and make sure `ssh` is on PATH",
        ),
      );
    case "not_openssh":
      return notReady(
        OPENSSH_CHECK,
        "ssh on PATH is not OpenSSH",
        thenRerun("Put the system OpenSSH client first on PATH"),
      );
    case "unusable":
      return failed(OPENSSH_CHECK, observation.reason, thenRerun(OPENSSH_DIAGNOSIS));
  }
}

const TAILSCALE_STATUS_ACTION = thenRerun(TAILSCALE_DIAGNOSIS);
const STARTING = {
  summary: "Tailscale is starting",
  action: "Wait for Tailscale to finish starting",
};

/** Every `BackendState` the Tailscale client reports other than `Running`. */
const BACKEND_STATES: Readonly<Record<string, { summary: string; action: string }>> = {
  NeedsLogin: { summary: "Logged out", action: "Log in with `tailscale login`" },
  Stopped: { summary: "Logged in but disconnected", action: "Connect with `tailscale up`" },
  NeedsMachineAuth: {
    summary: "This device is waiting for tailnet admin approval",
    action:
      "Ask a tailnet admin to approve this device at https://login.tailscale.com/admin/machines",
  },
  Starting: STARTING,
  NoState: STARTING,
  InUseOtherUser: {
    summary: "Tailscale is in use by another user on this computer",
    action:
      "Log in to this computer as the user running Tailscale, or have that user log out of it",
  },
};

function backendCheck(backendState: string): CheckResult {
  if (backendState === "Running") return ready(TAILSCALE_CHECK, "Logged in and running");
  const known = Object.hasOwn(BACKEND_STATES, backendState) ? BACKEND_STATES[backendState] : null;
  // An unrecognized state is not echoed: it is tool output, not something doctor derived.
  if (!known)
    return failed(TAILSCALE_CHECK, "Unrecognized Tailscale BackendState", TAILSCALE_STATUS_ACTION);
  return notReady(TAILSCALE_CHECK, known.summary, thenRerun(known.action));
}

export function tailscaleCheck(observation: TailscaleObservation): CheckResult {
  switch (observation.kind) {
    case "backend":
      return backendCheck(observation.backendState);
    case "not_found":
      return notReady(
        TAILSCALE_CHECK,
        "tailscale is not on PATH",
        thenRerun(
          "Install the Tailscale client from https://tailscale.com/download and make sure " +
            "`tailscale` is on PATH",
        ),
      );
    case "daemon_unreachable":
      return notReady(
        TAILSCALE_CHECK,
        "The Tailscale daemon is not running",
        thenRerun(
          "Start Tailscale: open the Tailscale app, or run `sudo systemctl start tailscaled`",
        ),
      );
    case "unusable":
      return failed(TAILSCALE_CHECK, observation.reason, TAILSCALE_STATUS_ACTION);
  }
}
