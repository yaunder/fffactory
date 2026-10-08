import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Release } from "../../src/domain/instance";
import { MATERIALIZED_MARKER, markerFor } from "../../src/domain/release-assets";
import {
  checkoutReleaseBundle,
  EMBEDDED_BUNDLE_NAME,
  type Embedded,
  embeddedReleaseBundle,
  INSTALL_ATTEMPTS,
  type InstallSteps,
  install,
  packAssetsDirectory,
  type ReleaseBundle,
  releaseAssetBundle,
  STALE_STAGING_MS,
} from "../../src/infrastructure/asset-bundle";
import {
  packTarball,
  sha256Hex,
  type TarballEntry,
  unpackTarball,
} from "../../src/infrastructure/release-tarball";
import { rawTarball } from "../support/raw-tarball";

const RELEASE = "0.3.0" as Release;
const text = (value: string) => new TextEncoder().encode(value);

const ENTRIES: TarballEntry[] = [
  { path: "release.json", executable: false, data: text('{\n  "release": "0.3.0"\n}\n') },
  { path: "bin/setup.sh", executable: true, data: text("#!/bin/sh\necho set up\n") },
];

/** A bundle over `tarball`, recording `sha256` (the tarball's own digest unless given). */
function bundleOf(tarball: Uint8Array<ArrayBuffer>, release = RELEASE, sha256?: string) {
  let reads = 0;
  const bundle: ReleaseBundle = {
    release,
    sha256: sha256 ?? sha256Hex(tarball),
    tarball: async () => {
      reads += 1;
      return tarball;
    },
  };
  return { load: async () => bundle, reads: () => reads };
}

const intact = (entries = ENTRIES, release = RELEASE) => bundleOf(packTarball(entries), release);

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-assets-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A fresh cache directory and the release directory inside it. */
async function freshCache(release: string = RELEASE) {
  const cache = await mkdtemp(join(scratch, "cache-"));
  return { cache, releases: join(cache, "releases"), directory: join(cache, "releases", release) };
}

