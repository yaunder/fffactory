/**
 * `install.sh` against a local fake of the GitHub Releases API (docs/specs/release.md
 * §Distribution). Every run gets a private PATH of stand-ins (`uname`, `gh`, `sysctl`,
 * `sudo`, a logging `curl` wrapper) and links to the few real tools the script needs, and its
 * own HOME and TMPDIR, so no run reaches GitHub, the host's `gh` or the operator's own home
 * directory.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  completeRelease,
  type FakeGitHub,
  type FakeGitHubOptions,
  fakeExecutable,
  fakeGitHub,
  sha256sums,
} from "../support/fake-github-releases";

const INSTALL = resolve(import.meta.dir, "../../install.sh");
// Deliberately not GitHub token formats: these authenticate only to the local fake.
const TOKEN = "fake-install-test-credential";
const OTHER_TOKEN = "fake-other-install-credential";
/** Real tools the script may use; everything else on its PATH is a stand-in. */
const REAL_TOOLS = ["awk", "cat", "chmod", "cp", "mkdir", "mktemp", "mv", "rm", "tr"];

let scratch: string;
let github: FakeGitHub | undefined;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-install-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});
afterEach(() => {
  github?.stop();
  github = undefined;
});

function serve(options: Partial<FakeGitHubOptions> = {}): FakeGitHub {
  github = fakeGitHub({ releases: [completeRelease("v0.2.0")], token: TOKEN, ...options });
  return github;
}

interface Run {
  /** `uname -s` and `uname -m`. */
  readonly uname?: readonly [string, string];
  /** `gh auth token --hostname github.com` prints this token; "logged-out" fails. No gh when omitted. */
  readonly gh?: string;
  /** `sysctl -n sysctl.proc_translated` prints this. No sysctl when omitted. */
  readonly sysctl?: string;
  /** Which digest tool is on PATH. */
  readonly digest?: "sha256sum" | "shasum" | "none";
  /** Leaves curl off PATH. */
  readonly noCurl?: boolean;
  /** Extra variables; `PATH`, `HOME` and `TMPDIR` are the run's own unless given here. */
  readonly env?: Record<string, string>;
  /** Directories after the stand-ins on PATH. */
  readonly pathAfter?: string;
  readonly args?: readonly string[];
}

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly home: string;
  readonly work: string;
  /** The run's TMPDIR. */
  readonly tmp: string;
  /** Every argument every `curl` run received, one per line. */
  readonly curlArgs: string;
  /** The first argument of each `curl` run, one per line. */
  readonly curlFirstArgs: string;
  readonly ghArgs: string;
  readonly sudoArgs: string;
}

