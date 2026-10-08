/**
 * Fakes for status and the host protocol: the EC2 inventory, the operator's tailnet view, an
 * SSH transport scripted per worker hostname, and this machine as a worker. None of them
 * runs `ssh` or `tailscale` or reaches AWS.
 */
import type { HostCommandOutcome, HostTransport } from "../../src/application/host-transport";
import type { MachineInventorySource } from "../../src/application/machine-inventory";
import type { TailnetPeers } from "../../src/application/tailnet-peers";
import type { CredentialSelection } from "../../src/domain/aws-account";
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import {
  HOST_PROTOCOL_VERSION,
  type HostInspection,
  hostInspectionJson,
} from "../../src/domain/host-protocol";
import {
  type HostApplyRecord,
  type HostApplyResult,
  hostApplyJson,
  INSTALL_STEPS,
  pendingSteps,
  type RecordedInstallation,
  withStep,
} from "../../src/domain/installation";
import type { FactoryId, HostKey, Release, SecretReference } from "../../src/domain/instance";
import { repositoryInspectionJson } from "../../src/domain/repository-placement";
import {
  dispatchInspectionJson,
  type DispatchInspection,
} from "../../src/domain/dispatch-projection";
import { ENROLLMENTS, type EnrollmentState, type Verification } from "../../src/domain/readiness";
import type { Machine, MachineInventory } from "../../src/domain/status";
import type { PeerView, TailnetPeer, WorkerAddress } from "../../src/domain/tailnet";
import type { WorkerEndpoint } from "../../src/host/endpoint";
import { sha256Text } from "../../src/infrastructure/release-tarball";

/** An ed25519 public key in OpenSSH's format; test data, never a real host's. */
export const HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTestsOnly0123456789abcdefghij";

/** The factory's tag: `tailscale.tag` in `examples/factory.json`. */
export const TAG = "tag:software-factory";

/** An online tailnet device carrying `hostname` and `TAG`, with a Tailscale SSH host key. */
export function peer(hostname: string, overrides: Partial<TailnetPeer> = {}): TailnetPeer {
  return {
    hostName: hostname,
    dnsName: `${hostname}.example-tailnet.ts.net.`,
    addresses: ["100.64.0.10", "fd7a:115c:a1e0::a"],
    online: true,
    sshHostKeys: [HOST_KEY],
    tags: [TAG],
    ...overrides,
  };
}

export function peers(...devices: TailnetPeer[]): PeerView {
  return { kind: "peers", peers: devices };
}

/**
 * TailnetPeers returning a fixed view, or the view `view` gives for each read (1 for the
 * first), as the tailnet changes while a new worker boots; counting reads.
 */
export function fakeTailnet(view: PeerView | ((read: number) => PeerView) = peers()) {
  let reads = 0;
  const tailnet: TailnetPeers = {
    view: async () => {
      reads += 1;
      return typeof view === "function" ? view(reads) : view;
    },
  };
  return { tailnet, reads: () => reads };
}

/**
 * A clock that moves only when apply sleeps, as a booting worker's wait does, recording each
 * sleep; `onSleep` runs after each, such as an interrupt arriving while apply waits.
 */
export function fakeTime(start: Date, onSleep: (slept: number) => void = () => {}) {
  let elapsed = 0;
  const sleeps: number[] = [];
  return {
    clock: () => new Date(start.getTime() + elapsed),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      elapsed += ms;
      onSleep(sleeps.length);
    },
    sleeps,
  };
}

export function machine(
  hostKey: string,
  state: Machine["state"] = "running",
  instanceId = "i-0123456789abcdef0",
): Machine {
  return { instanceId, state, hostKey };
}

/** MachineInventorySource returning fixed machines, recording each request. */
export function fakeMachineInventory(
  inventory: MachineInventory = { kind: "machines", machines: [] },
) {
  const requests: { credentials: CredentialSelection; region: string; factoryId: FactoryId }[] = [];
  const machines: MachineInventorySource = {
    list: async (credentials, region, factoryId) => {
      requests.push({ credentials, region, factoryId });
      return inventory;
    },
  };
  return { machines, requests };
}

/** The host configuration's digest in `inspection`, and what `FAKE_SHA256` computes. */
export const CONFIGURATION_SHA256 = "b".repeat(64);

/** A stand-in SHA-256 that gives every text `CONFIGURATION_SHA256`. */
export const FAKE_SHA256 = (_text: string) => CONFIGURATION_SHA256;

/** A verification on `hostname` that passed every check, with every account in `state`. */
export function verification(
  hostname: string,
  state: EnrollmentState = "enrolled",
  overrides: Partial<Verification> = {},
): Verification {
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname,
    verified_at: "2026-09-30T11:00:00.000Z",
    checks: [{ id: "toolchain", status: "passed", summary: "Every tool runs" }],
    enrollment: ENROLLMENTS.map(({ id }) => ({ id, state })),
    ...overrides,
  };
}

