# Decisions: execution-backend-abstraction

✓ D1 Overview layer names (2026-11-06, user)
   Chose: the spec adopts the overview's four layers (Orchestration, Harness, Dev environment,
   Compute, per Dex Horthy and Vaibhav Gupta). Dispatch policy, the trigger and the execution
   backend are all Orchestration; the spec names those three parts. Backend maintenance is not
   a layer: it is fffactory's declare-and-apply job, like pinning the harness.
   Rationale: the overview defines Orchestration as "assigns work to agents, tracks how it's
   going, and decides what happens next", which covers hosting and observing runs, not only
   dispatch. Splitting "execution" out as a fifth layer would put the spec at odds with the
   published framing.
   Rejected alternatives:
     - a separate "Execution" layer beneath Orchestration: cleaner for the port boundary, but
       a fifth layer nobody else uses; the port boundary is expressed as parts instead.
     - "control plane" as the layer name: CONTEXT.md reserves it away from execution hosting.

✓ D2 Shape: two worker-side ports under the Orchestration layer (2026-11-06, user)
   Chose: one `ExecutionBackend` interface with method groups (runs, agents, registration,
   layout, maintenance) and a separate `DispatchTrigger` interface. The operator-side
   `ControlPlane` port keeps its shape. The Orchestration relabel does not change this: the
   layer says what the code is for, the ports say where it varies, and the trigger and the
   backend vary independently (a Paseo backend with a timer trigger is a real combination).
   Rejected alternatives:
     - one interface holding the trigger too: SSH/tmux would implement a timer inside a
       "backend", and portable-execution says scheduling is separable.
     - a port per responsibility: five selection points, most with one caller.

✓ D3 The dispatcher is ported to TypeScript inside this epic (2026-11-06, user)
   Chose: #107 joins this epic as the runs step. The dispatcher's policy becomes pure domain
   code, its I/O (gh, git, the backend) host code, run as `factory` through
   `fffactory host dispatch run`; the dispatch skill calls that; the Python program and its
   tests are deleted. `startRun` and `runs` join `ExecutionBackend` in the same step and the
   dispatcher calls them in-process.
   Rationale: the dispatcher's own TODO says to port it when the launch next changes, and this
   is that change. No throwaway CLI contract between Python and the seam.
   Rejected alternatives:
     - thin `fffactory host runs start|ls` commands the Python shells out to (the `host agents`
       precedent): finishes sooner, but builds a CLI surface #107 then deletes.
     - leave the Python's Paseo calls and allow-list the dispatcher: the guard cannot prove
       the seam.

✓ D4 One worker-side interface: HostControlPlane folds into ExecutionBackend (2026-11-06, user)
   Chose: `HostControlPlane` (activity, agents, install, reload, restart) and `ExecutionBackend`
   are two interfaces for the same thing; they merge into `ExecutionBackend`, the one selection
   point. A daemonless backend answers reload and restart with `done`. The operator-side
   `ControlPlane` port is unchanged (the activator's fixed actions cannot change for existing
   workers).
   Rationale: the software being maintained is the backend's own; nothing varies the two apart.
   Rejected alternatives:
     - keep two worker-side interfaces: two selection points that must agree on the worker's
       backend.

✓ D5 Guard scope and the #93 quarantine (2026-11-06, user)
   Chose: the guard scans `src/`, `assets/`, `scripts/` (not docs, not tests under the
   allow-listed adapters' tests) for behavior tokens: `paseo` CLI invocations, `.paseo` paths,
   `PASEO_*` env, port 6767, `paseo.service`, `@getpaseo`. Names #93 owns (`paseo-password`,
   `paseo_password_secret*`, `paseo-package`, `paseo-configuration`, `paseo_health`,
   `paseo_changed`, `PASEO_CLIENTS`, "Paseo" in human output) sit in a second list marked
   `TODO(re-evaluate when #93 lands): remove`. `dispatch-schedule.sh` stays where it is, allow-listed.
   Rejected alternatives:
     - scan for the bare word only after #93: the guard waits on another epic.
     - move `dispatch-schedule.sh` under `assets/steps/control-plane/`: tidier allow-list, but
       the activator and host/dispatch.ts path references change for no behavior gain.

✓ D6 Spec layout mirrors the three peer parts of Orchestration (2026-11-06, user)
   Chose: three peer specs. `dispatch.md` narrows to policy and activation (gate matrix,
   capacity, duplicates, the `WorkflowQueue` connector, skipped workers). The schedule
   reconciler and the `DispatchTrigger` port move to a new `dispatch-trigger.md`. The backend
   (responsibilities, the `ExecutionBackend` contract, the allow-list, layer mapping) goes in a
   new `execution-backend.md`. Each carries its own layer mapping; CONTEXT.md gains "Trigger"
   and the four-layer framing, and the sections that moved leave a one-line pointer behind.
   Rejected alternatives:
     - one `orchestration.md` with three sections: one file, but dispatch.md is already large
       and well-linked, so it would be a big move for no behavior gain.
     - backend spec only, trigger stays in dispatch.md: fewer files, but the trigger would
       read as part of policy, which is the conflation being undone.

✓ D7 `stop` and `connect` named in the spec, marked not implemented (2026-11-06, user)
   Chose: the run contract in `execution-backend.md` lists start, inspect, connect and stop;
   connect and stop are marked not implemented with
   `TODO(re-evaluate when a second backend or a stop command needs them)`. They are not on the
   interface (no caller; src/CLAUDE.md forbids speculative ports).
   Rejected alternatives:
     - add them with the Paseo implementation: proves the contract, but nothing calls them and
       the SSH/tmux comparison is out of scope.
