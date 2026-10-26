import { join } from "node:path";
import { hashSync } from "bcryptjs";
import type { AgentActivity, ControlPlaneAction } from "../domain/control-plane";
import { WORKER_PATHS } from "../domain/host-protocol";
import { parseHostProjection } from "../domain/host-projection";
import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "../domain/installation";
import type { SecretReference } from "../domain/instance";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { ApplySystem } from "./apply";
import { AWS_ENV, readSecretValue } from "./secret-value";

const TIMEOUT_MS = 2 * 60_000;
/** Paseo's own cost: `DAEMON_PASSWORD_BCRYPT_COST` in `@getpaseo/server`'s auth.js. */
const PASEO_BCRYPT_COST = 12;
const ENV = {
  PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
};

function failure(outcome: ProcessOutcome, what: string): ControlPlaneAction {
  if (outcome.kind === "exited")
    return outcome.exitCode === 0
      ? { kind: "done" }
      : { kind: "failed", reason: `${what} exited ${outcome.exitCode}` };
  return { kind: "failed", reason: `${what} ${outcome.kind}` };
}

/**
 * The bcrypt hash of the host's Paseo password, made as Paseo's `daemon set-password` makes it
 * (bcryptjs's `hashSync`, its cost), or why the password could not be had. The password is read
 * as root with the instance role and reaches only the hash function: never an argument, an
 * environment, a log or a file. It is hashed as `paseo-auth.sh` sends it, its final line endings
 * dropped (`$(...)`), so fffactory's own CLI calls keep authenticating.
 */
async function passwordHash(
  system: ApplySystem,
  arn: SecretReference,
): Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  const read = await readSecretValue(
    (argv) => system.run(argv, CREDENTIAL_COMMAND_TIMEOUT_MS, { env: AWS_ENV }),
    arn,
  );
  if (!read.ok) return { ok: false, reason: `Paseo password: ${read.reason}` };
  const password = read.value.reveal().replace(/\n+$/, "");
  if (password.trim() === "") return { ok: false, reason: "Paseo password: its secret is empty" };
  return { ok: true, hash: hashSync(password, PASEO_BCRYPT_COST) };
}

export interface HostControlPlane {
  activity(): Promise<AgentActivity>;
  install(): Promise<ControlPlaneAction>;
  reload(): Promise<ControlPlaneAction>;
  restart(): Promise<ControlPlaneAction>;
}

export function workerControlPlane(system: ApplySystem): HostControlPlane {
  const release = join(system.root, WORKER_PATHS.activeRelease);
  const auth = join(release, "steps/control-plane/paseo-auth.sh");
  const setup = join(release, "steps/control-plane/setup-host.sh");
  const run = (argv: readonly string[], stdin?: string) =>
    system.run(argv, TIMEOUT_MS, {
      env: ENV,
      ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
    });
  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: hostile CLI output is parsed conservatively at this boundary
    async activity() {
      if (!system.isRoot()) return { kind: "unknown", reason: "not root" };
      const outcome = await run([
        "/usr/sbin/runuser",
        "-u",
        "factory",
        "--",
        "/usr/bin/env",
        "-i",
        "HOME=/home/factory",
        "PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
        auth,
        // TODO(re-evaluate when #98 lands): list with --global --background; Paseo 0.12+ hides
        // agents in background workspaces from a bare ls, so this does not count them.
        "agent",
        "ls",
        "--json",
      ]);
      if (outcome.kind !== "exited" || outcome.exitCode !== 0)
        return { kind: "unknown", reason: "Paseo activity could not be read" };
      try {
        const parsed: unknown = JSON.parse(outcome.stdout);
        const agents = Array.isArray(parsed)
          ? parsed
          : typeof parsed === "object" &&
              parsed !== null &&
              Array.isArray((parsed as { agents?: unknown }).agents)
            ? (parsed as { agents: unknown[] }).agents
            : undefined;
        if (agents === undefined) return { kind: "unknown", reason: "Paseo activity was invalid" };
        return agents.length === 0 ? { kind: "idle" } : { kind: "active", count: agents.length };
      } catch {
        return { kind: "unknown", reason: "Paseo activity was invalid" };
      }
    },
    async install() {
      if (!system.isRoot()) return { kind: "failed", reason: "not root" };
      const input = await system.readInput();
      const parsed = parseHostProjection(input);
      if (!parsed.ok) return { kind: "failed", reason: "invalid host projection" };
      if (parsed.document.hostname.toLowerCase() !== system.hostname().toLowerCase())
        return { kind: "failed", reason: "host projection is for another worker" };
      // Setup's standard input: the reference, then the hash, each line empty without one.
      const arn = parsed.document.paseo_password_secret;
      if (arn === undefined) return failure(await run(["/bin/bash", setup], "\n\n"), "Paseo setup");
      const hashed = await passwordHash(system, arn);
      if (!hashed.ok) return { kind: "failed", reason: hashed.reason };
      return failure(await run(["/bin/bash", setup], `${arn}\n${hashed.hash}\n`), "Paseo setup");
    },
    async reload() {
      if (!system.isRoot()) return { kind: "failed", reason: "not root" };
      return failure(
        await run([
          "/usr/sbin/runuser",
          "-u",
          "factory",
          "--",
          "/usr/bin/env",
          "-i",
          "HOME=/home/factory",
          "PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin",
          auth,
          "daemon",
          "reload",
        ]),
        "Paseo reload",
      );
    },
    async restart() {
      if (!system.isRoot()) return { kind: "failed", reason: "not root" };
      return failure(
        await run(["/usr/bin/systemctl", "restart", "paseo.service"]),
        "Paseo restart",
      );
    },
  };
}
