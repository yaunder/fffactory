# Worker log archive and local reader

Status: scope approved on 2026-10-26; implementation pending. The requirements
below capture the agreed first milestone. Implementation choices and validation
work are identified separately. This design does not add shipped commands or
authorize factory operations; [AGENTS.md](../../AGENTS.md) continues to govern.

The [collection and grouping spike](../research/worker-log-collection-spike.md)
validates local file capture, agent/session joins, and nested subagent links.
A read-only v2 worker follow-up also validates real epic command and subagent
associations. It found factory dispatch labels absent on the observed release;
label coverage and compatibility with the pinned Claude version remain checks.

## First useful outcome

An operator can open a factory and see what its workers are doing and what
happened in earlier development runs. During an eight-hour build, the operator
can read recent conversations and tool activity, notice repeated corrections,
and use existing supervision controls to intervene.

The first milestone is collecting the logs and making them readable. Later,
those records can support evals of implementation quality, repeated fixes,
planning quality, and how much discovery the worker needed to do. The eval
definitions are deliberately open; collection must preserve evidence for
repeated analysis rather than select only the events needed by one metric.

## Agreed scope

- Harvest Claude Code's existing files on v2 workers. Do not require agents
  to generate a second transcript or add logging steps to their workflow.
- Collect all available historical sessions and all new sessions after
  deployment, including ongoing, failed, interrupted, and unassociated work.
- Preserve conversation records, subagent records, saved tool outputs, and
  available usage and cost metadata. Include subagent metadata sidecars and
  referenced file-history backups outside the project directories. Preserve
  associated evidence rather than collecting only the top-level transcript.
- Copy new and changed data roughly every minute while work runs. Collection
  must never block development.
- Store the archive in a dedicated S3 bucket, separate from factory state,
  with no automatic expiration. Retention can be changed deliberately later.
- Provide a browser reader through a new `fffactory logs` command, running
  locally for operators with authorized AWS access to the selected factory.
- Keep original collected evidence available independently of its index and
  rendering, so it can be processed again as analysis evolves.

This milestone does not implement evals, derived cost dashboards, automated
triage, a centralized hosted interface, or worker controls in the reader.
Operators continue to pause or course-correct through existing supervision.
It does not collect from or inspect frozen v1 hosts.

## Sources and existing behavior

The repository pins Claude Code in
[versions.env](../../assets/steps/versions.env) and Paseo in
[control-plane/versions.env](../../assets/steps/control-plane/versions.env).
The versions examined for this design were Claude Code `2.1.302` and Paseo
`0.11.4`. Deployed versions and settings still require validation through
supported v2 operations when implementation reaches that stage.