describe("materialize", () => {
  test("writes every entry with its mode, then the marker naming release and digest", async () => {
    const { directory } = await freshCache();
    const bundle = intact();
    const digest = await releaseAssetBundle(bundle.load).materialize(directory);
    expect(digest).toBe((await bundle.load()).sha256);
    expect(await readFile(join(directory, "release.json"), "utf8")).toContain('"0.3.0"');
    expect((await stat(join(directory, "bin/setup.sh"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(directory, "release.json"))).mode & 0o111).toBe(0);
    const marker = await readFile(join(directory, MATERIALIZED_MARKER), "utf8");
    expect(marker).toBe(markerFor(RELEASE, (await bundle.load()).sha256));
  });

  test("is a no-op for a release already materialized from the same bundle", async () => {
    const { directory, releases } = await freshCache();
    const bundle = intact();
    const assets = releaseAssetBundle(bundle.load);
    await assets.materialize(directory);
    const before = await stat(directory);
    await writeFile(join(directory, "release.json"), "edited");

    expect(await assets.materialize(directory)).toBe((await bundle.load()).sha256);

    expect(bundle.reads()).toBe(1);
    expect((await stat(directory)).ino).toBe(before.ino);
    expect(await readFile(join(directory, "release.json"), "utf8")).toBe("edited");
    expect(await readdir(releases)).toEqual([RELEASE]);
  });

  test("keys each release by version: releases materialize side by side", async () => {
    const { cache, releases } = await freshCache();
    const older = join(cache, "releases", "0.2.0");
    await releaseAssetBundle(intact(ENTRIES, "0.2.0" as Release).load).materialize(older);
    await releaseAssetBundle(intact().load).materialize(join(releases, RELEASE));
    expect((await readdir(releases)).sort()).toEqual(["0.2.0", RELEASE]);
    expect(await readFile(join(older, MATERIALIZED_MARKER), "utf8")).toContain('"0.2.0"');
  });

  test("replaces a directory holding another bundle of the same release", async () => {
    const { directory, releases } = await freshCache();
    const other = intact([{ path: "old.txt", executable: false, data: text("old") }]);
    await releaseAssetBundle(other.load).materialize(directory);

    await releaseAssetBundle(intact().load).materialize(directory);

    expect((await readdir(directory)).sort()).toEqual([MATERIALIZED_MARKER, "bin", "release.json"]);
    expect(await readdir(releases)).toEqual([RELEASE]);
  });

  test("replaces a directory with no marker, and a file, at the release path", async () => {
    const { directory, releases } = await freshCache();
    await mkdir(join(directory, "partial"), { recursive: true });
    await releaseAssetBundle(intact().load).materialize(directory);
    expect(await readdir(directory)).not.toContain("partial");

    await rm(directory, { recursive: true });
    await writeFile(directory, "not a directory");
    await releaseAssetBundle(intact().load).materialize(directory);
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(await readdir(releases)).toEqual([RELEASE]);
  });

  test("removes staging and replaced copies a killed run left, older than an hour", async () => {
    const { directory, releases } = await freshCache();
    await mkdir(releases, { recursive: true });
    const old = new Date(Date.now() - STALE_STAGING_MS - 60_000);
    const left = [`.${RELEASE}.staging-abc`, `.${RELEASE}.replaced-def`, ".0.2.0.staging-old"];
    for (const name of left) {
      await mkdir(join(releases, name, "terraform"), { recursive: true });
      await utimes(join(releases, name), old, old);
    }
    await mkdir(join(releases, `.${RELEASE}.staging-recent`));
    await releaseAssetBundle(intact().load).materialize(directory);
    expect((await readdir(releases)).sort()).toEqual([
      ".0.2.0.staging-old",
      `.${RELEASE}.staging-recent`,
      RELEASE,
    ]);
    expect(STALE_STAGING_MS).toBe(60 * 60 * 1000);
  });

  test("rejects a tarball that does not match its recorded digest, writing nothing", async () => {
    const { cache, directory } = await freshCache();
    const tampered = bundleOf(packTarball(ENTRIES), RELEASE, "0".repeat(64));
    await expect(releaseAssetBundle(tampered.load).materialize(directory)).rejects.toThrow(
      "The embedded release assets do not match their recorded SHA-256 digest",
    );
    expect(await readdir(cache)).toEqual([]);
  });

  test("rejects an executable with no embedded bundle", async () => {
    const { directory } = await freshCache();
    await expect(releaseAssetBundle(async () => undefined).materialize(directory)).rejects.toThrow(
      "This fffactory executable embeds no release assets",
    );
  });

  test("rejects an entry that would escape the directory, writing nothing outside it", async () => {
    const { cache, directory, releases } = await freshCache();
    const escaping = rawTarball([
      { path: "release.json", data: text("{}") },
      { path: "../../escaped", data: text("owned") },
    ]);
    await expect(
      releaseAssetBundle(bundleOf(escaping).load).materialize(directory),
    ).rejects.toThrow(`"../../escaped" must not contain '.' or '..' segments`);
    expect(await readdir(cache)).toEqual([]);
    await expect(stat(join(releases, "..", "..", "escaped"))).rejects.toThrow();
  });

  test("leaves no partial directory when an entry cannot be written", async () => {
    const { directory, releases } = await freshCache();
    const stale = intact([{ path: "old.txt", executable: false, data: text("old") }]);
    await releaseAssetBundle(stale.load).materialize(directory);
    // "a" is a file, so "a/b" cannot be created beneath it.
    const unwritable = packTarball([
      { path: "a", executable: false, data: text("file") },
      { path: "a/b", executable: false, data: text("under a file") },
    ]);

    await expect(
      releaseAssetBundle(bundleOf(unwritable).load).materialize(directory),
    ).rejects.toThrow();

    expect(await readdir(releases)).toEqual([RELEASE]);
    expect(await readFile(join(directory, "old.txt"), "utf8")).toBe("old");
  });

  test("concurrent runs all succeed and leave one complete directory", async () => {
    const { directory, releases } = await freshCache();
    const runs = Array.from({ length: 8 }, () => releaseAssetBundle(intact().load));
    await Promise.all(runs.map((run) => run.materialize(directory)));
    expect(await readdir(releases)).toEqual([RELEASE]);
    expect(await releaseAssetBundle(intact().load).inspect(directory)).toBe("materialized");
  });

  test("concurrent runs replacing a stale directory all succeed", async () => {
    // Runs replacing the same stale directory can clear each other's way; repeat to hit it.
    for (let round = 0; round < 20; round += 1) {
      const { directory, releases } = await freshCache();
      const stale = intact([{ path: "old.txt", executable: false, data: text("old") }]);
      await releaseAssetBundle(stale.load).materialize(directory);
      const runs = Array.from({ length: 16 }, () => releaseAssetBundle(intact().load));
      await Promise.all(runs.map((run) => run.materialize(directory)));
      expect(await readdir(releases)).toEqual([RELEASE]);
      expect(await readdir(directory)).not.toContain("old.txt");
    }
  });
});

describe("install", () => {
  test("on its last attempt, leaves standing a current copy another run just installed", async () => {
    const { directory, releases } = await freshCache();
    const bundle = await intact().load();
    const putStale = async () => {
      await mkdir(directory);
      await writeFile(join(directory, "old.txt"), "old");
    };
    const copy = async (name: string) => {
      const path = join(releases, name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, MATERIALIZED_MARKER), markerFor(RELEASE, bundle.sha256));
      return path;
    };
    const staging = await copy(".staging");
    const winner = await copy(".winner");
    await putStale();
    let checks = 0;
    let movedAside = 0;
    const steps: InstallSteps = {
      // Something stale reappears after every move aside, so no rename of `staging` succeeds.
      async moveAside(from, to) {
        movedAside += 1;
        await rename(from, to);
        await putStale();
      },
      // On the last check, another run replaces the stale directory with its current copy
      // just after this run found it not current.
      async isCurrent() {
        checks += 1;
        if (checks === INSTALL_ATTEMPTS) {
          await rename(directory, join(releases, ".winner-cleared"));
          await rename(winner, directory);
        }
        return false;
      },
    };

    await expect(install(staging, directory, bundle, steps)).rejects.toThrow(
      `Could not replace ${directory}`,
    );

    expect(await releaseAssetBundle(intact().load).inspect(directory)).toBe("materialized");
    expect(movedAside).toBe(INSTALL_ATTEMPTS - 1);
  });
});

