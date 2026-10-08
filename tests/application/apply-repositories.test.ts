import { describe, expect, test } from "bun:test";
import {
  applyRepositories,
  type RepositoriesStageDependencies,
  type RepositoriesStageRequest,
} from "../../src/application/apply-repositories";
import type { HostCommandOutcome } from "../../src/application/host-transport";
import type { FactoryId, Host, HostKey, Repository } from "../../src/domain/instance";
import { repositoryInspectionJson } from "../../src/domain/repository-placement";
import type { PeerView } from "../../src/domain/tailnet";
import { type Answer, fakeTailnet, fakeTransport, peer, peers, TAG } from "../support/fake-workers";

const FACTORY = "fff-abcd1234" as FactoryId;
const B1 = "fff-abcd1234-builder-1";
const B2 = "fff-abcd1234-builder-2";
const THEN = ", then rerun `fffactory apply`.";

function repo(key: string): Repository {
  return { key, remote: `https://github.com/yaunder/${key}`, path: key, branch: "main" };
}

function host(key: string, repositories: string[] = ["alpha"]): Host {
  return { key: key as HostKey, repositories };
}

/** A worker answering the repository endpoint. */
function worker(outcome: HostCommandOutcome): Answer {
  return outcome;
}

const COMPLETED = (
  state: "synchronized" | "unresolved",
  unmanaged: readonly string[] = [],
): HostCommandOutcome => ({
  kind: "completed",
  exitCode: state === "synchronized" ? 0 : 1,
  stdout: repositoryInspectionJson({ protocol_version: 1, state, unmanaged }),
});

function stage(
  options: {
    view?: PeerView;
    script?: Record<string, Answer>;
    hosts?: Host[];
    repositories?: Repository[];
  } = {},
) {
  const tailnet = fakeTailnet(options.view ?? peers(peer(B1), peer(B2)));
  const transport = fakeTransport(options.script ?? {});
  const deps: RepositoriesStageDependencies = {
    peers: tailnet.tailnet,
    transport: transport.transport,
  };
  const request: RepositoriesStageRequest = {
    factoryId: FACTORY,
    tag: TAG,
    hosts: options.hosts ?? [host("builder-1")],
    repositories: options.repositories ?? [repo("alpha")],
  };
  return { deps, request, calls: transport.calls, run: () => applyRepositories(deps, request) };
}

describe("the repository stage", () => {
  test("delivers the projected manifest and synchronizes a reachable worker", async () => {
    const run = stage({ script: { [B1]: worker(COMPLETED("synchronized", ["legacy"])) } });
    const { outcomes } = await run.run();
    expect(outcomes).toEqual([
      { key: "builder-1" as HostKey, hostname: B1, kind: "synchronized", unmanaged: ["legacy"] },
    ]);

    const [call] = run.calls;
    expect(call?.command).toEqual([
      "sudo",
      "-n",
      "/usr/local/libexec/fffactory-activate",
      "repositories",
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(call?.stdin));
    expect(manifest.repositories.alpha.remote).toBe("https://github.com/yaunder/alpha");
    expect(manifest.hosts[B1].repository_sets).toEqual(["placed"]);
  });

  test("never issues a destructive command to a worker", async () => {
    const run = stage({ script: { [B1]: worker(COMPLETED("synchronized")) } });
    await run.run();
    const tokens = run.calls.flatMap((call) => call.command);
    expect(tokens).not.toContain("rm");
    expect(tokens).not.toContain("git");
    expect(run.calls.every((call) => call.command[0] === "sudo")).toBe(true);
  });

  test("reports a worker whose sync exits non-zero as unresolved", async () => {
    const run = stage({ script: { [B1]: worker(COMPLETED("unresolved", ["removed"])) } });
    const [outcome] = (await run.run()).outcomes;
    expect(outcome?.kind).toBe("unresolved");
    if (outcome?.kind === "unresolved") {
      expect(outcome.summary).toContain(B1);
      expect(outcome.nextAction).toEndWith(THEN);
      expect(outcome.unmanaged).toEqual(["removed"]);
    }
  });

  test("refuses a result whose exit status and document disagree", async () => {
    const run = stage({
      script: {
        [B1]: worker({
          kind: "completed",
          exitCode: 1,
          stdout: repositoryInspectionJson({
            protocol_version: 1,
            state: "synchronized",
            unmanaged: [],
          }),
        }),
      },
    });
    const [outcome] = (await run.run()).outcomes;
    expect(outcome?.kind).toBe("skipped");
    if (outcome?.kind === "skipped") expect(outcome.summary).toContain("invalid");
  });

  test("reports a sync that timed out as skipped", async () => {
    const run = stage({ script: { [B1]: worker({ kind: "timed_out" }) } });
    const [outcome] = (await run.run()).outcomes;
    expect(outcome).toMatchObject({ kind: "skipped" });
  });

  test("reports a worker ssh could not start for as skipped", async () => {
    const run = stage({
      script: { [B1]: worker({ kind: "not_started", code: "EACCES" }) },
    });
    const [outcome] = (await run.run()).outcomes;
    expect(outcome?.kind).toBe("skipped");
    if (outcome?.kind === "skipped") expect(outcome.summary).toContain("EACCES");
  });

  test("reports an unreachable worker as skipped with the connection verdict", async () => {
    const run = stage({
      script: { [B1]: worker({ kind: "unreachable", reason: "the route is down" }) },
    });
    const [outcome] = (await run.run()).outcomes;
    expect(outcome?.kind).toBe("skipped");
    if (outcome?.kind === "skipped") expect(outcome.summary).toContain("the route is down");
  });

  test("skips a worker that is not visible in the tailnet without reaching it", async () => {
    const run = stage({ view: peers(), script: {} });
    const [outcome] = (await run.run()).outcomes;
    expect(outcome?.kind).toBe("skipped");
    expect(run.calls).toEqual([]);
  });

  test("attempts every declared worker, one skip not stopping another", async () => {
    const run = stage({
      view: peers(peer(B1)),
      script: { [B1]: worker(COMPLETED("synchronized")) },
      hosts: [host("builder-1"), host("builder-2")],
    });
    const outcomes = (await run.run()).outcomes;
    expect(outcomes.map((o) => o.kind)).toEqual(["synchronized", "skipped"]);
  });
});
