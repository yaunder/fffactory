/**
 * `host work inspect` against real Git repositories in a temporary worker root
 * (`docs/specs/host-protocol.md` §work inspect). Git runs as this test's user: the runner takes
 * off the `runuser` prefix the worker uses to drop to the runtime account, after checking it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
import type { RepositoryWork, WorktreeWork } from "../../src/domain/work-inspection";
import type { ApplySystem } from "../../src/host/apply";
import { WORK_BUDGET_MS, workerWork } from "../../src/host/work";
import { AS_FACTORY, CHECKOUT, type GitWorld, gitWorld, PASEO } from "./work-scenarios";
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

  test("refuses to run except as root, through the activator", async () => {
    await expect(workerWork(workSystem({ isRoot: () => false })).inspectWork()).rejects.toThrow(
      "host work runs only through the activator",
    );
    expect(commands).toEqual([]);
  });
});
