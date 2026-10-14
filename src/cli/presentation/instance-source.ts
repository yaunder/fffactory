/**
 * Which factory.json a command acts on, as the line every command prints first
 * (`docs/specs/instance-configuration.md` §Instance discovery). The source's words are
 * `describeSource`'s, the ones doctor publishes in its JSON summary: one mapping, never a
 * second with other words.
 */
import { describeSource, type FoundInstance } from "../../application/resolve-instance";

/** `Instance: PATH (SOURCE)`, such as `Instance: /work/.fffactory/factory.json (nearest .fffactory/factory.json)`. */
export function instanceLine({ path, source }: FoundInstance): string {
  return `Instance: ${path} (${describeSource(source)})`;
}
