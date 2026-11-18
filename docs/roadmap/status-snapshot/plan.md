# Plan: status-snapshot

- Level: L1
- Stack: typescript
- Capture: github-issues

## Phase 1 — Understanding

Confirmed 2026-11-18.

**Problem.** An operator can't see the whole factory at a glance. `fffactory status` reports each
worker's agents as counts by state ("builder-2: 1 working, 2 finished") and doesn't say what they're
working on. The report has no snapshot time, and nothing renders it except the terminal. #151
proposed a Paseo plugin with an operator-local registry of factories to fill the gap. That means a
second registry, Paseo plugin packaging, and daemon-side directory browsing, all of it for a
read-only view.

**Direction.** Retire #151. Make `fffactory status --json` the complete, versioned snapshot contract,
so any UI is a pure rendering of one report: first the self-contained HTML page (#154), and later
anything else.

**Gaps in the report today:**
1. What each agent is working on (repository, epic, dispatch time): #153.
2. When the snapshot was taken: the report has no timestamp.
3. A rendering: #154.

**Out of scope:** live refresh or a served page, any control actions, a multi-factory registry,
queued-but-undispatched work, transcripts and history (#117).

## Phase 2 — Approach

Confirmed 2026-11-18.

`status --json` becomes the snapshot contract: one factory and one moment, everything a renderer
needs. Every rendering (terminal, HTML, a future external UI) is a pure function of that report. The
work is three additive changes to the report and one new rendering. Status schema version 2 and host
protocol version 1 stay.

### A. Agent work (#153, plus a launch record)

Amended at breakdown: Paseo's CLI prints no labels (0.15.0 pinned, 0.16.2 latest), so the launch identity comes
from a launch record the dispatcher writes. See decisions.md §Amended at breakdown.

| Layer | Module | Change |
| --- | --- | --- |
| Domain | new `src/domain/launch-record.ts` | The record document, its parser (every field checked, the whole record refused when malformed), the prune rule (absent from the listed runs AND dispatched more than 1 h before now), adding an entry, and the join onto runs by agent ID. Pure. |
| Host | `src/host/dispatcher.ts` | Under `DISPATCH_LOCK`, prunes from the list of every run it already reads, appends an entry for each successful `startRun`, writes `~factory/.local/state/fffactory/launches.json` by temporary file and rename. A failed write is reported in the summary and never fails the tick. |
| Host | `src/host/control-plane.ts` (`activity`) | As root, reads the record through a guarded descriptor (no symlinks, a regular file, a bounded size) and joins it to the runs. Read-only. |
| Domain | `src/domain/control-plane.ts` (`Agent`, `readAgent`, `agentActivity`) | `repository`, `epic` and `dispatched_at`, each null when unknown. A worker on an older release reads as null. |
| Spec/schema | `dispatch.md`, `execution-backend.md`, `host-protocol.md`, `control-plane.md`, `status.md`, `worker-lifecycle.md`, `status-report.schema.json`, `worker-inspection.schema.json`, fixtures | The record, three nullable fields on each agent. |
| CLI presentation | `src/cli/presentation/agents.ts` | Human report names working, needs-input and failed agents. |

### B. Snapshot time

| Layer | Module | Change |
| --- | --- | --- |
| Application | `src/application/status.ts` (`factoryStatus`) | Stamps the report from the injected `now` (`src/cli/context.ts:77`). No new port. |
| Domain | `src/domain/status.ts` (report) | `observed_at` on the report. |
| CLI | `src/cli/commands/status.ts` | JSON: top-level `observed_at`. Human: shown on the header line. |

`observed_at` is taken when status begins reading the inventories (Order step 4).
| Spec/schema | `status.md`, `status-report.schema.json`, fixture | Additive field. |

### C. HTML rendering (#154)

| Layer | Module | Change |
| --- | --- | --- |
| CLI presentation | new `src/cli/presentation/status-page.ts` | Pure `report → string`: escapes every value, inlines the CSS, no scripts or network requests, system fonts. Times are relative to `observed_at`, never to when the page is viewed. |
| CLI | `src/cli/commands/status.ts` | `--html` writes the page to stdout. Exit code is status's own. |
| Spec | `status.md` §Output | New HTML subsection. |

`--html` and `--json` exclude each other (both together: exit 1). Agents listed: working, then needs input, then
failed. Finished and stopped are counts. The human report uses the same rule. No links yet (TODO marker).

**Prototype:** [`prototype.html`](prototype.html), the user's Factory Floor artifact. Keep: layout (title + as-of
stamp, tally row, one "Needs you" panel for the whole factory, a grid of worker stations with a well header,
facts line and agent rows), yaunder.com tokens plus `--fault`, light only, state dots, dashed stations for not
ready and stopped workers. Change for production:
- No `<script>`: the CLI renders static HTML. Drop the Proposed/Today toggle and the dashed "new field"
  underline, which only exist for the prototype.
- No Google Fonts request. Use the fallback faces in the stack (Helvetica Neue, Arial; ui-monospace).
- Finished agents become a count per station instead of rows. Rows sort working → needs input → failed.
- `as_of` is `observed_at`.

### D. Every agent's repository (amended at breakdown)

| Layer | Module | Change |
| --- | --- | --- |
| Host adapter | `src/host/paseo-backend.ts` (`paseoRuns`) | Reads each agent's `cwd` from the `ls --json` it already reads. Lists each placed checkout's worktrees (`worktree ls --cwd CHECKOUT --json`). Attributes each run to a placed checkout or none. A failed worktree listing makes only that checkout's attribution unknown. |
| Domain | `src/domain/run.ts` | `Run` gains the placed checkout it works in, or null. |
| Host | `src/host/control-plane.ts` (`activity`) | Passes the manifest's placed checkouts. Maps a run's checkout to its repository key. The record's repository wins for dispatched agents. |
| Spec | `execution-backend.md` §Inspect, `host-protocol.md`, `status.md` | Repository known for ad hoc agents. |

### E. The report's repositories

| Layer | Module | Change |
| --- | --- | --- |
| Domain | `src/domain/status.ts` | The report's repositories: each declared repository, its placements with each worker's verdict and repository state. Pure, from factory.json and the workers' results. |
| CLI | `src/cli/commands/status.ts` (`statusJson`) | Top-level `repositories`: `key`, `name`, `placements`. |
| Spec/schema | `status.md` §JSON, `status-report.schema.json`, fixture | Additive. |

Display (all surfaces): two categories, **Dispatched** (`OWNER/NAME#EPIC`) and **Ad hoc** (`OWNER/NAME`, or its ID
outside the placed repositories). Within each: working, then needs input, then failed; finished and stopped are
counts. The HTML page stacks Needs you, Workers, Repositories. The terminal stays worker-centric.

## Phase 3 — Path

Confirmed 2026-11-18. Amended at breakdown to six tasks.

Housekeeping, at capture:
- Link docs/roadmap/status-snapshot/prototype.html from #154.
- Close #151 and #152 as not planned, each with a comment pointing at #154 and this plan.
- Open a follow-up design-spike issue for the page layout, including the repository view.

1. **New issue: the dispatcher records each launch.** No reader.
2. **#153, rescoped: status names each dispatched agent's work.** Reads the record. `OWNER/NAME#EPIC` from
   factory.json. The widened never-print rule. Two categories. Depends on 1.
3. **New issue: `observed_at`.**
4. **New issue: every agent's repository from its workspace.** Ad hoc agents get their repository. Depends on 2.
5. **New issue: the report's repositories.** Top-level `repositories` in `status --json`. Depends on 2.
6. **#154: `status --html`**, with Workers and Repositories views. Depends on 2, 3, 4, 5.

Tasks 2, 3, 4 and 5 share the status schema, fixture and spec: run them one after the other. Specs ship in each PR
with their code.
