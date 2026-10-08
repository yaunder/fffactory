import { describe, expect, test } from "bun:test";
import { credentialSelection } from "../../src/application/caller-identity";

describe("credential selection", () => {
  test("--profile wins over AWS_PROFILE", () => {
    expect(credentialSelection("flagged", "environment")).toEqual({
      source: "--profile",
      profile: "flagged",
    });
  });

  test("AWS_PROFILE selects a profile when --profile is absent", () => {
    expect(credentialSelection(undefined, "environment")).toEqual({
      source: "AWS_PROFILE",
      profile: "environment",
    });
  });

  test("otherwise the standard AWS credential chain; an empty AWS_PROFILE counts as unset", () => {
    expect(credentialSelection(undefined, undefined)).toEqual({ source: "chain" });
    expect(credentialSelection(undefined, "")).toEqual({ source: "chain" });
  });
});
