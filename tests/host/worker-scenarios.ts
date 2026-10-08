/**
 * Worker filesystems for the host protocol's contract test: each scenario lays out, under a
 * temporary root, the paths a worker's `host inspect` reads, and names the fixture its
 * document must equal byte for byte.
 */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import { WORKER_PATHS } from "../../src/domain/host-protocol";
import {
  type HostApplyRecord,
  hostApplyJson,
  INSTALL_STEPS,
  pendingSteps,
  withStep,
} from "../../src/domain/installation";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import { ENROLLMENTS } from "../../src/domain/readiness";
import { MATERIALIZED_MARKER } from "../../src/domain/release-assets";
import type { ApplySystem } from "../../src/host/apply";
import type { WorkerSystem } from "../../src/host/inspect";
import { flockExclusive } from "../../src/host/install-lock";
import { AS_FACTORY } from "../../src/host/verify";
import type { ProcessOutcome, ProcessRunner } from "../../src/infrastructure/local-tool-probe";

export const WORKER_HOSTNAME = "fff-aaaa1111-builder-1";
export const RELEASE_SHA256 = "c".repeat(64);
/** The host configuration apply sends builder-1 of fff-aaaa1111 on release 0.3.0. */
export const HOST_CONFIGURATION = hostProjectionJson(
  hostProjection("fff-aaaa1111" as FactoryId, "builder-1" as HostKey, "0.3.0" as Release),
);
/** Its SHA-256. */
export const HOST_CONFIGURATION_SHA256 =
  "ccdb230958f50d92a2a4e6d78269d2ad19f497226569f8fba095890825c7d857";

/** The record `host apply` keeps after installing 0.3.0: verified, every account pending. */
export function lastApply(overrides: Partial<HostApplyRecord> = {}): HostApplyRecord {
  const steps = INSTALL_STEPS.reduce(
    (results, { name }) => withStep(results, name, "succeeded"),
    pendingSteps(),
  );
  return {
    protocol_version: 1,
    hostname: WORKER_HOSTNAME,
    state: "succeeded",
    release: "0.3.0",
    configuration_sha256: HOST_CONFIGURATION_SHA256,
    started_at: "2026-09-30T12:00:00.000Z",
    finished_at: "2026-09-30T12:09:00.000Z",
    steps,
    verification: {
      protocol_version: 1,
      hostname: WORKER_HOSTNAME,
      verified_at: "2026-09-30T12:09:00.000Z",
      checks: [
        { id: "toolchain", status: "passed", summary: "Every development tool runs" },
        { id: "agents", status: "passed", summary: "Codex and Claude Code match their pins" },
      ],
      enrollment: ENROLLMENTS.map(({ id }) => ({ id, state: "pending" })),
    },
    failure: null,
    ...overrides,
  };
}
const AMAZON_LINUX = 'NAME="Amazon Linux"\nVERSION="2023"\nID="amzn"\nVERSION_ID="2023"\n';

function at(root: string, path: string): string {
  return join(root, path);
}

async function file(root: string, path: string, contents: string): Promise<void> {
  await mkdir(join(at(root, path), ".."), { recursive: true });
  await writeFile(at(root, path), contents);
}

/** Bootstrap's directories and marker, and Amazon Linux's os-release. */
async function bootstrapped(root: string): Promise<void> {
  await mkdir(at(root, WORKER_PATHS.releases), { recursive: true });
  await file(root, WORKER_PATHS.bootstrapComplete, "");
  await file(root, "/etc/os-release", AMAZON_LINUX);
}

/** A release activated as `host apply` leaves it: the directory, its marker and the link. */
export async function activate(root: string, version: string, sha256 = RELEASE_SHA256) {
  const directory = join(WORKER_PATHS.releases, version);
  await file(root, join(directory, "bin/fffactory"), "#!/bin/sh\n");
  await file(
    root,
    join(directory, MATERIALIZED_MARKER),
    `${JSON.stringify({ release: version, sha256 }, null, 2)}\n`,
  );
  await symlink(`releases/${version}`, at(root, WORKER_PATHS.activeRelease));
}

/** `systemctl is-active` printing `state` for every service. */
export function systemctl(state: string): ProcessRunner {
  return async (argv) => {
    if (argv[0] !== "systemctl" || argv[1] !== "is-active") throw new Error("unexpected command");
    return {
      kind: "exited",
      exitCode: state === "active" ? 0 : 3,
      stdout: `${state}\n`,
      stderr: "",
    };
  };
}

export function system(root: string, overrides: Partial<WorkerSystem> = {}): WorkerSystem {
  return {
    root,
    run: systemctl("active"),
    hostname: () => WORKER_HOSTNAME,
    machine: () => "x86_64",
    availableBytes: async () => 20 * 1024 ** 3,
    ...overrides,
  };
}

