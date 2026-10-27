# Phase 1: Archive storage

**Status:** captured
**Roadmap:** docs/roadmap/worker-log-archive/roadmap.md

**Kind:** design-slice
**Scope:** An optional `log_archive.bucket` in factory.json (schema v1 kept; account-regional name carrying the factory ID, not the state bucket; changing it once set is refused). A state-less, create-only `archive/` Terraform root (account-regional namespace, versioning, public access block, BucketOwnerEnforced, SSE-S3, ABAC, Deny-only TLS bucket policy, prevent_destroy, no lifecycle), created by apply under the factory lock in the reviewed plan; guardrail classification and terraform-check coverage for the new root. The worker role's identity policy grants s3:PutObject on `archive/1/<factory-id>/workers/${aws:userid}/*` with the factory-id tag condition and a Deny without If-None-Match; no delete or read. Apply writes a factory identity record (factory, region, repository key -> remote) into the archive. Operator read permissions documented. Teardown keeps the archive and says so in its review, confirmation, report and kept-factory.json advice. Specs (instance-configuration, provisioning, plan-apply, teardown, secrets/privacy note per D8) and tests ship with the code.
**Out of scope:** Anything running on workers (Phase 2); the reader (Phase 3); Paseo projections (Phase 4).
**Success:** On the Acceptance factory, `fffactory apply` with `log_archive.bucket` set creates the archive in the reviewed plan; the worker role can create objects only under its own incarnation prefix and only with If-None-Match (unit-tested policy documents plus an apply-time check); `fffactory teardown` leaves the archive and its identity record readable and reports it as kept; an invalid or changed bucket field is refused by validate/plan.
**Depends on:** Phase 0. Not epic #94 (D10).
**Estimated tasks:** ~5

## Handoff
When ready to execute this phase:
  /plan-chat

The handoff skill will read this file as its starting point.

## Amended by /plan-chat log-archive-storage (2026-10-27)
See docs/roadmap/worker-log-archive/phases/phase-1/decisions.md.
- D3: `log_archive.enabled` with a derived bucket name replaces `log_archive.bucket`; no change refusal needed.
- D2: no apply-time permission check; terraform-check asserts the exact worker policy.
- D4: the factory identity record (repository key -> remote) moves from Phase 1 to Phase 4, which chooses between an apply-written record and worker-observed git remotes.

## Captured tasks
Epic: #109 · Plan: phases/phase-1/plan.md · Decisions: phases/phase-1/decisions.md

- #110 — T1 Config: `log_archive.enabled` and the derived archive name
- #111 — T2 The `archive/` Terraform root
- #112 — T3 Worker write permission on the archive
- #113 — T4 Plan and apply create the archive
- #114 — T5 Teardown reports the archive as kept
