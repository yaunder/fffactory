/**
 * The worker's `DispatchTrigger` (`docs/specs/dispatch-trigger.md` §The trigger's contract) as an
 * in-memory fake, and a stand-in for its selection point, so the dispatch endpoint is tested
 * without any trigger's commands. By default it keeps one trigger as a reconciler would: a
 * reconcile makes it what the projection declares, and an inspection matches only while the
 * persisted projection (`read`) declares what it is. A test may answer either call itself.
 */
import type { DispatchProjection } from "../../src/domain/dispatch-projection";
import type {
  DispatchTrigger,
  TriggerInspection,
  TriggerSelection,
} from "../../src/host/dispatch-trigger";

export type TriggerCall =
  | { readonly method: "reconcile"; readonly projection: DispatchProjection }
  | { readonly method: "inspect" };

export interface TriggerAnswers {
  reconcile?: TriggerInspection;
  inspect?: TriggerInspection;
}

/**
 * A trigger present (`active`) or not; `read` gives whether the persisted projection is active,
 * undefined when there is none.
 */
export function fakeDispatchTrigger(
  read: () => Promise<boolean | undefined>,
  answers: TriggerAnswers = {},
) {
  const calls: TriggerCall[] = [];
  const timeouts: number[] = [];
  const world = { present: false };
  const identity = () => (world.present ? "schedule-1" : null);
  const trigger: DispatchTrigger = {
    async reconcile(projection) {
      calls.push({ method: "reconcile", projection });
      if (answers.reconcile !== undefined) return answers.reconcile;
      world.present = projection.active;
      return { state: world.present ? "active" : "absent", identity: identity() };
    },
    async inspect() {
      calls.push({ method: "inspect" });
      if (answers.inspect !== undefined) return answers.inspect;
      const active = await read();
      if (active === undefined || active !== world.present)
        return { state: "drift", identity: identity() };
      return { state: active ? "active" : "absent", identity: identity() };
    },
  };
  const select: TriggerSelection = (_system, timeoutMs) => {
    timeouts.push(timeoutMs);
    return trigger;
  };
  return { trigger, select, calls, timeouts, answers, world };
}
