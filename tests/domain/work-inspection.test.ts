import { describe, expect, test } from "bun:test";
import { HOST_PROTOCOL_VERSION } from "../../src/domain/protocol-fields";
import {
  INSPECT_WORK_COMMAND,
  parseWorkInspection,
  printableBranch,
  printablePath,
  type RepositoryWork,
  type WorkArchive,
  type WorkInspection,
  type WorktreeWork,
  workFindings,
  workInspectionJson,
} from "../../src/domain/work-inspection";

const HOSTNAME = "fff-abcd1234-builder-1";
const COUNTED = {
  state: "collected",
  complete: true,
  unarchived_files: 0,
  unarchived_bytes: 0,
  last_success_at: null,
};

function worktree(overrides: Partial<WorktreeWork> = {}): WorktreeWork {
  return {
    path: "/workspace/repos/acme/widget",
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
    path: "/workspace/repos/acme/widget",
    state: "inspected",
    unpushed_commits: 0,
    unpushed_branches: [],
    stashes: 0,
    worktrees: [worktree()],
    ...overrides,
  };
}

function inspection(
  repositories: readonly RepositoryWork[],
  overrides: Partial<WorkInspection> = {},
): WorkInspection {
  return {
    protocol_version: HOST_PROTOCOL_VERSION,
    hostname: HOSTNAME,
    complete: true,
    repositories,
    ...overrides,
  };
}

