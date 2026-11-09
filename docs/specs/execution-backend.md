# Execution backend

The [execution backend](../../CONTEXT.md#execution-backend) is the mechanism
that hosts and supervises runs on a worker: it starts a coding agent on a work
item in an isolated workspace, reports how its runs are going, and gives a
human a way back into them. Paseo is its first and only adapter. Design:
[portable execution](../designs/portable-execution.md); plan:
[execution-backend abstraction](../roadmap/execution-backend-abstraction/plan.md).

This spec holds what the backend is responsible for, the run contract, the
`ExecutionBackend` contract as it exists today, and the boundary that keeps
Paseo's behavior inside its adapters. Until the epic
[#136](https://github.com/yaunder/fffactory/issues/136) completes, part of that
behavior still sits outside the seam; the boundary's allow-list is the tracked
inventory of where.

## Orchestration's three parts

In the overview's four layers ([CONTEXT.md §Layers](../../CONTEXT.md#layers)),
the execution backend is part of **Orchestration**: hosting a run and
observing it is "tracks how it's going", and its supervision path is how a
human "decides what to do with feedback". Orchestration has three peer parts,
each with its own spec:

| Part | Decides | Spec |
| --- | --- | --- |
| Dispatch policy | what may run: eligibility, capacity, duplicates, activation | [dispatch](dispatch.md) |
| Trigger | when the policy runs | [dispatch trigger](dispatch-trigger.md) |
| Execution backend | how a run is started, observed and supervised in an isolated workspace | this spec |

The trigger and the backend vary independently: a Paseo backend with a
worker-local timer for its trigger is a real combination. Keeping the
backend's software installed and healthy is not a part of Orchestration, nor a
layer: it is what fffactory does to every layer, as it pins the harness
([control plane](control-plane.md)).

## Responsibilities

What Paseo does for the factory today, each responsibility with the spec that
holds its behavior:

| # | Responsibility | Part | Today | Behavior |
| --- | --- | --- | --- | --- |
| R1 | Host a run: start a coding agent on a work item in a fresh worktree, with a provider, model, mode and prompt | backend | `factory-dispatch` runs `paseo run` | [§Start](#start) |
| R2 | List and observe runs: agent states for capacity, maintenance deferral and removal; the launch history the duplicate check reads | backend | `ExecutionBackend.agents` through `host agents` and `host control-plane activity`; `factory-dispatch`'s labelled `paseo ls` | [§Inspect](#inspect) |
| R3 | Isolate workspaces: create worktrees and own their paths | backend | Paseo creates them under `/home/factory/.paseo/worktrees`, which work inspection searches (`WORK_ROOTS`); the collector never reads Paseo's `config.json` | [host protocol §work inspect](host-protocol.md#work-inspect), [collector](collector.md) |
| R4 | Supervise: a human reconnects to a run, inspects it and intervenes | backend | Paseo's clients over Tailscale | [§Connect](#connect) |
| R5 | Trigger dispatch on a cadence | trigger | `DispatchTrigger`, its Paseo adapter running `dispatch-schedule.sh` over `paseo schedule` | [dispatch trigger](dispatch-trigger.md) |
| R6 | Register the placed repositories for supervision | backend | `ExecutionBackend.registerRepositories`, Paseo projects | [§The `ExecutionBackend` contract](#the-executionbackend-contract) |
| R7 | Keep the backend's software healthy: install, configure, authenticate, run the unit, probe health, reload, restart, classify changes, defer maintenance | maintenance | the `ControlPlane` port and its activator actions, which the worker answers through `ExecutionBackend`'s maintenance group; `assets/steps/control-plane/` | [control plane](control-plane.md) |

R1 to R4 are the run contract below. R6 is a convenience the backend offers
supervision. R7 maintains whatever the backend is; the operator-side
`ControlPlane` port keeps its shape whichever backend runs, and its change
names (`paseo-package` and the rest) are the Paseo backend's maintenance
vocabulary.

## The run contract

Four operations, after [portable execution §A small run interface](../designs/portable-execution.md#a-small-run-interface-with-explicit-guarantees).
Their callers never see the backend's own flags, labels or workspace layout:
those are the adapter's.

| Operation | The caller supplies | The backend returns | Status |
| --- | --- | --- | --- |
| Start | a launch identity (repository alias, work item, attempt stamp), the checkout and base branch, the branch to create, the workflow invocation, and agent settings (provider, model, mode) | a run handle, or a failure in fffactory's words | implemented in `factory-dispatch`, not yet behind the seam ([#143](https://github.com/yaunder/fffactory/issues/143)) |
| Inspect | nothing, or a launch identity | the runs it holds in fffactory's [agent states](control-plane.md#agent-states), with whether dispatch launched them; unreadable is unknown, never a guess | states behind the seam (`agents`); launch history in `factory-dispatch`, not yet behind it ([#143](https://github.com/yaunder/fffactory/issues/143)) |
| Connect | a run | an authorized way to observe and intervene in that same run | not on the interface: Paseo's own clients serve it ([§Connect](#connect)) |
| Stop | a run | the run stopped, its workspace and history kept | not implemented |

`TODO(re-evaluate when a second backend or a stop command needs them)`: add
connect and stop to `ExecutionBackend`. Nothing calls them today, and
`src/CLAUDE.md` allows no speculative ports, so they are named here and
nowhere in the code.

### Start

The dispatcher launches an epic's agent with `paseo run --no-wait --json` in a
new branch-off worktree workspace, labelled `factory-dispatch=true`,
`factory-repository=<alias>`, `factory-epic=<number>` and
`factory-dispatched-at=<stamp>`, and reads the `agentId` from standard output.
The labels are how the Paseo adapter carries the launch identity. It never
passes `--background`, Paseo's deprecated alias of `--no-wait`, removed after
2027-04-01. It drops `PASEO_AGENT_ID` and `PASEO_WORKSPACE_ID` from the
launch's environment, so the agent is top-level and its workspace inherits
nothing from the scheduled agent that runs the dispatcher. Tested in
`assets/steps/dispatch/tests/test_factory_dispatch.py`.

### Inspect

A worker's agents in fffactory's states come from the backend's `agents`
([§The `ExecutionBackend` contract](#the-executionbackend-contract)), whose
Paseo adapter translates Paseo's statuses
([control plane §Agent states](control-plane.md#agent-states));
`host control-plane activity` and `host agents`
([host protocol §agents](host-protocol.md#agents)) ask it, and dispatch's
capacity check reads `host agents` ([dispatch §Capacity](dispatch.md#capacity)).

The launch history the duplicate check (`previously_dispatched`) reads is
still the dispatcher's own Paseo call: it lists the agents labelled for the epic
with `paseo ls --global --background` and the label filters, so it also sees
agents in background workspaces, which a bare `ls` hides
([control plane §The Paseo pin](control-plane.md#the-paseo-pin)). Tested in
`assets/steps/dispatch/tests/test_factory_dispatch.py`.

### Connect

A human supervises a run from an enrolled Paseo client over Tailscale
([readiness §Enrollment](readiness.md#enrollment)), which reaches the worker's
daemon directly; fffactory brokers nothing.

## The `ExecutionBackend` contract

The worker has one execution-backend interface, `ExecutionBackend`
(`src/host/execution-backend.ts`), and one place that chooses it,
`executionBackend(system, budgetMs)`, hardwired to Paseo: factory.json has no
backend selector until a second backend is built. Every command the chosen
backend runs falls within the budget its caller gives, from when it was
chosen: a command that would start past it, or outlasts it, has failed. Its
answers are in fffactory's states and words, never the backend's own status,
field, label or output. The interface has three groups:

| Group | Operation | Caller |
| --- | --- | --- |
| registration | `registerRepositories(checkouts)` | `host dispatch reconcile` ([dispatch §Repository registration](dispatch.md#repository-registration)) |
| agents | `agents()`: the worker's agents in fffactory's [agent states](control-plane.md#agent-states), each with whether dispatch launched it, or `unknown` with fffactory's reason | `host control-plane activity` (as root) and `host agents` (as `factory`) |
| maintenance | `install(projection, password)`, `reload()`, `restart()`: each `done`, or `failed` with fffactory's reason | `host control-plane install`, `reload`, `restart` |

The worker endpoints call the seam, never a backend's commands. The
control-plane endpoint (`src/host/control-plane.ts`) keeps what is the
activator's, whichever the backend: the privilege rules (`activity` and the
maintenance actions only as root, `host agents` never as root), the host
projection read from standard input and checked for this worker, and the
password the projection references, read by that reference as root
([control plane §The daemon password](control-plane.md#the-daemon-password)).
It hands the backend the projection and the password, never judged, and
passes its answer on as it is. It chooses the backend within 90 seconds for
the agents (under the CLI's two-minute wait) and two minutes for each
maintenance action. A backend without a daemon answers `reload` and `restart`
with `done`.

### Registration

The checkouts are the absolute paths of the repositories the host's repository
manifest ([repositories](repositories.md), `REPOSITORY_MANIFEST_PATH`) places,
under `/workspace/repos`, in placement order (`placedCheckouts`). A manifest
that is not version 2 JSON, or places a repository it does not hold or one
whose path is not a relative checkout path, is refused in fffactory's words,
never quoted. When registration runs, and what of its result apply reports, is
dispatch's ([dispatch §Repository registration](dispatch.md#repository-registration)).

Given the absolute paths of placed checkouts present on disk,
`registerRepositories` returns a backend-neutral result:

- `backend`: the backend's name, `paseo`;
- `checkouts`: per checkout, its `path` and `state`: `registered` (newly),
  `present` (already), `failed` with a `reason` in fffactory's own words, never
  the tool's output, or `not_applicable` (a backend with nothing to register);
- `changed`: whether any checkout was `registered`.

It only adds: it never deletes, renames or archives a project, and never
reloads or restarts the daemon. With no checkouts it asks the backend nothing.

The result's document, carried by the dispatch inspection, has the keys
`backend`, `changed` and `checkouts` in that order, each checkout `path`,
`state` and, when `failed`, `reason`. Its reader ignores fields it does not
know; an absent document, from a worker whose release predates registration, is
no result, and so is a malformed one (an unknown backend or state, a path
outside `/workspace/repos` or escaping it, a failure without a one-line
printable reason, or `changed` disagreeing with the checkouts), so it never
invalidates the document carrying it.

### The Paseo adapter

`src/host/paseo-backend.ts` is the only worker code that names Paseo's CLI,
its setup program, its unit or its password's bcrypt cost; the auth wrapper it
shares with the Paseo trigger
([dispatch trigger §The Paseo trigger](dispatch-trigger.md#the-paseo-trigger)).
It runs the Paseo CLI only as `factory`, authenticated by the active release's
`paseo-auth.sh`: from root, through `runuser -u factory` and `env -i` with
`factory`'s `HOME` and `PATH` alone; run as `factory` (`host agents`), the
wrapper itself with that environment. The password is never one of its
arguments. It relies on the contract proved against the pin
([control plane §The Paseo pin](control-plane.md#the-paseo-pin)):

- **Registration.** `paseo project ls --json`: each checkout whose absolute
  path is a listed project's `path` is `present`; then `paseo project create
  <path> --json` for each checkout not listed, in order: exit 0 is
  `registered`. Listing first keeps a rerun a true no-op (`changed: false`)
  and leaves existing projects untouched. If listing fails (it exits non-zero,
  times out, cannot start, or prints anything but a JSON array of objects each
  with a string `path`), every checkout is `failed` and nothing is created. One
  failed `create` fails only that checkout. The reasons say what fffactory did
  and how it ended: `listing Paseo's projects exited with status 1`, `Paseo's
  project list was invalid`, `registering it as a Paseo project timed out`.
- **Agents.** `paseo ls --global --background`, its labelled list and
  `agent inspect` for each running agent, translated into fffactory's states
  ([control plane §Agent states](control-plane.md#agent-states)).
- **Maintenance.** `install` hashes the password at Paseo's bcrypt cost and
  sends the active release's `setup-host.sh` the reference and the hash on
  standard input ([control plane §The daemon password](control-plane.md#the-daemon-password));
  `reload` is `paseo daemon reload` as `factory`; `restart` is
  `systemctl restart paseo.service`. A failure is `Paseo setup`, `Paseo
  reload` or `Paseo restart` and how it ended (`exited 1`, `timed_out`), never
  the command's output.

Tested in `tests/domain/repository-registration.test.ts` (the placed checkouts
from a manifest, the result, its document and reader),
`tests/host/paseo-backend.test.ts`, over a scripted runner answering as 0.15.0
prints (the exact commands, as `factory` from root and as itself, and their
environment; registration: nothing missing creates nothing and changes nothing,
some missing creates only those, a rerun is a no-op, listing failing fails
every checkout, one create failing fails only it with no Paseo output in its
reason, only `ls` and `create` are ever run; the agents; install, reload and
restart; the budget; and the password reaches no argument, environment, setup
input or result), and `tests/host/control-plane.test.ts`, the endpoint over a
fake backend (`tests/support/fake-execution-backend.ts`): privilege, the
projection, the password read, the budgets it chooses with, and the backend's
answers passed on.

## The boundary

Only allow-listed files may name Paseo's behavior. A repository check,
`tests/execution-backend-boundary.test.ts`, reads every file under `src/`,
`assets/` and `scripts/` as text, CLAUDE.md files aside, and fails for any file
outside the allow-list that names:

| Behavior | What it matches |
| --- | --- |
| the Paseo CLI | a run of `paseo` with one of the top-level commands of the pinned 0.15.0 (`agent`, `archive`, `attach`, `clone`, `daemon`, `delete`, `heartbeat`, `hooks`, `host`, `hub`, `import`, `inspect`, `logs`, `ls`, `onboard`, `pair`, `permit`, `plugin`, `project`, `provider`, `reload`, `restart`, `run`, `schedule`, `script`, `send`, `speech`, `start`, `status`, `stop`, `terminal`, `usage`, `wait`, `workspace`, `worktree`): after any root options before the command (`--json`, `-o json`, `--host=h`; an option's value never starts with a dash): on a command line, also through a shell variable named `paseo` or `PASEO` (`paseo -o json ls`, `"$paseo" ls`, `"${PASEO}" schedule ls`); or as an argument list whose program is the string `paseo`, a path ending in `/paseo`, or a variable named `paseo` or `PASEO` (`["paseo", "ls"]`, `["paseo", "-o", "json", "ls"]`, `execFile("paseo", ["ls"])`, `command_json(PASEO, "ls")`), but not when the command is a quoted key (`"runtime": "paseo", "status": "ok"`); or a function named `paseo` called with an argument list (`paseo(["project", "ls"])`); and the TypeScript handles that run it, `PaseoCommand`, `paseoCli` and `paseoAgents` |
| Paseo's paths | `.paseo`, and `paseoWorktrees`, the name of its worktree root |
| Paseo's environment | `PASEO_` followed by a letter, also inside a longer name such as `FACTORY_PASEO_BIN` |
| Paseo's port | `6767` |
| Paseo's unit | `paseo.service` |
| Paseo's package | `@getpaseo` |
| Paseo's auth wrapper | `paseo-auth.sh` |

The word "Paseo" in prose, and the backend's name `paseo` in the registration
record (`["paseo"]`, `repositoryRegistration("paseo", [])`), are not behavior.
`tests/` and `docs/` are not scanned: a test exercises its adapter, and a
fixture holds what the backend prints. The Python tests shipped beside the
assets are scanned, as files under `assets/`.

### The allow-list

The allow-list is the tracked inventory of Paseo's behavior. Each entry leaves
with the task of epic #136 that moves its calls behind a seam; the adapters
stay.

| Entry | Names | Stays, or leaves with |
| --- | --- | --- |
| `src/host/paseo-backend.ts` | the CLI and its handles, the auth wrapper, the unit, the package | stays: the `ExecutionBackend` adapter |
| `src/host/paseo-trigger.ts` | the environment (`PASEO_HOME`, `FACTORY_PASEO_BIN`), the auth wrapper | stays: the `DispatchTrigger` adapter |
| `src/infrastructure/paseo-control-plane.ts` | the port, by `PASEO_PORT` | stays: the operator-side `ControlPlane` adapter |
| `assets/steps/control-plane/**` | everything: install, config, auth wrapper, unit, pin, and their tests | stays: the backend's shipped assets |
| `assets/steps/dispatch/dispatch-schedule.sh` and its `tests/test_dispatch_schedule.py` | the CLI, the environment, the auth wrapper | stays: the Paseo trigger's shipped reconciler |
| `assets/steps/dispatch/factory-dispatch` and its `tests/test_factory_dispatch.py` | the CLI, the paths, the environment, the auth wrapper | [#142](https://github.com/yaunder/fffactory/issues/142): the dispatcher in TypeScript |
| `src/host/work.ts`, `src/domain/work-inspection.ts`, `src/domain/collector-installation.ts` | the paths | [#144](https://github.com/yaunder/fffactory/issues/144): the backend's layout as data |

An entry is never kept once nothing in it names Paseo's behavior: the check
fails on an allow-list entry that matches no file naming any, so the list
shrinks with the code.

### The quarantine

Names [#93](https://github.com/yaunder/fffactory/issues/93) owns are
quarantined in a second list, marked
`TODO(re-evaluate when #93 lands): remove`. Each is tolerated outside the
allow-list only in the files that use it today, where it is blanked out before
the behavior scan; in any other file it fails, so #93's names do not spread
while they wait to be renamed. The test lists each name's files:

| Name | What it is |
| --- | --- |
| `paseo-password` | the secret's CLI name and its error text |
| `paseo_password_secret*` | factory.json's per-host reference, its Terraform variable and their checks, and the control-plane endpoint's read of it |
| `paseo-package`, `paseo-configuration` | control-plane change names |
| `paseo_health` | the dispatch gate |
| `paseo_changed` | the stale-plan reason |
| `PASEO_CLIENTS` | the enrollment note, and apply's note carrying it |
| Paseo in human output | operator text naming `systemctl status paseo.service` or `~/.paseo/worktrees` |

The bare word "Paseo" in human output is #93's too, and is not scanned. As for
the allow-list, the check fails on a quarantined file that no longer uses its
name, or that the allow-list already covers.

Tested in `tests/execution-backend-boundary.test.ts`: every file under the
scanned roots against the allow-list and the quarantine, every entry still
needed, and over fixtures each behavior named outside the allow-list, an
allow-listed file by path and by glob, prose naming Paseo, a quarantined name in
its own file and in another, and stale entries.

## Layer mapping

| Concern | Layer | Where |
| --- | --- | --- |
| The registration result, its document and reader; the backend's name | domain (pure) | `src/domain/repository-registration.ts` |
| fffactory's agent states and the busy rule | domain (pure) | `src/domain/control-plane.ts` |
| Paseo's worktree root, searched by work inspection | domain (pure) | `src/domain/work-inspection.ts` (`WORK_ROOTS`) |
| The `ExecutionBackend` seam (registration, agents, maintenance) and its one selection point | host | `src/host/execution-backend.ts` |
| The Paseo adapter: the Paseo CLI as `factory` (`paseoCli`), projects, the agent adapter (`paseoAgents`), setup with the bcrypt hash, reload and the unit's restart | host | `src/host/paseo-backend.ts` |
| The worker endpoints calling the seam: the control-plane actions and `host agents`, dispatch reconcile's registration | host | `src/host/control-plane.ts`, `src/host/dispatch.ts`, `src/host/endpoint.ts` |
| The run launch and the duplicate check's listing | release assets | `assets/steps/dispatch/factory-dispatch` |
| The boundary | check | `tests/execution-backend-boundary.test.ts` |

The trigger's seam and its Paseo adapter (`src/host/dispatch-trigger.ts`,
`src/host/paseo-trigger.ts`) are in
[dispatch trigger §Layer mapping](dispatch-trigger.md#layer-mapping).

Introduced by [#139](https://github.com/yaunder/fffactory/issues/139) (epic
[#136](https://github.com/yaunder/fffactory/issues/136)); one worker-side
interface, `HostControlPlane` folded into it:
[#140](https://github.com/yaunder/fffactory/issues/140). The `ExecutionBackend`
contract: [#133](https://github.com/yaunder/fffactory/issues/133).
