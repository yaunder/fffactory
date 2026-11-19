# Plan: status-snapshot

- Level: L1
- Stack: typescript
- Capture: github-issues

## Phase 1: The problem

Confirmed 2026-11-18.

**The problem.** You can't see the whole factory at a glance. `fffactory status` counts each worker's agents ("1
working, 2 finished") but doesn't say what they're working on. The report doesn't say when it was taken, and only the
terminal shows it.

#151 tried to fix this with a Paseo plugin and a list of factories kept on the operator's machine. That's a second
list of factories, Paseo plugin packaging and folder browsing on the Paseo daemon, all for a read-only view.

**What we'll do instead.** Close #151 and #152. Make `fffactory status --json` complete enough to draw any view of
one factory from it. Then draw the first view: a single HTML page (#154).

**What the report is missing today:**
1. What each agent is working on: its repository, its epic, and when it started (#153).
2. When the report was taken.
3. A list of the factory's repositories, so we can look at the factory by repository as well as by worker.
4. A page that shows it (#154).

**Not in scope:**
- Live updates or a web server.
- Buttons that change anything.
- More than one factory per page.
- Work that's waiting but hasn't been dispatched.
- Transcripts and history (#117).

## Phase 2: The approach

Confirmed 2026-11-18, and amended while breaking it into tasks.

`status --json` becomes the snapshot: one factory, one moment in time. Every view (the terminal, the HTML page, any
future UI) is drawn from that one report. Each change below only adds fields, so status keeps schema version 2 and
the host protocol keeps version 1.

### A. Which repository and epic each dispatched agent is on (tasks 1 and 2)

Dispatch tags each agent it starts with Paseo labels, but Paseo's command line never prints label values back (we
checked 0.15.0, which we pin, and 0.16.2, the latest). So dispatch will write down what it started:

- **Dispatch keeps a small JSON file** of the agents it started: agent ID, repository key, epic, and start time. It
  lives in `factory`'s state folder, next to dispatch's lock.
- **Each dispatch run removes entries** for agents Paseo no longer lists, once they're over an hour old. An agent
  that's still listed keeps its entry, however long it runs.
- **When status asks a worker for its agents,** the worker reads the file carefully (agents could tamper with it)
  and adds each agent's repository, epic and start time.
- **The CLI turns the repository key into its GitHub `OWNER/NAME`** using factory.json.

| Layer | Where | Change |
| --- | --- | --- |
| Domain | new `src/domain/launch-record.ts` | The file's format, checking it, the removal rule, matching entries to agents. |
| Worker | `src/host/dispatcher.ts` | Writes the file. |
| Worker | `src/host/control-plane.ts` | Reads it when asked for agents. |
| Domain | `src/domain/control-plane.ts` | Each agent gains `repository`, `epic`, `dispatched_at`. |
| CLI | `src/cli/presentation/agents.ts`, `status.ts`, `worker-inspect.ts` | `OWNER/NAME#EPIC`, and the two groups of agents. |

### B. When the report was taken (task 3)

The report gains `observed_at`, taken just before status starts its checks. The terminal header shows it, and
"started 3h ago" times are measured from it.

### C. The repository of every agent (task 4)

Agents dispatch didn't start ("ad hoc" agents, such as a planning session) aren't in dispatch's file. Every agent has
a working directory, so the Paseo adapter matches it to a repository placed on the worker, or to one of that
repository's Paseo worktrees. No folder path is ever printed.

### D. The factory's repositories (task 5)

`status --json` gains a `repositories` list: each repository in factory.json, its GitHub name, and the workers it's
placed on with their state. Agents stay under workers; a view groups them by repository.

### E. The HTML page (task 6)

`fffactory status --html` prints one self-contained page, with no JavaScript and nothing loaded from the network. It
has three sections, in this order:
- **Needs you**
- **Workers**
- **Repositories**

In every panel, agents are in two groups:
- **Dispatched:** shown as `OWNER/NAME#EPIC`.
- **Ad hoc:** shown as `OWNER/NAME`, or by agent ID.

Within each group: working agents first, then agents waiting for input, then failed agents. Finished and stopped
agents are only counted.

**Prototype:** [`prototype.html`](prototype.html), exported from the Factory Floor artifact. We keep its layout,
colours and state dots. The production page differs in these ways:
- **No JavaScript.** The prototype's Proposed/Today toggle and the dashed underline on new fields go.
- **No Google Fonts.** It uses fonts the computer already has.
- **Finished agents are counted,** not listed.
- **A Repositories section** is added. The layout gets refined later in a design spike.

## Phase 3: The path

Confirmed 2026-11-18. Amended to six tasks while breaking it down.

1. **Dispatch keeps a record of the agents it starts.** (new issue)
2. **Status shows which repository and epic each dispatched agent is on.** (#153, rewritten) Depends on 1.
3. **The status report records when it was taken.** (new issue)
4. **Status shows the repository of every agent, including ad hoc ones.** (new issue) Depends on 2.
5. **The status report lists the factory's repositories.** (new issue) Depends on 2.
6. **`status --html`.** (#154, rewritten) Depends on 2, 3, 4 and 5.

Tasks 2, 3, 4 and 5 all edit the status schema, fixture and spec, so do them one at a time. Each PR updates its own
specs.

Also done at capture:
- Close #151 and #152 as not planned, pointing to #154 and this plan.
- Link the prototype from #154.
- Open a design-spike issue for the page layout, including the repository view.
