# tests/host: the worker side of the host protocol

Tests of `src/host/` (`docs/specs/host-protocol.md`) against worker filesystems laid out in
temporary directories by `worker-scenarios.ts`, never the real `/`.

- `fixtures/` (inspect, apply and verify documents) is the protocol's shared contract.
  `protocol-contract.test.ts` runs every fixture through both sides: the worker side must
  produce it byte for byte; the CLI side must parse it and serialize it back unchanged.
  Change a document, its fixture and the CLI-side parser together.
- Biome leaves `**/fixtures/**/*.json` alone: the fixtures are `JSON.stringify`'s output.
- `apply.test.ts` runs `host apply` over fake steps: real bash scripts written into the
  temporary release and run by the real process runner, or a scripted runner. It holds the
  real install lock (`install-lock.test.ts`) under the temporary root's `/run`.
- `verify.test.ts` answers every command with a scripted runner; `inspect.test.ts` covers the
  unprivileged read-only inspection.
