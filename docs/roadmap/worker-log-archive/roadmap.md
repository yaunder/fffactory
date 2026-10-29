# Roadmap: worker-log-archive

Level: L1 · Stack: typescript · Capture: github-issues
Source: docs/designs/worker-log-archive.md (scope approved 2026-10-26), with
docs/research/worker-log-collection-spike.md as evidence.

## Vision

An operator can open a factory and see what its workers are doing and what
happened in earlier runs: recent conversations, subagents and tool activity,
grouped by repository, epic and attempt where known. Claude Code's own files on
v2 workers are harvested about once a minute into a dedicated, never-expiring
S3 archive that outlives workers and teardown, and read through a local
browser reader started by `fffactory logs`. Original evidence stays separate
from its index so later evals can reprocess it.

Out of scope for the whole roadmap: evals, derived cost dashboards, automated
triage, a hosted interface, worker controls in the reader, and v1 hosts.

## Survey

Brownfield. Touched surface:

- `assets/terraform/modules` (`state-bucket`, `host-identity`, `hosts`): a new
  archive bucket, worker write access, operator read access.
- `docs/specs/teardown.md`: teardown deletes everything it owns; the archive
  must survive it and stay discoverable afterwards.
- `docs/specs/instance-configuration.md`: archive settings, distinct from the
  state bucket field.
- `docs/specs/plan-apply.md`, `host-protocol.md`, `assets/steps`: a new
  collector installed through apply's stages, never gating dispatch.
- `docs/specs/credential-delivery.md`: Claude managed settings
  (`/etc/claude-code/managed-settings.json`) are written by fffactory today.
- `src/cli`: a new `fffactory logs` command and a bundled browser reader.

All touched modules are specified; no characterize phase is needed.

