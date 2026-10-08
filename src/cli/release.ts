import { version } from "../../package.json";
import { parseRelease, type Release } from "../domain/instance";

export function releaseFrom(version: string): Release {
  const parsed = parseRelease(version);
  if (!parsed.ok) throw new Error(`package.json version ${parsed.message}`);
  return parsed.value;
}

/**
 * The running CLI's release: the single source for the release this CLI pins in
 * new instances. It is package.json `version`, imported so that
 * `bun build --compile` inlines it into the executable.
 */
export const RELEASE: Release = releaseFrom(version);
