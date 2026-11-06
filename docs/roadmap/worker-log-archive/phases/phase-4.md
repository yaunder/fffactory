# Phase 4: Relationships

**Status:** not-started
**Roadmap:** docs/roadmap/worker-log-archive/roadmap.md

**Kind:** design-slice
**Scope:** The collector writes bounded Paseo projections (agent id, labels, cwd, workspace, persistence.sessionId, timestamps, status) as observations only when they change; backfill of associations from current Paseo records and slash-command epic references, marked inferred; repository identity from the archive's key -> remote records. The reader groups ongoing and historical attempts by repository and epic, one attempt per dispatched agent, distinguishing observed from inferred and keeping unassociated sessions. Validate factory dispatch labels on the first worker whose dispatch launches agents.
**Out of scope:** A complete rebind history Paseo does not record; new dispatch identifiers.
**Success:** A dispatched epic appears in the reader under its repository and epic with each dispatch as a separate attempt and its conversations and subagents beneath; hand-started epic runs appear as inferred; sessions with no epic stay visible as unassociated; specs and tests ship with the code.
**Depends on:** Phases 2 and 3 (D3).
**Estimated tasks:** ~4

## Handoff
When ready to execute this phase:
  /plan-chat

The handoff skill will read this file as its starting point.

## Amended by /plan-chat log-archive-storage (2026-10-27)
See docs/roadmap/worker-log-archive/phases/phase-1/decisions.md.
- D3: `log_archive.enabled` with a derived bucket name replaces `log_archive.bucket`; no change refusal needed.
- D2: no apply-time permission check; terraform-check asserts the exact worker policy.
- D4: the factory identity record (repository key -> remote) moves from Phase 1 to Phase 4, which chooses between an apply-written record and worker-observed git remotes.
