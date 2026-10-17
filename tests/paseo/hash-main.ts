/**
 * Prints the bcrypt hash the worker's control-plane install hands setup for the Paseo password on
 * standard input: the real `workerControlPlane`, over a stand-in worker whose Secrets Manager
 * answers that password and whose setup program only records what it was sent. For
 * `hash-only-daemon.sh`; `bun test` never runs it.
 */
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import type { FactoryId, HostKey, Release, SecretReference } from "../../src/domain/instance";
import { workerControlPlane } from "../../src/host/control-plane";
import { system, WORKER_HOSTNAME } from "../host/worker-scenarios";

const ARN =
  "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-aaaa1111/paseo-AbCdEf" as SecretReference;
const password = await Bun.stdin.text();
let setupInput = "";
const outcome = await workerControlPlane({
  ...system("/nonexistent"),
  hostname: () => WORKER_HOSTNAME,
  run: async (argv, _timeout, options) => {
    if (argv[0] === "/usr/bin/aws")
      return { kind: "exited", exitCode: 0, stdout: JSON.stringify(password), stderr: "" };
    setupInput = new TextDecoder().decode(options?.stdin);
    return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
  },
  now: () => new Date(),
  isRoot: () => true,
  readInput: async () =>
    hostProjectionJson(
      hostProjection("fff-aaaa1111" as FactoryId, "builder-1" as HostKey, "0.3.0" as Release, ARN),
    ),
  release: "0.3.0" as Release,
  lock: async () => ({ release: () => {} }),
}).install();
const [reference, hash] = setupInput.split("\n");
if (outcome.kind !== "done" || reference !== ARN || !hash) {
  console.error("hash-main: the control-plane install did not hand setup a hash");
  process.exit(1);
}
console.log(hash);
