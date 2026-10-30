#!/usr/bin/env bun
import { constants, homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { cacheDirectoryPath } from "../application/cache-directory";
import { planStoreDirectory } from "../application/plan-store";
import { readLimited } from "../host/apply";
import { localCollectionSystem, workerCollection } from "../host/collection";
import { workerEndpoint } from "../host/endpoint";
import { localWorkerSystem } from "../host/inspect";
import { flockExclusive } from "../host/install-lock";
import {
  checkoutReleaseBundle,
  embeddedReleaseBundle,
  releaseAssetBundle,
} from "../infrastructure/asset-bundle";
import { s3LockStore } from "../infrastructure/aws-s3-lock-store";
import { secretsManagerStore } from "../infrastructure/aws-secrets-manager-store";
import { stsCallerIdentity } from "../infrastructure/aws-sts-caller-identity";
import { awsVpcQuotaProbe } from "../infrastructure/aws-vpc-quota-probe";
import { ec2MachineInventory } from "../infrastructure/ec2-inventory";
import { ec2MachineControl } from "../infrastructure/ec2-machine-control";
import { filesystemCacheDirectory } from "../infrastructure/filesystem-cache-directory";
import { filesystemInstanceStore } from "../infrastructure/filesystem-instance-store";
import {
  killRunningTools,
  localToolProbe,
  stopRunningTools,
  stopsGracefully,
} from "../infrastructure/local-tool-probe";
import { filesystemPlanStore } from "../infrastructure/plan-store";
import { sshTransport } from "../infrastructure/ssh-transport";
import { paseoControlPlane } from "../infrastructure/paseo-control-plane";
import { ffflowGithubWorkflowQueue } from "../infrastructure/ffflow-github-workflow-queue";
import { tailscaleApiAdmin, tailscaleApiBase } from "../infrastructure/tailscale-api-admin";
import { tailscalePeers } from "../infrastructure/tailscale-peers";
import { terminalPrompt } from "../infrastructure/terminal-prompt";
import { managedTerraform } from "../infrastructure/terraform/installer";
import { terraformProvisioner } from "../infrastructure/terraform/provisioner";
import { terraformRunner } from "../infrastructure/terraform/runner";
import { RELEASE_COMPATIBILITY } from "../domain/release-compatibility";
import { descriptorOutput } from "./descriptor-lines";
import { interruptible, RETURN_GRACE_MS } from "./interrupts";
import { streamStyles } from "./presentation/color";
import { writer } from "./presentation/style";
import { RELEASE } from "./release";
import { run, waitsOnInterrupt } from "./run";

/** Standard output's and standard error's lines, written raw: never through `console`. */
const output = descriptorOutput();
const stdoutLines = output.lines(1);
const stderrLines = output.lines(2);

/** Signal handling (`cli/interrupts.ts`) over this process. */
const interrupts = interruptible({
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.off(signal, handler),
  exit: (code) => process.exit(code),
  flushOutput: output.flush,
  cancelOutput: output.cancel,
  signalNumber: (signal) => constants.signals[signal],
  stopRunningTools,
  killRunningTools,
  stopsGracefully,
  err: stderrLines,
  graceMs: RETURN_GRACE_MS,
});

/**
 * The compiled executable uses only the bundle embedded in it. Run from source, there is
 * none, so the bundle is packed from this checkout's `assets/` instead.
 */
const assets = releaseAssetBundle(
  Bun.isStandaloneExecutable
    ? embeddedReleaseBundle(RELEASE)
    : checkoutReleaseBundle(resolve(import.meta.dir, "../../assets"), RELEASE),
);

/**
 * Where the Tailscale admin client sends its secret. Only a run from source reads
 * `FFFACTORY_TAILSCALE_API`, for tests' loopback stand-ins; the compiled executable never does,
 * so its secret goes only to Tailscale. A stand-in it refuses stops every command before it runs.
 */
function tailscaleApi(): string | undefined {
  try {
    return tailscaleApiBase(Bun.isStandaloneExecutable ? {} : process.env);
  } catch (error) {
    stderrLines(`fffactory: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
const tailscaleApiUrl = tailscaleApi();
if (tailscaleApiUrl === undefined) {
  await output.flush();
  process.exit(1);
}

const cacheDirectory = cacheDirectoryPath(process.env, homedir());
const terraform = managedTerraform();

/** One SSH transport reaches every worker stage: the workers, repositories and phase-3 stages. */
const transport = sshTransport({ env: process.env });

/** Each stream's style, from its own terminal status and the environment, decided once. */
const styles = streamStyles({
  stdoutIsTTY: process.stdout.isTTY,
  stderrIsTTY: process.stderr.isTTY,
  env: process.env,
});

const argv = process.argv.slice(2);
await interrupts.run(
  () =>
    run(argv, {
      cwd: process.cwd(),
      home: homedir(),
      env: process.env,
      store: filesystemInstanceStore,
      tools: localToolProbe(),
      cache: filesystemCacheDirectory,
      assets,
      identity: stsCallerIdentity(),
      terraform,
      vpcQuota: awsVpcQuotaProbe(),
      lockStore: s3LockStore(),
      secrets: secretsManagerStore(),
      prompt: terminalPrompt(process.stdin, {
        write: (text) => output.write(2, text),
        flush: async () => {
          await output.flush();
          return !interrupts.interrupted();
        },
      }),
      provisioner: terraformProvisioner({
        cacheDirectory,
        terraform,
        run: terraformRunner(process.env),
      }),
      planStore: filesystemPlanStore(planStoreDirectory(cacheDirectory)),
      machines: ec2MachineInventory(),
      machineControl: ec2MachineControl(),
      tailnet: tailscalePeers(),
      tailnetAdmin: tailscaleApiAdmin({ baseUrl: tailscaleApiUrl }),
      transport,
      controlPlane: paseoControlPlane(transport),
      workflowQueue: ffflowGithubWorkflowQueue(transport),
      worker: workerEndpoint(
        {
          ...localWorkerSystem(),
          release: RELEASE,
          isRoot: () => process.getuid?.() === 0,
          readInput: () => readLimited(Bun.stdin.stream(), 1024 * 1024),
          now: () => new Date(),
          lock: flockExclusive,
        },
        workerCollection(localCollectionSystem(RELEASE)),
      ),
      interrupted: interrupts.interrupted,
      hostname: hostname(),
      now: () => new Date(),
      sleep: interrupts.sleep,
      release: RELEASE,
      compatibility: RELEASE_COMPATIBILITY,
      randomBytes: (count) => crypto.getRandomValues(new Uint8Array(count)),
      out: writer(stdoutLines, styles.out),
      err: writer(stderrLines, styles.err),
    }),
  { waitsOnInterrupt: waitsOnInterrupt(argv) },
);
