import { describe, expect, test } from "bun:test";
import { type Release, SCHEMA_VERSION } from "../../src/domain/instance";
import { describeD11Refusal } from "../../src/domain/plan";
import {
  assessUpgrade,
  compareReleases,
  describePinMove,
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
    expect(assessment.kind).toBe("d11");
    if (assessment.kind !== "d11") return;
    expect(describeD11Refusal(assessment.refusal)).toEqual([
      "Refusing: this change needs base migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  release 0.3.1 needs base generation 2, which arrived in release 0.3.0: workers set up by the release factory.json pins have an older base",
      "Nothing was applied. factory.json still pins its release; keep using that release until base migration arrives.",
    ]);
    expect(describeD11Refusal(assessment.refusal).join("\n")).not.toContain("SECRETLIKE");
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
    const change = schemaVersionChange(document(1), { ...COMPATIBLE, schema_version: 2 });
    expect(change?.kind).toBe("d11");
    if (change?.kind !== "d11") return;
    expect(describeD11Refusal(change.refusal)).toEqual([
      "Refusing: this change needs schema migration, which fffactory does not have yet (D11; it arrives in milestone M3):",
      "  factory.json has schema version 1, and this release reads and writes schema version 2",
      "Nothing was applied. factory.json still pins its release; keep using that release until schema migration arrives.",
    ]);
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

describe("the pin move's preview", () => {
  test("names both releases when the pin is a plain release", () => {
    expect(describePinMove("0.2.0", release("0.3.0"))).toEqual([
      "Upgrade: factory.json's release pin moves from 0.2.0 to 0.3.0. It is written once you approve this plan, before anything is applied.",
    ]);
  });

  test("never echoes a pin whose prerelease text could hold anything", () => {
    expect(describePinMove("0.2.9-SECRETLIKE", release("0.3.0"))).toEqual([
      "Upgrade: factory.json's release pin moves from the release it pins now to 0.3.0. It is written once you approve this plan, before anything is applied.",
    ]);
  });
});
