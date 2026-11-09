# tests/host: the worker side of the host protocol

Tests of `src/host/` (`docs/specs/host-protocol.md`) against worker filesystems laid out in
temporary directories by `worker-scenarios.ts`, never the real `/`.

- `fixtures/` (inspect, apply, verify, work and activity documents) is the protocol's shared
  contract.
  `protocol-contract.test.ts` runs every fixture through both sides: the worker side must
  produce it byte for byte; the CLI side must parse it and serialize it back unchanged.
  `work-before-archive.json`, an older worker's work inspection without `archive`, is read by
  the CLI side only: the worker side no longer produces it.
  `dispatch-not-requested.json`, the projection that stops dispatch, goes the other way: the
  CLI side builds it byte for byte, the worker side parses it unchanged, and `dispatch.test.ts`
  and the reconciler's Python test (`assets/steps/dispatch/tests/`) remove the schedule for it.
  `projection-log-archive.json`, a host projection carrying the log archive, goes the same way:
  the CLI side projects it byte for byte, the worker side parses it unchanged, and `host
  inspect` reports its control-plane part's digest apart.
  `dispatch-registered.json` is a reconcile's inspection with its repository registration:
  `dispatch reconcile` produces it from a scripted schedule and Paseo, and the CLI reads it,
  also through the `WorkflowQueue`; `dispatch-before-registration.json`, an older worker's
  without it, is read by the CLI side only.
  `activity-agents.json` is also what `host agents` prints, and the dispatcher's test
  (`dispatcher.test.ts`) gives its agents as the backend's answer to the capacity check.
  Change a document, its fixture and the CLI-side parser together.
- Biome leaves `**/fixtures/**/*.json` alone: the fixtures are `JSON.stringify`'s output.
- `apply.test.ts` runs `host apply` over fake steps: real bash scripts written into the
  temporary release and run by the real process runner, or a scripted runner. It holds the
  real install lock (`install-lock.test.ts`) under the temporary root's `/run`.
- `work.test.ts` runs `host work inspect` over real Git repositories that `work-scenarios.ts`
  lays out in a temporary worker root, with a remote outside it; its runner checks each command
  drops to `factory`, then runs the rest as the test's user. `protocol-contract.test.ts` builds
  `fixtures/work-unresolved.json` from the same real Git, and `work-archive-backlog.json` from
  `work-scenarios.ts`'s `archivingWorker`. `work-archive.test.ts` runs its archive section over a
  Claude root, the collector's configuration and a checkpoint laid out there
  (`configureCollector`, `saveCheckpoint`, `captured`), each write a later modification time.
- `plugins.test.ts` exercises native plugin installation and verification with local
  metadata and a scripted process runner, including unversioned marketplace entries,
  exact commit/version/content checks, drift repair and undeclared plugin removal.
- `credentials.test.ts` runs the `credentials` step over a scripted runner, Secrets Manager
  answered by ARN: it asserts each command, deadline and standard input, and searches every
  argument, environment value and log line for the material it used.