export interface Scenario {
  readonly fixture: string;
  readonly description: string;
  /** Lays the worker out under `root` and returns how inspection reads it. */
  readonly build: (root: string) => Promise<WorkerSystem>;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    fixture: "inspect-ready.json",
    description: "an installed worker on release 0.3.0 with its configuration",
    build: async (root) => {
      await bootstrapped(root);
      await activate(root, "0.3.0");
      await file(root, WORKER_PATHS.configuration, HOST_CONFIGURATION);
      await file(root, WORKER_PATHS.lastApply, hostApplyJson(lastApply()));
      return system(root);
    },
  },
  {
    fixture: "inspect-failed-install.json",
    description: "a worker whose install of release 0.3.0 failed at its harness step",
    build: async (root) => {
      await bootstrapped(root);
      await activate(root, "0.3.0");
      await file(root, WORKER_PATHS.configuration, HOST_CONFIGURATION);
      const steps = withStep(
        ["packages", "user", "systemd"].reduce(
          (results, name) => withStep(results, name, "succeeded"),
          pendingSteps(),
        ),
        "harness",
        "failed",
        "exited with status 1",
      );
      await file(
        root,
        WORKER_PATHS.lastApply,
        hostApplyJson(lastApply({ state: "failed", steps, verification: null })),
      );
      return system(root);
    },
  },
  {
    fixture: "inspect-no-release.json",
    description: "a freshly bootstrapped worker: no release and no configuration yet",
    build: async (root) => {
      await bootstrapped(root);
      return system(root);
    },
  },
  {
    fixture: "inspect-damaged.json",
    description:
      "a damaged worker: a link to a missing release, an unreadable configuration, no " +
      "os-release, an unfinished bootstrap, unknown free space and a failed service",
    build: async (root) => {
      await mkdir(at(root, WORKER_PATHS.releases), { recursive: true });
      await symlink("releases/9.9.9", at(root, WORKER_PATHS.activeRelease));
      // A directory where the file should be cannot be read as one.
      await mkdir(at(root, WORKER_PATHS.configuration), { recursive: true });
      await file(root, WORKER_PATHS.lastApply, "{ interrupted mid-write");
      return system(root, {
        run: systemctl("failed"),
        availableBytes: async () => {
          throw new Error("statfs failed");
        },
      });
    },
  },
];

/** When the contract's installs start, run and end. */
export const APPLIED_AT = new Date("2026-09-30T12:09:00.000Z");

const exited = (exitCode: number, stdout = ""): ProcessOutcome => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr: "",
});

/**
 * A worker's tools as the install steps leave them, by command (run as factory or as root):
 * everything runs at its pin, and factory has enrolled GitHub only. Each install step exits
 * 0, or 1 when it is named in `failing`.
 */
export function installedTools(failing: readonly string[] = []): ProcessRunner {
  const uid = process.getuid?.() ?? 1000;
  const answers: Record<string, ProcessOutcome> = {
    "id -u factory": exited(0, `${uid}\n`),
    "node --version": exited(0, "v22.12.0\n"),
    "codex --version": exited(0, "codex-cli 0.156.1\n"),
    "claude --version": exited(0, "2.1.280 (Claude Code)\n"),
    "systemctl is-active tailscaled.service": exited(0, "active\n"),
    "gh auth status --hostname github.com": exited(0, "Logged in to github.com\n"),
    "codex login status": exited(1, "Not logged in\n"),
    "claude auth status": exited(1, "Not logged in\n"),
  };
  return async (argv) => {
    const command = commandOf(argv);
    const step = /^bash (\w+)\.sh$/.exec(command)?.[1];
    if (step !== undefined) return exited(failing.includes(step) ? 1 : 0);
    return answers[command] ?? exited(0);
  };
}

/** A command as the tests name it: without `AS_FACTORY`'s prefix or any directories. */
function commandOf(argv: readonly string[]): string {
  const asFactory = AS_FACTORY.every((token, index) => argv[index] === token);
  return (asFactory ? argv.slice(AS_FACTORY.length) : argv)
    .map((token) => token.split("/").at(-1))
    .join(" ");
}

/**
 * A bootstrapped worker with release 0.3.0 unpacked by the activator but not yet active, its
 * pins, and the runtime account's workspace: what `host apply` finds.
 */
export async function unpackedWorker(root: string): Promise<void> {
  await bootstrapped(root);
  await activate(root, "0.3.0");
  await rm(at(root, WORKER_PATHS.activeRelease));
  await file(
    root,
    join(WORKER_PATHS.releases, "0.3.0", "steps/versions.env"),
    "CODEX_VERSION=0.156.1\nCLAUDE_CODE_VERSION=2.1.280\n",
  );
  for (const directory of ["/workspace/repos", "/workspace/cache", "/run"])
    await mkdir(at(root, directory), { recursive: true });
}

/** `host apply`'s view of the worker under `root`, sent builder-1's configuration. */
export function applyingSystem(root: string, run: ProcessRunner): ApplySystem {
  return {
    ...system(root, { run }),
    now: () => APPLIED_AT,
    isRoot: () => true,
    readInput: async () => HOST_CONFIGURATION,
    release: "0.3.0" as Release,
    lock: flockExclusive,
  };
}
