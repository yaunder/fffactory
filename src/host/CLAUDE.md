# src/host: the worker side of the host protocol

What `fffactory host <subcommand>` does on a worker, where the operator's fffactory runs it
over SSH as `fffactory-admin`, all but `host agents`, which the dispatcher runs as `factory`,
and `host collect --once`, which the log archive's timer runs as `factory`
(`docs/specs/host-protocol.md`). Rules:

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
  `factory`. Activity runs `paseoAgents`, the one place Paseo's agent statuses are known: it
  translates them into `domain/control-plane.ts`'s `AgentState`, inspects only `running`
  agents, and answers `unknown` for anything it cannot read, all its calls within one budget
  (`ACTIVITY_BUDGET_MS`) under the CLI's wait; no Paseo status, field or label
  reaches its document. It takes a `PaseoCommand`, so another caller can run Paseo its own
  way; install reads the host projection from standard input, reads the Paseo password
  by its reference as root and hashes it (bcryptjs at Paseo's cost), and invokes only the
  active release's setup program, the reference and the hash on its standard input; the
  password reaches only the hash function. Restart is the fixed Paseo systemd action.
- `host agents --json` is the one subcommand neither the operator's fffactory nor the
  activator runs: the worker's dispatcher runs it as `factory` for its capacity check, so a
  dispatch tick never waits on the install lock. It refuses root, runs `paseoAgents` through
  the active release's auth wrapper itself in `factory`'s clean environment
  (`FACTORY_ENV`), within the activity's budget, prints the activity document, and exits 1
  when the agents are unknown, so dispatch fails safe.
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
  files but no repository, an unused submodule Git directory. Before any Git command it counts
  the log archive's backlog (`archive`, `docs/specs/host-protocol.md` §The archive's backlog):
  `not_collected` without `/etc/fffactory/collector.json`; otherwise the collector's checkpoint,
  read as root never through a link and only as a bounded regular file (none if not), against
  the collector's own discovery (`discoverSources` in `collect.ts`, never a copy of it), stat
  only, within `ARCHIVE_BUDGET_MS` (the checkpoint's read included) and `ARCHIVE_ENTRY_LIMIT`,
  `complete: false` past them, all out of `WORK_BUDGET_MS`, whose clock starts before it, so the
  whole inspection ends well inside the CLI's `INSPECT_WORK_TIMEOUT_MS`. It
  never touches the document's `complete`: a backlog never refuses a removal.
- `plugins.ts` implements the plugin install step and its read-only verifier. It reads
  `plugins.json` through `plugin-manifest.ts`, uses one command deadline for the whole
  operation, and runs tools through `runtime-account.ts` as `factory`. Only locked
  `host apply` invokes installation; there is no standalone plugin mutation command.
- `credentials.ts` implements the `credentials` install step
  (`docs/specs/credential-delivery.md`): it reads each delivered secret with `/usr/bin/aws` as
  root into a `SecretMaterial`, checks every one before any tool runs, and reveals material only
  onto a delivering command's standard input (`ProcessOptions.stdin`), never an argument, an
  environment or the log. Tools run as `factory` through `AS_FACTORY`, files in `factory`'s home
  are written as `factory`, and only `/etc/claude-code` is written by root. It composes Claude
  Code's managed settings from what fffactory needs (`claudeManagedSettingsJson`: the helper
  while Anthropic is delivered, `cleanupPeriodDays` while the projection carries `log_archive`),
  replacing whatever was there; needing neither, it removes them only while they are
  fffactory's own (`ownsManagedSettings`): anyone else's, or unreadable ones, stay. `verify.ts`
  checks the key file while they name the helper (`namesKeyHelper`). Its log holds its own lines
  only, never a tool's output, and a failure names the account (or the log archive) and the AWS
  error name, exit status or deadline.
