# assets/steps/dispatch: the dispatch program, schedule and skill

The factory's dispatch program, its Paseo schedule reconciler and the dispatch
skill, shipped as shell steps in the release assets (D3; reimplemented in
TypeScript only when next touched for another reason). Apply's dispatch stage
activates dispatch on a worker only once every readiness gate passes
(`src/application/apply-dispatch.ts`, `src/domain/dispatch-readiness.ts`,
`src/application/workflow-queue.ts`, `src/infrastructure/ffflow-github-workflow-queue.ts`).
Spec: [docs/specs/dispatch.md](../../../docs/specs/dispatch.md).

- `factory-dispatch` pulls ready FFFlow epics on a host into top-level Paseo
  agents and worktrees. It never merges, force-pushes, deletes branches, closes
  issues, deploys infrastructure or converges hosts.
- Its capacity check asks the active release's `fffactory host agents --json`
  (`FACTORY_FFFACTORY_BIN` in tests) and counts dispatched agents that are
  `working` or `needs_input`; it reads no Paseo status, and a failing or
  malformed answer fails the tick. It accepts exactly what the CLI's
  `parseActivityDocument` reads as listed agents, each agent's ID, state and
  boolean `dispatched` included, and keeps its copy of the agent states, ID rule
  and busy pair in step with `src/domain/control-plane.ts` until the port. Only
  the duplicate check and the launch call Paseo (`paseo-auth.sh`,
  `FACTORY_PASEO_BIN`).
- `dispatch-schedule.sh` reconciles the one factory-owned Paseo schedule from the
  versioned dispatch projection, as the unprivileged `factory` account; it
  refuses to run as root and uses every declared provider/model/mode/cwd input.
- `skill/SKILL.md` is the dispatch skill. The host endpoint installs it into the
  `factory` account's canonical `.agents/skills` directory and links Claude's
  discovery path to it. It is no longer a canonical repository skill:
  moving it here is why `scripts/repository-skills.sh` no longer lists
  `dispatch` in `expected_skills` and asserts the skill and program at these paths.
- These are not `INSTALL_STEPS`: `tests/assets/steps/steps.test.ts` lists only the
  top-level `assets/steps/*.sh`, so this subdirectory is excluded. `factory-dispatch`
  has no `.sh` suffix, so the step checks skip it too.
- `tests/test_factory_dispatch.py` and `tests/test_dispatch_schedule.py` are Python
  tests of the program and the reconciler, run in CI
  (`.github/workflows/repository-checks.yml`), never by `bun test`. Keep them green from
  here; they resolve the program and reconciler one directory up and the
  repository scripts in the sibling `repositories/`. `test_dispatch_schedule.py` also reads
  the checkout's `tests/host/fixtures/dispatch-not-requested.json`, the projection the CLI
  sends to stop dispatch, and `test_factory_dispatch.py` its `activity-agents.json`, what
  `host agents` prints, so both run only from a checkout.
- A program is ported to TypeScript only when it is changed for another reason
  (D3). Until then, change a program and its test together.
- Exception: #97 (the Paseo 0.13.2 flags) and #100 (the capacity check) changed
  `factory-dispatch` in place, because their plans scoped it that way; #100's, the
  worker-idleness plan's D7, keeps the duplicate check and the launch Paseo-specific inside
  the dispatcher. Its `TODO(re-evaluate when …)` names when the port is due.
