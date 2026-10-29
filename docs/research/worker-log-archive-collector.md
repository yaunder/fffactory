# Worker log archive: collector and storage validation

Date: 2026-10-26. Phase 0 of the worker-log-archive roadmap. Answers the
collector and storage items of the
[design's validation list](../designs/worker-log-archive.md#validation-required-before-implementation)
(items 1, 2, 4 and 6), building on the
[collection and grouping spike](worker-log-collection-spike.md).

Sources: desk review of this repository's specs, code and Terraform; AWS
documentation fetched 2026-10-26; the published Claude Code `2.1.302` package;
local experiments against synthetic fixtures and a mocked S3; and an authorized
read-only inspection of the v2 worker `fff-r29c2un6-builder-1`. Nothing created
AWS resources, changed a factory, or wrote to the worker. No conversation text,
identifier values or secret values are recorded here. Each finding is marked
**established** (with its source) or **unverified**.

## Verdict

Every collector item has an answer. The AWS behaviours the design depends on
passed a [live check](#live-aws-check-established-2026-10-27). What remains
needs a worker on the target release (see
[Still unverified](#still-unverified)). The collector should be:

- a TypeScript `fffactory host collect --once` in the worker binary,
- run every minute by a systemd timer with no tie to Paseo,
- uploading only appended bytes (append-delta) with a full-prefix hash to
  detect rewrites,
- publishing content-addressed blobs and a per-cycle journal, all written with
  `If-None-Match`,
- into a create-only archive bucket that teardown keeps.

The worker inspection changes two assumptions:

- **The worker is stale.** It runs release 0.0.3: Claude Code `2.1.280` and
  Paseo `0.9.1`.
- **Secret-pattern scanning flags mostly fixtures.** Matches in its transcripts
  turned out to be fffactory's own realistic test values, so how secrets are
  handled must be decided deliberately rather than by pattern scanning.

## 1. Discovery and coverage (item 1)

**On the worker (established, read-only inspection):**

- **Claude root:** the default `/home/factory/.claude`. `CLAUDE_CONFIG_DIR` is
  unset in `paseo.service` and in every running Paseo and Claude process.
- **`projects/`:** 1,258 files, 292.6 MB:
  - 207 main transcripts
  - 365 subagent transcripts and 365 sidecars
  - 315 saved tool outputs
  - 6 memory files
- **Also present:** `file-history/` (21 files), `backups/`, `sessions/`,
  `shell-snapshots/`, `plugins/`.
- **Absent:** `todos/`, `plans/`, `tasks/`, `debug/`, `paste-cache/`.
- **History:** 2026-10-14T15:45Z to 2026-10-27T00:44Z; 73,591 records, none
  malformed.
- **Retention:** nothing overrides `cleanupPeriodDays` or disables persistence
  (managed, user, remote, policy, project and Paseo's inline settings were all
  checked). Cleanup last ran 2026-10-26 and had deleted nothing detectable: all
  207 Paseo Claude agents still have their transcript.
- **First deletion:** the 30-day default starts deleting history around
  **2026-11-13**.
- **Disk:** 189.9 GiB free of 199.9 GiB.

**Retention control (established, Claude Code `2.1.302` binary strings):**

- `cleanupPeriodDays` defaults to 30. Its minimum is 1, and 0 is rejected.
- Claude's own hint suggests "a large number (e.g. 3650 for ~10 years)" for
  long retention.
- A policy (managed settings) value is honoured even when Paseo narrows
  `--setting-sources` to `user,project,local`: the cleanup gate checks
  `policySettings` independently.
- Persistence is disabled only by `--no-session-persistence` or the SDK's
  `persistSession: false`.
- Paseo `0.13.2` itself deletes the transcripts of the ephemeral helper runs it
  starts with `persistSession: false` (metadata and branch-name generators;
  `agent/providers/claude/agent.js:2346-2359` in `@getpaseo/server@0.13.2`).
  Those runs are a known, acceptable gap.
- Fact: setting `cleanupPeriodDays` in the managed settings that
  [credential delivery](../specs/credential-delivery.md) already writes keeps
  evidence on the worker until it is collected.

**Collection boundary (recommendation):**

Use an allowlist, not a denylist.

- **Collect:**
  - `projects/**/*.jsonl`, subagent transcripts and `.meta.json` sidecars
  - `tool-results/` files
  - `file-history/<session>/` backups referenced by transcripts
  - `paste-cache/`, `plans/`, `tasks/` and `todos/`, when present
- **Never collect** (credential- or state-like; names established from the
  binary):
  - `~/.claude/.credentials.json`, `~/.claude.json` and its backup
  - `.session_ingress_token`
  - `remote-settings.json`, `policy-limits.json`
  - `session-env/`, `shell-snapshots/`
  - `~/.config/fffactory/`, `~/.codex/`
- **Exclude from the first release:** `backups/` and `sessions/`. Their
  contents are not established, so they stay out until fixtures show they hold
  session evidence.
- **Undecided:** the project memory Markdown files under `projects/`. They are
  outside the earlier spike's boundary.

## 2. Live copying and recovery (item 2)

**Hot files (established, local experiments):**

A synthetic 25 MB transcript received an append every ~200 ms, plus a ~1 MB
line every minute, an in-place rewrite, an atomic replace and a same-length
edit. Results:

| Strategy | Result |
| --- | --- |
| A: whole-file copy, waiting until the file is stable | Starves under continuous appends. At 25 MB/s read speed, 470 of 471 attempts were rejected, with no capture for a 6-minute hot period. At 125 MB/s, 79% were rejected. It also stores a full revision every cycle (~10 GB raw per 8-hour hot transcript). |
| B1: append-delta, hashing only the last 64 KiB of the prefix | Missed a same-length early edit, then published corrupt revisions for the rest of the run. Rejected. |
| B2: append-delta, hashing the full captured prefix | Completed every cycle at every read speed with no retries. Moved 1.1–2.2 MB/min raw, about the writer's rate, using 33–100 ms CPU per hot minute. Fell back to a full new generation on rewrite, replace and same-length edit; every revision was a real prefix state and the last equalled the file. |

The full-prefix hash costs local reads only. For the hottest file that is about
26 MB/min, which is cheap next to uploading.

**On the worker (established append-only; rewrites unverified):**

- Three snapshots 150 s apart during an active but quiet run.
- Growth was append-only: up to ~20 KB/min per file, with no shrink, inode
  change or same-size change, and earlier bytes always unchanged.
- No compaction records were present.
- A full snapshot with hashes took 0.26–0.51 s.
- The largest file was 3.75 MB, against 26 MB locally.

Rewrite detection is therefore exercised by synthetic fixtures only.

**Idempotent publication (established against a mock, unverified against S3):**

The scheme: content-addressed chunk blobs plus sequence-numbered journal
records, every write with `If-None-Match: *`. It passed 344 runs:

- a crash before and after every operation, including ambiguous puts;
- a transient error at every operation;
- appends between crash and restart;
- two interleaved collector instances.

Outcomes: no duplicate logical revision, no gap, no checkpoint ahead of stored
data, and every revision reassembled to a real source prefix.

The pinned `@aws-sdk/client-s3` exposes `IfNoneMatch`. The S3 lock store
already uses it, and `tests/support/stub-s3.ts` already models conditional
writes.

## 3. Storage, layout and permissions (item 4)

**S3 behaviour (established, AWS docs):**

- `If-None-Match: *` on PutObject returns 412 if the key exists, and the first
  of several racing writers wins.
  ([conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html))
- On a versioned bucket it checks only the current version, so a delete marker
  lets a rewrite through: **workers must have no delete permission.**
- A bucket policy can require the header with `s3:if-none-match`
  ([enforcement](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html)).
- S3 is strongly read-after-write consistent for GET and LIST, but has no
  cross-key atomicity. Publish blobs before the journal record that names them.
- The largest observed file is 26 MB, so single PUTs suffice and multipart is
  avoided.

**Bucket settings (recommendation):**

- Versioning on, Object Lock off, SSE-S3, no lifecycle rules.
- Object Lock can never be disabled, and compliance retention only grows. That
  conflicts with the design's "retention can be changed deliberately later".
- SSE-KMS adds operator `kms:Decrypt` grants. A factory-owned key deleted at
  teardown would make the archive unreadable.
- Immutability comes from content-addressed keys, enforced `If-None-Match` and
  no worker delete.

**Cost (estimate, us-east-1 prices):**

| Volume | Cost per month |
| --- | --- |
| Per worker, 8 h × 22 days | ≈ $1.60–$2.60 |
| Per worker, 24/7 | ≈ $6–$10 |

- Requests dominate; batching one journal record per cycle roughly halves them.
- Append-delta storage stays near true content, about 0.15 GB per worker per
  month.
- Whole-file revisions would instead store ~138 GB per worker per month and
  reach ~$36 per worker per month by month 12.

**Candidate layout (recommendation):**

```text
archive/1/<factory-id>/
  factory/<utc-ts>.json                written by apply: factory identity, region,
                                       repository key -> remote map
  workers/<role-id>:<instance-id>/     the enforced per-incarnation prefix (below)
    incarnation.json                   host key, instance id, release, versions, roots
    blobs/sha256/<hex>                 raw bytes: chunks, generation bases, small files
    journal/<run>/<seq>.json           one per cycle, written after its blobs
    observations/paseo/<run>/<seq>.json  Paseo projection, only when changed (Phase 3)
    heartbeat/<yyyy-mm-dd>/<ts>.json   freshness, backlog, last failure, boot id
```

- Source paths become opaque hash IDs: Claude's encoded project directories can
  contain characters that are unsafe in S3 keys. The real path is kept in the
  journal record.
- The reader derives grouping from journal and observation records and caches
  it locally. It never lists blobs.

**Where the bucket lives (established constraints; recommendation):**

The bucket cannot be in the `factory` Terraform root:

- `prevent_destroy` fails teardown's guarded destroy plan;
- `removed` blocks are banned by `tests/support/terraform-guardrails.ts`;
- `destroyPlanRefusal` refuses `forget` (see [provisioning](../specs/provisioning.md)).

**Recommendation:**

- A new state-less, create-only `archive/` root, built like `backend/`
  (HeadBucket readiness, `prevent_destroy`).
- Created under the factory lock as part of the reviewed plan, not by a
  separate bootstrap. The state bucket has its own bootstrap only because the
  lock lives in it.
- Never deleted by any fffactory command, and reported as kept by teardown.
- It inherits the backend root's "cannot reconfigure" limit, marked as a TODO
  to re-evaluate when retention or settings must change.

**Name (established):**

- Use the S3 account-regional namespace, `<factory-id>-logs-<account>-<region>-an`
  ([bucket namespaces](https://docs.aws.amazon.com/AmazonS3/latest/userguide/gpbucketnamespaces.html)).
  No other account can ever recreate that name. It is unavailable in
  me-south-1 and me-central-1.
- The pinned AWS provider 6.66.0 supports it (`bucket_namespace`, added in
  6.37.0).

**Configuration (recommendation):**

- An optional `log_archive.bucket` in factory.json, so schema version 1 stays.
- Validated like `state_backend.bucket`:
  - carries the factory ID;
  - is not the state bucket;
  - ends in `-<account>-<region>-an`.
- Absent means no archive and no collector.
- The state bucket must never be selected: teardown empties and deletes it, and
  it holds Terraform state and the lock, which workers must not be able to
  write.
- Changing `log_archive.bucket` after workers have written would strand the old
  evidence. Refuse the change in the first release.
- factory.json survives teardown, so `fffactory logs` can still find the
  archive.

**IAM (established constraints; recommendation):**

Constraints:

- All hosts share the role `<factory-id>-host`, which today grants only
  `secretsmanager:GetSecretValue`
  (`assets/terraform/modules/host-identity/main.tf`).
- The guardrail requires every non-read Allow to carry
  `StringEquals aws:ResourceTag/fffactory:factory-id`.
- S3 evaluates `aws:ResourceTag` only once ABAC is enabled on the bucket
  ([bucket tagging](https://docs.aws.amazon.com/AmazonS3/latest/userguide/buckets-tagging.html)).

Recommendation:

- Enable ABAC on the archive bucket so the worker grant fits the guardrail
  unchanged.
- Worker policy: Allow `s3:PutObject` on
  `<bucket>/archive/1/<factory-id>/workers/${aws:userid}/*`, where
  `aws:userid` is `role-id:instance-id` for an instance role. This enforces one
  prefix per worker incarnation.
- Deny `s3:PutObject` without `If-None-Match`. No delete, ACL or lifecycle
  actions, and no read.
- The grant lives on the role's identity policy, recreated with the role. The
  surviving bucket policy names no role and carries only Deny statements:
  TLS-only, and optionally no `DeleteBucket` and no lifecycle changes. A
  re-applied factory recreates the role with a new role ID, which a stored
  principal would no longer match.
- Operators need documented `s3:ListBucket` and `s3:GetObject` permissions on
  the factory prefix, the account check, and `ExpectedBucketOwner` on every
  call.

Note: IMDS answers every local user (hop limit 1 only stops bridged
containers), so agents can use the role's credentials too. The role must
therefore never be able to overwrite or delete.

## 4. Runtime and lifecycle integration (items 5 and 6)

**What runs on the worker today (established):**

- The Bun-compiled worker `fffactory` (~85 MB, one-shot `host` subcommands)
  already bundles the S3 client and the IMDS credential provider.
- One stdlib Python program, `factory-dispatch`, runs on the system Python 3.9.
- The only systemd unit fffactory installs is `paseo.service`, with no timers.
- The v2 design rules out a persistent fffactory daemon for worker management
  ([fffactory-v2](../designs/fffactory-v2.md)).
- AL2023 ships systemd 252.

**Recommendation:** run `fffactory host collect --once` from a
`fffactory-collector.timer` (`OnBootSec`, `OnUnitInactiveSec=60s`,
`AccuracySec=5s`).

- systemd never overlaps runs.
- Each run executes `/opt/fffactory/current`, so upgrades need no restart.
- Memory is released between runs.
- Tests run in `just check-all` against `stub-s3.ts` and a loopback IMDS, under
  the existing AWS-isolation test.

The unit:

- **Paseo:** no `Requires`, `BindsTo`, `PartOf` or `After` on `paseo.service`,
  and it is never launched from Paseo or an agent (Paseo's
  `KillMode=control-group` would kill it).
- **Limits:** CPU and memory limits (`CPUWeight`, `CPUQuota`, `MemoryHigh`,
  `MemoryMax`, `TasksMax`).
- **Sandbox:** `ProtectSystem=strict`, `ProtectHome=read-only`,
  `NoNewPrivileges`, `StateDirectory` for checkpoints, and `InaccessiblePaths`
  over the credential stores.
- **I/O:** bounded by per-run byte and time budgets. `IOWeight` on EBS NVMe is
  not relied on.
- **Lock:** the collector must not take `/run/fffactory-host-apply.lock`,
  which `host apply`, `repositories`, `control-plane`, `dispatch` and
  `work inspect` share. Otherwise it would make them fail as `busy`.

Rejected alternatives:

- **Python with hand-rolled SigV4:** security-relevant code, tests outside
  check-all, and a second implementation of the archive format.
- **boto3:** not on the AMI, and tied to Python 3.9.
- **The AWS CLI per call:** process cost and stderr parsing.
- **A long-running daemon:** contrary to the v2 design and needs a restart on
  upgrade.

**Install (recommendation):**

- A small `collector` step at the end of `host apply`'s install steps writes
  the unit and configuration, reloads systemd and enables the timer.
- It never waits for an upload, S3 or freshness.
- An install failure fails the install honestly with its step log, like any
  step.
- Runtime health (last upload, backlog, last error class) stays out of
  `host verify`, `WORKER_SERVICES` and the dispatch gates, so it never blocks
  dispatch.
- A separate apply stage was rejected: it would need a new root activator
  operation, and every existing worker's first-boot activator refuses those
  (exit 64).

**Interactions (established by reading the code):**

- Every release change plans Paseo maintenance, so a collector release reaches
  only idle workers. Today a worker is never idle once dispatch has run (#92).
  Rollout therefore depends on epic #94, and on #96 for `upgrade`.
- Archive settings must be excluded from the host projection's control-plane
  part, as `credentials` is. Otherwise changing them plans a Paseo restart.

**Retirement (recommendation):**

- `worker terminate` and `teardown` report each worker's unarchived evidence,
  read through `work inspect` or an unprivileged read, in the review and the
  removal record (#102).
- A worker that cannot be inspected is reported from its last heartbeat in S3,
  as "last archived at T", never as "nothing unarchived".
- Whether a backlog refuses removal (like unpushed work, with `--force`) or is
  report-only is a Phase 1 decision. Teardown has no `--force`.

## 5. Secret-shaped content (validation of the design's privacy section)

**Established (no values recorded):**

- **Worker scan:** vendor-format patterns matched 13 distinct values:
  - 3 AWS access-key IDs
  - 8 Tailscale keys
  - 1 GitHub token
  - 1 URL with credentials
- **Classification by masked context:** every match was a fixture, except one
  AWS access-key ID that was quoted in a test report about requests signed with
  a local profile's key. A key ID is an identifier, not a secret, and no secret
  access key appeared. The rest were constants in fffactory's own tests
  (`TOKEN`, `AUTH_KEY`, `ADMIN_SECRET`, `PASTED`), fake environment values, a
  stub credential process with `SecretAccessKey` `"x"`, and URL test cases.
- **Local sample:** similar classes, unclassified.
- **Where:** hits sit in tool inputs and results, saved outputs and prompts,
  and are duplicated across `toolUseResult`, `wireToolInputs` and rendered
  copies.

**What this shows about pattern scanning:** it cannot tell realistic test
fixtures from live credentials. This repository's tests deliberately use
realistic secret shapes, so on fffactory's own work a scanner mostly flags
fixtures. An AWS secret access key also has no prefix to match at all. No live
secret was found, but agents work with credentials, so the archive must still
be treated as potentially holding them.

Unmodified capture and secret removal are mutually exclusive: redaction changes
the evidence, has to cover every duplicate, and over-matches fixtures. The
design requires the choice to be explicit. It belongs to Phase 1.

## Live AWS check (established, 2026-10-27)

The bucket and worker policy proposed above were checked in a throwaway AWS
account that holds no factory. The check used the pinned AWS provider 6.66.0
with Terraform 1.16.4. All resources were destroyed afterwards and confirmed
gone.

The setup:

- An account-regional bucket (`bucket_namespace = "account-regional"`) with
  versioning and a public access block, tagged `fffactory:factory-id`.
- A role carrying the proposed worker policy:
  - Allow `s3:PutObject` on `.../workers/${aws:userid}/*`, conditioned on
    `aws:ResourceTag/fffactory:factory-id`;
  - Deny `s3:PutObject` when `s3:if-none-match` is absent.
- An instance identity emulated by assuming the role with session name
  `i-…`. That yields the same `aws:userid` form as an instance role,
  `AROA…:i-…`.

| Case | ABAC off | ABAC on |
| --- | --- | --- |
| Own prefix, `If-None-Match: *` | AccessDenied | Allowed |
| Same key again, `If-None-Match: *` | AccessDenied | PreconditionFailed (412) |
| Own prefix, no `If-None-Match` | AccessDenied | AccessDenied |
| Another incarnation's prefix | AccessDenied | AccessDenied |
| Outside the workers prefix | AccessDenied | AccessDenied |
| Delete own object | AccessDenied | AccessDenied |

Conclusions:

1. **ABAC fails closed.** With ABAC off, the tag condition matches nothing.
   With it on, the guardrail's existing tag condition admits exactly the
   intended writes.
2. **`${aws:userid}` resolves inside S3 object ARNs.** It enforces one prefix
   per incarnation. `sts:GetCallerIdentity` works without any permission, so
   the collector can learn its own prefix.
3. **Provider ordering works.** Creating the bucket with its namespace, its
   tags and ABAC in one fresh apply succeeds. So does enabling ABAC later on a
   tagged bucket. Re-plans show no drift, and the same account-regional name
   was recreated after deletion.
4. **Conditional writes behave as specified.** `If-None-Match` is enforced by
   the identity policy's Deny, and a repeated key returns 412.

## Still unverified

Each of these needs a worker running the release that pins Claude `2.1.302`
and Paseo `0.13.2`:

1. Peak RSS and startup time of the 85 MB worker binary running once a minute
   on AL2023. This sets `MemoryHigh` and `MemoryMax`.
2. Rewrite and compaction behaviour on real transcripts, and the artifact
   layout written by Claude `2.1.302` on a worker.
3. What `backups/` and `sessions/` hold.
