# Phase 2: Collector

**Status:** not-started
**Roadmap:** docs/roadmap/worker-log-archive/roadmap.md

**Kind:** design-slice
**Scope:** Claude managed settings raise cleanupPeriodDays (D2). `fffactory host collect --once` in the worker binary: allowlisted discovery (projects transcripts, subagent transcripts and sidecars, tool-results, referenced file-history, paste-cache/plans/tasks/todos when present; credential and state files never), append-delta capture with full-prefix hash and generations on rewrite, content-addressed blobs and per-cycle journal written with If-None-Match, incarnation.json and per-minute heartbeat, per-run byte/time budgets, checkpoint state under StateDirectory, its own lock (never the host apply lock). A `fffactory-collector.timer` and sandboxed oneshot unit with no tie to paseo.service, installed by a final `host apply` step that only enables the timer; archive settings excluded from the control-plane projection. Removal (terminate, teardown) reports each worker's unarchived evidence, or 'last archived at T' from S3 when it cannot be inspected. Raw capture, archive treated as sensitive (D8).
**Out of scope:** The reader (Phase 3); Paseo relationship projection (Phase 4); collection health in fffactory status (D4).
**Success:** On the Acceptance factory after #94's release, apply installs the collector; existing and new session artifacts reach the archive within about a minute while an agent works; a rewritten transcript keeps its earlier generation; an S3 or IAM failure shows in the heartbeat and never blocks dispatch or restarts Paseo; terminate and teardown report unarchived evidence; the binary's per-run RSS and time are measured and bounded; host-protocol, plan-apply, credential-delivery, worker-lifecycle, teardown and a new collector spec ship with tests against stub S3 and a loopback IMDS.
**Depends on:** Phase 1; all of epic #94 (D5).
**Estimated tasks:** ~7

## Handoff
When ready to execute this phase:
  /plan-chat

The handoff skill will read this file as its starting point.
