# Plan: paseo-project-registration

- Level: L1
- Stack: typescript
- Capture: github-issues

## Phase 1 — Understanding

_Confirmed with the operator 2026-10-29._

### Problem

A Paseo project is a record in the worker daemon's own state
(`/home/factory/.paseo/projects/projects.json`: root path, kind, remote key).
A replaced worker starts with none. To work on a repository from the Paseo
app, the operator must re-add each one by hand and remember its path under
`/workspace/repos`. factory.json already knows every repository placed on the
host and its path, and apply's repository stage clones them there, but nothing
tells Paseo about them.

Dispatch fills the gap only partly: `paseo run --new-workspace worktree --cwd
<checkout>` registers the project as a side effect (Paseo's workspace
provisioning finds or creates the project for the directory). But that happens
only for a repository with a `ready` epic, so manual work on any other placed
repository still needs a hand-added project.

### Goal

After `fffactory apply`, every repository factory.json places on a worker
appears as a Paseo project on that worker, with no operator action. That
includes a freshly replaced worker, and an existing worker reached by
`fffactory upgrade`.

### Who benefits

The operator: working from the Paseo app on a new or replaced worker no
longer needs manual project adds or memorised remote paths.

### Current spec and code

- `docs/specs/repositories.md`: placement → per-host manifest, clone/sync under
  `/workspace/repos`. The stage "never creates a Paseo worktree". It runs
  before the control-plane stage, so on a fresh worker Paseo is not installed
  or running yet.
- `docs/specs/control-plane.md`: Paseo install, reload and restart, plus health.
  `paseo-auth.sh` is the only path for fffactory's Paseo CLI calls. The stage
  returns early when a worker has no planned changes.
- `docs/specs/dispatch.md`: `dispatch reconcile` runs on every located,
  non-skipped worker on every apply (requested or not), as root, and drops to
  `factory` for Paseo through `paseo-auth.sh`.
- `assets/terraform/bootstrap/fffactory-activate`: closed action allowlist,
  installed at first boot and never updated (Terraform `ignore_changes =
  [user_data]`). An older activator refuses a new action with exit 64
  (`docs/specs/worker-bootstrap.md`).
- Paseo 0.15.0 (the worker pin on main since release 0.0.10; it was 0.11.4
  when planning began) has `paseo project create <path>` →
  `client.addProject(path)`, and `paseo project ls --json` (rows:
  `projectId`, `name`, `kind`, `path`).
