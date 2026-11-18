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

### A. Agent work (#153)

| Layer | Module | Change |
| --- | --- | --- |
| Host adapter | `src/host/control-plane.ts` (`paseoAgents`) | Read the `factory-repository`, `factory-epic` and `factory-dispatched-at` labels from `paseo ls --json`. Label names stay in the adapter (#93). |
| Domain | `src/domain/control-plane.ts` (`Agent`, `readAgent`, `agentActivity`) | `repository`, `epic` and `dispatched_at`, each validated or null. An older worker's document without them reads as null. |
| Spec/schema | `host-protocol.md`, `control-plane.md`, `status.md`, `worker-lifecycle.md`, `status-report.schema.json`, `worker-inspection.schema.json`, status fixture | Three nullable fields on each agent. |
| CLI presentation | `src/cli/presentation/agents.ts` | Human report names the agents (layout: decision below). |

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

## Phase 3 — Path

Confirmed 2026-11-18.

Housekeeping, at capture: link docs/roadmap/status-snapshot/prototype.html
and link it from #154. Close #151 and #152 as not planned, each with a comment pointing at #154 and this plan.

1. **#153: agent work.** Adapter reads the labels. The domain validates them (null if invalid or missing). Host
   protocol, control-plane, status and worker-lifecycle specs, both schemas, the fixture and the human `Agents:`
   lines all change. One PR.
2. **New issue: `observed_at`.** Report field, header line, schema, fixture, spec. One PR. It doesn't depend on
   #153, but it edits the same schema, fixture and status spec, so run the two one after the other rather than
   in parallel.
3. **#154: HTML page.** `status-page.ts` from the fixture report (rendered from fixtures, with tests for
   escaping, no script and no network). `--html` flag and its exclusion with `--json`. Status spec §Output gains HTML.
   Depends on 1 and 2. One PR.

Commit boundaries are the three PRs. Specs ship in each PR with their code.
