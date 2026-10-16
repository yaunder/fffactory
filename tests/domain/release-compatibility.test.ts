import { describe, expect, test } from "bun:test";
import { type Release, SCHEMA_VERSION } from "../../src/domain/instance";
import {
  assessUpgrade,
  compareReleases,
  pinMove,
  RELEASE_COMPATIBILITY,
  type ReleaseCompatibility,
  schemaVersionChange,
} from "../../src/domain/release-compatibility";

const release = (value: string) => value as Release;

/** A running release that reads schema 1 and needs the base generation every release has. */
const COMPATIBLE: ReleaseCompatibility = {
  schema_version: 1,
  base_generation: 1,
  base_generation_since: release("0.0.0"),
};

describe("release order (semantic versioning precedence)", () => {
  test("orders by major, minor and patch numerically", () => {
    const ordered = ["0.0.0", "0.0.1", "0.0.10", "0.1.0", "0.9.9", "0.10.0", "1.0.0", "10.0.0"];
    for (const [index, earlier] of ordered.entries())
      for (const later of ordered.slice(index + 1)) {
        expect(compareReleases(release(earlier), release(later))).toBeLessThan(0);
        expect(compareReleases(release(later), release(earlier))).toBeGreaterThan(0);
      }
  });

  test("a prerelease precedes its release; prerelease identifiers compare numerically or in ASCII", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (const [index, earlier] of ordered.entries())
      for (const later of ordered.slice(index + 1))
        expect(compareReleases(release(earlier), release(later))).toBeLessThan(0);
  });

  test("equal releases compare equal, whatever leading zeros they carry", () => {
    expect(compareReleases(release("0.3.0"), release("0.3.0"))).toBe(0);
    expect(compareReleases(release("0.03.0"), release("0.3.0"))).toBe(0);
    expect(compareReleases(release("99999999999999999999.0.0"), release("1.0.0"))).toBeGreaterThan(
      0,
    );
  });
});

describe("the release's compatibility declaration (plan-apply §Upgrade)", () => {
  test("this release reads and writes factory.json's schema and declares its base generation", () => {
    expect(RELEASE_COMPATIBILITY.schema_version).toBe(SCHEMA_VERSION);
    expect(RELEASE_COMPATIBILITY.base_generation).toBe(2);
    expect(RELEASE_COMPATIBILITY.base_generation_since).toBe(release("0.0.1"));
  });
});

describe("upgrade compatibility (plan-apply §Upgrade)", () => {
  test("an earlier pin moves to the running release", () => {
    expect(assessUpgrade("0.2.0", release("0.3.0"), COMPATIBLE)).toEqual({
      kind: "upgrade",
      from: release("0.2.0"),
    });
    expect(assessUpgrade("0.3.0-rc.1", release("0.3.0"), COMPATIBLE)).toEqual({
      kind: "upgrade",
      from: release("0.3.0-rc.1"),
    });
  });

  test("the running release's own pin has nothing to upgrade", () => {
    expect(assessUpgrade("0.3.0", release("0.3.0"), COMPATIBLE)).toEqual({ kind: "current" });
  });

  test("a later pin is never moved back: downgrade is not supported", () => {
    expect(assessUpgrade("0.3.1", release("0.3.0"), COMPATIBLE)).toEqual({ kind: "downgrade" });
    expect(assessUpgrade("0.3.0", release("0.3.0-rc.1"), COMPATIBLE)).toEqual({
      kind: "downgrade",
    });
  });

  test("a missing or unreadable pin is not a release to upgrade from", () => {
    expect(assessUpgrade(undefined, release("0.3.0"), COMPATIBLE)).toEqual({ kind: "unpinned" });
    expect(assessUpgrade("latest", release("0.3.0"), COMPATIBLE)).toEqual({ kind: "unpinned" });
  });

  test("a release needing a newer base generation than the pinned release's is refused (D11)", () => {
    const newerBase: ReleaseCompatibility = {
      ...COMPATIBLE,
      base_generation: 2,
      base_generation_since: release("0.3.0"),
    };
    const assessment = assessUpgrade("0.2.9-SECRETLIKE", release("0.3.1"), newerBase);
    expect(assessment).toEqual({
      kind: "d11",
      refusal: {
        capability: "base migration",
        reasons: [
          "release 0.3.1 needs base generation 2, which arrived in release 0.3.0: workers set up by the release factory.json pins have an older base",
        ],
        instead:
          "factory.json still pins its release; keep using that release until base migration arrives.",
      },
    });
    expect(JSON.stringify(assessment)).not.toContain("SECRETLIKE");
  });

  test("a pin at or after the release that brought the base generation may move", () => {
    const newerBase: ReleaseCompatibility = {
      ...COMPATIBLE,
      base_generation: 2,
      base_generation_since: release("0.3.0"),
    };
    expect(assessUpgrade("0.3.0", release("0.3.1"), newerBase)).toEqual({
      kind: "upgrade",
      from: release("0.3.0"),
    });
  });
});

describe("the schema version check before factory.json is validated (plan-apply §Upgrade)", () => {
  const document = (schema: unknown) =>
    JSON.stringify({ schema_version: schema, release: "0.2.0" });

  test("the same schema version needs no migration", () => {
    expect(schemaVersionChange(document(1), COMPATIBLE)).toBeUndefined();
  });

  test("an earlier schema version needs schema migration, refused until M3 (D11)", () => {
    expect(schemaVersionChange(document(1), { ...COMPATIBLE, schema_version: 2 })).toEqual({
      kind: "d11",
      refusal: {
        capability: "schema migration",
        reasons: [
          "factory.json has schema version 1, and this release reads and writes schema version 2",
        ],
        instead:
          "factory.json still pins its release; keep using that release until schema migration arrives.",
      },
    });
  });

  test("a later schema version was written by a later release: a downgrade", () => {
    expect(schemaVersionChange(document(3), { ...COMPATIBLE, schema_version: 2 })).toEqual({
      kind: "downgrade",
    });
  });

  test("anything that is not a schema version is left to validation", () => {
    for (const text of ["", "[]", "{", document("1"), document(1.5), JSON.stringify({})])
      expect(schemaVersionChange(text, COMPATIBLE)).toBeUndefined();
  });
});

describe("the pin move shown with an upgrade's plan (plan-apply §Upgrade)", () => {
  test("names both releases when the pin is a plain release", () => {
    expect(pinMove("0.2.0", release("0.3.0"))).toEqual({
      from: release("0.2.0"),
      to: release("0.3.0"),
    });
  });

  test("never carries a pin whose prerelease text could hold anything", () => {
    for (const pin of ["0.2.9-SECRETLIKE", "0.2.9+build", "v0.2.9"]) {
      const move = pinMove(pin, release("0.3.0"));
      expect(move).toEqual({ from: "unshown", to: release("0.3.0") });
      expect(JSON.stringify(move)).not.toContain(pin);
    }
  });
});
