import { describe, expect, test } from "bun:test";
import type { FactoryId, Host, HostKey, Repository } from "../../src/domain/instance";
import {
  ADOPTION_CHECK,
  INSPECT_REPOSITORIES_COMMAND,
  PLACED_SET,
  placedRepositories,
  REPOSITORY_MANIFEST_PATH,
  repositoryManifest,
  repositoryManifestJson,
  repositoryReadiness,
  repositorySync,
  SYNC_COMMAND,
  SYNC_SCRIPT,
  unmanagedRepositories,
} from "../../src/domain/repository-placement";

const FACTORY = "fff-abcd1234" as FactoryId;

function repo(key: string, path = key): Repository {
  return {
    key,
    remote: `https://github.com/yaunder/${key}`,
    path,
    branch: "main",
  };
}

function host(key: string, repositories: string[]): Host {
  return { key: key as HostKey, repositories };
}

describe("repository placement", () => {
  test("resolves a host's placement from the inventory, in placement order", () => {
    const inventory = [repo("alpha"), repo("beta"), repo("gamma")];
    const placed = placedRepositories(inventory, host("builder-1", ["gamma", "alpha"]));
    expect(placed.map((r) => r.key)).toEqual(["gamma", "alpha"]);
  });

  test("skips a placement key that is not in the inventory", () => {
    const placed = placedRepositories([repo("alpha")], host("builder-1", ["alpha", "missing"]));
    expect(placed.map((r) => r.key)).toEqual(["alpha"]);
  });

  test("a host with no placement places nothing", () => {
    expect(placedRepositories([repo("alpha")], {})).toEqual([]);
  });

  test("projects the per-host manifest the wrapped sync script reads", () => {
    const inventory = [repo("alpha", "services/alpha"), repo("beta")];
    const manifest = repositoryManifest(FACTORY, host("builder-1", ["alpha", "beta"]), inventory);
    expect(manifest).toEqual({
      version: 2,
      repositories: {
        alpha: {
          remote: "https://github.com/yaunder/alpha",
          path: "services/alpha",
          branch: "main",
          update_policy: "fast-forward-only",
        },
        beta: {
          remote: "https://github.com/yaunder/beta",
          path: "beta",
          branch: "main",
          update_policy: "fast-forward-only",
        },
      },
      repository_sets: { [PLACED_SET]: ["alpha", "beta"] },
      hosts: { "fff-abcd1234-builder-1": { repository_sets: [PLACED_SET] } },
    });
  });

  test("serializes the manifest as canonical two-space JSON with a final newline", () => {
    const json = repositoryManifestJson(
      repositoryManifest(FACTORY, host("builder-1", ["alpha"]), [repo("alpha")]),
    );
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toBe(`${JSON.stringify(JSON.parse(json), null, 2)}\n`);
    expect(json).toContain('"fast-forward-only"');
  });
});

describe("repository readiness", () => {
  test("a clean sync run is synchronized and lets dispatch proceed", () => {
    const sync = repositorySync(0);
    expect(sync).toEqual({ kind: "synchronized" });
    expect(repositoryReadiness(sync)).toBe("ready");
  });

  test("a non-zero sync run leaves repositories unresolved and keeps dispatch pending", () => {
    const sync = repositorySync(1);
    expect(sync).toEqual({ kind: "unresolved" });
    expect(repositoryReadiness(sync)).toBe("pending");
  });
});

describe("unmanaged checkouts", () => {
  test("names checkouts on disk that factory.json no longer places there, sorted", () => {
    const unmanaged = unmanagedRepositories(
      ["alpha", "services/beta"],
      ["services/beta", "removed", "alpha", "legacy"],
    );
    expect(unmanaged).toEqual(["legacy", "removed"]);
  });

  test("nothing is unmanaged when every checkout is still placed", () => {
    expect(unmanagedRepositories(["alpha"], ["alpha"])).toEqual([]);
  });
});

describe("worker command surface", () => {
  test("the sync script and adoption check live under the active release", () => {
    expect(SYNC_SCRIPT).toBe("/opt/fffactory/current/steps/repositories/sync-repositories.sh");
    expect(ADOPTION_CHECK).toBe(
      "/opt/fffactory/current/steps/repositories/check-ffflow-adoption.sh",
    );
    expect(REPOSITORY_MANIFEST_PATH).toBe("/var/lib/fffactory/repositories.json");
  });

  test("reconciliation uses the activator's narrow endpoint and status is unprivileged", () => {
    expect([...SYNC_COMMAND]).toEqual([
      "sudo",
      "-n",
      "/usr/local/libexec/fffactory-activate",
      "repositories",
    ]);
    expect([...INSPECT_REPOSITORIES_COMMAND]).toEqual([
      "/opt/fffactory/current/bin/fffactory",
      "host",
      "repositories",
      "--json",
    ]);
  });
});
