# Decisions: status-snapshot

✓ Fate of #151 and #152
   Chose: close both as not planned, pointing at this plan.
   Rationale: a registry and Paseo plugin are a lot of surface for a read-only view. A snapshot rendered
   from `status --json` gets the same picture with no second source of truth. The configuration chat
   (#152) can come back later on top of the snapshot.
   Rejected alternatives:
     - keep #151 and build the Paseo browser: second registry, plugin packaging, daemon-side directory browsing
     - close #151, rewrite #152 to bind to one --instance path: still Paseo plugin work, not needed now

✓ Target UI
   Chose: #154's self-contained HTML page rendered by the CLI, with `status --json` as the contract behind it.
   Rationale: one renderer we own and test against fixtures. An external UI can read the same JSON later at no extra cost.
   Rejected alternatives:
     - JSON contract only, UI built elsewhere: no UI ships, and the contract goes untested by a real consumer

✓ Snapshot time
   Chose: add a top-level `observed_at` (ISO 8601 UTC) to the status report. Additive; schema version 2 stays.
   Rationale: the "as of" time must come from the CLI so JSON and HTML agree. The renderer must not invent it.
   Rejected alternatives:
     - renderer stamps its own time: JSON consumers can't tell when the report was taken

✓ Scope: factories per snapshot
   Chose: one factory per snapshot, selected with --instance as today.
   Rationale: no registry needed. Several factories means several runs.
   Rejected alternatives:
     - multi-factory page: brings back a registry like #151's

✓ Issues
   Chose: reuse #153 (agent work) and #154 (HTML), tightened into dispatch-ready specs at capture. `observed_at` gets
   its own small issue that can ship alongside #153.
   Re-examined 2026-11-18: it shares the schema, fixture and status spec with #153, so it runs one after the other
   with #153, not in parallel. User confirmed a separate issue anyway.
   Rejected alternatives:
     - fold observed_at into #153: widens #153's scope beyond agent labels
     - fold observed_at into #154: one PR would touch both the contract and the renderer
     - capture fresh issues: duplicates #153 and #154

✓ observed_at semantics
   Chose: the start of inspection: the moment status begins reading the inventories (Order step 4), after
   validation and the account check.
   Rationale (user's call): "as of" marks when observation began. Every fact in the report was observed at or after it.
   Rejected alternatives:
     - when the report is assembled, after every observation

✓ Human layout for named agents (#153)
   Chose: keep the `Agents:` count line. Below it, one line per agent that is working, needs input or failed, in that
   state order, e.g. `api #212 working, dispatched 3h 04m ago`. Agents not launched by dispatch are named by ID.
   Finished and stopped agents are counts only.
   Rejected alternatives:
     - name every agent: finished agents pile up on long-lived workers

✓ Which agents the page lists (#154)
   Chose: the same rule as the human report. List working, then needs input, then failed. Finished and stopped are
   a count per worker.
   Rationale: one rule, so the terminal and the page never disagree.
   Rejected alternatives:
     - also list finished agents dispatched within 24h of observed_at: a second rule to spec and test

✓ --html with --json
   Chose: one output format at a time. Both together is an invalid argument and exits 1.
   Rejected alternatives:
     - one silently wins

✓ Links from the page
   Chose: no links in this plan. The page will link to a different target once that exists (user's call), not GitHub.
   Marker: `TODO(re-evaluate when <link target> is up): link agents and epics` in status-page.ts.
   Rejected alternatives:
     - GitHub epic URLs: need repository owner and name, which status never prints

✓ UI prototype
   Chose: the user's "Factory Floor.html" artifact (exported 2026-11-18) is the visual prototype for #154.
   Committed as docs/roadmap/status-snapshot/prototype.html. Design reference only, not code to reuse (see differences in plan.md).

✓ Fonts
   Chose: drop the Google Fonts request and use the fallback faces in the stack ("Helvetica Neue", Arial, sans-serif;
   ui-monospace for mono).
   Rationale: the page makes no network requests and stays small. The look stays close to the prototype.
   Rejected alternatives:
     - embed IBM Plex (base64 woff2): about 150 KB more per page, and the fonts' licence ships with every page
     - keep the Google Fonts link: breaks offline reading and the no-network rule

✓ Where the prototype lives
   Chose: at plan-capture, commit it to docs/roadmap/status-snapshot/prototype.html and link it from #154.
   Rationale: the plan directory in /tmp doesn't last. The agent implementing #154 needs the file in the repo.
   Rejected alternatives:
     - attach to #154: GitHub doesn't accept .html attachments, so it would need a zip or a gist

## Amended at breakdown (2026-11-18)

✓ Where an agent's repository, epic and dispatch time come from
   Chose: a launch record written by the dispatcher. #153's "read the labels in the adapter" is not possible.
   Evidence: Paseo 0.15.0 (pinned) and 0.16.2 (latest), checked in the package source: `ls --json` only filters by an
   exact `--label key=value` and never prints label values, and `agent inspect --json` shows only Paseo's own
   `paseo.worktree` and parent labels. docs/specs/execution-backend.md §Inspect says the same ("Paseo's list prints
   no label"). The dispatcher persists nothing per launch today; its summary is only printed.
   Rejected alternatives:
     - one label-filtered `ls` per placed repository: gives the repository only, never the epic or dispatch time
     - parse `dispatch/epic-N-STAMP` from `agent inspect`'s worktree: inspects every agent, still no repository,
       and couples fffactory to Paseo's worktree naming
     - wait for Paseo to print labels: neither version does. Recorded as the record's retirement trigger.
   Marker: `TODO(re-evaluate when the pinned Paseo's ls --json prints labels): read the launch identity from the
   backend and retire the launch record`.

✓ Launch record format
   Chose: one JSON document, written to a temporary file in the same directory and renamed into place.
   Rationale: the reader is root (`host control-plane activity`) and the file lives in `factory`'s space, which coding
   agents control. A JSON file reads through the guarded-descriptor pattern the repo already uses (no symlinks, a
   regular file, a bounded size), and is never seen half-written.
   Rejected alternatives:
     - SQLite via bun:sqlite (built into the executable): opening by path skips the descriptor guards; root can leave
       root-owned -journal/-wal/-shm files in `factory`'s directory; a read without the dispatch lock can see a
       half-written database. Its query strength serves launch history, which is not this record's job.

✓ Launch history
   Chose: not kept. The record holds only agents Paseo still lists. History belongs to the log archive's Phase 4
   (Relationships, docs/roadmap/worker-log-archive/roadmap.md), which groups attempts by repository and epic.
   Transcripts (the dispatch summary, each agent's `/fff:work-epic N`) already reach the archive when it's enabled,
   but status may not read them: they're agent-written text, collected only for Claude Code, and not structured
   until the Phase 3 reader.
   Note for Phase 4: it assumes the collector can record Paseo labels. It can't, for the same reason. The launch
   record is a candidate source.

✓ Pruning
   Chose: the dispatcher prunes during its normal tick, under the dispatch lock, from the list of every run it
   already reads for capacity (no extra Paseo call). It drops an entry only when Paseo no longer lists that agent
   AND it was dispatched more than 1 hour ago. Then it appends an entry for each successful `startRun`, and writes
   the record by temporary file and rename.
   - An agent Paseo still lists keeps its entry, whatever its age or state: an 8-hour run, or a finished one, keeps it.
   - The hour of grace only protects an entry whose agent Paseo hasn't listed yet.
   - Runs unreadable: the tick already fails, and nothing is pruned.
   - Dispatch stopped: no ticks, so no pruning and no new entries. Stale entries are never shown, because the
     reader joins by agent ID against the current runs.
   - The reader (root) never writes or prunes. An oversized or malformed record makes every agent's three fields
     null, never the agents unreadable.
   Rejected alternatives:
     - prune by age alone: drops long runs that are still going
     - keep every entry: unbounded growth on a long-lived worker

✓ Record write fails after a launch
   Chose: the launch stands, and the tick summary reports that the record could not be written. The tick does not
   fail because of it. Status shows null for that agent.
   Rationale: the agent is already running. Failing the tick risks the next one launching the epic again if the
   duplicate check can't see the first run yet.
   Rejected alternatives:
     - fail the tick: risks a repeated launch

✓ How an agent's repository is shown
   Chose: as GitHub's `OWNER/NAME`, and a dispatched agent as `OWNER/NAME#EPIC`. The worker reports the repository key;
   the CLI maps it through its own factory.json (`repositories[key].remote`). A key factory.json no longer declares
   shows the key alone. JSON keeps `repository` (key) and adds `repository_name` (`OWNER/NAME` or null).
   Rationale: a key is a local alias, so an epic number beside it is meaningless. `OWNER/NAME#N` is GitHub's
   cross-repository reference form and the natural link target later. The CLI builds what it prints from its own
   factory.json, never worker text.
   Rejected alternatives:
     - show the key only (the prototype's "api #212"): the number means nothing outside the factory
     - store the remote in the launch record: puts configuration in a file agents control, which the CLI must check anyway
   Marker: `TODO(re-evaluate when per-project FFFlow status exists): link each agent's repository and epic to it`.

✓ status may print a repository's OWNER/NAME
   Chose: widen status.md §What status never prints and src/CLAUDE.md's never-echo rule: "a repository's
   `OWNER/NAME` from a remote that passed its format check". Lands in task 2.
   Rationale: the remote's pattern admits the same characters as a key, which status already prints. The branch and
   the checkout path are still never printed.
   Rejected alternatives:
     - keep the rule as is: the view can't name repositories

✓ Agents not launched by dispatch (ad hoc and planning sessions)
   Chose: every agent's repository comes from its working directory. The Paseo adapter matches each agent's `cwd`
   (in the `ls --json` it already reads) to a placed checkout, or to one of that checkout's worktrees (one
   `paseo worktree ls --cwd <checkout> --json` per placed checkout). The run carries the placed checkout it works
   in, which says nothing Paseo-specific. The endpoint maps that to a key through the host's manifest. A dispatched
   agent's repository comes from the launch record first, and its workspace as fallback. Only the record gives an
   epic and a dispatch time. No path is ever printed.
   Rejected alternatives:
     - show ad hoc agents by ID only: the repository view can't place them
     - read the epic from the worktree's `dispatch/epic-N-STAMP` branch instead of a record: the agent may move off it
     - workspace first for dispatched agents: the record is the dispatcher's own launch identity

✓ Agent categories
   Chose: two categories everywhere agents are listed: **Dispatched** and **Ad hoc** (anything dispatch didn't
   launch, in a placed repository or not). Within each: working, then needs input, then failed. Finished and
   stopped are counts. A dispatched agent is `OWNER/NAME#EPIC`. An ad hoc agent is `OWNER/NAME`, or its agent ID
   outside the placed repositories, with its ID as secondary text either way, for reconnecting.
   Rejected alternatives:
     - a third "outside the placed repositories" category: user chose two for now

✓ Repository view
   Chose: the status JSON gains a top-level `repositories` section: each repository factory.json declares, in its
   order, with `key`, `name` (`OWNER/NAME`) and `placements` (each worker it's placed on, with that worker's verdict
   and repository state). Agents stay under workers, so each fact appears once; renderers group them by repository.
   The HTML page shows Needs you, then Workers, then Repositories, stacked on one page. A repository panel shows its
   placements, its agents across all workers in the two categories, and its entries from Needs you. The terminal
   report stays worker-centric.
   Rationale: no new worker calls, no script, and the page prints and archives as one snapshot.
   Rejected alternatives:
     - a CSS-only toggle between the views: more machinery, and a printed page shows only one view
     - a `Repositories:` section in the terminal report: --html is the at-a-glance surface
     - copy agents under repositories in the JSON: the same fact twice

✓ Per-checkout repository state
   Chose: out of this plan. The worker reports one repository state for all its checkouts (#104 is open). A panel
   shows the worker's state as it is ("synchronized on builder-1", "builder-2: repositories unresolved").
   Marker: `TODO(re-evaluate when #104 reports per-checkout state): show each checkout's own state`.

✓ Page design iteration
   Chose: the prototype is not updated now. The layout, including the repository view, is iterated in a separate
   design spike, opened as a follow-up issue at capture. It doesn't block task 4.
   Rejected alternatives:
     - add a Repositories section to prototype.html now: user prefers a design spike

✓ Breakdown
   Chose: six tasks. A new launch-record issue; #153 rescoped to read the record; a new observed_at issue; #154;
   a new task for each agent's repository from its workspace; a new task for the report's repositories section.
