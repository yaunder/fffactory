# assets/steps: the wrapped install steps

The worker's install steps, run by `fffactory host apply` as root, one after another in one
process, in the order `INSTALL_STEPS` (`src/domain/installation.ts`) names them, stopping at
the first that fails. Spec: [docs/specs/host-protocol.md](../../docs/specs/host-protocol.md)
§apply. Wrapped from v1's setup scripts (D3): a step is ported to TypeScript only when it is
changed for another reason.

- One `<step>.sh` per install step, plus `validate-plugins.sh`; `versions.env` and
  `plugins.json` are the pins. `tests/assets/steps/steps.test.ts` checks the list.
- Bash on Amazon Linux 2023, `set -Eeuo pipefail`, shellcheck-clean (CI checks), executable.
  `host apply` runs each with `/bin/bash`, as root, from `/`, with only `PATH`, `HOME=/root`,
  `LANG` and the `FFFACTORY_*` inputs in its environment; read inputs only from those, never
  from v1's deployed paths.
- Idempotent: a rerun repairs what a failed run left. Exit non-zero to fail the install.
- Never wait for another step or poll a marker file: `host apply` orders the steps. Never write
  a completion marker or state record: `host apply` records each step's result.
- Output goes to the step's log, `/var/log/fffactory/<step>.log`, readable by
  `fffactory-admin`: never print a secret.
- Never mention SSM here; a test fails on it.
- A step that still needs `jq` carries a `TODO(re-evaluate when …)` naming when to drop it.
- `versions.env` and `plugins.json` are the only pins of the agent CLIs and Claude Code
  plugins: v1's originals in `agent-harness/` were deleted in #102.
- `repositories/` holds the repository-sync program the repository stage runs over SSH, not an
  install step; its own CLAUDE.md has the rules.
- `control-plane/` holds the Paseo control-plane step (install, verify, the config merge, the
  auth wrapper, the service unit and the Paseo pin), driven by the control-plane stage, not an
  install step; its own CLAUDE.md has the rules.
