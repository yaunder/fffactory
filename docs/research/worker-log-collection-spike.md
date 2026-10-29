# Worker log collection and grouping spike

Date: 2026-10-26. Scope: local evidence, reproducible experiments, and an
authorized read-only v2 worker follow-up for the
[approved archive design](../designs/worker-log-archive.md). The initial spike
used local files only. The follow-up inspected a worker through Paseo,
`fffactory status`, and Tailscale SSH; it changed no factory resources or
remote files.

## Verdict

The local files prove that a reader can join Paseo agents to Claude
conversations and reconstruct nested subagent activity without running or
resuming an agent. They also contain useful tool, usage, and cost evidence.
Historical associations are incomplete, so collection must retain unmatched
files and metadata independently.

Collection also works against the local sample: 434 artifacts totaling
152,620,746 bytes were copied into a private temporary archive and verified
by SHA-256. A restarted collector recognized all 434 as unchanged. Twelve
synthetic experiment groups passed, including concurrent mutation, partial
records, revision retention, publication failures, and grouping. The archive
was removed after verification; only synthetic fixtures and aggregate results
remain in this repository.

The full epic-to-attempt join is established by the factory dispatcher and
Paseo storage contract, but it is not demonstrated by a real dispatched run in
this local sample: every local Paseo record has an empty labels object.
The remote follow-up below verifies real epic associations from recorded
commands, but also finds the expected factory labels absent on that worker.
The label-based route still needs validation on the intended release.

## Inspection method and limits

The read-only survey parsed records under `~/.paseo/agents/` and files under
`~/.claude/projects/`, comparing identifiers in memory. It did not copy private
conversation text into this repository. Counts, field names, structural
relationships, and source references are recorded below; prompts, titles,
project names, identifier values, and raw settings are omitted.

All 149 discovered JSONL files parsed successfully, containing 38,349 records
at inspection time. The record timestamps span 2026-09-25 through 2026-10-26.
Observed transcript `version` values were `2.1.267`, `2.1.277`, and `2.1.284`.
These are not the repository's Claude Code `2.1.302` pin. The local Paseo
records do not establish which Paseo release originally wrote them.

Source inspection used the extracted, published `@getpaseo/server@0.11.4`
package already available locally, matching the repository's Paseo pin.
Package paths below are relative to `dist/server/server/`. The existing
[Paseo lifecycle research](../roadmap/worker-idleness/research/paseo-0.11.4.md)
records the package provenance. Repository pins are in
[agent versions](../../assets/steps/versions.env) and
[control-plane versions](../../assets/steps/control-plane/versions.env).

## Observed relationships

| Observation | Result |
| --- | --- |
| Persisted Paseo agents | 275: 128 Claude and 147 Codex |
| Claude agents with a native session ID | 128 of 128 |
| Claude agents whose persistence ID, native handle, and runtime session ID agree | 128 of 128 |
| Paseo records with factory dispatch labels | 0; all 275 labels objects are empty |
| Top-level Claude transcripts | 62 |
| Exact Paseo native-session-to-transcript joins | 43 agents to 43 transcripts |
| Claude Paseo records without a remaining top-level transcript | 85 |
| Top-level transcripts without a current Paseo record match | 19 |
| Top-level filenames matching their records' session IDs | 62 of 62 |
| Subagent transcripts | 87, all with an existing top-level parent transcript |
| Subagent filename agent IDs and directory session IDs matching record fields | 87 of 87 |
| Subagent sidecars whose tool-use ID resolves to the immediate parent's tool call | 87 of 87 |
| Subagents with another subagent as immediate parent | 3; all parent IDs resolve |

These are file joins, not counts of successful work or proof of complete
history. Missing transcripts may have been removed or stored elsewhere; this
inspection does not establish their cause. Likewise, an unmatched transcript
does not establish that it was originally created outside Paseo.

All 43 matched local records used a transcript directory matching their
encoded current working directory. The production collector still must search
by native session ID across project directories: Paseo's
`agent/providers/claude/project-dir.js:21` explicitly handles resumed sessions
that continue writing in their original directory after the working directory
changes. Directory decoding alone is not an identity contract.