describe("inspect", () => {
  test("reports a missing bundle, and a tarball that fails its digest", async () => {
    const { directory } = await freshCache();
    expect(await releaseAssetBundle(async () => undefined).inspect(directory)).toBe("not_embedded");
    const tampered = bundleOf(packTarball(ENTRIES), RELEASE, "0".repeat(64));
    expect(await releaseAssetBundle(tampered.load).inspect(directory)).toBe("tampered");
  });

  test("reports absent, materialized and stale directories, creating nothing", async () => {
    const { cache, directory } = await freshCache();
    const assets = releaseAssetBundle(intact().load);
    expect(await assets.inspect(directory)).toBe("absent");
    expect(await readdir(cache)).toEqual([]);

    await assets.materialize(directory);
    expect(await assets.inspect(directory)).toBe("materialized");

    await writeFile(join(directory, MATERIALIZED_MARKER), markerFor(RELEASE, "0".repeat(64)));
    expect(await assets.inspect(directory)).toBe("stale");
    await rm(join(directory, MATERIALIZED_MARKER));
    expect(await assets.inspect(directory)).toBe("stale");
    await rm(directory, { recursive: true });
    await writeFile(directory, "not a directory");
    expect(await assets.inspect(directory)).toBe("stale");
  });

  test("rejects when the marker cannot be read", async () => {
    const { directory } = await freshCache();
    const assets = releaseAssetBundle(intact().load);
    await assets.materialize(directory);
    await chmod(join(directory, MATERIALIZED_MARKER), 0o000);
    try {
      // Root reads any file; there the marker stays readable.
      if (process.getuid?.() === 0) return;
      await expect(assets.inspect(directory)).rejects.toThrow("EACCES");
    } finally {
      await chmod(join(directory, MATERIALIZED_MARKER), 0o644);
    }
  });
});

