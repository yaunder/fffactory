# Phase 3 — E3 Repository, dispatch and the switch

Status: complete
Tracked in: the private tracker this repository was snapshotted from (docs/public-repository.md), since retired. The epic and its tasks closed as done there, so they are listed by name.
Milestone: M2 (one completed epic)
Kind: plan-chat (tasks broken down in phases/phase-3/tasks/)
Scope: Repository placement and sync (wrapped v1), Paseo installed and classified by change type with busy-agent
deferral, dispatch readiness gates with requested vs active dispatch (wrapped v1 dispatch), end-to-end verification,
then the switch: M2 acceptance evidence, documentation rewritten for v2, remaining v1 code deleted.
Success: "From a workstation without a factory checkout, provision one worker, complete human enrollment, and turn one
ready epic into a PR; rerunning apply is safe." Proven failure paths: dirty or divergent repository keeps dispatch
pending, missing credential keeps dispatch inactive, rerunning apply with an active agent does not restart Paseo.
Depends on: phase-2
Estimated tasks: 4
Decisions: D3, D6, D7, D8, D9

## Captured tasks
Epic: E3 Repository, dispatch and the switch

- Repository placement and synchronization
- Paseo installation and change classification
- Dispatch readiness gates and end-to-end verification
- M2 acceptance and the switch to v2
