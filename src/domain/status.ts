/**
 * `fffactory status`'s rules: what the EC2 inventory, the operator's tailnet view and each
 * worker's own inspection say about every declared host, the next action for anything not
 * ready, and the report's status. Pure: `application/status.ts` makes the observations.
 */
import { type CheckResult, type CheckStatus, failed, ready, worstStatus } from "./check-result";
import {
  HOST_PROTOCOL_VERSION,
  type HostInspection,
  INSPECT_COMMAND,
  WORKER_ADMIN,
  WORKER_PATHS,
} from "./host-protocol";
import { ACTIVATION_TIMEOUT_MS, type RecordedInstallation } from "./installation";
import type { HostKey } from "./instance";
import type { DispatchGate } from "./dispatch-readiness";
import { tailscaleCheck } from "./local-tooling";
import {
  type EnrollmentReport,
  enrollmentReport,
  pendingEnrollment,
  pendingEnrollmentLines,
  RUNTIME_ACCOUNT,
  type Verification,
} from "./readiness";
import { type PeerView, resolveWorker, type WorkerAddress } from "./tailnet";

/** EC2 states of an instance that is not terminated. */
export type MachineState = "pending" | "running" | "stopping" | "stopped" | "shutting-down";

/** One factory-tagged EC2 instance. */
export interface Machine {
  readonly instanceId: string;
  readonly state: MachineState;
  /** Its `fffactory:host-key` tag, when it has one. */
  readonly hostKey: string | undefined;
}

/** What listing the factory's EC2 instances showed. */
export type MachineInventory =
  | { readonly kind: "machines"; readonly machines: readonly Machine[] }
  /** The listing failed; `reason` names the error, never quoting AWS. */
  | { readonly kind: "unavailable"; readonly reason: string };

/** What inspecting one worker over SSH showed, from the CLI's side. */
export type WorkerInspection =
  | { readonly kind: "inspected"; readonly inspection: HostInspection }
  /** The worker has no active release to run `host inspect` with. */
  | { readonly kind: "no_release" }
  /** SSH could not connect, or the connection dropped or timed out. */
  | { readonly kind: "unreachable"; readonly reason: string }
  /** Tailnet SSH policy refused the login as `fffactory-admin`. */
  | { readonly kind: "access_denied" }
  /** The worker's host key is not one the tailnet lists for it. */
  | { readonly kind: "host_key_mismatch" }
  /** `ssh` is not on PATH. */
  | { readonly kind: "client_missing" }
  | { readonly kind: "unsupported_protocol"; readonly version: number }
  /** Anything else: a failed start, an unexpected exit status or an unreadable document. */
  | { readonly kind: "failed"; readonly reason: string };

export type MachineFact = MachineState | "absent" | "duplicate" | "unknown";
export type TailnetFact =
  | "online"
  | "offline"
  | "missing"
  | "duplicate"
  | "untagged"
  | "no_ssh"
  | "unknown"
  | "not_checked";

/** What status observed about a worker, whether or not it is ready. */
export interface WorkerFacts {
  readonly machine: MachineFact;
  readonly instanceId: string | null;
  readonly tailnet: TailnetFact;
  /** The active release's version, or `none`, `broken` or `unknown` (not inspected). */
  readonly release: string;
  /** The host configuration's SHA-256, or `none`, `unreadable` or `unknown`. */
  readonly configuration: string;
  /**
   * The last install's state (`running`, `succeeded`, `failed`), or `none`, `unreadable` or
   * `unknown` (not inspected).
   */
  readonly installation: string;
  /**
   * Each account's enrollment as the last install's verification found it, with the steps the
   * CLI names for it, or null.
   */
  readonly enrollment: readonly EnrollmentReport[] | null;
}

/** A worker's result: `CheckResult`'s status, summary, details and next action, and facts. */
export interface Verdict {
  readonly status: CheckStatus;
  readonly summary: string;
  readonly details: readonly string[];
  readonly nextAction: string | null;
}

