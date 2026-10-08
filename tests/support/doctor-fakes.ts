import type { AssetBundle, WorkerRelease } from "../../src/application/asset-bundle";
import type { CacheDirectoryProbe } from "../../src/application/cache-directory";
import type { CallerIdentity } from "../../src/application/caller-identity";
import type { ManagedTerraformProbe } from "../../src/application/managed-terraform";
import type { ToolProbe } from "../../src/application/tool-probe";
import type { VpcQuotaProbe } from "../../src/application/vpc-quota-probe";
import type { Caller, CallerObservation, CredentialSelection } from "../../src/domain/aws-account";
import type { CacheDirectoryState } from "../../src/domain/cache";
import type { OpenSshObservation, TailscaleObservation } from "../../src/domain/local-tooling";
import type { ManagedTerraformState } from "../../src/domain/managed-terraform";
import type { FactoryId, Release } from "../../src/domain/instance";
import type { ReleaseAssetsState } from "../../src/domain/release-assets";
import type { VpcQuotaObservation } from "../../src/domain/vpc-quota";

type Scripted<T> = T | Error;

function answer<T>(value: Scripted<T>): Promise<T> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

/** ToolProbe returning fixed observations, or rejecting with a given error. Ready by default. */
export function fakeToolProbe(
  script: {
    openSsh?: Scripted<OpenSshObservation>;
    tailscale?: Scripted<TailscaleObservation>;
  } = {},
): ToolProbe {
  return {
    openSsh: () => answer(script.openSsh ?? { kind: "openssh", version: "OpenSSH_9.9p1" }),
    tailscale: () => answer(script.tailscale ?? { kind: "backend", backendState: "Running" }),
  };
}

/** CacheDirectoryProbe returning a fixed state and recording the paths it inspects. */
export function fakeCacheDirectory(state: Scripted<CacheDirectoryState> = "absent") {
  const inspected: string[] = [];
  const probe: CacheDirectoryProbe = {
    inspect: (path) => {
      inspected.push(path);
      return answer(state);
    },
  };
  return { probe, inspected };
}

/** A documentation-style caller in examples/factory.json's account. Never a real account. */
export const FAKE_CALLER: Caller = {
  account: "123456789012",
  arn: "arn:aws:sts::123456789012:assumed-role/FactoryAdmin/operator",
};

/**
 * CallerIdentity returning a fixed observation, or rejecting with a given error, and
 * recording each request. Resolves FAKE_CALLER by default. Never contacts AWS.
 */
export function fakeCallerIdentity(
  observation: Scripted<CallerObservation> = { kind: "caller", caller: FAKE_CALLER },
) {
  const requests: { credentials: CredentialSelection; region: string }[] = [];
  const identity: CallerIdentity = {
    resolve: (credentials, region) => {
      requests.push({ credentials, region });
      return answer(observation);
    },
  };
  return { identity, requests };
}

/** The digest the fake bundle's materialized assets have. */
export const FAKE_ASSETS_SHA256 = "5".repeat(64);

/** The release tarball the fake bundle hands to workers: stand-in bytes with their digest. */
export const FAKE_WORKER_RELEASE: WorkerRelease = {
  release: "0.3.0" as Release,
  sha256: FAKE_ASSETS_SHA256,
  tarball: new TextEncoder().encode("the release tarball"),
};

/**
 * AssetBundle whose `inspect` returns a fixed state, or rejects with a given error, and
 * which records every directory it inspects or materializes. Never touches the filesystem.
 * Its worker release is `worker`: undefined models a bundle without a worker executable.
 */
export function fakeAssetBundle(
  state: Scripted<ReleaseAssetsState> = "absent",
  worker: WorkerRelease | undefined = FAKE_WORKER_RELEASE,
) {
  const inspected: string[] = [];
  const materialized: string[] = [];
  const bundle: AssetBundle = {
    inspect: (directory) => {
      inspected.push(directory);
      return answer(state);
    },
    materialize: async (directory) => {
      materialized.push(directory);
      return FAKE_ASSETS_SHA256;
    },
    workerRelease: async () => worker,
  };
  return { bundle, inspected, materialized };
}

/**
 * ManagedTerraformProbe returning a fixed state, or rejecting with a given error, and
 * recording the cache directories it inspects. Never touches the filesystem or network.
 */
export function fakeManagedTerraform(state: Scripted<ManagedTerraformState> = "absent") {
  const inspected: string[] = [];
  const probe: ManagedTerraformProbe = {
    inspect: (cacheDirectory) => {
      inspected.push(cacheDirectory);
      return answer(state);
    },
  };
  return { probe, inspected };
}

/**
 * VpcQuotaProbe returning a fixed observation, or rejecting with a given error, and
 * recording each request. Room for the factory's VPC by default. Never contacts AWS.
 */
export function fakeVpcQuotaProbe(
  observation: Scripted<VpcQuotaObservation> = {
    kind: "observed",
    limit: 5,
    used: 1,
    factoryVpc: false,
  },
) {
  const requests: { credentials: CredentialSelection; region: string; factoryId: FactoryId }[] = [];
  const probe: VpcQuotaProbe = {
    inspect: (credentials, region, factoryId) => {
      requests.push({ credentials, region, factoryId });
      return answer(observation);
    },
  };
  return { probe, requests };
}
