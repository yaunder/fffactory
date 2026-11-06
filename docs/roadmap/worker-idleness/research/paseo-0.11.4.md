# Paseo 0.11.4 agent lifecycle (research, 2026-10-26)

Source: `npm pack @getpaseo/{cli,server,client,protocol}@0.11.4` (unbundled tsc output), unpacked in
/tmp/paseo-research. S = server/dist/server/server.

- Statuses (protocol/dist/agent-lifecycle.js): `initializing`, `running`, `idle`, `error`, `closed`. Nothing else.
  - A finished turn (completed or cancelled) → `idle`, with `requiresAttention: true, attentionReason: "finished"`.
  - A pending permission is NOT a status. The agent stays `running` and gets `pendingPermissions` + `attentionReason: "permission"`.
    So factory-dispatch's `status in ("running", "permission")` never matches "permission". It still counts those agents because they are `running`.
  - `closed` = runtime closed (archived, daemon shutdown, provider retired).
- `paseo ls` = `paseo agent ls` (same handler).
  - Excludes archived agents unless `-a`. Without `-g` the scope is unarchived workspaces and projects, NOT the cwd. Even with `-g`, agents with no workspace and internal agents are dropped.
  - Label filters are exact key=value, AND-ed, applied on the server.
  - The server page limit is 200 and the CLI never paginates: rows past 200 are silently dropped.
  - JSON row: `id, shortId, name, provider, thinking, status, cwd, created` (relative text). No labels, pendingPermissions or timestamps.
    `paseo agent inspect --json` has Status, Archived, UpdatedAt, PendingPermissions.
- Archive.
  - `paseo agent archive <id>` refuses a `running` agent without `--force`. It archives the agent's children too.
    It keeps the workspace and the worktree.
  - `paseo workspace archive` archives the workspace's agents and DELETES a Paseo-owned worktree once nothing references it.
  - Sending a message to an archived agent un-archives it.
  - The only auto setting is `daemon.autoArchiveAfterMerge` (default off): it archives a Paseo-owned worktree workspace whose PR merged and that is clean. No age-based retention.
- Schedules with a `new-agent` target (the CLI default): each tick creates a workspace and agent labelled
  `paseo.schedule-id` / `paseo.schedule-run`, and archives the workspace in a `finally` (success or failure).
  Tick agents therefore do not accumulate in `ls`.
- `paseo run --background`: when its turn ends the agent goes `idle` and stays listed indefinitely.
- Daemon restart (SIGTERM).
  - Every live agent is closed, 5 s timeout each. A running turn is killed, not resumed.
  - After restart, persisted agents show `closed`, stay listed, and are resumable: a new message reloads them from provider persistence.
    So a restart loses only in-flight turns, not finished conversations.
  - A SIGKILL or a timed-out close can leave a stale stored `running` (inferred). That reads as active, the safe side.
- Protocol bucketing (agent-state-bucket.js): permission → needs_input, error → failed, running → running, else done.
