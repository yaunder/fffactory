# Dispatch

Dispatch pulls ready FFFlow epics on a worker into top-level Paseo agents and
worktrees. factory.json *requests* dispatch on a host, but apply keeps it
*inactive* until every readiness gate passes, and a later apply activates it
automatically once they do. Requested dispatch and active dispatch are distinct
states. Apply ends with an end-to-end verification that joins every stage.
Design:
[fffactory-v2.md §Repositories and dispatch](../designs/fffactory-v2.md#repositories-and-dispatch).

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
factory-owned Paseo schedule through the `WorkflowQueue`, a **live** change
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

## The dispatch programs and skill

The dispatch program (`factory-dispatch`), the Paseo schedule reconciler
(`dispatch-schedule.sh`) and the dispatch skill ship in the release assets
(`assets/steps/dispatch/`). When dispatch becomes active, the root-owned host
dispatch endpoint installs the program as `/usr/local/bin/factory-dispatch` and
the skill in the `factory` account's canonical `.agents/skills/dispatch`
directory, with Claude Code's `.claude/skills/dispatch` as a link to it. The dispatcher pulls ready FFFlow epics
into top-level Paseo agents and worktrees; it never merges, force-pushes,
deletes branches, closes issues, deploys infrastructure or converges hosts. The
schedule reconciler reconciles the one factory-owned schedule from the
versioned desired dispatch projection, as the unprivileged `factory` account,
refusing to run as root. The projection contains every schedule input: cron,
timezone, provider, model, mode and absolute working directory. An enabled
declaration missing any input is incomplete; nothing is defaulted. Their behavior is held by the Python tests
that ship beside them,
`assets/steps/dispatch/tests/test_factory_dispatch.py` and
`test_dispatch_schedule.py`, run in CI (not by `bun test`).

The dispatcher launches an epic's agent with `paseo run --no-wait --json` in a
new branch-off worktree workspace, labelled `factory-dispatch=true`,
`factory-repository=<alias>`, `factory-epic=<number>` and
`factory-dispatched-at=<stamp>`, and reads the `agentId` from standard output.
It never passes `--background`, Paseo's deprecated alias of `--no-wait`, removed
after 2027-04-01. It drops `PASEO_AGENT_ID` and `PASEO_WORKSPACE_ID` from the
launch's environment, so the agent is top-level and its workspace inherits
nothing from the scheduled agent that runs the dispatcher. Its duplicate check
(`previously_dispatched`) lists the agents labelled for the epic with
`paseo ls --global --background` and the label filters, so it also sees agents
in background workspaces, which a bare `ls` hides
([control plane §The Paseo pin](control-plane.md#the-paseo-pin)); any listed
agent, finished or not, means the epic was already dispatched.

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
0.13.2 has no setting that bounds or prunes that history, so it grows by one
entry per dispatch run for as long as the schedule lives. fffactory does not
edit Paseo's private state to trim it.

Moving the dispatch skill into the release is why it is no longer a canonical
repository skill: `scripts/repository-skills.sh` no longer lists
`dispatch` in `expected_skills` and instead asserts the shipped skill, program
and reconciler at their `assets/steps/dispatch/` paths, and AGENTS.md's routing
table records the move.

## Capacity

A worker runs at most one dispatched epic agent at a time (`CAP`). The
dispatcher counts the agents holding that slot by asking the worker's own
fffactory, never Paseo: `/opt/fffactory/current/bin/fffactory host agents
--json` ([host protocol §agents](host-protocol.md#agents)), which translates
Paseo's agents with the same adapter as every other gate
([control plane §Agent states](control-plane.md#agent-states)). It counts the
agents it launched (`dispatched`) that are `working` or `needs_input`, by the
[busy rule](control-plane.md#the-busy-rule): an agent waiting on a permission
holds the slot, and a `finished`, `failed` or `stopped` one never does, however
long it stays listed. An agent dispatch did not launch, such as the scheduled
agent running the dispatcher, never counts. No dispatcher code reads a Paseo
status.

When `host agents` exits non-zero, or prints anything the CLI's own activity
parser would refuse, the tick fails (exit 1) before it reads an epic or launches
anything, so an unreadable worker never reads as a free slot. The dispatcher
accepts only a version-1 document whose `activity` is `idle` or `active` with a
positive count, and whose `agents` list holds only objects with an `id` matching
the agent ID rule, a `state` among fffactory's five, and a boolean `dispatched`;
it ignores fields it does not know, as the
[host protocol](host-protocol.md) requires. One malformed agent fails the whole
tick rather than being skipped, since skipping it could free a slot it holds.
Its error names `host agents`' reason, which that command writes on one line on
standard error, or says the agent list is invalid; never the document. The
duplicate check and the launch stay Paseo-specific inside the dispatcher.

Tested in `assets/steps/dispatch/tests/test_factory_dispatch.py`: each state,
dispatched or not, holding the slot or not; the checkout's
`tests/host/fixtures/activity-agents.json` read as `host agents` prints it;
a failing, unknown, other-version or malformed answer failing the tick with
no epic read and nothing listed or launched, including a malformed agent (no or
an unknown state, a non-boolean or missing `dispatched`, a missing or malformed
ID) and a malformed `activity`; unknown fields ignored; a failing one's reason
as the tick's one-line error; and no Paseo list for capacity.

## The `WorkflowQueue` connector

FFFactory owns the FFFlow/GitHub readiness logic for now, isolated behind the
`WorkflowQueue` port (`application/workflow-queue.ts`). Its adapter
(`infrastructure/ffflow-github-workflow-queue.ts`) can invoke only the fixed
root activator operations `dispatch adoption`, `dispatch reconcile` and
`dispatch inspect`. Adoption runs the active release's dispatcher with
`--adoption-only`: it checks every placed repository with the active release's
FFFlow checker and launches no work. Reconcile streams the canonical desired
projection on standard input. The worker installs the release assets, drops to
`factory` for Paseo and repository operations, persists the projection and
observed result, and reports `active` only after the real schedule matches.
Pending and not-requested projections actively remove a previous schedule.
A [skipped worker](#skipped-workers) is sent no projection, so its schedule is
left as it is.
The adapter never invokes a removed v1 command or an arbitrary sudo command.

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
and exits 1.

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
| The root endpoint, asset installation, privilege drop and persisted observation | host | `src/host/dispatch.ts` |
| The dispatch program, schedule reconciler and skill | release assets | `assets/steps/dispatch/` |
| The agents the capacity check counts (`host agents`), translated by the one Paseo adapter | host | `src/host/control-plane.ts`, `src/cli/commands/host.ts` |

Introduced by [#105](https://github.com/yaunder/factory/issues/105). Skipped
workers: [#134](https://github.com/yaunder/factory/issues/134). A delivered
GitHub token's next action: [#70](https://github.com/yaunder/fffactory/issues/70).
Stopping dispatch: [#84](https://github.com/yaunder/fffactory/issues/84).
Capacity from `host agents`: [#100](https://github.com/yaunder/fffactory/issues/100).
