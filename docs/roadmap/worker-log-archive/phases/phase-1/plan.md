# Plan: log-archive-storage

Level: L1 · Stack: typescript · Capture: github-issues
Roadmap: docs/roadmap/worker-log-archive/roadmap.md (Phase 1 — Archive storage)
Design: docs/designs/worker-log-archive.md · Evidence: docs/research/worker-log-archive-collector.md §3, Live AWS check

## Phase 1 — Understanding (confirmed 2026-10-27)

**Guiding constraint (user):** as thin as possible. Do not re-verify AWS's
permission semantics in our own code.

**Problem.** Phase 2's collector needs a durable place to write, and Phase 3's
reader needs to find it after workers, and even the factory, are gone. Today
the only bucket is the state bucket: teardown deletes it, it holds Terraform
state and the lock, and workers can write nothing (the host role grants only
`secretsmanager:GetSecretValue`).

**Outcome.** An operator opts a factory in by setting `log_archive.bucket` in
factory.json. The reviewed `fffactory apply` plan creates a private, hardened,
never-expiring archive bucket under the factory lock. The worker role can only
*create new* objects under its own incarnation prefix. Apply records the
factory's identity (factory, region, repository key -> remote) in the archive.
Teardown keeps the bucket, says so everywhere it speaks, and factory.json stays
the pointer to it. Re-applying a torn-down factory adopts the kept bucket.

**Who benefits.** Operators, once Phases 2-3 ship; directly, the collector
phase, which can then be planned against a real destination.

**In scope.** Config field + validation; a state-less, create-only `archive/`
Terraform root with guardrail and terraform-check coverage; the worker role's
PutObject grant; the identity record; teardown keeping and reporting the
archive; documented operator read permissions; specs (instance-configuration,
provisioning, plan-apply, teardown, secrets/privacy per D8) and tests.

**Out of scope.** Anything on workers (Phase 2), the reader (Phase 3), Paseo
projections (Phase 4); changing retention or bucket settings after creation and
moving an archive to another bucket (refused, marked TODO); KMS, Object Lock;
`init` proposing an archive (D1); a live apply-time permission probe (D2); v1.

**Constraints.**
- AGENTS.md invariants: account check before plan, exact-plan approval, one
  factory lock, no raw secrets; CI uses stubs and reads no AWS.
- Terraform guardrails: factory-ID naming, `NAMED_RESOURCES` allowlist, tag
  condition on every mutating Allow (works only with bucket ABAC on), no
  `removed`/`check` blocks. Widening an allowlist is a guardrail change.
- Schema version 1 kept (optional field). Account-regional namespace (`-an`)
  is unavailable in me-south-1 and me-central-1.
- Runs in parallel with epic #94 (D10); teardown/removal-record edits overlap
  #102 and are reconciled at merge.

**Code facts that shape the work** (survey 2026-10-27):
- A saved plan binds exactly one tfplan (`PlanFiles {factory, backend}`,
  `plan-store.ts:6`; digests and `sameChanges` in `apply-factory.ts:375-421`).
  A second root in the reviewed plan is the largest hidden cost.
- No "refuse a change once set" mechanism exists except host keys, recorded as
  a factory-root output (`plan-factory.ts:226`). A state-less root cannot
  remember the bucket.
- No apply-time AWS behaviour probe exists (`verify-factory.ts` is pure). The
  instance role is only usable from a worker.
- `checkStateBucket` enforces only the factory-ID prefix; the `-an` suffix and
  "not the state bucket" rules are new.
- `CreateBucket` on a bucket you already own returns 200 in us-east-1, so
  re-apply needs HeadBucket readiness, as backend bootstrap already does
  (`bootstrap-backend.ts:114`).
- Teardown today says "nothing it owns remains" and that apply "would create a
  new one" (`domain/teardown.ts:933`, `cli/presentation/teardown.ts:375`).
- Only the S3 lock store writes objects today; its port is state-bucket
  specific (`lock-store.ts:9`).

## Phase 2 — Architecture / Approach (confirmed 2026-10-27)

Opt-in config produces one extra create-only Terraform root in the reviewed
plan, and one conditional policy on the host role. Teardown changes only its
words. fffactory writes no S3 objects in this phase (D4).

**Domain** (`src/domain`)
- `instance.ts`: optional `log_archive.enabled` (D3), schema v1 kept;
  mirrored in `schemas/factory.schema.json`; refused when the region lacks the
  account-regional namespace (me-south-1, me-central-1).