async function stub(directory: string, name: string, script: string) {
  const file = join(directory, name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
}

function realTool(name: string): string {
  const found = Bun.which(name);
  if (!found) throw new Error(`the install tests need ${name} on PATH`);
  return found;
}

async function toolPath(root: string, run: Run): Promise<string> {
  const bin = join(root, "bin");
  const log = join(root, "log");
  await mkdir(bin, { recursive: true });
  await mkdir(log);
  const links = REAL_TOOLS.map((tool) => stub(bin, tool, `exec ${realTool(tool)} "$@"`));
  await Promise.all(links);
  const [os, arch] = run.uname ?? ["Linux", "x86_64"];
  await stub(bin, "uname", `case "$1" in -m) echo ${arch} ;; *) echo ${os} ;; esac`);
  if (!run.noCurl) {
    const logArgs = `printf '%s\\n' "$@" >>${log}/curl\nprintf '%s\\n' "$1" >>${log}/curl-first`;
    await stub(bin, "curl", `${logArgs}\nexec ${realTool("curl")} "$@"`);
  }
  await stub(bin, "sudo", `echo "$*" >>${log}/sudo\nexit 1`);
  if (run.gh !== undefined) {
    const answer =
      run.gh === "logged-out"
        ? "echo 'no oauth token found for github.com' >&2; exit 1"
        : `echo ${run.gh}`;
    await stub(
      bin,
      "gh",
      `echo "$*" >>${log}/gh\n[ "$*" = "auth token --hostname github.com" ] || exit 2\n${answer}`,
    );
  }
  if (run.sysctl !== undefined) {
    await stub(bin, "sysctl", `[ "$*" = "-n sysctl.proc_translated" ] && echo ${run.sysctl}`);
  }
  await digestTool(bin, run.digest ?? "sha256sum");
  return bin;
}

/** The host's SHA-256 tool, exposed under the name the run asks for. */
async function digestTool(bin: string, digest: Run["digest"]) {
  const sha256sum = Bun.which("sha256sum");
  const shasum = Bun.which("shasum");
  if (digest === "sha256sum") {
    await stub(
      bin,
      "sha256sum",
      sha256sum ? `exec ${sha256sum} "$@"` : `exec ${shasum} -a 256 "$@"`,
    );
  } else if (digest === "shasum") {
    const body = sha256sum ? `shift 2\nexec ${sha256sum} "$@"` : `exec ${shasum} "$@"`;
    await stub(bin, "shasum", `[ "$1 $2" = "-a 256" ] || exit 2\n${body}`);
  }
}

async function install(server: FakeGitHub, run: Run = {}): Promise<Result> {
  const root = await mkdtemp(join(scratch, "run-"));
  const home = join(root, "home");
  const work = join(root, "work");
  const tmp = join(root, "tmp");
  await Promise.all([mkdir(home), mkdir(work), mkdir(tmp)]);
  const bin = await toolPath(root, run);
  const path = run.pathAfter ? `${bin}:${run.pathAfter}` : bin;
  const env = { PATH: path, HOME: home, TMPDIR: tmp, FFFACTORY_GITHUB_API: server.api, ...run.env };
  const child = Bun.spawn(["/bin/sh", INSTALL, ...(run.args ?? [])], {
    cwd: work,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const logged = (name: string) => readFile(join(root, "log", name), "utf8").catch(() => "");
  return {
    code,
    stdout,
    stderr,
    home,
    work,
    tmp,
    curlArgs: await logged("curl"),
    curlFirstArgs: await logged("curl-first"),
    ghArgs: await logged("gh"),
    sudoArgs: await logged("sudo"),
  };
}

const installed = (result: Result) => join(result.home, ".local", "bin", "fffactory");

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Every file under `directory` with its contents, by relative path. */
async function tree(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const pairs = await Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      return [relative(directory, path), await readFile(path, "utf8")] as const;
    }),
  );
  return Object.fromEntries(pairs);
}

/** Runs an installed stand-in executable and returns what it printed. */
function runInstalled(path: string): string {
  return Bun.spawnSync(["/bin/sh", path]).stdout.toString();
}

/** The run removed its temporary files. */
async function expectNoTemporaryFiles(result: Result) {
  expect(await readdir(result.tmp)).toEqual([]);
}

/** Every curl run started with -q, so it read no curl configuration file. */
function expectCurlConfigFilesIgnored(result: Result, runs: number) {
  expect(result.curlFirstArgs).toBe("-q\n".repeat(runs));
}

function expectNoTokenLeak(result: Result, ...tokens: string[]) {
  for (const token of tokens) {
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    expect(result.curlArgs).not.toContain(token);
  }
}

