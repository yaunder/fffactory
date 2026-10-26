# Paseo 0.11.4 → 0.12.0 → 0.13.2: agent activity, archive, schedules (research, 2026-10-26)

Builds on research-paseo.md (0.11.4 baseline); not repeated here.

## Sources

- `npm pack @getpaseo/{cli,server,client,protocol}` at 0.12.0 and 0.13.2 (each cli pins the same-version
  client/server/protocol exactly), unpacked in /tmp/paseo-research/v0.12.0 and /v0.13.2. 0.11.4 is at
  /tmp/paseo-research/{cli,server,client,protocol}. 0.13.0 cli+server also packed (/v0.13.0) to check 0.13.1/0.13.2.
- package.json has no `repository`/`engines` field in any version. The public repo is github.com/getpaseo/paseo
  (found via `gh`). Release notes: `gh release view v0.12.0|v0.13.0|v0.13.1|v0.13.2 -R getpaseo/paseo`
  (saved in /tmp/paseo-research/notes/rel-*.md). PRs read: #6033, #7535, #7573, #7668.
- Paths: `C11/C12/C13` = `{.,v0.12.0,v0.13.2}/cli/dist`, `S11/S12/S13` = `{.,v0.12.0,v0.13.2}/server/dist/server/server`,
  `P` = protocol/dist. All under /tmp/paseo-research.

Legend: **[C]** confirmed in code or release notes; **[I]** inferred.

## Summary table (A–D)

