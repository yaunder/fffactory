import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPOSITORY_MANIFEST_PATH,
  REPOSITORY_RESULT_PATH,
} from "../../src/domain/repository-placement";
import type { Release } from "../../src/domain/instance";
import type { ApplySystem } from "../../src/host/apply";
import { workerRepositories } from "../../src/host/repositories";
import type { ProcessRunner } from "../../src/infrastructure/local-tool-probe";
import { system } from "./worker-scenarios";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-repositories-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function repositorySystem(run: ProcessRunner, overrides: Partial<ApplySystem> = {}): ApplySystem {
  return {
    ...system(root),
    run,
    now: () => new Date("2026-10-05T12:00:00.000Z"),
    isRoot: () => true,
    readInput: async () => '{"version":2}\n',
    release: "0.3.0" as Release,
    lock: async () => ({ release: () => {} }),
    ...overrides,
  };
}

describe("host repositories", () => {
  test("writes the manifest as root, runs the active release as factory, and persists its result", async () => {
    const calls: { argv: readonly string[]; options: unknown }[] = [];
    const run: ProcessRunner = async (argv, _timeout, options) => {
      calls.push({ argv, options });
      return {
        kind: "exited",
        exitCode: 0,
        stdout: '{"protocol_version":1,"state":"synchronized","unmanaged":["legacy/product"]}\n',
        stderr: "",
      };
    };
    const endpoint = workerRepositories(repositorySystem(run));
    expect(await endpoint.reconcileRepositories()).toEqual({
      protocol_version: 1,
      state: "synchronized",
      unmanaged: ["legacy/product"],
    });
    expect(await readFile(join(root, REPOSITORY_MANIFEST_PATH), "utf8")).toBe('{"version":2}\n');
    expect(calls[0]?.argv).toEqual([
      "runuser",
      "-u",
      "factory",
      "--",
      "env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "HOME=/home/factory",
      "LANG=C.UTF-8",
      join(root, "/opt/fffactory/current/steps/repositories/sync-repositories.sh"),
      "--apply",
      "--manifest",
      join(root, REPOSITORY_MANIFEST_PATH),
      "--json",
    ]);
    expect(JSON.parse(await readFile(join(root, REPOSITORY_RESULT_PATH), "utf8"))).toEqual({
      protocol_version: 1,
      state: "synchronized",
      unmanaged: ["legacy/product"],
    });
    expect(await endpoint.inspectRepositories()).toEqual({
      protocol_version: 1,
      state: "synchronized",
      unmanaged: ["legacy/product"],
    });
  });

  test("refuses reconciliation outside the root activator", async () => {
    const endpoint = workerRepositories(
      repositorySystem(async () => ({ kind: "not_found" }), { isRoot: () => false }),
    );
    expect(endpoint.reconcileRepositories()).rejects.toThrow("through the activator");
  });

  test("distinguishes an absent result from one that cannot be trusted", async () => {
    const endpoint = workerRepositories(repositorySystem(async () => ({ kind: "not_found" })));
    expect(await endpoint.inspectRepositories()).toEqual({ protocol_version: 1, state: "none" });

    const result = join(root, REPOSITORY_RESULT_PATH);
    await mkdir(join(result, ".."), { recursive: true });
    await writeFile(result, "not json");
    expect(await endpoint.inspectRepositories()).toEqual({
      protocol_version: 1,
      state: "unreadable",
    });
  });

  test.each([
    [{ kind: "timed_out" as const }, "timed out"],
    [{ kind: "not_found" as const }, "runuser is not installed"],
    [{ kind: "not_started" as const, code: "EACCES" }, "could not start (EACCES)"],
  ])("reports a repository synchronization process failure", async (outcome, message) => {
    const endpoint = workerRepositories(repositorySystem(async () => outcome));
    expect(endpoint.reconcileRepositories()).rejects.toThrow(message);
  });

  test.each([
    [{ kind: "exited" as const, exitCode: 0, stdout: "not json", stderr: "" }, "not JSON"],
    [
      {
        kind: "exited" as const,
        exitCode: 0,
        stdout: '{"protocol_version":1,"state":"none"}',
        stderr: "",
      },
      "no completed result",
    ],
    [
      {
        kind: "exited" as const,
        exitCode: 0,
        stdout: '{"protocol_version":1,"state":"unresolved","unmanaged":[]}',
        stderr: "",
      },
      "exit status disagrees",
    ],
  ])("rejects an untrusted completed synchronization result", async (outcome, message) => {
    const endpoint = workerRepositories(repositorySystem(async () => outcome));
    expect(endpoint.reconcileRepositories()).rejects.toThrow(message);
  });
});
