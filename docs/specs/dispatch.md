# Dispatch

Dispatch pulls ready FFFlow epics on a worker into runs its execution backend
hosts: top-level Paseo agents and worktrees today. factory.json *requests*
dispatch on a host, but apply keeps it *inactive* until every readiness gate
passes, and a later apply activates it automatically once they do. Requested
dispatch and active dispatch are distinct states. Apply ends with an end-to-end
verification that joins every stage.
Design:
[fffactory-v2.md §Repositories and dispatch](../designs/fffactory-v2.md#repositories-and-dispatch).

This spec is dispatch policy and its activation: what may run, and when apply
lets it. It is one of Orchestration's three peer parts; when dispatch runs is
the [trigger](dispatch-trigger.md)'s, and how a run is started, observed and
supervised is the [execution backend](execution-backend.md)'s
([execution backend §Orchestration's three parts](execution-backend.md#orchestrations-three-parts)).

Dispatch is apply's fourth worker stage, after the workers, repository and
control-plane stages ([plan and apply §Apply](plan-apply.md#apply)), under the
same factory-wide lock and operation record. It consumes what those stages
produced: the worker's release health and GitHub credential (the workers
stage's verification), its repository synchronization (the repository stage) and
Paseo health (the control-plane stage).

## Requested versus active

factory.json requests dispatch on a host with `hosts[].dispatch.enabled`. A
request is not activation: apply activates dispatch only when every gate below
passes, and keeps it inactive otherwise. Because activation is automatic once
the gates pass, no second command is needed — a later `fffactory apply`
reconciles it. Keeping dispatch inactive never fails an apply; the worker is
software-ready, with dispatch pending.

## Gate matrix

Each gate is pure (`domain/dispatch-readiness.ts`); the stage gathers the
inputs. Every gate must pass for dispatch to be active; any one failing keeps it
pending and names what unblocks it. The table is closed: a new gate is one more
entry here and in `DISPATCH_GATES`.

| Gate | Passes when | When it fails, keeps dispatch |
| --- | --- | --- |
| `worker_release` | The workers stage installed and verified the release. | pending until a rerun installs and verifies it; in apply a worker the workers stage did not install never reaches the gates ([Skipped workers](#skipped-workers)), so this gate guards in depth |
| `github_credential` | The worker's verification found GitHub enrolled for `factory`. | pending, naming the exact GitHub enrollment steps, or, for a GitHub token factory.json delivers to the host, storing a valid one and applying it ([readiness §Enrollment](readiness.md#enrollment)) |
| `repository_sync` | The repository stage synchronized every placed checkout ([repositories §Repository readiness](repositories.md#repository-readiness-and-dispatch)). | pending until the reported checkouts are resolved |
| `ffflow_adoption` | The `WorkflowQueue` reports FFFlow adoption passes for the placed repositories. | pending until the placed repositories adopt FFFlow |
| `paseo_health` | The control-plane stage found Paseo healthy. | pending until Paseo is healthy |

A missing GitHub credential is the common case: dispatch cannot pull epics
without it, so the gate keeps dispatch inactive and surfaces the credential's
next action. The adoption and Paseo-health gates read the `WorkflowQueue` and
the control-plane stage; an input the adapter could not read (an unreachable
worker, a timed-out check) is unknown, which blocks the gate rather than
guessing dispatch ready.

## Activation

When every gate passes, the stage activates dispatch by reconciling the
factory-owned Paseo schedule ([dispatch trigger](dispatch-trigger.md)) through
the `WorkflowQueue`, a **live** change
([control-plane §Change classification](control-plane.md#change-classification)):
it never restarts the daemon, so it never interrupts an active agent. Reconciling
reports whether it changed anything; when the schedule already matches, nothing
changes, so **rerunning apply with an active agent is a no-op for Paseo and the
agent** — the stage holds no control-plane port and never restarts the daemon.
When a gate fails, the stage reconciles dispatch to inactive, keeping it off.

Each worker's dispatch outcome is one of:

| Outcome | When |
| --- | --- |
| `not_requested` | factory.json does not request dispatch on the host; any existing factory schedule is removed. |
| `active` | Every gate passed; the schedule was reconciled. `changed` is false when it already matched. |
| `pending` | A gate blocks dispatch; it was kept inactive, with the blocking gates and their next actions. |
| `failed` | Reconciling the schedule did not complete; the schedule may be unchanged. |
| `skipped` | An earlier stage skipped the worker; it was sent nothing and its schedule left as it is ([below](#skipped-workers)). |
| `stopped` | Its machine is stopped ([plan and apply §Stopped workers](plan-apply.md#stopped-workers)); it was sent nothing and its schedule left as it is. Not a skip: it keeps the stage `active` and apply's exit 0. |

### Skipped workers

The stage reconciles only a worker the earlier stages left it able to: one
the workers stage installed and the tailnet still locates. Any other worker is
`skipped` before any gate is read: no adoption check, no projection, so
whatever schedule it has stays as it is and the next apply reconciles it.
Gating it instead would read its unverified release as failing and remove a
schedule that was dispatching fine. Its reason (`DispatchSkip`,
`src/application/apply-dispatch.ts`) is one of:

| Reason | When | Summary and next action |
| --- | --- | --- |
| `deferred` | Apply deferred its Paseo maintenance while agents may be busy ([control plane §Pre-activation deferral](control-plane.md#pre-activation-deferral)), whatever else skipped it. | The deferral's, as the workers stage words it: `Paseo maintenance is deferred while agents may be busy`, then the deferral's next action, such as ``Wait until no agent on HOSTNAME is working or needs input, then rerun `fffactory apply` ``. |
| `worker_skipped` | The workers stage skipped it for another reason: offline, not found, an install still running on it, ... ([plan and apply §The workers stage](plan-apply.md#the-workers-stage)). | The workers stage's, such as `Offline in the tailnet`. |
| `unreachable` | The workers stage installed it, but the tailnet no longer locates it. | The hostname-match rule's, as the workers stage words a skip. |

The dispatch stage never fails a skipped worker: its `skipped` outcome exits 2,
as for the skipped worker itself, not 1, and the operation record shows the
dispatch stage `pending` ([plan and apply §Operation records](plan-apply.md#operation-records)).
Only a deferred worker also bypasses the control-plane stage; a worker skipped
for another reason that the tailnet still locates is reconciled there, which
may fail it and the apply.

## Stopping dispatch

fffactory can stop dispatch on one running worker outside apply: `fffactory
teardown` stops it on every running worker before it destroys anything
(epic [#56](https://github.com/yaunder/fffactory/issues/56), D3). It
reconciles that host's **not-requested** projection through the
`WorkflowQueue`'s `dispatch reconcile`, the same activator operation and
document apply sends a host factory.json requests no dispatch on
(`notRequestedDispatchProjection`, `src/domain/dispatch-projection.ts`), so the
reconciler removes the `factory-dispatch` schedule as a not-requested
projection already does. Like any reconcile it is a live change: it never
restarts Paseo or interrupts an active agent, and an agent dispatch already
started keeps running. It reads no gate and no adoption, and sends the worker
nothing else.

The projection can only be built as not requested. The parser accepts no
`active` projection without a request, and a requested inactive projection must
name a blocker, which stopping is not: so it is `requested: false`,
`active: false`, no blockers and no schedule, whatever factory.json requests.
The CLI builds `tests/host/fixtures/dispatch-not-requested.json` byte for byte
(`tests/host/protocol-contract.test.ts`); the worker's endpoint
(`tests/host/dispatch.test.ts`) and the schedule reconciler
(`test_dispatch_schedule.py`) take that very file and remove the schedule:

```json
{
  "protocol_version": 1,
  "hostname": "fff-aaaa1111-builder-1",
  "requested": false,
  "active": false,
  "blockers": [],
  "schedule": null
}
```

Stopping one worker (`stopDispatch`, `src/application/stop-dispatch.ts`) ends
in one of:

| Result | When |
| --- | --- |
| `stopped` | The worker reports dispatch `not_requested` and changed something: it held another projection or a schedule. |
| `already stopped` | The worker reports dispatch `not_requested` and changed nothing: it already held this projection and no schedule. |
| `failed` | Reconciling did not complete (an unreachable worker, a schedule that did not reconcile, an answer that is not the protocol's), or the worker reported any state other than `not_requested`. Its reason is fffactory's short words, never Paseo's output; the schedule may be unchanged. |

factory.json is not changed. `fffactory apply` reconciles dispatch from it as
usual, so it restarts dispatch on a host that requests it once its gates pass;
until then `status` reports that host's dispatch as not matching factory.json
and names `fffactory apply`. Stopping is not a pause: no command but teardown
uses it, and `worker stop` and `worker terminate` still leave the schedule as
it is.

## The dispatcher and skill

The dispatcher is the release's own `fffactory`: `fffactory host dispatch run`
([host protocol §dispatch run](host-protocol.md#dispatch-run)). The dispatch
skill ships in the release assets (`assets/steps/dispatch/skill/`), beside the
trigger's schedule reconciler. When dispatch becomes active, the root-owned host
dispatch endpoint installs the skill in the `factory` account's canonical
`.agents/skills/dispatch` directory, with Claude Code's `.claude/skills/dispatch`
as a link to it; the skill runs `/opt/fffactory/current/bin/fffactory host
dispatch run` as `factory` from the declared dispatch directory. That reconcile
also removes `/usr/local/bin/factory-dispatch`, the Python dispatcher a release
before [#142](https://github.com/yaunder/fffactory/issues/142) installed and
its skill ran (`TODO(re-evaluate when no worker runs a release from before
#142)`). The dispatcher pulls ready FFFlow epics into runs the execution
backend hosts; it never merges, force-pushes, deletes branches, closes issues,
deploys infrastructure or converges hosts.

An existing worker reaches the new dispatcher with `fffactory upgrade` and
`apply`: the workers stage activates the release, whose `fffactory` still
answers the Python dispatcher's `host agents`, so a tick between the stages
still runs; the dispatch stage's reconcile then installs the new skill and
removes the Python program. A Python tick may still be running then, under its
own lock, `$PASEO_HOME/factory-dispatch.lock`
(`/home/factory/.paseo/factory-dispatch.lock`): while that directory is there,
each new tick also takes that lock, so it never overlaps the Python tick
(`TODO(re-evaluate when no worker runs a release from before #142)`). The
activator does not change.

Moving the dispatch skill into the release is why it is no longer a canonical
repository skill: `scripts/repository-skills.sh` no longer lists
`dispatch` in `expected_skills` and instead asserts the shipped skill (naming
`fffactory host dispatch run`), the reconciler at its `assets/steps/dispatch/`
path and that no Python dispatch program is there, and AGENTS.md's routing
table records the move.

The schedule reconciler moved to
[dispatch trigger §The Paseo schedule reconciler](dispatch-trigger.md#the-paseo-schedule-reconciler).
The launch and the duplicate check's listing are in
[execution backend §Start](execution-backend.md#start) and [§Inspect](execution-backend.md#inspect).

### The dispatcher

One run, a tick, is the Python `factory-dispatch` it replaced, ported
unchanged ([#107](https://github.com/yaunder/fffactory/issues/107)). Its pure
rules are `src/domain/dispatch-policy.ts`, its reads and launch
`src/host/dispatcher.ts`. In order, it:

1. Refuses root. Reads the repository manifest (`REPOSITORY_MANIFEST_PATH`)
   for the repositories every set of its host (its hostname up to the first
   dot) names, sorted by alias; a manifest without the host
   (`host HOST is absent from the deployed manifest`), or one it cannot read,
   fails the tick.
2. Reads the persisted dispatch projection, which must be for its host,
   requested and active (`dispatch is not active for this host`), and refuses
   to run from any directory but the schedule's declared one
   (`run from the declared dispatch directory: DIR`).
3. Takes the dispatch lock ([dispatch trigger §The trigger's contract](dispatch-trigger.md#the-triggers-contract)),
   `/home/factory/.local/state/fffactory/dispatch.lock`, in the `factory`
   account's own state directory whatever the backend, created if missing,
   and, while `/home/factory/.paseo` is there, the Python dispatcher's
   `/home/factory/.paseo/factory-dispatch.lock` too (the upgrade above); either
   lock another tick holds fails the tick (`another dispatch tick holds its
   lock`), holding neither. It holds both to the tick's end.
4. Reads the worker's agents for [capacity](#capacity).
5. For each repository: runs the active release's FFFlow adoption check
   (`check-ffflow-adoption.sh REMOTE BRANCH`); a repository failing it is
   skipped with `FFFlow adoption check failed: ` and the check's error, and its
   epics are not read. Lists its open `ready` `ffflow-epic` issues; with none
   it moves on. A checkout present on disk must be the clean primary clone the
   manifest declares (not a link, its own Git top level, the declared GitHub
   remote, the declared branch, nothing uncommitted or untracked), or every
   epic is considered and skipped with why. Then lists its open pull requests.
6. For each epic, by number: it is ready when it has captured tasks (`ffflow-task`
   and `epic-N`), every one open, none depending on an open issue outside the
   epic (`Depends on: #N` at a line's start in its body or a comment), none
   named by an open pull request's title or body (`#N`, the exact number), and
   no remote `epic/N` branch exists.
   A ready epic is launched unless the worker has no slot (`host cap reached`)
   or the backend lists a run dispatch launched for it, finished or not
   (`existing dispatched agent`): an epic is never launched twice. Before the
   launch, the release's repository program plans then applies the placed
   checkouts (`sync-repositories.sh --plan`, `--apply`), the checkout is checked
   again as above, fetched, and must be at `origin/BRANCH`; any refusal skips
   the epic with its reason (a diverged checkout's `DIVERGED`, from `--plan`).
7. Prints its summary.

Its commands are the Python dispatcher's, with the same arguments, in the
environment and working directory it was started with (the scheduled agent's),
the repository program also given `FACTORY_REPOSITORY_ROOT`; each within 15
minutes, where the Python waited without limit. Their output is decoded as
UTF-8, leniently (a byte that is not becomes U+FFFD), and stripped of the
whitespace around it; output that should be JSON and is not, corrupt bytes
included, fails the tick (`invalid JSON from gh: ...`, or `from paseo`). The
manifest and the projection are read as UTF-8 the same way.

What it prints is the agent's timeline's, not a protocol document, JSON
indented by two spaces: `host`, `cap`, `running`, `considered` (`repository`,
`epic`), `skipped` (`repository`, `epic` but for an adoption failure,
`reason`), `started` (`repository`, `epic`, `agent_id`) and `running_after`;
exit 0. A reason may carry a command's error, as the Python's did. Anything
else fails the tick, exit 1: nothing on standard output, `factory dispatch:
REASON` on one line on standard error, and what it launched before stays
launched.

`--adoption-only` reads only the manifest and runs only the adoption checks:
it prints `{"adoption": "passed" | "failed", "failed_repositories": [...]}`,
exit 0 when all passed and 2 otherwise. The activator's `dispatch adoption`
runs the same checks in process as root, each dropped to `factory` in its
clean environment, all within 15 minutes, and is `passed` only when every
placed repository passed ([The `WorkflowQueue` connector](#the-workflowqueue-connector)).

Tested in `tests/host/dispatcher.test.ts`, in process against a worker laid out
in a temporary root: a real local Git remote standing in for GitHub's, the
release's real adoption check and repository program, a stand-in `gh` and
Paseo auth wrapper, and a fake execution backend for the agents (the real Paseo
backend over the stand-in where the case is the adapter's). It covers every
scenario the Python tests held, and the exact launch and GitHub commands, the
caller's environment reaching them, the lock and the Python dispatcher's, the
failures of a tick and output that is not UTF-8.
`tests/domain/dispatch-policy.test.ts` covers the rules,
`tests/host/dispatch.test.ts` the root adoption, `tests/cli/host.test.ts` the
command's output and exit codes, root refused among them.

## Capacity

A worker runs at most one dispatched epic agent at a time
(`DISPATCH_CAPACITY`). The dispatcher counts the agents holding that slot from
the execution backend's `agents`
([execution backend §The `ExecutionBackend` contract](execution-backend.md#the-executionbackend-contract)),
in process, within 90 seconds, never from a Paseo status: the backend's
adapter translates Paseo's agents as for every other gate
([control plane §Agent states](control-plane.md#agent-states)). It counts the
agents it launched (`dispatched`) that are `working` or `needs_input`, by the
[busy rule](control-plane.md#the-busy-rule) (`workerActivity`, `busyDispatched`):
an agent waiting on a permission holds the slot, and a `finished`, `failed` or
`stopped` one never does, however long it stays listed. An agent dispatch did
not launch, such as the scheduled agent running the dispatcher, never counts.

When the backend cannot read the agents, the tick fails (exit 1) before it
reads an epic or launches anything, so an unreadable worker never reads as a
free slot: `the worker's agents could not be read: REASON`, the backend's
reason in fffactory's words, never Paseo's output. The adapter reads one
malformed agent (no or an unknown status, a missing or malformed ID) as the
whole list unreadable rather than skipping it, since skipping it could free a
slot it holds, and ignores fields it does not know. The duplicate check and the
launch stay Paseo-specific inside the dispatcher until
[#143](https://github.com/yaunder/fffactory/issues/143).

Tested in `tests/host/dispatcher.test.ts`: each state, dispatched or not,
holding the slot or not; the agents of `tests/host/fixtures/activity-agents.json`,
as `host agents` prints them; an unknown answer failing the tick with no epic
read and nothing listed or launched; through the real Paseo adapter, a
malformed agent failing it, fields it does not know ignored, and a failing
list's reason as the tick's one-line error; and no Paseo list for capacity.

## The `WorkflowQueue` connector

FFFactory owns the FFFlow/GitHub readiness logic for now, isolated behind the
`WorkflowQueue` port (`application/workflow-queue.ts`). Its adapter
(`infrastructure/ffflow-github-workflow-queue.ts`) can invoke only the fixed
root activator operations `dispatch adoption`, `dispatch reconcile` and
`dispatch inspect`. Adoption runs the dispatcher's adoption check in process
([The dispatcher](#the-dispatcher)): it checks every placed repository with the
active release's FFFlow checker, as `factory`, and launches no work. Reconcile streams the canonical desired
projection on standard input. The worker installs the release assets, drops to
`factory` for Paseo and repository operations, persists the projection and
observed result, and reports `active` only after the real schedule matches.
Pending and not-requested projections actively remove a previous schedule.
Every reconcile then registers the placed checkouts through the worker's
execution backend ([Repository registration](#repository-registration)) and
returns its result in the inspection, which the adapter passes on unchanged.
A [skipped worker](#skipped-workers) is sent no projection, so its schedule is
left as it is.
The adapter never invokes a removed v1 command or an arbitrary sudo command.

## Repository registration

Every repository factory.json places on a worker is made available for
supervision through the worker's
[execution backend](../../CONTEXT.md#execution-backend), so the operator can
work on it from the backend's own client without adding it by hand.

### When it runs

On every `dispatch reconcile`, once the schedule is reconciled, the worker's
endpoint (`reconcileDispatch`, `src/host/dispatch.ts`) reads the host's
repository manifest at `REPOSITORY_MANIFEST_PATH` and keeps every checkout it
places that is present on disk as a directory, whatever its sync result: an
unresolved checkout is still one the operator wants to open. A placed checkout
not yet cloned is left out, and so is one reached through a symbolic link (the
repository root, the checkout, or any directory between), as the sync program
refuses it ([repositories](repositories.md)). It hands those to the selected
[execution backend](execution-backend.md#the-executionbackend-contract), never
to Paseo directly, chosen once from the one selection point
(`executionBackend`) with all its calls within one two-minute budget. The result is
the inspection's `repository_registration`
([host protocol §The dispatch inspection document](host-protocol.md#the-dispatch-inspection-document)),
in the result the endpoint persists and in the one it returns.

- It runs whatever the projection: requested and active, pending, or not
  requested, and also when the schedule did not reconcile (`failed`). Only a
  projection refused before anything changes (invalid, or for another worker)
  registers nothing. Teardown's dispatch stop sends the same not-requested
  projection ([Stopping dispatch](#stopping-dispatch)), so it registers too,
  harmlessly, before the machine is destroyed.
- Its outcome never changes the dispatch state, the blockers, the schedule or
  the inspection's `changed`, which stay the schedule's. A registration failure
  is reported in `repository_registration` alone.
- It only adds. A project removed in Paseo is registered again on the next
  reconcile: placement means shown. To stop showing one, unplace it; its project
  stays, as an unmanaged checkout does
  ([repositories §Unmanaged checkouts](repositories.md#unmanaged-checkouts)).
- Without a manifest (the repository stage has never reached the worker),
  nothing placed is present: the backend is asked nothing and the result has no
  checkouts. A manifest that cannot be read or is invalid places nothing known,
  so nothing is registered and the inspection carries no
  `repository_registration`, rather than a result claiming nothing is placed.
  That is never silent: every apply's repository stage writes the canonical
  manifest before dispatch, so during an apply it can be invalid or unreadable
  only where that delivery did not complete, which the stage reports `skipped`
  ([repositories](repositories.md)), leaving the apply partial (exit 2) with a
  rerun as its next action.
- Anything unexpected the registration throws records none, and the schedule's
  result is persisted as it is. That gap is unreported: apply cannot tell it
  from a result written by an earlier release. Only a defect throws there,
  since the backend's commands return outcomes rather than throwing.
- `dispatch inspect` returns the stored registration unchanged, also when it
  reports the schedule drifted. A stored result without it, written by an
  earlier release, still parses, with no registration.

Apply reports it ([plan and apply §Apply](plan-apply.md#apply)). The plan's
Dispatch row names the registration of the repositories factory.json places
on each worker. Each reconciled worker's dispatch outcome (`active`, `pending`
or `not_requested`, unchanged by it) carries the registration its reconcile
returned (`apply-dispatch.ts`); one that failed is never a failure but a gap
(`registrationGap`): the worker is not ready, the Result names each
unregistered checkout with its reason and the Next block ``Rerun `fffactory
apply` ``, and apply exits 2, never 1. Every checkout `registered` or `present`
adds nothing to the Result, and neither does a worker reporting none.

It runs here because the activator already allows `dispatch reconcile`: the
change ships as release code and reaches existing workers through `fffactory
upgrade` and apply. A new activator action would not, the activator being
first-boot user data, never updated.

Tested in `tests/host/dispatch.test.ts`: the placed checkouts present on disk
are registered for active, pending and not-requested projections, through the
auth wrapper as `factory`, and stored; one not cloned, not a directory, or
reached through a symbolic link (the repository root's too) is left out; a
registration failure leaves the state, the trigger's calls and `changed` as
they are, on a first run and a rerun; one that throws records none and the
schedule's result is still stored; the backend's calls share one budget;
without a manifest the backend is asked nothing; an invalid or unreadable one
records no registration; inspection returns the stored one, also when the
schedule drifted; an older stored result parses, with none.
`tests/domain/dispatch-projection.test.ts` covers the field's place, its
document and its reader, and `tests/host/protocol-contract.test.ts` the shared
fixtures.

### The execution backend

Moved to [execution backend §The `ExecutionBackend` contract](execution-backend.md#the-executionbackend-contract).

## End-to-end verification

Apply's last stage joins every declared worker's outcome across the stages into
one composite verdict per worker and for the factory (`verify-factory.ts`). It is
pure: it reads the outcomes the stages produced and reaches no worker itself. A
worker is ready when its release is healthy, its repositories synchronized, its
control plane fully applied (not deferred or failed) and its requested dispatch
was observed active after schedule reconciliation; the factory is ready when every worker is. A pending dispatch, a
deferred maintenance or a skipped worker is not a failure, but the factory has
not reached its requested end state until a later apply completes it, and
`fffactory apply` exits 2. A failed dispatch reconciliation is a command failure
and exits 1. A worker whose execution backend left a placed checkout
unregistered ([Repository registration](#repository-registration)) is not ready
either, its dispatch verdict as it is: its details name each such checkout,
`PATH is not registered: REASON`, then ``Rerun `fffactory apply` ``, and apply
exits 2.

Tested in `tests/application/apply-dispatch.test.ts` (every gate, skipped and
stopped workers, and the registration each reconciled outcome carries, none
from an older worker or a schedule that did not reconcile, and the gap a failed
checkout leaves) and `tests/application/verify-factory.test.ts` (each verdict,
skips and stopped workers, and a registration gap leaving a worker not ready
with its dispatch verdict unchanged).

A worker the workers stage skipped keeps whatever release it had: its release
verdict is `skipped`, `Release left as is: SUMMARY`, never `absent`, and a
skipped dispatch is `Dispatch left as is` (with its own summary when the
workers stage installed the worker); the operation record keeps each worker's
verdict and these details. Apply's Result shows the factory's verdict as its
`Verification` row, and each worker's stages under its row, a dispatch skipped
for the workers stage's reason saying only `skipped`; the skips' next actions
are said once, in the Next block
([plan and apply §What apply prints](plan-apply.md#what-apply-prints)):

```text
  ! builder-1          skipped · Paseo maintenance is deferred while agents may be busy
    ! Control plane   deferred · Maintenance (paseo-package, service-definition, listen-address) was deferred while 1 agent is working on fff-abcd1234-builder-1; it stays on its complete current release
    ✔ Repositories    synchronized
    ↷ Dispatch        skipped
  ! Verification       The factory is not ready: 1 of 1 workers need attention
```

## Readiness progression

With dispatch, the per-worker readiness progression
([readiness §Dispatch](readiness.md#dispatch)) runs
`initialized -> … -> usable -> dispatch pending or active`. Apply reports the
dispatch state and, when pending, the blocking gates and their next actions.
`status` calls the fixed `dispatch inspect` activator operation, which reads the
persisted result and checks the actual schedule without changing it. It shows
`active`, `pending`, `not_requested` or a failed/unreadable state and the
persisted blockers; a requested host is never reported active from the
configuration flag alone.

## Layer mapping

| Concern | Layer | Where |
| --- | --- | --- |
| The gate matrix, requested-versus-active state, and the readiness progression | domain (pure) | `src/domain/dispatch-readiness.ts` |
| The `WorkflowQueue` port | application | `src/application/workflow-queue.ts` |
| The dispatch stage over the port | application | `src/application/apply-dispatch.ts` |
| Stopping dispatch on one worker over the port | application | `src/application/stop-dispatch.ts` |
| The end-to-end verification stage | application | `src/application/verify-factory.ts` |
| The FFFlow/GitHub adapter over `HostTransport` | infrastructure | `src/infrastructure/ffflow-github-workflow-queue.ts` |
| The versioned desired and observed dispatch documents, the not-requested projection that stops dispatch and how stopping ended (`DispatchStop`) | domain (pure) | `src/domain/dispatch-projection.ts` |
| The root endpoint, asset installation, privilege drop, persisted observation, the trigger reconciled and inspected through `DispatchTrigger`, and registering the placed checkouts present on disk after the schedule | host | `src/host/dispatch.ts` |
| Dispatch policy: the placed repositories, readiness, capacity by the busy rule, the launch's names and the summary | domain (pure) | `src/domain/dispatch-policy.ts` |
| The dispatcher: GitHub and Git reads as `factory`, the lock and, until no worker runs a release from before #142, the Python dispatcher's (`RETIRED_DISPATCH_LOCK`, from the Paseo adapter), the adoption check (also in process from root for `dispatch adoption`), the agents from the backend, the launch and duplicate check through the Paseo adapter's `callerPaseo` until [#143](https://github.com/yaunder/fffactory/issues/143) | host | `src/host/dispatcher.ts` |
| `host dispatch run [--adoption-only]`, refused as root | host (driving) | `src/cli/commands/host.ts` |
| The dispatch skill | release assets | `assets/steps/dispatch/skill/` |

The trigger's seam, its Paseo adapter and the schedule reconciler's layers are in
[dispatch trigger §Layer mapping](dispatch-trigger.md#layer-mapping); the
`ExecutionBackend` seam's, its adapter's and the registration result's in
[execution backend §Layer mapping](execution-backend.md#layer-mapping).

Introduced by [#105](https://github.com/yaunder/factory/issues/105). Skipped
workers: [#134](https://github.com/yaunder/factory/issues/134). A delivered
GitHub token's next action: [#70](https://github.com/yaunder/fffactory/issues/70).
Stopping dispatch: [#84](https://github.com/yaunder/fffactory/issues/84).
Capacity from `host agents`: [#100](https://github.com/yaunder/fffactory/issues/100).
The execution backend's repository registration: [#133](https://github.com/yaunder/fffactory/issues/133);
registered on every dispatch reconcile: [#134](https://github.com/yaunder/fffactory/issues/134).
Narrowed to policy and activation, the trigger and the backend split out:
[#139](https://github.com/yaunder/fffactory/issues/139). The dispatcher in
TypeScript, `host dispatch run`: [#142](https://github.com/yaunder/fffactory/issues/142)
([#107](https://github.com/yaunder/fffactory/issues/107)).
