/**
 * The host protocol: what the operator's fffactory and the worker's `fffactory host`
 * subcommands exchange over SSH (`docs/specs/host-protocol.md`). The worker side produces
 * these documents and the CLI side parses them with the same types, so a contract test runs
 * one set of fixtures through both sides.
 */
import { type Installation, installationFields, readInstallation } from "./installation";
import {
  type DocumentParse,
  type Fields,
  HOST_PROTOCOL_VERSION,
  Invalid,
  parseVersioned,
  RELEASE_VERSION,
  record,
  sha256,
  string,
  TOKEN,
} from "./protocol-fields";

export { HOST_PROTOCOL_VERSION } from "./protocol-fields";

/** Where a worker keeps what the protocol reports. Bootstrap creates the directories. */
export const WORKER_PATHS = {
  /** One directory per activated release (`docs/specs/worker-bootstrap.md`). */
  releases: "/opt/fffactory/releases",
  /** Symbolic link `releases/<version>` to the active release; `host apply` writes it. */
  activeRelease: "/opt/fffactory/current",
  /** Worker state outside releases. */
  state: "/var/lib/fffactory",
  /** Written last by a finished bootstrap. */
  bootstrapComplete: "/var/lib/fffactory/bootstrap-complete",
  /** The host's non-secret projection of factory.json, written by `host apply`. */
  configuration: "/var/lib/fffactory/host.json",
  /** `host apply`'s record of the last install, written as each step ends. */
  lastApply: "/var/lib/fffactory/last-apply.json",
  /** The repository stage's current per-host manifest. */
  repositoryManifest: "/var/lib/fffactory/repositories.json",
  /** The repository stage's last completed observation. */
  repositoryResult: "/var/lib/fffactory/repositories-result.json",
  /**
   * The install lock `host apply` holds while it installs, so installs never overlap on one
   * worker (`host/install-lock.ts`); root's alone, under `/run`, so a reboot clears it.
   */
  applyLock: "/run/fffactory-host-apply.lock",
  /** Each install step's output, `<step>.log`, from the last install that ran it. */
  logs: "/var/log/fffactory",
  /** The root activator bootstrap installs (`docs/specs/worker-bootstrap.md`). */
  activator: "/usr/local/libexec/fffactory-activate",
  /** Where apply uploads the release tarball, in `fffactory-admin`'s private home. */
  upload: "/home/fffactory-admin/fffactory-release.tar.gz",
} as const;

/** The account the CLI logs in to a worker as. */
export const WORKER_ADMIN = "fffactory-admin";

/** The services a worker reports, in this order. */
export const WORKER_SERVICES = ["tailscaled"] as const;

/** The states `systemctl is-active` prints; anything else is reported as `unknown`. */
export const SERVICE_STATES = [
  "active",
  "reloading",
  "refreshing",
  "inactive",
  "failed",
  "activating",
  "deactivating",
  "maintenance",
  "unknown",
] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/** The active release: none yet, one whose marker records it, or a link that is damaged. */
export type ReleaseState =
  | { readonly state: "none" }
  | { readonly state: "active"; readonly version: string; readonly sha256: string }
  | { readonly state: "broken" };

/** The host's configuration: none yet, its SHA-256, or a file `fffactory-admin` cannot read. */
export type ConfigurationState =
  | { readonly state: "none" }
  | { readonly state: "present"; readonly sha256: string }
  | { readonly state: "unreadable" };

export interface ServiceObservation {
  readonly name: string;
  readonly state: ServiceState;
}

/** What the worker observed about its base, for the CLI's readiness rules. */
export interface ReadinessEvidence {
  readonly bootstrap_complete: boolean;
  /** `ID` and `VERSION_ID` from `/etc/os-release`, or null when it cannot be read. */
  readonly os: { readonly id: string; readonly version_id: string } | null;
  /** The machine hardware name, as `uname -m` prints it. */
  readonly architecture: string;
  /**
   * Bytes available to unprivileged users on the filesystem of the releases directory (or,
   * before it exists, its nearest parent), or null when that cannot be measured.
   */
  readonly available_bytes: number | null;
}

/** `fffactory host inspect --json`'s document. */
export interface HostInspection {
  readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
  readonly hostname: string;
  readonly release: ReleaseState;
  readonly configuration: ConfigurationState;
  /** The last install's record, as `host apply` kept it. */
  readonly installation: Installation;
  readonly services: readonly ServiceObservation[];
  readonly evidence: ReadinessEvidence;
}

function releaseJson(release: ReleaseState) {
  return release.state === "active"
    ? { state: release.state, version: release.version, sha256: release.sha256 }
    : { state: release.state };
}

function configurationJson(configuration: ConfigurationState) {
  return configuration.state === "present"
    ? { state: configuration.state, sha256: configuration.sha256 }
    : { state: configuration.state };
}

/** The document as the worker prints it: keys in a fixed order, two-space indented. */
export function hostInspectionJson(inspection: HostInspection): string {
  const { evidence } = inspection;
  return JSON.stringify(
    {
      protocol_version: inspection.protocol_version,
      hostname: inspection.hostname,
      release: releaseJson(inspection.release),
      configuration: configurationJson(inspection.configuration),
      installation: installationFields(inspection.installation),
      services: inspection.services.map(({ name, state }) => ({ name, state })),
      evidence: {
        bootstrap_complete: evidence.bootstrap_complete,
        os:
          evidence.os === null ? null : { id: evidence.os.id, version_id: evidence.os.version_id },
        architecture: evidence.architecture,
        available_bytes: evidence.available_bytes,
      },
    },
    null,
    2,
  );
}

