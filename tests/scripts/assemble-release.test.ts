/**
 * `scripts/assemble-release.sh`, which the release workflow runs to check the tag and to
 * assemble the GitHub Release assets (docs/specs/release.md §Distribution). Each test runs a
 * copy of the script in a stand-in repository with its own package.json and install.sh.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../../package.json";

const ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts", "assemble-release.sh");
const EXECUTABLES = ["fffactory-darwin-arm64", "fffactory-linux-x64"] as const;

/** Headers of a 64-bit arm64 Mach-O and a 64-bit x86-64 ELF executable. */
const MACH_O_ARM64 = [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01];
const ELF_X64 = [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0, ...Array(10).fill(0), 0x3e, 0x00];

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-assemble-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function executable(header: number[], filler: string): Uint8Array {
  return new Uint8Array([...header, ...new TextEncoder().encode(filler)]);
}

const GOOD: Record<string, Uint8Array> = {
  "fffactory-darwin-arm64": executable(MACH_O_ARM64, "darwin body"),
  "fffactory-linux-x64": executable(ELF_X64, "linux body"),
};

/** A stand-in repository with the script, a package.json at `version` and an install.sh. */
async function repository(version: string): Promise<string> {
  const root = await mkdtemp(join(scratch, "repo-"));
  await mkdir(join(root, "scripts"));
  await copyFile(SCRIPT, join(root, "scripts", "assemble-release.sh"));
  const document = { name: "fffactory", version, private: true };
  await writeFile(join(root, "package.json"), `${JSON.stringify(document, null, 2)}\n`);
  await writeFile(join(root, "install.sh"), "#!/bin/sh\necho install\n");
  return root;
}

