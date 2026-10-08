# Plan: fffactory-v2-roadmap

Level: L1 · Source: docs/designs/fffactory-v2.md @ d813dee (main) · Tracker: #80

## Phase 1 — Understanding (confirmed 2026-09-29)

Split FFFactory v2 (design at docs/designs/fffactory-v2.md, tracker #80) into an
ordered, dependency-aware set of epics. Each epic can be delivered and
demonstrated on its own, and together they reach the design's acceptance
journey plus adoption. (Originally: v1 stays the production authority throughout.
Revised by D7: v1 is disposable; v2 becomes the standard as soon as possible.)

In scope: epic boundaries, order, dependencies, the external prerequisites each
epic needs (signing keys, test account), and what happens to existing issues.

Out of scope: task-level breakdown (/plan-breakdown per epic), detailed designs
for the lock, plan format or host protocol, and any production deployment.

Review findings that shape the split:
1. The acceptance section is one long journey, so nothing can be demonstrated
   until the end unless we slice deliberately.
2. The trust chain (signing mechanism, key custody, rotation, verification on
   AL2023) is not specified. Resolved by D4: no signing for now.
3. The worker-side executor for the plan/apply/verify protocol is undefined.
4. Acceptance leaves out `upgrade` and base migration, the riskiest paths.
5. Existing issues overlap v2 (#45 #46 #50 #62 #68 #72 #79); see D6.
6. v2 names resources by factory ID and v1 does not, so they can coexist, but
   the test environment still needs a deliberate choice.

## Phase 2 — Architecture / Approach (revised 2026-09-29 after external review)

Organising milestone (D2): the first real FFFlow run. Acceptance statement for M2:

> From a workstation without a factory checkout, provision one worker, complete
> human enrollment, and turn one ready epic into a PR; rerunning apply is safe.

Test environment: production account, separate factory ID (D5). v2 is built at the
repository root; each epic deletes the v1 code it replaces (D7, D9). Each epic proves
its own failure paths. Kept from the first implementation: account check,
namespacing, lock, exact-plan approval, honest readiness, safe repository handling.
Layers: D = domain, A = application (use cases + ports), I = infrastructure.

### M1 — One usable worker

E1 CLI foundation (local only, no AWS mutation)
  D: factory instance, stable host key, release id, config revision, readiness progression.
  A: init, validate, doctor. Only ports with a caller in E1: CallerIdentity (+ config store).
  I: root package.json/src, factory.json schema v1 + discovery precedence, STS caller
     adapter + account-mismatch refusal, local tool probes, CLI adapter, embedded asset
     bundle + materialization, Bun builds (darwin-arm64, linux-x64) with ad-hoc macOS
     codesign, CI smoke test of the packaged binary, tag-triggered GitHub Release
     (binaries, SHA256SUMS, install.sh using gh or GITHUB_TOKEN while private: D10).
  Authority (D12): AGENTS.md invariants rewritten: fffactory governs v2 factory IDs,
     v1 commands frozen, v2 operating rules stated.
  Also: module CLAUDE.md, first specs, design-doc edits for D2/D3/D4/D7/D8/D9/D10/D11.
  Demo: install from a GitHub Release on a clean workstation; init + doctor with no checkout;
     wrong AWS account is refused.

E2 Provision and install one worker
  D: plan, operation, stage, lock, plan freshness, observed readiness, D11 refusals.
  A: plan/apply (infrastructure + worker stages), backend bootstrap flow, factory-wide lock,
     saved plans with exact-plan approval, guided protected secret write, status (0/2/1),
     minimal upgrade (pin bump + rollout), human enrollment next actions (GitHub, provider,
     Paseo client). Ports: Provisioner, SecretStore, HostTransport.
  I: managed Terraform (download, verify, isolated workdir, provider cache), namespaced
     modules reusing v1 resources, S3 lock adapter, Secrets Manager adapter, bootstrap user
     data without SSM (fffactory-admin and factory accounts, Tailscale enrollment,
     activator, release directories, RPM-lock retry #17), OpenSSH-over-Tailscale adapter
     with duplicate/missing-hostname refusal, worker `fffactory host inspect|apply|verify`,
     minimal shell activator (tarball digest), v1 setup steps wrapped as shell (D3).
  Guardrails (D5): factory-ID prefix on every resource name with a test enforcing it,
     tag-scoped IAM for mutations, per-factory Tailscale secret, VPC quota check in doctor.
  Deletes: v1 infrastructure/ Terraform and SSM documents, bin/factory-infrastructure,
     bin/factory-host (v1 scripts reused by D3 move into release assets).
  Failure paths proven: stale or changed-input plan rejected; concurrent apply refused by
     the lock; interrupted apply recovers on rerun; failed install leaves the worker on the
     requested unhealthy release and a rerun repairs it; D11 refusals fire.
  Demo: backend bootstrap -> one worker provisioned, installed and verified synchronously;
     status reports enrollment pending with exact next steps; upgrade to the next build.

### M2 — One completed epic (switch to v2 here)

E3 Repository, dispatch and the switch
  D: repository placement, dispatch readiness gates, requested vs active dispatch,
     change classification (live / reload / maintenance).
  A: repository and dispatch stages, end-to-end verification. Ports: ControlPlane, WorkflowQueue.
  I: v1 sync-repositories.sh and FFFlow adoption check wrapped as steps; Paseo adapter
     built on v1's Paseo CLI dispatch; FFFlow/GitHub readiness; busy-agent detection that
     defers Paseo-restarting changes while agents are active.
  Failure paths proven: dirty or divergent repository refuses sync and keeps dispatch
     pending; missing human credential keeps dispatch inactive; rerunning apply with an
     active agent does not restart Paseo or interrupt the agent.
  Switch: the user moves onto v2; README.md, SDLC.md, decision 0001, onboarding and
     repository skills describe v2; remaining v1 code deleted; v1 hosts retired manually.
  Demo: the M2 acceptance statement.

### M3 — Operate and expand (one-line entries; each gets its own plan-chat when needed)

- Second worker and rollout policy (one at a time, skip offline, stop on unexpected failure).
- Full upgrade: schema migration with backup (removes the D11 schema refusal).
- Base migrations with reboot and reconnect (removes the D11 base refusal).
- Host retirement with snapshot and destroy approvals (removes the D11 host refusals).
- Inventory and orphan reporting across AWS, Tailscale and factory.json.
- Companion fffactory skill and `skill install`.
- Full acceptance exercise across all failure paths.

## Phase 3 — Path

Order: E1 -> E2 -> E3 (switch). M3 items follow in whatever order need dictates.

Natural cut points (rough; /plan-breakdown decides the real tasks):
  E1: schema + discovery + domain types -> init/doctor + account check -> packaging + CI
      smoke -> GitHub Release + install.sh -> AGENTS.md authority + design-doc edits.
  E2: managed Terraform -> namespaced modules + guardrail test -> backend bootstrap + lock
      -> saved plans + freshness + D11 refusals -> bootstrap user data -> transport + host
      inspect -> activator + host apply wrapping v1 steps -> verifiers + status ->
      enrollment next actions -> minimal upgrade -> delete v1 infrastructure/host CLIs.
  E3: repository step -> Paseo adapter + change classification + busy-agent deferral ->
      WorkflowQueue + readiness gates -> first real PR -> docs switch -> delete v1.

External prerequisites:
  E1: nothing beyond the repository. E2 onward: operator AWS credentials for the
  production account, a Tailscale enrollment key for the v2 factory stored in Secrets
  Manager, and tailnet SSH policy for fffactory-admin (manual admin step).

Issue actions at capture (D6): close #68 #72 #62 #45 #46 #50 #79, fold #17 into E2,
make #80 the tracker.
