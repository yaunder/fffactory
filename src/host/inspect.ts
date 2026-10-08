/**
 * The worker side of `host inspect`: what this worker has installed and how its base looks,
 * read unprivileged as `fffactory-admin` from nothing but its own filesystem and systemd
 * (`docs/specs/host-protocol.md` §inspect). It changes nothing.
 */
import { readFile, readlink, stat, statfs } from "node:fs/promises";
import { hostname, machine } from "node:os";
import { dirname, join } from "node:path";
import {
  type ConfigurationState,
  HOST_PROTOCOL_VERSION,
  type HostInspection,
  type ReleaseState,
  SERVICE_STATES,
  type ServiceObservation,
  type ServiceState,
  WORKER_PATHS,
  WORKER_SERVICES,
} from "../domain/host-protocol";
import { type Installation, installationOf, parseHostApply } from "../domain/installation";
import { MATERIALIZED_MARKER } from "../domain/release-assets";
import { bunProcessRunner, type ProcessRunner } from "../infrastructure/local-tool-probe";
import { sha256Hex } from "../infrastructure/release-tarball";

/** What inspection reads the worker through; tests replace each part. */
export interface WorkerSystem {
  /** `/` on a worker; tests pass a directory holding the same paths. */
  readonly root: string;
  readonly run: ProcessRunner;
  readonly hostname: () => string;
  /** The machine hardware name, as `uname -m` prints it. */
  readonly machine: () => string;
  /** Bytes available to unprivileged users on the filesystem holding `path`. */
  readonly availableBytes: (path: string) => Promise<number>;
}

export interface HostInspector {
  inspect(): Promise<HostInspection>;
}

/** The worker this executable runs on. */
export function localWorkerSystem(): WorkerSystem {
  return {
    root: "/",
    run: bunProcessRunner,
    hostname,
    machine,
    availableBytes: async (path) => {
      const { bavail, bsize } = await statfs(path);
      return bavail * bsize;
    },
  };
}

const TOKEN = /^[A-Za-z0-9._-]{1,253}$/;
const RELEASE_LINK = /^releases\/(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SERVICE_TIMEOUT_MS = 5000;
/** systemctl's fixed environment: the system's own tools, untranslated output. */
const SYSTEM_ENVIRONMENT = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" };

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export function tokenOr(value: string, fallback: string): string {
  return TOKEN.test(value) ? value : fallback;
}

/** The release digest the marker at `path` records for `version`, if it records that version. */
export async function markerRecords(path: string, version: string): Promise<string | undefined> {
  try {
    const marker: unknown = JSON.parse(await readFile(path, "utf8"));
    const { release, sha256 } = (marker ?? {}) as Record<string, unknown>;
    return release === version && typeof sha256 === "string" && SHA256.test(sha256)
      ? sha256
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `current` must be the link `releases/<version>` to a release whose marker records that
 * version; anything else is a damaged activation.
 */
async function activeRelease(root: string): Promise<ReleaseState> {
  let target: string;
  try {
    target = await readlink(join(root, WORKER_PATHS.activeRelease));
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { state: "none" } : { state: "broken" };
  }
  const version = RELEASE_LINK.exec(target)?.[1];
  if (version === undefined) return { state: "broken" };
  const marker = join(root, WORKER_PATHS.releases, version, MATERIALIZED_MARKER);
  const sha256 = await markerRecords(marker, version);
  return sha256 === undefined ? { state: "broken" } : { state: "active", version, sha256 };
}

async function configuration(root: string): Promise<ConfigurationState> {
  try {
    const bytes = await readFile(join(root, WORKER_PATHS.configuration));
    return { state: "present", sha256: sha256Hex(bytes) };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { state: "none" } : { state: "unreadable" };
  }
}

/** The last install's record: none, one that cannot be read as a record, or its summary. */
async function installation(root: string): Promise<Installation> {
  let text: string;
  try {
    text = await readFile(join(root, WORKER_PATHS.lastApply), "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { state: "none" } : { state: "unreadable" };
  }
  const parsed = parseHostApply(text);
  if (!parsed.ok || parsed.document.state === "refused") return { state: "unreadable" };
  return installationOf(parsed.document);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** One `KEY=value` line's value, unquoted. */
function osReleaseValue(text: string, key: string): string | undefined {
  const line = text.split("\n").find((entry) => entry.startsWith(`${key}=`));
  return line?.slice(key.length + 1).replace(/^(["'])(.*)\1$/, "$2");
}

/** `ID` and `VERSION_ID` from the worker's os-release, or null when either cannot be read. */
export async function operatingSystem(root: string): Promise<HostInspection["evidence"]["os"]> {
  let text: string;
  try {
    text = await readFile(join(root, "etc/os-release"), "utf8");
  } catch {
    return null;
  }
  const id = osReleaseValue(text, "ID") ?? "";
  const versionId = osReleaseValue(text, "VERSION_ID") ?? "";
  return TOKEN.test(id) && TOKEN.test(versionId) ? { id, version_id: versionId } : null;
}

/**
 * Free space on the filesystem that holds the releases directory, or will: before bootstrap
 * creates it, its nearest existing parent's.
 */
async function available(system: WorkerSystem): Promise<number | null> {
  for (let path = join(system.root, WORKER_PATHS.releases); ; path = dirname(path)) {
    try {
      const bytes = await system.availableBytes(path);
      return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || path === dirname(path)) return null;
    }
  }
}

async function service(run: ProcessRunner, name: string): Promise<ServiceObservation> {
  const outcome = await run(["systemctl", "is-active", `${name}.service`], SERVICE_TIMEOUT_MS, {
    env: SYSTEM_ENVIRONMENT,
  });
  // `is-active` exits non-zero for every state but active, and prints the state either way.
  const printed = outcome.kind === "exited" ? outcome.stdout.trim() : "";
  const state = SERVICE_STATES.includes(printed as ServiceState)
    ? (printed as ServiceState)
    : "unknown";
  return { name, state };
}

/** Inspects the worker `system` describes. Never throws for what it cannot read. */
export function workerInspector(system: WorkerSystem): HostInspector {
  return {
    async inspect() {
      const { root } = system;
      const [release, config, installed, bootstrapComplete, os, availableBytes, services] =
        await Promise.all([
          activeRelease(root),
          configuration(root),
          installation(root),
          exists(join(root, WORKER_PATHS.bootstrapComplete)),
          operatingSystem(root),
          available(system),
          Promise.all(WORKER_SERVICES.map((name) => service(system.run, name))),
        ]);
      return {
        protocol_version: HOST_PROTOCOL_VERSION,
        hostname: tokenOr(system.hostname(), "unknown"),
        release,
        configuration: config,
        installation: installed,
        services,
        evidence: {
          bootstrap_complete: bootstrapComplete,
          os,
          architecture: tokenOr(system.machine(), "unknown"),
          available_bytes: availableBytes,
        },
      };
    },
  };
}
