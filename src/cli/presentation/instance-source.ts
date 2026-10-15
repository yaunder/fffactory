/**
 * Which factory.json a command acts on, as the line every command prints first
 * (`docs/specs/instance-configuration.md` §Instance discovery). The source's words are
 * `describeSource`'s, the ones doctor publishes in its JSON summary: one mapping, never a
 * second with other words.
 */
import { describeSource, type FoundInstance } from "../../application/resolve-instance";
import { type Block, verbatim } from "./blocks";

/** `Instance: PATH (SOURCE)`, such as `Instance: /work/.fffactory/factory.json (nearest .fffactory/factory.json)`. */
export function instanceLine({ path, source }: FoundInstance): string {
  return `Instance: ${path} (${describeSource(source)})`;
}

/**
 * `path` as shown to the operator: from `~` when it is under the home directory `home`,
 * otherwise whole. Never shortened further: the path tells which factory.json it is.
 */
export function displayPath(path: string, home: string): string {
  const base = home.length > 1 ? home.replace(/\/+$/, "") : "";
  return base !== "" && path.startsWith(`${base}/`) ? `~/${path.slice(base.length + 1)}` : path;
}

/**
 * What a restyled command prints first: `fffactory COMMAND · release R`, then
 * `Instance  PATH (SOURCE)` (`docs/specs/plan-apply.md` §Before anything reaches AWS).
 */
export function instanceHeader(
  command: string,
  release: string,
  { path, source }: FoundInstance,
  home: string,
): Block {
  return {
    kind: "text",
    lines: [
      [{ text: `fffactory ${command}`, tone: "heading" }, ` · release ${release}`],
      [
        { text: "Instance", tone: "label" },
        "  ",
        verbatim(displayPath(path, home)),
        ` (${describeSource(source)})`,
      ],
    ],
  };
}
