# Decisions: paseo-project-registration

✓ Never delete projects
   Chose: registration only adds; a repository removed from placement keeps its project.
   Rationale: mirrors the unmanaged-checkout policy (repositories.md §Unmanaged checkouts); v2 has no reviewed deletion policy.
   Rejected alternatives:
     - reconcile to exactly the placed set: deletes operator-added projects and their workspaces (`paseo project delete` archives workspaces too).

✓ Use the Paseo CLI, not Paseo's state files
   Chose: `paseo project create` through `paseo-auth.sh`, as `factory`.
   Rationale: dispatch.md already refuses to edit Paseo's private state; the CLI is the supported contract.
   Rejected alternatives:
     - write ~/.paseo/projects/projects.json directly: private format, unsafe while the daemon runs.

✓ Where registration runs on the worker
   Chose: inside the active release's `host dispatch reconcile` endpoint (activator `dispatch reconcile`).
   Rationale: the change ships as release code, so `fffactory upgrade` + apply delivers it to existing workers (operator's requirement: no worker replacement). The activator already allows the action, it runs on every located, non-skipped worker on every apply whether or not dispatch is requested, it already drops to `factory`, calls Paseo through `paseo-auth.sh`, and has the placement manifest on disk.
   Rejected alternatives:
     - new activator action `control-plane projects`: the activator is first-boot user data (Terraform `ignore_changes = [user_data]`), never updated by upgrade; existing workers refuse it (exit 64) until replaced, and the bootstrap change forces a base-generation decision (raising it blocks upgrade until M3 base migration).
     - the `repositories` endpoint: runs before the control-plane stage, so Paseo is not installed or running on a fresh worker.
     - `control-plane reload`: runs only on a reload-safe change, not every apply.
   Accepted cost: dispatch's endpoint takes on a non-dispatch duty; teardown's dispatch stop (byte-identical not-requested projection) will also register repositories, harmlessly, before the machine is destroyed.

✓ D1 Which checkouts get registered
   Chose: every placed checkout present on disk as a directory, whatever its sync result.
   Rationale: an unresolved (dirty, divergent) checkout is still one the operator wants to open; Paseo refuses a missing directory anyway.
   Rejected alternatives:
     - only synchronized checkouts: hides exactly the repositories that need attention.
     - every placed path: a never-cloned path only produces `directory_not_found` failures.

✓ D2 A placed project removed in Paseo
   Chose: re-register it on the next apply.
   Rationale: apply aligns the worker with declared configuration; placement means "shown". To stop showing one, unplace it.
   Rejected alternatives:
     - register once, remembered in worker state: extra state, lost on replacement anyway, diverges from config.
     - register only on fresh clone: misses an existing worker reached by upgrade (the motivating case).

✓ D3 Registration failure
   Chose: dispatch state and schedule unaffected; apply reports the unregistered checkouts with "rerun `fffactory apply`" and exits 2 (incomplete), not 1.
   Rationale: a convenience projection must not fail an apply or block dispatch, but must not be silent.
   Rejected alternatives:
     - fail the dispatch outcome (exit 1): too strong for a convenience projection.
     - log only: a silent gap.

✓ D4 Plan visibility
   Chose: the plan shows it per worker (e.g. "register 3 placed repositories as Paseo projects").
   Rationale: apply performs only what the reviewed plan described.
   Rejected alternatives:
     - apply output only: an unreviewed action.

✓ D5 Status
   Chose: no status reporting for now.
   Rationale: apply reports it and the Paseo app shows the outcome; status would need a new read of the stored result.
   Rejected alternatives:
     - status reads the stored result: deferred until registration is seen failing unnoticed in practice.

✓ D5a (operator requirement) Registration sits behind an execution-backend seam
   Chose: a seam so SSH/tmux or Herdr can supply their own registration later; the dispatch endpoint never calls Paseo for this directly.
   Rationale: consistent with docs/designs/portable-execution.md and container-workers.md.

✓ D6 Where the seam lives and what it is called
   Chose: a worker-side `ExecutionBackend` interface (`src/host/execution-backend.ts`) with one operation, `registerRepositories`; the Paseo adapter in `src/host/paseo-backend.ts`.
   Rationale: per-backend behavior runs on the worker; named for CONTEXT.md's existing term so the run operations portable-execution.md proposes can join it later; one operation because only one has a caller (src/CLAUDE.md: no speculative ports).
   Rejected alternatives:
     - narrowly named `RepositoryRegistrar`: avoids pre-committing the name, but forces a second interface when backends grow run operations.
     - operator-side port in `application/`: the operator would need each worker's backend and send backend-specific instructions; splits backend logic across machines.

✓ D7 How a worker's backend is selected
   Chose: hardwire Paseo at the one selection point, with `TODO(re-evaluate when a second execution backend adapter is built): select the backend from factory.json's hosts[].execution_backend`.
   Rationale: a selector with one valid value is speculative configuration; its right shape (per host or per factory, tied to the Docker image or not) depends on open container-workers.md decisions.
   Rejected alternatives:
     - optional `hosts[].execution_backend`, `"paseo"` only, Paseo when absent: keeps schema version 1 (instance-configuration.md), so it would not block upgrade, but it is schema, validation, projection and docs work for a choice nobody can make yet.

✓ Re-verified at capture (2026-11-05) against origin/main
   Main moved while the plan was open: Paseo pin 0.15.0 (release 0.0.10), worker-idleness (#94) and log-archive phase 1 (#109) merged.
   - Paseo 0.15.0 keeps the relied-on project behavior (`getOrCreateActiveByRoot`, `directory_not_found`, `ls` omits archived); `project ls --json` rows are `projectId`, `name`, `kind`, `path`.
   - The activator's allowlist is unchanged; `dispatch reconcile` still exists, so the placement decision holds.
   - Main has no execution-backend interface; it has `PaseoCommand` (`src/host/control-plane.ts`), which `paseoAgents` takes. The Paseo registration adapter takes it too rather than building its own `runuser` command.
