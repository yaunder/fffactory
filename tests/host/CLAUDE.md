# tests/host: the worker side of the host protocol

Tests of `src/host/` (`docs/specs/host-protocol.md`) against worker filesystems laid out in
temporary directories by `worker-scenarios.ts`, never the real `/`.

- `fixtures/` (inspect, apply, verify and work documents) is the protocol's shared contract.
  `protocol-contract.test.ts` runs every fixture through both sides: the worker side must
  produce it byte for byte; the CLI side must parse it and serialize it back unchanged.
  Change a document, its fixture and the CLI-side parser together.
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
- `verify.test.ts` answers every command with a scripted runner; `inspect.test.ts` covers the
  unprivileged read-only inspection.
