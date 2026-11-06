import { describe, expect, test } from "bun:test";
import type { FactoryId, HostKey, Repository } from "../../src/domain/instance";
import { repositoryManifest, repositoryManifestJson } from "../../src/domain/repository-placement";
import {
  type CheckoutRegistration,
  parseRepositoryRegistration,
  placedCheckouts,
  type RepositoryRegistration,
  repositoryRegistration,
  repositoryRegistrationDocument,
} from "../../src/domain/repository-registration";

function repo(key: string, path = key): Repository {
  return { key, remote: `https://github.com/yaunder/${key}`, path, branch: "main" };
}

function manifestText(placement: string[], inventory: Repository[]): string {
  return repositoryManifestJson(
    repositoryManifest(
      "fff-abcd1234" as FactoryId,
      { key: "builder-1" as HostKey, repositories: placement },
      inventory,
    ),
  );
}

describe("placed checkouts (docs/specs/dispatch.md §Repository registration)", () => {
  test("are the absolute paths under the repository root the manifest places, in placement order", () => {
    const text = manifestText(
      ["gamma", "alpha"],
      [repo("alpha"), repo("beta"), repo("gamma", "team/gamma")],
    );
    expect(placedCheckouts(text)).toEqual({
      ok: true,
      checkouts: ["/workspace/repos/team/gamma", "/workspace/repos/alpha"],
    });
  });

  test("a manifest placing nothing places no checkout", () => {
    expect(placedCheckouts(manifestText([], [repo("alpha")]))).toEqual({ ok: true, checkouts: [] });
  });

  test.each([
    ["not JSON", "{", "the repository manifest is not JSON"],
    ["another version", JSON.stringify({ version: 1 }), "the repository manifest is not version 2"],
    [
      "no placed set",
      JSON.stringify({ version: 2, repositories: {}, repository_sets: {} }),
      "the repository manifest is invalid",
    ],
    [
      "a placed key without its repository",
      JSON.stringify({ version: 2, repositories: {}, repository_sets: { placed: ["alpha"] } }),
      "the repository manifest is invalid",
    ],
    [
      "a path escaping the repository root",
      JSON.stringify({
        version: 2,
        repositories: { alpha: { path: "../etc" } },
        repository_sets: { placed: ["alpha"] },
      }),
      "the repository manifest is invalid",
    ],
    [
      "an absolute path",
      JSON.stringify({
        version: 2,
        repositories: { alpha: { path: "/etc" } },
        repository_sets: { placed: ["alpha"] },
      }),
      "the repository manifest is invalid",
    ],
  ])("refuses a manifest with %s, never quoting it", (_case, text, reason) => {
    expect(placedCheckouts(text)).toEqual({ ok: false, reason });
  });
});

describe("the registration result", () => {
  test("changed is whether any checkout was newly registered", () => {
    const present: CheckoutRegistration = { path: "/workspace/repos/a", state: "present" };
    const registered: CheckoutRegistration = { path: "/workspace/repos/b", state: "registered" };
    const failed: CheckoutRegistration = {
      path: "/workspace/repos/c",
      state: "failed",
      reason: "Paseo project create exited with status 1",
    };
    expect(repositoryRegistration("paseo", [present, failed]).changed).toBe(false);
    expect(repositoryRegistration("paseo", [present, registered, failed])).toEqual({
      backend: "paseo",
      checkouts: [present, registered, failed],
      changed: true,
    });
    expect(repositoryRegistration("paseo", []).changed).toBe(false);
  });
});

const RESULT: RepositoryRegistration = repositoryRegistration("paseo", [
  { path: "/workspace/repos/alpha", state: "registered" },
  { path: "/workspace/repos/team/beta", state: "present" },
  { path: "/workspace/repos/gamma", state: "failed", reason: "Paseo project create timed out" },
  { path: "/workspace/repos/delta", state: "not_applicable" },
]);

describe("the registration document", () => {
  test("has a stable key order, a failure's reason only on a failed checkout", () => {
    expect(JSON.stringify(repositoryRegistrationDocument(RESULT))).toBe(
      JSON.stringify({
        backend: "paseo",
        changed: true,
        checkouts: [
          { path: "/workspace/repos/alpha", state: "registered" },
          { path: "/workspace/repos/team/beta", state: "present" },
          {
            path: "/workspace/repos/gamma",
            state: "failed",
            reason: "Paseo project create timed out",
          },
          { path: "/workspace/repos/delta", state: "not_applicable" },
        ],
      }),
    );
  });

  test("parses back unchanged", () => {
    const document = JSON.parse(JSON.stringify(repositoryRegistrationDocument(RESULT)));
    expect(parseRepositoryRegistration(document)).toEqual(RESULT);
  });

  test("an absent document is no result, as an older worker's", () => {
    expect(parseRepositoryRegistration(undefined)).toBeUndefined();
  });

  test("ignores fields it does not know", () => {
    const document = {
      ...repositoryRegistrationDocument(RESULT),
      later: 1,
      checkouts: [{ path: "/workspace/repos/alpha", state: "registered", later: true }],
    };
    expect(parseRepositoryRegistration(document)).toEqual(
      repositoryRegistration("paseo", [{ path: "/workspace/repos/alpha", state: "registered" }]),
    );
  });

  const valid = () => JSON.parse(JSON.stringify(repositoryRegistrationDocument(RESULT)));
  test.each([
    ["not an object", () => []],
    ["an unknown backend", () => ({ ...valid(), backend: "herdr" })],
    ["no checkouts", () => ({ ...valid(), checkouts: undefined })],
    ["a non-boolean changed", () => ({ ...valid(), changed: "yes" })],
    ["changed disagreeing with the checkouts", () => ({ ...valid(), changed: false })],
    [
      "an unknown state",
      () => ({ ...valid(), checkouts: [{ path: "/workspace/repos/a", state: "archived" }] }),
    ],
    [
      "a path outside the repository root",
      () => ({ ...valid(), changed: false, checkouts: [{ path: "/etc", state: "present" }] }),
    ],
    [
      "a path escaping the repository root",
      () => ({
        ...valid(),
        changed: false,
        checkouts: [{ path: "/workspace/repos/../x", state: "present" }],
      }),
    ],
    [
      "a failure without a reason",
      () => ({
        ...valid(),
        changed: false,
        checkouts: [{ path: "/workspace/repos/a", state: "failed" }],
      }),
    ],
    [
      "a reason that is not one printable line",
      () => ({
        ...valid(),
        changed: false,
        checkouts: [{ path: "/workspace/repos/a", state: "failed", reason: "a\nb" }],
      }),
    ],
  ])("reads a malformed document (%s) as no result", (_case, document) => {
    expect(parseRepositoryRegistration(document())).toBeUndefined();
  });
});