## Epic and attempt mapping

The [factory dispatcher](../../assets/steps/dispatch/factory-dispatch) passes
these string labels on each dispatched agent:

```text
factory-dispatch
factory-repository
factory-epic
factory-dispatched-at
```

It retains the returned Paseo agent ID in its dispatch summary. Paseo's stored
record schema includes `id`, `labels`, `cwd`, `workspaceId`, timestamps,
`runtimeInfo`, and `persistence`. Claude's `describePersistence()` explicitly
writes the native Claude ID to both `persistence.sessionId` and
`persistence.nativeHandle`. Sources: package
`agent/agent-storage.js:27` and
`agent/providers/claude/agent.js:2139`.

The resulting exact join is:

```text
factory-repository + factory-epic
  -> Paseo agent id (attempt)
  -> persistence.sessionId (Claude conversation)
  -> projects/<project>/<session-id>.jsonl and its associated directory
```

Retain factory and worker-incarnation identity alongside this metadata. An
alias alone does not preserve a repository's identity after configuration
changes, and the same host key can be reused on a replacement machine.

Do not archive a complete Paseo record merely to obtain these associations.
Its configuration schema also permits system prompts, MCP configuration, and
provider options. A bounded projection of relationship and lifecycle fields is
sufficient for grouping and avoids pulling unrelated configuration into the
archive. This is separate from preserving the Claude evidence files.

## Subagents and nested work

Observed layout:

```text
projects/<project>/<session-id>.jsonl
projects/<project>/<session-id>/subagents/agent-<agent-id>.jsonl
projects/<project>/<session-id>/subagents/agent-<agent-id>.meta.json
```

Every child transcript carried the containing conversation's `sessionId` and
its own `agentId`. All 87 sidecars contained `toolUseId` and `spawnDepth`, along
with descriptive and request-shape metadata. Eighty-four had depth 1; three
had depth 2 and a `parentAgentId` identifying another subagent in the same
conversation. Every sidecar's `toolUseId` matched a `tool_use.id` in its
immediate parent's transcript.

`parentUuid` is message ancestry, not the parent agent relationship. In this
sample all child message chains began with `parentUuid: null`, and no child
`parentUuid` pointed into its parent's transcript. Joining on it would miss
every subagent relationship. Top-level transcripts referenced 82 of the 87
child agent IDs in `toolUseResult`; those references alone do not describe
nested ancestry or cover every identifiable child.