/** Downloaded artifacts, as the release workflow lays them out: modes lost. */
async function artifacts(files: Record<string, Uint8Array> = GOOD): Promise<string> {
  const directory = await mkdtemp(join(scratch, "artifacts-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content, { mode: 0o644 });
  }
  return directory;
}

function run(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["bash", join(root, "scripts", "assemble-release.sh"), ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      TMPDIR: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const sha256 = (content: Uint8Array | string) => createHash("sha256").update(content).digest("hex");

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      TMPDIR: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Release test",
      GIT_AUTHOR_EMAIL: "release@example.invalid",
      GIT_COMMITTER_NAME: "Release test",
      GIT_COMMITTER_EMAIL: "release@example.invalid",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function releaseRepository(): Promise<string> {
  const root = await repository("0.1.0");
  git(root, "init", "--initial-branch=main");
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial release");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

describe("assemble-release.sh check-source", () => {
  for (const annotated of [false, true]) {
    test(`accepts a ${annotated ? "annotated" : "lightweight"} tag on main`, async () => {
      const root = await releaseRepository();
      git(root, "tag", ...(annotated ? ["-a", "-m", "Release"] : []), "v0.1.0");
      const result = run(root, "check-source", "v0.1.0");
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });
  }

  test("accepts a released ancestor after main advances", async () => {
    const root = await releaseRepository();
    git(root, "tag", "v0.1.0");
    git(root, "commit", "--allow-empty", "-m", "Next change");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "checkout", "--detach", "v0.1.0");
    expect(run(root, "check-source", "v0.1.0").code).toBe(0);
  });

  test("refuses an unmerged commit even with a matching version tag", async () => {
    const root = await releaseRepository();
    git(root, "checkout", "-b", "unreviewed");
    git(root, "commit", "--allow-empty", "-m", "Unreviewed change");
    git(root, "tag", "v0.1.0");
    const result = run(root, "check-source", "v0.1.0");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not reachable from origin/main");
  });

  test("refuses a checkout that differs from the tag", async () => {
    const root = await releaseRepository();
    git(root, "tag", "v0.1.0");
    git(root, "commit", "--allow-empty", "-m", "Different commit");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const result = run(root, "check-source", "v0.1.0");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not match checked-out HEAD");
  });

  test("fails closed when origin/main was not fetched", async () => {
    const root = await releaseRepository();
    git(root, "tag", "v0.1.0");
    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    const result = run(root, "check-source", "v0.1.0");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("origin/main is missing");
  });

  test("fails closed when the tag is absent", async () => {
    const root = await releaseRepository();
    const result = run(root, "check-source", "v0.1.0");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has no commit");
  });
});

describe("assemble-release.sh check-tag", () => {
  test("accepts v and the package.json version of this repository", () => {
    const result = run(ROOT, "check-tag", `v${manifest.version}`);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`version=${manifest.version}\nprerelease=false\n`);
    expect(result.code).toBe(0);
  });

  test("marks a prerelease version", async () => {
    const root = await repository("0.1.0-rc.1");
    const result = run(root, "check-tag", "v0.1.0-rc.1");
    expect(result.stdout).toBe("version=0.1.0-rc.1\nprerelease=true\n");
    expect(result.code).toBe(0);
  });

  for (const tag of ["0.1.0", "v0.1.1", "v0.1.0-rc.1", "refs/tags/v0.1.0", "v0.1.0 "]) {
    test(`refuses tag "${tag}" for version 0.1.0`, async () => {
      const root = await repository("0.1.0");
      const result = run(root, "check-tag", tag);
      expect(result.stderr).toContain(
        `does not match package.json version 0.1.0; release it with tag v0.1.0`,
      );
      expect(result.stdout).toBe("");
      expect(result.code).toBe(1);
    });
  }

  test("refuses a package.json without a release version", async () => {
    const root = await repository("next");
    const result = run(root, "check-tag", "vnext");
    expect(result.stderr).toContain("package.json has no release version");
    expect(result.code).toBe(1);
  });

  test("refuses a missing tag", () => {
    const result = run(ROOT, "check-tag");
    expect(result.stderr).toContain("Usage:");
    expect(result.code).toBe(2);
  });
});

describe("assemble-release.sh assemble", () => {
  test("writes the four release assets, restoring modes, with SHA256SUMS over the executables", async () => {
    const root = await repository("0.1.0");
    const out = join(scratch, `release-${crypto.randomUUID()}`);
    const result = run(root, "assemble", "v0.1.0", await artifacts(), out);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const names = ["SHA256SUMS", "fffactory-darwin-arm64", "fffactory-linux-x64", "install.sh"];
    expect((await readdir(out)).sort()).toEqual(names);
    expect(result.stdout).toBe(names.map((name) => `${join(out, name)}\n`).join(""));
    for (const name of [...EXECUTABLES, "install.sh"]) {
      expect((await stat(join(out, name))).mode & 0o777).toBe(0o755);
    }
    expect(await readFile(join(out, "install.sh"), "utf8")).toBe("#!/bin/sh\necho install\n");
    expect(await readFile(join(out, "SHA256SUMS"), "utf8")).toBe(
      EXECUTABLES.map((name) => `${sha256(GOOD[name] as Uint8Array)}  ${name}\n`).join(""),
    );
  });

  test("digests the files it publishes, so sha256sum -c accepts them", async () => {
    const root = await repository("0.1.0");
    const out = join(scratch, `release-${crypto.randomUUID()}`);
    expect(run(root, "assemble", "v0.1.0", await artifacts(), out).code).toBe(0);
    const tool = Bun.which("sha256sum") ? ["sha256sum"] : ["shasum", "-a", "256"];
    const check = Bun.spawnSync([...tool, "-c", "SHA256SUMS"], { cwd: out });
    expect(check.stdout.toString()).toContain("fffactory-linux-x64: OK");
    expect(check.exitCode).toBe(0);
  });

  test("refuses a tag that does not match package.json, writing nothing", async () => {
    const root = await repository("0.1.0");
    const out = join(scratch, `release-${crypto.randomUUID()}`);
    const result = run(root, "assemble", "v0.2.0", await artifacts(), out);
    expect(result.stderr).toContain("does not match package.json version 0.1.0");
    expect(result.code).toBe(1);
    expect(await stat(out).catch(() => null)).toBeNull();
  });

  for (const name of EXECUTABLES) {
    test(`refuses artifacts without ${name}`, async () => {
      const root = await repository("0.1.0");
      const files = Object.fromEntries(Object.entries(GOOD).filter(([file]) => file !== name));
      const out = join(scratch, `release-${crypto.randomUUID()}`);
      const result = run(root, "assemble", "v0.1.0", await artifacts(files), out);
      expect(result.stderr).toContain(`${name} is missing`);
      expect(result.code).toBe(1);
      expect(await stat(out).catch(() => null)).toBeNull();
    });
  }

  test("refuses executables for the wrong platforms", async () => {
    const root = await repository("0.1.0");
    const swapped = {
      "fffactory-darwin-arm64": GOOD["fffactory-linux-x64"] as Uint8Array,
      "fffactory-linux-x64": GOOD["fffactory-darwin-arm64"] as Uint8Array,
    };
    const out = join(scratch, `release-${crypto.randomUUID()}`);
    const result = run(root, "assemble", "v0.1.0", await artifacts(swapped), out);
    expect(result.stderr).toContain("fffactory-darwin-arm64 is not an arm64 Mach-O executable");
    expect(result.code).toBe(1);
  });

  test("refuses an x86-64 Mach-O and an arm64 ELF", async () => {
    const root = await repository("0.1.0");
    const wrong = {
      "fffactory-darwin-arm64": executable([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0, 0, 0x01], "x"),
      "fffactory-linux-x64": GOOD["fffactory-linux-x64"] as Uint8Array,
    };
    const darwin = run(
      root,
      "assemble",
      "v0.1.0",
      await artifacts(wrong),
      join(scratch, `release-${crypto.randomUUID()}`),
    );
    expect(darwin.stderr).toContain("is not an arm64 Mach-O executable");
    const arm = [...ELF_X64];
    arm[18] = 0xb7;
    const linux = run(
      root,
      "assemble",
      "v0.1.0",
      await artifacts({ ...GOOD, "fffactory-linux-x64": executable(arm, "x") }),
      join(scratch, `release-${crypto.randomUUID()}`),
    );
    expect(linux.stderr).toContain("fffactory-linux-x64 is not an x86-64 ELF executable");
  });

  test("refuses an output directory that already exists", async () => {
    const root = await repository("0.1.0");
    const out = await mkdtemp(join(scratch, "existing-"));
    const result = run(root, "assemble", "v0.1.0", await artifacts(), out);
    expect(result.stderr).toContain(`${out} already exists`);
    expect(result.code).toBe(1);
    expect(await readdir(out)).toEqual([]);
  });
});
