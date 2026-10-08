/**
 * `fffactory apply` waiting for a new worker's first boot, in its own process, with real
 * signal handling: `cli/interrupts.ts` wired to this process as `cli/main.ts` wires it, and
 * its real sleep, over the in-memory factory of `cli/plan-apply.test.ts` (fake Terraform,
 * lock store and tailnet). Run from source, `main.ts` carries no worker executable, so it
 * never reaches the wait; this does. The plan creates builder-1's machine, which never joins
 * the tailnet, so apply prints that it waits and then sleeps until it is interrupted.
 */
import { constants } from "node:os";
import { interruptible, RETURN_GRACE_MS } from "../../src/cli/interrupts";
import { run } from "../../src/cli/run";
import {
  killRunningTools,
  stopRunningTools,
  stopsGracefully,
} from "../../src/infrastructure/local-tool-probe";
import { harness } from "./cli-harness";
import { fakeAssetBundle } from "./doctor-fakes";
import { BUCKET, declaring, workerFleet } from "./factory-world";
import { fakeFactoryWorld } from "./fake-provisioner";
import { fakePrompt } from "./fake-secrets";
import { MemoryInstanceStore } from "./memory-instance-store";
import { MemoryLockStore } from "./memory-lock-store";
import { MemoryPlanStore } from "./memory-plan-store";

const interrupts = interruptible({
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.off(signal, handler),
  exit: (code) => process.exit(code),
  signalNumber: (signal) => constants.signals[signal],
  stopRunningTools,
  killRunningTools,
  stopsGracefully,
  err: (line) => console.error(line),
  graceMs: RETURN_GRACE_MS,
});

const store = new MemoryInstanceStore({
  "/work/repo/.fffactory/factory.json": `${JSON.stringify(declaring("builder-1"), null, 2)}\n`,
});
const lockStore = new MemoryLockStore([BUCKET]);
const fleet = workerFleet([]);
const { context } = harness(
  store,
  {},
  {
    lockStore,
    provisioner: fakeFactoryWorld({ store: lockStore, bucket: BUCKET }).provisioner,
    planStore: new MemoryPlanStore(),
    prompt: fakePrompt({ interactive: true, answers: ["yes"] }).prompt,
    assets: fakeAssetBundle().bundle,
    interrupted: interrupts.interrupted,
    tailnet: fleet.deps.peers,
    transport: fleet.deps.transport,
    sleep: interrupts.sleep,
  },
);

await interrupts.run(
  () =>
    run(["apply"], {
      ...context,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  { waitsOnInterrupt: true },
);
