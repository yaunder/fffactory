# Dispatch trigger

The [trigger](../../CONTEXT.md#trigger) decides when dispatch runs on a worker:
it starts the dispatch skill on the declared cadence, and changes nothing
about what may run. Paseo's schedule is its first and only adapter
([§The Paseo trigger](#the-paseo-trigger)). Design:
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
  runs. The dispatcher serializes them: it holds an exclusive lock for the whole
  tick, `/home/factory/.local/state/fffactory/dispatch.lock` in the `factory`
  account's own state directory, whichever trigger and backend run
  ([dispatch §The dispatcher](dispatch.md#the-dispatcher)), and a tick that
  finds it held fails (exit 1) before it reads an agent or an epic, runs a
  sync or launches anything. While `/home/factory/.paseo` is there it also
  holds the lock the Python dispatcher of a release before #142 holds,
  `/home/factory/.paseo/factory-dispatch.lock`, so a Python tick still running
  when an upgrade swaps the skill excludes the next tick the same way
  (`TODO(re-evaluate when no worker runs a release from before #142)`). Tested
  in `tests/host/dispatcher.test.ts` (a tick overlapping a running one, or a
  Python tick still holding its lock, fails before anything runs).

### The `DispatchTrigger` interface

The worker reaches its trigger only through `DispatchTrigger`
(`src/host/dispatch-trigger.ts`), a worker-side seam beside
[`ExecutionBackend`](execution-backend.md#the-executionbackend-contract), not an
operator-side port: nothing on the operator side calls it. Its one selection
point, `dispatchTrigger`, is hardwired to the Paseo trigger until a second
adapter exists (`TODO(re-evaluate when a second dispatch trigger adapter is
built)`); each command the trigger runs is within the timeout it is chosen
with, the endpoint's 15 minutes.

- **`reconcile(projection)`** brings the trigger to the projection, which the
  endpoint has already persisted as desired state
  (`DISPATCH_PROJECTION_PATH`): present and matching when it is active, absent
  otherwise. It answers the trigger as it left it.
- **`inspect()`** checks the trigger against the persisted projection, changing
  nothing.

Both answer a `TriggerInspection` in fffactory's states: `active` (present and
matching an active projection), `absent` (none, for any other), or `drift`
(differing from it), each with the trigger's identity when one was found; or
`unknown` with fffactory's reason when it could not be read, never taken as
matching. No trigger output reaches an answer.

The root endpoint (`workerDispatch`, `src/host/dispatch.ts`) decides when to
ask: on a reconcile, it inspects the trigger only when the persisted projection
is the one received, persists the projection, then reconciles unless that
inspection was `active` or `absent`; a reconcile answering anything else is
`dispatch schedule did not reconcile`. `dispatch inspect` inspects alone, and
anything but `active` or `absent` is `dispatch schedule differs from its
recorded state`. The persisted desired and observed dispatch documents are the
same whichever trigger answers.

### The Paseo trigger

The Paseo adapter (`paseoTrigger`, `src/host/paseo-trigger.ts`) runs the active
release's schedule reconciler, `dispatch-schedule.sh`, over the persisted
projection: `--apply` to reconcile, `--check` to inspect. It runs it as
`factory` through `runuser` and `env -i` with `factory`'s clean environment
(`HOME`, `PATH`, `LANG=C.UTF-8`), and is the only worker code that adds
`PASEO_HOME` (`/home/factory/.paseo`) and points `FACTORY_PASEO_BIN` at the
active release's `paseo-auth.sh`. It reads the reconciler's answer,
`{host, status, schedule_id}`, from the last non-empty line of its stdout,
ignoring any earlier lines, only when its exit agrees with its status
(`active` and `absent` exit 0, `drift` exits 1); anything else is `unknown`,
with how the reconciler ended or that its answer was invalid. A reconcile's
answer must also name the projection's host and the state it declares, or it
is `unknown`. Tested in `tests/host/paseo-trigger.test.ts`; the endpoint over a
fake trigger (`tests/support/fake-dispatch-trigger.ts`) in
`tests/host/dispatch.test.ts`.

## The Paseo schedule reconciler

The schedule reconciler (`dispatch-schedule.sh`) ships in the release assets
(`assets/steps/dispatch/`) beside the dispatch skill. It reconciles
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
`bun test`); the Paseo trigger's use of it by `tests/host/paseo-trigger.test.ts`.

## Layer mapping

| Concern | Layer | Where |
| --- | --- | --- |
| The desired and observed dispatch documents the trigger answers to | domain (pure) | `src/domain/dispatch-projection.ts` |
| The `DispatchTrigger` seam, `TriggerInspection`, and its one selection point | host | `src/host/dispatch-trigger.ts` |
| When the trigger is inspected and reconciled, and its answer in the persisted observation | host | `src/host/dispatch.ts` |
| The Paseo trigger: the reconciler run as `factory` with `PASEO_HOME` and `FACTORY_PASEO_BIN`, and its answer read | host (adapter) | `src/host/paseo-trigger.ts` |
| The Paseo schedule reconciler | release assets | `assets/steps/dispatch/dispatch-schedule.sh` |

Split from [dispatch](dispatch.md) by
[#139](https://github.com/yaunder/fffactory/issues/139) (epic
[#136](https://github.com/yaunder/fffactory/issues/136)); the `DispatchTrigger`
seam and its Paseo adapter:
[#141](https://github.com/yaunder/fffactory/issues/141); the dispatch lock out
of `$PASEO_HOME`: [#142](https://github.com/yaunder/fffactory/issues/142).
