import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE } from "../../../src/cli/release";
import {
  assessUpgrade,
  compareReleases,
  RELEASE_COMPATIBILITY,
} from "../../../src/domain/release-compatibility";
import { sha256Hex } from "../../../src/infrastructure/release-tarball";

const BOOTSTRAP = join(import.meta.dir, "../../../assets/terraform/bootstrap");

/**
 * The SHA-256 of the worker bootstrap each base generation describes. Bootstrap sets up a
 * worker's base once, at its first boot, and an upgrade never reruns it. After changing the
 * bootstrap, decide: if a release's install steps or worker executable will rely on the change,
 * raise `RELEASE_COMPATIBILITY.base_generation` (with `base_generation_since`, the release that
 * raises it) and record the new digest under the new generation, so `fffactory upgrade`
 * refuses to install that release on workers with the older base (plan-apply §Upgrade);
 * otherwise record the new digest under the same generation.
 */
const BOOTSTRAP_OF_GENERATION: Readonly<Record<number, string>> = {
  1: "0b5940daa3375b9cc33cb299499849fc677441197099fd4b06efa1810937213b",
  2: "81718968693c26131bef92a4a7ac7ec81cb786eca273de81620966e7ab8a8348",
};

/** The bootstrap's files, as a worker receives them: every file here but CLAUDE.md. */
function bootstrapDigest(): string {
  const files = readdirSync(BOOTSTRAP)
    .filter((name) => name !== "CLAUDE.md")
    .sort();
  const text = files.map((name) => `${name}\0${readFileSync(join(BOOTSTRAP, name), "utf8")}\0`);
  return sha256Hex(new TextEncoder().encode(text.join("")));
}

describe("the base generation (plan-apply §Upgrade)", () => {
  test("the worker bootstrap is the one this release's base generation describes", () => {
    expect({
      base_generation: RELEASE_COMPATIBILITY.base_generation,
      bootstrap_sha256: bootstrapDigest(),
    }).toEqual({
      base_generation: RELEASE_COMPATIBILITY.base_generation,
      bootstrap_sha256: BOOTSTRAP_OF_GENERATION[RELEASE_COMPATIBILITY.base_generation] ?? "none",
    });
  });

  test("the release that brought the base generation is no later than this release", () => {
    expect(
      compareReleases(RELEASE_COMPATIBILITY.base_generation_since, RELEASE),
    ).toBeLessThanOrEqual(0);
  });

  test("a factory pinned to the release that brought the base generation may move to this one", () => {
    const { kind } = assessUpgrade(
      RELEASE_COMPATIBILITY.base_generation_since,
      RELEASE,
      RELEASE_COMPATIBILITY,
    );
    expect(["current", "upgrade"]).toContain(kind);
  });

  test("a factory pinned before generation 2's first release, 0.0.1, is refused base migration (D11)", () => {
    expect(RELEASE_COMPATIBILITY.base_generation).toBe(2);
    const assessment = assessUpgrade("0.0.0", RELEASE, RELEASE_COMPATIBILITY);
    expect(assessment.kind).toBe("d11");
    if (assessment.kind !== "d11") return;
    expect(assessment.refusal.capability).toBe("base migration");
  });
});
