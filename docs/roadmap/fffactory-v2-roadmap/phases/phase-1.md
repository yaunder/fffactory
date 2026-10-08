# Phase 1 — E1 CLI foundation (milestone M1: one usable worker)

Kind: plan-chat (tasks broken down in phases/phase-1/tasks/)
Scope: The locally usable `fffactory` CLI: factory.json schema v1 and instance discovery, `init`, `doctor` with the AWS
account check, a packaged Bun executable with embedded assets, a tag-triggered GitHub Release with install.sh, and the
repository rules and design doc updated so v2 is the operating authority for v2 factory IDs (D12). No AWS mutation.
Success: On a workstation with no factory checkout, Node or Bun, an operator installs `fffactory` from a GitHub Release
with install.sh, runs `init` and `doctor`, and a mismatched AWS account is refused. CI runs the packaged binary smoke test.
Depends on: none
Estimated tasks: 7
Decisions: D2, D4, D7, D8, D9, D10, D11, D12

## Captured tasks
Epic: #85

- #88 — Establish v2 operating authority and update the design
- #89 — factory.json schema v1 and instance discovery
- #90 — fffactory init
- #91 — fffactory doctor: local checks and versioned JSON
- #92 — AWS caller identity and account check
- #93 — Packaged fffactory executable with embedded assets
- #94 — GitHub Release and install.sh
