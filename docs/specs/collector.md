# Collector

With the log archive enabled ([instance configuration](instance-configuration.md)),
each worker copies the evidence Claude Code keeps on its root volume into the
archive the factory's hosts may write
([provisioning §Log archive access](provisioning.md#log-archive-access)).
This spec defines what is collected, the archive's format, and the rules every
run decides by. Design: [worker log archive](../designs/worker-log-archive.md);
evidence: [collector validation](../research/worker-log-archive-collector.md).

The rules are pure (`src/domain/collector.ts`, `src/domain/archive-format.ts`);
the run that reads the files and writes the archive builds on them.
Collection is raw: nothing is redacted, so the archive may hold anything an
agent saw and is treated as sensitive.

## Sources

Claude's root is `/home/factory/.claude` (`CLAUDE_ROOT`). Only these
directories under it are collected (`COLLECTED_DIRECTORIES`), with everything
below them:

| Directory | Holds |
| --- | --- |
| `projects/` | Main and subagent transcripts, subagent `.meta.json` sidecars, saved tool results, project memory files. |
| `file-history/` | Every file-history backup. |
| `paste-cache/`, `plans/`, `tasks/`, `todos/` | Collected when present. |

A path is collected (`collectable`) only when all of these hold:

- it is absolute, under `CLAUDE_ROOT`, inside one of those directories, and
  names something below the directory, not the directory itself;
- none of its segments is empty, `.` or `..`, and none holds a NUL: a path is
  refused rather than normalized, so `projects/../.credentials.json` is refused;
- it is a regular file, reached through no symbolic link: the path is not one,
  and no directory on the way to it is one;
- its name is none of the credential files below, wherever it sits.

Discovery descends only into `CLAUDE_ROOT` and the collected directories
(`walkable`), under the same segment rules.

Never collected (`NEVER_COLLECTED`), whatever the allowlist says:

- `~/.claude/.credentials.json`, `~/.claude.json` and its backup
  (`~/.claude.json.backup`), `~/.claude/.session_ingress_token`;
- `~/.claude/remote-settings.json`, `~/.claude/policy-limits.json`;
- `~/.claude/session-env/`, `~/.claude/shell-snapshots/`, `~/.claude/sessions/`,
  `~/.claude/backups/` (their contents are not established as session evidence);
- `~/.config/fffactory/`, `~/.codex/`.

The names `.credentials.json`, `.claude.json`, `.claude.json.backup` and
`.session_ingress_token` are refused anywhere, also inside a collected directory.

A source is identified by its source ID: the SHA-256 of its absolute path's
UTF-8 bytes, as lowercase hex. Archive keys never carry a path; the real path
appears only inside journal records and the local checkpoint.

## Archive format v1

Every worker incarnation writes under its own prefix, which the hosts' policy
enforces (`aws:userid` is `<role ID>:<instance ID>` for an instance role;
`callerIncarnation` reads it, `archiveKeys` builds the keys):

```text
archive/1/<factory-id>/workers/<role-id>:<instance-id>/
  incarnation.json                   once per incarnation
  blobs/sha256/<hex>                 raw bytes, named by their SHA-256
  journal/<epoch>/<seq>.json         at most one per run, after its blobs
  heartbeat/<yyyy-mm-dd>/<ts>.json   every run
```

- Every object is created with a single PutObject carrying `If-None-Match: *`;
  none is ever replaced or deleted. A blob that already exists is already
  stored (its key is its content).
- Keys use only letters, digits and `!-_.*'()/`, plus the `:` that `aws:userid`
  puts in the prefix; never a path (`isS3SafeKey`).
- `<epoch>` is `YYYYMMDDTHHMMSSZ-<16 hex>`: the UTC time a checkpoint was
  started and 8 random bytes (`newEpoch`). `<seq>` is the run's sequence number
  in its epoch, from 1, zero-padded to 10 digits so keys sort in order.
- `<ts>` is the heartbeat's UTC time as `YYYYMMDDTHHMMSS.mmmZ`, under its date.

Each document is JSON with `"format": 1`. A reader rejects another format and
ignores fields it does not know; adding a field keeps the format, and removing,
renaming or redefining one needs a new one, under a new `archive/<n>/`.
Shared fixtures: `tests/domain/fixtures/archive/`.

### incarnation.json

| Field | Value |
| --- | --- |
| `factory_id`, `host_key` | The factory and the host this worker is. |
| `role_id`, `instance_id` | The incarnation, as in its prefix. |
| `created_at` | When the collector first ran on it. |
| `release` | The fffactory release that wrote it. |
| `claude_code_version` | Claude Code's version, or `null` when it could not be read. |
| `claude_root` | `CLAUDE_ROOT`. |

### Journal records

One run that captured anything writes one record listing its captures; a run
that captured nothing writes none.

| Field | Value |
| --- | --- |
| `epoch`, `seq` | As in its key. |
| `run_started_at` | When the run started. |
| `captures` | Each capture, below. |

A capture:

| Field | Value |
| --- | --- |
| `source` | The source ID. |
| `path` | The source's absolute path. |
| `generation` | Its generation in this epoch, from 1. |
| `offset`, `length` | The bytes `[offset, offset + length)` of that generation; `offset` is 0 for a new generation. |
| `blob` | The SHA-256 of exactly those bytes: its blob's name. |
| `base_sha256` | The SHA-256 of the generation's bytes `[0, offset)`, the `prefix_sha256` of the capture it follows; `null` exactly when `offset` is 0. |
| `prefix_sha256` | The SHA-256 of the generation's bytes `[0, offset + length)`. |
| `mtime_ms` | The source's modification time when it was read. |

A run whose journal record is stored but whose checkpoint is not (it stopped in
between) leaves an orphan: the next run starts from the older checkpoint and
may record the same source, generation and offset again with other bytes, as
when the file was rewritten once more in between. Its journal key is taken
(`If-None-Match` fails), so it advances the sequence until a key is free (several
orphans in a row each hold one), and an orphan's sequence is always lower than
any record made after it. A reader reassembles
each source in an epoch by these rules:

- Within an epoch, of the captures of one source, generation and offset, the
  one with the highest `seq` wins; the others are orphans and are ignored.
- A generation's content is its winning captures chained from offset 0: each
  next capture starts where the last ends and its `base_sha256` is the last
  one's `prefix_sha256`. A capture that does not chain is never spliced in.
- The highest-`seq` rule alone settles which capture wins; `base_sha256` makes
  every link checkable, so a reader detects, rather than silently assembles,
  bytes that do not follow.
- A source's current generation is the one its highest-`seq` capture records,
  not the highest generation number: an orphan's new generation that no later
  run replays is superseded by the generation later runs keep appending to.
- Ranges are idempotent: two captures of one source with the same
  `prefix_sha256` and the same `offset + length` describe the same bytes,
  whichever epoch, sequence or generation number recorded them, as a retried
  run or a new epoch records them again, and a reader dedupes them.

An orphan nothing superseded still holds bytes the file held when it was read.

### Heartbeats

| Field | Value |
| --- | --- |
| `at` | When the run ended. |
| `epoch` | The checkpoint's epoch. |
| `boot_id` | The worker's boot ID. |
| `release`, `claude_code_version` | As in `incarnation.json`. |
| `outcome` | `succeeded`, or `failed` when any write or read failed. |
| `failure` | The failure's class (an AWS error name or a network error code, never a message), or `null`; always `null` when `outcome` is `succeeded`. |
| `budget_hit` | `bytes` or `time` when the run stopped at a budget, else `null`. |
| `uploaded_bytes` | The bytes of the blobs this run created ([Run](#run)). |
| `journal_seq` | The sequence of the record this run wrote, or `null`. |
| `last_success_at` | When the last run that succeeded ended, this one included, or `null`. |
| `backlog` | `{ "files", "bytes" }` still unarchived after the run ([Backlog](#backlog)). |

## Capture

Each run decides each source from its checkpoint entry and a fresh stat (its
identity, size and modification time), in this order (`captureDecision`):

| Seen | Decision |
| --- | --- |
| Not in the checkpoint | New generation (`first`), uploaded whole. |
| Its identity (device and inode) changed | New generation (`replaced`). |
| Smaller than captured | New generation (`shrunk`). |
| Same size and modification time | Unchanged; not read. |
| At most `SMALL_FILE_BYTES` (64 KiB), otherwise changed | New generation (`changed`), uploaded whole. |
| Otherwise | Verify: hash its first captured-length bytes. |
| ...and that hash differs from the checkpoint's prefix hash | New generation (`rewritten`). |
| ...it matches, same size | Unchanged; only its modification time is recorded (`touchedEntry`). |
| ...it matches, larger | Append: the bytes from the captured length to the size. |

A new generation is the next number after the source's last in the
checkpoint; an append keeps it. A capture's checkpoint entry is
`capturedEntry`. A rewritten file keeps its earlier generations' captures: a
new generation's offset 0 is recorded twice in an epoch only when a run replays
one an orphan recorded ([Journal records](#journal-records)), and the replay wins. The
prefix hash covers the whole captured prefix, never only its
tail, so an edit of the same length anywhere before the end is a rewrite.
Captured bytes are raw: a partial last line is completed by the next append.

## Checkpoint

The collector's checkpoint is its own local state (`checkpoint.json`), saved
only after the data it names is stored:

| Field | Value |
| --- | --- |
| `epoch` | Its epoch. |
| `next_seq` | The sequence the next journal record takes; past the last one this run wrote, or a key it found taken. |
| `saved_at` | When it was saved. |
| `last_success_at` | When the last successful run ended, or `null`. |
| `sources` | Per source, by source ID: `path`, `identity`, `mtime_ms`, `generation`, captured `length` and `prefix_sha256`. |

A missing or unreadable checkpoint is lost: the next run starts a new epoch,
from sequence 1, and captures every source as new, whole. Blobs it uploads
again are already stored, and readers dedupe the ranges.

## Budgets

A run uploads at most 64 MiB of blobs and stops starting uploads after 40 s
(`COLLECTION_BUDGET`; both `TODO(re-evaluate when measured on Acceptance)`).
Pending captures go most recently modified first, ties by source ID
(`budgetedCaptures`): each is admitted while the bytes admitted stay within the
budget, and the first that would exceed it stops the run there, leaving it and
everything after it to later runs. A first capture larger than the budget is
admitted cut to the budget's bytes: a new generation is recorded with only its
first 64 MiB, an append with its next 64 MiB, and later runs append the rest,
at most the budget per run. The budget exceeds `SMALL_FILE_BYTES`, so a cut
capture's rest is always appended, never captured whole again.

The time budget also bounds the decisions, so a run reaches its checkpoint
within it however much there is to verify. Sources are decided in the same
order, most recently modified first. Decisions get the first half of the time
budget (20 s), leaving the rest to the uploads: once it has passed, no verify
starts, and one still hashing gives up between chunks (1 MiB). Those sources
stay undecided, counting in the backlog, and the run reports `budget_hit:
"time"`; what stat alone decides (a new, replaced, shrunk or small changed
source) is still decided, and what was decided in time is uploaded, journaled
and checkpointed as usual. A verify found unchanged is touched, so the next run
decides it by stat and reaches further. A source whose captured prefix alone
takes longer than the decisions' half to hash never finishes a verify, and the
sources modified more recently than it are verified first every run; at disk
speed that is a prefix of gigabytes (`TODO(re-evaluate when T7 measures run
time on Acceptance)`).

## Backlog

What is unarchived is computed from a checkpoint and current source stats
alone, never by reading a file (`backlog`). A source counts as a file exactly
when stat does not find it as captured (same identity, size and modification
time), as the next run would capture or verify it, so an empty one counts with
no bytes. Per collectable source:

| Seen | Unarchived |
| --- | --- |
| Not in the checkpoint, or no checkpoint | The file, all its bytes. |
| Identity changed, or smaller than captured | The file, all its bytes. |
| Larger than captured | The file, the bytes beyond the captured length. |
| Same size, modification time changed | The file, all its bytes (a rewrite cannot be told from stat alone). |
| Same identity, size and modification time | Nothing. |

A source a run verified unchanged has its new modification time in the
checkpoint (`touchedEntry`), so it is no longer backlog.

A source the checkpoint names but no longer present is not backlog: what was
captured of it stays in the archive.

## Run

One run (`collectOnce`, `src/host/collect.ts`) is one pass, in this order:

1. **Lock.** It takes its own lock, `collect.lock` in its state directory
   (`COLLECTOR_STATE`, `/var/lib/fffactory-collector`), an exclusive `flock`
   without waiting. Held elsewhere, the run ends at once, quietly (`busy`):
   nothing is read, written or saved. It never takes, opens or creates the install
   lock (`/run/fffactory-host-apply.lock`), so it never makes `host apply`,
   `repositories`, `control-plane`, `dispatch` or `work inspect` refuse `busy`, and
   they never stop it.
2. **Checkpoint.** It reads `checkpoint.json` beside the lock; missing or
   unreadable, it starts a new one ([Checkpoint](#checkpoint)).
3. **Discovery.** It walks `CLAUDE_ROOT` with `lstat`, descending only into
   walkable directories and finding only collectable files ([Sources](#sources)).
   A symbolic link is neither descended into nor collected, nor is `CLAUDE_ROOT`
   when it is one; a path neither walkable nor collectable is not even `lstat`ed.
4. **Decision.** Each source is decided from its entry and its `lstat`
   ([Capture](#capture)), most recently modified first. A verify opens the
   source and hashes its captured prefix a chunk at a time; unchanged, its entry
   is touched. Once half the time budget has passed since the run started, no
   verify starts and one under way gives up; those sources are left to the next
   run ([Budgets](#budgets)).
5. **Budget.** The pending captures are admitted by the byte budget
   ([Budgets](#budgets)).
6. **Blobs.** Each admitted capture, in that order, is read and its blob put. No
   upload starts once the time budget has passed since the run started. A put
   answered `exists` (S3's 412) is stored: a blob's key is its content. The first
   put that fails stops the uploads.
7. **Journal.** If any blob was stored, one record naming exactly the stored
   captures is put at the checkpoint's `next_seq`. A key already taken (`exists`,
   an orphan's) advances the sequence and the record is put again there, at most
   1000 times in one run (then the run fails `JournalKeysTaken`).
8. **Checkpoint.** It saves the checkpoint whole or not at all (a private
   `0600` copy, flushed and renamed over it). Its entries take the run's captures
   only when their journal record was stored, so it never names a blob or record
   that is not stored; `next_seq` passes every key this run found taken or wrote.

A source is opened only with `O_NOFOLLOW`, and read only while the open file is
still the device and inode discovery found, the kernel finds it open at its own
path under the Claude root's real path (`/proc/self/fd`; the Claude root's parent
resolved once per run and its own name kept, so a link above it, such as `/home`
on a data volume, is followed, and the Claude root itself never is), and it
holds the bytes decided: one replaced, shortened, turned into a link, or reached
through a directory turned into a link in between is left for the next run,
whose decision sees it. A source that vanished is no failure, but the same file
found open at another path fails the run `SourcePathMismatch`, and one whose open
path cannot be read (no `/proc`) fails it `OpenPathUnverified`: either is left
for the next run, the other sources still collected, so a worker where every open
is refused never reports success with a backlog that only grows. A run never
writes, truncates, renames or deletes a source, or changes its times.

The run reports, in the heartbeat's terms ([Heartbeats](#heartbeats)), its
epoch, start and end, `outcome` (`failed` when a source or directory could not be
read for another reason than vanishing, a put failed, or the checkpoint could not
be saved, or a source was not found open at its own path; `failure` the first
one's class: the file-system error code, `SourcePathMismatch`,
`OpenPathUnverified` or the writer's), `budget_hit` (`time` over `bytes`; `time`
when the decisions or the uploads ran out of it), `uploaded_bytes` (the blobs it
created; one that existed is not counted), the journal sequence it wrote, the
last success (the checkpoint's, this run's when it succeeded and was saved) and
the backlog by the checkpoint in force after it and the stats it discovered.

The archive is written through an `ArchiveWriter` (`put(key, bytes)` answering
`created`, `exists` or `failed` with a class; `src/domain/archive-format.ts`),
so the run is tested against an in-memory archive with failures and crashes
injected at every put (`tests/host/collect.test.ts`). A run that dies at any
point leaves the checkpoint as it was; the next run resumes from it, and
reassembling the archive gives, per source, only states the file held, the last
equal to the file.