describe("install.sh authentication", () => {
  test("installs with GITHUB_TOKEN alone, keeping the token off command lines and output", async () => {
    const server = serve();
    const result = await install(server, { env: { GITHUB_TOKEN: TOKEN } });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Authenticating to GitHub with GITHUB_TOKEN");
    expect(result.stdout).toContain(
      `Installed fffactory 0.2.0 (linux-x64) at ${installed(result)}`,
    );
    expect(runInstalled(installed(result))).toBe("fake fffactory linux-x64 v0.2.0\n");
    expect((await stat(installed(result))).mode & 0o777).toBe(0o755);
    const apiRequests = server.requests.filter((request) => request.path.startsWith("/repos/"));
    expect(apiRequests.length).toBe(3);
    for (const request of apiRequests) expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    expectNoTokenLeak(result, TOKEN);
    expectCurlConfigFilesIgnored(result, 3);
    await expectNoTemporaryFiles(result);
  });

  test("installs with gh alone when GITHUB_TOKEN is unset", async () => {
    const server = serve();
    const result = await install(server, { gh: TOKEN });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.ghArgs).toBe("auth token --hostname github.com\n");
    expect(result.stdout).toContain("Authenticating to GitHub with gh auth token");
    expect(runInstalled(installed(result))).toBe("fake fffactory linux-x64 v0.2.0\n");
    expectNoTokenLeak(result, TOKEN);
  });

  test("prefers GITHUB_TOKEN over gh", async () => {
    const server = serve();
    const result = await install(server, { gh: OTHER_TOKEN, env: { GITHUB_TOKEN: TOKEN } });
    expect(result.code).toBe(0);
    expect(result.ghArgs).toBe("");
    expectNoTokenLeak(result, TOKEN, OTHER_TOKEN);
  });

  test("installs anonymously from a public repository when there are no credentials", async () => {
    const server = serve({ token: undefined });
    const result = await install(server, { gh: "logged-out" });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Downloading anonymously");
    expect(runInstalled(installed(result))).toBe("fake fffactory linux-x64 v0.2.0\n");
    for (const request of server.requests) expect(request.authorization).toBeNull();
    expectCurlConfigFilesIgnored(result, 3);
  });

  test("explains how to authenticate when an anonymous request cannot see the private release", async () => {
    const server = serve();
    const result = await install(server);
    expect(result.stderr).toContain("No release latest in yaunder/fffactory");
    expect(result.stderr).toContain("gh auth login");
    expect(result.stderr).toContain("GITHUB_TOKEN");
    expect(result.code).toBe(1);
    expect(await exists(installed(result))).toBe(false);
  });

  test("reports credentials GitHub refuses without echoing them", async () => {
    const server = serve();
    const result = await install(server, { env: { GITHUB_TOKEN: OTHER_TOKEN } });
    expect(result.stderr).toContain("GitHub refused the credentials from GITHUB_TOKEN (HTTP 401)");
    expect(result.code).toBe(1);
    expectNoTokenLeak(result, OTHER_TOKEN);
    await expectNoTemporaryFiles(result);
  });

  test("refuses a token with characters no GitHub token has, without echoing it", async () => {
    const server = serve();
    const token = 'ghp_bad"token';
    const result = await install(server, { env: { GITHUB_TOKEN: token } });
    expect(result.stderr).toContain("GITHUB_TOKEN does not look like a GitHub token");
    expect(result.code).toBe(1);
    expectNoTokenLeak(result, token);
    expect(server.requests).toEqual([]);
  });

  test("never sends the token past the asset redirect to another host", async () => {
    const server = serve();
    const result = await install(server, { env: { GITHUB_TOKEN: TOKEN } });
    expect(result.code).toBe(0);
    const storage = server.requests.filter((request) => request.path.startsWith("/storage/"));
    expect(storage.length).toBe(2);
    for (const request of storage) {
      expect(request.host).toStartWith("localhost:");
      expect(request.authorization).toBeNull();
    }
  });

  // curl reads a configuration file unless -q comes first; one that turns on `verbose`
  // would print the Authorization header, and `location-trusted` would send it past the
  // redirect.
  const hostileCurlrc = [
    "verbose",
    "location-trusted",
    "proto-redir = all",
    'header = "X-Leak: 1"',
    "",
  ].join("\n");
  const curlrcLocations = [
    { variable: "HOME", file: ".curlrc" },
    { variable: "CURL_HOME", file: ".curlrc" },
    // No dot: curl reads $XDG_CONFIG_HOME/curlrc.
    { variable: "XDG_CONFIG_HOME", file: "curlrc" },
  ] as const;
  for (const { variable, file } of curlrcLocations) {
    test(`ignores a curl configuration file at $${variable}/${file}`, async () => {
      const server = serve();
      const directory = await mkdtemp(join(scratch, "curlrc-"));
      await writeFile(join(directory, file), hostileCurlrc);
      const result = await install(server, { env: { GITHUB_TOKEN: TOKEN, [variable]: directory } });
      expectNoTokenLeak(result, TOKEN);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(server.requests.length).toBe(5);
      for (const request of server.requests) expect(request.headers["x-leak"]).toBeUndefined();
      const storage = server.requests.filter((request) => request.path.startsWith("/storage/"));
      expect(storage.length).toBe(2);
      for (const request of storage) expect(request.authorization).toBeNull();
    });
  }
});