/** Why a document could not be read. Never quotes the document. */
export type InspectionParse =
  | { readonly ok: true; readonly inspection: HostInspection }
  | Exclude<DocumentParse<HostInspection>, { readonly ok: true }>;

const SERVICE_NAME = /^[a-z0-9@._-]{1,64}$/;

function parseRelease(value: unknown): ReleaseState {
  const release = record(value, "release");
  switch (release.state) {
    case "none":
    case "broken":
      return { state: release.state };
    case "active":
      return {
        state: "active",
        version: string(release.version, "release.version", RELEASE_VERSION),
        sha256: sha256(release.sha256, "release.sha256"),
      };
    default:
      throw new Invalid("release.state is not a known state");
  }
}

function parseConfiguration(value: unknown): ConfigurationState {
  const configuration = record(value, "configuration");
  switch (configuration.state) {
    case "none":
    case "unreadable":
      return { state: configuration.state };
    case "present":
      return { state: "present", sha256: sha256(configuration.sha256, "configuration.sha256") };
    default:
      throw new Invalid("configuration.state is not a known state");
  }
}

function parseService(value: unknown, index: number): ServiceObservation {
  const service = record(value, `services[${index}]`);
  const state = service.state;
  if (!SERVICE_STATES.includes(state as ServiceState))
    throw new Invalid(`services[${index}].state is not a known state`);
  return {
    name: string(service.name, `services[${index}].name`, SERVICE_NAME),
    state: state as ServiceState,
  };
}

function parseServices(value: unknown): ServiceObservation[] {
  if (!Array.isArray(value)) throw new Invalid("services must be an array");
  return value.map(parseService);
}

function parseOs(value: unknown): ReadinessEvidence["os"] {
  if (value === null) return null;
  const os = record(value, "evidence.os");
  return {
    id: string(os.id, "evidence.os.id", TOKEN),
    version_id: string(os.version_id, "evidence.os.version_id", TOKEN),
  };
}

function parseAvailable(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Invalid("evidence.available_bytes must be a byte count or null");
  return value as number;
}

function parseEvidence(value: unknown): ReadinessEvidence {
  const evidence = record(value, "evidence");
  if (typeof evidence.bootstrap_complete !== "boolean")
    throw new Invalid("evidence.bootstrap_complete must be a boolean");
  return {
    bootstrap_complete: evidence.bootstrap_complete,
    os: parseOs(evidence.os),
    architecture: string(evidence.architecture, "evidence.architecture", TOKEN),
    available_bytes: parseAvailable(evidence.available_bytes),
  };
}

function parseDocument(document: Fields): HostInspection {
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname: string(document.hostname, "hostname", TOKEN),
    release: parseRelease(document.release),
    configuration: parseConfiguration(document.configuration),
    // A worker from before installs were recorded reports none.
    installation:
      document.installation === undefined
        ? { state: "none" }
        : readInstallation(document.installation),
    services: parseServices(document.services),
    evidence: parseEvidence(document.evidence),
  };
}

/**
 * Reads `host inspect --json` output on the CLI side. A document of another major version is
 * rejected before anything else is read; fields this version does not know are ignored.
 */
export function parseHostInspection(text: string): InspectionParse {
  const parsed = parseVersioned(text, parseDocument);
  return parsed.ok ? { ok: true, inspection: parsed.document } : parsed;
}

declare const commandBrand: unique symbol;

/**
 * A command to run on a worker: fixed tokens, each safe to pass through the remote login
 * shell unquoted, because OpenSSH joins them with spaces for that shell to run.
 */
export type RemoteCommand = readonly string[] & { readonly [commandBrand]: "RemoteCommand" };

/** Letters, digits and `_ / . = : @ % + , -`: nothing a POSIX shell treats specially. */
const SAFE_TOKEN = /^[A-Za-z0-9_/.=:@%+,-]+$/;

/** Builds a remote command, refusing any token a shell would interpret. */
export function remoteCommand(tokens: readonly string[]): RemoteCommand {
  if (tokens.length === 0) throw new Error("A remote command needs at least one token");
  for (const token of tokens)
    if (!SAFE_TOKEN.test(token)) throw new Error("A remote command token is not shell-safe");
  return Object.freeze([...tokens]) as unknown as RemoteCommand;
}

/** The active release's executable on a worker. */
export const WORKER_EXECUTABLE = `${WORKER_PATHS.activeRelease}/bin/fffactory`;

/** How the CLI asks a worker to inspect itself. */
export const INSPECT_COMMAND = remoteCommand([WORKER_EXECUTABLE, "host", "inspect", "--json"]);

/**
 * How apply uploads the release tarball: `dd` writes its standard input to the upload path,
 * replacing whatever was there. Nothing else runs; the activator verifies the copy.
 */
export const UPLOAD_COMMAND = remoteCommand([
  "dd",
  `of=${WORKER_PATHS.upload}`,
  "bs=1M",
  "status=none",
]);

/**
 * How apply installs the uploaded release: the activator, through its one sudoers entry,
 * checks the tarball against `sha256`, the digest the running executable embeds for it,
 * unpacks it and runs its `host apply` as root, which reads the host projection on
 * standard input.
 */
export function activateCommand(sha256Digest: string): RemoteCommand {
  return remoteCommand(["sudo", "-n", WORKER_PATHS.activator, WORKER_PATHS.upload, sha256Digest]);
}

/**
 * The exit status the worker's shell gives a command it cannot find: for `INSPECT_COMMAND`,
 * no active release. `fffactory` itself never exits with it.
 */
export const COMMAND_NOT_FOUND = 127;
