import { describe, expect, test } from "bun:test";
import type { HostCommandOutcome, HostTransport } from "../../src/application/host-transport";
import type { RemoteCommand } from "../../src/domain/host-protocol";
import { resolveWorker, type WorkerAddress } from "../../src/domain/tailnet";
import { paseoControlPlane } from "../../src/infrastructure/paseo-control-plane";
import { activityJson, controlPlaneActionJson } from "../../src/domain/control-plane";
import { hostProjection } from "../../src/domain/host-projection";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import { peer, TAG } from "../support/fake-workers";

const HOSTNAME = "fff-abcd1234-builder-1";

function address(): WorkerAddress {
  const resolution = resolveWorker([peer(HOSTNAME)], HOSTNAME, TAG);
  if (resolution.kind !== "found") throw new Error("test worker did not resolve");
  return resolution.worker;
}

const COMPLETED = (exitCode: number, stdout = ""): HostCommandOutcome => ({
  kind: "completed",
  exitCode,
  stdout,
});

/** A transport that answers by the command's first meaningful token and records every command. */
function fakeTransport(answer: (command: RemoteCommand) => HostCommandOutcome) {
  const commands: RemoteCommand[] = [];
  const inputs: (Uint8Array | undefined)[] = [];
  const transport: HostTransport = {
    run: async (_worker, command, options) => {
      commands.push(command);
      inputs.push(options.stdin);
      return answer(command);
    },
  };
  return { transport, commands, inputs };
}

/** The tail token that names what a Paseo CLI command does: `ls`, `reload`, `restart`, ... */
function verb(command: RemoteCommand): string {
  return command[command.length - 1] ?? "";
}

describe("the Paseo control-plane adapter", () => {
  test("reports health from the worker's own endpoint", async () => {
    const { transport, commands } = fakeTransport(() => COMPLETED(0));
    expect(await paseoControlPlane(transport).health(address())).toBe("healthy");
    expect(commands[0]?.[0]).toBe("curl");
    expect(commands[0]).toContain(`http://${address().address}:6767/api/health`);
  });

  test("a non-zero health probe is unhealthy; a connection failure is unreachable", async () => {
    const unhealthy = fakeTransport(() => COMPLETED(22));
    expect(await paseoControlPlane(unhealthy.transport).health(address())).toBe("unhealthy");
    const down = fakeTransport(() => ({ kind: "unreachable", reason: "no route" }));
    expect(await paseoControlPlane(down.transport).health(address())).toBe("unreachable");
  });

  test("reads agent activity as the factory account, idle when none are listed", async () => {
    const { transport, commands } = fakeTransport(() =>
      COMPLETED(0, activityJson({ kind: "idle" })),
    );
    expect(await paseoControlPlane(transport).activeAgents(address())).toEqual({ kind: "idle" });
    expect(commands[0]).toEqual([
      "sudo",
      "-n",
      "/usr/local/libexec/fffactory-activate",
      "control-plane",
      "activity",
    ] as unknown as RemoteCommand);
  });

  test("counts listed agents as active, from an array or an { agents } object", async () => {
    const array = fakeTransport(() => COMPLETED(0, activityJson({ kind: "active", count: 2 })));
    expect(await paseoControlPlane(array.transport).activeAgents(address())).toEqual({
      kind: "active",
      count: 2,
    });
    const wrapped = fakeTransport(() => COMPLETED(0, activityJson({ kind: "active", count: 1 })));
    expect(await paseoControlPlane(wrapped.transport).activeAgents(address())).toEqual({
      kind: "active",
      count: 1,
    });
  });

  test("unreadable or non-JSON agent output is unknown, which the stage treats as active", async () => {
    const garbled = fakeTransport(() => COMPLETED(0, "not json"));
    expect((await paseoControlPlane(garbled.transport).activeAgents(address())).kind).toBe(
      "unknown",
    );
    const errored = fakeTransport(() => COMPLETED(1, ""));
    expect((await paseoControlPlane(errored.transport).activeAgents(address())).kind).toBe(
      "unknown",
    );
  });

  test("reload runs the authenticated Paseo CLI and maps exit status", async () => {
    const ok = fakeTransport(() => COMPLETED(0, controlPlaneActionJson({ kind: "done" })));
    expect(await paseoControlPlane(ok.transport).reload(address())).toEqual({ kind: "done" });
    expect(verb(ok.commands[0] as RemoteCommand)).toBe("reload");
    const bad = fakeTransport(() => COMPLETED(3));
    expect((await paseoControlPlane(bad.transport).reload(address())).kind).toBe("failed");
  });

  test("restart runs systemctl as root", async () => {
    const { transport, commands } = fakeTransport(() =>
      COMPLETED(0, controlPlaneActionJson({ kind: "done" })),
    );
    expect(await paseoControlPlane(transport).restart(address())).toEqual({ kind: "done" });
    expect(commands[0]).toEqual([
      "sudo",
      "-n",
      "/usr/local/libexec/fffactory-activate",
      "control-plane",
      "restart",
    ] as unknown as RemoteCommand);
  });

  test("installs Paseo through the activator with only the canonical host projection on stdin", async () => {
    const { transport, commands, inputs } = fakeTransport(() =>
      COMPLETED(0, controlPlaneActionJson({ kind: "done" })),
    );
    const projection = hostProjection(
      "fff-abcd1234" as FactoryId,
      "builder-1" as HostKey,
      "0.3.0" as Release,
    );

    expect(await paseoControlPlane(transport).install(address(), projection)).toEqual({
      kind: "done",
    });
    expect(verb(commands[0] as RemoteCommand)).toBe("install");
    expect(JSON.parse(new TextDecoder().decode(inputs[0]))).toEqual(projection);
  });

  test("a transport failure during an action is reported in fffactory's own words", async () => {
    const unavailable = fakeTransport(() => ({ kind: "unreachable", reason: "secret detail" }));
    expect(
      await paseoControlPlane(unavailable.transport).install(
        address(),
        hostProjection("fff-abcd1234" as FactoryId, "builder-1" as HostKey, "0.3.0" as Release),
      ),
    ).toEqual({ kind: "failed", reason: "Paseo install unreachable" });
  });
});