describe("install.sh platform detection", () => {
  const supported = [
    { uname: ["Darwin", "arm64"], platform: "darwin-arm64" },
    { uname: ["Linux", "x86_64"], platform: "linux-x64" },
    { uname: ["Linux", "amd64"], platform: "linux-x64" },
  ] as const;
  for (const { uname, platform } of supported) {
    test(`${uname.join(" ")} installs fffactory-${platform}`, async () => {
      const result = await install(serve(), { uname, env: { GITHUB_TOKEN: TOKEN } });
      expect(result.code).toBe(0);
      expect(runInstalled(installed(result))).toBe(`fake fffactory ${platform} v0.2.0\n`);
    });
  }

  test("a shell translated by Rosetta on Apple Silicon installs darwin-arm64", async () => {
    const result = await install(serve(), {
      uname: ["Darwin", "x86_64"],
      sysctl: "1",
      env: { GITHUB_TOKEN: TOKEN },
    });
    expect(result.code).toBe(0);
    expect(runInstalled(installed(result))).toBe("fake fffactory darwin-arm64 v0.2.0\n");
  });

  const unsupported = [
    { uname: ["Darwin", "x86_64"], name: "darwin-x64" },
    { uname: ["Linux", "aarch64"], name: "linux-arm64" },
    { uname: ["FreeBSD", "amd64"], name: "freebsd-amd64" },
  ] as const;
  for (const { uname, name } of unsupported) {
    test(`refuses ${uname.join(" ")} before any download`, async () => {
      const server = serve();
      const result = await install(server, { uname, sysctl: "0", env: { GITHUB_TOKEN: TOKEN } });
      expect(result.stderr).toContain(
        `fffactory has no executable for ${name}; releases support darwin-arm64 and linux-x64`,
      );
      expect(result.code).toBe(1);
      expect(server.requests).toEqual([]);
      expect(await exists(installed(result))).toBe(false);
      await expectNoTemporaryFiles(result);
    });
  }
});