In flight: epic #94 (worker idleness) pins Paseo 0.13.2 (#97) and makes
upgrade run every apply stage (#96). The spike validated the Paseo join
against 0.11.4 and found dispatch labels absent on release 0.0.3.

## Phases

### Phase 0 — Validation spike
**Kind:** research (in-session; not captured as issues — D6)
**Scope:** Answered design validation items 1-6 and the open spike checks: worker discovery, retention, hot-file capture, publication, storage/teardown/IAM, collector runtime and install, secrets, reader bundling and load, Paseo 0.13.2 relationships; plus a live AWS check in a throwaway account (D9).
**Out of scope:** Creating factory resources, writing to the worker, copying private text into the repository.
**Success:** docs/research/worker-log-archive-collector.md, docs/research/worker-log-archive-reader.md and docs/research/worker-log-archive-relationships.md hold the findings, each marked established or unverified; Phases 1-4 are sized against them.
**Depends on:** none.
**Estimated tasks:** n/a (research)

### Phase 1 — Archive storage
**Kind:** design-slice
**Scope:** An optional `log_archive.bucket` in factory.json (schema v1 kept; account-regional name carrying the factory ID, not the state bucket; changing it once set is refused). A state-less, create-only `archive/` Terraform root (account-regional namespace, versioning, public access block, BucketOwnerEnforced, SSE-S3, ABAC, Deny-only TLS bucket policy, prevent_destroy, no lifecycle), created by apply under the factory lock in the reviewed plan; guardrail classification and terraform-check coverage for the new root. The worker role's identity policy grants s3:PutObject on `archive/1/<factory-id>/workers/${aws:userid}/*` with the factory-id tag condition and a Deny without If-None-Match; no delete or read. Apply writes a factory identity record (factory, region, repository key -> remote) into the archive. Operator read permissions documented. Teardown keeps the archive and says so in its review, confirmation, report and kept-factory.json advice. Specs (instance-configuration, provisioning, plan-apply, teardown, secrets/privacy note per D8) and tests ship with the code.
**Out of scope:** Anything running on workers (Phase 2); the reader (Phase 3); Paseo projections (Phase 4).
**Success:** On the Acceptance factory, `fffactory apply` with `log_archive.bucket` set creates the archive in the reviewed plan; the worker role can create objects only under its own incarnation prefix and only with If-None-Match (unit-tested policy documents plus an apply-time check); `fffactory teardown` leaves the archive and its identity record readable and reports it as kept; an invalid or changed bucket field is refused by validate/plan.
**Depends on:** Phase 0. Not epic #94 (D10).
**Estimated tasks:** ~5
**Amended at plan-chat (2026-10-27):** `log_archive.enabled` with a derived bucket name; no apply-time permission check; the identity record moves to Phase 4. See phases/phase-1.md and phases/phase-1/decisions.md.

### Phase 2 — Collector
**Kind:** design-slice
**Scope:** Claude managed settings raise cleanupPeriodDays (D2). `fffactory host collect --once` in the worker binary: allowlisted discovery (projects transcripts, subagent transcripts and sidecars, tool-results, referenced file-history, paste-cache/plans/tasks/todos when present; credential and state files never), append-delta capture with full-prefix hash and generations on rewrite, content-addressed blobs and per-cycle journal written with If-None-Match, incarnation.json and per-minute heartbeat, per-run byte/time budgets, checkpoint state under StateDirectory, its own lock (never the host apply lock). A `fffactory-collector.timer` and sandboxed oneshot unit with no tie to paseo.service, installed by a final `host apply` step that only enables the timer; archive settings excluded from the control-plane projection. Removal (terminate, teardown) reports each worker's unarchived evidence, or 'last archived at T' from S3 when it cannot be inspected. Raw capture, archive treated as sensitive (D8).
**Out of scope:** The reader (Phase 3); Paseo relationship projection (Phase 4); collection health in fffactory status (D4).
**Success:** On the Acceptance factory after #94's release, apply installs the collector; existing and new session artifacts reach the archive within about a minute while an agent works; a rewritten transcript keeps its earlier generation; an S3 or IAM failure shows in the heartbeat and never blocks dispatch or restarts Paseo; terminate and teardown report unarchived evidence; the binary's per-run RSS and time are measured and bounded; host-protocol, plan-apply, credential-delivery, worker-lifecycle, teardown and a new collector spec ship with tests against stub S3 and a loopback IMDS.
**Depends on:** Phase 1; all of epic #94 (D5).
**Estimated tasks:** ~7

### Phase 3 — fffactory logs reader
**Kind:** design-slice
**Scope:** `fffactory logs --instance PATH --profile NAME`: reads `log_archive.bucket` from factory.json (works after teardown, no state bucket or Terraform), account check, ExpectedBucketOwner; loopback server on 127.0.0.1 with Host/Origin/Sec-Fetch checks and a per-run token exchanged for a cookie; prebuilt plain TS+DOM UI embedded as file imports, rendered as text under a CSP. Builds its index from journal records (StartAfter), cached per factory. Shows workers with heartbeat freshness and failures; sessions by worker and conversation; windowed conversation rendering, lazy tool output over ~8 KiB and saved outputs; subagent navigation; unassociated sessions; raw archived files; refresh of ongoing runs.
**Out of scope:** Repository/epic/attempt grouping (Phase 4); worker controls; cost dashboards; masking (D8).
**Success:** From a released binary, an operator opens the Acceptance factory's archive, sees each worker's collection freshness, follows a live run as it refreshes, navigates nested subagents and a large tool output, and reads a session whose worker is gone; a wrong account and a non-loopback or tokenless request are refused; specs and tests cover the command, access rules and rendering safety.
**Depends on:** Phase 2.
**Estimated tasks:** ~7

### Phase 4 — Relationships
**Kind:** design-slice
**Scope:** The collector writes bounded Paseo projections (agent id, labels, cwd, workspace, persistence.sessionId, timestamps, status) as observations only when they change; backfill of associations from current Paseo records and slash-command epic references, marked inferred; repository identity from the archive's key -> remote records. The reader groups ongoing and historical attempts by repository and epic, one attempt per dispatched agent, distinguishing observed from inferred and keeping unassociated sessions. Validate factory dispatch labels on the first worker whose dispatch launches agents.
**Out of scope:** A complete rebind history Paseo does not record; new dispatch identifiers.
**Success:** A dispatched epic appears in the reader under its repository and epic with each dispatch as a separate attempt and its conversations and subagents beneath; hand-started epic runs appear as inferred; sessions with no epic stay visible as unassociated; specs and tests ship with the code.
**Depends on:** Phases 2 and 3 (D3).
**Estimated tasks:** ~4

## Order

Phase 0 (done) -> Phase 1 (parallel with epic #94) -> Phase 2 (after #94) -> Phase 3 -> Phase 4.
