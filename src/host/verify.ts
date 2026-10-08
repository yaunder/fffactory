/**
 * The worker side of `host verify` (`docs/specs/readiness.md`): fixed TypeScript verifiers of
 * what the install steps set up, and checks of which accounts the runtime account `factory`
 * has enrolled. It runs as root: `host apply` runs it after its steps, since only the
 * activator gives root, and the credentials it checks are `factory`'s own. It changes
 * nothing, and never echoes what a tool prints: a credential check's output can name an
 * account.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { WORKER_PATHS } from "../domain/host-protocol";
import type { Release } from "../domain/instance";
import {
  ENROLLMENTS,
  type EnrollmentId,
  type EnrollmentState,
  RUNTIME_ACCOUNT,
  type SoftwareCheck,
  type Verification,
} from "../domain/readiness";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import { tokenOr, type WorkerSystem } from "./inspect";

/** What verification needs of the worker. */
export interface VerifySystem extends WorkerSystem {
  readonly now: () => Date;
  /** This executable's release, whose steps hold the pins and the plugin verifier. */
  readonly release: Release;
}

export interface HostVerifier {
  verify(): Promise<Verification>;
}

/** Each command's deadline; every verifier runs at once. */
export const CHECK_TIMEOUT_MS = 30_000;
/** The plugins step's own verifier reads every plugin checkout, so it gets longer. */
export const PLUGINS_TIMEOUT_MS = 2 * 60_000;

const FACTORY_HOME = `/home/${RUNTIME_ACCOUNT}`;

/**
 * How a command runs as the runtime account: `runuser`, then `env -i` so it gets exactly the
 * environment its agents get (its own tools first) and nothing of root's.
 */