The observed sidecars provide a stronger join: conversation directory plus
child `agentId`, optional `parentAgentId`, and `toolUseId`. Keep these sidecars
with the transcripts. Anthropic documents the transcript and metadata paths,
and notes that a resumed subagent retains its ID; a finished child file must
not be assumed immutable. See
[subagent persistence](https://code.claude.com/docs/en/sub-agents#resume-subagents).

## Session changes and historical uncertainty

Paseo's rewind path calls the Claude SDK's `forkSession` and rebinds the same
Paseo agent to the resulting Claude session. Rewinding before an answered turn
can instead create a fresh session ID. It also accepts a changed native ID
announced by Claude during execution. Sources: package
`agent/providers/claude/rewind.js:5`,
`agent/providers/claude/agent.js:2238`, `:2394`, `:2424`, and `:3804`.

The current persistence record contains one session ID, not an array of past
IDs. Record updates replace the stored JSON atomically
(`agent/agent-storage.js:142`). Session-change notices enter an in-memory
timeline (`agent/agent-timeline-store.js:7`); the current record is not a
durable session-history journal.

A collector that snapshots metadata every minute can retain the mappings it
observes, but can miss an intermediate session created and replaced between
scans. This spike does not prove a complete historical rebind mapping. Collect
the underlying files anyway and label missing associations as unknown. If
complete mapping through rewinds becomes a requirement, validate durable
change capture or another recorded relationship source before promising it.

## Evidence available for later analysis

The inspected JSONL records included user and assistant messages, tool calls
and results, thinking blocks, attachments, system events, file-history events,
PR links, and usage/cost state. Parsing only user/assistant text would discard
evidence relevant to the agreed scope. The archive should retain unfamiliar
record types even if the first reader cannot render them specially.

There were 6,198 tool-use blocks and 6,197 tool-result blocks across the sample.
Their unequal counts are not by themselves proof of a failure; an unfinished
or interrupted call can lack a result. Eighteen records explicitly referenced
saved tool output through `toolUseResult.persistedOutputPath`, reinforcing the
need to preserve associated files instead of only transcript JSONL.

All 12,161 assistant records had usage objects, including input, output,
cache-read, and cache-creation token fields. They represented only 6,092 unique
`message.id` values; 4,496 IDs appeared in more than one record, with up to eight
records for one ID. There were no repeated record UUIDs among these usage
records. Summing usage once per JSONL row would therefore treat multiple
records from the same API message as separate messages. Preserve the records;
the eventual analytics layer must establish aggregation semantics.

Seventy-two `cost-state` records across 58 files carried numeric
`totalCostUSD`, alongside duration and model-usage fields. They are available
evidence, not proof that summing them produces a valid total. This spike does
not calculate or publish the user's costs.

Anthropic explicitly describes the JSONL entry format as internal and subject
to change. Preserve original evidence and version-aware interpretation
separately; fixtures from this local sample do not prove compatibility with
every Claude release. See
[transcript storage](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored).

## Discovery boundary and file history

The local inventory found these artifacts:

| Artifact | Files | Bytes |
| --- | ---: | ---: |
| Main transcripts under projects | 62 | 84,323,936 |
| Subagent transcripts | 87 | 57,793,601 |
| Subagent metadata sidecars | 87 | 16,376 |
| Saved tool outputs | 67 | 8,998,841 |
| File-history backups outside projects | 128 | 1,483,352 |
| Paste-cache files outside projects | 3 | 4,640 |
| Total collected in the local experiment | 434 | 152,620,746 |

Collecting only `projects/` would miss relevant evidence. The transcripts
contained 469 `file-history-snapshot` records and 54 `file-history-delta`
records. Backup metadata includes `backupFileName`, version, backup time, and
parent-directory information. The 284 non-null backup references resolve to
128 unique `(sessionId, backupFileName)` pairs at
`file-history/<session-id>/<backupFileName>`. All 128 files existed, accounting
for the entire local backup set. Include those backups in the evidence archive.
The paste-cache files were preserved too, but this spike did not establish
their conversation associations.

The project trees also contained 64 memory Markdown files; these were outside
the transcript-artifact experiment. Transient session keys, credential stores,
and shell environment snapshots were not read or copied. Settings inspection
was limited to retention and relevant transcript environment options; settings
were not archived. Plan, task, and debug directories were absent in this sample. The harness
therefore proves a specific observed collection boundary, not exhaustive
coverage of every optional artifact in every Claude configuration.

No `cleanupPeriodDays` override was present in the inspected user settings.
Existing files alone do not establish a guaranteed retention period or explain
the 85 missing Paseo transcripts. Backfill must inventory what is available,
and collection must run before local deletion makes evidence unrecoverable.

## Copying experiments

The [research harness](worker-log-collection-spike.py) implements a local,
content-addressed archive of whole-file revisions as a correctness baseline.
It is not a production collector or a shipped `fffactory` command.

It opens regular source files without following a final-component symlink,
reads at most 64 KiB per chunk into a staged copy, and checks device/inode,
size, modification time, and change time before and after copying. It also
checks that the source path still identifies that same file. A detected
mutation discards the candidate and leaves the last successful checkpoint
unchanged. A complete staged copy is published by its content hash before
the source-to-revision manifest advances. Repeated content reuses the object.

| Experiment | Result |
| --- | --- |
| Ordinary copy and repeat | Exact bytes retained; unchanged source adds no revision |
| Append during streaming read | Candidate rejected; subsequent stable copy captures appended content |
| Truncation during streaming read | Candidate rejected; shorter replacement captured later and old revision retained |
| Same-length rewrite | Change detected despite unchanged size |
| Atomic path replacement | Inode/path change detected; replacement captured on retry |
| Incomplete final JSONL record | Raw tail retained; indexing waits for a newline before treating it as a record |
| Malformed complete JSONL record | Counted separately; later valid records remain readable |
| Failure before object publication | No checkpoint advances; retry succeeds |
| Failure after object publication or before manifest publication | Existing object reused after restart; retry commits one logical revision |
| Source deletion | Earlier archived content remains available |
| Source symlink | Final-component symlink refused |
| Synthetic dispatched agents and session changes | Attempts remain distinct under one epic; observed replacement conversations stay under their attempt |
| Multiple candidate paths or missing metadata | Candidates retained without guessing from cwd; unmatched evidence remains explicit |
| Nested subagents | Sidecar parent/tool references preserve nesting; missing sidecar ancestry remains unknown |
| Discovery exclusions | Session artifacts, backups, and pastes included; memory, keys, and environment files excluded |

Mutation cases deliberately change synthetic source files after the first
streaming read, so they exercise the copy race deterministically. Local source
files were only read: no actual mutation happened during either observed scan.
This proves detection and retry under the injected races, not a claim that
the real sample happened to exercise concurrent writes.

The final local run copied, verified, and individually compressed all 434
artifacts in 3.247 seconds on the operator's Mac. The combined zlib output was
51,579,702 bytes, about 34% of the original size. The second pass, using a
reloaded manifest, found 434 unchanged files and no new revisions. The largest
individual source was 26,257,143 bytes. These measurements demonstrate local
feasibility; they are not worker CPU, network, S3 throughput, or upload-cost
measurements.

### Reproduce

The default run creates its synthetic fixtures in a private temporary
directory. It reads no home directory, factory, AWS account, or credentials:

```sh
python3 docs/research/worker-log-collection-spike.py
```

Explicitly opt into the local source experiment with:

```sh
python3 docs/research/worker-log-collection-spike.py --local-claude-root "$HOME/.claude"
```

The second command reads the selected root's projects, file-history, and
paste-cache artifacts. It stages private copies locally, prints aggregates
only, and removes its scratch directory on normal completion or a handled
exception. An uncatchable process termination can leave the private temporary
directory behind. It sends nothing to S3 or another service. The reported
grouping survey above is a separate read-only inspection; the harness's
grouping fixtures are synthetic, not copies of private conversations.

## Implementation consequences and remaining checks

The spike supports moving to the archive and collector specs with these
requirements:

1. **Keep source evidence and interpretation separate.** Preserve unknown
   record types, complete sidecars, saved outputs, referenced file-history,
   and unassociated artifacts. Index partial or malformed records without
   discarding the raw evidence.
2. **Archive relationships independently.** Project selected Paseo identity,
   dispatch, workspace, and lifecycle fields rather than copying arbitrary
   provider configuration. Preserve observations of session mappings over time.
3. **Treat every captured version as evidence.** Rewrites, truncation, and
   deletion must not erase an earlier successful capture. A publication retry
   must not advance its checkpoint before data is safely stored.
4. **Keep uncertainty visible.** Missing labels, missing source files, absent
   sidecars, and missed intermediate mappings need explicit representations.
   They must not be converted into invented epic or parent relationships.

The following remain unproven and must stay explicit in the implementation
work:

- Validate factory dispatch labels and artifacts produced by Claude Code
  `2.1.302` on the intended release. The remote follow-up establishes real epic,
  session, and subagent relationships, but its factory release was `0.0.3`,
  its sampled transcripts record Claude `2.1.280`, and expected factory labels
  were absent.
- Decide whether observed mapping history is sufficient for the first release.
  Minute-by-minute polling cannot recover every intermediate rebind or a file
  created and deleted entirely between scans. Complete capture would require
  an additional validated durable source of those events.
- Refine discovery for optional plans, tasks, debug artifacts, and rotated
  files using fixtures from the deployed version. Establish paste association
  where possible, and keep unmatched pastes independently recoverable.
- Resolve continuously changing large files: this conservative copier can
  repeatedly defer a hot file. It does not prove a one-minute freshness bound.
  Validate a stable-prefix or chunk strategy if bounded retry cannot meet the
  target, while still detecting rewrites.
- Choose the efficient production layout. Whole-file revisions can duplicate
  large growing transcripts; the harness also rereads and stages unchanged
  sources. Compression helps but does not settle incremental transfer,
  backpressure, retry quotas, or storage growth.
- Implement rooted path containment and full symlink-race handling, limits,
  supported file types, and source-access failures. Final-component no-follow
  plus a controlled local source tree is not a complete security boundary.
- Exercise real S3 publication/checkpoint recovery, object verification,
  IAM, and service lifecycle separately. Local exceptions and atomic renames
  do not prove network recovery or durability through power loss.
- Define handling of accidentally embedded secrets before production archive
  ingestion. This spike neither scans nor certifies provider content as
  secret-free, and it does not copy credential files or private samples into
  the repository.

## Follow-up on a real v2 worker

The operator authorized access to the existing remote worker. Paseo's desktop
client identified `fff-r29c2un6-builder-1`, matching the local v2 Acceptance
factory configuration. AWS STS confirmed that the `factory` profile belonged
to that configuration's expected account. The installed `fffactory` executable
and selected configuration both pinned release `0.0.3`.

The shipped `fffactory status` command reached the running, online worker and
reported that release. It also reported unresolved repository synchronization
and a `repository_sync` dispatch blocker; those were left unchanged. This is
the observed readiness report, not a diagnosis of the historical launches.

Plain SSH with strict checking lacked a saved host key. The file survey used
Tailscale SSH's authenticated host-key handling instead; it did not disable
host-key verification. A Python program was passed over stdin and executed as
the worker's `factory` user. It read metadata and transcript records, emitted
aggregate counts and work references, and wrote no remote files. SSM was not
needed, and no collector was installed.

| Worker observation | Result |
| --- | ---: |
| Persisted Paseo agents | 208 |
| Claude agent records | 207 |
| Main Claude transcripts | 207 |
| Subagent transcripts | 361 |
| Subagent metadata sidecars | 361 |
| Saved tool output files | 310 |
| Agent records with schedule labels | 190 |
| Agent records with expected factory-dispatch labels | 0 |

The populated label keys were `paseo.schedule-id` and `paseo.schedule-run`.
None of the saved records carried the proposed join's `factory-dispatch`,
`factory-repository`, `factory-epic`, or `factory-dispatched-at` labels. The
presence of scheduled agents does not itself establish which agent launched
an epic. This survey did not diagnose why the factory labels were absent or
establish the launch mechanism of each historical epic.

The five most recently modified transcripts with a matching Paseo agent were
inspected in detail. Each had exactly one matching path, agreed with the native
persistence handle, and had no session-ID mismatch, malformed record, or
detected mutation during the read. Their recorded work-epic commands identified
epics 94, 98, 86, 71, and 73; four Paseo titles also contained their epic number.
An epic number still needs repository context to identify work uniquely.

Claude recorded these invocations in structured slash-command text, containing
`<command-name>/fff:work-epic</command-name>` and a `<command-args>` element.
A parser restricted to user text beginning with `/fff:work-epic` would miss
these real invocations. Recorded command evidence can support a historical
association, but must be labeled by that provenance rather than passed off
as a factory dispatch label or proof of an automatic launch.

For `fffactory-verification` epic 98, the workspace path, Paseo title, and
recorded command agreed. The native session join resolved to a 1,556,723-byte
transcript with 381 records and 27 subagent transcripts. All 27 sidecars'
`toolUseId` values matched parent tool calls, and every child session/agent ID
matched its containing path. Paseo's desktop client independently showed the
same 27 subagents and visible implementation, review, and correction activity.

Across the five inspected attempts, all 105 subagents had sidecars and valid
immediate-parent tool-call joins, including one nested child. Their main and
child records reported Claude version `2.1.280`; this does not validate the
repository's newer `2.1.302` pin. Epic 98 also had 91 usage-bearing assistant
records but only 49 unique message IDs, confirming that repeated usage records
are present in worker data as well as the local sample.

This follow-up proves access to real worker evidence and useful epic/session/
subagent grouping. It strengthens the requirement to preserve work-association
provenance and handle missing labels. It does not prove complete historical
dispatch attribution, session-rebind history, remote archive copying, or the
future S3 collection pipeline.
