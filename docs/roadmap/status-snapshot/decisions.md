# Decisions: status-snapshot

Each decision says what we chose, why, and what we turned down.

## Made while planning (2026-11-18)

✓ #151 and #152
   Chose: close both as not planned, pointing to this plan.
   Why: a Paseo plugin with its own list of factories is a lot to build for a read-only view. A page drawn from
   `status --json` shows the same picture without a second list. The configuration chat (#152) can come back later,
   built on the snapshot.
   Turned down:
     - build the Paseo factory browser: a second list of factories, plugin packaging, folder browsing on the daemon
     - close #151 but rewrite #152 to use one `--instance` path: still Paseo plugin work we don't need yet

✓ What the UI is
   Chose: #154's HTML page, drawn by the CLI, with `status --json` as the data behind it.
   Why: one page we build and test against sample reports. Any other UI can read the same JSON later.
   Turned down:
     - only the JSON, with a UI built elsewhere: no UI would ship, and nothing real would test the JSON

✓ When the report was taken
   Chose: add `observed_at`, a UTC timestamp, to the top of the report. It only adds a field, so the version stays 2.
   Why: the "As of" time has to come from the CLI so the JSON and the page agree.
   Turned down:
     - let the page add its own time: anything reading the JSON couldn't tell when it was taken

✓ How many factories per page
   Chose: one, picked with `--instance` as today.
   Why: no list of factories needed. For several factories, run it once each.
   Turned down:
     - several factories on one page: brings back a list like #151's

✓ Which issues to use
   Chose: rewrite #153 and #154 rather than open copies. Open new issues for the other tasks, including
   `observed_at` on its own. `observed_at` edits the same files as #153, so the two are done one after the other.
   Turned down:
     - fold `observed_at` into #153: makes #153 about more than agents
     - fold `observed_at` into #154: one PR would change both the data and the page

✓ When `observed_at` is taken
   Chose: at the start of the checks, just before status reads EC2 and Tailscale, after factory.json and the AWS
   account have been checked. Everything in the report was seen at or after that time. (User's call.)
   Turned down:
     - when the report is finished

✓ `--html` and `--json` together
   Chose: one format at a time. Asking for both is an error and exits 1.
   Turned down:
     - let one quietly win

✓ The prototype
   Chose: the "Factory Floor.html" artifact the user exported is the prototype for the page. It's committed as
   `docs/roadmap/status-snapshot/prototype.html` and linked from #154. It's a design guide, not code to reuse.
   Turned down:
     - attach it to #154: GitHub doesn't accept .html attachments

✓ Fonts
   Chose: drop the prototype's Google Fonts link. Use fonts the computer already has (Helvetica Neue, Arial; a system
   monospace font).
   Why: the page loads nothing from the network and stays small. It looks close to the prototype.
   Turned down:
     - put IBM Plex inside the page: about 150 KB more per page, plus the font licence in every page
     - keep the Google Fonts link: the page wouldn't work offline

✓ Links
   Chose: no links for now. Later they'll point to each project's FFFlow status, not to GitHub.
   Marker in the code: `TODO(re-evaluate when per-project FFFlow status exists): link each repository and epic to it`.

## Made while breaking it into tasks (2026-11-18)

✓ Where each agent's repository, epic and start time come from
   Chose: dispatch writes them down when it starts each agent.
   Why: #153 planned to read the labels dispatch puts on each agent in Paseo. That can't work. We checked Paseo's
   source for 0.15.0 (pinned) and 0.16.2 (latest): `paseo ls --json` can filter by a label but never prints label
   values, and `paseo agent inspect --json` only shows Paseo's own labels. `docs/specs/execution-backend.md` says
   the same. Dispatch doesn't save anything per agent today; it only prints a summary.
   Turned down:
     - one filtered `ls` per repository: tells us the repository, never the epic or start time
     - read the epic from the worktree's branch name (`dispatch/epic-N-STAMP`): needs a call per agent, still no
       repository, ties us to Paseo's folder naming, and the agent may switch branches
     - wait for Paseo to print labels: neither version does
   Marker in the code: `TODO(re-evaluate when the pinned Paseo's ls --json prints labels): read the launch identity
   from the backend and retire the launch record`.

✓ What format the record uses
   Chose: one JSON file. It's written to a temporary file first, then renamed into place.
   Why: dispatch writes it as `factory`, but status reads it as root, and coding agents also run as `factory` and
   could change it. The repo already has a safe way for root to read a file like this (no symlinks, a regular file,
   a size limit). The rename means nobody ever reads a half-written file.
   Turned down:
     - SQLite (built into Bun, so available on workers): it opens files by path, which skips those safety checks; root
       could leave root-owned journal files that `factory` then can't write; reading while dispatch writes can see a
       half-finished database. Its strength is querying history, which this record doesn't keep.

✓ History
   Chose: the record doesn't keep history. It only covers agents Paseo still lists. History belongs to the log
   archive's Phase 4 (`docs/roadmap/worker-log-archive/roadmap.md`), which plans to group past attempts by repository
   and epic.
   Why not the logs for status: transcripts already reach the archive when it's on, but they're text agents wrote,
   only Claude Code sessions are collected, and nothing can query them until the Phase 3 reader exists. Status also
   never reads the archive.
   Note for Phase 4: it assumes the collector can record Paseo labels. It can't, for the same reason. This record
   could feed it instead.

✓ When entries are removed
   Chose: each dispatch run removes an entry only when Paseo no longer lists that agent AND it was started more than
   an hour ago. Dispatch uses the list of agents it already fetches for its capacity check, so there are no extra
   calls. It then adds an entry for each agent it starts, and writes the file.
   - An agent Paseo still lists keeps its entry, however old: an 8-hour run keeps it, and so does a finished one.
   - The hour only protects a new agent that Paseo hasn't listed yet.
   - If dispatch can't read the agents, the run already fails, and nothing is removed.
   - If dispatch is stopped, nothing is added or removed. Old entries do no harm, because they only show up when
     their agent does.
   - Status never writes or cleans the file. If the file is too big or broken, the agents are still listed, with
     their repository, epic and time empty.
   Turned down:
     - remove entries by age alone: would drop long runs that are still going
     - never remove entries: the file would keep growing

✓ If writing the record fails after an agent starts
   Chose: the agent keeps running. The dispatch summary says the record couldn't be written. The run doesn't fail.
   Status shows empty fields for that agent.
   Why: failing the run could lead the next run to start the same epic again.
   Turned down:
     - fail the run: risks starting the epic twice

✓ How a repository is shown
   Chose: by its GitHub `OWNER/NAME`, and a dispatched agent as `OWNER/NAME#EPIC`. The worker reports the repository
   key; the CLI looks up its remote in factory.json. If factory.json no longer has that key, the key is shown on its
   own. The JSON keeps `repository` (the key) and adds `repository_name`.
   Why: a key like `api` is a local nickname, so an epic number beside it means little. `OWNER/NAME#212` is how GitHub
   itself refers to an issue in another repository, and it's what we'll link later. The CLI already builds what it
   prints from its own factory.json, never from text a worker sent.
   Turned down:
     - show only the key (the prototype's "api #212"): the number means nothing outside the factory
     - have dispatch store the remote in the record: puts configuration in a file agents can change

✓ Status may print a repository's `OWNER/NAME`
   Chose: update "What status never prints" in `docs/specs/status.md`, and the matching rule in `src/CLAUDE.md`, to
   allow "a repository's `OWNER/NAME` from a remote that passed its format check". Done in task 2.
   Why: the remote's format allows the same characters as a repository key, which status already prints. The branch
   and the checkout path are still never printed.
   Turned down:
     - keep the rule: the page couldn't name repositories

✓ Agents dispatch didn't start (ad hoc and planning sessions)
   Chose: find every agent's repository from its working directory. Paseo's agent list includes each agent's `cwd`.
   The Paseo adapter matches it to a repository placed on the worker, or to one of that repository's worktrees (one
   `paseo worktree ls --cwd CHECKOUT --json` per repository). For dispatched agents, the record's repository wins and
   the working directory is the fallback. Only the record has an epic and a start time. No folder path is ever printed.
   Turned down:
     - show ad hoc agents by ID only: they couldn't appear under their repository
     - prefer the working directory for dispatched agents: the record is what dispatch actually started

✓ Groups of agents
   Chose: two groups wherever agents are listed: **Dispatched** and **Ad hoc**. Ad hoc means anything dispatch
   didn't start, in a placed repository or not. In each group: working first, then waiting for input, then failed.
   Finished and stopped agents are only counted. A dispatched agent shows as `OWNER/NAME#EPIC`. An ad hoc agent shows
   as `OWNER/NAME`, or its agent ID if it's outside the placed repositories, with the ID shown small either way so
   you can reconnect to it.
   Turned down:
     - a third group for agents outside the placed repositories: the user wanted two for now
     - list every agent, finished ones included: finished agents pile up on long-running workers

✓ Looking at the factory by repository
   Chose: `status --json` gains a `repositories` list: each repository in factory.json, in order, with its `key`,
   `name` (`OWNER/NAME`) and `placements` (each worker it's on, with that worker's verdict and repository state).
   Agents stay under workers, so nothing is stored twice; a view groups them by repository. The page stacks three
   sections: Needs you, Workers, Repositories. A repository panel shows where it's placed, its agents from every
   worker in the two groups, and its items from Needs you. The terminal report stays as it is, by worker.
   Why: no new calls to workers, no JavaScript, and the page prints and saves as one snapshot.
   Turned down:
     - a switch between the two views (CSS only): more to build, and a printed page shows only one view
     - a repositories section in the terminal: `--html` is the at-a-glance view
     - copy agents under each repository in the JSON: the same fact in two places

✓ Each checkout's sync state
   Chose: not in this plan. Workers report one repository state for all their checkouts (#104 is open). A repository
   panel shows each worker's state as reported ("synchronized on builder-1", "builder-2: repositories unresolved").
   Marker in the code: `TODO(re-evaluate when #104 reports per-checkout state): show each checkout's own state`.

✓ Refining the page design
   Chose: don't update the prototype now. Refine the layout, including the repository view, in a separate design
   spike, opened as a follow-up issue at capture. It doesn't hold up task 6.
   Turned down:
     - add a Repositories section to the prototype now: the user prefers a design spike

✓ Tasks
   Chose: six tasks.
   1. Dispatch keeps a record of the agents it starts. (new)
   2. Status shows which repository and epic each dispatched agent is on. (#153, rewritten)
   3. The status report records when it was taken. (new)
   4. Status shows the repository of every agent. (new)
   5. The status report lists the factory's repositories. (new)
   6. `status --html`. (#154, rewritten)