export interface WorkerStatus extends WorkerFacts, Verdict {
  readonly key: HostKey;
  readonly hostname: string;
  /** Last repository reconciliation, or `unknown` when it could not be observed. */
  readonly repositories: "synchronized" | "unresolved" | "none" | "unreadable" | "unknown";
  /** Checkout paths no longer placed on the worker; null when not observable. */
  readonly unmanagedRepositories: readonly string[] | null;
  /** The actual persisted-and-checked dispatch state, never the requested flag. */
  readonly dispatch:
    | "active"
    | "pending"
    | "not_requested"
    | "failed"
    | "none"
    | "unreadable"
    | "unknown";
  readonly dispatchBlockers: readonly DispatchGate[] | null;
}

export interface StatusReport {
  readonly status: CheckStatus;
  /** The EC2 and tailnet inventories, as checks. */
  readonly inventories: readonly CheckResult[];
  readonly workers: readonly WorkerStatus[];
}

/** Workers run only this base. */
export const SUPPORTED_BASE = { osId: "amzn", osVersionId: "2023", architecture: "x86_64" };
/** Room for a release tarball, its unpacked copy and a previous release. */
export const MIN_AVAILABLE_BYTES = 2 * 1024 ** 3;

/** Completes a next action with the command to rerun once it is done. */
export type Then = (action: string) => string;

/** Completes a next action: every one of status's ends by asking the operator to rerun it. */
export function thenRerunStatus(action: string): string {
  return `${action}, then rerun \`fffactory status\`.`;
}

/** Completes a next action of apply's: rerunning it converges what remains. */
export function thenRerunApply(action: string): string {
  return `${action}, then rerun \`fffactory apply\`.`;
}

/** Completes enrollment's next action: apply verifies the enrollment, status then shows it. */
function thenVerifyEnrollment(action: string): string {
  return `${action}, then verify the enrollment with \`fffactory apply\` and rerun \`fffactory status\`.`;
}

function notReadyVerdict(
  summary: string,
  action: string,
  details: string[] = [],
  then: Then = thenRerunStatus,
): Verdict {
  return { status: "not_ready", summary, details, nextAction: then(action) };
}

function errorVerdict(summary: string, action: string, then: Then = thenRerunStatus): Verdict {
  return { status: "error", summary, details: [], nextAction: then(action) };
}

export const EC2_INVENTORY_CHECK = { id: "ec2_instances", title: "EC2 instances" } as const;

export function ec2InventoryCheck(inventory: MachineInventory): CheckResult {
  if (inventory.kind === "unavailable")
    return failed(
      EC2_INVENTORY_CHECK,
      inventory.reason,
      thenRerunStatus(
        "Check your network connection and that the credentials may call ec2:DescribeInstances",
      ),
    );
  const count = inventory.machines.length;
  return ready(
    EC2_INVENTORY_CHECK,
    `${count} ${count === 1 ? "instance carries" : "instances carry"} the factory ID`,
  );
}

/** The local Tailscale client, reported as doctor reports it. */
export function tailnetCheck(view: PeerView): CheckResult {
  switch (view.kind) {
    case "peers": {
      const count = view.peers.length;
      return ready(
        { id: "tailscale", title: "Tailscale client" },
        `Logged in and running; ${count} ${count === 1 ? "device" : "devices"} visible`,
      );
    }
    case "not_running":
      return tailscaleCheck({ kind: "backend", backendState: view.backendState });
    default:
      return tailscaleCheck(view);
  }
}

export interface MachineFacts {
  readonly machine: MachineFact;
  readonly instanceId: string | null;
  readonly instanceIds: readonly string[];
}

/** The instance carrying `key` in the inventory. */
export function machineFacts(inventory: MachineInventory, key: HostKey): MachineFacts {
  if (inventory.kind === "unavailable")
    return { machine: "unknown", instanceId: null, instanceIds: [] };
  const machines = inventory.machines.filter((machine) => machine.hostKey === key);
  const instanceIds = machines.map((machine) => machine.instanceId);
  const [only] = machines;
  if (only === undefined) return { machine: "absent", instanceId: null, instanceIds };
  if (machines.length > 1) return { machine: "duplicate", instanceId: null, instanceIds };
  return { machine: only.state, instanceId: only.instanceId, instanceIds };
}

