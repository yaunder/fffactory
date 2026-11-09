/**
 * Dispatch policy (`docs/specs/dispatch.md` §The dispatcher, §Capacity): the pure rules the
 * worker's dispatcher applies to what it observed. One case per rule the Python dispatcher's
 * tests held.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Agent, AGENT_STATES, parseActivityDocument } from "../../src/domain/control-plane";
import {
  adoptionReportJson,
  busyDispatched,
  capacityReached,
  DISPATCH_CAPACITY,
  dispatchBranch,
  dispatchRepositories,
  dispatchStamp,
  dispatchSummaryJson,
  epicBranch,
  externalDependencies,
  githubSlug,
  isClosed,
  isOpen,
  pullRequestFor,
  SKIPS,
  toolText,
} from "../../src/domain/dispatch-policy";

describe("capacity (dispatch §Capacity)", () => {
  test("a worker runs one dispatched epic agent at a time", () => {
    expect(DISPATCH_CAPACITY).toBe(1);
    expect(capacityReached(0)).toBe(false);
    expect(capacityReached(1)).toBe(true);
    expect(capacityReached(2)).toBe(true);
  });

  test("counts only dispatched agents working or needing input, by the busy rule", () => {
    const counted = AGENT_STATES.flatMap((state) =>
      [true, false].map((dispatched) => ({
        state,
        dispatched,
        busy: busyDispatched([{ id: "a", state, dispatched }]),
      })),
    );
    expect(counted.filter(({ busy }) => busy === 1)).toEqual([
      { state: "working", dispatched: true, busy: 1 },
      { state: "needs_input", dispatched: true, busy: 1 },
    ]);
    expect(counted.filter(({ busy }) => busy !== 0 && busy !== 1)).toEqual([]);
  });

  test("the activity document host agents prints holds one slot", async () => {
    const text = await readFile(
      join(import.meta.dir, "../host/fixtures/activity-agents.json"),
      "utf8",
    );
    const parsed = parseActivityDocument(text);
    if (!parsed.ok || parsed.document.kind !== "listed") throw new Error("fixture unreadable");
    expect(busyDispatched(parsed.document.agents)).toBe(1);
  });

  test("a launch takes the slot it found free", () => {
    const launched: Agent[] = [{ id: "agent-1", state: "working", dispatched: true }];
    expect(capacityReached(busyDispatched(launched))).toBe(true);
  });
});

describe("the repositories placed on the worker", () => {
  const manifest = (hosts: unknown, repositories?: unknown) =>
    JSON.stringify({
      version: 2,
      repositories: repositories ?? {
        zeta: { remote: "https://github.com/acme/zeta", path: "zeta", branch: "main" },
        alpha: { remote: "https://github.com/acme/alpha", path: "a/alpha", branch: "develop" },
      },
      repository_sets: { placed: ["zeta", "alpha"], other: ["alpha"] },
      hosts,
    });

  test("are every set the host names, by alias, sorted", () => {
    const placed = dispatchRepositories(
      manifest({ "test-host": { repository_sets: ["placed", "other"] } }),
      "test-host",
    );
    expect(placed).toEqual({
      ok: true,
      repositories: [
        {
          alias: "alpha",
          remote: "https://github.com/acme/alpha",
          path: "a/alpha",
          branch: "develop",
        },
        { alias: "zeta", remote: "https://github.com/acme/zeta", path: "zeta", branch: "main" },
      ],
    });
  });

  test("a host the manifest does not name is refused", () => {
    expect(dispatchRepositories(manifest({ other: { repository_sets: [] } }), "test-host")).toEqual(
      { ok: false, reason: "host test-host is absent from the deployed manifest" },
    );
  });

  test.each([
    ["not JSON", "{", "the repository manifest is not JSON"],
    ["a set it does not hold", manifest({ h: { repository_sets: ["missing"] } }), undefined],
    [
      "a repository without a branch",
      manifest({ h: { repository_sets: ["placed"] } }, { zeta: { remote: "r", path: "zeta" } }),
      undefined,
    ],
    [
      "an absolute path",
      manifest(
        { h: { repository_sets: ["placed"] } },
        { zeta: { remote: "r", path: "/zeta", branch: "main" } },
      ),
      undefined,
    ],
  ])("a manifest with %s is refused", (_name, text, reason) => {
    expect(dispatchRepositories(text, "h")).toEqual({
      ok: false,
      reason: reason ?? "the repository manifest is invalid",
    });
  });
});

describe("GitHub remotes", () => {
  test.each([
    ["https://github.com/Acme/Product.git", "acme/product"],
    ["http://github.com/acme/product/", "acme/product"],
    ["git@github.com:acme/product.git", "acme/product"],
    ["ssh://git@github.com/acme/my.repo", "acme/my.repo"],
    ["git://GITHUB.com/acme/product", "acme/product"],
  ])("%s names %s", (remote, slug) => {
    expect(githubSlug(remote)).toBe(slug);
  });

  test.each([
    "https://gitlab.com/acme/product",
    "https://github.com/acme",
    "https://github.com/acme/product/tree",
    "https://github.com/acme/product\n",
  ])("%s is unsupported", (remote) => {
    expect(githubSlug(remote)).toBeUndefined();
  });
});

describe("an epic's readiness", () => {
  const issue = (body: string, ...comments: string[]) => ({ body, comments });

  test("a task's dependency outside the epic, in its body or a comment, by number", () => {
    expect(
      externalDependencies(
        issue("Acceptance\n- Depends on: #300\n", "* depends on #12", "Depends on: #102"),
        new Set([102]),
      ),
    ).toEqual([12, 300]);
  });

  test("names a dependency only at the start of a line", () => {
    expect(externalDependencies(issue("see Depends on: #5"), new Set())).toEqual([]);
    expect(externalDependencies(issue("x\r\nDepends on: #5"), new Set())).toEqual([5]);
    expect(externalDependencies(issue("\n\n  Depends on: #6"), new Set())).toEqual([6]);
  });

  test("a number running into a word character is no dependency", () => {
    expect(externalDependencies(issue("Depends on: #7a"), new Set())).toEqual([]);
    expect(externalDependencies(issue("Depends on: #7."), new Set())).toEqual([7]);
  });

  test("an open pull request naming the task holds it, by its exact number", () => {
    const prs = [
      { number: 7, title: "Fix #1020", body: "" },
      { number: 8, title: "Fix", body: "Closes #102" },
    ];
    expect(pullRequestFor(102, prs)?.number).toBe(8);
    expect(pullRequestFor(10, prs)).toBeUndefined();
    expect(pullRequestFor(1, [{ number: 9, title: "x#1", body: "" }])?.number).toBe(9);
  });

  test("states are read regardless of case", () => {
    expect(isOpen("open")).toBe(true);
    expect(isOpen("CLOSED")).toBe(false);
    expect(isClosed("closed")).toBe(true);
    expect(isClosed("MERGED")).toBe(false);
  });

  test("its reasons", () => {
    expect(SKIPS.noTasks).toBe("no captured tasks");
    expect(SKIPS.taskNotOpen(102)).toBe("task #102 is not open");
    expect(SKIPS.openDependency(102, 300)).toBe("task #102 has open external dependency #300");
    expect(SKIPS.openPullRequest(102, 8)).toBe("task #102 has open PR #8");
    expect(SKIPS.branchExists(101)).toBe("remote branch epic/101 already exists");
    expect(SKIPS.capReached).toBe("host cap reached");
    expect(SKIPS.dispatched).toBe("existing dispatched agent");
    expect(SKIPS.adoption("x: y")).toBe("FFFlow adoption check failed: x: y");
  });
});

describe("the launch's inputs", () => {
  test("the dispatch branch carries the epic and the UTC stamp", () => {
    const stamp = dispatchStamp(new Date("2026-11-09T07:05:03.999Z"));
    expect(stamp).toBe("20261109T070503Z");
    expect(dispatchBranch(101, stamp)).toBe("dispatch/epic-101-20261109T070503Z");
    expect(epicBranch(101)).toBe("epic/101");
  });
});

describe("how the dispatcher reads its tools' text", () => {
  test("strips the whitespace around it", () => {
    expect(toolText("\n\t main  \n")).toBe("main");
    expect(toolText("a\nb\n")).toBe("a\nb");
  });
});

describe("the printed summaries, as JSON indented by two", () => {
  test("the tick's summary", () => {
    expect(
      dispatchSummaryJson({
        host: "test-host",
        cap: 1,
        running: 0,
        considered: [{ repository: "product", epic: 101 }],
        skipped: [
          {
            repository: "product",
            epic: 101,
            reason: "checkout is not at origin/main: café 😀",
          },
        ],
        started: [],
        running_after: 0,
      }),
    ).toBe(
      '{\n  "host": "test-host",\n  "cap": 1,\n  "running": 0,\n  "considered": [\n    {\n      "repository": "product",\n      "epic": 101\n    }\n  ],\n  "skipped": [\n    {\n      "repository": "product",\n      "epic": 101,\n      "reason": "checkout is not at origin/main: café 😀"\n    }\n  ],\n  "started": [],\n  "running_after": 0\n}',
    );
  });

  test("the adoption report", () => {
    expect(adoptionReportJson({ adoption: "failed", failed_repositories: ["b"] })).toBe(
      '{\n  "adoption": "failed",\n  "failed_repositories": [\n    "b"\n  ]\n}',
    );
  });
});
