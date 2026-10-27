# Decisions: log-archive-storage

Inherited from the roadmap (not reopened here): D8 raw capture, archive treated
as sensitive, no redaction; D9 live AWS behaviours already checked; D10 storage
runs in parallel with epic #94.

✓ D1. `fffactory init` does not propose a log archive
   Chose: the operator sets it by hand; examples/factory.json shows it. Absent
   means no archive. Marked TODO(re-evaluate when the collector ships).
   Rationale: opt-in, keeps the phase thin. User: "fine for now".
   Revisited after D3 (derived name): picking a valid name is no longer a
   burden, but init only fills fields fffactory generates (schema_version,
   release, factory_id) and never operator choices (account, region, network,
   state bucket). It also fills gaps in existing documents, so a default there
   would silently opt existing factories in on a rerun. Default-on, if wanted,
   is "absent means enabled", shown in the reviewed plan — deferred because
   Phase 1 has no collector: TODO(re-evaluate when the collector ships).
   Rejected alternatives:
     - init proposes one: more surface in a phase with no consumer yet.
     - init fills `log_archive.enabled: true`: makes an operator choice and
       opts existing factories in on rerun.

✓ D2. No live apply-time permission check
   Chose: terraform-check asserts the planned worker policy is exactly the
   intended statements (as it already does for the secret-reading policy).
   AWS's enforcement was proven by the Phase 0 live check (roadmap D9);
   Phase 2's first upload exercises the grant live and a denied write shows in
   its heartbeat.
   Rationale: user — "as thin as possible; we don't need to re-verify the
   permissions structure of AWS in our own code." Secrets work the same way
   today: CI asserts the policy, apply exercises it only as a side effect.
   Rejected alternatives:
     - a `host` subcommand attempting allowed and forbidden writes after
       install: re-tests AWS, and needs worker code that belongs to Phase 2.
   Changes the roadmap's Phase 1 success criterion: drop "plus an apply-time check".

✓ D3. The archive name is derived
   Chose: `"log_archive": { "enabled": true }` -> bucket
   `<factory-id>-logs-<account>-<region>-an` (account-regional namespace).
   Max length 56 <= 63 for any valid factory ID and region. Turning it off
   removes the worker grant and keeps the bucket. User: "for now".
   Rationale: no free choice means no suffix rule, no not-the-state-bucket
   rule, and no change refusal (nothing exists to remember a prior value
   except a factory-root output, as host keys do).
   Rejected alternatives:
     - free `log_archive.bucket` (roadmap): three new rules plus a change
       refusal with no storage for the prior value.

✓ D4. The identity record moves to Phase 4
   Chose: Phase 1 writes no S3 objects. Phase 4, its only consumer, decides
   between an apply-written record and worker-observed repository identity
   (each checkout's actual git remote, recorded by the collector).
   Rationale: the record is data written by fffactory code, not a Terraform
   resource: it would add an S3 write port, a reviewed mutation with its own
   staleness rule, a failure semantic for apply, and a record format that
   belongs with Phase 2's archive format. Account and region add nothing: the
   derived name (D3) and factory.json give them.
   Rejected alternatives:
     - keep in Phase 1 (roadmap): cost above, no reader until Phase 4.

✓ D5. Archive creation sits inside the infrastructure stage
   Chose: `fffactory plan` checks the archive's readiness; missing -> plans the
   `archive/` root create-only into `archive.tfplan`, bound by digest in the
   saved factory plan with a staleness reason when presence changes; present
   and ready -> nothing planned; half-made -> refused. Apply runs it after
   approval, before the factory root, in the infrastructure stage. Upgrade
   inherits it.
   Rejected alternatives:
     - a new stage: a new constant, outcomes and presentation for one bucket.
     - a separate bootstrap-like saved plan: bootstrap is separate only because
       the lock lives in the state bucket; the archive can be created under it.

✓ D6. Bucket policy carries only the TLS-only Deny
   Rationale: workers hold no delete, and S3 refuses to delete a non-empty
   bucket. Rejected: also Deny DeleteBucket / lifecycle changes (more policy,
   protects against operators only).

✓ D7. Bucket readiness reuses the S3 adapter's check
   Chose: generalise the HeadBucket/readiness check from `StateBucket` to a
   bucket name. No new port.
   Rejected: a new ArchiveStore port (only needed once fffactory writes objects,
   which D4 removed).

✓ D8. Teardown names the kept archive without an AWS call
   Chose: "Log archive <name> is kept; fffactory never removes it", derived from
   factory.json, in question, review, report and advice; reword "nothing it
   owns remains" and "apply would create a new one".
   Rationale: true whether or not the bucket was ever created; no new call.
   Rejected: HeadBucket to report kept vs never created.

## Open

(none)