/** Why the machine cannot be inspected, or undefined when status goes on to the tailnet. */
export function machineVerdict(facts: MachineFacts): Verdict | undefined {
  const { machine, instanceId, instanceIds } = facts;
  switch (machine) {
    case "absent":
      return notReadyVerdict(
        "Not provisioned: no EC2 instance carries this host key",
        "Provision it with `fffactory apply`",
      );
    case "duplicate":
      return notReadyVerdict(
        `${instanceIds.length} EC2 instances carry this host key`,
        "Find the instance that is not this worker in the EC2 console and remove it yourself; " +
          "fffactory never guesses which is which",
        instanceIds.map((id) => `Instance: ${id}`),
      );
    case "stopped":
      return notReadyVerdict(
        `EC2 instance ${instanceId} is stopped`,
        `Start instance ${instanceId} in the EC2 console`,
      );
    case "stopping":
    case "shutting-down":
      return notReadyVerdict(
        `EC2 instance ${instanceId} is ${machine}`,
        `Check instance ${instanceId} in the EC2 console`,
      );
    default:
      return undefined;
  }
}

/** Where tailnet devices are checked and removed. */
export const ADMIN_CONSOLE = "https://login.tailscale.com/admin/machines";

/** Where the worker is in the tailnet, or why it cannot be reached there. */
export type TailnetLocation =
  | { readonly kind: "found"; readonly worker: WorkerAddress }
  | { readonly kind: "blocked"; readonly tailnet: TailnetFact; readonly verdict: Verdict };

function notReadyAfter(summary: string, action: string, then: Then): Verdict {
  return notReadyVerdict(summary, action, [], then);
}

function blocked(tailnet: TailnetFact, verdict: Verdict): TailnetLocation {
  return { kind: "blocked", tailnet, verdict };
}

function unavailableView(
  view: Exclude<PeerView, { readonly kind: "peers" }>,
  then: Then,
): TailnetLocation {
  const verdict =
    view.kind === "unusable"
      ? errorVerdict("The Tailscale peer view could not be read", "Fix the Tailscale client", then)
      : notReadyVerdict(
          "The Tailscale peer view is unavailable",
          "Fix the Tailscale client",
          [],
          then,
        );
  return blocked("unknown", { ...verdict, details: ["See the Tailscale client check."] });
}

/**
 * Applies the hostname-match rule and the factory's `tag` to the operator's view, and says
 * why it refused, each next action completed by `then`. The tag is never echoed: its format
 * could hold a pasted secret.
 */
export function locateWorker(
  view: PeerView,
  hostname: string,
  tag: string,
  then: Then = thenRerunStatus,
): TailnetLocation {
  if (view.kind !== "peers") return unavailableView(view, then);
  const verdict = (summary: string, action: string) => notReadyAfter(summary, action, then);
  const resolution = resolveWorker(view.peers, hostname, tag);
  switch (resolution.kind) {
    case "found":
      return resolution;
    case "missing":
      // TODO(re-evaluate when host replacement lands in M3): offer guided replacement of a
      // worker whose bootstrap failed.
      // Bootstrap runs once, at first boot, so a failed one is recovered by terminating the
      // instance: refresh drops it from state and the next plan creates it, which D11 allows.
      return blocked(
        "missing",
        verdict(
          `No Tailscale device named ${hostname} is visible from this machine`,
          "If the worker has just started, wait for it to join the tailnet. Otherwise check " +
            "that tailnet policy lets this device see the factory's tag, and the bootstrap in " +
            "the instance's EC2 console output: if it failed, terminate the instance in the " +
            "EC2 console; once it is terminated, the next `fffactory apply` creates it again",
        ),
      );
    case "duplicate":
      return blocked(
        "duplicate",
        verdict(
          `${resolution.count} Tailscale devices are named ${hostname}; fffactory never guesses which is the worker`,
          `Remove the stale devices named ${hostname} at ${ADMIN_CONSOLE}, keeping the worker's`,
        ),
      );
    case "untagged":
      return blocked(
        "untagged",
        verdict(
          `The Tailscale device named ${hostname} does not carry the factory's tag (tailscale.tag in factory.json)`,
          `Check the tailnet at ${ADMIN_CONSOLE}: the device named ${hostname} must be this factory's worker and carry the factory's tag; remove it if it is not the worker`,
        ),
      );
    case "offline":
      return blocked(
        "offline",
        verdict(
          "Offline in the tailnet",
          "Check that the instance is running and that Tailscale is up on it",
        ),
      );
    case "no_ssh":
      return blocked(
        "no_ssh",
        verdict(
          "The tailnet lists no Tailscale SSH host key or address for this worker",
          `Make sure the worker runs Tailscale SSH (\`tailscale up --ssh\`) and that tailnet policy lets this device reach it; check ${hostname} at ${ADMIN_CONSOLE}`,
        ),
      );
  }
}

