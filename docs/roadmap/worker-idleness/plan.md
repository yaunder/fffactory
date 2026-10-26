# Plan: worker-idleness

Level: L1 · Stack: typescript · Capture: github-issues

## Phase 1: Problem

Confirmed by the user 2026-10-26.

fffactory decides whether a worker is busy in several places, and they disagree:

- **Removal gates** (`worker stop`, `worker terminate`, `teardown`) and **Paseo maintenance
  deferral** in apply/upgrade count every agent `paseo agent ls --json` lists, whatever its status
  (control-plane.md, `src/host/control-plane.ts` `activity()`). Nothing archives agents, so once
  dispatch has launched an epic agent, the worker is never idle again: teardown and terminate
  refuse it forever without `--force`, and maintenance is deferred forever (#92).
- **Dispatch capacity** (`factory-dispatch` `active_agents`) counts only `factory-dispatch=true`
  agents whose status is `running` or `permission`.
- **Dispatch dedupe** (`previously_dispatched`) treats any listed agent with the epic's labels as
  "already dispatched", so it relies on finished agents staying listed.
- A worker with no Paseo password never starts its daemon, so its activity is always `unknown`,
  and apply, dispatch and the removal gates all fail on it, while `validate` reports the document
  complete (#91).

And nobody outside the gate can see its verdict: no read-only command reports whether a worker
is idle or holds unpushed work, and the `worker-terminate` / `teardown` records do not say whether
`--force` skipped the gates or what they found. An unattended caller can only learn removability
by attempting a removal.

**Target.** One specified definition of an active agent, used by every place that asks; every
worker has a readable daemon (password required); a read-only removability verdict using the
same gates; and removal records that carry the gates' outcome.

**Evidence.** Paseo 0.11.4's lifecycle is in `research/paseo-0.11.4.md`. Statuses are `initializing`, `running`, `idle`, `error` and `closed`. A permission wait is `running`. A finished agent is `idle` and stays listed. Schedule tick agents are archived by Paseo. A restart loses only in-flight turns.

**Out of scope.** Bounding schedule run history (#74); upgrade wiring and unattended
upgrade (#11, #57); a saved plan staying fresh after `terminate --keep` (#39); dispatch pausing (the accepted race in worker-lifecycle §Gates); changing
what counts as unresolved work (the work gate is unchanged).

## Phase 2: Approach

fffactory owns the vocabulary; Paseo is translated only in the worker-side adapter (D3).
Every worker runs the new release and Paseo 0.13.2 (D2, D4, D8).

**fffactory's states (D5, D6).**
- Agent: `working`, `needs_input`, `finished`, `failed`, `stopped`.
- Worker activity: `busy` while any agent is `working` or `needs_input`; `idle` when none is; `unknown` when it can't be read.
- `finished` never blocks maintenance or removal. Nothing archives agents (D10).

**Paseo mapping (adapter only).**
| fffactory | Paseo 0.13.2 |
|---|---|
| `working` | `initializing`; `running` with no pending permission |
| `needs_input` | `running` with a pending permission (`agent inspect --json`) |
| `finished` | `idle` |
| `failed` | `error` |
| `stopped` | `closed` |

The adapter lists with `paseo ls --global --background --json` (0.12+ pages past 200). It inspects
only the `running` agents, and marks the agents dispatch launched from the `factory-dispatch=true`
label filter.

**Layers.**
- **Domain.**
  - The agent and worker states and the busy rule (`domain/control-plane.ts` or a new `domain/agent-activity.ts`).
  - The activity document's parser: an answer without the agent list is refused with the replace-the-worker next action (D4).
  - The removal inspection document shared by `worker inspect` and the records (D12, D13).
  - `maintenanceDeferral` and `removalGate` judge from the busy rule.
  - Completeness requires `hosts[].paseo_password_secret` (#91).
- **Application.**
  - A lock-free `inspectWorker` use case over `inspectForRemoval` and `removalGate`.
  - Terminate and teardown write `inspection` into their records.
  - Status reads each worker's activity.
  - Upgrade gets `controlPlane` and `workflowQueue` (#11).
- **Infrastructure, CLI side.** The SSH adapter reads the richer activity document. Its Paseo-named
  files are left alone; #93 covers them.
- **Host, the worker-side adapter.**
  - `src/host/control-plane.ts` `activity()` translates Paseo into fffactory's states.
  - A new read-only `fffactory host agents --json`, run as `factory`, which dispatch calls (D7).
- **Assets.**
  - `versions.env` pins 0.13.2.
  - `factory-dispatch` moves from `--background` to `--no-wait`, and its capacity check calls `host agents` (which also drops the never-matching `"permission"` status).
  - `paseo-config.sh` turns off dictation and voice mode (#73).
- **CLI.**
  - `fffactory worker inspect [KEY] [--json]`.
  - Status shows each worker's agent summary.
  - `validate` names `fffactory secret set paseo-password --host KEY` (#91).

**Specs changed.** control-plane.md (contracts at 0.13.2, the mapping, the busy rule), host-protocol.md
(activity document fields, `host agents`), worker-lifecycle.md (gates, `worker inspect`, record),
teardown.md (record), dispatch.md (capacity, `--no-wait`), status.md and its schema (agent summary,
an addition), instance-configuration.md (#91), plan-apply.md §Upgrade (#11). The release notes
tell operators to replace existing workers (D4).

## Phase 3: Path

Rough commit boundaries in dependency order. plan-breakdown cuts the tasks.

1. **#91.** Every worker needs a Paseo password (completeness, validate's next action, init text, specs). Independent.
2. **#11.** Upgrade runs every stage apply runs. Independent.
3. **Paseo 0.13.2.** The pin, `--no-wait`, `ls --background`, the speech switches (#73), `just paseo-check` against 0.13.2, and the control-plane.md contracts. Trial it on one worker before release (D8).
4. **fffactory agent states.** The domain states and busy rule, the activity document's agent list
   from the host adapter, the CLI refusing an answer without it (D4), and maintenance deferral and
   removal gates judged by the rule. Depends on 3. This alone fixes #92.
5. **`host agents` for dispatch.** The read-only worker command, and dispatch's capacity check calling it (D7). Depends on 4.
6. **`worker inspect` and the status summary.** Depends on 4.
7. **Removal records carry `inspection`.** Terminate and teardown write the shared document (D13). Depends on 6.
8. **Release notes** for replacing existing workers (D4). Ships with the release, not the epic PR.


## Captured tasks

Epic #94.

- #95 T1 — Every worker needs a Paseo password (#91)
- #96 T2 — `upgrade` runs every stage `apply` runs (#11)
- #97 T3 — Pin Paseo 0.13.2
- #98 T4 — The worker reports its agents in fffactory's states
- #99 T5 — The CLI judges busy from agent states (fixes #92)
- #100 T6 — Dispatch asks the same adapter
- #101 T7 — `fffactory worker inspect` and the status agent summary
- #102 T8 — Removal records carry `inspection`