- `control-plane.test.ts` runs the control-plane endpoint and `host agents` over a fake
  `ExecutionBackend` (`support/fake-execution-backend.ts`, which records every call and every
  budget and environment its selection was given, and keeps to the run contract: asked for a
  work's runs, only those `launchedFor` it) and, for install, Secrets Manager answering the
  Paseo password: privilege, the projection, the password read and handed on, the budgets, and
  the backend's answers passed on, its runs read as agents. It runs no backend command.
- `dispatch.test.ts` runs the dispatch endpoint over a fake `DispatchTrigger`
  (`support/fake-dispatch-trigger.ts`, which keeps one trigger as a reconciler would over the
  persisted projection, records every call and timeout, and answers as a test sets), and a
  scripted runner answering Paseo's registration commands (after the auth wrapper), with a
  repository manifest and checkouts laid out under the temporary root (`placeRepositories`). It
  runs no trigger command.
- `dispatcher.test.ts` runs the dispatcher (`host dispatch run`) in process, as the Python
  dispatcher's tests ran it, one case for each of theirs: a worker laid out in the temporary
  root, a real bare Git remote that `GIT_CONFIG_GLOBAL`'s `insteadOf` puts in GitHub's place,
  the release's real FFFlow adoption check and repository program (the latter behind a wrapper
  recording each mode), a stand-in `gh` on the caller's `PATH` answering by `MOCK_READINESS`,
  and the runs from `support/fake-execution-backend.ts`, read afresh from the test's world
  (each dispatched run with the epic it was launched for), whose `startRun` records the request
  and takes the slot. Where a case goes through the real Paseo backend end to end (the real
  selection), a stand-in for the auth wrapper answers the epic's labelled list and the launch
  from the test's runs, records how it was run, and answers the adapter's own lists from rows
  the test writes. Stand-ins are Bun scripts behind a shell wrapper with their paths written in,
  since the adapter's own calls may get a clean environment. The exact Paseo commands are
  `paseo-backend.test.ts`'s. It holds the real dispatch lock (`flockExclusive`),
  and the Python dispatcher's under the temporary root's Paseo home where a case needs it.
  `dispatch.test.ts` covers the activator's adoption over a scripted runner.
- `paseo-trigger.test.ts` runs the Paseo trigger over a scripted runner: the reconciler's exact
  command, timeout and environment (`PASEO_HOME` and `FACTORY_PASEO_BIN` set there, and nowhere
  else: the adoption probe's command in `dispatch.test.ts` carries neither), and its answer, as
  `dispatch-schedule.sh` prints it, read into the trigger's inspection.
- `paseo-backend.test.ts` runs the Paseo adapter over a scripted runner: Paseo's own arguments
  after the auth wrapper, however it was run (from root by `runuser`, or as `factory`), answered
  as Paseo 0.15.0 prints them (`project ls` and `project create`, the agent lists, a work's
  labelled list and each agent's inspection, and `run`'s `agentId`), and setup and `systemctl`.
  It asserts each command, environment (the caller's as given, the launch's without
  `PASEO_AGENT_ID` and `PASEO_WORKSPACE_ID`), directory, budget and setup input; checks the hash setup is sent with `bcryptjs`'s `compareSync`; and searches
  every argument, environment value, setup input and result for the password.
- `verify.test.ts` answers every command with a scripted runner; `inspect.test.ts` covers the
  unprivileged read-only inspection.
- `collect.test.ts` runs the collection run (`docs/specs/collector.md` §Run) over a Claude root
  laid out in a temporary worker root, every write a later modification time, writing to
  `support/memory-archive.ts` (create-once keys, a failure or a crash before or after any put,
  and a hook before each put that changes the worker mid-run). It reassembles the archive by the
  reader's rules with `support/archive-reassembly.ts`, checks every reassembled state is a prefix
  of content the file held and the last equals it, and that the checkpoint names only stored
  data, also over a seeded random sequence of appends, rewrites and crashes.
  `collect.test.ts` gives the run no `incarnation.json` unless a test does, so put indices
  count only the run's own objects.
- `collector-step.test.ts` runs the `collector` install step over a scripted `systemctl` that
  writes to the step's log as the real one does. It also spawns
  `support/aws-endpoint-probe-main.ts` under the service's environment, assembled from the unit
  text by systemd's rules (the manager's variables, then `Environment=`, then
  `UnsetEnvironment=`), with a `~/.aws` and inherited settings pointing at closed local ports, and
  without that environment as the baseline. The probe resolves where instance metadata, STS and S3
  would be asked and stops each request once built, sending nothing; it is not `fffactory`, so it
  gets that environment rather than `isolatedAwsEnvironment`, whose settings it exists to test.
- `s3-archive-writer.test.ts` and `collection.test.ts` run the S3 archive writer and `host
  collect --once` on the real AWS SDK against `support/loopback-imds.ts`, `support/stub-sts.ts`
  and `support/stub-s3.ts` (with `requireIfNoneMatch`), the metadata endpoint set only around
  the open (`withMetadataEndpoint`); nothing reaches AWS. A network failure is a real refused
  connection to `CLOSED_ENDPOINT`.
