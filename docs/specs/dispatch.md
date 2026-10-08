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
| `github_credential` | The worker's verification found GitHub enrolled for `factory`. | pending, naming the exact GitHub enrollment steps ([readiness §Enrollment](readiness.md#enrollment)) |
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
| `deferred` | Apply deferred its Paseo maintenance while agents may be active ([control plane §Pre-activation deferral](control-plane.md#pre-activation-deferral)), whatever else skipped it. | The deferral's, as the workers stage words it: `Paseo maintenance is deferred while agents may be active`, then ``Close the active agents on HOSTNAME, then rerun `fffactory apply` ``. |
| `worker_skipped` | The workers stage skipped it for another reason: offline, not found, an install still running on it, ... ([plan and apply §The workers stage](plan-apply.md#the-workers-stage)). | The workers stage's, such as `Offline in the tailnet`. |
| `unreachable` | The workers stage installed it, but the tailnet no longer locates it. | The hostname-match rule's, as the workers stage words a skip. |

The dispatch stage never fails a skipped worker: its `skipped` outcome exits 2,
as for the skipped worker itself, not 1, and the operation record shows the
dispatch stage `pending` ([plan and apply §Operation records](plan-apply.md#operation-records)).
Only a deferred worker also bypasses the control-plane stage; a worker skipped
for another reason that the tailnet still locates is reconciled there, which
may fail it and the apply.

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

Moving the dispatch skill into the release is why it is no longer a canonical
repository skill: `scripts/repository-skills.sh` no longer lists
`dispatch` in `expected_skills` and instead asserts the shipped skill, program
and reconciler at their `assets/steps/dispatch/` paths, and AGENTS.md's routing
table records the move.

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
workers stage installed the worker). The verdict ends with the skips' next
actions, each named once:

```text
End-to-end verification: The factory is not ready: 1 of 1 workers need attention
  fff-abcd1234-builder-1 is not ready: Release left as is: Paseo maintenance is deferred while agents may be active; Control plane is deferred; Dispatch left as is; Close the active agents on fff-abcd1234-builder-1, then rerun `fffactory apply`
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
| The end-to-end verification stage | application | `src/application/verify-factory.ts` |
| The FFFlow/GitHub adapter over `HostTransport` | infrastructure | `src/infrastructure/ffflow-github-workflow-queue.ts` |
| The versioned desired and observed dispatch documents | domain (pure) | `src/domain/dispatch-projection.ts` |
| The root endpoint, asset installation, privilege drop and persisted observation | host | `src/host/dispatch.ts` |
| The dispatch program, schedule reconciler and skill | release assets | `assets/steps/dispatch/` |

Introduced by [#105](https://github.com/yaunder/factory/issues/105). Skipped
workers: [#134](https://github.com/yaunder/factory/issues/134).
