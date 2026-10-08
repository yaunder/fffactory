# Phase 2 — E2 Provision and install one worker (milestone M1: one usable worker)

Kind: plan-chat (tasks broken down in phases/phase-2/tasks/)
Scope: Managed Terraform, namespaced modules with the D5 guardrails, bootstrap without SSM, backend bootstrap and the
factory-wide lock, saved plans with exact-plan approval and the D11 refusals, SSH over Tailscale, worker
`host inspect|apply|verify` wrapping v1 setup steps, `status`, enrollment next actions, a minimal `upgrade`, and deletion
of the v1 infrastructure and host CLIs.
Success: In the production account under a v2 factory ID, backend bootstrap then one worker provisioned, installed and
verified synchronously; `status` reports enrollment pending with exact next steps; `upgrade` moves the worker to the next
build. Proven failure paths: stale or changed-input plan rejected, concurrent apply refused, interrupted apply recovered,
failed install repaired by rerun, D11 refusals fire.
Depends on: phase-1
Estimated tasks: 8
Decisions: D3, D4, D5, D8, D9, D11

## Captured tasks
Epic: #86

- #95 — Managed Terraform behind the Provisioner port
- #96 — Namespaced Terraform modules with guardrails
- #97 — Bootstrap user data and the root activator
- #98 — Backend bootstrap, factory-wide lock and guided secret write
- #99 — Plan and apply for the infrastructure stage
- #100 — SSH transport, host inspect and status
- #101 — Worker install stage and enrollment next actions
- #102 — Minimal upgrade and removal of v1 infrastructure and host CLIs
