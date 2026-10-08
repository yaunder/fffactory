import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedTerraformPaths } from "../../../src/application/managed-terraform";
import {
  HASHICORP_RELEASES_URL,
  hashicorpPlatform,
  type ManagedTerraformOptions,
  managedTerraform,
  STALE_STAGING_MS,
} from "../../../src/infrastructure/terraform/installer";
import {
  type FakeHashicorpReleases,
  fakeHashicorpReleases,
  fakeTerraformRelease,
  fakeTerraformScript,
  type ReleaseFiles,
  zipName,
} from "../../support/fake-hashicorp-releases";
import { zipArchive } from "../../support/zip";

const VERSION = "1.16.4";
const LINUX = { os: "linux", arch: "x64" } as const;
const LINUX_ZIP = zipName(VERSION, "linux_amd64");
const release = fakeTerraformRelease(VERSION);

let scratch: string;
let cache: string;
const servers: FakeHashicorpReleases[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-terraform-installer-"));
  cache = join(scratch, "cache", "fffactory");
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  await rm(scratch, { recursive: true, force: true });
});

afterAll(() => {
  for (const server of servers.splice(0)) server.stop();
});

function serve(files: ReleaseFiles = release.files, options?: { stall?: boolean }) {
  const server = fakeHashicorpReleases(VERSION, files, options);
  servers.push(server);
  return server;
}

function installer(server: FakeHashicorpReleases, options: Partial<ManagedTerraformOptions> = {}) {
  return managedTerraform({
    distribution: release.distribution,
    releasesUrl: server.url,
    platform: LINUX,
    ...options,
  });
}

const paths = () => managedTerraformPaths(cache, VERSION);

/** Every file and directory under `directory`, relative to it. */
async function tree(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { recursive: true })).sort();
  } catch {
    return [];
  }
}

describe("hashicorpPlatform", () => {
  test.each([
    ["darwin", "arm64", "darwin_arm64"],
    ["darwin", "x64", "darwin_amd64"],
    ["linux", "x64", "linux_amd64"],
    ["linux", "arm64", "linux_arm64"],
  ])("names %s %s as %s", (os, arch, name) => {
    expect(hashicorpPlatform({ os, arch })).toBe(name);
  });

  test.each([
    ["win32", "x64"],
    ["freebsd", "x64"],
    ["linux", "ia32"],
  ])("has no supported build for %s %s", (os, arch) => {
    expect(hashicorpPlatform({ os, arch })).toBeUndefined();
  });
});