describe("workerRelease (host protocol §apply)", () => {
  test("is the verified tarball and its digest when it carries the worker executable", async () => {
    const entries = [
      ...ENTRIES,
      { path: "bin/fffactory", executable: true, data: text("#!/bin/sh\n") },
    ];
    const tarball = packTarball(entries);
    const worker = await releaseAssetBundle(bundleOf(tarball).load).workerRelease();
    expect(worker).toEqual({ release: RELEASE, sha256: sha256Hex(tarball), tarball });
  });

  test("is undefined without an executable bin/fffactory, as when run from source", async () => {
    expect(await releaseAssetBundle(intact().load).workerRelease()).toBeUndefined();
    const plain = intact([
      ...ENTRIES,
      { path: "bin/fffactory", executable: false, data: text("not a program") },
    ]);
    expect(await releaseAssetBundle(plain.load).workerRelease()).toBeUndefined();
  });

  test("rejects a tampered or missing bundle", async () => {
    const tampered = bundleOf(packTarball(ENTRIES), RELEASE, "0".repeat(64));
    await expect(releaseAssetBundle(tampered.load).workerRelease()).rejects.toThrow(
      "do not match their recorded SHA-256 digest",
    );
    await expect(releaseAssetBundle(async () => undefined).workerRelease()).rejects.toThrow(
      "embeds no release assets",
    );
  });
});

