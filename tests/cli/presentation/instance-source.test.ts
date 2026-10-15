import { describe, expect, test } from "bun:test";
import type { InstanceSource } from "../../../src/application/resolve-instance";
import { render } from "../../../src/cli/presentation/blocks";
import {
  displayPath,
  instanceHeader,
  instanceLine,
} from "../../../src/cli/presentation/instance-source";
import { ansiStyle, plainStyle } from "../../../src/cli/presentation/style";

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

const HOME = "/home/op";

describe("the header of a restyled command (plan-apply §Before anything reaches AWS)", () => {
  const header = (path: string, source: InstanceSource) =>
    render(plainStyle, [instanceHeader("plan", "0.3.0", { found: true, path, source }, HOME)]);

  test("names the command and release, then the instance with doctor's source words", () => {
    expect(header("/work/.fffactory/factory.json", "nearest")).toEqual([
      "fffactory plan · release 0.3.0",
      "Instance  /work/.fffactory/factory.json (nearest .fffactory/factory.json)",
    ]);
  });

  test("a path under the home directory is shown from ~, and no other is shortened", () => {
    expect(header("/home/op/test-factory/.fffactory/factory.json", "--instance")[1]).toBe(
      "Instance  ~/test-factory/.fffactory/factory.json (--instance)",
    );
    expect(header("/home/op/.fffactory/factory.json", "home")[1]).toBe(
      "Instance  ~/.fffactory/factory.json (~/.fffactory/factory.json)",
    );
    expect(header("/home/operator/factory.json", "--instance")[1]).toBe(
      "Instance  /home/operator/factory.json (--instance)",
    );
    expect(displayPath("/home/op/factory.json", "/home/op/")).toBe("~/factory.json");
    expect(displayPath("/factory.json", "/")).toBe("/factory.json");
    expect(displayPath("/home/op", "/home/op")).toBe("/home/op");
  });

  test("in color, the command is a heading and Instance a label", () => {
    const [command, instance] = render(ansiStyle, [
      instanceHeader("apply", "0.3.0", { found: true, path: "/w/f.json", source: "nearest" }, HOME),
    ]);
    expect(command).toBe(`${ansiStyle.heading("fffactory apply")} · release 0.3.0`);
    expect(instance).toBe(
      `${ansiStyle.label("Instance")}  /w/f.json (nearest .fffactory/factory.json)`,
    );
  });

  test("the path is data: shown verbatim, its backticks kept in color", () => {
    const [, instance] = render(ansiStyle, [
      instanceHeader(
        "plan",
        "0.3.0",
        { found: true, path: "/w/`a`/f.json", source: "--instance" },
        HOME,
      ),
    ]);
    expect(instance).toBe(`${ansiStyle.label("Instance")}  /w/\`a\`/f.json (--instance)`);
  });
});
