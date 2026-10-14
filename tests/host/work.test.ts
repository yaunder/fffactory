/**
 * `host work inspect` against real Git repositories in a temporary worker root
 * (`docs/specs/host-protocol.md` §work inspect). Git runs as this test's user: the runner takes
 * off the `runuser` prefix the worker uses to drop to the runtime account, after checking it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { HOST_PROTOCOL_VERSION } from "../../src/domain/protocol-fields";
import {
  type RepositoryWork,
  type WorktreeWork,
  workFindings,
} from "../../src/domain/work-inspection";
import type { ApplySystem } from "../../src/host/apply";
import { WORK_BUDGET_MS, workerWork } from "../../src/host/work";
import {
  AS_FACTORY,
  addSubmodule,
  CHECKOUT,
  type GitWorld,
  gitWorld,
  PASEO,
  remote,
  submoduleGit,
} from "./work-scenarios";
import { WORKER_HOSTNAME } from "./worker-scenarios";

let world: GitWorld;
let outside: string;
let origin: string;
let commands: (readonly string[])[];
const git = (cwd: string, ...args: string[]) => world.git(cwd, ...args);
const at = (path: string) => world.at(path);
const checkout = (path?: string) => world.checkout(path);
const asTestUser: ApplySystem["run"] = (argv, timeoutMs, options) =>
  world.run(argv, timeoutMs, options);
const workSystem = (overrides: Partial<ApplySystem> = {}) => world.system(overrides);

function clean(path = CHECKOUT, overrides: Partial<WorktreeWork> = {}): WorktreeWork {
  return {
    path,
    branch: "main",
    state: "inspected",
    tracked_changes: 0,
    untracked_files: 0,
    unpushed_commits: 0,
    operation: null,
    ...overrides,
  };
}

function repository(overrides: Partial<RepositoryWork> = {}): RepositoryWork {
  return {
    path: CHECKOUT,
    state: "inspected",
    unpushed_commits: 0,
    unpushed_branches: [],
    stashes: 0,
    worktrees: [clean()],
    ...overrides,
  };
}

async function inspect(overrides: Partial<ApplySystem> = {}) {
  return workerWork(workSystem(overrides)).inspectWork();
}

beforeEach(async () => {
  world = await gitWorld();
  ({ outside, origin, commands } = world);
});

afterEach(async () => {
  await world.remove();
});

describe("host work inspect (host-protocol §work inspect)", () => {
  test("a worker without checkouts reports none, completely", async () => {
    expect(await inspect()).toEqual({
      protocol_version: HOST_PROTOCOL_VERSION,
      hostname: WORKER_HOSTNAME,
      complete: true,
      repositories: [],
    });
  });

  test("a clean checkout in step with its remote holds no work", async () => {
    await checkout();
    expect(await inspect()).toEqual({
      protocol_version: HOST_PROTOCOL_VERSION,
      hostname: WORKER_HOSTNAME,
      complete: true,
      repositories: [repository()],
    });
  });

  test("an untracked file made after the last synchronization is seen", async () => {
    const directory = await checkout();
    await writeFile(join(directory, "uncommitted-work.txt"), "work\n");
    expect((await inspect()).repositories).toEqual([
      repository({ worktrees: [clean(CHECKOUT, { untracked_files: 1 })] }),
    ]);
  });

  test("ignored files alone are no work", async () => {
    const directory = await checkout();
    await writeFile(join(directory, "build.log"), "noise\n");
    expect((await inspect()).repositories).toEqual([repository()]);
  });

  test("tracked changes, staged or not, are counted", async () => {
    const directory = await checkout();
    await writeFile(join(directory, "README.md"), "changed\n");
    await writeFile(join(directory, "staged.txt"), "new\n");
    git(directory, "add", "staged.txt");
    expect((await inspect()).repositories).toEqual([
      repository({ worktrees: [clean(CHECKOUT, { tracked_changes: 2 })] }),
    ]);
  });

  test("commits ahead of the upstream are unpushed, on the worktree and its branch", async () => {
    const directory = await checkout();
    await writeFile(join(directory, "README.md"), "ahead\n");
    git(directory, "commit", "--quiet", "-am", "ahead");
    expect((await inspect()).repositories).toEqual([
      repository({
        unpushed_commits: 1,
        unpushed_branches: ["main"],
        worktrees: [clean(CHECKOUT, { unpushed_commits: 1 })],
      }),
    ]);
  });

  test("a branch without an upstream carrying local commits is unpushed, checked out or not", async () => {
    const directory = await checkout();
    git(directory, "switch", "--quiet", "-c", "feature");
    await writeFile(join(directory, "feature.txt"), "feature\n");
    git(directory, "add", "feature.txt");
    git(directory, "commit", "--quiet", "-m", "feature");
    git(directory, "switch", "--quiet", "main");
    // A branch with no commits of its own holds nothing to lose.
    git(directory, "branch", "empty");
    expect((await inspect()).repositories).toEqual([
      repository({ unpushed_commits: 1, unpushed_branches: ["feature"] }),
    ]);
  });

  test("names at most 10 branches carrying unpushed commits, and counts every commit", async () => {
    const directory = await checkout();
    for (let index = 0; index < 12; index += 1) {
      git(directory, "switch", "--quiet", "-c", `wip-${String(index).padStart(2, "0")}`, "main");
      await writeFile(join(directory, `wip-${index}.txt`), "wip\n");
      git(directory, "add", ".");
      git(directory, "commit", "--quiet", "-m", `wip ${index}`);
    }
    git(directory, "switch", "--quiet", "main");
    const [found] = (await inspect()).repositories;
    expect(found?.unpushed_commits).toBe(12);
    expect(found?.unpushed_branches).toEqual(
      Array.from({ length: 10 }, (_, index) => `wip-${String(index).padStart(2, "0")}`),
    );
  });

  test("a stash entry is work", async () => {
    const directory = await checkout();
    await writeFile(join(directory, "README.md"), "stashed\n");
    git(directory, "stash", "--quiet");
    expect((await inspect()).repositories).toEqual([repository({ stashes: 1 })]);
  });

  test("a merge left in progress is reported", async () => {
    const directory = await checkout();
    git(directory, "switch", "--quiet", "-c", "feature");
    await writeFile(join(directory, "feature.txt"), "feature\n");
    git(directory, "add", "feature.txt");
    git(directory, "commit", "--quiet", "-m", "feature");
    git(directory, "switch", "--quiet", "main");
    git(directory, "merge", "--quiet", "--no-ff", "--no-commit", "feature");
    const [found] = (await inspect()).repositories;
    expect(found?.worktrees[0]).toEqual(
      clean(CHECKOUT, { tracked_changes: 1, operation: "merge" }),
    );
  });

  test("a dirty Paseo worktree of a checkout is reported with its branch", async () => {
    const directory = await checkout();
    const worktree = at(`${PASEO}/abc123/serious-goose`);
    await mkdir(join(worktree, ".."), { recursive: true });
    git(directory, "worktree", "add", "--quiet", "-b", "epic/5", worktree, "origin/main");
    await writeFile(join(worktree, "uncommitted-work.txt"), "work\n");
    expect((await inspect()).repositories).toEqual([
      repository({
        worktrees: [
          clean(),
          clean(`${PASEO}/abc123/serious-goose`, { branch: "epic/5", untracked_files: 1 }),
        ],
      }),
    ]);
  });

  test("a worktree whose directory is gone is missing; its unpushed HEAD still counts", async () => {
    const directory = await checkout();
    const worktree = at(`${PASEO}/abc123/gone`);
    await mkdir(join(worktree, ".."), { recursive: true });
    git(directory, "worktree", "add", "--quiet", "--detach", worktree, "origin/main");
    await writeFile(join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "--quiet", "-m", "detached work");
    await rm(worktree, { recursive: true, force: true });
    expect((await inspect()).repositories).toEqual([
      repository({
        worktrees: [
          clean(),
          clean(`${PASEO}/abc123/gone`, { branch: null, state: "missing", unpushed_commits: 1 }),
        ],
      }),
    ]);
  });

  test("a Paseo worktree of a repository kept elsewhere is found and inspected", async () => {
    const elsewhere = join(outside, "elsewhere");
    git(outside, "clone", "--quiet", origin, elsewhere);
    const worktree = at(`${PASEO}/def456/other`);
    await mkdir(join(worktree, ".."), { recursive: true });
    git(elsewhere, "worktree", "add", "--quiet", "-b", "spike", worktree, "origin/main");
    await writeFile(join(worktree, "spike.txt"), "spike\n");
    const [found] = (await inspect()).repositories;
    expect(found).toMatchObject({ path: `${PASEO}/def456/other`, state: "inspected" });
    expect(found?.worktrees).toContainEqual(
      clean(`${PASEO}/def456/other`, { branch: "spike", untracked_files: 1 }),
    );
  });

  /**
   * The stale registration: `a` added a worktree at `b`, `b` was removed without `git worktree
   * prune`, and an independent clone made there, with a branch commit pushed nowhere and a stash
   * entry. Git does not mark `a`'s entry prunable, since `b/.git` exists.
   */
  async function staleRegistration(b: string): Promise<string> {
    const a = await checkout("/workspace/repos/a");
    await mkdir(join(b, ".."), { recursive: true });
    git(a, "worktree", "add", "--quiet", "-b", "old", b, "origin/main");
    await rm(b, { recursive: true, force: true });
    git(outside, "clone", "--quiet", origin, b);
    git(b, "switch", "--quiet", "-c", "feature");
    await writeFile(join(b, "feature.txt"), "feature\n");
    git(b, "add", "feature.txt");
    git(b, "commit", "--quiet", "-m", "feature");
    git(b, "switch", "--quiet", "main");
    await writeFile(join(b, "README.md"), "stashed\n");
    git(b, "stash", "--quiet");
    expect(git(a, "worktree", "list", "--porcelain")).not.toContain("prunable");
    return a;
  }

  test("a stale worktree registration never hides an independent clone at its path", async () => {
    await staleRegistration(at("/workspace/repos/b"));
    const result = await inspect();
    expect(result.complete).toBe(true);
    expect(result.repositories).toEqual([
      repository({
        path: "/workspace/repos/a",
        worktrees: [
          clean("/workspace/repos/a"),
          clean("/workspace/repos/b", { branch: "old", state: "unreadable" }),
        ],
      }),
      repository({
        path: "/workspace/repos/b",
        unpushed_commits: 1,
        unpushed_branches: ["feature"],
        stashes: 1,
        worktrees: [clean("/workspace/repos/b")],
      }),
    ]);
    expect(workFindings(result, ["a", "b"]).unresolved).toEqual([
      "/workspace/repos/b: 1 commit on local branches not on any remote (feature)",
      "/workspace/repos/b: 1 stash entry",
    ]);
  });

  test("a stale worktree registration of a clone outside the roots never reads as clean", async () => {
    const b = join(outside, "b");
    await staleRegistration(b);
    const result = await inspect();
    expect(result.repositories).toEqual([
      repository({
        path: "/workspace/repos/a",
        worktrees: [clean("/workspace/repos/a"), clean(b, { branch: "old", state: "unreadable" })],
      }),
    ]);
    expect(workFindings(result, ["a"]).uninspected).toEqual([
      `${b} (branch old): could not be read`,
    ]);
  });

  test("a repository with no remote at all has every commit unpushed", async () => {
    const directory = at("/workspace/repos/local/only");
    await mkdir(directory, { recursive: true });
    git(directory, "init", "--quiet", "--initial-branch=main");
    await writeFile(join(directory, "a.txt"), "a\n");
    git(directory, "add", "a.txt");
    git(directory, "commit", "--quiet", "-m", "local");
    expect((await inspect()).repositories).toEqual([
      repository({
        path: "/workspace/repos/local/only",
        unpushed_commits: 1,
        unpushed_branches: ["main"],
        worktrees: [clean("/workspace/repos/local/only", { unpushed_commits: 1 })],
      }),
    ]);
  });

  test("a .git that Git cannot read is an unreadable repository, never skipped", async () => {
    await mkdir(at("/workspace/repos/acme/broken/.git"), { recursive: true });
    expect((await inspect()).repositories).toEqual([
      {
        path: "/workspace/repos/acme/broken",
        state: "unreadable",
        unpushed_commits: 0,
        unpushed_branches: [],
        stashes: 0,
        worktrees: [],
      },
    ]);
  });

  test("a directory it cannot read back, such as a name that is not UTF-8, leaves it incomplete", async () => {
    await checkout();
    await mkdir(Buffer.concat([Buffer.from(at("/workspace/repos/")), Buffer.from([0xff])]));
    const result = await inspect();
    expect(result.complete).toBe(false);
    expect(result.repositories).toEqual([repository()]);
  });

  test("a worktree Git cannot report on is unreadable, its repository still inspected", async () => {
    await checkout();
    const result = await inspect({
      run: async (argv, timeoutMs, options) =>
        argv.includes("status")
          ? { kind: "exited", exitCode: 128, stdout: "", stderr: "fatal" }
          : asTestUser(argv, timeoutMs, options),
    });
    expect(result.repositories).toEqual([
      repository({ worktrees: [clean(CHECKOUT, { state: "unreadable" })] }),
    ]);
    expect(result.complete).toBe(true);
  });

  test("symbolic links under the roots are not followed", async () => {
    const elsewhere = join(outside, "linked");
    git(outside, "clone", "--quiet", origin, elsewhere);
    await writeFile(join(elsewhere, "work.txt"), "work\n");
    await mkdir(at("/workspace/repos"), { recursive: true });
    await symlink(elsewhere, at("/workspace/repos/linked"));
    expect((await inspect()).repositories).toEqual([]);
  });

  test("a checkout deeper than it looks leaves it incomplete: never read as no work", async () => {
    // factory.json may place a checkout at any depth (`a/b/c/d/e`); the search stops at four.
    const directory = await checkout("/workspace/repos/a/b/c/d/e");
    await writeFile(join(directory, "uncommitted-work.txt"), "work\n");
    const deep = await inspect();
    expect(deep.complete).toBe(false);
    expect(deep.repositories).toEqual([]);
    // So does a Paseo worktree below its three levels.
    await world.remove();
    world = await gitWorld();
    await checkout(`${PASEO}/a/b/c/d`);
    expect((await inspect()).complete).toBe(false);
  });

  test("a bare repository under the roots leaves it incomplete: commits pushed only there are not safe", async () => {
    const mirror = at("/workspace/repos/acme/mirror.git");
    await mkdir(join(mirror, ".."), { recursive: true });
    git(outside, "clone", "--quiet", "--bare", origin, mirror);
    const directory = await checkout();
    git(directory, "remote", "set-url", "origin", mirror);
    await writeFile(join(directory, "README.md"), "pushed to the mirror\n");
    git(directory, "commit", "--quiet", "-am", "mirrored");
    git(directory, "push", "--quiet", "origin", "main");
    const result = await inspect();
    expect(result.complete).toBe(false);
    expect(result.repositories).toEqual([repository()]);
  });

  test("a directory at the depth limit without subdirectories leaves it complete", async () => {
    await mkdir(at("/workspace/repos/a/b/c/d"), { recursive: true });
    await writeFile(at("/workspace/repos/a/b/c/d/notes.txt"), "notes\n");
    await checkout("/workspace/repos/a/b/c/widget");
    const result = await inspect();
    expect(result.complete).toBe(true);
    expect(result.repositories.map((found) => found.path)).toEqual([
      "/workspace/repos/a/b/c/widget",
    ]);
  });

  test("a search root reached through a symbolic link is not followed: it leaves it incomplete", async () => {
    // As sync-repositories.sh refuses a symlinked repository root.
    for (const [linked, target] of [
      ["/workspace/repos", "/workspace/repos"],
      ["/home/factory/.paseo", PASEO],
    ] as const) {
      await world.remove();
      world = await gitWorld();
      const elsewhere = join(world.outside, "elsewhere");
      await mkdir(elsewhere, { recursive: true });
      await mkdir(join(at(linked), ".."), { recursive: true });
      await symlink(elsewhere, at(linked));
      await checkout(target);
      const result = await inspect();
      expect(result.complete).toBe(false);
      expect(result.repositories).toEqual([]);
    }
  });

  test("never runs a repository's LFS filter: what it would clean is compared as it is", async () => {
    // `git lfs install --system` on workers: `git status` would run the clean filter on a file
    // whose stat is stale, writing into `.git/lfs/objects`.
    const directory = await checkout();
    const marker = join(outside, "filter-ran");
    await writeFile(join(directory, ".git/info/attributes"), "* filter=lfs\n");
    git(directory, "config", "filter.lfs.clean", `echo clean >> ${marker}; cat`);
    git(directory, "config", "filter.lfs.process", `echo process >> ${marker}; exit 1`);
    git(directory, "config", "filter.lfs.required", "true");
    const later = new Date(Date.now() + 60_000);
    await utimes(join(directory, "README.md"), later, later);
    expect((await inspect()).repositories).toEqual([repository()]);
    await expect(lstat(marker)).rejects.toThrow();
  });

  test.skipIf(Bun.which("git-lfs") === null)(
    "with Git LFS, an LFS file reads as unchanged, and as changed once its stat is stale, writing nothing",
    async () => {
      const directory = await checkout();
      git(directory, "lfs", "install", "--local");
      git(directory, "lfs", "track", "*.bin");
      await writeFile(join(directory, "data.bin"), "large\n".repeat(1000));
      git(directory, "add", ".gitattributes", "data.bin");
      git(directory, "commit", "--quiet", "-m", "lfs");
      git(directory, "push", "--quiet", "--no-verify", "origin", "main");
      // The file older than the index, which a later Git command refreshed: not racily clean.
      const earlier = new Date(Date.now() - 60_000);
      await utimes(join(directory, "data.bin"), earlier, earlier);
      git(directory, "status", "--porcelain");
      await rm(join(directory, ".git/lfs"), { recursive: true, force: true });
      expect((await inspect()).repositories).toEqual([repository()]);
      const later = new Date(Date.now() + 60_000);
      await utimes(join(directory, "data.bin"), later, later);
      expect((await inspect()).repositories).toEqual([
        repository({ worktrees: [clean(CHECKOUT, { tracked_changes: 1 })] }),
      ]);
      await expect(lstat(join(directory, ".git/lfs"))).rejects.toThrow();
    },
  );

  test("changes nothing: no index refresh, no lock file, no fetch", async () => {
    const directory = await checkout();
    // A newer modification time without a change in content: `git status` would normally
    // refresh the index and write it back.
    const later = new Date(Date.now() + 60_000);
    await utimes(join(directory, "README.md"), later, later);
    const index = join(directory, ".git/index");
    const before = { bytes: await readFile(index), mtime: (await stat(index)).mtimeMs };
    const listing = await readdir(join(directory, ".git"));
    await inspect();
    expect(await readFile(index)).toEqual(before.bytes);
    expect((await stat(index)).mtimeMs).toBe(before.mtime);
    expect(await readdir(join(directory, ".git"))).toEqual(listing);
    await expect(lstat(join(directory, ".git/index.lock"))).rejects.toThrow();
    for (const argv of commands) {
      expect(argv).toContain("GIT_OPTIONAL_LOCKS=0");
      expect(argv).toContain("core.fsmonitor=false");
      expect(argv).toContain("filter.lfs.process=");
      for (const mutating of ["fetch", "pull", "gc", "prune", "update-index", "commit"])
        expect(argv).not.toContain(mutating);
    }
  });

  test("runs Git only as the runtime account, in a clean environment, each within its timeout", async () => {
    await checkout();
    const timeouts: number[] = [];
    await inspect({
      run: async (argv, timeoutMs, options) => {
        timeouts.push(timeoutMs);
        expect(options?.env).toEqual({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" });
        return asTestUser(argv, timeoutMs, options);
      },
    });
    expect(commands.length).toBeGreaterThan(0);
    for (const argv of commands)
      expect(argv.slice(0, 13)).toEqual([
        ...AS_FACTORY,
        "HOME=/home/factory",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "LANG=C",
        "LC_ALL=C",
        "GIT_OPTIONAL_LOCKS=0",
        "GIT_TERMINAL_PROMPT=0",
        "git",
      ]);
    for (const timeout of timeouts) expect(timeout).toBeLessThanOrEqual(20_000);
  });

  test("past its time budget it starts no more Git commands and says it is incomplete", async () => {
    await checkout();
    await checkout("/workspace/repos/acme/second");
    let now = 0;
    const result = await inspect({
      now: () => new Date(now),
      run: async (argv, timeoutMs, options) => {
        now += WORK_BUDGET_MS; // The first command uses up the whole budget.
        return asTestUser(argv, timeoutMs, options);
      },
    });
    expect(commands.length).toBe(1);
    expect(result.complete).toBe(false);
  });

  test("a file Git is told to assume unchanged makes its worktree unreadable: never read as clean", async () => {
    const directory = await checkout();
    git(directory, "update-index", "--assume-unchanged", "README.md");
    await writeFile(join(directory, "README.md"), "hidden edit\n");
    expect(git(directory, "status", "--porcelain")).toBe("");
    expect((await inspect()).repositories).toEqual([
      repository({ worktrees: [clean(CHECKOUT, { state: "unreadable" })] }),
    ]);
  });

  test("a file marked skip-worktree that is on disk makes its worktree unreadable", async () => {
    const directory = await checkout();
    git(directory, "update-index", "--skip-worktree", "README.md");
    await writeFile(join(directory, "README.md"), "hidden edit\n");
    expect(git(directory, "status", "--porcelain")).toBe("");
    expect((await inspect()).repositories).toEqual([
      repository({ worktrees: [clean(CHECKOUT, { state: "unreadable" })] }),
    ]);
  });

  test("a sparse checkout's files left out of the worktree are no work", async () => {
    const directory = await checkout();
    git(directory, "sparse-checkout", "set", "--no-cone", "/README.md");
    await expect(lstat(join(directory, ".gitignore"))).rejects.toThrow();
    expect((await inspect()).repositories).toEqual([repository()]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a directory Git warns it cannot open makes its worktree unreadable: status still exits 0",
    async () => {
      const directory = await checkout();
      const hidden = join(directory, "hidden");
      await mkdir(hidden);
      await writeFile(join(hidden, "work.txt"), "work\n");
      await chmod(hidden, 0o000);
      try {
        expect((await inspect()).repositories).toEqual([
          repository({ worktrees: [clean(CHECKOUT, { state: "unreadable" })] }),
        ]);
      } finally {
        await chmod(hidden, 0o755);
      }
    },
  );

  test("refuses to run except as root, through the activator", async () => {
    await expect(workerWork(workSystem({ isRoot: () => false })).inspectWork()).rejects.toThrow(
      "host work runs only through the activator",
    );
    expect(commands).toEqual([]);
  });
});

describe("host work inspect: submodules (host-protocol §work inspect)", () => {
  const SUB = `${CHECKOUT}/sub`;

  /** The submodule's repository entry: in step with its remote, on `main`, unless overridden. */
  function submodule(
    overrides: Partial<RepositoryWork> = {},
    worktree: Partial<WorktreeWork> = {},
    path = SUB,
  ): RepositoryWork {
    return repository({ path, worktrees: [clean(path, worktree)], ...overrides });
  }

  function unreadableAt(path: string): RepositoryWork {
    return {
      path,
      state: "unreadable",
      unpushed_commits: 0,
      unpushed_branches: [],
      stashes: 0,
      worktrees: [],
    };
  }

  /** The checkout with `sub` added, committed and pushed, and the submodule's directory. */
  async function withSubmodule(): Promise<{ directory: string; sub: string }> {
    const directory = await checkout();
    return { directory, sub: addSubmodule(world, directory, await remote(world, "sub")) };
  }

  test("a clean submodule in step with its remote holds no work", async () => {
    await withSubmodule();
    const result = await inspect();
    expect(result.complete).toBe(true);
    expect(result.repositories).toEqual([repository(), submodule()]);
  });

  test("a submodule commit pushed nowhere is unresolved, though the parent pushed its bump", async () => {
    const { directory, sub } = await withSubmodule();
    git(sub, "switch", "--quiet", "--detach");
    await writeFile(join(sub, "work.txt"), "work\n");
    git(sub, "add", "work.txt");
    git(sub, "commit", "--quiet", "-m", "work");
    git(directory, "add", "sub");
    git(directory, "commit", "--quiet", "-m", "bump sub");
    git(directory, "push", "--quiet", "origin", "main");
    const result = await inspect();
    expect(result.complete).toBe(true);
    expect(result.repositories).toEqual([
      repository(),
      submodule({}, { branch: null, unpushed_commits: 1 }),
    ]);
    expect(workFindings(result, ["acme/widget"]).unresolved).toEqual([
      `${SUB} (detached HEAD): 1 commit not on any remote`,
    ]);
  });

  test("a submodule's stash entry is unresolved", async () => {
    const { sub } = await withSubmodule();
    await writeFile(join(sub, "sub.txt"), "stashed\n");
    git(sub, "stash", "--quiet");
    expect((await inspect()).repositories).toEqual([repository(), submodule({ stashes: 1 })]);
  });

  test("a submodule's local branch not on its remote is unresolved", async () => {
    const { sub } = await withSubmodule();
    git(sub, "switch", "--quiet", "-c", "feature");
    await writeFile(join(sub, "feature.txt"), "feature\n");
    git(sub, "add", "feature.txt");
    git(sub, "commit", "--quiet", "-m", "feature");
    git(sub, "switch", "--quiet", "main");
    expect((await inspect()).repositories).toEqual([
      repository(),
      submodule({ unpushed_commits: 1, unpushed_branches: ["feature"] }),
    ]);
  });

  test("a change in a submodule's worktree is counted there, and in the parent", async () => {
    const { sub } = await withSubmodule();
    await writeFile(join(sub, "untracked.txt"), "work\n");
    expect((await inspect()).repositories).toEqual([
      repository({ worktrees: [clean(CHECKOUT, { tracked_changes: 1 })] }),
      submodule({}, { untracked_files: 1 }),
    ]);
  });

  test("a nested submodule is inspected too", async () => {
    const inner = await remote(world, "inner");
    const outer = await remote(world, "outer");
    addSubmodule(world, join(outside, "outer-seed"), inner, "inner");
    const directory = await checkout();
    const sub = addSubmodule(world, directory, outer);
    const nested = join(sub, "inner");
    await writeFile(join(nested, "inner.txt"), "changed\n");
    git(nested, "commit", "--quiet", "-am", "inner work");
    git(sub, "add", "inner");
    git(sub, "commit", "--quiet", "-m", "bump inner");
    git(directory, "add", "sub");
    git(directory, "commit", "--quiet", "-m", "bump sub");
    git(directory, "push", "--quiet", "origin", "main");
    const result = await inspect();
    expect(result.complete).toBe(true);
    expect(result.repositories).toEqual([
      repository(),
      submodule(
        { unpushed_commits: 1, unpushed_branches: ["main"] },
        { branch: "main", unpushed_commits: 1 },
      ),
      submodule({}, { branch: null, unpushed_commits: 1 }, `${SUB}/inner`),
    ]);
  });

  test("a submodule with its own .git directory is inspected", async () => {
    const directory = await checkout();
    const url = await remote(world, "sub");
    git(outside, "clone", "--quiet", url, join(directory, "sub"));
    const sub = addSubmodule(world, directory, url);
    expect((await lstat(join(sub, ".git"))).isDirectory()).toBe(true);
    await writeFile(join(sub, "sub.txt"), "changed\n");
    git(sub, "commit", "--quiet", "-am", "work");
    expect((await inspect()).repositories).toEqual([
      repository({ worktrees: [clean(CHECKOUT, { tracked_changes: 1 })] }),
      submodule({ unpushed_commits: 1, unpushed_branches: ["main"] }, { unpushed_commits: 1 }),
    ]);
  });

  test("a submodule of a linked worktree is inspected with it", async () => {
    const { directory } = await withSubmodule();
    const worktree = at(`${PASEO}/abc123/serious-goose`);
    await mkdir(join(worktree, ".."), { recursive: true });
    git(directory, "worktree", "add", "--quiet", "-b", "epic/5", worktree, "origin/main");
    submoduleGit(world, worktree, "submodule", "update", "--quiet", "--init");
    const nested = join(worktree, "sub");
    await writeFile(join(nested, "sub.txt"), "changed\n");
    git(nested, "commit", "--quiet", "-am", "work");
    const linked = `${PASEO}/abc123/serious-goose/sub`;
    expect((await inspect()).repositories).toEqual([
      repository({
        worktrees: [
          clean(),
          clean(`${PASEO}/abc123/serious-goose`, { branch: "epic/5", tracked_changes: 1 }),
        ],
      }),
      submodule(),
      submodule({}, { branch: null, unpushed_commits: 1 }, linked),
    ]);
  });

  test("files in a submodule's directory that Git does not manage are never read as clean", async () => {
    const { directory } = await withSubmodule();
    const fresh = await checkout("/workspace/repos/acme/fresh");
    await writeFile(join(fresh, "sub", "work.txt"), "work\n");
    expect(git(fresh, "status", "--porcelain")).toBe("");
    expect(directory).not.toBe(fresh);
    const result = await inspect();
    expect(result.repositories).toContainEqual(unreadableAt("/workspace/repos/acme/fresh/sub"));
  });

  test("an empty, never initialized submodule directory is no work", async () => {
    await withSubmodule();
    await checkout("/workspace/repos/acme/fresh");
    expect((await inspect()).repositories).toEqual([
      repository({
        path: "/workspace/repos/acme/fresh",
        worktrees: [clean("/workspace/repos/acme/fresh")],
      }),
      repository(),
      submodule(),
    ]);
  });

  test("a submodule's Git directory left behind by deinit is never read as no work", async () => {
    const { directory } = await withSubmodule();
    submoduleGit(world, directory, "submodule", "deinit", "--quiet", "--force", "sub");
    expect((await inspect()).repositories).toEqual([
      repository(),
      unreadableAt(`${CHECKOUT}/.git/modules/sub`),
    ]);
  });

  test("a submodule whose .git leads to another repository is unreadable", async () => {
    const { sub } = await withSubmodule();
    const elsewhere = join(outside, "elsewhere");
    git(outside, "clone", "--quiet", origin, elsewhere);
    await writeFile(join(sub, ".git"), `gitdir: ${join(elsewhere, ".git")}\n`);
    const result = await inspect();
    expect(result.repositories).toContainEqual(unreadableAt(SUB));
  });

  test("submodules count against the repositories it reports: past them, it is incomplete", async () => {
    // Directories holding files but no repository: each one reported, without a Git command.
    const directory = await checkout();
    const [head = ""] = git(directory, "rev-parse", "HEAD").split("\n");
    const paths = Array.from({ length: 100 }, (_, index) => `m${String(index).padStart(3, "0")}`);
    git(
      directory,
      "update-index",
      "--add",
      ...paths.flatMap((path) => ["--cacheinfo", `160000,${head},${path}`]),
    );
    for (const path of paths) {
      await mkdir(join(directory, path));
      await writeFile(join(directory, path, "work.txt"), "work\n");
    }
    const result = await inspect();
    expect(result.complete).toBe(false);
    expect(result.repositories).toEqual([
      repository({ worktrees: [clean(CHECKOUT, { tracked_changes: 100 })] }),
      ...paths.slice(0, 99).map((path) => unreadableAt(`${CHECKOUT}/${path}`)),
    ]);
  });
});