| | 0.11.4 | 0.12.0 | 0.13.2 |
|---|---|---|---|
| Statuses | initializing, running, idle, error, closed | same [C] (P/agent-lifecycle.js unchanged) | same [C] |
| `ls --json` row | id, shortId, name, provider, thinking, status, cwd, created (relative) | same [C] | same [C]: no labels, attention, pendingPermissions, timestamps or archived flag (C13/commands/agent/ls.js:70-82; upstream #7534 still open) |
| 200-row cap | silent truncation (C11/…/ls.js:134, one call) | fixed: CLI pages by created_at cursor (C12/…/ls.js:145-153; #6033) | fixed; `agent archive` also pages (C13/utils/agent-directory.js; #7535) |
| New ls scoping | – | `--background` flag; default ls now hides agents in *background workspaces*; `-a` now = archived + background + global (C12/…/ls.js:8-10,101-112) | same |
| "Is anything working / needs input" command | none | none (new: `paseo usage`) | none (new: `paseo host`) [C] (cli.js diffs) |
| `agent inspect --json` | Status, Archived, UpdatedAt, PendingPermissions… | byte-identical [C] | byte-identical [C] |
| `agent archive` / `workspace archive` | as baseline | unchanged semantics; workspace archive now also archives internal agents (S12/workspace-archive-service.js:255) | unchanged |
| Auto-archive settings | `daemon.autoArchiveAfterMerge` only | same | same key (S13/persisted-config.js:227); fires without an app watching (#7681) |
| Archive-on-finish for `run` | none in CLI | none | none [C]. Protocol `create_agent_request.autoArchive` exists in all three but CLI never sends it |
| Schedule CLI flags/JSON | baseline | byte-identical [C] | byte-identical [C] |
| Schedule run retention | none; `runs` grows forever | none; fixes: no double run (#6532), no stuck schedule after store failure (#6334) | none (service.js, store.js identical to 0.12) |
| Restart: running turns | killed, not resumed | same | same; PR #7573 lists auto-resume as a non-goal |
| Stale `running` after crash | possible [I] | possible [I] | normalised: startup writes `closed` for stored `running`/`initializing` (S13/bootstrap.js:684, 1484-1492; #7573) |

## A. Agent activity API

- **[C]** Status set unchanged (protocol agent-lifecycle.js not in either diff). Permission is still not a
  status. `requiresAttention` / `attentionReason` / `pendingPermissions` exist in the WS snapshot in every
  version, but the CLI's `toListItem` drops them (C13/commands/agent/ls.js:70-82, identical to C11:68-80).
- **[C]** Pagination: 0.12.0 loops `fetchAgents` with `sort created_at desc` and `page.limit 200` until
  `nextCursor` is null (C12/…/ls.js:145-153). 0.13 moves it to `fetchAllAgents` (C13/utils/agent-directory.js)
  and uses it in `agent archive` too (C13/commands/agent/archive.js:30). Label filters still run on the server.
- **[C]** New in 0.12: *background workspaces* (`workspace.background`, default false,
  S12/workspace-registry.js:95). `AgentDirectory.list` drops agents in background workspaces unless
  `includeBackground` (S12/agent/directory.js:6-23). A new workspace inherits `background` from the caller
  agent's workspace when not set explicitly (S12/session/workspace-provisioning/workspace-provisioning-service.js:118-127).
  `paseo run` now passes `callerAgentId` from `PASEO_AGENT_ID` (C12/commands/agent/run.js:404-409, utils/caller-agent.js).
- **[C]** No CLI status filter, no `paseo status`, no HTTP activity endpoint. `/api/status` returns only
  serverId/hostname/version/listen (S13/bootstrap.js:524-531). The MCP `list_agents` tool (agent-only) has a
  `statuses` filter and richer rows (labels, requiresAttention, updatedAt, archivedAt) in all three versions,
  max 200, 48 h archived window (S11/agent/tools/paseo-tools.js:1510-1550).
- **[C]** `agent inspect` unchanged (diff -q identical): the only CLI path to UpdatedAt, Archived and
  PendingPermissions (C11/commands/agent/inspect.js:90-101).

## B. Archive / lifecycle

- **[C]** `agent archive` (refuses running without `--force`, archives children, keeps worktree) is unchanged
  except paging. `workspace archive` (deletes a Paseo-owned worktree) is unchanged except it also archives internal
  agents in 0.12. Un-archive on send is unchanged (`unarchiveAgentState`, S13/agent/agent-prompt.js:116).
- **[C]** No age-based retention or archive-on-finish setting in any version; upstream closed the
  "idle runtime release" request as not planned (#7891, 2026-10-26). Idle agents keep their provider process
  until archived or the daemon restarts.
- **[C]** `autoArchive: true` on `create_agent_request` (P/messages.js:1415/1435) archives the agent and its
  auto-created worktree after the first `turn_completed|failed|canceled`
  (S11/agent/create-agent-lifecycle-dispatch.js:19-23,132-160). The CLI never sets it. **[I]** It is an
  in-memory subscription, so it is lost if the daemon restarts mid-turn.
- **[C]** 0.13.0 fixes merged-PR auto-archive missing updates while no app was watching (#7681).
- **[C]** Upstream open, relevant: #7856 (0.12.0) — workspaces whose folder was deleted outside Paseo are
  polled forever and starve the daemon. Archive through Paseo; never `git worktree remove` behind it.
  #6189: a schedule run is marked succeeded and archived while Claude background subagents still run.

## C. Schedules

- **[C]** `cli/dist/commands/schedule/*` and `server/schedule/store.js` are byte-identical across all three
  versions. Flags are as in C11/commands/schedule/index.js:16-63. No retention or prune flag or setting.
  Every run is appended (S13/schedule/service.js:623,635). `schedule inspect` still returns the full history.
- **[C]** 0.12 `service.js` changes: due slots are claimed atomically (`claimDueRun`), restart-failed runs
  can complete a maxRuns schedule (S12 service.js:474-479), and errors are typed (`ScheduleNotFoundError`).
  The new-agent target creates a non-background workspace and archives it in `finally` when `archiveOnFinish`
  is true (the default, internal config, not a CLI flag) (S12 service.js:755-830, S11 service.js:104-105).
- fffactory must still bound history itself (for example, recreate the schedule or trim the JSON while the daemon is stopped).

## D. Daemon restart

- **[C]** Shutdown still closes each agent with a 5 s timeout (S13/bootstrap.js:1499). Turns are not
  resumed in any version (#7573 non-goals).
- **[C]** 0.13.0+: `closeStaleAgentRecords` runs at startup before clients connect and rewrites
  `running`/`initializing` to `closed`. It keeps `requiresAttention`/`attentionReason` (PR #7573 test).
  It also stops waiting on Claude SDK interrupt/return during close, so the 5 s deadline no longer
  leaves the child process alive. In 0.11.4/0.12.0 a stale `running` persists until the agent is opened **[I]**.
- **[C]** 0.13.0: `notifyOnFinish` survives restart via new `~/.paseo/finish-subscriptions.json` (#7683).

## E. Compatibility

1. **[C]** `auth.js`, `local-credential.js` identical across versions; `resolveDaemonCredential` identical
   (URI password → `PASEO_PASSWORD` → local credential; C13/utils/client.js:125-138); `AUTH_FAILED` mapping kept
   (C13 client.js:27,39). `PASEO_AGENT_ID`/`PASEO_AGENT_CWD` injection identical (S13/agent/agent-manager.js:3808-3813).
   No hash → every client admitted (session-admission-auth.js). The only auth change: 0.13 removes the relay
   no-password bypass (S11/session-admission-auth.js:10-13; #7668). `daemon run` code unchanged (only `daemon pair` differs).
   CLI now connects via `createHostClient`/`parseHostTarget`; bare `host:port` still maps to ws (P13/host-target.js:45-51).
2. **[C]** `/api/health` exempt from auth (auth.js:84, all); Host allowlist 403 unchanged (S11 bootstrap.js:456,
   S13:465); `daemon.listen`, `daemon.hostnames`, `daemon.relay.enabled` keys unchanged. New optional
   `daemon.relay.requireProtectedSecurity` (S13/persisted-config.js:241, reloadable).
3. **[C]** JSON array shape unchanged. Behaviour change: background-workspace agents are hidden without `--background`.
   factory-dispatch pops `PASEO_AGENT_ID` before `paseo run` (assets/steps/dispatch/factory-dispatch:227), so its
   workspaces never inherit background. Schedule-run workspaces are not background. **[I]** The dispatcher is unaffected.
4. **[C]** `daemon reload` CLI unchanged; reloadable paths gain only the new relay key.
5. **[C]** Agent storage identical; workspace record gains `background` (optional, default false); schedule store
   identical; 0.13 adds `finish-subscriptions.json`. No migration code. **[I]** Downgrade is safe, because zod
   `z.object` strips unknown keys. No `engines`; third-party deps (node-pty 1.2.0-beta.15, etc.) identical, so Node 22 holds **[I]**.
6. **[C]** `run --background` became a hidden deprecated alias of `--no-wait` in 0.12. It prints a stderr warning
   (C12/C13 run.js:275) and is removed "after 2027-04-01" (run.js:19). 0.11.4 has no `--no-wait` (C11 run.js:17),
   so the flag switch must ship with the pin. The dispatcher reads only stdout, so the warning is harmless.
   `ls --global --label`, schedule ls/inspect/create/update/delete: identical.
7. **[C]** `features.dictation.enabled` / `features.voiceMode.enabled` keys unchanged (S13/persisted-config.js:302-303);
   speech code unchanged except OpenAI TTS voice/config.

## F. Other

- **[C]** Security (0.13.0, #7668): in 0.11.4/0.12.0 a relay client with no password is admitted as owner.
  fffactory sets `daemon.relay.enabled=false` (assets/steps/control-plane/paseo-config.sh:44), so **[I]** it is not exposed.
- **[C]** 0.12: memory fixes for the CLI/daemon (#6847, #6262, #7265); `paseo send` from an agent now steers
  instead of interrupting (#5164; 0.13 adds `--behavior`); `permit allow/deny` exit non-zero when unconfirmed.
- **[C]** 0.13.1 (startup crash with Show background, #7896) and 0.13.2 (Android) are app-only. The 0.13.0→0.13.2
  cli/server dist is identical apart from a builtin-plugins version string. 0.13 adds connected hosts (`paseo host add`, opt-in).
- **[C]** Open upstream issues filed against 0.13.0: #7962 git-scheduler slot leak can freeze the daemon;
  #7849 ACP agents lose injected Paseo tools (ACP only); #7845 archiving one agent kills turns of siblings
  sharing an ACP server; #7892 each restart leaves a `paseo-attachments-*` dir in /tmp (also 0.11.2).
  **[I]** None is shown to be new in 0.13, except #7849 (ACP only).

## Recommendation

Move to **0.13.2**, as a dedicated change.

What it gives:

- the 200-row truncation is fixed (0.12+).
- a crashed or killed daemon no longer leaves agents reading `running` forever (0.13 only). That matters directly
  for the removal gate and the "removable" report.
- the relay auth hole is closed.

It does not give:

- a richer `ls --json`.
- a status filter or activity endpoint.
- archive-on-finish.
- schedule retention.

fffactory must still build these itself: per-agent `inspect --json` or a small `@getpaseo/client` `fetchAgents`
reader, explicit archiving, and its own schedule-history bound.

Compatibility cost is small:

- swap `--background` for `--no-wait` together with the pin.
- pass `--background`/`-a` to `ls` wherever an agent-originated workspace might be counted.

0.12.0 gives only the pagination fix and carries the same compatibility deltas, so it is not worth a separate stop.
0.13.x is two days old: canary it on one worker first.