- `resource-naming.ts`: the derived archive bucket name `<factory-id>-logs-<account>-<region>-an` (D3).
- `plan.ts`: a saved factory plan records whether it creates the archive; a
  staleness reason when that fact changes (mirrors `state_bucket_created`); the
  review shows an "Archive" line (created / present) (D5).
- `teardown.ts`: question, review, report and FACTORY_JSON_KEPT advice say the
  log archive is kept; "nothing it owns remains" is reworded.

**Application** (`src/application`)
- `plan-factory.ts`: when enabled, check the archive bucket's readiness; missing
  -> plan the `archive/` root create-only into `archive.tfplan` (create-only
  verdict as bootstrap's); present and ready -> nothing to plan; half-made ->
  refuse, as an unready state bucket is refused.
- `apply-factory.ts`: inside the infrastructure stage, after approval, apply
  `archive.tfplan` (bound by digest like `factory.tfplan`) and then the factory
  root. No new stage. Upgrade inherits it because it runs the same stage.
- `project-terraform-inputs.ts`: the archive name to both roots.

**Infrastructure**
- `assets/terraform/archive/` root (state-less, like `backend/`) + a module:
  account-regional namespace, versioning, public access block,
  BucketOwnerEnforced, SSE-S3, ABAC on, TLS-only Deny bucket policy (D6),
  `prevent_destroy`, no lifecycle, factory-id tag.
- `modules/host-identity`: a conditional `aws_iam_role_policy`
  `-write-archive`: Allow `s3:PutObject` on
  `archive/1/<factory-id>/workers/$${aws:userid}/*` with the factory-id tag
  condition; Deny PutObject without `s3:if-none-match`. No read, no delete.
- Bucket readiness: reuse the S3 adapter's HeadBucket/readiness by
  generalising it from `StateBucket` to a bucket name (D7).
- Guardrails: new S3 resource types in `NAMED_RESOURCES`; `archive` added to
  `ROOT_MODULES` and the guardrail test's root lists; a terraform-check case
  asserting the exact planned worker archive policy (D2).

**Specs**: instance-configuration (field), provisioning (archive root; amend
"hosts can mutate nothing"; operator read permissions as a documented IAM
statement), plan-apply (review line, `archive.tfplan`, staleness), teardown
(kept), secrets (D8: archive may hold anything an agent saw).

## Phase 3 — Path (confirmed 2026-10-27)

Rough cut; /plan-breakdown decides the real tasks. Each step ships its spec
edits and tests.

1. **Config.** `log_archive.enabled` in `instance.ts` and the JSON schema;
   region refusal (me-south-1, me-central-1); derived name in
   `resource-naming.ts`; examples/factory.json; instance-configuration spec.
   No behaviour yet. Depends on: nothing.
2. **Archive root.** `assets/terraform/archive/` + module; new S3 resource
   types in `NAMED_RESOURCES`; `archive` in `ROOT_MODULES` and the guardrail
   test's root lists; terraform-check plans it; provisioning spec.
   Depends on: 1 (name).
3. **Worker grant.** Conditional `-write-archive` policy in host-identity;
   name projected to the factory root; terraform-check asserts the exact
   statements (D2); amend "hosts can mutate nothing"; operator read IAM
   statement documented. Depends on: 1. Parallel with 2.
4. **Plan and apply.** Generalised bucket readiness (D7); plan the archive
   root create-only into `archive.tfplan`; saved-plan binding, digest,
   staleness and review line; apply it first in the infrastructure stage
   (D5); plan-apply spec. Depends on: 2. The phase's demo lands here.
5. **Teardown wording.** Kept-archive text in question, review, report and
   advice (D8); teardown spec; secrets spec privacy note (D8 of the roadmap).
   Depends on: 1. Parallel with 2-4; overlaps #102 at merge.

Order: 1 -> (2, 3, 5 in parallel) -> 4. About 5 tasks.

**Success (revised from the roadmap):** on the Acceptance factory, `fffactory
apply` with `log_archive.enabled` creates the archive in the reviewed plan and
a rerun plans nothing for it; terraform-check asserts the worker policy allows
only own-prefix PutObject with If-None-Match and nothing else; `fffactory
teardown` reports the archive as kept and it remains; re-applying the torn-down
factory adopts it; an unsupported region is refused by validate/plan.