describe("packAssetsDirectory", () => {
  test("adds the worker executable as bin/fffactory when given one", async () => {
    const assets = await mkdtemp(join(scratch, "assets-"));
    await writeFile(join(assets, "a.txt"), "a");
    const entries = unpackTarball(await packAssetsDirectory(assets, RELEASE, text("ELF")));
    expect(entries.map(({ path, executable }) => ({ path, executable }))).toEqual([
      { path: "a.txt", executable: false },
      { path: "bin/fffactory", executable: true },
      { path: "release.json", executable: false },
    ]);
    const clashing = await mkdtemp(join(scratch, "assets-"));
    await mkdir(join(clashing, "bin"));
    await writeFile(join(clashing, "bin", "fffactory"), "#!/bin/sh\n", { mode: 0o755 });
    await expect(packAssetsDirectory(clashing, RELEASE, text("ELF"))).rejects.toThrow(
      `Bundle entry "bin/fffactory" appears more than once`,
    );
  });

  test("bundles every regular file with its mode, skips CLAUDE.md and adds release.json", async () => {
    const assets = await mkdtemp(join(scratch, "assets-"));
    await mkdir(join(assets, "terraform", "modules"), { recursive: true });
    await writeFile(join(assets, "terraform", "modules", "main.tf"), "# module\n");
    await writeFile(join(assets, "setup.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(assets, "CLAUDE.md"), "# notes for agents\n");
    await writeFile(join(assets, "terraform", "CLAUDE.md"), "# notes\n");

    const entries = unpackTarball(await packAssetsDirectory(assets, RELEASE));

    expect(entries.map(({ path, executable }) => ({ path, executable }))).toEqual([
      { path: "release.json", executable: false },
      { path: "setup.sh", executable: true },
      { path: "terraform/modules/main.tf", executable: false },
    ]);
    const metadata = new TextDecoder().decode(entries[0]?.data);
    expect(JSON.parse(metadata)).toEqual({ release: RELEASE });
  });

  test("packs the same directory to the same bytes", async () => {
    const assets = await mkdtemp(join(scratch, "assets-"));
    await writeFile(join(assets, "a.txt"), "a");
    const first = await packAssetsDirectory(assets, RELEASE);
    expect(sha256Hex(await packAssetsDirectory(assets, RELEASE))).toBe(sha256Hex(first));
  });

  test("refuses a symbolic link and a checked-in release.json", async () => {
    const linked = await mkdtemp(join(scratch, "assets-"));
    await symlink("/etc/passwd", join(linked, "passwd"));
    await expect(packAssetsDirectory(linked, RELEASE)).rejects.toThrow(
      `Asset "passwd" is not a regular file or directory`,
    );
    const metadata = await mkdtemp(join(scratch, "assets-"));
    await writeFile(join(metadata, "release.json"), "{}");
    await expect(packAssetsDirectory(metadata, RELEASE)).rejects.toThrow(
      `Bundle entry "release.json" appears more than once`,
    );
  });

  // The activator bootstrap installed on every worker, part of its base, accepts a release.json
  // naming the release and nothing else: what a release declares beyond it stays in the
  // executable (`RELEASE_COMPATIBILITY`), or every existing worker would refuse the release.
  test("the repository's assets/ bundles this release's metadata: the release alone", async () => {
    const repositoryAssets = resolve(import.meta.dir, "../../assets");
    const entries = unpackTarball(await packAssetsDirectory(repositoryAssets, RELEASE));
    const metadata = entries.find((entry) => entry.path === "release.json");
    expect(JSON.parse(new TextDecoder().decode(metadata?.data))).toEqual({ release: RELEASE });
  });
});

describe("bundle sources", () => {
  test("a checkout bundle packs the assets directory and records the tarball's digest", async () => {
    const assets = await mkdtemp(join(scratch, "assets-"));
    await writeFile(join(assets, "a.txt"), "a");
    const bundle = await checkoutReleaseBundle(assets, RELEASE)();
    expect(bundle?.release).toBe(RELEASE);
    const tarball = (await bundle?.tarball()) ?? new Uint8Array();
    expect(bundle?.sha256).toBe(sha256Hex(tarball));
    expect(unpackTarball(tarball).map((entry) => entry.path)).toEqual(["a.txt", "release.json"]);
  });

  test("outside a compiled executable nothing is embedded", async () => {
    expect(await embeddedReleaseBundle(RELEASE)()).toBeUndefined();
  });

  test("an executable's bundle is the embedded file by name, with the recorded digest", async () => {
    const tarball = packTarball(ENTRIES);
    const named = (name: string) => Object.assign(new Blob([tarball]), { name });
    const files = [named("other.tar.gz"), named(EMBEDDED_BUNDLE_NAME)];
    const sha256 = sha256Hex(tarball);
    const bundle = await embeddedReleaseBundle(RELEASE, () => ({ files, sha256 }))();
    expect(bundle).toMatchObject({ release: RELEASE, sha256 });
    expect(await bundle?.tarball()).toEqual(tarball);

    const directory = (await freshCache()).directory;
    await releaseAssetBundle(async () => bundle).materialize(directory);
    expect(await readdir(directory)).toContain("release.json");
  });

  test("an executable missing the file or a valid digest embeds nothing", async () => {
    const file = Object.assign(new Blob([packTarball(ENTRIES)]), { name: EMBEDDED_BUNDLE_NAME });
    const sha256 = "a".repeat(64);
    const without = (embedded: Embedded) => embeddedReleaseBundle(RELEASE, () => embedded)();
    expect(await without({ files: [], sha256 })).toBeUndefined();
    expect(await without({ files: [file], sha256: undefined })).toBeUndefined();
    expect(await without({ files: [file], sha256: "not a digest" })).toBeUndefined();
  });
});