describe("managed Terraform install", () => {
  test("a cache miss downloads, verifies and installs the executable for this platform", async () => {
    const server = serve();
    const executable = await installer(server).install(cache);
    expect(executable).toBe(paths().executable);
    expect(await readFile(executable, "utf8")).toBe(fakeTerraformScript(VERSION));
    expect((await stat(executable)).mode & 0o777).toBe(0o755);
    expect(server.requests).toEqual([
      `/terraform/${VERSION}/${release.sumsName}`,
      `/terraform/${VERSION}/${LINUX_ZIP}`,
    ]);
    // Only the installed version remains: no staging directory and no zip archive.
    expect(await tree(paths().root)).toEqual([VERSION, `${VERSION}/terraform`]);
  });

  test("the executable is mode 0755 whatever the umask", async () => {
    const server = serve();
    const previous = process.umask(0o077);
    try {
      await installer(server).install(cache);
    } finally {
      process.umask(previous);
    }
    expect((await stat(paths().executable)).mode & 0o777).toBe(0o755);
  });

  test("an install removes staging directories an interrupted install left behind", async () => {
    const stale = join(paths().root, ".download-stale");
    const live = join(paths().root, ".download-live");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, LINUX_ZIP), "partial download");
    const old = new Date(Date.now() - STALE_STAGING_MS - 60_000);
    await utimes(stale, old, old);
    // A concurrent install's staging directory is recent, and is left alone.
    await mkdir(live);
    await installer(serve()).install(cache);
    expect(await tree(paths().root)).toEqual([".download-live", VERSION, `${VERSION}/terraform`]);
  });

  test("a cache hit uses the installed executable without any download", async () => {
    const server = serve();
    await installer(server).install(cache);
    const installed = await stat(paths().executable);
    server.stop();

    const again = await installer(server).install(cache);
    expect(again).toBe(paths().executable);
    expect(server.requests).toHaveLength(2);
    const after = await stat(again);
    expect([after.ino, after.mtimeMs]).toEqual([installed.ino, installed.mtimeMs]);
  });

  test("a zip that does not match SHA256SUMS is refused and the download deleted", async () => {
    const tampered = zipArchive([{ name: "terraform", data: "#!/bin/sh\necho evil\n" }]);
    const server = serve({ ...release.files, [LINUX_ZIP]: tampered });
    await expect(installer(server).install(cache)).rejects.toThrow(
      `${LINUX_ZIP} does not match its SHA-256 in HashiCorp's SHA256SUMS for Terraform ` +
        `${VERSION}; the download was deleted`,
    );
    expect(server.requests.at(-1)).toBe(`/terraform/${VERSION}/${LINUX_ZIP}`);
    expect(await tree(paths().root)).toEqual([]);
  });

  test("a SHA256SUMS that does not match the pinned digest is refused before any archive", async () => {
    const server = serve({ ...release.files, [release.sumsName]: "0".repeat(64) });
    await expect(installer(server).install(cache)).rejects.toThrow(
      `HashiCorp's SHA256SUMS for Terraform ${VERSION} does not match the digest ` +
        "fffactory pins; nothing was installed",
    );
    expect(server.requests).toEqual([`/terraform/${VERSION}/${release.sumsName}`]);
    expect(await tree(paths().root)).toEqual([]);
  });

  test("a platform missing from SHA256SUMS is refused", async () => {
    const server = serve();
    const install = installer(server, { platform: { os: "linux", arch: "arm64" } }).install(cache);
    await expect(install).rejects.toThrow(
      `HashiCorp's SHA256SUMS for Terraform ${VERSION} lists no ${zipName(VERSION, "linux_arm64")}`,
    );
    expect(await tree(paths().root)).toEqual([]);
  });

  test("an unsupported platform is refused without any download", async () => {
    const server = serve();
    const install = installer(server, { platform: { os: "win32", arch: "x64" } }).install(cache);
    await expect(install).rejects.toThrow(
      `FFFactory has no Terraform ${VERSION} build for win32 x64`,
    );
    expect(server.requests).toEqual([]);
  });

  test("an HTTP error names the status and installs nothing", async () => {
    const server = serve({ [release.sumsName]: release.files[release.sumsName] as string });
    await expect(installer(server).install(cache)).rejects.toThrow(
      `Downloading ${server.url}/${VERSION}/${LINUX_ZIP} failed with HTTP status 404`,
    );
    expect(await tree(paths().root)).toEqual([]);
  });

  test("a download that does not finish in time is abandoned", async () => {
    const server = serve(release.files, { stall: true });
    await expect(installer(server, { timeoutMs: 50 }).install(cache)).rejects.toThrow(
      `Downloading ${server.url}/${VERSION}/${release.sumsName} did not finish within 0.05 s`,
    );
    expect(await tree(paths().root)).toEqual([]);
  });

  test("an unreachable server is reported by error name, not message", async () => {
    const server = serve();
    server.stop();
    await expect(installer(server).install(cache)).rejects.toThrow(
      new RegExp(`^Could not download ${server.url}/${VERSION}/${release.sumsName} \\(\\w+\\)$`),
    );
  });

  test("a damaged copy is replaced", async () => {
    await mkdir(paths().versionDirectory, { recursive: true });
    await writeFile(paths().executable, "not terraform", { mode: 0o644 });
    await writeFile(join(paths().versionDirectory, "leftover"), "");
    const server = serve();
    await installer(server).install(cache);
    expect(await readFile(paths().executable, "utf8")).toBe(fakeTerraformScript(VERSION));
    expect(await tree(paths().versionDirectory)).toEqual(["terraform"]);
  });

  test("concurrent installs both succeed with one installed copy", async () => {
    const server = serve();
    const [first, second] = await Promise.all([
      installer(server).install(cache),
      installer(server).install(cache),
    ]);
    expect(first).toBe(paths().executable);
    expect(second).toBe(paths().executable);
    expect(await tree(paths().root)).toEqual([VERSION, `${VERSION}/terraform`]);
  });
});

describe("managed Terraform inspect", () => {
  test("nothing installed is absent, and inspecting creates nothing", async () => {
    const server = serve();
    expect(await installer(server).inspect(cache)).toBe("absent");
    expect(await tree(scratch)).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  test("an installed executable is installed", async () => {
    const server = serve();
    await installer(server).install(cache);
    expect(await installer(server).inspect(cache)).toBe("installed");
  });

  test("a file that is not executable is damaged", async () => {
    await mkdir(paths().versionDirectory, { recursive: true });
    await writeFile(paths().executable, "", { mode: 0o644 });
    expect(await installer(serve()).inspect(cache)).toBe("damaged");
  });

  test("a version directory without the executable is damaged", async () => {
    await mkdir(paths().versionDirectory, { recursive: true });
    expect(await installer(serve()).inspect(cache)).toBe("damaged");
  });

  test("a cache path that is a file holds no Terraform", async () => {
    await mkdir(join(scratch, "cache"), { recursive: true });
    await writeFile(cache, "");
    expect(await installer(serve()).inspect(cache)).toBe("absent");
  });

  test("an unsupported platform is reported as such", async () => {
    const probe = installer(serve(), { platform: { os: "freebsd", arch: "x64" } });
    expect(await probe.inspect(cache)).toBe("unsupported_platform");
  });

  test.skipIf(process.getuid?.() === 0)("other I/O errors are thrown", async () => {
    await mkdir(paths().root, { recursive: true });
    await chmod(paths().root, 0o000);
    try {
      await expect(installer(serve()).inspect(cache)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(paths().root, 0o755);
    }
  });
});

describe("managed Terraform defaults", () => {
  test("downloads from HashiCorp's release server", () => {
    expect(HASHICORP_RELEASES_URL).toBe("https://releases.hashicorp.com/terraform");
  });

  test("inspects the supported release for this platform", async () => {
    const supported = hashicorpPlatform({ os: process.platform, arch: process.arch });
    expect(await managedTerraform().inspect(cache)).toBe(
      supported === undefined ? "unsupported_platform" : "absent",
    );
  });
});
