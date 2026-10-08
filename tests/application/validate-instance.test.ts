import { describe, expect, test } from "bun:test";
import { validateInstance } from "../../src/application/validate-instance";
import { MemoryInstanceStore } from "../support/memory-instance-store";

const PATH = "/work/.fffactory/factory.json";

async function validate(contents: string) {
  return validateInstance(new MemoryInstanceStore({ [PATH]: contents }), PATH);
}

describe("validateInstance", () => {
  test("a valid partial document is valid and reports completeness separately", async () => {
    const result = await validate('{"schema_version": 1, "factory_id": "yaunder-v2"}');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.instance.factory_id).toBe("yaunder-v2" as never);
    expect(result.completeness.complete).toBe(false);
    expect(result.completeness.missing).not.toContain("factory_id");
  });

  test("an invalid document reports issues by field path", async () => {
    expect(await validate('{"schema_version": 1, "factory_id": "X"}')).toEqual({
      valid: false,
      issues: [{ path: "factory_id", message: expect.stringContaining("lowercase") }],
    });
  });

  test("malformed JSON is reported without echoing the contents", async () => {
    const result = await validate('{"tailscale": tskey-auth-secret}');
    expect(result).toEqual({
      valid: false,
      issues: [{ path: "(root)", message: "is not valid JSON" }],
    });
  });
});
