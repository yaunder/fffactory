import { describe, expect, test } from "bun:test";
import {
  COMMAND_NOT_FOUND,
  HOST_PROTOCOL_VERSION,
  INSPECT_COMMAND,
  UPLOAD_COMMAND,
  activateCommand,
  parseHostInspection,
  remoteCommand,
} from "../../src/domain/host-protocol";
import { inspection } from "../support/fake-workers";

const VALID = inspection("fff-aaaa1111-builder-1");

function problem(document: unknown): string | undefined {
  const parsed = parseHostInspection(JSON.stringify(document));
  return parsed.ok ? undefined : parsed.kind === "invalid" ? parsed.problem : parsed.kind;
}

describe("reading a host inspection", () => {
  test("rejects output that is not a JSON object", () => {
    expect(parseHostInspection("Welcome to Amazon Linux")).toEqual({
      ok: false,
      kind: "invalid",
      problem: "the output is not JSON",
    });
    expect(problem([])).toBe("the document must be an object");
    expect(problem({ ...VALID, protocol_version: "1" })).toBe(
      "protocol_version must be an integer",
    );
  });

  test("names the first field that is missing or malformed, never quoting it", () => {
    const cases: [unknown, string][] = [
      [{ ...VALID, hostname: "a b" }, "hostname is missing or malformed"],
      [{ ...VALID, release: { state: "installing" } }, "release.state is not a known state"],
      [
        { ...VALID, release: { state: "active", version: "latest", sha256: "c".repeat(64) } },
        "release.version is missing or malformed",
      ],
      [
        { ...VALID, release: { state: "active", version: "1.0.0", sha256: "C".repeat(64) } },
        "release.sha256 must be a SHA-256 digest",
      ],
      [{ ...VALID, release: null }, "release must be an object"],
      [{ ...VALID, configuration: { state: "stale" } }, "configuration.state is not a known state"],
      [
        { ...VALID, configuration: { state: "present" } },
        "configuration.sha256 must be a SHA-256 digest",
      ],
      [{ ...VALID, services: {} }, "services must be an array"],
      [
        { ...VALID, services: [{ name: "tailscaled", state: "running" }] },
        "services[0].state is not a known state",
      ],
      [
        { ...VALID, services: [{ name: "Bad Name", state: "active" }] },
        "services[0].name is missing or malformed",
      ],
      [
        { ...VALID, evidence: { ...VALID.evidence, bootstrap_complete: "yes" } },
        "evidence.bootstrap_complete must be a boolean",
      ],
      [
        { ...VALID, evidence: { ...VALID.evidence, os: { id: "amzn" } } },
        "evidence.os.version_id is missing or malformed",
      ],
      [
        { ...VALID, evidence: { ...VALID.evidence, architecture: 64 } },
        "evidence.architecture is missing or malformed",
      ],
      [
        { ...VALID, evidence: { ...VALID.evidence, available_bytes: -1 } },
        "evidence.available_bytes must be a byte count or null",
      ],
      [{ ...VALID, evidence: undefined }, "evidence must be an object"],
    ];
    for (const [document, expected] of cases) expect(problem(document)).toBe(expected);
  });

  test("accepts every documented state", () => {
    for (const release of [{ state: "none" }, { state: "broken" }])
      for (const configuration of [{ state: "none" }, { state: "unreadable" }])
        expect(problem({ ...VALID, release, configuration })).toBeUndefined();
    expect(
      problem({ ...VALID, evidence: { ...VALID.evidence, os: null, available_bytes: null } }),
    ).toBeUndefined();
  });

  test("checks the version before anything else", () => {
    expect(parseHostInspection(JSON.stringify({ protocol_version: 2 }))).toEqual({
      ok: false,
      kind: "unsupported_version",
      version: 2,
    });
    expect(HOST_PROTOCOL_VERSION).toBe(1);
  });
});

describe("remote commands", () => {
  test("inspect runs the active release's executable with fixed tokens", () => {
    expect([...INSPECT_COMMAND]).toEqual([
      "/opt/fffactory/current/bin/fffactory",
      "host",
      "inspect",
      "--json",
    ]);
    expect(COMMAND_NOT_FOUND).toBe(127);
  });

  test("apply uploads with dd and activates through the one sudoers entry", () => {
    expect([...UPLOAD_COMMAND]).toEqual([
      "dd",
      "of=/home/fffactory-admin/fffactory-release.tar.gz",
      "bs=1M",
      "status=none",
    ]);
    const digest = "a".repeat(64);
    expect([...activateCommand(digest)]).toEqual([
      "sudo",
      "-n",
      "/usr/local/libexec/fffactory-activate",
      "/home/fffactory-admin/fffactory-release.tar.gz",
      digest,
    ]);
  });

  test("refuses any token a shell would interpret, and an empty command", () => {
    for (const token of [
      "a b",
      "$(id)",
      "`id`",
      "a;b",
      "a|b",
      "a&b",
      "'a'",
      '"a"',
      "a>b",
      "~",
      "*",
      "",
      "a\nb",
    ])
      expect(() => remoteCommand(["fffactory", token])).toThrow("not shell-safe");
    expect(() => remoteCommand([])).toThrow("at least one token");
    expect([...remoteCommand(["/usr/bin/true", "--x=1", "a:b@c%d+e,f"])]).toHaveLength(3);
  });
});
