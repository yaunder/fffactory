import { expect, test } from "bun:test";
import { instanceLine } from "../../../src/cli/presentation/instance-source";

test.each([
  ["--instance", "/flag/factory.json", "Instance: /flag/factory.json (--instance)"],
  ["FFFACTORY_INSTANCE", "/env/factory.json", "Instance: /env/factory.json (FFFACTORY_INSTANCE)"],
  [
    "nearest",
    "/work/.fffactory/factory.json",
    "Instance: /work/.fffactory/factory.json (nearest .fffactory/factory.json)",
  ],
  [
    "home",
    "/home/op/.fffactory/factory.json",
    "Instance: /home/op/.fffactory/factory.json (~/.fffactory/factory.json)",
  ],
] as const)(
  "the instance line names a %s selection with doctor's source words",
  (source, path, line) => {
    expect(instanceLine({ found: true, path, source })).toBe(line);
  },
);
