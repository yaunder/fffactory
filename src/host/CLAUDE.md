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
  `factory`; install reads the host projection from standard input and invokes only the
  active release's setup program; restart is the fixed Paseo systemd action.
- `host dispatch` runs only through the activator's fixed `adoption`, `reconcile` and
  `inspect` actions and shares that lock. It installs only the active release's assets,
  persists canonical desired and observed state, and drops to `factory` for FFFlow,
  repository and Paseo commands. Inspection checks the schedule before reporting active.
- A step's output goes only to its log under `WORKER_PATHS.logs`, written by the step itself as
  it runs (`ProcessOptions.output`), never collected and written afterwards; a verifier's tool
  output goes nowhere. Documents carry fffactory's own words and states, never a tool's output.
- Documents carry states, never instructions: the CLI names every next action itself, so a
  worker's document never puts text in front of the operator as something to run.
- Verifiers run the runtime account's commands through `AS_FACTORY` (`runuser`, then
  `env -i`), never with root's environment. They change nothing.
- Nothing here names or uses SSM; `tests/assets/steps/steps.test.ts` scans this directory.