- `collector-step.ts` implements the `collector` install step, last in `INSTALL_STEPS`
  (`docs/specs/host-protocol.md` §The collector step), the only other code on the worker that
  reads `log_archive`: with it, `/etc/fffactory/collector.json` and the service and timer
  `domain/collector-installation.ts` defines, written by root (`root-files.ts`, shared with
  `credentials.ts`), then `/usr/bin/systemctl daemon-reload` and `enable --now` of the timer;
  without it, the timer disabled and a run stopped (each only while its unit file is there), the
  files removed and systemd reloaded, the state directory kept, and nothing at all where none of
  them is. It never starts, inspects or waits for a collection: the collector's health is never
  the install's, so neither `verify.ts`, `WORKER_SERVICES` nor a dispatch gate names it. Its log
  holds systemctl's output and its own lines, never a configuration value. Change the unit's
  directives and the spec's unit text together.
- `collect.ts` is one collection run (`docs/specs/collector.md` §Run), run as `factory`, not
  through the activator: it takes `collect.lock` in its own state directory (`COLLECTOR_STATE`,
  the unit's `StateDirectory`, `domain/collector-installation.ts`) and ends `busy` when another
  holds it; it never names `WORKER_PATHS.applyLock`, so it never
  blocks or waits on an install. It decides by `domain/collector.ts` alone and writes only
  through an injected `ArchiveWriter` (`domain/archive-format.ts`): `incarnation.json` when it
  is given one, blobs, then the journal
  record, then the checkpoint (atomically), whose entries take a capture only once its record
  is stored. It finds sources by `lstat`, opens them `O_NOFOLLOW` and reads one only while it is
  still the device and inode found and `/proc/self/fd` (`CollectSystem.openFiles`) shows it
  open at its own path under the Claude root's real path (its parent resolved, its own name
  kept); found open elsewhere or unverifiable, it fails the run (`SourcePathMismatch`,
  `OpenPathUnverified`) and leaves the source, never silently. It never changes a source. Its
  time budget bounds the decisions' hashing too, newest first, with half the budget, so a run always reaches its checkpoint (§Budgets). File-system failures are
  reported by their error code, a vanished source is none, and an error without a code is
  thrown. Tests run it over a worker in a temporary directory and `tests/support/memory-archive.ts`.
- `host collect --once` (`collection.ts`, `docs/specs/collector.md` §Credentials and
  publishing) is the other subcommand run as `factory`, by the log archive's timer, never
  through the activator; it refuses root. Without `/etc/fffactory/collector.json` it does
  nothing and asks nothing. It opens the archive through `s3-archive-writer.ts`, the one place
  in `host/` that calls AWS through the SDK (the written exception in `src/CLAUDE.md`):
  instance-metadata credentials only (IMDSv2), its prefix and bucket owner from
  `sts:GetCallerIdentity`, every put create-once (`If-None-Match: *`, `ExpectedBucketOwner`),
  every call within `ARCHIVE_CALL_DEADLINE_MS`, failures by error name or code only. Then
  `collectOnce` (which creates `incarnation.json` first under its lock) and the heartbeat. Its
  failures go only to the heartbeat and its own lines on standard output and error (the
  journal). `localCollectionSystem` is the only production `CollectionSystem`: it alone sets
  `openFiles` to `OPEN_FILES` (`/proc/self/fd`), and `cli/main.ts` wires
  `workerCollection(localCollectionSystem(RELEASE))`, which `tests/host/collection.test.ts`
  checks; a null `openFiles` is for tests where there is no `/proc`.
- A step's output goes only to its log under `WORKER_PATHS.logs`, written by the step itself as
  it runs (`ProcessOptions.output`), never collected and written afterwards; a verifier's tool
  output goes nowhere. Documents carry fffactory's own words and states, never a tool's output.
- Documents carry states, never instructions: the CLI names every next action itself, so a
  worker's document never puts text in front of the operator as something to run.
- Verifiers run the runtime account's commands through `AS_FACTORY` (`runuser`, then
  `env -i`) from `FACTORY_HOME`, never with root's environment or working directory. They
  change nothing.
- Nothing here names or uses SSM; `tests/assets/steps/steps.test.ts` scans this directory.