/** A finished install of `release` whose verification is `verified`. */
export function installed(release: string, verified: Verification | null): RecordedInstallation {
  return {
    state: "succeeded",
    release,
    configuration_sha256: CONFIGURATION_SHA256,
    failed_step: null,
    started_at: "2026-09-30T10:55:00.000Z",
    finished_at: "2026-09-30T11:00:00.000Z",
    verification: verified,
    failure: null,
  };
}

/** The SHA-256 of the host projection apply sends `key` of `factoryId` on `release`. */
export function projectionSha256(
  factoryId: string,
  key: string,
  release: string,
  paseoPasswordSecret?: SecretReference,
): string {
  return sha256Text(
    hostProjectionJson(
      hostProjection(
        factoryId as FactoryId,
        key as HostKey,
        release as Release,
        paseoPasswordSecret,
      ),
    ),
  );
}

/**
 * The inspection of a ready worker `key` of `factoryId` on `release`, holding the host
 * projection factory.json gives it: what the CLI, which digests projections for real, sees.
 */
export function readyWorker(
  factoryId: string,
  key: string,
  release: string,
  paseoPasswordSecret?: SecretReference,
): HostInspection {
  const hostname = `${factoryId}-${key}`;
  const sha256 = projectionSha256(factoryId, key, release, paseoPasswordSecret);
  return inspection(
    hostname,
    {
      configuration: { state: "present", sha256 },
      installation: {
        ...installed(release, verification(hostname)),
        configuration_sha256: sha256,
      },
    },
    release,
  );
}

/** A ready worker's inspection on `release`: installed, verified and every account enrolled. */
export function inspection(
  hostname: string,
  overrides: Partial<HostInspection> = {},
  release = "0.3.0",
): HostInspection {
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname,
    release: { state: "active", version: release, sha256: "a".repeat(64) },
    configuration: { state: "present", sha256: CONFIGURATION_SHA256 },
    installation: installed(release, verification(hostname)),
    services: [{ name: "tailscaled", state: "active" }],
    evidence: {
      bootstrap_complete: true,
      os: { id: "amzn", version_id: "2023" },
      architecture: "x86_64",
      available_bytes: 20 * 1024 ** 3,
    },
    ...overrides,
  };
}

/** A worker answering `host inspect` with this document. */
export function answers(document: HostInspection): HostCommandOutcome {
  return { kind: "completed", exitCode: 0, stdout: hostInspectionJson(document) };
}

function dispatchAnswer(dispatch: DispatchInspection): HostCommandOutcome {
  const failed = dispatch.state === "failed" || dispatch.state === "unreadable";
  const pending = dispatch.state === "pending" || dispatch.state === "none";
  return {
    kind: "completed",
    exitCode: failed ? 1 : pending ? 2 : 0,
    stdout: dispatchInspectionJson(dispatch),
  };
}

function repositoriesAnswer(
  state: "synchronized" | "unresolved" | "none" | "unreadable",
  unmanaged: readonly string[],
): HostCommandOutcome {
  const inspected =
    state === "synchronized" || state === "unresolved"
      ? { protocol_version: 1 as const, state, unmanaged }
      : { protocol_version: 1 as const, state };
  return {
    kind: "completed",
    exitCode: state === "unresolved" || state === "unreadable" ? 1 : 0,
    stdout: repositoryInspectionJson(inspected),
  };
}

/** A worker answering both of status's read-only host protocol commands. */
export function statusAnswers(
  document: HostInspection,
  repositories: "synchronized" | "unresolved" | "none" | "unreadable" = "synchronized",
  unmanaged: readonly string[] = [],
  dispatch: DispatchInspection = {
    protocol_version: HOST_PROTOCOL_VERSION,
    state: "not_requested",
    blockers: [],
    changed: false,
  },
): Answer {
  return (command) => {
    if (command.includes("dispatch")) return dispatchAnswer(dispatch);
    return command.includes("repositories")
      ? repositoriesAnswer(repositories, unmanaged)
      : answers(document);
  };
}

/** A worker's scripted answer: one outcome for every command, or one chosen by command. */
export type Answer =
  | HostCommandOutcome
  | ((command: readonly string[], stdin: Uint8Array | undefined) => HostCommandOutcome);

/**
 * HostTransport answering by the worker's hostname, recording every call and the standard
 * input it streamed. A worker with no scripted answer is unreachable.
 */
export function fakeTransport(script: Record<string, Answer> = {}) {
  const calls: {
    worker: WorkerAddress;
    command: readonly string[];
    timeoutMs: number;
    stdin?: Uint8Array;
  }[] = [];
  const transport: HostTransport = {
    run: async (worker, command, { timeoutMs, stdin }) => {
      calls.push({ worker, command: [...command], timeoutMs, ...(stdin ? { stdin } : {}) });
      const answer = script[worker.hostname];
      if (answer === undefined) return { kind: "unreachable", reason: "the connection timed out" };
      return typeof answer === "function" ? answer(command, stdin) : answer;
    },
  };
  return { transport, calls };
}

