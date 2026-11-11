# Plan: execution-backend-abstraction

- Slug: execution-backend-abstraction
- Level: L1
- Issue: #136 (Put every Paseo interaction behind the execution-backend abstraction)
- Created: 2026-11-06

## Phase 1: Understanding

Status: confirmed by the user 2026-11-06.

### Problem

Paseo is the factory's execution backend: it hosts coding-agent runs, creates
their worktrees, holds the dispatch schedule, exposes sessions for human
supervision, and its labels double as dispatch's launch history. Those
interactions are spread across TypeScript (operator CLI and worker host code),
Python (`factory-dispatch`), shell (`dispatch-schedule.sh`, control-plane
setup), a systemd unit and Terraform. There is no single inventory, no
single seam, and no check that keeps new Paseo calls from landing anywhere.

Two prior slices exist: `ExecutionBackend` on the worker (#131, one operation:
`registerRepositories`) and the worker-idleness decision that fffactory owns
agent states and the Paseo adapter translates (#94 D3, D7). The rest of the
calls still reach Paseo directly.

The goal of this plan is to make the execution-backend layer clean enough that
SSH/tmux, Herdr, or another tool could replace Paseo by writing one adapter
plus its shipped assets, without touching dispatch policy, apply stages, status,
or the host protocol. That requires (a) naming what Paseo does for the factory
today, (b) deciding which of those responsibilities belong to the replaceable
backend and which belong to the factory, (c) one abstraction shape with explicit
ports, and (d) a mechanical check that only adapter files may name Paseo.

### Who benefits

- Operators who want to run the factory with their own supervision tooling
  (Bryon's SSH/tmux case in `docs/designs/container-workers.md`).
- The project: a second backend becomes an adapter task, not an archaeology
  project, and `#93` (names) and `#107` (dispatch to TypeScript) get a target
  to land against.

### What the evergreen spec says today

- `docs/specs/control-plane.md`: Paseo is the control plane; plan classifies
  `paseo-package`, `service-definition`, `listen-address`, `password` as
  maintenance changes; `ControlPlane` is a maintenance port (health, activity,
  install, reload, restart). Layer mapping puts the SSH adapter in
  `src/infrastructure/paseo-control-plane.ts` and the worker endpoint in
  `src/host/control-plane.ts`.
- `docs/specs/dispatch.md`: the dispatcher launches top-level Paseo agents and
  worktrees; the schedule reconciler drives `paseo schedule *`; `WorkflowQueue`
  is the operator-side port whose adapter calls fixed activator operations.
- `CONTEXT.md`: *execution backend* = "the selected mechanism for hosting and
  supervising runs on a worker"; avoid "control plane" for execution hosting.
- `docs/designs/portable-execution.md`: the proposed run contract
  (start, inspect, connect, stop), the responsibility split, and the scenarios.
- `docs/roadmap/worker-idleness/decisions.md` D3/D7: fffactory's own agent
  states; one adapter that dispatch calls for capacity.

### Alignment with the software factory overview

The overview ("Building a lights-on software factory", 2026-11-06) uses the
four layers Dex Horthy and Vaibhav Gupta defined on AI That Works:

| Layer | Their definition | In the overview's worker stack |
| --- | --- | --- |
| Orchestration | "the control plane that dispatches work and decides what to do with feedback": whatever assigns work to agents, tracks how it's going, and decides what happens next | Paseo on each worker; dispatch hands ready ffflow epics to agents; the Paseo apps on phone and laptop, updated separately |
| Harness | the coding agent itself | Claude Code and Codex at pinned versions, with the ffflow plugin |
| Dev environment | what the agent needs to build and test | packages, user accounts, and the repositories for that worker's client |
| Compute | just where the agent runs | EC2 instances defined in Terraform, reached over Tailscale |

fffactory declares all four layers from factory.json plus a pinned release;
each host's `dispatch` block is the orchestration setting for that worker.

By that definition, Paseo *is* in Orchestration, and so is the execution
backend after this plan: hosting a run and observing it is "tracks how it's
going", and supervision clients are "decides what to do with feedback". The
layer has three parts, and the plan names them so the spec and the overview
use the same words:

| Orchestration part | Factory term (CONTEXT.md) | Owner after this plan |
| --- | --- | --- |
| Policy: what may run, capacity, duplicates | Dispatch | The factory's dispatcher, backend-neutral |
| Trigger: when the policy runs | (trigger) | A worker-side port; Paseo's schedule is its first adapter |
| Mechanism: start, observe and supervise a run in an isolated workspace | Execution backend, run, session, supervision | A worker-side port; Paseo is its first adapter, the Paseo apps its supervision path |

Keeping the backend's software installed and healthy is not a layer; it is
what fffactory does to every layer, the way it pins the harness. Its port
(`ControlPlane`) stays operator-side.

### Out of scope

- Renaming Paseo's names in output, schemas and configuration (#93).
- Building the SSH/tmux or Herdr adapter.
- A factory.json backend selector (hardwired to Paseo until a second adapter).
- Porting `factory-dispatch` to TypeScript (#107) as a whole; this plan
  decides where its Paseo calls go, #107 moves the program.
- Multi-worker claim coordination and run bookkeeping store (portable-execution
  open questions). The abstraction must leave room; it does not build them.
- Live migration of runs between backends.

### Constraints

- Operate only shipped behavior; AGENTS.md v2 rules (approved plan, lock,
  pinned release) are unchanged.
- The host protocol stays at major version 1; documents may gain fields.
- Dispatch's Python tests run in CI; shipped assets are what the worker runs,
  so any worker-side port has to be reachable from the activator or a shipped
  program, not only from `bun test`.
- L1: hexagonal layer mapping per spec section; no RIDs.

## Phase 2: Architecture / Approach

Status: confirmed 2026-11-06. Built from the inventory of origin/main (release
0.0.10, Paseo 0.15.0; full list in `inventory.md` beside this file). Every
decision is resolved in `decisions.md`.

### What Paseo does for the factory today

Seven responsibilities, each with where it is wired on main:

| # | Responsibility | Today | Replaceable? |
| --- | --- | --- | --- |
| R1 | **Host a run**: start a coding agent on a work item in a fresh worktree, with provider, model, mode and a prompt | `factory-dispatch` → `paseo run --no-wait --new-workspace worktree ... --label factory-*` | yes, core of the backend |
| R2 | **List and observe runs**: agent states for capacity, maintenance deferral and removal; labels as launch history for the duplicate check | `host agents` over `paseoAgents` (D7 of worker-idleness: `ls --global --background`, the labelled `ls`, `agent inspect` per running agent) for states; `factory-dispatch` still calls `paseo ls --label ...` for the duplicate check | yes |
| R3 | **Isolate workspaces**: create worktrees and own their paths | `~/.paseo/worktrees`, hard-coded in `domain/work-inspection.ts` (`WORK_ROOTS`), `host/work.ts`, the collector's never-read list (`.paseo/config.json`), operator text, and implicitly in the archive's Claude project directory names (`-home-factory--paseo-worktrees-…`) | yes; the backend owns the layout, the factory asks it |
| R4 | **Supervise**: a human reconnects, inspects and intervenes | Paseo clients over Tailscale; the `PASEO_CLIENTS` readiness note | yes; each backend has its own connection path |
| R5 | **Trigger dispatch**: run the dispatch skill on a cadence | `dispatch-schedule.sh` over `paseo schedule *`, driven by `host/dispatch.ts` | yes, and separable from R1–R4 (portable-execution: "scheduling should be separable from execution hosting") |
| R6 | **Register repositories** for supervision | `ExecutionBackend.registerRepositories` → `paseo project ls|create` (#131) | already behind the seam |
| R7 | **Keep the backend software healthy**: install, configure, authenticate, unit, health, reload, restart; classify changes; defer maintenance | `ControlPlane` port (operator) over the activator's four actions; `host/control-plane.ts`; `assets/steps/control-plane/*`; `domain/change-classification.ts` | partly: the worker side is backend-specific; the operator side keeps a generic maintenance port |

R1–R4 are the run contract portable-execution.md proposes (start, inspect,
connect, stop). R5 is the trigger. R6 is a convenience projection. R7 is
maintenance of whatever the backend is.

### Mapping to the overview's layers

Per Phase 1, R1–R6 are all Orchestration in the overview's sense. Within it:
R5 is the trigger, R1–R4 and R6 are the execution backend (the mechanism), and
dispatch policy stays the factory's. R7 is maintenance, which fffactory does
to every layer; its operator-side port is `ControlPlane`. The spec's layer
section says this in the overview's words (decision D1).

### Layer mapping (L1)

Two worker-side seams, one existing operator-side port, one guard test:

| Concern | Layer | Where (after this plan) |
| --- | --- | --- |
| Run request and result types (launch identity, work reference, agent settings, workspace requirement; run observation in fffactory's states), workspace roots and private files as data | domain | `src/domain/run.ts` (new), `src/domain/control-plane.ts` (agent states, exists), `src/domain/work-inspection.ts` (takes roots as input, no Paseo path) |
| `ExecutionBackend`, the one worker-side interface (`HostControlPlane` folds into it, D4): `registerRepositories` (exists), `agents`, `startRun`, `runs`, `layout` (workspace roots, private files), and the maintenance group `install`, `reload`, `restart` | host | `src/host/execution-backend.ts` |
| `DispatchTrigger` worker-side interface: `reconcile(projection)`, `inspect()` | host | `src/host/dispatch-trigger.ts` (new) |
| The one selection point (hardwired to Paseo, TODO from #131 D7) | host | `src/host/execution-backend.ts` |
| Paseo adapter for `ExecutionBackend`: `PaseoCommand`, `paseoAgents`, the run launch flags and labels, `PASEO_AGENT_ID`/`PASEO_WORKSPACE_ID` scrubbing, `~/.paseo` paths, bcrypt at Paseo's cost, `setup-host.sh`/`paseo-auth.sh` paths, `systemctl restart paseo.service` | host (adapter) | `src/host/paseo-backend.ts` |
| Paseo adapter for `DispatchTrigger`: wraps `dispatch-schedule.sh`, sets `PASEO_HOME`, `FACTORY_PASEO_BIN` | host (adapter) | `src/host/paseo-trigger.ts` (new) |
| Worker endpoints call the seam, never Paseo: `host agents`, `host control-plane`, `host dispatch`, `host work inspect`, and the new `host dispatch run` (as `factory`, what the dispatch skill invokes) | host | `src/host/control-plane.ts`, `dispatch.ts`, `work.ts`, `src/cli/commands/host.ts` |
| Operator-side maintenance port, unchanged shape: `health`, `activeAgents`, `install`, `reload`, `restart` | application | `src/application/control-plane.ts` |
| Operator-side Paseo adapter (the health probe on 6767 and the activator actions): the only operator module that names Paseo | infrastructure | `src/infrastructure/paseo-control-plane.ts` |
| Shipped Paseo assets: install, config merge, auth wrapper, unit, pin, schedule reconciler | release assets | `assets/steps/control-plane/`, `assets/steps/dispatch/dispatch-schedule.sh` (moves beside the other Paseo assets or stays, see D5) |
| Dispatch policy (eligibility, capacity, duplicates, branch and PR checks as pure rules over observations) | domain | `src/domain/dispatch-policy.ts` (new, #107) |
| The dispatcher's I/O: GitHub and Git reads, the lock, the launch through the seam | host | `src/host/dispatcher.ts` (new, #107); the Python `factory-dispatch` and its tests are deleted |
| The boundary: a test that scans `src/`, `assets/`, `scripts/` for Paseo's CLI, paths, environment, port and unit outside the allow-listed adapter files; names that #93 owns are quarantined in a second list that shrinks as #93 lands | check | `tests/execution-backend-boundary.test.ts` (new) |
| Specs, three peers under Orchestration (D6): policy in `dispatch.md` (narrowed), the trigger in `dispatch-trigger.md` (new), the backend's responsibilities, contract, allow-list and layer mapping in `execution-backend.md` (new) | spec | `docs/specs/` |

Contracts, in prose (no code in this plan):

- `startRun` takes a launch identity (repository alias, work item, attempt
  stamp), the checkout and base branch, the branch to create, the workflow
  invocation (the prompt), and agent settings (provider, model, mode). It
  returns a run handle (backend's run ID, workspace path) or a failure in
  fffactory's words. Labels are the Paseo adapter's way to carry the launch
  identity; no caller sees them.
- `runs` returns the runs the backend holds with their launch identity and
  fffactory state, so the dispatcher's duplicate check and capacity count read
  one list. (`agents` today is the same list without launch identity; they
  merge.)
- `layout` returns the workspace roots the work inspection searches and the
  private files the collector must never read. Domain rules take them as
  input.
- The maintenance group mirrors `HostControlPlane` today. A backend without a
  daemon implements `reload`/`restart` as `done`.
- `stop` and `connect` have no caller today; they are named in the spec as
  not yet implemented, with a TODO(re-evaluate when a second backend or a stop
  command needs them), per src/CLAUDE.md's no-speculative-ports rule.
- Dispatch's lock file leaves `$PASEO_HOME`; it moves to the factory account's
  own state directory.
- The dispatcher in TypeScript (#107, D3) keeps the behavior its Python tests
  hold today: ready-label and dependency checks, existing branch and PR checks,
  the capacity of one, `--adoption-only`, and the launch inputs. Those tests
  become `bun test` tests over the same scenarios, and `.github/workflows/
  repository-checks.yml` stops running the Python.
- `host agents` (run as `factory`) today builds its own `paseo-auth.sh` command; after step 2 it takes the backend from the one selection point like `host dispatch` does.
- `EXECUTION_BACKENDS` in `domain/repository-registration.ts` is the backend's name in the registration record; it stays a domain enum (one value) and the adapter supplies it.
- Operator-side change classification keeps its change names (`paseo-package`
  and friends are #93's), but the spec records that the table is the Paseo
  backend's maintenance vocabulary.

What does not move: the operator-side health probe stays in the operator
adapter (it is already the adapter, and the activator's fixed action list
cannot grow for existing workers, see #131's placement decision).

## Phase 3: Path

Ordered so each step is one PR, each shrinks the allow-list, and the guard
test holds the inventory from the first step.

1. **Specs and guard first.** Split the specs into the three peers (D6):
   narrow `dispatch.md`, create `dispatch-trigger.md` and
   `execution-backend.md` with the responsibilities table and the inventory as
   an allow-list. Add the boundary test with that allow-list, so it is green
   today and fails when a new file names Paseo's CLI, paths, env, port or unit.
   Quarantine #93's names in a second list with a TODO. CONTEXT.md gains
   "Trigger" and the four layers. Commit boundary: no behavior change.
2. **One worker-side interface.** Fold `HostControlPlane` into
   `ExecutionBackend` (D4): `PaseoCommand`, `paseoAgents`, the setup/auth
   paths, bcrypt, reload and restart move from `src/host/control-plane.ts`
   into `paseo-backend.ts`; `host agents` and `host control-plane` call the
   seam from the one selection point. Allow-list shrinks by one file.
3. **Trigger seam.** `DispatchTrigger` + `paseo-trigger.ts` wrapping
   `dispatch-schedule.sh`; `host/dispatch.ts` loses `PASEO_HOME` and
   `FACTORY_PASEO_BIN`. Allow-list shrinks by one file.
4. **Runs on the seam and the dispatcher in TypeScript (#107, D3).**
   `startRun` and `runs` join the interface and the Paseo adapter (labels as
   launch identity, env scrubbing, the launch flags). Policy becomes
   `domain/dispatch-policy.ts`, I/O `host/dispatcher.ts`, invoked as `factory`
   through `fffactory host dispatch run`; the skill calls it; the lock leaves
   `$PASEO_HOME`; the prompt stops saying "Paseo worktree". The Python
   program, its tests and the CI job that ran them are deleted; the scenarios
   become `bun test` tests. Allow-list shrinks by the dispatcher and its
   tests. Depends on 2. Largest step; may be two PRs (port, then runs on the
   seam) if the port lands cleanly first with the Paseo calls still inline.
5. **Layout as data.** `layout` on the interface; `WORK_ROOTS` and the
   collector's never-read list take their Paseo entries from the adapter;
   `host work inspect` and the collector install pass them in. Operator text
   naming `~/.paseo/worktrees` is #93's.
6. **Tighten and document.** Final allow-list: `src/host/paseo-backend.ts`,
   `src/host/paseo-trigger.ts`, `src/infrastructure/paseo-control-plane.ts`,
   `assets/steps/control-plane/**`, `dispatch-schedule.sh`, and their tests.
   Update SDLC.md ("the execution backend owns worktrees"), src/CLAUDE.md,
   src/host/CLAUDE.md, assets/steps/*/CLAUDE.md, and the layer mappings.

Dependencies: 1 → 2 → {3, 4, 5} → 6. Steps 3, 4 and 5 are independent of each
other. #93 (names) follows this epic. #107 closes with step 4.

## Captured tasks

Epic #136 (2026-11-08):

- #139 T1 — Three peer specs under Orchestration, and the Paseo boundary guard
- #140 T2 — One worker-side interface: HostControlPlane folds into ExecutionBackend (depends on #139)
- #141 T3 — The DispatchTrigger seam and its Paseo adapter (depends on #139)
- #142 T4 — Port the dispatcher to TypeScript, closes #107 (depends on #140)
- #143 T5 — Runs on the seam: startRun and runs (depends on #142)
- #144 T6 — The backend's layout as data (depends on #140)
- #145 T7 — Tighten the boundary and document the layer (depends on #141, #143, #144)

Outcome (#145): the guard's allow-list is step 6's, scanned as `src/`,
`assets/` and `scripts/`: the three adapters, `assets/steps/control-plane/**`,
`dispatch-schedule.sh` and its shipped Python test. The adapters' tests under
`tests/` and `tests/paseo/` need no entry because `tests/` is not scanned
(D5). The #93 quarantine stays with its TODO.
