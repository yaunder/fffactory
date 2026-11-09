# assets/steps/dispatch: the dispatch skill and schedule

The dispatch skill and the Paseo trigger's schedule reconciler, shipped in the release assets.
The dispatcher itself is the release's `fffactory host dispatch run` (`src/host/dispatcher.ts`,
`src/domain/dispatch-policy.ts`), ported from the Python `factory-dispatch` that lived here
(#142, #107). Apply's dispatch stage activates dispatch on a worker only once every readiness
gate passes (`src/application/apply-dispatch.ts`, `src/domain/dispatch-readiness.ts`,
`src/application/workflow-queue.ts`, `src/infrastructure/ffflow-github-workflow-queue.ts`).
Spec: [docs/specs/dispatch.md](../../../docs/specs/dispatch.md) (the dispatcher and skill),
[docs/specs/dispatch-trigger.md](../../../docs/specs/dispatch-trigger.md) (the schedule
reconciler) and [docs/specs/execution-backend.md](../../../docs/specs/execution-backend.md) (the
launch, and the boundary whose allow-list names the reconciler).

- `skill/SKILL.md` is the dispatch skill. The host endpoint installs it into the
  `factory` account's canonical `.agents/skills` directory and links Claude's
  discovery path to it. It runs `/opt/fffactory/current/bin/fffactory host dispatch run`
  from the declared dispatch directory; change the command, its output or its exit codes and
  the skill together. It is no longer a canonical repository skill: moving it here is why
  `scripts/repository-skills.sh` no longer lists `dispatch` in `expected_skills` and asserts
  the skill (naming that command) and the reconciler at these paths, and no Python program.
- `dispatch-schedule.sh`, the Paseo trigger's reconciler, reconciles the one factory-owned
  Paseo schedule from the versioned dispatch projection, as the unprivileged `factory`
  account; it refuses to run as root and uses every declared provider/model/mode/cwd input.
  `src/host/paseo-trigger.ts` runs it with `PASEO_HOME` and `FACTORY_PASEO_BIN` and reads its
  answer, `{host, status, schedule_id, desired}`, from the last non-empty line of its stdout,
  ignoring earlier lines: keep that answer last and its shape, and its exit 0
  for `active` and `absent` and 1 for `drift`, in step with the adapter.
- These are not `INSTALL_STEPS`: `tests/assets/steps/steps.test.ts` lists only the
  top-level `assets/steps/*.sh`, so this subdirectory is excluded.
- `tests/test_dispatch_schedule.py` is the Python test of the reconciler, run in CI
  (`.github/workflows/repository-checks.yml`), never by `bun test`; Python stays in CI for it
  and the control-plane step tests. Keep it green from here; it resolves the reconciler one
  directory up, and reads the checkout's `tests/host/fixtures/dispatch-not-requested.json`, the
  projection the CLI sends to stop dispatch, so it runs only from a checkout.
- The reconciler is ported to TypeScript only when it is changed for another reason (D3).
  Until then, change it and its test together.