export interface Expectation {
  readonly hostname: string;
  /** The release factory.json pins. */
  readonly release: string;
  /** SHA-256 of the host projection apply would send it (`domain/host-projection.ts`). */
  readonly configurationSha256: string;
}

interface Finding {
  readonly summary: string;
  readonly action: string;
}

const APPLY_REPAIRS = "Repair the worker with `fffactory apply`";

function baseFindings(inspection: HostInspection, expected: Expectation): Finding[] {
  const { evidence } = inspection;
  const findings: Finding[] = [];
  if (inspection.hostname.toLowerCase() !== expected.hostname.toLowerCase())
    findings.push({
      summary: "The worker reports another hostname than its Tailscale name",
      action: `Check at ${ADMIN_CONSOLE} that the device ${expected.hostname} is this factory's worker`,
    });
  if (!evidence.bootstrap_complete)
    findings.push({
      summary: "Its bootstrap has not finished",
      action: "Wait for the first boot to finish, or check the instance's EC2 console output",
    });
  const { os, architecture } = evidence;
  if (
    os?.id !== SUPPORTED_BASE.osId ||
    os.version_id !== SUPPORTED_BASE.osVersionId ||
    architecture !== SUPPORTED_BASE.architecture
  )
    findings.push({
      summary: "It is not Amazon Linux 2023 on x86-64, the only base workers run",
      action: "Check that this machine is the factory's worker",
    });
  if (evidence.available_bytes !== null && evidence.available_bytes < MIN_AVAILABLE_BYTES)
    findings.push({
      summary: `Less than ${MIN_AVAILABLE_BYTES / 1024 ** 3} GiB is free under ${WORKER_PATHS.releases}`,
      action: "Free disk space on the worker, or grow its root volume (hosts[].root_volume_gib)",
    });
  return findings;
}

function releaseFindings(inspection: HostInspection, expected: Expectation): Finding[] {
  const { release } = inspection;
  const install = `Install release ${expected.release} with \`fffactory apply\``;
  const findings: Finding[] = [];
  if (release.state === "none") findings.push({ summary: "No release is active", action: install });
  if (release.state === "broken")
    findings.push({ summary: "Its active release is damaged", action: install });
  if (release.state === "active" && release.version !== expected.release)
    findings.push({
      summary: `It runs release ${release.version}; factory.json pins ${expected.release}`,
      action: install,
    });
  return findings;
}

function configurationFindings(inspection: HostInspection, expected: Expectation): Finding[] {
  const { configuration } = inspection;
  const findings: Finding[] = [];
  if (configuration.state === "present" && configuration.sha256 !== expected.configurationSha256)
    findings.push({
      summary: "Its host configuration is not the one factory.json projects for it",
      action: APPLY_REPAIRS,
    });
  if (configuration.state === "none")
    findings.push({ summary: "It has no host configuration", action: APPLY_REPAIRS });
  if (configuration.state === "unreadable")
    findings.push({
      summary: `${WORKER_ADMIN} cannot read its host configuration`,
      action: APPLY_REPAIRS,
    });
  for (const service of inspection.services)
    if (service.state !== "active")
      findings.push({
        summary: `Service ${service.name} is ${service.state}`,
        action: APPLY_REPAIRS,
      });
  return findings;
}

