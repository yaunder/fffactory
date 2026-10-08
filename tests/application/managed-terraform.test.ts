import { describe, expect, test } from "bun:test";
import { managedTerraformPaths } from "../../src/application/managed-terraform";

const CACHE = "/home/operator/.cache/fffactory";

describe("managedTerraformPaths", () => {
  test("keys the executable by version, and shares one provider cache across operations", () => {
    expect(managedTerraformPaths(CACHE, "1.16.4")).toEqual({
      root: `${CACHE}/terraform`,
      versionDirectory: `${CACHE}/terraform/1.16.4`,
      executable: `${CACHE}/terraform/1.16.4/terraform`,
      pluginCache: `${CACHE}/terraform/plugins`,
      operations: `${CACHE}/terraform/operations`,
      diagnostics: `${CACHE}/terraform/diagnostics`,
    });
  });
});
