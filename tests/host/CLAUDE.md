# tests/host: the worker side of the host protocol

Tests of `src/host/` (`docs/specs/host-protocol.md`) against worker filesystems laid out in
temporary directories by `worker-scenarios.ts`, never the real `/`.

- `fixtures/` (inspect, apply, verify, work and activity documents) is the protocol's shared
  contract.
  `protocol-contract.test.ts` runs every fixture through both sides: the worker side must
  produce it byte for byte; the CLI side must parse it and serialize it back unchanged.
  `dispatch-not-requested.json`, the projection that stops dispatch, goes the other way: the
  CLI side builds it byte for byte, the worker side parses it unchanged, and `dispatch.test.ts`
  and the reconciler's Python test (`assets/steps/dispatch/tests/`) remove the schedule for it.
  `projection-log-archive.json`, a host projection carrying the log archive, goes the same way:
  the CLI side projects it byte for byte, the worker side parses it unchanged, and `host
  inspect` reports its control-plane part's digest apart.
  `activity-agents.json` is also what `host agents` prints, and the dispatcher's Python test
  (`assets/steps/dispatch/tests/test_factory_dispatch.py`) reads it as its capacity check's
  answer. Change a document, its fixture and the CLI-side parser together.
- Biome leaves `**/fixtures/**/*.json` alone: the fixtures are `JSON.stringify`'s output.
- `apply.test.ts` runs `host apply` over fake steps: real bash scripts written into the
  temporary release and run by the real process runner, or a scripted runner. It holds the
  real install lock (`install-lock.test.ts`) under the temporary root's `/run`.
- `work.test.ts` runs `host work inspect` over real Git repositories that `work-scenarios.ts`
  lays out in a temporary worker root, with a remote outside it; its runner checks each command
  drops to `factory`, then runs the rest as the test's user. `protocol-contract.test.ts` builds
  `fixtures/work-unresolved.json` from the same real Git.
- `plugins.test.ts` exercises native plugin installation and verification with local
  metadata and a scripted process runner, including unversioned marketplace entries,
  exact commit/version/content checks, drift repair and undeclared plugin removal.
- `credentials.test.ts` runs the `credentials` step over a scripted runner, Secrets Manager
  answered by ARN: it asserts each command, deadline and standard input, and searches every
  argument, environment value and log line for the material it used.
- `control-plane.test.ts` runs the control-plane endpoint over a scripted runner: for
  activity and `host agents`, a scripted Paseo (`paseo`) answering its lists and each agent's
  inspection, as 0.13.2 prints them, after the auth wrapper however it was run; for install,
  Secrets Manager answering the Paseo password: it checks the hash setup is sent with
  `bcryptjs`'s `compareSync`, and searches every argument, environment value and setup input
  for the password.
- `verify.test.ts` answers every command with a scripted runner; `inspect.test.ts` covers the
  unprivileged read-only inspection.
- `collect.test.ts` runs the collection run (`docs/specs/collector.md` §Run) over a Claude root
  laid out in a temporary worker root, every write a later modification time, writing to
  `support/memory-archive.ts` (create-once keys, a failure or a crash before or after any put,
  and a hook before each put that changes the worker mid-run). It reassembles the archive by the
  reader's rules with `support/archive-reassembly.ts`, checks every reassembled state is a prefix
  of content the file held and the last equals it, and that the checkpoint names only stored
  data, also over a seeded random sequence of appends, rewrites and crashes.