function failedChecks(verification: Verification | null): string[] {
  return (verification?.checks ?? [])
    .filter((check) => check.status === "failed")
    .map((check) => check.summary);
}

/** Why a recorded install failed: at a step, outside its steps, or in verification. */
function failedInstall(installation: RecordedInstallation): string {
  const { release, failed_step, failure, verification } = installation;
  if (failed_step !== null)
    return `Its install of release ${release} failed at step ${failed_step}`;
  if (failure !== null) return `Its install of release ${release} failed: ${failure}`;
  return `Release ${release} failed verification: ${failedChecks(verification).join("; ")}`;
}

/** What the last install's record says, once a release is active (else the release says it). */
function installationFindings(inspection: HostInspection): Finding[] {
  const { release, installation } = inspection;
  if (release.state !== "active") return [];
  const repair = (summary: string) => [{ summary, action: APPLY_REPAIRS }];
  switch (installation.state) {
    case "none":
      return repair(`No install of release ${release.version} by \`fffactory apply\` is recorded`);
    case "unreadable":
      return repair("Its install record cannot be read");
    case "running":
      return [
        {
          summary: `An install of release ${installation.release} started at ${installation.started_at} has not finished; it may still be running`,
          action: `If it started more than ${ACTIVATION_TIMEOUT_MS / 60_000} min ago (apply's activation timeout), repair the worker with \`fffactory apply\`; otherwise wait for it to finish`,
        },
      ];
    case "failed":
      return repair(failedInstall(installation));
    case "succeeded":
      return installation.release === release.version
        ? []
        : repair(
            `Its active release ${release.version} is not the one its last install recorded, ${installation.release}`,
          );
  }
}

/**
 * The inspection's release, configuration, install and enrollment facts; enrollment steps name
 * `hostname`, the worker's name as the CLI resolved it, never one the worker reported.
 */
export function inspectedFacts(
  inspection: HostInspection,
  hostname: string,
): Omit<WorkerFacts, "machine" | "instanceId" | "tailnet"> {
  const { release, configuration, installation } = inspection;
  const verification = "verification" in installation ? installation.verification : null;
  return {
    release: release.state === "active" ? release.version : release.state,
    configuration: configuration.state === "present" ? configuration.sha256 : configuration.state,
    installation: installation.state,
    enrollment: verification === null ? null : enrollmentReport(verification, hostname),
  };
}

/**
 * Software ready and every check passed, with accounts still to enroll: the exact steps for
 * each, which `fffactory apply` verifies again. Status itself cannot: only root can check the
 * runtime account's credentials, and only `host apply` runs as root.
 */
function enrollmentVerdict(verification: Verification, expected: Expectation): Verdict | undefined {
  const report = enrollmentReport(verification, expected.hostname);
  const pending = pendingEnrollment(report);
  if (pending.length === 0) return undefined;
  const titles = pending.map((entry) => entry.title).join(", ");
  return notReadyVerdict(
    `Software ready on release ${expected.release}; enrollment pending: ${titles}`,
    `Enroll each pending account on ${expected.hostname} as listed (tailnet SSH policy must let you log in there as \`factory\`)`,
    [
      ...pendingEnrollmentLines(report),
      `Enrollment as \`fffactory apply\` last verified it, at ${verification.verified_at}`,
    ],
    thenVerifyEnrollment,
  );
}

/** The readiness rule: the worker's own evidence against what factory.json expects. */
export function readinessVerdict(inspection: HostInspection, expected: Expectation): Verdict {
  const [first, ...rest] = [
    ...baseFindings(inspection, expected),
    ...releaseFindings(inspection, expected),
    ...configurationFindings(inspection, expected),
    ...installationFindings(inspection),
  ];
  if (first !== undefined)
    return notReadyVerdict(
      first.summary,
      first.action,
      rest.map((finding) => finding.summary),
    );
  const { installation } = inspection;
  const verification = installation.state === "succeeded" ? installation.verification : null;
  const pending = verification === null ? undefined : enrollmentVerdict(verification, expected);
  return (
    pending ?? {
      status: "ready",
      summary: `Ready on release ${expected.release}`,
      details: [],
      nextAction: null,
    }
  );
}

