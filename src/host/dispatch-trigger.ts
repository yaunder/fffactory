/**
 * The worker's dispatch trigger (CONTEXT.md: what decides when dispatch runs on a worker), as far
 * as fffactory asks it anything: the `DispatchTrigger` interface
 * (`docs/specs/dispatch-trigger.md` §The trigger's contract) and its one selection point. A
 * worker-side seam beside `ExecutionBackend`, not an `application/` port: nothing on the operator
 * side calls it, and it varies independently of the backend. Its answers are in fffactory's
 * states and words, never the trigger's own.
 */
import type { DispatchProjection } from "../domain/dispatch-projection";
import type { ApplySystem } from "./apply";
import { paseoTrigger } from "./paseo-trigger";

/**
 * The trigger checked against the projection persisted as desired state
 * (`DISPATCH_PROJECTION_PATH`): `active`, present and matching an active projection; `absent`,
 * none for any other; `drift`, differing from it; each with the trigger's identity, if one was
 * found. `unknown`, with fffactory's reason, when it could not be read: never taken as matching.
 */
export type TriggerInspection =
  | { readonly state: "active" | "absent" | "drift"; readonly identity: string | null }
  | { readonly state: "unknown"; readonly reason: string };

export interface DispatchTrigger {
  /**
   * Brings the trigger to `projection`, which the caller has persisted as desired state first:
   * present and matching when it is active, absent otherwise. A live change that never restarts
   * the backend or interrupts a run. Answers the trigger as it was left.
   */
  reconcile(projection: DispatchProjection): Promise<TriggerInspection>;
  /** The trigger checked against the persisted projection, changing nothing. */
  inspect(): Promise<TriggerInspection>;
}

/** Whether `inspection` found the trigger as the persisted projection declares it. */
export function matching(inspection: TriggerInspection): boolean {
  return inspection.state === "active" || inspection.state === "absent";
}

/** Chooses the worker's trigger on `system`, each command it runs within `timeoutMs`. */
export type TriggerSelection = (system: ApplySystem, timeoutMs: number) => DispatchTrigger;

/** The worker's dispatch trigger: the one place it is chosen. */
// TODO(re-evaluate when a second dispatch trigger adapter is built): select the trigger from factory.json's hosts[].dispatch
export const dispatchTrigger: TriggerSelection = (system, timeoutMs) =>
  paseoTrigger(system, timeoutMs);
