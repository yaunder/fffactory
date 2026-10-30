/**
 * Real Git repositories for `host work inspect` (`docs/specs/host-protocol.md` §work inspect):
 * a remote outside the worker, clones and worktrees laid out under a temporary worker root, and
 * a process runner that runs the worker's Git commands as this test's user, after checking they
 * drop to the runtime account.
 */
import { expect } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_ROOT } from "../../src/domain/archive-format";
import {
  type Checkpoint,
  checkpointJson,
  COLLECTOR_CONFIGURATION,
  collectorConfigurationJson,
  type SourceCheckpoint,
} from "../../src/domain/collector";
import { COLLECTOR_STATE } from "../../src/domain/collector-installation";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import type { ApplySystem } from "../../src/host/apply";
import { CHECKPOINT, sourceId } from "../../src/host/collect";
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

/** A bare remote outside the worker, `NAME.git`, holding one commit on `main` (`NAME.txt`). */
export async function remote(world: GitWorld, name: string): Promise<string> {
  const url = join(world.outside, `${name}.git`);
  world.git(world.outside, "init", "--quiet", "--bare", "--initial-branch=main", url);
  const seed = join(world.outside, `${name}-seed`);
  world.git(world.outside, "clone", "--quiet", url, seed);
  await writeFile(join(seed, `${name}.txt`), `${name}\n`);
  world.git(seed, "add", `${name}.txt`);
  world.git(seed, "commit", "--quiet", "-m", name);
  world.git(seed, "push", "--quiet", "origin", "main");
  return url;
}

/** Git for submodules of local remotes, which Git refuses to clone over `file` by default. */
export function submoduleGit(world: GitWorld, cwd: string, ...args: string[]): string {
  return world.git(cwd, "-c", "protocol.file.allow=always", ...args);
}

/**
 * `url` added to the clone at `directory` as the submodule `path`, absorbed (its Git directory
 * in the clone's `.git/modules/`) and checked out on `main`, every submodule of it too, the
 * addition committed and pushed.
 */
export function addSubmodule(
  world: GitWorld,
  directory: string,
  url: string,
  path = "sub",
): string {
  submoduleGit(world, directory, "submodule", "add", "--quiet", url, path);
  submoduleGit(world, directory, "submodule", "update", "--quiet", "--init", "--recursive");
  world.git(directory, "commit", "--quiet", "-m", `add ${path}`);
  world.git(directory, "push", "--quiet", "origin", "main");
  return join(directory, path);
}

/** A Claude project's session evidence on the worker, as the log archive's collector finds it. */
export const PROJECT = `${CLAUDE_ROOT}/projects/-workspace-repos-acme-widget`;
export const SESSION = `${PROJECT}/0b6e1c3a.jsonl`;
export const SUBAGENT = `${PROJECT}/0b6e1c3a/subagents/agent-1.jsonl`;
export const TOOL_RESULT = `${PROJECT}/0b6e1c3a/tool-results/toolu_01.txt`;
/** When the checkpoint `saveCheckpoint` writes says the collector last succeeded. */
export const LAST_SUCCESS = "2026-10-30T10:15:00.000Z";

let written = 1_793_000_000;

/** Writes `content` to the worker's `path`, each write a later modification time. */
export async function putFile(world: GitWorld, path: string, content: string): Promise<void> {
  await mkdir(dirname(world.at(path)), { recursive: true });
  await writeFile(world.at(path), content);
  written += 1;
  await utimes(world.at(path), written, written);
}

/** The collector's configuration, as the `collector` install step writes it. */
export async function configureCollector(world: GitWorld): Promise<void> {
  await putFile(
    world,
    COLLECTOR_CONFIGURATION,
    collectorConfigurationJson({
      format: 1,
      factory_id: "fff-aaaa1111" as FactoryId,
      host_key: "builder-1" as HostKey,
      bucket: "fff-aaaa1111-logs-123456789012-eu-west-2-an",
      region: "eu-west-2",
    }),
  );
}

/** The checkpoint entry of `path` as a run captures it now: its identity, size and time. */
export async function captured(world: GitWorld, path: string): Promise<SourceCheckpoint> {
  const stats = await lstat(world.at(path), { bigint: true });
  return {
    source: sourceId(path),
    path,
    identity: `${stats.dev}:${stats.ino}`,
    mtime_ms: Number(stats.mtimeMs),
    generation: 1,
    length: Number(stats.size),
    prefix_sha256: "a".repeat(64),
  };
}

/** The collector's checkpoint holding `sources`, its last success `LAST_SUCCESS`. */
export async function saveCheckpoint(
  world: GitWorld,
  sources: readonly SourceCheckpoint[],
): Promise<void> {
  const checkpoint: Checkpoint = {
    format: 1,
    epoch: "20261030T101500Z-0123456789abcdef",
    next_seq: 2,
    saved_at: LAST_SUCCESS,
    last_success_at: LAST_SUCCESS,
    sources,
  };
  const directory = world.at(COLLECTOR_STATE);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, CHECKPOINT), `${checkpointJson(checkpoint)}\n`);
}

/**
 * The archiving worker (`fixtures/work-archive-backlog.json`): collected, no checkout, a session
 * grown by 6 bytes since its capture and a tool result never captured, 10 bytes: 2 files, 16
 * bytes unarchived.
 */
export async function archivingWorker(world: GitWorld): Promise<void> {
  await configureCollector(world);
  await putFile(world, SESSION, "0123456789");
  await saveCheckpoint(world, [await captured(world, SESSION)]);
  await putFile(world, SESSION, "0123456789+grown");
  await putFile(world, TOOL_RESULT, "new result");
}