describe("the work inspection document (host-protocol §work inspect)", () => {
  test("serializes with a stable key order and reads back without loss", () => {
    const document = inspection([
      repository({
        unpushed_commits: 2,
        unpushed_branches: ["epic/5"],
        stashes: 1,
        worktrees: [
          worktree(),
          worktree({
            path: "/home/factory/.paseo/worktrees/abc/serious-goose",
            branch: null,
            untracked_files: 1,
            operation: "rebase",
          }),
          worktree({ path: null, state: "missing", unpushed_commits: 3 }),
        ],
      }),
      repository({ path: "/workspace/repos/acme/broken", state: "unreadable", worktrees: [] }),
    ]);
    const text = workInspectionJson(document);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "protocol_version",
      "hostname",
      "complete",
      "repositories",
    ]);
    expect(Object.keys(JSON.parse(text).repositories[0])).toEqual([
      "path",
      "state",
      "unpushed_commits",
      "unpushed_branches",
      "stashes",
      "worktrees",
    ]);
    expect(Object.keys(JSON.parse(text).repositories[0].worktrees[0])).toEqual([
      "path",
      "branch",
      "state",
      "tracked_changes",
      "untracked_files",
      "unpushed_commits",
      "operation",
    ]);
    const parsed = parseWorkInspection(text);
    expect(parsed).toEqual({ ok: true, document });
    if (parsed.ok) expect(workInspectionJson(parsed.document)).toBe(text);
  });

  test("carries the archive's backlog: not collected, or counted from the checkpoint", () => {
    const counted: WorkArchive = {
      state: "collected",
      complete: false,
      unarchived_files: 3,
      unarchived_bytes: 70_000,
      last_success_at: "2026-10-30T10:15:00.000Z",
    };
    for (const archive of [{ state: "not_collected" } as const, counted]) {
      const document = inspection([], { archive });
      const text = workInspectionJson(document);
      expect(Object.keys(JSON.parse(text))).toEqual([
        "protocol_version",
        "hostname",
        "complete",
        "repositories",
        "archive",
      ]);
      expect(parseWorkInspection(text)).toEqual({ ok: true, document });
    }
    expect(
      Object.keys(JSON.parse(workInspectionJson(inspection([], { archive: counted }))).archive),
    ).toEqual(["state", "complete", "unarchived_files", "unarchived_bytes", "last_success_at"]);
    const never = { ...counted, last_success_at: null };
    expect(parseWorkInspection(workInspectionJson(inspection([], { archive: never })))).toEqual({
      ok: true,
      document: inspection([], { archive: never }),
    });
  });

  test("an older worker's document, without the archive, still reads: its backlog is not reported", () => {
    const text = workInspectionJson(inspection([repository()]));
    expect(Object.keys(JSON.parse(text))).not.toContain("archive");
    const parsed = parseWorkInspection(text);
    expect(parsed).toEqual({ ok: true, document: inspection([repository()]) });
    if (parsed.ok) expect(parsed.document.archive).toBeUndefined();
  });

  test("a malformed archive section loses only the backlog: the work still reads and is judged", () => {
    const dirty = [repository({ worktrees: [worktree({ untracked_files: 2 })] })];
    const malformed: [string, unknown][] = [
      ["not an object", []],
      ["an unknown state", { state: "archived" }],
      ["complete", { ...COUNTED, complete: 1 }],
      ["files", { ...COUNTED, unarchived_files: 1.5 }],
      ["bytes", { ...COUNTED, unarchived_bytes: "1" }],
      ["last success", { ...COUNTED, last_success_at: "yesterday" }],
      ["null", null],
    ];
    for (const [, archive] of malformed) {
      const value = JSON.parse(workInspectionJson(inspection(dirty)));
      value.archive = archive;
      const parsed = parseWorkInspection(JSON.stringify(value));
      expect(parsed).toEqual({ ok: true, document: inspection(dirty) });
      if (!parsed.ok) continue;
      expect(parsed.document.archive).toBeUndefined();
      expect(workFindings(parsed.document, [])).toEqual(workFindings(inspection(dirty), []));
    }
  });

  test("ignores fields it does not know", () => {
    const value = JSON.parse(workInspectionJson(inspection([repository()])));
    value.later = true;
    value.repositories[0].later = 1;
    value.repositories[0].worktrees[0].later = "x";
    expect(parseWorkInspection(JSON.stringify(value))).toEqual({
      ok: true,
      document: inspection([repository()]),
    });
  });

  test("rejects another major version before reading anything else", () => {
    expect(parseWorkInspection('{"protocol_version":2,"repositories":"?"}')).toEqual({
      ok: false,
      kind: "unsupported_version",
      version: 2,
    });
  });

  test("names the first malformed field, never quoting it", () => {
    const valid = () => JSON.parse(workInspectionJson(inspection([repository()])));
    // biome-ignore lint/suspicious/noExplicitAny: parsed JSON, broken one field at a time
    type Json = Record<string, any>;
    const cases: [string, (value: Json) => void, string][] = [
      ["not JSON", () => {}, "the output is not JSON"],
      ["hostname", (v) => (v.hostname = "evil\u001b[31m"), "hostname is missing or malformed"],
      ["complete", (v) => (v.complete = "yes"), "complete must be true or false"],
      ["repositories", (v) => (v.repositories = {}), "repositories must be an array"],
      [
        "a path",
        (v) => (v.repositories[0].path = "relative/path"),
        "repositories[0].path is missing or malformed",
      ],
      [
        "an unprintable path",
        (v) => (v.repositories[0].worktrees[0].path = "/workspace/\u001b]0;x\u0007"),
        "repositories[0].worktrees[0].path is missing or malformed",
      ],
      [
        "a branch",
        (v) => (v.repositories[0].worktrees[0].branch = "a b"),
        "repositories[0].worktrees[0].branch is missing or malformed",
      ],
      [
        "a state",
        (v) => (v.repositories[0].state = "fine"),
        "repositories[0].state is not a known state",
      ],
      [
        "a count",
        (v) => (v.repositories[0].worktrees[0].untracked_files = -1),
        "repositories[0].worktrees[0].untracked_files must be a count",
      ],
      [
        "an operation",
        (v) => (v.repositories[0].worktrees[0].operation = "bisect"),
        "repositories[0].worktrees[0].operation is not a known state",
      ],
      [
        "unpushed branches",
        (v) => (v.repositories[0].unpushed_branches = ["ok", 3]),
        "repositories[0].unpushed_branches[1] is missing or malformed",
      ],
    ];
    for (const [name, change, problem] of cases) {
      const value = valid();
      change(value);
      const text = name === "not JSON" ? "{" : JSON.stringify(value);
      expect(parseWorkInspection(text)).toEqual({ ok: false, kind: "invalid", problem });
    }
  });

  test("refuses more repositories, worktrees or named branches than a worker reports", () => {
    const many = inspection(
      Array.from({ length: 101 }, (_, index) => repository({ path: `/workspace/repos/r${index}` })),
    );
    expect(parseWorkInspection(workInspectionJson(many))).toMatchObject({
      ok: false,
      problem: "repositories has too many entries",
    });
    const branches = inspection([
      repository({ unpushed_branches: Array.from({ length: 11 }, (_, index) => `b${index}`) }),
    ]);
    expect(parseWorkInspection(workInspectionJson(branches))).toMatchObject({
      ok: false,
      problem: "repositories[0].unpushed_branches has too many entries",
    });
  });

  test("printable paths and branches: printable ASCII and bounded, else nothing", () => {
    expect(printablePath("/workspace/repos/acme/widget")).toBe("/workspace/repos/acme/widget");
    expect(printablePath("/workspace/repos/with space")).toBe("/workspace/repos/with space");
    for (const unsafe of ["relative", "/a\nb", "/a\u001bb", "/café", `/${"a".repeat(300)}`])
      expect(printablePath(unsafe)).toBeNull();
    expect(printableBranch("epic/5")).toBe("epic/5");
    for (const unsafe of ["", "a b", "café", "a\u0007", "x".repeat(201)])
      expect(printableBranch(unsafe)).toBeNull();
  });

  test("is asked for through the activator's fixed work inspect operation", () => {
    expect([...INSPECT_WORK_COMMAND]).toEqual([
      "sudo",
      "-n",
      "/usr/local/libexec/fffactory-activate",
      "work",
      "inspect",
    ]);
  });
});

