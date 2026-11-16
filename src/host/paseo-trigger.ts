/**
 * The Paseo dispatch trigger (`docs/specs/dispatch-trigger.md` §The trigger's contract): the
 * active release's schedule reconciler, `dispatch-schedule.sh`, run as `factory` through
 * `runuser` in `factory`'s clean environment over the persisted projection. The only worker code
 * that sets `PASEO_HOME` and points `FACTORY_PASEO_BIN` at the auth wrapper. It reads the
 * reconciler's answer, `{host, status, schedule_id}`, from the last non-empty line of its stdout,
 * only when its exit agrees with it; no other reconciler output reaches an inspection.
 */
import { join } from "node:path";
import { DISPATCH_PROJECTION_PATH, type DispatchProjection } from "../domain/dispatch-projection";
import { WORKER_PATHS } from "../domain/host-protocol";
import type { ProcessOutcome } from "../infrastructure/local-tool-probe";
import type { ApplySystem } from "./apply";
import type { DispatchTrigger, TriggerInspection } from "./dispatch-trigger";
import { ended } from "./failures";
import { FACTORY_HOME } from "./runtime-account";

/** The reconciler's entire environment as `factory`. */
const FACTORY_ENV = [
  `HOME=${FACTORY_HOME}`,
  `PASEO_HOME=${FACTORY_HOME}/.paseo`,
  `PATH=${FACTORY_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
  "LANG=C.UTF-8",
] as const;
/** Root's environment for `runuser`. */
const ROOT_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" };
/** Each status the reconciler prints, with the exit status that agrees with it. */
const EXIT_FOR: Readonly<Record<string, number>> = { active: 0, absent: 0, drift: 1 };
const INVALID = "the dispatch schedule's answer was invalid";

function steps(system: ApplySystem, relative: string): string {
  return join(system.root, WORKER_PATHS.activeRelease, "steps", relative);
}

/** The reconciler's last non-empty line of `stdout` as JSON, or undefined when it is not JSON. */
function lastLineJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trimEnd().split("\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
}

/**
 * The reconciler's answer as an inspection, with the host it named: believed only when it
 * printed one with a status its exit agrees with, otherwise unknown in fffactory's words.
 */
function answered(
  outcome: ProcessOutcome,
  what: string,
): { readonly inspection: TriggerInspection; readonly host?: string } {
  if (outcome.kind !== "exited")
    return { inspection: { state: "unknown", reason: ended(what, outcome) ?? INVALID } };
  const parsed = lastLineJson(outcome.stdout);
  const { host, status, schedule_id } =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : {};
  if (typeof status !== "string" || !Object.hasOwn(EXIT_FOR, status))
    return { inspection: { state: "unknown", reason: ended(what, outcome) ?? INVALID } };
  if (
    EXIT_FOR[status] !== outcome.exitCode ||
    typeof host !== "string" ||
    !(typeof schedule_id === "string" || schedule_id === null)
  )
    return { inspection: { state: "unknown", reason: INVALID } };
  const state = status as "active" | "absent" | "drift";
  return { inspection: { state, identity: schedule_id }, host };
}

/** The Paseo trigger on `system`, each reconciler run within `timeoutMs`. */
export function paseoTrigger(system: ApplySystem, timeoutMs: number): DispatchTrigger {
  const projection = join(system.root, DISPATCH_PROJECTION_PATH);
  const run = (mode: "--apply" | "--check") =>
    system.run(
      [
        "/usr/sbin/runuser",
        "-u",
        "factory",
        "--",
        "/usr/bin/env",
        "-i",
        ...FACTORY_ENV,
        `FACTORY_PASEO_BIN=${steps(system, "control-plane/paseo-auth.sh")}`,
        steps(system, "dispatch/dispatch-schedule.sh"),
        mode,
        "--projection",
        projection,
      ],
      timeoutMs,
      { cwd: "/", env: ROOT_ENV },
    );
  return {
    async reconcile(declared: DispatchProjection) {
      const { inspection, host } = answered(
        await run("--apply"),
        "the dispatch schedule's reconcile",
      );
      if (inspection.state === "unknown" || inspection.state === "drift") return inspection;
      const wanted = declared.active ? "active" : "absent";
      return host === declared.hostname && inspection.state === wanted
        ? inspection
        : { state: "unknown", reason: "the dispatch schedule answered for another projection" };
    },
    inspect: async () => answered(await run("--check"), "the dispatch schedule's check").inspection,
  };
}
