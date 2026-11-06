# Decisions: worker-log-archive

D1. Several epics, not one. The design is ~20 tasks across three surfaces
    (worker collector and infrastructure, a bundled browser reader,
    relationship metadata), past plan-chat's 8-task ceiling.
    Rejected: one epic (would need a sub-roadmap anyway).

D2. The retention setting (`cleanupPeriodDays` in Claude's managed settings,
    which fffactory already writes) ships inside the collector epic, not as its
    own epic first. Accepted consequence: worker history older than 30 days at
    the time the collector ships is lost; backfill reports what it found.
    Rejected: a one-task stopgap epic shipped ahead of #94; skipping it.

D3. Reader before relationships. The reader first groups by worker and
    session; the relationships phase then adds repository, epic and attempt
    grouping to the collector and the reader. Accepted consequence: session
    rebinds that happen between the collector and relationships releases are
    not observed; relationships backfills from current Paseo records and
    slash-command markup, marked as inferred where it is.
    Rejected: relationships first (earlier association capture); merging the
    two (~11 tasks).

D4. Collection health is shown in the reader only; `fffactory status` is
    unchanged. Between the collector and reader releases, an operator sees
    apply's install outcome but not runtime staleness.
    Rejected: per-worker collection freshness in `fffactory status`.

D5. The collector epic waits for all of epic #94 (Paseo 0.13.2 pinned by #97;
    upgrade runs every apply stage by #96). Rejected: task-level dependencies
    on #96 and #97 only.

D6. A validation spike runs in-session before any epic's plan-chat, so every
    epic is planned on established facts. It is Phase 0: research output only,
    not captured as issues — an acknowledged exception to independent
    shippability. Rejected: validation inside each phase's plan-chat; a
    captured spike epic.

## After the Phase 0 spike (2026-10-27)

D2 (reaffirmed). The retention setting stays in the collector phase. The
spike found the worker's history starts 2026-10-14, so the 30-day default
deletes from about 2026-11-13; that loss is accepted. Rejected again: a
standalone issue merged before #94's release.

D7. The archive-and-collector phase splits into Storage (Phase 1) and
Collector (Phase 2). The spike put it at ~12 tasks. Reader becomes Phase 3,
Relationships Phase 4. Rejected: one phase recursed into a sub-roadmap.

D9. The live AWS behaviours (ABAC failing closed, ${aws:userid} in S3 object
ARNs, provider 6.66.0 ordering, If-None-Match enforcement) were checked before
planning, in a throwaway account holding no factory (fffv-operator profile,
user-authorized), and all resources were destroyed. Results are in
docs/research/worker-log-archive-collector.md. Rejected: proving them only in
the storage phase's acceptance.

D8. Secrets: raw, unmodified capture into an archive treated as sensitive
(private, TLS-only, operator read granted deliberately; specs state it may hold
anything an agent saw). No redaction. The spike found only test fixtures and
one AWS key ID (not a secret); pattern scanning cannot tell fixtures from live
credentials and misses unprefixed secrets. Rejected: reader-side masking (can
be added later); redaction at collection (non-reprocessable, mostly scrubs
fixtures).

D10. Storage (Phase 1) depends only on Phase 0 and may run in parallel with
epic #94; only the collector (Phase 2) waits for #94 (D5). Overlap with #102's
removal-record edits is handled at merge. Rejected: storage waiting for #94.
