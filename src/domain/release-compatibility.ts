/**
 * Release compatibility: what a release declares about the factories it can operate, and
 * which pin `fffactory upgrade` may move to the running release. Until schema and base
 * migrations land in milestone M3, an upgrade that changes factory.json's schema version, or
 * whose release needs a newer base generation than the pinned release's workers have, is
 * refused, naming the missing capability (D11). Downgrade is not supported.
 */
import { parseRelease, type Release, SCHEMA_VERSION } from "./instance";
import type { D11Refusal } from "./plan";
import { isRecord } from "./validation";

/**
 * What a release declares about the factories it can operate. It lives in the executable, not
 * in the bundle's `release.json`, which must name the release alone: the activator every
 * worker's base carries refuses any other `release.json` (`docs/specs/worker-bootstrap.md`).
 */
export interface ReleaseCompatibility {
  /** The factory.json schema version the release reads and writes. */
  readonly schema_version: number;
  /**
   * The minimum base generation the release supports: the base its worker bootstrap
   * (`assets/terraform/bootstrap/`) sets up, and the one its install steps rely on.
   */
  readonly base_generation: number;
  /**
   * The first release that needed `base_generation`. Bootstrap sets up a worker's base only
   * once, at its first boot, so every worker of a factory pinned to an earlier release has an
   * older base.
   */
  readonly base_generation_since: Release;
}

/**
 * This release's declaration. Raise `base_generation`, and set `base_generation_since` to the
 * release that raises it, whenever a change to the worker bootstrap is one the install steps
 * or the worker executable rely on: an existing worker never runs the new bootstrap.
 * `base_generation_since` is never later than package.json's version
 * (`tests/assets/bootstrap/base-generation.test.ts`).
 */
export const RELEASE_COMPATIBILITY: ReleaseCompatibility = {
  schema_version: SCHEMA_VERSION,
  base_generation: 2,
  base_generation_since: "0.0.1" as Release,
};

const NUMERIC = /^\d+$/;

/** Compares two numeric identifiers of any length, ignoring leading zeros. */
function compareNumbers(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareIdentifiers(a: string, b: string): number {
  const numeric = [NUMERIC.test(a), NUMERIC.test(b)];
  if (numeric[0] && numeric[1]) return compareNumbers(a, b);
  if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function parts(release: Release): { core: string[]; prerelease: string[] } {
  const dash = release.indexOf("-");
  const core = (dash === -1 ? release : release.slice(0, dash)).split(".");
  return { core, prerelease: dash === -1 ? [] : release.slice(dash + 1).split(".") };
}

/** The first non-zero comparison of two lists, item by item, over their common length. */
function firstOrder(
  a: readonly string[],
  b: readonly string[],
  compare: (x: string, y: string) => number,
): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const order = compare(a[index] ?? "", b[index] ?? "");
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Semantic versioning precedence: negative when `a` precedes `b`, zero when they are equal,
 * positive when it follows. A prerelease precedes its release.
 */
export function compareReleases(a: Release, b: Release): number {
  const x = parts(a);
  const y = parts(b);
  const core = firstOrder(x.core, y.core, compareNumbers);
  if (core !== 0) return core;
  if (x.prerelease.length === 0 || y.prerelease.length === 0)
    return y.prerelease.length - x.prerelease.length;
  const prerelease = firstOrder(x.prerelease, y.prerelease, compareIdentifiers);
  return prerelease !== 0 ? prerelease : x.prerelease.length - y.prerelease.length;
}

const KEEP_PIN = (capability: string) =>
  `factory.json still pins its release; keep using that release until ${capability} arrives.`;

/** Whether the pin moves to the running release, and why not when it may not. */
export type UpgradeAssessment =
  /** factory.json pins no readable release: `init` pins one. */
  | { readonly kind: "unpinned" }
  /** factory.json already pins the running release. */
  | { readonly kind: "current" }
  /** factory.json pins a later release: the pin is never moved back. */
  | { readonly kind: "downgrade" }
  | { readonly kind: "d11"; readonly refusal: D11Refusal }
  | { readonly kind: "upgrade"; readonly from: Release };

/**
 * Before factory.json is validated, which a release of another schema version could not do:
 * whether its schema version is the running release's. An earlier one needs schema migration
 * (D11); a later one was written by a later release, so moving to this one is a downgrade.
 * Anything that is not a schema version is left to validation.
 */
export function schemaVersionChange(
  text: string,
  running: ReleaseCompatibility,
): Extract<UpgradeAssessment, { readonly kind: "d11" | "downgrade" }> | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const version = isRecord(document) ? document.schema_version : undefined;
  if (!Number.isSafeInteger(version) || version === running.schema_version) return undefined;
  if ((version as number) > running.schema_version) return { kind: "downgrade" };
  return {
    kind: "d11",
    refusal: {
      capability: "schema migration",
      reasons: [
        `factory.json has schema version ${version}, and this release reads and writes schema ` +
          `version ${running.schema_version}`,
      ],
      instead: KEEP_PIN("schema migration"),
    },
  };
}

/**
 * Whether `fffactory upgrade`, run by `running`, may move factory.json's pin to it: only from
 * an earlier release, and only when that release's workers have the base generation the
 * running release needs. The pin is never echoed: it is a configuration value.
 */
export function assessUpgrade(
  pin: string | undefined,
  running: Release,
  compatibility: ReleaseCompatibility,
): UpgradeAssessment {
  const parsed = pin === undefined ? undefined : parseRelease(pin);
  if (parsed === undefined || !parsed.ok) return { kind: "unpinned" };
  const from = parsed.value;
  if (from === running) return { kind: "current" };
  if (compareReleases(from, running) > 0) return { kind: "downgrade" };
  const { base_generation, base_generation_since } = compatibility;
  if (compareReleases(from, base_generation_since) < 0)
    return {
      kind: "d11",
      refusal: {
        capability: "base migration",
        reasons: [
          `release ${running} needs base generation ${base_generation}, which arrived in release ` +
            `${base_generation_since}: workers set up by the release factory.json pins have an older base`,
        ],
        instead: KEEP_PIN("base migration"),
      },
    };
  return { kind: "upgrade", from };
}

/** A pin that is only a release's numbers, which cannot hold anything else, may be shown. */
const PLAIN_RELEASE = /^\d+\.\d+\.\d+$/;

/** What an upgrade's plan shows first: the pin it moves, approved with the plan. */
export function describePinMove(from: string, to: Release): string[] {
  const shown = PLAIN_RELEASE.test(from) ? from : "the release it pins now";
  return [
    `Upgrade: factory.json's release pin moves from ${shown} to ${to}. It is written once you ` +
      "approve this plan, before anything is applied.",
  ];
}
