/**
 * Runs one `stopRunningTools` scenario in its own process, because stopping refuses every
 * later command for the rest of the process, as `fffactory` exits once it is done. Argument:
 * the scenario as JSON. Prints what happened as JSON.
 */
import {
  bunProcessRunner,
  type GracefulStop,
  killRunningTools,
  stopRunningTools,
} from "../../src/infrastructure/local-tool-probe";
import { eventually, recordedPids } from "./processes";

export interface StopScenario {
  readonly tools: readonly {
    readonly argv: readonly string[];
    readonly timeoutMs: number;
    readonly stop?: GracefulStop;
    /** Where the tool records `"$$ $!"`, its own pid and its child's, once it is ready. */
    readonly pidFile: string;
  }[];
  /** Stop the tools only once this file exists. */
  readonly stopWhen?: string;
  /** Once this file exists, while the tools are stopping, kill them at once. */
  readonly killWhen?: string;
}

async function exists(file: string | undefined): Promise<void> {
  if (file === undefined) return;
  const found = await eventually(5000, async () =>
    (await Bun.file(file).exists()) ? true : undefined,
  );
  if (!found) throw new Error(`${file} never appeared`);
}

const scenario = JSON.parse(process.argv[2] ?? "") as StopScenario;
const runs = scenario.tools.map(({ argv, timeoutMs, stop }) =>
  bunProcessRunner(argv, timeoutMs, { stop }),
);
for (const { pidFile } of scenario.tools)
  if (!(await recordedPids(pidFile, 2, 5000))) throw new Error(`${pidFile} never appeared`);
await exists(scenario.stopWhen);
const started = Date.now();
const stopping = stopRunningTools();
await exists(scenario.killWhen);
if (scenario.killWhen !== undefined) killRunningTools();
await stopping;
const elapsedMs = Date.now() - started;
const outcomes = await Promise.all(runs);
const after = await bunProcessRunner([process.execPath, "-e", ""], 5000);
console.log(JSON.stringify({ elapsedMs, outcomes, after }));