describe("install.sh integrity", () => {
  function withSums(sums: string) {
    const release = completeRelease("v0.2.0");
    const assets = release.assets.map((asset) =>
      asset.name === "SHA256SUMS" ? { name: "SHA256SUMS", content: sums } : asset,
    );
    return serve({ releases: [{ tag: "v0.2.0", assets }] });
  }

  test("refuses a checksum mismatch, keeping the installed executable and leaving nothing behind", async () => {
    const forged = sha256sums([
      fakeExecutable("darwin-arm64", "v0.2.0"),
      { name: "fffactory-linux-x64", content: "something else" },
    ]);
    const server = withSums(forged);
    const home = await mkdtemp(join(scratch, "home-"));
    const directory = join(home, ".local", "bin");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "fffactory"), "previous release\n");
    const result = await install(server, { env: { GITHUB_TOKEN: TOKEN, HOME: home } });
    expect(result.stderr).toContain(
      "The SHA-256 of fffactory-linux-x64 does not match SHA256SUMS; nothing was installed",
    );
    expect(result.code).toBe(1);
    expect(await tree(directory)).toEqual({ fffactory: "previous release\n" });
    await expectNoTemporaryFiles(result);
  });

  test("refuses when SHA256SUMS has no entry for the executable", async () => {
    const server = withSums(sha256sums([fakeExecutable("darwin-arm64", "v0.2.0")]));
    const result = await install(server, { env: { GITHUB_TOKEN: TOKEN } });
    expect(result.stderr).toContain("SHA256SUMS has no valid SHA-256 for fffactory-linux-x64");
    expect(result.code).toBe(1);
    expect(await exists(installed(result))).toBe(false);
  });

  test("verifies with shasum when sha256sum is missing", async () => {
    const result = await install(serve(), { digest: "shasum", env: { GITHUB_TOKEN: TOKEN } });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  test("refuses to install without a SHA-256 tool", async () => {
    const server = serve();
    const result = await install(server, { digest: "none", env: { GITHUB_TOKEN: TOKEN } });
    expect(result.stderr).toContain("needs sha256sum or shasum");
    expect(result.code).toBe(1);
    expect(server.requests).toEqual([]);
  });

  test("refuses to install without curl", async () => {
    const server = serve();
    const result = await install(server, { noCurl: true, env: { GITHUB_TOKEN: TOKEN } });
    expect(result.stderr).toContain("install.sh needs curl");
    expect(result.code).toBe(1);
  });

  for (const missing of ["fffactory-linux-x64", "SHA256SUMS"]) {
    test(`refuses a release without ${missing}`, async () => {
      const release = completeRelease("v0.2.0");
      const assets = release.assets.filter((asset) => asset.name !== missing);
      const server = serve({ releases: [{ tag: "v0.2.0", assets }] });
      const result = await install(server, { env: { GITHUB_TOKEN: TOKEN } });
      expect(result.stderr).toContain(
        `Release v0.2.0 of yaunder/fffactory has no asset ${missing}`,
      );
      expect(result.code).toBe(1);
      expect(await exists(installed(result))).toBe(false);
      await expectNoTemporaryFiles(result);
    });
  }

  test("finds assets in indented JSON", async () => {
    const result = await install(serve({ pretty: true }), { env: { GITHUB_TOKEN: TOKEN } });
    expect(result.code).toBe(0);
    expect(runInstalled(installed(result))).toBe("fake fffactory linux-x64 v0.2.0\n");
  });
});

describe("install.sh version selection", () => {
  const releases = [completeRelease("v0.2.0"), completeRelease("v0.1.0")];

  test("installs the latest release by default", async () => {
    const server = serve({ releases, latest: "v0.2.0" });
    const result = await install(server, { env: { GITHUB_TOKEN: TOKEN } });
    expect(result.code).toBe(0);
    expect(server.requests[0]?.path).toBe("/repos/yaunder/fffactory/releases/latest");
  });

  for (const version of ["0.1.0", "v0.1.0"]) {
    test(`FFFACTORY_VERSION=${version} installs release v0.1.0`, async () => {
      const server = serve({ releases });
      const env = { GITHUB_TOKEN: TOKEN, FFFACTORY_VERSION: version };
      const result = await install(server, { env });
      expect(result.code).toBe(0);
      expect(server.requests[0]?.path).toBe("/repos/yaunder/fffactory/releases/tags/v0.1.0");
      expect(result.stdout).toContain("Installed fffactory 0.1.0 (linux-x64)");
      expect(runInstalled(installed(result))).toBe("fake fffactory linux-x64 v0.1.0\n");
    });
  }

  test("reports a version that has no release", async () => {
    const server = serve({ releases });
    const env = { GITHUB_TOKEN: TOKEN, FFFACTORY_VERSION: "9.9.9" };
    const result = await install(server, { env });
    expect(result.stderr).toContain("No release v9.9.9 in yaunder/fffactory");
    expect(result.code).toBe(1);
  });

  test("refuses a version that is not a release version, before any request", async () => {
    const server = serve({ releases });
    const env = { GITHUB_TOKEN: TOKEN, FFFACTORY_VERSION: "../../latest" };
    const result = await install(server, { env });
    expect(result.stderr).toContain("FFFACTORY_VERSION must be a release version like 1.2.3");
    expect(result.code).toBe(1);
    expect(server.requests).toEqual([]);
  });
});