Claude documents continuously written transcripts under
`~/.claude/projects/<encoded-working-directory>/<session-id>.jsonl`.
`CLAUDE_CONFIG_DIR` can relocate the root. Associated session directories
contain subagent transcripts and saved tool results. The documented default
cleanup period is 30 days, configurable through `cleanupPeriodDays`.
These are current documentation facts, not a version-frozen storage contract.
See [session storage](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored),
[application data](https://code.claude.com/docs/en/claude-directory#application-data),
and [subagent persistence](https://code.claude.com/docs/en/sub-agents#resume-subagents).

Transcript files are not guaranteed to be append-only. For example, optional
local transcript garbage collection can rewrite history after compaction.
Persistence can also be disabled. The collector must establish the effective
settings and handle changes to existing files; copying only completed sessions
or assuming byte offsets never change is insufficient.
See [Claude environment variables](https://code.claude.com/docs/en/env-vars).

The worker runs Paseo as `factory`, with home `/home/factory` and
`PASEO_HOME=/home/factory/.paseo`; see the
[service definition](../../assets/steps/control-plane/paseo.service).
The root volume is deleted on worker termination; see the
[host module](../../assets/terraform/modules/hosts/main.tf).
Worker-local files therefore cannot serve as the durable archive.

Collection preserves available evidence. It cannot recover files already
deleted, transient sessions whose persistence was disabled, or content the
provider never wrote. Backfill must report what was discovered rather than
promise complete historical coverage.

## Relating logs to work

Use observed identifiers to provide useful grouping without requiring every
session to have an epic. The initial relationship is:

```text
factory
  worker incarnation
    repository and epic, when known
      execution attempt: one dispatched Paseo agent
        Claude conversation or conversations
          subagent records and associated files
```

The [dispatcher](../../assets/steps/dispatch/factory-dispatch) labels launched
agents with repository alias, epic number, and dispatch timestamp, and returns
their Paseo agent IDs. The examined Paseo `0.11.4` package persists agent labels,
working directory, workspace ID, and `persistence.sessionId`; its Claude
adapter uses the native Claude conversation ID for that session field.
This establishes a join from an epic to an agent and its transcript files.

One dispatched Paseo agent is one execution attempt. A later dispatch for the
same epic is another attempt. There is no separate durable "build" identifier
in current dispatch, so the reader must not invent one or treat individual
fixes within a conversation as new dispatched attempts.

An attempt may contain several Claude conversations. In the examined Paseo
adapter, rewinding can fork a conversation or start a fresh one while retaining
the Paseo agent ID. The adapter also handles replacement session IDs announced
by Claude. Ordinary resume reuses the existing native session ID; archiving
does not inherently create another. Subagent transcripts are separate from
replacement parent conversations.

Capture relationship changes as well as current metadata. A final snapshot
of a Paseo record may contain only its latest native session ID. Periodic
sampling alone must not be assumed to capture every intermediate association.
Session IDs may also resolve to a directory different from the agent's current
working directory after a resume.

Preserve source identifiers, provenance, and relevant versions. Include enough
worker identity to distinguish a replacement machine using the same host key,
and enough repository identity to interpret old aliases after configuration
changes. Preserve sessions whose relationships are missing. Any inferred
association must be distinguishable from an observed one, and lack of an epic
must never exclude a file from collection.

The worker follow-up found usable epic references in recorded slash-command
markup even where factory labels were absent. Preserve that association's
source separately from dispatch metadata. Titles or command text can help
backfill, but do not prove an automatic launch or replace validated dispatch
identifiers for new work.

## Collection and archive behavior

An independent background collector discovers existing evidence on startup
and continues discovering and copying changes. Small uploads during execution
support inspection without waiting for a run to finish. The roughly one-minute
interval is a normal-operation target, not a guarantee against outages or
sudden disk loss.

Retries must be safe and must not create duplicate logical sessions. Track
successful uploads and preserve earlier captured content when a source file
is rewritten or removed. Remote indexing can evolve without replacing the
stored source evidence. The exact object layout, snapshot or chunk strategy,
and indexing format remain implementation choices to validate.

Uploads and backfill must use bounded resources. A large history or an S3
outage must not exhaust worker disk, memory, or CPU, or starve collection of
current work. The collector does not delete Claude's source files. Durable
retry bookkeeping is allowed; generating a replacement development transcript
is unnecessary. Failed uploads should be retried while the source remains
available, with any known gaps reported honestly.

Collection failure must not pause an agent, disable dispatch, or require a
working browser client. Report collection failures and freshness separately
from execution state. A quiet transcript does not establish successful work,
and a stale upload does not establish an idle worker.

Use a dedicated archive bucket with no expiration of either current or retained
historical evidence. Worker replacement and ordinary factory teardown must
not silently delete the archive. The implementation must define how the retained
bucket remains discoverable and readable after factory infrastructure is gone.
This changes teardown's resource ownership contract and needs explicit coverage
in the eventual behavior specs.

Workers authenticate using AWS roles, with deliberate archive permissions;
do not distribute static S3 credentials. The current
[worker IAM module](../../assets/terraform/modules/host-identity/main.tf)
does not grant archive access. Operator access also needs explicit permission
documentation; existing AWS credentials alone do not guarantee access to the
new bucket.

Treat the evidence as private development data. Credential stores and raw
secret configuration are not collection sources. The repository's prohibition
on raw secrets in logs remains in force. Validation must address accidental
secret exposure within provider records without silently claiming both
unmodified capture and secret removal. Any necessary exclusions or
transformations must be explicit.

## Local reader

The agreed command shape is new functionality:

```sh
fffactory logs --instance PATH --profile NAME
```

Reuse normal factory selection and AWS credential resolution, including
refusing an invalid instance and checking the caller's expected AWS account.
The command starts a local server and opens a browser for that factory.
Bundle the reader in the release so operators need no separate application,
repository checkout, Node, or Bun installation.

AWS credentials stay in the local server process. The browser reads through
that process; the archive remains private. Bind the server to loopback and
validate local request access. Render captured text and tool output as
untrusted content, never as executable HTML or commands. Print the local URL
if opening a browser is unavailable.

The reader must support:

- Workers, latest successful collection, and visible stale or failed collection.
- Ongoing and historical attempts with repository and epic grouping where known.
- Conversations, subagent activity, and tool inputs and results, including
  access to associated saved outputs.
- Unassociated sessions and access to original archived files.
- Refreshing ongoing runs as uploads arrive, without starting or resuming an
  agent or requiring the worker to remain online to read archived evidence.

Recorded usage and cost fields remain available as evidence. A derived cost
model or aggregate dashboard is outside this milestone. Exact layout, filtering,
pagination, and rendering choices should be established using representative
files, including long runs and large tool outputs.

## Release integration

Provision storage and permissions, deliver collector configuration, install the
service, and package the reader through the normal `fffactory` release flow.
Configuration needs validated archive settings; the existing state bucket field
does not implicitly select a log destination.

Factory changes must use the pinned release, account checks, reviewed exact
plans, and factory-wide mutation lock. Release-pin changes use `fffactory
upgrade`. This design provides no route for ad hoc host installation or direct
Terraform changes.

Collector runtime health must not become a prerequisite for development
dispatch. Installation failures need a defined outcome within apply's existing
stage semantics; "collection never blocks work" must not become permission to
hide an unsuccessful installation. Maintenance must continue to protect active
agents. These interactions require validation before implementation is specified.

## Validation required before implementation

Use representative fixtures and the pinned provider packages to resolve:

1. **File discovery and coverage:** effective directories and retention,
   subagents, saved outputs, other associated evidence, permissions, disabled
   persistence, and already-missing historical files.
2. **Live copying and recovery:** partial JSONL records, concurrent writes,
   rewrites, resumes, interrupted uploads, collector restarts, deduplication,
   and bounded backfill during an ongoing run.
3. **Relationship history:** reliable capture of session changes, historical
   mappings, repository and worker identity, and clear handling of unmatched
   evidence. Validate the Paseo join against actual package behavior rather
   than relying solely on CLI output.
4. **Storage and permissions:** archive configuration, object layout, retained
   revisions, worker upload access, operator read access, and archive survival
   through worker removal and factory teardown.
5. **Reader behavior:** an ongoing long run, multiple attempts for an epic,
   subagent navigation, missing data, stale collection, large files, and safe
   rendering without provider execution.
6. **Lifecycle integration:** service installation and upgrade, visible
   collection failure without blocking development, and retirement behavior
   that accurately reports any unarchived data.

The implementation's automated checks must exercise fixtures and mocked
boundaries without reading an AWS account or factory state. Translate the
validated behavior into evergreen specs and tests together with implementation.

## Relationship to other work

[Issue 21](https://github.com/yaunder/factory/issues/21) proposed a broader
compound engineering loop with Paseo timelines as primary telemetry. This
milestone starts from Claude Code's existing files and adds collection and
inspection. It does not implement that loop or require a Paseo plugin.
Paseo metadata supplies associations; normalized events may be useful later.

The [portable execution discussion](portable-execution.md) separates work items,
attempts, and sessions. This design uses those distinctions with today's Paseo
dispatch and does not require a new execution backend. A future centralized
interface or processing service can consume the archive without changing the
first milestone's local operator experience.
