import { describe, expect, test } from "bun:test";
import { workerLines } from "../../../src/cli/presentation/workers";
import type { HostKey } from "../../../src/domain/instance";
import {
  ENROLLMENTS,
  type EnrollmentState,
  type Verification,
} from "../../../src/domain/readiness";
import type { WorkerOutcome } from "../../../src/domain/rollout";

const HOST = "fff-abcd1234-builder-1";
const WORKER = { key: "builder-1" as HostKey, hostname: HOST };
const POLICY = "(tailnet SSH policy must let you log in as `factory`)";
const LOGIN = `\`tailscale ssh factory@${HOST}\``;
const INDENT = " ".repeat(13);

function installed(state: (id: string) => EnrollmentState): WorkerOutcome {
  const verification: Verification = {
    protocol_version: 1,
    hostname: "attacker",
    verified_at: "2026-09-30T12:00:00.000Z",
    checks: [],
    enrollment: ENROLLMENTS.map(({ id }) => ({ id, state: state(id) })),
  };
  return { ...WORKER, kind: "installed", release: "0.3.0", verification };
}

describe("apply's worker lines (plan and apply §The workers stage)", () => {
  test("an installed worker lists each account still to enroll, for the resolved hostname", () => {
    const outcome = installed((id) => (id === "openai" ? "enrolled" : "pending"));
    expect(workerLines(outcome)).toEqual([
      `  installed  builder-1 (${HOST}): release 0.3.0 installed and verified; enrollment pending: GitHub, Claude Code`,
      `${INDENT}GitHub: Authenticate GitHub as factory on ${HOST} ${POLICY}: run ${LOGIN}, then ` +
        "`gh auth login --hostname github.com --git-protocol https --web`, then `gh auth status`",
      `${INDENT}Claude Code: Log in to Claude Code as factory on ${HOST} ${POLICY}: run ${LOGIN}, then ` +
        "`claude auth login`, then `claude auth status`",
      `${INDENT}Paseo clients: enrollment is checked from each client, not the worker`,
    ]);
  });

  test("a fully enrolled worker says so, then what Paseo clients wait for", () => {
    expect(workerLines(installed(() => "enrolled"))).toEqual([
      `  installed  builder-1 (${HOST}): release 0.3.0 installed and verified; every account is enrolled`,
      `${INDENT}Paseo clients: enrollment is checked from each client, not the worker`,
    ]);
  });

  test("a worker not installed shows its summary and next action, aligned under the labels", () => {
    const outcome: WorkerOutcome = {
      ...WORKER,
      kind: "skipped",
      summary: "Offline",
      nextAction: "Start it, then rerun `fffactory apply`.",
    };
    expect(workerLines(outcome)).toEqual([
      `  skipped    builder-1 (${HOST}): Offline`,
      `${INDENT}Next: Start it, then rerun \`fffactory apply\`.`,
    ]);
  });

  test("a worker after a failure was not tried", () => {
    expect(workerLines({ ...WORKER, kind: "not_attempted" })).toEqual([
      `  not tried  builder-1 (${HOST}): the rollout stopped at the failure above`,
    ]);
  });
});
