# Decisions: worker-idleness

✓ D1 Scope (2026-10-26, user)
   Chose: the epic covers #91, #92, a read-only removability report, and removal records that
   carry the gates' outcome. #39 is out.
   Rationale: #39 is about plan freshness, not idleness. Planning fresh after a removal avoids it.
   Rejected alternatives:
     - Include #39: a bigger PR for an unrelated freshness rule.

✓ D2 No legacy path; Paseo 0.12 or later (2026-10-26, user)
   Chose: every worker is forced onto the new release. No code reads an older worker's activity
   answer. The epic targets Paseo 0.12 and later; the exact pin follows the upgrade research.
   Rationale: the user is forcing every worker to upgrade.
   Rejected alternatives:
     - A fallback for older workers' count-only answer: dead code once every worker is upgraded.
   Consequence to plan for: the pre-activation deferral asks the worker's *current* release for
   activity, which counts finished agents. So a worker that has run dispatch defers the very
   upgrade that fixes this (#92 blocks its own rollout). See D4.

✓ D3 fffactory owns worker and agent status; Paseo is an adapter (2026-10-26, user)
   Chose: fffactory's domain defines its own agent and worker states. The Paseo adapter on the
   worker translates Paseo's statuses into them. No Paseo status, field or verb (`idle`, `closed`,
   archive, pendingPermissions) crosses the host protocol or reaches CLI output, status JSON or
   operation records.
   Rationale: Paseo may be replaced; only the adapter should change when it is.
   Rejected alternatives:
     - Worker reports Paseo's raw statuses and the CLI judges them: leaks Paseo into the protocol
       and the domain.
     - Worker reports only a busy/idle verdict (today): the rule is untestable on the CLI side, and
       the removability report and records cannot say *what* is active.

✓ D4 Existing workers are replaced, not upgraded in place (2026-10-26, user)
   Chose: the new CLI reads only the new activity answer. A worker whose release sends the old
   one is refused with a message naming the fix: push its work, then
   `fffactory worker terminate KEY --force` and `fffactory apply` to recreate it. The host
   protocol stays at major version 1: the answer only gains fields.
   Rationale: no legacy code, and replacing a worker is already a supported path (terminate, then apply).
   Rejected alternatives:
     - Bump the host protocol to v2: rejects every v1 document (inspect, apply, verify, work
       inspect), not just activity, and still ends in replacement.
     - Read the old answer once for the pre-activation check: a legacy path, plus a by-hand
       clean-up of finished agents.
   Note: `--force` skips the work gate, so the refusal's next action tells the operator to check
   for unpushed work first, the way the older-activator refusal does.

✓ D5 Five fffactory agent states (2026-10-26, user)
   Chose: `working`, `needs_input`, `finished`, `failed`, `stopped`. A worker is busy while any
   agent is `working` or `needs_input`, idle when none is, and unknown when activity can't be read.
   Rationale: status and the removability report can say an agent failed or is not loaded.
   Rejected alternatives:
     - Three (working, needs_input, done): fewer words, but the operator can't tell a failed
       agent from a finished one.

✓ D6 A finished agent is not busy, even if it may be waiting for a reply (2026-10-26, user)
   Chose: `finished` never blocks removal or maintenance. The removability report lists finished
   agents, so the operator sees which conversations a removal would end.
   Rationale: no runtime signal tells "waiting for a reply" from "done". The work gate protects
   unpushed work, and merge approval happens on the PR.
   Rejected alternatives:
     - Busy for N hours after finishing: a clock-dependent gate and a new setting; upstream
       Paseo declined a similar age-based rule.

✓ D7 One adapter, which dispatch calls (2026-10-26, user)
   Chose: the worker's fffactory gains a read-only command listing its agents in fffactory's
   states, each with whether dispatch launched it (from the runtime's label, translated in the
   adapter). Dispatch's capacity check calls it instead of `paseo ls`.
   Rationale: one translation, and one place to change if Paseo is replaced.
   Rejected alternatives:
     - Dispatch keeps its own Paseo call: two translations that could drift.
   Kept as is: dispatch's duplicate check (`previously_dispatched`) and `paseo run` stay
   Paseo-specific inside the dispatcher.

✓ D12 `worker inspect` for the verdict, an agent summary in `status` (2026-10-26, user)
   Chose: `fffactory worker inspect [KEY] [--json]` is read-only and takes no lock. It runs exactly
   terminate's gates (agents, work, checkouts) and prints the verdict and findings; it exits 0
   when removable. `status` gains each worker's busy/idle/unknown and its agents' states, without
   the work inspection.
   Rationale: the work inspection can hold a worker's activator for up to 2 minutes, which is too
   slow and contended for every status call.
   Rejected alternatives:
     - All of it in `status`: slow, and contends with apply.
     - Only `worker inspect`: status would show nothing about agents.

✓ D13 Removal records carry forced, verdict and findings (2026-10-26, user)
   Chose: each inspected worker in a `worker-terminate` or `teardown` record gets `inspection`:
   `forced`, a verdict (removable, refused, or not inspected because stopped or forced), and the
   findings in fffactory's words. It is the same document `worker inspect --json` prints.
   Teardown records one per running worker.
   Rationale: a caller can tell from the record alone whether the gates ran and what they found.
   Rejected alternatives:
     - Forced and verdict only: seeing why means rerunning `worker inspect`, whose answer may have changed.

✓ D8 Pin Paseo 0.13.2 (2026-10-26, user)
   Chose: 0.13.2, trialled on one worker before the release. The dispatcher moves from
   `run --background` to `--no-wait` in the same release. `ls` adds `--background` so it sees
   agent-created workspaces.
   Rationale: 0.12 removes the silent 200-row cap; 0.13 rewrites a crashed daemon's stale
   `running` to `closed`, which would otherwise hold removal gates shut. 0.13.1 and 0.13.2 are app-only.
   Rejected alternatives:
     - 0.12.0: only the cap fix, the same compatibility cost.
     - Stay on 0.11.4: rejected by D2.

✓ D9 #11 joins the epic (2026-10-26, user)
   Chose: wire controlPlane and workflowQueue into upgrade, as #11 describes.
   Rationale: the pin moves through `fffactory upgrade`, which today never installs Paseo changes.
   Rejected alternatives:
     - Keep it with #57: every upgrade needs a follow-up apply.

✓ D10 Finished agents stop counting; nothing archives them (2026-10-26, user)
   Chose: fffactory's states make a finished agent not busy. Neither dispatch nor fffactory
   archives agents.
   Rationale: fixes the gates without archiving. Dispatch's duplicate check keeps relying on
   finished agents staying listed. Nothing risks `workspace archive` deleting a worktree. The
   list keeps growing, which is housekeeping, not correctness (0.12+ pages past 200).
   Rejected alternatives:
     - Archive them: needs a new duplicate check, care never to archive a workspace, and Paseo
       un-archives an agent whenever someone messages it.

✓ D11 #73 rides with the pin bump (2026-10-26, user)
   Chose: `paseo-config.sh` merges `features.dictation.enabled` and `features.voiceMode.enabled`
   as false, in the same release.
   Rationale: the same file and the same maintenance restart; 0.13.2 honours both switches.
   Rejected alternatives:
     - Separate: workers keep downloading about 765 MB at every daemon start.

