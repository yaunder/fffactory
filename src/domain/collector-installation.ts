/**
 * What the `collector` install step installs on a worker (`docs/specs/host-protocol.md` §The
 * collector step): the collector's configuration from the host projection, and its systemd
 * service and timer, which run `host collect --once` as `factory` about once a minute with no
 * tie to the execution backend, sandboxed and bounded, never reading its private files. Pure:
 * `host/collector-step.ts` writes them.
 */
import type { CollectorConfiguration } from "./collector";
import { collectorConfigurationJson } from "./collector";
import type { HostProjection } from "./host-projection";
import { WORKER_PATHS } from "./host-protocol";
import { RUNTIME_ACCOUNT } from "./readiness";
import { ARCHIVE_FORMAT, CLAUDE_ROOT } from "./archive-format";

/** The collector's state directory's name under `/var/lib`: the unit's `StateDirectory=`. */
export const COLLECTOR_STATE_DIRECTORY = "fffactory-collector";
/** The collector's state directory: its checkpoint and its lock, nothing else. */
export const COLLECTOR_STATE = `/var/lib/${COLLECTOR_STATE_DIRECTORY}`;

export const COLLECTOR_SERVICE = "fffactory-collector.service";
export const COLLECTOR_TIMER = "fffactory-collector.timer";
/** Where the step installs both units: systemd's directory for the administrator's units. */
const UNIT_DIRECTORY = "/etc/systemd/system";

/** Each `systemctl` command's deadline, within the step's own timeout. */
export const COLLECTOR_COMMAND_TIMEOUT_MS = 60_000;

/**
 * The service's resource limits. Provisional: peak RSS, thread count and run time of the worker
 * executable running once a minute are not measured yet.
 * TODO(re-evaluate when measured on Acceptance): set memoryHigh, memoryMax, timeoutStart and
 * tasksMax from the measured peak RSS, task count and run time, and cpuWeight from the agents'
 * contention (epic #117, task 7).
 */
export const COLLECTOR_LIMITS = {
  memoryHigh: "384M",
  memoryMax: "512M",
  cpuQuota: "50%",
  timeoutStart: "55s",
  tasksMax: "64",
  cpuWeight: "20",
} as const;

/**
 * How long systemd waits for a stopped run before killing it, and again for survivors of that
 * kill: twice it stays under the step's 60 s command deadline, so removing the collector's
 * `systemctl stop` never overruns it.
 */
export const COLLECTOR_STOP_TIMEOUT = "20s";

/**
 * `factory`'s credential stores, which the collector never reads: Claude's, the Anthropic key
 * credential delivery writes, GitHub's, Codex's, AWS's, SSH's and Git's.
 */
const CREDENTIAL_STORES = [
  `${CLAUDE_ROOT}/.credentials.json`,
  `${CLAUDE_ROOT}/.session_ingress_token`,
  "/home/factory/.claude.json",
  "/home/factory/.claude.json.backup",
  "/home/factory/.config/fffactory",
  "/home/factory/.config/gh",
  "/home/factory/.codex",
  "/home/factory/.aws",
  "/home/factory/.ssh",
  "/home/factory/.git-credentials",
] as const;

/**
 * What the collector never reads (`InaccessiblePaths=`, each optional): `factory`'s credential
 * stores, then the execution backend's private files (`privateFiles`, its layout's,
 * `docs/specs/execution-backend.md` §Layout). None is, or lies above, anything a run reads or
 * writes (`/etc/fffactory/collector.json`, the releases, its state, `~/.claude`'s collected
 * directories).
 */
export function collectorInaccessible(privateFiles: readonly string[]): readonly string[] {
  return [...CREDENTIAL_STORES, ...privateFiles];
}

/**
 * AWS settings the service manager could pass the collector, removed from its environment
 * (`UnsetEnvironment=`): an endpoint, instance metadata's, a profile, or keys would redirect
 * or break the SDK's calls. The unit's own `Environment=` settings are not among them, since
 * unsetting a name also drops the unit's assignment of it.
 */
