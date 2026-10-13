/**
 * Real Git repositories for `host work inspect` (`docs/specs/host-protocol.md` §work inspect):
 * a remote outside the worker, clones and worktrees laid out under a temporary worker root, and
 * a process runner that runs the worker's Git commands as this test's user, after checking they
 * drop to the runtime account.
 */
import { expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Release } from "../../src/domain/instance";
import type { ApplySystem } from "../../src/host/apply";
import { bunProcessRunner, type ProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { system } from "./worker-scenarios";

/** What every Git command the worker runs starts with: the runtime account, a clean environment. */
export const AS_FACTORY = ["/usr/sbin/runuser", "-u", "factory", "--", "/usr/bin/env", "-i"];

export const CHECKOUT = "/workspace/repos/acme/widget";
export const PASEO = "/home/factory/.paseo/worktrees";

/** A worker root, a directory outside it holding the remote, and every command the worker ran. */
export interface GitWorld {
  readonly root: string;
  readonly outside: string;
  readonly origin: string;
  readonly commands: (readonly string[])[];
  /** Git for setting up repositories: no user or system configuration. */
  git(cwd: string, ...args: string[]): string;
  /** `path` under the worker root. */
  at(path: string): string;
  /** A clone of the remote at `path` under the worker root, on `main`, in step with it. */
  checkout(path?: string): Promise<string>;
  /** Runs the worker's commands as this user, the runtime account's home inside the root. */
  readonly run: ProcessRunner;
  /** A root worker over this world, for `workerWork`. */
  system(overrides?: Partial<ApplySystem>): ApplySystem;
  remove(): Promise<void>;
}

/** A remote holding one commit on `main` (a README and a `.gitignore` of `*.log`), no clones. */
export async function gitWorld(): Promise<GitWorld> {
  const root = await mkdtemp(join(tmpdir(), "fffactory-work-root-"));
  const outside = await mkdtemp(join(tmpdir(), "fffactory-work-outside-"));
  const origin = join(outside, "origin.git");
  const commands: (readonly string[])[] = [];
  const git = (cwd: string, ...args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: outside,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };
  const at = (path: string) => join(root, path);
  const run: ProcessRunner = async (argv, timeoutMs, options) => {
    commands.push(argv);
    expect(argv.slice(0, AS_FACTORY.length)).toEqual(AS_FACTORY);
    const rest = argv
      .slice(4)
      .map((token) =>
        token === "HOME=/home/factory" ? `HOME=${join(root, "home/factory")}` : token,
      );
    return bunProcessRunner(rest, timeoutMs, options);
  };
  git(outside, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  const seed = join(outside, "seed");
  git(outside, "clone", "--quiet", origin, seed);
  await writeFile(join(seed, "README.md"), "widget\n");
  await writeFile(join(seed, ".gitignore"), "*.log\n");
  git(seed, "add", "README.md", ".gitignore");
  git(seed, "commit", "--quiet", "-m", "first");
  git(seed, "push", "--quiet", "origin", "main");
  return {
    root,
    outside,
    origin,
    commands,
    git,
    at,
    run,
    async checkout(path = CHECKOUT) {
      const directory = at(path);
      await mkdir(join(directory, ".."), { recursive: true });
      git(outside, "clone", "--quiet", origin, directory);
      return directory;
    },
    system: (overrides = {}) => ({
      ...system(root),
      run,
      now: () => new Date(),
      isRoot: () => true,
      readInput: async () => "",
      release: "0.3.0" as Release,
      lock: async () => ({ release: () => {} }),
      ...overrides,
    }),
    async remove() {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}

/**
 * The reviewer's worker (`fixtures/work-unresolved.json`): synchronized, then an untracked
 * `uncommitted-work.txt` in the placed checkout, and a Paseo worktree on `epic/5` with a commit
 * pushed nowhere.
 */
export async function unresolvedWorker(world: GitWorld): Promise<void> {
  const directory = await world.checkout();
  await writeFile(join(directory, "uncommitted-work.txt"), "work\n");
  const worktree = world.at(`${PASEO}/abc123/serious-goose`);
  await mkdir(join(worktree, ".."), { recursive: true });
  world.git(directory, "worktree", "add", "--quiet", "-b", "epic/5", worktree, "origin/main");
  await writeFile(join(worktree, "feature.txt"), "feature\n");
  world.git(worktree, "add", "feature.txt");
  world.git(worktree, "commit", "--quiet", "-m", "feature");
}