describe("install.sh install directory", () => {
  test("creates ~/.local/bin and warns when it is not on PATH", async () => {
    const result = await install(serve(), { env: { GITHUB_TOKEN: TOKEN } });
    expect(result.code).toBe(0);
    const directory = join(result.home, ".local", "bin");
    expect(result.stdout).toContain(`${directory} is not on PATH`);
    expect(await exists(installed(result))).toBe(true);
  });

  test("installs to FFFACTORY_INSTALL_DIR, with no warning when it is on PATH", async () => {
    const directory = await mkdtemp(join(scratch, "prefix-"));
    const env = { GITHUB_TOKEN: TOKEN, FFFACTORY_INSTALL_DIR: directory };
    const result = await install(serve(), { env, pathAfter: directory });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`at ${directory}/fffactory`);
    expect(result.stdout).not.toContain("is not on PATH");
    expect(await readdir(directory)).toEqual(["fffactory"]);
  });

  test("refuses a relative FFFACTORY_INSTALL_DIR", async () => {
    const server = serve();
    const env = { GITHUB_TOKEN: TOKEN, FFFACTORY_INSTALL_DIR: "bin" };
    const result = await install(server, { env });
    expect(result.stderr).toContain("FFFACTORY_INSTALL_DIR must be an absolute path");
    expect(result.code).toBe(1);
    expect(server.requests).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "refuses a directory it cannot write, without sudo",
    async () => {
      const directory = await mkdtemp(join(scratch, "locked-"));
      await chmod(directory, 0o555);
      const env = { GITHUB_TOKEN: TOKEN, FFFACTORY_INSTALL_DIR: directory };
      const result = await install(serve(), { env }).finally(() => chmod(directory, 0o755));
      expect(result.stderr).toContain(`Cannot write to ${directory}`);
      expect(result.code).toBe(1);
      expect(result.sudoArgs).toBe("");
    },
  );

  test("changes no instance and nothing in HOME but the executable", async () => {
    const server = serve();
    const home = await mkdtemp(join(scratch, "home-"));
    const instance = '{"schema_version": 1}\n';
    await mkdir(join(home, ".fffactory"));
    await writeFile(join(home, ".fffactory", "factory.json"), instance);
    const before = await tree(home);
    const result = await install(server, { env: { GITHUB_TOKEN: TOKEN, HOME: home } });
    expect(result.code).toBe(0);
    const after = await tree(home);
    expect(Object.keys(after).sort()).toEqual([".fffactory/factory.json", ".local/bin/fffactory"]);
    expect(after[".fffactory/factory.json"]).toBe(before[".fffactory/factory.json"] ?? "");
    expect(await readdir(result.work)).toEqual([]);
  });
});

describe("install.sh arguments", () => {
  test("--help describes the variables and installs nothing", async () => {
    const server = serve();
    const result = await install(server, { args: ["--help"] });
    expect(result.stdout).toContain("FFFACTORY_VERSION");
    expect(result.stdout).toContain("FFFACTORY_INSTALL_DIR");
    expect(result.stdout).toContain("sends the token to the host it names");
    expect(result.code).toBe(0);
    expect(server.requests).toEqual([]);
  });

  test("refuses any other argument", async () => {
    const result = await install(serve(), { args: ["--prefix", "/usr/local"] });
    expect(result.stderr).toContain("Usage:");
    expect(result.code).toBe(2);
  });
});