/**
 * Tailscale SSH, never plain `ssh`: the tailnet vouches for the host key, so the operator is
 * never asked to trust one on first use.
 */
function inspectCommand(hostname: string): string {
  return `\`tailscale ssh ${WORKER_ADMIN}@${hostname} ${INSPECT_COMMAND.join(" ")}\``;
}

/** A connection to the worker that SSH could not make or keep. */
export type ConnectionFailure = Extract<
  WorkerInspection,
  { readonly kind: "unreachable" | "access_denied" | "host_key_mismatch" | "client_missing" }
>;

/** Why SSH did not reach the worker `hostname`, and what to do, completed by `then`. */
export function connectionVerdict(
  failure: ConnectionFailure,
  hostname: string,
  then: Then = thenRerunStatus,
): Verdict {
  const verdict = (summary: string, action: string) => notReadyAfter(summary, action, then);
  switch (failure.kind) {
    case "unreachable":
      return verdict(
        `SSH could not reach it: ${failure.reason}`,
        `Check that the worker is up and reachable with \`tailscale ping ${hostname}\``,
      );
    case "access_denied":
      return verdict(
        `Tailnet SSH policy does not let you log in as ${WORKER_ADMIN}`,
        `Ask a tailnet admin for an SSH rule with action "accept" that lets you log in as ${WORKER_ADMIN} to the factory's tag (tailscale.tag in factory.json); enrolling a worker's accounts also needs one for ${RUNTIME_ACCOUNT}`,
      );
    case "host_key_mismatch":
      return verdict(
        "Its SSH host key is not one the tailnet lists for it, so fffactory did not log in",
        `Do not bypass this: check at ${ADMIN_CONSOLE} that the device ${hostname} is this factory's worker`,
      );
    case "client_missing":
      return verdict(
        "ssh is not on PATH",
        "Install the system OpenSSH client (`fffactory doctor` checks it)",
      );
  }
}

/** What an inspection that did not produce a document means for the worker. */
function uninspectedVerdict(
  inspection: Exclude<WorkerInspection, { readonly kind: "inspected" }>,
  expected: Expectation,
): Verdict {
  switch (inspection.kind) {
    case "no_release":
      return notReadyVerdict(
        "No release is installed",
        `Install release ${expected.release} with \`fffactory apply\``,
      );
    case "unreachable":
    case "access_denied":
    case "host_key_mismatch":
    case "client_missing":
      return connectionVerdict(inspection, expected.hostname);
    case "unsupported_protocol":
      return errorVerdict(
        `It speaks host protocol version ${inspection.version}; this fffactory speaks version ${HOST_PROTOCOL_VERSION}`,
        `Use fffactory ${expected.release}, the release factory.json pins`,
      );
    case "failed":
      return errorVerdict(
        `Inspecting it failed: ${inspection.reason}`,
        `If it fails again, run ${inspectCommand(expected.hostname)} to see why`,
      );
  }
}

/** The worker's facts and verdict from its inspection. */
export function inspectionVerdict(
  inspection: WorkerInspection,
  expected: Expectation,
): Omit<WorkerFacts, "machine" | "instanceId" | "tailnet"> & { readonly verdict: Verdict } {
  if (inspection.kind === "inspected")
    return {
      ...inspectedFacts(inspection.inspection, expected.hostname),
      verdict: readinessVerdict(inspection.inspection, expected),
    };
  return {
    release: inspection.kind === "no_release" ? "none" : "unknown",
    configuration: "unknown",
    installation: "unknown",
    enrollment: null,
    verdict: uninspectedVerdict(inspection, expected),
  };
}

/** The report: its status is the worst of every inventory and worker. */
export function statusReport(
  inventories: readonly CheckResult[],
  workers: readonly WorkerStatus[],
): StatusReport {
  return {
    status: worstStatus([...inventories, ...workers].map((entry) => entry.status)),
    inventories,
    workers,
  };
}