export const AS_FACTORY = [
  "/usr/sbin/runuser",
  "-u",
  RUNTIME_ACCOUNT,
  "--",
  "/usr/bin/env",
  "-i",
  `HOME=${FACTORY_HOME}`,
  `PATH=${FACTORY_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
  "LANG=C.UTF-8",
  "DISABLE_UPDATES=1",
] as const;

/** The tools the packages step installs, each with the command that shows it runs. */
export const TOOLCHAIN: readonly (readonly [string, readonly string[]])[] = [
  ["Git", ["git", "--version"]],
  ["Git LFS", ["git", "lfs", "version"]],
  ["GitHub CLI", ["gh", "--version"]],
  ["ripgrep", ["rg", "--version"]],
  ["jq", ["jq", "--version"]],
  ["Node 22", ["node", "--version"]],
  ["npm", ["npm", "--version"]],
  ["Python 3.11", ["python3.11", "--version"]],
  ["GNU Make", ["make", "--version"]],
  ["GCC", ["gcc", "--version"]],
];

/** The workspace directories the user step makes for the runtime account. */
export const WORKSPACE = ["/workspace/repos", "/workspace/cache"] as const;

function passed(id: string, summary: string): SoftwareCheck {
  return { id, status: "passed", summary };
}

function failed(id: string, summary: string): SoftwareCheck {
  return { id, status: "failed", summary };
}

function succeeded(
  outcome: ProcessOutcome,
): outcome is Extract<ProcessOutcome, { kind: "exited" }> {
  return outcome.kind === "exited" && outcome.exitCode === 0;
}

/** `KEY=value` lines of a pins file, values unquoted. */
function pins(text: string): Map<string, string> {
  const entries = text
    .split("\n")
    .map((line) => /^([A-Z_][A-Z0-9_]*)=(['"]?)(.*)\2$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => [match[1] ?? "", match[3] ?? ""] as const);
  return new Map(entries);
}

/** How each account's credential is checked, as `factory`. */
export const CREDENTIAL_CHECKS: Readonly<Record<EnrollmentId, readonly string[]>> = {
  github: ["gh", "auth", "status", "--hostname", "github.com"],
  openai: ["codex", "login", "status"],
  anthropic: ["claude", "auth", "status"],
};

function verifiers(system: VerifySystem) {
  const asFactory = (argv: readonly string[]) =>
    system.run([...AS_FACTORY, ...argv], CHECK_TIMEOUT_MS, { env: {} });
  const steps = join(system.root, WORKER_PATHS.releases, system.release, "steps");

  /** The runtime account's user ID, or undefined when it does not exist. */
  async function factoryUid(): Promise<number | undefined> {
    const outcome = await system.run(["/usr/bin/id", "-u", RUNTIME_ACCOUNT], CHECK_TIMEOUT_MS, {
      env: {},
    });
    const uid = succeeded(outcome) ? Number(outcome.stdout.trim()) : Number.NaN;
    return Number.isSafeInteger(uid) ? uid : undefined;
  }

  async function toolchain(): Promise<SoftwareCheck> {
    const results = await Promise.all(
      TOOLCHAIN.map(async ([name, argv]) => {
        const outcome = await asFactory(argv);
        const runs =
          succeeded(outcome) && (name !== "Node 22" || outcome.stdout.startsWith("v22."));
        return runs ? undefined : name;
      }),
    );
    const missing = results.filter((name) => name !== undefined);
    return missing.length === 0
      ? passed("toolchain", "Every development tool runs, with Node 22 by default")
      : failed("toolchain", `Missing, failing or the wrong version: ${missing.join(", ")}`);
  }

  async function workspace(uid: number | undefined): Promise<SoftwareCheck> {
    const wrong: string[] = [];
    for (const directory of WORKSPACE) {
      const info = await stat(join(system.root, directory)).catch(() => undefined);
      if (!info?.isDirectory() || info.uid !== uid) wrong.push(directory);
    }
    return wrong.length === 0
      ? passed("workspace", `${WORKSPACE.join(" and ")} belong to ${RUNTIME_ACCOUNT}`)
      : failed("workspace", `Missing or not owned by ${RUNTIME_ACCOUNT}: ${wrong.join(", ")}`);
  }

  async function agents(): Promise<SoftwareCheck> {
    const text = await readFile(join(steps, "versions.env"), "utf8").catch(() => "");
    const pinned = pins(text);
    const expected = [
      ["Codex", pinned.get("CODEX_VERSION"), ["codex", "--version"]],
      ["Claude Code", pinned.get("CLAUDE_CODE_VERSION"), ["claude", "--version"]],
    ] as const;
    const wrong: string[] = [];
    for (const [name, version, argv] of expected) {
      const outcome = await asFactory(argv);
      if (version === undefined || !succeeded(outcome) || !outcome.stdout.includes(version))
        wrong.push(name);
    }
    return wrong.length === 0
      ? passed("agents", "Codex and Claude Code match their pins")
      : failed("agents", `Missing or not at its pin: ${wrong.join(", ")}`);
  }

  async function plugins(): Promise<SoftwareCheck> {
    const outcome = await system.run(
      ["/bin/bash", join(steps, "plugins.sh"), "verify"],
      PLUGINS_TIMEOUT_MS,
      {
        env: {
          PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          HOME: "/root",
          LANG: "C.UTF-8",
          FFFACTORY_STEPS: steps,
        },
      },
    );
    return succeeded(outcome)
      ? passed("plugins", "The agent plugins match their pins")
      : failed("plugins", "The agent plugins do not match their pins");
  }

  async function tailscaled(): Promise<SoftwareCheck> {
    const outcome = await system.run(
      ["/usr/bin/systemctl", "is-active", "tailscaled.service"],
      CHECK_TIMEOUT_MS,
      { env: { LANG: "C" } },
    );
    return succeeded(outcome) && outcome.stdout.trim() === "active"
      ? passed("tailscaled", "tailscaled is active")
      : failed("tailscaled", "tailscaled is not active");
  }

  /** Whether `factory` has a credential: the tool says so, no credential, or cannot tell. */
  async function enrolled(argv: readonly string[]): Promise<EnrollmentState> {
    const outcome = await asFactory(argv);
    if (outcome.kind !== "exited") return "unknown";
    // `env` exits 127 when the tool is missing, and 126 when it cannot run it.
    if (outcome.exitCode === 127 || outcome.exitCode === 126) return "unknown";
    return outcome.exitCode === 0 ? "enrolled" : "pending";
  }

  async function enrollment(id: EnrollmentId): Promise<EnrollmentState> {
    return enrolled(CREDENTIAL_CHECKS[id]);
  }

  return { factoryUid, toolchain, workspace, agents, plugins, tailscaled, enrollment };
}

/** `host verify` on the worker `system` describes. */
export function workerVerifier(system: VerifySystem): HostVerifier {
  return {
    async verify() {
      const hostname = tokenOr(system.hostname(), "unknown");
      const check = verifiers(system);
      const uid = await check.factoryUid();
      const account =
        uid === undefined
          ? failed("factory_account", `The ${RUNTIME_ACCOUNT} account does not exist`)
          : passed("factory_account", `The ${RUNTIME_ACCOUNT} account exists`);
      const [toolchain, workspace, agents, plugins, tailscaled, states] = await Promise.all([
        check.toolchain(),
        check.workspace(uid),
        check.agents(),
        check.plugins(),
        check.tailscaled(),
        Promise.all(ENROLLMENTS.map(({ id }) => check.enrollment(id))),
      ]);
      return {
        protocol_version: 1,
        hostname,
        verified_at: system.now().toISOString(),
        checks: [account, toolchain, workspace, agents, plugins, tailscaled],
        enrollment: ENROLLMENTS.map(({ id }, index) => ({
          id,
          state: states[index] ?? "unknown",
        })),
      };
    },
  };
}