describe("what counts as unresolved work (worker-lifecycle §Gates (terminate))", () => {
  test("a worker with no checkouts, or only clean, pushed ones, holds none", () => {
    expect(workFindings(inspection([]), [])).toEqual({ unresolved: [], uninspected: [] });
    expect(
      workFindings(
        inspection([
          repository({
            worktrees: [
              worktree(),
              worktree({ path: "/home/factory/.paseo/worktrees/a/b", branch: "dispatch/x" }),
              // A worktree whose directory is gone, its HEAD pushed: nothing to lose.
              worktree({ path: "/home/factory/.paseo/worktrees/a/c", state: "missing" }),
            ],
          }),
        ]),
        ["acme/widget"],
      ),
    ).toEqual({ unresolved: [], uninspected: [] });
  });

  test("uncommitted, untracked, unpushed or stashed work, or an operation in progress, is unresolved", () => {
    const findings = workFindings(
      inspection([
        repository({
          unpushed_commits: 3,
          unpushed_branches: ["epic/5", "wip"],
          stashes: 2,
          worktrees: [
            worktree({ tracked_changes: 1 }),
            worktree({
              path: "/home/factory/.paseo/worktrees/abc/serious-goose",
              branch: "epic/5",
              tracked_changes: 2,
              untracked_files: 1,
              unpushed_commits: 3,
              operation: "merge",
            }),
            worktree({
              path: "/home/factory/.paseo/worktrees/abc/gone",
              branch: null,
              state: "missing",
              unpushed_commits: 1,
            }),
          ],
        }),
        repository({
          path: "/workspace/repos/acme/other",
          stashes: 1,
          worktrees: [worktree({ path: "/workspace/repos/acme/other", untracked_files: 1 })],
        }),
      ]),
      ["acme/widget", "acme/other"],
    );
    expect(findings).toEqual({
      unresolved: [
        "/workspace/repos/acme/widget: 3 commits on local branches not on any remote (epic/5, wip)",
        "/workspace/repos/acme/widget: 2 stash entries",
        "/workspace/repos/acme/widget (branch main): 1 changed file",
        "/home/factory/.paseo/worktrees/abc/serious-goose (branch epic/5): 2 changed files, 1 untracked file, 3 commits not on any remote, a merge in progress",
        "/home/factory/.paseo/worktrees/abc/gone (detached HEAD, its directory is gone): 1 commit not on any remote",
        "/workspace/repos/acme/other: 1 stash entry",
        "/workspace/repos/acme/other (branch main): 1 untracked file",
      ],
      uninspected: [],
    });
  });

  test("a repository or worktree that could not be read, or an incomplete inspection, is uninspected", () => {
    expect(
      workFindings(
        inspection(
          [
            repository({ path: null, state: "unreadable", worktrees: [] }),
            repository({
              path: "/workspace/repos/acme/b",
              worktrees: [worktree({ path: "/workspace/repos/acme/b", state: "unreadable" })],
            }),
          ],
          { complete: false },
        ),
        [],
      ),
    ).toEqual({
      unresolved: [],
      uninspected: [
        "A repository whose path cannot be printed: could not be read",
        "/workspace/repos/acme/b (branch main): could not be read",
        "The worker did not inspect every checkout and worktree in time, or found more than it reports",
      ],
    });
  });

  test("a checkout factory.json places on the worker that the inspection does not report is uninspected", () => {
    // A checkout deeper than the worker looks, or one never cloned: never read as clean.
    const placed = ["acme/widget", "acme/linked", "a/b/c/d/e"];
    expect(
      workFindings(
        inspection([
          repository({
            worktrees: [
              worktree(),
              // A placed checkout Git lists as a worktree of another is reported through it.
              worktree({ path: "/workspace/repos/acme/linked", branch: "linked" }),
            ],
          }),
        ]),
        placed,
      ),
    ).toEqual({
      unresolved: [],
      uninspected: [
        "/workspace/repos/a/b/c/d/e: placed on this worker, but the work inspection did not report it",
      ],
    });
  });
});
