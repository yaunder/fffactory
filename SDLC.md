# Software development lifecycle

The factory is only useful when its machines run a defined workflow. This
document defines that workflow: which stages exist, which
[FFFlow](https://github.com/bryonjacob/ffflow) skill implements each stage,
where each stage runs, and what gates the transition to the next one. It is the
design record for making FFFlow the execution model of the factory. The
factory side of it ships in `fffactory` releases; remaining work is in
[`docs/roadmap/`](docs/roadmap/).

## Ownership split

Three systems share the lifecycle. Each owns one concern and none duplicates
another's state.

| Concern | Owner | What it owns | What it never does |
| --- | --- | --- | --- |
| Machines | this repository (`fffactory` and its releases) | hosts, runtimes, pinned plugins, repository inventory, verification | define task workflow or hold task state |
| Dispatch | Paseo | agents, sessions, worktrees, permissions, timelines, schedules | decide what a task must do to be done |
| Workflow | FFFlow | planning, capture, the work loop, review discipline, audit | provision hosts or start agents |

The factory previously closed its own repository-contract, task-loop, and
task-state issues (#4, #6, #13) as owned by "Paseo and the workflow skills."
FFFlow is the workflow skill set those decisions assumed. The repository
contract is `.ffflow/config.yaml`, the stamped beliefs block in each
repository's `CLAUDE.md`, and its justfile. The task loop is `work-issue` for
one task and `work-epic` for one epic; both run the same discipline of spec,
red, green, spec update, gates, and pull request. Task state is the issue
tracker plus the pull request.

## Stages

| Stage | FFFlow skill | Runs on | Actor | Durable artifact | Gate to next stage |
| --- | --- | --- | --- | --- | --- |
| Roadmap | `plan-roadmap` | laptop | human with agent | `docs/roadmap/<slug>/` in the product repository | zero open decision markers |
| Plan | `plan-chat`, `characterize`, or `audit --plan` | laptop | human with agent | transient plan directory | zero open decision markers |
| Breakdown | `plan-breakdown` | laptop | human with agent | task files in the plan directory | every task has scope, dependencies, acceptance criteria |
| Capture | `plan-capture` | laptop | agent | epic and task issues in GitHub | issues exist with dependency comments |
| Ready | none; a human decision | GitHub | human | `ready` label on the epic issue | see [Readiness](#readiness) |
| Work | `work-epic` (later `work-issue`) | factory host | Paseo agent | branch, commits, pull request | level-appropriate gates pass, PR opened |
| Review and merge | none; GitHub review | GitHub | human | merged pull request | human approval |
| Audit | `audit` | laptop or host | agent | audit findings, optionally a plan | above-threshold findings become plans |

Two rules follow from the table and are factory invariants:

- **Hosts consume captured issues only.** Planning is a laptop activity for
  now. A plan is durable only once captured, so a host never depends on plan
  state that lives in a laptop's temporary directory. Planning on hosts is on
  the deferred list.
- **Nothing in the factory merges.** FFFlow's work skills stop at the pull
  request. The dispatcher stops at the pull request. Merge is a human action
  in GitHub.

## Readiness

FFFlow's capture stage deliberately performs no status transitions. The factory
therefore needs its own signal for "identified as ready for development." The
convention is:

1. A human applies the `ready` label to an epic issue. This is the decision
   point and it happens after planning, on a laptop. Labeling individual task
   issues is not part of the first cut; see [Execution units](#execution-units).
2. The dispatcher only acts on a `ready` epic when every task issue under it
   is open with no open pull request, no `epic/<id>` branch already exists, and
   every dependency of the epic's tasks that lives outside the epic is closed.
   These checks are computed at dispatch time and stop the factory from
   double-running work.

Removing the label withdraws the item from the queue. The label is the only
state the factory adds to the tracker.

## Execution units

`work-epic` is the first dispatch unit: one epic, one branch, one squashed
commit per task, one pull request. It is already how work is started
interactively today, and it runs correctly inside a Paseo worktree because it
never creates a worktree of its own. Dispatching at the epic granularity also
matches how planning produces work: `plan-capture` writes one epic per plan
or phase, so `ready` on the epic is one label per unit of planned work.

`work-issue` as a dispatch unit is deferred. One pull request per task changes
how readiness, dependencies between tasks, and per-task review compose, and
that logic should be agreed with the upstream maintainer before the factory
encodes it. It runs correctly inside a Paseo worktree today and remains
available interactively.

Stacked epics, where epic two branches off epic one's branch while that pull
request awaits merge, are deferred. `work-epic` hard-codes `origin/main` as its
base today. The change is an upstream contribution, not a fork; see
[Relationship to upstream](#relationship-to-upstream-ffflow).

## Worktree ownership

Two worktree conventions exist: Paseo creates worktrees under
`~/.paseo/worktrees`, and FFFlow's `work-fanout` creates `worktrees/<task-id>/`
inside the project root.

On factory hosts, **Paseo owns worktrees.** Every unit of work runs as a
top-level Paseo agent in a Paseo-created worktree branched off fresh `main`.
FFFlow skills run inside that worktree and never create nested worktrees.
Consequences:

- `work-fanout` is not used on hosts until it gains an executor that spawns
  Paseo agents instead of in-session subagents. Parallelism comes from the
  dispatcher starting several agents, not from one agent forking itself.
- Each unit of work has its own Paseo timeline, permission queue, activity
  signal, and kill switch. A stalled unit is visible from any enrolled client.

## Dispatcher

The dispatcher is the piece that makes the factory pull work rather than wait
for a human to type a command. It is deliberately small:

- A Paseo schedule on each host starts a fresh agent on a fixed cadence.
- That agent runs a factory-owned dispatch skill. The skill lists `ready`
  issues across the repositories placed on that host, applies the readiness
  checks, counts the factory agents already running on the host, and starts
  at most `cap - running` new agents.
- Each new agent is created in a Paseo worktree off the repository's declared
  branch with an initial prompt of `/fff:work-epic <id>`. Dispatching
  `/fff:work-issue <n>` is added once the task-level logic is agreed upstream.
- The dispatcher never merges, never force-pushes, and never deletes
  worktrees. Cleanup after merge is a separate reviewed policy, matching the
  repository synchronization precedent.

The cap is one unit of work per host. The dispatcher depends on Paseo's
schedules and worktree isolation and on the FFFlow plugin, both pinned in the
release (`assets/steps/control-plane/versions.env`,
`assets/steps/plugins.json`). The PR-checkpoint protocol inside
`work-issue` is session-local and `work-epic` opens exactly one pull request,
so an agent started by the dispatcher never hits the checkpoint. `work-epic`
does stop and ask on unexpected state such as an existing branch or a task
without acceptance criteria; the readiness checks above are designed to make
those stops rare, and when one happens it surfaces as a Paseo permission or
question that any enrolled client can answer.

The factory repository is outside the managed work inventory (#59). The
dispatch skill and program therefore ship in the release
(`assets/steps/dispatch/`), and apply's dispatch stage installs them into the
`factory` user's environment once every readiness gate passes
([docs/specs/dispatch.md](docs/specs/dispatch.md)). The schedule is declared
per host in factory.json's `hosts[].dispatch`, with its working directory,
and is off unless `enabled` is true. The program rechecks FFFlow adoption with
the release's checker before considering each repository.

## Fleet conformance

A repository enters factory.json's `repositories` and a host's placement only
after it adopts FFFlow on its declared branch. Apply's repository stage checks
the repository's own `.ffflow/config.yaml` before reporting a checkout ready
or publishing a clone, and leaves an unadopted one untouched; CI validates
only code. The factory does not duplicate the repository's level in its
inventory. Dispatch checks adoption again, as the `ffflow_adoption` gate and
before each run, so a repository whose config has been removed cannot receive
new work ([docs/specs/repositories.md](docs/specs/repositories.md)).

Each operator's factory.json owns its inventory; this repository holds none.

## Recorded decisions

- **Planning happens on laptops.** Hosts consume captured issues. Planning on
  hosts is deferred.
- **Claude Code is the first executor.** FFFlow is a Claude Code plugin. Codex
  remains pinned in the release but has no FFFlow path until upstream adds one.
  Codex compatibility is deferred.
- **Control-plane orchestration.** Parallelism is one Paseo agent per unit of
  work, started by the dispatcher, rather than in-session fan-out.
- **`ready` label on epics as the human gate**, with computed branch,
  open-PR, and dependency checks at dispatch time. Epics are dispatched with
  `work-epic` first. Task-level dispatch with `work-issue` waits on a
  conversation with the upstream maintainer about how that logic should work.
- **Factory instances are separate from factory code.** A factory instance is
  one user-owned `.fffactory/factory.json`, selected with `--instance PATH`,
  `FFFACTORY_INSTANCE`, the nearest `.fffactory/factory.json` or
  `~/.fffactory/factory.json`. It pins the one `fffactory` release that may
  plan or change the factory; reviewed releases are the factory code, and
  commands refuse to act without a valid instance. CI exercises only the code
  in this repository and reads no AWS account or factory state.
  [Decision 0002](docs/decisions/0002-fffactory-v2.md) records this; it
  supersedes [decision 0001](docs/decisions/0001-factory-instance-configuration.md)'s
  four-file instance (#64).
- **The factory repository adopts FFFlow at L1** (`.ffflow/config.yaml`) for
  its v2 development. It stays outside the managed repository inventory; the
  dispatch skill ships in the release rather than coming from a managed
  primary checkout.
- **Consume upstream, contribute upstream.** The plugin is pinned to an
  upstream commit. Factory needs are proposed to the upstream maintainer as
  pull requests. There is no Yaunder fork.
- **The compound engineering loop (#21) is deferred** until a consolidated
  end-to-end flow exists. It then feeds `audit --plan` with session-derived
  findings.

## Relationship to upstream FFFlow

Two changes are needed upstream for the full model. Both are proposed as pull
requests to the upstream repository and tracked here so the factory remembers
what it needs and why:

1. **Executor cartridge for `work-fanout`**
   ([#65](https://github.com/yaunder/factory/issues/65)). The default keeps
   today's in-session subagent behavior. A `paseo` executor starts each task
   as a top-level Paseo agent in its own worktree. The final report format is
   unchanged.
2. **`--base <branch>` for `work-epic`**
   ([#66](https://github.com/yaunder/factory/issues/66)). Allows an epic to
   branch off another epic's branch, enabling stacked pull requests, with a
   documented rebase step after the base merges.

Both are additive to the first cut, which dispatches epics off `main` with
`work-epic` as it exists today. A third topic, how task-level dispatch with
`work-issue` should treat readiness and inter-task dependencies, is a
conversation to have upstream before the factory encodes any of it.

## Deferred

The SDLC milestone that delivered the first cut
([#58](https://github.com/yaunder/factory/issues/58)) is closed history;
remaining factory work is planned in [`docs/roadmap/`](docs/roadmap/). The
upstream contributions in
[Relationship to upstream FFFlow](#relationship-to-upstream-ffflow) unlock
these deferred items, in the order they are likely to be pulled in:

- task-level dispatch with `work-issue`, after the upstream conversation;
- planning on development hosts;
- Codex as an FFFlow executor;
- the compound engineering loop (#21) as an audit input;
- worktree cleanup policy after merge.
