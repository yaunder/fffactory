# Worker log archive: relationships validation

Date: 2026-10-26. Phase 0 of the worker-log-archive roadmap. This answers the
relationship item of the
[design's validation list](../designs/worker-log-archive.md#validation-required-before-implementation)
(item 3), following on from the
[collection and grouping spike](worker-log-collection-spike.md#epic-and-attempt-mapping).

Sources:

- The published `@getpaseo/server@0.13.2` package. Epic #94 pins this version
  (#97). Paths below are relative to `dist/server/server/`.
- `assets/steps/dispatch/`.
- The repository specs.
- An authorized read-only inspection of the v2 worker
  `fff-r29c2un6-builder-1`.

No identifier values are recorded here.

## Verdict

**What holds:**
- The epic → attempt → conversation join still works in Paseo `0.13.2`.
- Labels persist on the agent record.
- `persistence.sessionId` still holds the Claude session ID.

**What doesn't:**
- Paseo keeps no durable history of session changes, so periodic observation
  remains the only source for rebinds.
- The factory dispatch labels have never been produced on a real worker:
  dispatch never launched an agent there.
- The label route therefore stays unverified until a release with working
  dispatch runs on a worker.

## 1. Paseo `0.13.2` agent records (established)

The stored agent schema (`agent/agent-storage.js:28-68`) holds:

- `id`, `provider` and `cwd`, plus an optional `workspaceId`.
- Timestamps: `createdAt`, `updatedAt`, `lastActivityAt` and
  `lastUserMessageAt`.
- `labels`: a string map, `{}` by default.
- `lastStatus`.
- `runtimeInfo.sessionId`.
- `persistence`, which is `{provider, sessionId, nativeHandle?, metadata?}`.
- `archivedAt` and `owner`.
- `config`, which can hold system prompts and provider options. Project only
  the bounded fields above, as the earlier spike recommended.

Lookups match a Claude session on either `persistence.sessionId` or
`nativeHandle` (`agent/agent-storage.js:100-102`).

Archiving sets `archivedAt` and keeps the record (`agent/agent-archive.js:2-5`).

**Session changes.**
- Rewind still forks through the Claude SDK's `forkSession`
  (`agent/providers/claude/rewind.js:3-8,63`) and rebinds the same agent.
- The record still carries one current session ID.
- No persisted session-history field or store was found in `agent/`.

**Ephemeral helper runs.** Paseo deletes the transcripts of its ephemeral
helper runs that it starts with `persistSession: false`
(`agent/providers/claude/agent.js:2346-2359`). These are the metadata and
branch-name generators.

## 2. Why the worker had no dispatch labels (established)

The worker runs release 0.0.3 (Paseo `0.9.1`). It has 208 agent records:

- 190 carry only `paseo.schedule-id` and `paseo.schedule-run`, all from one
  schedule.
- None carries a `factory-*` label.

The schedule's runs (2026-10-14 to 10-16) each invoked `/dispatch`, which runs
`/usr/local/bin/factory-dispatch`. All 190 printed summaries reported
`started: 0`.

The 16 epic runs were started by hand with `/fff:work-epic`. Dispatch is now
pending on `repository_sync`, and no schedule is persisted.

So the absence of labels is not a Paseo storage problem: the labelling path
has simply never launched an agent.

The dispatch program writes no summary file. Its state lives in
`/var/lib/fffactory/dispatch.json` and `dispatch-result.json`.

## 3. Repository identity (established)

- A repository is declared with a `key`, an `https://github.com/OWNER/NAME`
  `remote`, a `path` and a `branch`
  ([instance configuration](../specs/instance-configuration.md),
  [repositories](../specs/repositories.md)).
- Dispatch labels carry the key (`factory-repository`).
- On the worker, each checkout has one `https://github.com/<owner>/<repo>.git`
  remote, and the synchronized set is recorded in
  `/var/lib/fffactory/repositories.json`.

**What survives a rename:**
- Renaming a key keeps the remote.
- Renaming or transferring the GitHub repository changes the remote.
- GitHub's stable node ID is recorded nowhere.

**Recommendation:** apply writes a snapshot mapping repository key → remote
into the archive's `factory/` prefix whenever it changes. Old keys then stay
interpretable.

## 4. Consequences for Phase 3

- **Sampling limits.** Sampled projections, taken each minute and only when
  changed, record the mappings they observe. They cannot see a session that is
  created and replaced between two samples.
- **No durable history source.** Paseo `0.13.2` offers none. Complete rebind
  history stays out of scope unless one appears.
- **Inferred associations.** Slash-command markup can back-fill the epics of
  hand-started runs, like the 16 found on the worker. Mark these inferred.
- **The label route.** It must be validated on the first worker that runs a
  release whose dispatch actually launches agents. Until then, epic grouping on
  real data comes only from inferred associations.
- **Gaps.** Agent records without a transcript, and transcripts without a
  record, stay visible as unassociated.

## Still unverified

- Whether Claude `2.1.302` transcripts record a fork's parent session, which
  would give a second relationship source.
- Whether the labels on agents launched by `factory-dispatch` persist on a
  worker running `0.13.2`.