export const INHERITED_AWS_SETTINGS = [
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_EC2_METADATA_V1_DISABLED",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL_STS",
  "AWS_USE_FIPS_ENDPOINT",
  "AWS_USE_DUALSTACK_ENDPOINT",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
] as const;

/**
 * One collection run, as `factory`, from the active release, so an upgrade needs no restart,
 * never reading the backend's `privateFiles` (`collectorInaccessible`). `factory`'s `~/.aws` is
 * the agents' to write, so the SDK reads neither its config nor its credentials file and ignores
 * configured endpoints; nothing in the unit ties it to the execution backend's units, such as
 * Paseo's, whose `KillMode=control-group` would otherwise reach it. No `[Install]`: the timer
 * starts it.
 */
export function collectorServiceUnit(privateFiles: readonly string[]): string {
  return `[Unit]
Description=fffactory log archive collector: one collection run

[Service]
Type=oneshot
User=${RUNTIME_ACCOUNT}
Group=${RUNTIME_ACCOUNT}
ExecStart=${WORKER_PATHS.activeRelease}/bin/fffactory host collect --once
StateDirectory=${COLLECTOR_STATE_DIRECTORY}
StateDirectoryMode=0700
Environment=AWS_CONFIG_FILE=/dev/null
Environment=AWS_SHARED_CREDENTIALS_FILE=/dev/null
Environment=AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true
UnsetEnvironment=${INHERITED_AWS_SETTINGS.join(" ")}
ProtectSystem=strict
ProtectHome=read-only
NoNewPrivileges=true
PrivateTmp=true
${collectorInaccessible(privateFiles)
  .map((path) => `InaccessiblePaths=-${path}`)
  .join("\n")}
MemoryHigh=${COLLECTOR_LIMITS.memoryHigh}
MemoryMax=${COLLECTOR_LIMITS.memoryMax}
CPUQuota=${COLLECTOR_LIMITS.cpuQuota}
CPUWeight=${COLLECTOR_LIMITS.cpuWeight}
TasksMax=${COLLECTOR_LIMITS.tasksMax}
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=${COLLECTOR_LIMITS.timeoutStart}
TimeoutStopSec=${COLLECTOR_STOP_TIMEOUT}
`;
}

/** About once a minute: a minute after boot, then a minute after each run ends, never overlapping. */
export const COLLECTOR_TIMER_UNIT = `[Unit]
Description=Run the fffactory log archive collector about once a minute

[Timer]
OnBootSec=60s
OnUnitInactiveSec=60s
AccuracySec=5s
Unit=${COLLECTOR_SERVICE}

[Install]
WantedBy=timers.target
`;

/** One unit file the step writes: where, and its text. */
export interface CollectorUnit {
  readonly path: string;
  readonly text: string;
}

/** The collector's units, as the step writes them, the service first. */
export type CollectorUnits = readonly [service: CollectorUnit, timer: CollectorUnit];

/** The collector's units, never reading the backend's `privateFiles`. */
export function collectorUnits(privateFiles: readonly string[]): CollectorUnits {
  return [
    { path: `${UNIT_DIRECTORY}/${COLLECTOR_SERVICE}`, text: collectorServiceUnit(privateFiles) },
    { path: `${UNIT_DIRECTORY}/${COLLECTOR_TIMER}`, text: COLLECTOR_TIMER_UNIT },
  ];
}

/** The collector's configuration for the projection's worker, or undefined without the archive. */
export function collectorConfigurationOf(
  projection: Pick<HostProjection, "factory_id" | "host_key" | "log_archive">,
): CollectorConfiguration | undefined {
  const archive = projection.log_archive;
  if (archive === undefined) return undefined;
  return {
    format: ARCHIVE_FORMAT,
    factory_id: projection.factory_id,
    host_key: projection.host_key,
    bucket: archive.bucket,
    region: archive.region,
  };
}

/** `/etc/fffactory/collector.json`'s text: the configuration with one final newline. */
export function collectorConfigurationText(configuration: CollectorConfiguration): string {
  return `${collectorConfigurationJson(configuration)}\n`;
}
