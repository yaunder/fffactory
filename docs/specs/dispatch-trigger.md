# Dispatch trigger

The [trigger](../../CONTEXT.md#trigger) decides when dispatch runs on a worker:
it starts the dispatch skill on the declared cadence, and changes nothing
about what may run. Paseo's schedule is its first and only adapter. Design:
[portable execution §Proposed responsibility split](../designs/portable-execution.md#proposed-responsibility-split).

The trigger is one of Orchestration's three peer parts, beside dispatch policy
([dispatch](dispatch.md)) and the execution backend
([execution backend §Orchestration's three parts](execution-backend.md#orchestrations-three-parts)).
It varies independently of the backend: scheduling is separable from hosting
runs.

## The trigger's contract

The trigger answers to the versioned desired dispatch projection
(`src/domain/dispatch-projection.ts`), which the dispatch stage sends through
the `WorkflowQueue` ([dispatch §The `WorkflowQueue` connector](dispatch.md#the-workflowqueue-connector)):

- **Reconcile to the projection.** An active projection has one factory-owned
  trigger fire the dispatch skill (`/dispatch`) with the projection's cadence,
  timezone, provider, model, mode and working directory; any other projection
  has none. Reconciling reports whether it changed anything, and is a live
  change: it never restarts the backend or interrupts a run.
- **Inspect.** Check the actual trigger against the projection without
  changing it, so `dispatch inspect` reports drift rather than repairing it.
- **Overlapping ticks must be safe.** A tick may start while the last one still
  runs. The dispatcher serializes them: it holds an exclusive lock
  (`factory-dispatch.lock` in `$PASEO_HOME`) for the whole tick, and a tick that
  finds it held fails (exit 1) before it reads an epic or launches anything.
  Tested in `assets/steps/dispatch/tests/test_factory_dispatch.py`.

There is no `DispatchTrigger` interface yet: the root endpoint
(`workerDispatch`, `src/host/dispatch.ts`) runs the Paseo reconciler itself, as
`factory`: on a reconcile, `--check` when the persisted projection is the one
received, then `--apply` unless that check passed; for `dispatch inspect`,
`--check` alone. It sets `PASEO_HOME` and
points `FACTORY_PASEO_BIN` at the active release's `paseo-auth.sh`.
[#141](https://github.com/yaunder/fffactory/issues/141) moves that behind a
`DispatchTrigger` with a Paseo adapter, and
[#142](https://github.com/yaunder/fffactory/issues/142) moves the dispatcher's
lock out of `$PASEO_HOME`.

## The Paseo schedule reconciler

The schedule reconciler (`dispatch-schedule.sh`) ships in the release assets
(`assets/steps/dispatch/`) beside the dispatch program and skill. It reconciles
the one factory-owned schedule from the projection, as the unprivileged
`factory` account, refusing to run as root. The projection contains every
schedule input: cron, timezone, provider, model, mode and absolute working
directory. An enabled declaration missing any input is incomplete; nothing is
defaulted.

The reconciler finds the schedule by its `factory-dispatch` name, fails on more
than one, and changes it in place, keeping its ID and run history: any
difference in cadence, timezone, provider, model, mode, working directory or
prompt is one `paseo schedule update`, followed by `schedule resume` when the
schedule was paused, and a run limit or expiry that is set is cleared in the
same update (`--no-max-runs`, `--no-expires-in`, which Paseo 0.11.4 and later
honor and 0.9.1 misread as values). An ordinary update sends neither flag. Only a schedule
that no update can bring to the declared state is deleted and created again,
losing its history: a completed one, one with a thinking option, or one whose
target is not a new agent. It reads the inspected schedule, run history
included, on standard input, never as an argument, so a large history neither
reports drift nor stops reconciliation
([#43](https://github.com/yaunder/fffactory/issues/43)).

Paseo keeps every run of a schedule in its record
(`~/.paseo/schedules/<id>.json`), and `schedule inspect` returns all of them.
0.15.0 has no setting that bounds or prunes that history, so it grows by one
entry per dispatch run for as long as the schedule lives. fffactory does not
edit Paseo's private state to trim it.

Its behavior is held by the Python tests that ship beside it,
`assets/steps/dispatch/tests/test_dispatch_schedule.py`, run in CI (not by
`bun test`); the endpoint's use of it by `tests/host/dispatch.test.ts`.

## Layer mapping

| Concern | Layer | Where |
| --- | --- | --- |
| Running the reconciler as `factory` with Paseo's environment, on reconcile and inspect | host | `src/host/dispatch.ts`; a `DispatchTrigger` and `src/host/paseo-trigger.ts` with [#141](https://github.com/yaunder/fffactory/issues/141) |
| The Paseo schedule reconciler | release assets | `assets/steps/dispatch/dispatch-schedule.sh` |

Split from [dispatch](dispatch.md) by
[#139](https://github.com/yaunder/fffactory/issues/139) (epic
[#136](https://github.com/yaunder/fffactory/issues/136)).
