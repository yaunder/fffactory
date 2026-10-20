# src/host: the worker side of the host protocol

What `fffactory host <subcommand>` does on a worker, where the operator's fffactory runs it
over SSH as `fffactory-admin` (`docs/specs/host-protocol.md`). Rules:

- Read the worker through a `WorkerSystem`, never fixed paths or `process`: its `root`
  (`/` on a worker) prefixes every path in `WORKER_PATHS`, so tests lay out a worker in a
  temporary directory (`tests/host/worker-scenarios.ts`).
- `inspect` is unprivileged and read-only, needs no factory.json, and never throws for what
  it cannot read: absence is an explicit state (`none`), anything else `broken`,
  `unreadable`, `unknown` or `null`.
- Documents are built as `domain/host-protocol.ts` types and printed with its serializer.
  A change to a document changes `tests/host/fixtures/` and the CLI-side parser together
  (`tests/host/protocol-contract.test.ts`), and follows the protocol's versioning rule.
- Run systems tools through the injected `ProcessRunner` with a fixed environment and a
  timeout, by absolute path where a worker has one.
- `apply`, repository reconciliation, and `verify` run as root. `host apply` runs only
  through the activator, which gives it
  no arguments and the host projection on standard input. It holds the install lock
  (`install-lock.ts`, `flock` on `WORKER_PATHS.applyLock`, close-on-exec so no step inherits
  it) from before its first change to its end; held elsewhere, it refuses `busy`. Every
  refusal (`REFUSALS`) is decided before anything changes. After that it records the install
  before each change and after each step (`last-apply.json`, written atomically), makes the
  release active with one rename, runs `INSTALL_STEPS` in order in its own process and stops at
  the first failure, then verifies within `VERIFY_TIMEOUT_MS`. Anything that throws after the
  install is recorded fails it with a `failure` in fffactory's words, and the record is still
  printed. Never poll a marker file or wait for another process.
- `host repositories --apply` runs only through the activator's exact `repositories`
  operation and shares the install lock. It writes the manifest and completed result under
  `/var/lib/fffactory`, but runs Git and the shipped repository step as `factory` through
  `runuser` and `env -i`; neither the operator nor `factory` receives broader sudo.
- `host control-plane` runs only through the activator's fixed `activity`, `install`,
  `reload` and `restart` actions and shares that lock. Activity and reload drop to
  `factory`; install reads the host projection from standard input, reads the Paseo password
  by its reference as root and hashes it (bcryptjs at Paseo's cost), and invokes only the
  active release's setup program, the reference and the hash on its standard input; the
  password reaches only the hash function. Restart is the fixed Paseo systemd action.
- `secret-value.ts` reads a delivered secret by its ARN with `/usr/bin/aws` as root, for the
  `credentials` step and the control-plane install: a `SecretMaterial`, or why not in
  fffactory's words (the AWS error's name at most).
- `host dispatch` runs only through the activator's fixed `adoption`, `reconcile` and
  `inspect` actions and shares that lock. It installs only the active release's assets,
  persists canonical desired and observed state, and drops to `factory` for FFFlow,
  repository and Paseo commands. Inspection checks the schedule before reporting active.
- `host work inspect` runs only through the activator's fixed `work inspect` operation and
  shares that lock. It lists directories as root but runs every Git command as `factory`
  (`runuser`, `env -i`) with `GIT_OPTIONAL_LOCKS=0`, no fsmonitor and no LFS filter, so it
  writes no index, lock, ref or LFS object and never fetches. Its document carries counts and
  printable paths and branch names only (`printablePath`, `printableBranch`), never a file's
  name or content. It bounds itself (`WORK_BUDGET_MS`, `WORK_LIMITS`, its search depth) and
  says `complete: false` rather than guess: a search root reached through a symbolic link, a
  directory at the depth limit holding directories, or a bare repository, is incomplete, never
  no work. A path a repository lists as its worktree is that repository's only when the Git
  directory there is its own (`ownedBy`); another repository at a stale entry's path is
  inspected as itself, and the entry is `unreadable`. A populated submodule is a repository of
  its own, counted against `WORK_LIMITS.repositories`, and is its own only when Git there names
  its directory the top level and a common Git directory in the parent worktree's `modules/`
  (or its own `.git` directory); never `listing()` it, since Git names its Git directory as
  its first worktree. What Git cannot fully report reads `unreadable`, never clean: a `git
  status` that writes to standard error (it exits 0 past a directory it cannot open), an index
  entry assumed unchanged or skip-worktree with its file on disk, a submodule's directory with
  files but no repository, an unused submodule Git directory.
- `plugins.ts` implements the plugin install step and its read-only verifier. It reads
  `plugins.json` through `plugin-manifest.ts`, uses one command deadline for the whole
  operation, and runs tools through `runtime-account.ts` as `factory`. Only locked
  `host apply` invokes installation; there is no standalone plugin mutation command.
- `credentials.ts` implements the `credentials` install step
  (`docs/specs/credential-delivery.md`): it reads each delivered secret with `/usr/bin/aws` as
  root into a `SecretMaterial`, checks every one before any tool runs, and reveals material only
  onto a delivering command's standard input (`ProcessOptions.stdin`), never an argument, an
  environment or the log. Tools run as `factory` through `AS_FACTORY`, files in `factory`'s home
  are written as `factory`, and only `/etc/claude-code` is written by root. With Anthropic not
  delivered it removes Claude Code's managed settings only while they name fffactory's helper
  (`namesKeyHelper`, the test `verify.ts` uses): anyone else's, or unreadable ones, stay. Its
  log holds its own lines only, never a tool's output, and a failure names the account and the
  AWS error name, exit status or deadline.
- A step's output goes only to its log under `WORKER_PATHS.logs`, written by the step itself as
  it runs (`ProcessOptions.output`), never collected and written afterwards; a verifier's tool
  output goes nowhere. Documents carry fffactory's own words and states, never a tool's output.
- Documents carry states, never instructions: the CLI names every next action itself, so a
  worker's document never puts text in front of the operator as something to run.
- Verifiers run the runtime account's commands through `AS_FACTORY` (`runuser`, then
  `env -i`) from `FACTORY_HOME`, never with root's environment or working directory. They
  change nothing.
- Nothing here names or uses SSM; `tests/assets/steps/steps.test.ts` scans this directory.