/** What `host dispatch inspect` answers when factory.json requests no dispatch. */
const NOT_REQUESTED: DispatchInspection = {
  protocol_version: HOST_PROTOCOL_VERSION,
  state: "not_requested",
  blockers: [],
  changed: false,
};

/**
 * `document` as the worker reports it once it keeps `projection`: its configuration, and its
 * install record's, are that text's real SHA-256, as `host apply` records them.
 */
function holding(document: HostInspection, projection: string | undefined): HostInspection {
  if (projection === undefined) return document;
  const sha256 = sha256Text(projection);
  const { installation } = document;
  return {
    ...document,
    configuration: { state: "present", sha256 },
    installation:
      "configuration_sha256" in installation
        ? { ...installation, configuration_sha256: sha256 }
        : installation,
  };
}

/**
 * A worker that takes an upload and answers the activator with `result` (host apply's
 * document, printed as it prints it), `host inspect` as `inspection`, its repositories as
 * synchronized and its dispatch as `dispatch` (by default not requested). Like `host apply`, it
 * keeps the projection the activator streamed it, which `projections` lists: from then on its
 * inspection reports that text's real SHA-256 as its configuration, so a test sees exactly the
 * drift, or the clean rerun, the CLI's real digests would.
 */
export function installableWorker(
  result: HostApplyResult,
  options: {
    upload?: HostCommandOutcome;
    activation?: HostCommandOutcome;
    inspection?: HostInspection;
    dispatch?: DispatchInspection;
  } = {},
): Answer & { readonly projections: readonly string[] } {
  const projections: string[] = [];
  const uploaded = uploadAnswer(options.upload);
  const dispatched = dispatchAnswer(options.dispatch ?? NOT_REQUESTED);
  const activate = (stdin: Uint8Array | undefined): HostCommandOutcome => {
    const activated = activationAnswer(result, options.activation);
    if (activated.kind === "completed" && stdin !== undefined)
      projections.push(new TextDecoder().decode(stdin));
    return activated;
  };
  const inspect = (): HostCommandOutcome =>
    options.inspection === undefined
      ? NOT_FOUND
      : answers(holding(options.inspection, projections.at(-1)));
  const answer = (command: readonly string[], stdin: Uint8Array | undefined) => {
    if (command[0] === "dd") return uploaded;
    if (command.includes("dispatch")) return dispatched;
    if (command.includes("inspect")) return inspect();
    if (command.includes("repositories")) return repositoriesAnswer("synchronized", []);
    return command[0] === "sudo" ? activate(stdin) : NOT_FOUND;
  };
  return Object.assign(answer, { projections });
}

/** What the worker's shell answers for a command it cannot find. */
const NOT_FOUND: HostCommandOutcome = { kind: "completed", exitCode: 127, stdout: "" };

function uploadAnswer(upload: HostCommandOutcome | undefined): HostCommandOutcome {
  return upload ?? { kind: "completed", exitCode: 0, stdout: "" };
}

function activationAnswer(
  result: HostApplyResult,
  activation: HostCommandOutcome | undefined,
): HostCommandOutcome {
  if (activation !== undefined) return activation;
  return {
    kind: "completed",
    exitCode: result.state === "succeeded" ? 0 : 1,
    stdout: hostApplyJson(result),
  };
}

/** host apply's record of a verified install of `release` on `hostname`. */
export function appliedRecord(
  hostname: string,
  release = "0.3.0",
  overrides: Partial<HostApplyRecord> = {},
): HostApplyRecord {
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname,
    state: "succeeded",
    release,
    configuration_sha256: CONFIGURATION_SHA256,
    started_at: "2026-09-30T12:00:00.000Z",
    finished_at: "2026-09-30T12:09:00.000Z",
    steps: INSTALL_STEPS.reduce(
      (steps, { name }) => withStep(steps, name, "succeeded"),
      pendingSteps(),
    ),
    verification: verification(hostname, "pending"),
    failure: null,
    ...overrides,
  };
}

/**
 * This machine as a worker, answering `host inspect` with a fixed document, and `host apply`
 * and `host verify` as `overrides` say (by default they throw: nothing should call them).
 */
export function fakeWorker(
  document: HostInspection,
  overrides: Partial<WorkerEndpoint> = {},
): WorkerEndpoint {
  return {
    inspect: async () => document,
    apply: async () => {
      throw new Error("host apply was not expected");
    },
    verify: async () => {
      throw new Error("host verify was not expected");
    },
    inspectRepositories: async () => ({ protocol_version: 1, state: "none" }),
    reconcileRepositories: async () => {
      throw new Error("host repositories --apply was not expected");
    },
    activity: async () => ({ kind: "idle" }),
    install: async () => ({ kind: "done" }),
    reload: async () => ({ kind: "done" }),
    restart: async () => ({ kind: "done" }),
    adoption: async () => ({ protocol_version: 1, state: "passed" }),
    reconcileDispatch: async () => ({
      protocol_version: 1,
      state: "not_requested",
      blockers: [],
      changed: false,
    }),
    inspectDispatch: async () => ({ protocol_version: 1, state: "none" }),
    isRoot: () => false,
    ...overrides,
  };
}
