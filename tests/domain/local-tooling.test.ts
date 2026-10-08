import { describe, expect, test } from "bun:test";
import {
  openSshCheck,
  type TailscaleObservation,
  tailscaleCheck,
} from "../../src/domain/local-tooling";

describe("OpenSSH check", () => {
  test("OpenSSH is ready and reports its version", () => {
    const check = openSshCheck({ kind: "openssh", version: "OpenSSH_9.9p1" });
    expect(check).toMatchObject({ id: "openssh", status: "ready", summary: "OpenSSH_9.9p1" });
    expect(check.nextAction).toBeNull();
  });

  test("a missing ssh is not ready and says how to install OpenSSH", () => {
    const check = openSshCheck({ kind: "not_found" });
    expect(check.status).toBe("not_ready");
    expect(check.nextAction).toContain("Install the system OpenSSH client");
    expect(check.nextAction).toEndWith("then rerun `fffactory doctor`.");
  });

  test("an ssh that is not OpenSSH is not ready", () => {
    const check = openSshCheck({ kind: "not_openssh" });
    expect(check.status).toBe("not_ready");
    expect(check.nextAction).toContain("first on PATH");
  });

  test("an unusable ssh is an error that points at ssh -V", () => {
    const check = openSshCheck({ kind: "unusable", reason: "`ssh -V` timed out" });
    expect(check).toMatchObject({ status: "error", summary: "`ssh -V` timed out" });
    expect(check.nextAction).toContain("Run `ssh -V`");
  });
});

function backend(backendState: string): TailscaleObservation {
  return { kind: "backend", backendState };
}

describe("Tailscale check", () => {
  test("Running is ready", () => {
    expect(tailscaleCheck(backend("Running"))).toMatchObject({
      id: "tailscale",
      status: "ready",
      nextAction: null,
    });
  });

  test("missing, logged out and daemon-down each have a distinct next action", () => {
    const actions = [
      tailscaleCheck({ kind: "not_found" }),
      tailscaleCheck(backend("NeedsLogin")),
      tailscaleCheck({ kind: "daemon_unreachable" }),
    ].map((check) => {
      expect(check.status).toBe("not_ready");
      return check.nextAction;
    });
    expect(actions[0]).toContain("https://tailscale.com/download");
    expect(actions[1]).toContain("`tailscale login`");
    expect(actions[2]).toContain("sudo systemctl start tailscaled");
    expect(new Set(actions).size).toBe(3);
  });

  const notReady: [string, string][] = [
    ["Stopped", "`tailscale up`"],
    ["NeedsMachineAuth", "approve this device"],
    ["Starting", "finish starting"],
    ["NoState", "finish starting"],
    ["InUseOtherUser", "user running Tailscale"],
  ];
  for (const [state, action] of notReady) {
    test(`${state} is not ready`, () => {
      const check = tailscaleCheck(backend(state));
      expect(check.status).toBe("not_ready");
      expect(check.nextAction).toContain(action);
    });
  }

  test("an unrecognized BackendState is an error and is not echoed verbatim", () => {
    const check = tailscaleCheck(backend("tskey-auth-looks-secret"));
    expect(check.status).toBe("error");
    expect(JSON.stringify(check)).not.toContain("tskey");
    expect(check.nextAction).toContain("Run `tailscale status`");
  });

  test("an unusable client is an error", () => {
    const check = tailscaleCheck({ kind: "unusable", reason: "exited with status 3" });
    expect(check).toMatchObject({ status: "error", summary: "exited with status 3" });
  });
});
