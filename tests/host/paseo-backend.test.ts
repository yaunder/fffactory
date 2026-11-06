import { describe, expect, test } from "bun:test";
import type { PaseoCommand } from "../../src/host/control-plane";
import { executionBackend } from "../../src/host/execution-backend";
import { paseoBackend } from "../../src/host/paseo-backend";
import type { ProcessOutcome } from "../../src/infrastructure/local-tool-probe";

const ALPHA = "/workspace/repos/alpha";
const BETA = "/workspace/repos/team/beta";
const GAMMA = "/workspace/repos/gamma";
/** What the auth wrapper holds; the adapter never has it, and must never pass one. */
const PASSWORD = "Paseo-pw 7f3e9aé";

/** A row of `paseo project ls --json`, as Paseo 0.15.0 prints it. */
function project(path: string) {
  return { projectId: `proj-${path.length}`, name: path.split("/").at(-1), kind: "git", path };
}

const exited = (exitCode: number, stdout = "", stderr = ""): ProcessOutcome => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr,
});

/**
 * A scripted Paseo CLI: `project ls` lists `registered` (or answers `ls`), `project create`
 * registers its path unless `create` answers otherwise for it. Records every call.
 */
function fakePaseo(
  registered: readonly string[],
  answers: { ls?: ProcessOutcome; create?: Readonly<Record<string, ProcessOutcome>> } = {},
) {
  const calls: (readonly string[])[] = [];
  const projects = [...registered];
  const paseo: PaseoCommand = async (args) => {
    calls.push([...args]);
    if (args[0] === "project" && args[1] === "ls")
      return answers.ls ?? exited(0, `${JSON.stringify(projects.map(project))}\n`);
    if (args[0] === "project" && args[1] === "create") {
      const path = args[2] as string;
      const answer = answers.create?.[path];
      if (answer !== undefined) return answer;
      projects.push(path);
      return exited(0, `${JSON.stringify(project(path))}\n`);
    }
    return exited(2, "", "unknown command");
  };
  return { paseo, calls };
}

describe("the Paseo execution backend (docs/specs/dispatch.md §Repository registration)", () => {
  test("nothing missing: lists once, creates nothing, changes nothing", async () => {
    const { paseo, calls } = fakePaseo([ALPHA, BETA, "/home/factory/elsewhere"]);
    expect(await paseoBackend(paseo).registerRepositories([ALPHA, BETA])).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "present" },
        { path: BETA, state: "present" },
      ],
      changed: false,
    });
    expect(calls).toEqual([["project", "ls", "--json"]]);
  });

  test("some missing: creates only those, in order, by their absolute path", async () => {
    const { paseo, calls } = fakePaseo([BETA]);
    expect(await paseoBackend(paseo).registerRepositories([ALPHA, BETA, GAMMA])).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "registered" },
        { path: BETA, state: "present" },
        { path: GAMMA, state: "registered" },
      ],
      changed: true,
    });
    expect(calls).toEqual([
      ["project", "ls", "--json"],
      ["project", "create", ALPHA, "--json"],
      ["project", "create", GAMMA, "--json"],
    ]);
  });

  test("a rerun after registering is a no-op", async () => {
    const { paseo, calls } = fakePaseo([]);
    const backend = paseoBackend(paseo);
    await backend.registerRepositories([ALPHA]);
    expect((await backend.registerRepositories([ALPHA])).changed).toBe(false);
    expect(calls.filter((call) => call[1] === "create")).toHaveLength(1);
  });

  test("no checkouts: nothing to register, nothing asked, nothing changed", async () => {
    const { paseo, calls } = fakePaseo([]);
    expect(await paseoBackend(paseo).registerRepositories([])).toEqual({
      backend: "paseo",
      checkouts: [],
      changed: false,
    });
    expect(calls).toEqual([]);
  });

  test.each([
    [exited(1, "", `AUTH_FAILED ${PASSWORD}`), "listing Paseo's projects exited with status 1"],
    [{ kind: "timed_out" } as const, "listing Paseo's projects timed out"],
    [{ kind: "not_found" } as const, "listing Paseo's projects could not be started (ENOENT)"],
    [
      { kind: "not_started", code: "EACCES" } as const,
      "listing Paseo's projects could not be started (EACCES)",
    ],
    [exited(0, "not json"), "Paseo's project list was invalid"],
    [exited(0, `${JSON.stringify({ path: ALPHA })}\n`), "Paseo's project list was invalid"],
    [exited(0, `${JSON.stringify([{ projectId: "p" }])}\n`), "Paseo's project list was invalid"],
  ])("listing fails (%#): every checkout fails, none is created", async (ls, reason) => {
    const { paseo, calls } = fakePaseo([], { ls });
    expect(await paseoBackend(paseo).registerRepositories([ALPHA, BETA])).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "failed", reason },
        { path: BETA, state: "failed", reason },
      ],
      changed: false,
    });
    expect(calls).toEqual([["project", "ls", "--json"]]);
  });

  test("one create fails: only it fails, in fffactory's words, never Paseo's output", async () => {
    const refused = exited(1, "", "PROJECT_CREATE_FAILED: Directory not found");
    const { paseo } = fakePaseo([], { create: { [BETA]: refused } });
    const result = await paseoBackend(paseo).registerRepositories([ALPHA, BETA, GAMMA]);
    expect(result).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "registered" },
        {
          path: BETA,
          state: "failed",
          reason: "registering it as a Paseo project exited with status 1",
        },
        { path: GAMMA, state: "registered" },
      ],
      changed: true,
    });
    expect(JSON.stringify(result)).not.toContain("Directory not found");
  });

  test("a create that times out fails that checkout alone", async () => {
    const { paseo } = fakePaseo([], { create: { [ALPHA]: { kind: "timed_out" } } });
    expect(await paseoBackend(paseo).registerRepositories([ALPHA])).toEqual({
      backend: "paseo",
      checkouts: [
        { path: ALPHA, state: "failed", reason: "registering it as a Paseo project timed out" },
      ],
      changed: false,
    });
  });

  test("only lists and creates: never deletes, archives or touches the daemon", async () => {
    const { paseo, calls } = fakePaseo([BETA], {
      create: { [GAMMA]: exited(1) },
    });
    await paseoBackend(paseo).registerRepositories([ALPHA, BETA, GAMMA]);
    expect(calls).toHaveLength(3);
    expect(
      calls.every((call) => call[0] === "project" && ["ls", "create"].includes(call[1] ?? "")),
    ).toBe(true);
  });

  test("the password never appears in an argument or the result", async () => {
    const leaky = exited(1, PASSWORD, `AUTH_FAILED: ${PASSWORD}`);
    const { paseo, calls } = fakePaseo([], { create: { [ALPHA]: leaky } });
    const result = await paseoBackend(paseo).registerRepositories([ALPHA, BETA]);
    const listingLeak = fakePaseo([], { ls: leaky });
    const listed = await paseoBackend(listingLeak.paseo).registerRepositories([ALPHA]);
    const seen = [...calls, ...listingLeak.calls].flat();
    expect(seen).toContain(ALPHA);
    expect(seen.filter((arg) => arg.includes(PASSWORD) || /password/i.test(arg))).toEqual([]);
    expect(JSON.stringify([result, listed])).not.toContain(PASSWORD);
  });
});

describe("the execution backend selection", () => {
  test("is Paseo, over the given Paseo command", async () => {
    const { paseo, calls } = fakePaseo([ALPHA]);
    const result = await executionBackend(paseo).registerRepositories([ALPHA]);
    expect(result.backend).toBe("paseo");
    expect(calls).toEqual([["project", "ls", "--json"]]);
  });
});