- `src/host/control-plane.ts` has `PaseoCommand`: the Paseo CLI as `factory`,
  authenticated, which `paseoAgents` (the worker's agent states) already takes.
  The registration adapter takes it too.

### Constraints

- Live change only: never reload or restart the daemon for this.
- Paseo password only through `paseo-auth.sh`. Configuration reaches the
  worker on stdin or the files apply already writes, never as an SSH command
  token. On the worker, a checkout path may be a local process argument, as
  `factory-dispatch`'s `--cwd` already is: paths are not secret.
- fffactory does not edit Paseo's private state files; it uses the CLI.
- Never delete a project. This mirrors the unmanaged-checkout policy: removing a
  repository from placement stops managing it and deletes nothing.
- One factory-wide lock; no new privileged surface beyond the activator's
  fixed shapes.

### Out of scope

- Worktree/branch cleanup after merge (`autoArchiveAfterMerge`, the
  cleanup-policy decision in SDLC.md:229): separate plan.
- Deleting, renaming or archiving projects.
- Reading Paseo's project list into `fffactory plan` (plan never reads Paseo state).
- `fffactory status` reporting registration (D5).
- A factory.json backend selector (D7).
- Run operations (start, inspect, connect, stop) behind the execution backend.
- Docker/container workers (docs/designs/container-workers.md).
- Changing how dispatch itself creates workspaces.
- Delivery (release, `fffactory upgrade`, `apply` on a worker): operator
  action outside the development flow, not a task in this epic.

## Phase 2 — Architecture / Approach

### Shape

The active release's `host dispatch reconcile` endpoint gains one more duty.
After it reconciles the dispatch schedule, it makes every repository placed on
this worker and present on disk (D1) available through the worker's execution
backend. It reads placement from the repository manifest the repository stage
already wrote (`REPOSITORY_MANIFEST_PATH`).

Because this is release code behind an action the activator already allows,
`fffactory upgrade` + apply delivers it to existing workers with no
replacement.

Registration does not depend on dispatch being requested or active. A
not-requested or pending projection still registers repositories. It never
changes the dispatch state or schedule (D3).

### The execution-backend seam

Registration differs per execution backend (CONTEXT.md: "the selected mechanism
for hosting and supervising runs on a worker"). Paseo registers a project; an
SSH/tmux backend might create a named session per repository or do nothing;
Herdr has its own workspace operations (docs/designs/portable-execution.md,
container-workers.md). So the dispatch endpoint never calls Paseo for this
directly. It calls a worker-side interface and receives a backend-neutral
result:

- `ExecutionBackend.registerRepositories(checkouts)`: given the absolute paths
  of the placed checkouts present on disk, make each available for supervision
  in the backend's own terms. Returns, per checkout, `registered` (newly),
  `present` (already), `failed` (with fffactory's short reason, never the
  tool's output) or `not_applicable` (a backend with nothing to register), plus
  `changed` and the backend's name.
- The Paseo adapter implements it over main's `PaseoCommand` (as `factory`,
  through `paseo-auth.sh`):
  1. `paseo project ls --json` → the `path` of each project Paseo already has;
  2. `paseo project create <path> --json` for each checkout it lacks.
- The backend is chosen in one place, hardwired to Paseo, with
  `TODO(re-evaluate when a second execution backend adapter is built): select
  the backend from factory.json's hosts[].execution_backend` (D7).
- The inspection document carries the result under a backend-neutral key,
  `repository_registration`.

The seam is narrow by design: one operation, the one with a caller. The run
operations portable-execution.md proposes join `ExecutionBackend` only when
dispatch moves behind it. Putting every Paseo interaction behind it is #136.

Paseo behavior this relies on (read from `@getpaseo/server` 0.11.4 and
re-read, unchanged, in 0.15.0, the current pin; proved against the pin in
step 1): `project create` resolves through
`getOrCreateActiveByRoot`, so an active project at the same root is returned,
not duplicated; a missing directory is refused (`directory_not_found`);
`project ls` omits archived projects, so a removed or archived project is
registered afresh (D2). Listing first keeps a rerun a true no-op
(`changed: false`) and leaves existing project records untouched.

Contract: input = this host's placement + the backend's current state;
output = the placed checkouts registered, nothing removed. A live change: no
reload, no restart, never touches agents or workspaces.

### Hexagonal mapping (L1)

| Concern | Layer | Where |
| --- | --- | --- |
| Placed checkout paths for a host; the registration result type, its JSON and parse | domain (pure) | `src/domain/repository-registration.ts` (new), reusing `repository-placement.ts` |
| The `ExecutionBackend` interface (worker-side seam) and the one selection point (D7 TODO) | host | `src/host/execution-backend.ts` (new) |
| The Paseo adapter: `project ls` / `project create` over `PaseoCommand` | host | `src/host/paseo-backend.ts` (new) |
| Calling the backend from dispatch reconcile; recording the result | host | `src/host/dispatch.ts` (`reconcileDispatch`) |
| Carrying the result into the dispatch outcome, exit 2 on failure (D3) | application | `src/application/apply-dispatch.ts`, `verify-factory.ts` |
| The plan's Dispatch row (D4) and apply output | cli | `src/cli/presentation/plan.ts`, `apply.ts` |
| The Paseo CLI contract against the pin | check | `tests/paseo/hash-only-daemon.sh` (`just paseo-check`) |

No operator-side port changes: `WorkflowQueue.reconcile` already returns the
inspection document; it gains an optional field. Older workers' results lack
it and still parse (the parser ignores unknown fields).

### Specs touched

- `docs/specs/dispatch.md`: new section "Repository registration".
- `docs/specs/host-protocol.md`: the inspection document's
  `repository_registration` field.
- `docs/specs/plan-apply.md`: the plan's Dispatch row wording, apply output,
  exit 2 on a registration failure.
- `docs/specs/repositories.md`: cross-reference from placement.
- `CONTEXT.md`: note that the execution backend now owns repository
  registration.
- `src/CLAUDE.md`, `src/host/CLAUDE.md`: the new host modules.

## Phase 3 — Path

Each step is red-then-green and ships its spec edits with its code.

1. **Prove the Paseo contract against the pin.** Extend
   `tests/paseo/hash-only-daemon.sh` (`just paseo-check`): through
   `paseo-auth.sh`, `project ls --json` lists projects with their `path`;
   `project create` registers a new checkout; a second `create` on it returns
   the same project ID; a missing directory is refused. This de-risks every
   later step; if the pin disagrees with the source reading, revise Phase 2
   before going on.
2. **Domain: placement → checkouts, and the result document.**
   `src/domain/repository-registration.ts`: the absolute checkout paths a host's
   manifest places; the per-checkout states (`registered`, `present`,
   `failed`, `not_applicable`), `changed`, backend name; its JSON and a
   tolerant parse (absent field → no result). Unit tests.
   Depends on: nothing.
3. **Host: the `ExecutionBackend` seam and the Paseo adapter.**
   `src/host/execution-backend.ts` (interface, the hardwired selection with the
   D7 TODO) and `src/host/paseo-backend.ts` (`ls` then `create` for the missing
   ones, over `PaseoCommand`, fffactory's own failure words).
   Tests with a fake process runner: none missing → no `create`, `changed:
   false`; some missing → `create` only for those; `ls` fails → every checkout
   `failed`; one `create` fails → only it `failed`.
   Depends on: 1, 2.
4. **Host: dispatch reconcile registers.** `reconcileDispatch` keeps only the
   placed checkouts present on disk (D1), calls the backend after the schedule,
   and writes `repository_registration` into the result and inspection. A
   registration failure leaves the dispatch state as it is (D3).
   Not-requested and pending projections register too. Update
   `tests/host/dispatch.test.ts` and the shared protocol fixtures in
   `tests/host/fixtures/` on both sides. Spec: `dispatch.md` §Repository
   registration, `host-protocol.md`.
   Depends on: 2, 3.
5. **Operator side: plan, apply and exit code.** `apply-dispatch.ts` carries the
   result into the dispatch outcome. A failed registration makes apply exit 2
   with "rerun `fffactory apply`" and names the unregistered checkouts. The
   plan's Dispatch row says `register N placed repositories as Paseo projects`
   (D4). Tests in `tests/application/` and `tests/cli/plan-apply.test.ts`.
   Spec: `plan-apply.md`, `repositories.md` cross-reference, `CONTEXT.md`,
   `src/CLAUDE.md`, `src/host/CLAUDE.md`.
   Depends on: 4.
Natural commit boundaries: one per step. Steps 1–5 are one epic and one PR
(`/fff:work-epic`).

## Captured tasks

Epic #131.

- #132 T1 — Prove Paseo's project commands against the pin
- #133 T2 — The `ExecutionBackend` interface and the Paseo adapter
- #134 T3 — Dispatch reconcile registers placed checkouts
- #135 T4 — Plan row, apply outcome and exit 2
