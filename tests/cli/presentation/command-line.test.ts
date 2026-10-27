import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { render } from "../../../src/cli/presentation/blocks";
import {
  fffactoryCommand,
  shellWord,
  withCommands,
} from "../../../src/cli/presentation/command-line";
import { ansiStyle } from "../../../src/cli/presentation/style";

describe("the fffactory commands human output names (cli-output §Next)", () => {
  test("a plainly safe word is as it is; any other is single-quoted for a POSIX shell", () => {
    expect(shellWord("/work/.fffactory/factory.json")).toBe("/work/.fffactory/factory.json");
    expect(shellWord("a-profile_1@x:y=z%+")).toBe("a-profile_1@x:y=z%+");
    expect(shellWord("my factory.json")).toBe("'my factory.json'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shellWord("$HOME;`x`")).toBe("'$HOME;`x`'");
    expect(shellWord("")).toBe("''");
  });

  test("repeats the instance and profile a command was given, after its own words", () => {
    expect(fffactoryCommand(["plan"])).toBe("fffactory plan");
    expect(fffactoryCommand(["apply", "--plan-id", "k3x9q2ab"], { profile: "factory" })).toBe(
      "fffactory apply --plan-id k3x9q2ab --profile factory",
    );
    expect(
      fffactoryCommand(["lock", "break"], { instance: "/a/it's mine.json", profile: "p q" }),
    ).toBe("fffactory lock break --instance '/a/it'\\''s mine.json' --profile 'p q'");
    expect(fffactoryCommand(["plan"], { instance: undefined, profile: undefined })).toBe(
      "fffactory plan",
    );
  });
});

describe("fffactory's own words naming fffactory commands (cli-output §Next)", () => {
  test("every fffactory command as inline code with the selection, other backticks kept", () => {
    const lines = render(ansiStyle, [
      {
        kind: "text",
        lines: [withCommands("Run `fffactory status`, then `ls`.", { instance: "a b" })],
      },
    ]);
    expect(stripVTControlCharacters(lines[0] ?? "")).toBe(
      "Run fffactory status --instance 'a b', then ls.",
    );
    expect(lines[0]).toContain("\x1b[36m");
  });
});
