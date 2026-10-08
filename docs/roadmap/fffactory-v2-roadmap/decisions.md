# Decisions: fffactory-v2-roadmap

✓ D1 Plan level
   Chose: L1, taken from .ffflow/config.yaml (merged in #84: stack typescript, capture github-issues, specs in docs/specs, tests in tests).
   Rationale: the repository now declares its level, so the plan follows it. L1 means hexagonal layer mapping for each epic.
   Rejected alternatives:
     - L0 prose-only: below the declared level, and the design is explicitly hexagonal.
     - Adopting FFFlow inside the first epic: already done in #84.
✓ D2 Phase shape (revised 2026-09-29 after external review)
   Chose: milestones organised around the first real FFFlow run. M1 one usable worker; M2 one ready epic becomes a PR
   (switch to v2 here); M3 operate and expand. Each epic proves its own failure paths.
   Rationale: the original reasons for rejecting a walking skeleton are gone. D4 removed the signing shortcuts and D7
   left no v1 to protect. The first PR is the proof that matters.
   Rejected alternatives:
     - Journey-ordered E1–E6 (the earlier choice): too much work (six ports, inventory correlation, rollout, sync rewrite)
       ahead of the first real FFFlow run.
     - Layer by layer: nothing works end to end until late.
✓ D3 Worker-side executor (amended 2026-09-29 after external review)
   Chose: C′ without a completion gate. The Linux fffactory binary is the protocol endpoint (`host inspect|apply|verify`,
   versioned JSON); protocol, step ordering and verifiers are TypeScript. A minimal root shell activator
   (/usr/local/libexec/fffactory-activate: checks the tarball digest, unpacks into /opt/fffactory/releases/<version>,
   runs `host apply` as root; the only sudoers entry for fffactory-admin). v1 setup steps, sync-repositories.sh and
   the Paseo CLI dispatch are wrapped as shell steps. A step is ported to TypeScript only when it is touched for another
   reason; no epic requires shell to be gone.
   SSM is removed regardless: Terraform stops embedding scripts in SSM documents and associations, the CLI sequences
   steps in one process (replacing marker-file polling), and verification returns results directly.
   Rationale: one typed contract between CLI and worker without rewriting stable, tested helpers.
   Rejected alternatives:
     - "Only the activator is shell" as an exit criterion (the earlier C′): mandatory rewrite scope that proves nothing about the factory flow.
     - A from the start: the first worker install comes later, for no functional gain.
     - B (shell + JSON protocol): the contract lives in two languages and has weaker tests.
✓ D4 Release signing
   Chose: no release signing in v2's first cut. Integrity only: the release goes to the worker as one tarball; the CLI
   passes the tarball's embedded SHA-256 to the activator, which compares it before unpacking (catches a stale or
   wrong staged file; SSH and gzip already detect transit corruption and truncation). No per-file manifest. The trust chain is GitHub-authenticated download
   -> SHA256SUMS -> the operator's installed CLI -> Tailscale SSH -> activator.
   Accepted risk: anyone who can SSH as fffactory-admin can install arbitrary code as root, so fffactory-admin is
   effectively root. The activator-only sudoers entry stays as a narrow interface, not a security boundary.
   TODO trigger: re-evaluate when the repo goes public, a second operator gets fleet access, or releases are
   distributed to anyone who is not the factory owner.
   Rationale: with one operator installing from an authenticated private repo, signing only defends against someone
   who already holds operator SSH access. That isn't worth a key-custody and rotation lifecycle yet.
   Rejected alternatives:
     - Ed25519 key in a GitHub Actions environment: key custody and rotation overhead for negligible current benefit.
     - Sigstore/cosign keyless: adds cosign and network access to Sigstore's public log for the activator.
     - AWS KMS signing from CI: gives CI access to an AWS account, against the invariant.
     - Per-file SHA256 manifest: only meaningful as the thing a signature covers; with no signing, one digest for the tarball is enough.
✓ D5 Test environment
   Chose: the production AWS account and Region, under a separate v2 factory ID.
   (Revised after D7: v1 no longer needs protecting, so the guardrails below exist for the design's
   several-factories-per-account goal, not to shield v1.)
   Guardrails that become E2 acceptance criteria:
     - every v2 resource name (IAM roles and instance profiles, security groups, VPC, state bucket, lock object,
       Tailscale hostnames) carries the factory ID, and a test asserts no unprefixed names in the modules;
     - v2 IAM policies that can mutate EC2 or other shared resources are scoped by a factory-ID resource tag
       condition, never `*`, so one factory's automation cannot touch another's machines;
     - each factory's Tailscale enrollment secret is its own reference in factory.json;
     - doctor checks the Region's VPC quota headroom before the first apply, since v2 creates its own VPC.
   Rationale: no new account to set up, and it exercises the design's goal of several factories in one account.
   Rejected alternatives:
     - Dedicated AWS account: stronger isolation, but the user chose not to set one up.
     - Same account, different Region: IAM is account-wide, so the isolation is only partial.
✓ D6 Existing issue disposition (actions happen at /plan-capture, with user approval then)
   Close as superseded by E1: #68 (init CLI), #72 (merge repositories.json).
   Fold into E2 and close: #17 (retry RPM lock failures at bootstrap).
   Close in favour of the M2 acceptance statement: #62 (end-to-end acceptance and onboarding).
   Close as won't-fix, obsolete at adoption: #45, #46, #50.
   Close: #79 (dispatch via Paseo API); v1 dispatch runs through the Paseo CLI, which is sufficient for now.
   #80 becomes the v2 tracker; epic issues link to it.
   Unchanged: #58, #65, #66, #76, #21.
   Rationale: removes v1-only work that v2 replaces and keeps one tracker for v2.
   Rejected alternatives:
     - Keep #79 for v1: the user confirmed the Paseo CLI dispatch is sufficient.
     - Keep the tidy-up issues open until adoption: noise for work that will never happen.
✓ D7 v1 change policy
   Chose: v1 is disposable. It is a single-user, non-critical deployment with nobody to migrate. v2 work may break or
   delete v1 freely; no effort goes into preserving, fixing or porting v1 beyond reusing its code where convenient.
   The deployed v1 hosts keep running as-is and are used to build v2 (Paseo dispatch). This is safe while main
   changes because none of the v1 SSM associations has a schedule_expression and repository sync is operator-triggered;
   the one rule is to run no v1 factory-infrastructure/factory-host deploy, converge or sync once v1 code is removed.
   Rationale: the user wants v2 to be the standard as quickly as possible.
   Rejected alternatives:
     - Maintenance-only v1: effort spent keeping something that is being replaced.
     - Business as usual / full freeze: both assume v1 has users to protect; it doesn't.
✓ D8 Upgrade scope and when to switch (revised 2026-09-29 after external review)
   Chose: a minimal `upgrade` (move the pin and roll out) ships in M1, because every new build during development
   must reach the test worker and the pin check blocks apply otherwise; schema changes and new base generations are
   refused (D11). The switch to v2 happens at the end of M2. Full upgrade with schema migration, base migration and
   their acceptance move to M3.
   Rationale: gets the user onto v2 at the first real PR, and keeps the development loop working from the start.
   Rejected alternatives:
     - Defer all upgrade work to M3 (review suggestion): blocks reinstalling new builds on the test worker during M1/M2.
     - Big-bang adoption after full acceptance: delays the switch for no benefit now that v1 is disposable.
✓ D9 Code location
   Chose: v2 lives at the repository root (root package.json, src/, specs in docs/specs, tests in tests, matching
   .ffflow/config.yaml). Each epic deletes the v1 code it replaces (E2: infrastructure/ Terraform, bin/factory-infrastructure,
   bin/factory-host, SSM documents); v1 scripts reused as wrapped steps (D3) move into the release assets; the switch at
   the end of M2 removes the rest.
   Rationale: v1 is disposable (D7), so a subfolder would only need moving later.
   Rejected alternatives:
     - Separate subfolder (e.g. fffactory/): an extra move at adoption and a paths mismatch with .ffflow/config.yaml.
     - Separate repository: loses history and splits the tracker.
✓ D10 Operator distribution
   Chose: ad-hoc signed Bun binaries (darwin-arm64, linux-x64) plus SHA256SUMS and install.sh as assets on
   GitHub Releases of yaunder/factory. While the repo is private, install.sh authenticates with `gh auth token`
   or GITHUB_TOKEN. When the repo goes public, the same script works anonymously. Folded into E1; the separate
   distribution epic is removed. The design doc edit (no notarization or Homebrew; install-time GitHub
   credentials while private) ships with E1.
   Rationale: the simplest install that needs no checkout, and it keeps a single repository. GitHub credentials
   are needed only at install time, never to run the CLI.
   Rejected alternatives:
     - Homebrew + notarization + native installer: too much publishing overhead for the current audience.
     - bun install -g from the git repo: installs source that needs Bun to run, which breaks the no-Bun goal.
     - Public releases-only repo: an extra repo and cross-repo publishing token, unneeded before the planned public release.
     - Making yaunder/factory public now: the user wants it private for now.

✓ D11 Refusals that make deferred lifecycle work safe (from external review)
   Chose: until the M3 lifecycle epics land, `plan` refuses, with a spec per refusal:
     - removing a host key from factory.json (no retirement yet);
     - any Terraform plan that destroys or replaces a host machine (no retirement or replacement yet);
     - an upgrade whose release needs a newer base generation (no base migration yet);
     - an upgrade that changes the factory.json schema version (no schema migration yet).
   Each refusal names the missing capability and is removed by the epic that adds it.
   Rationale: small checks that let substantial machinery be deferred safely.
   Rejected alternatives:
     - Allow them with warnings: the design's safety model depends on these being gated.
     - Build retirement and migrations before the switch: delays the first PR.

✓ D12 Operating authority during the build (from external review)
   Chose: E1 rewrites the AGENTS.md invariants: `fffactory` is the operating authority for v2 factory IDs in the
   production account; v1 `factory-infrastructure` and `factory-host` are frozen (no deploy, converge or sync, D7);
   v2 operating rules (account check, exact-plan approval, lock, no raw secrets) are stated. The full documentation
   switch (README.md, SDLC.md, decision 0001, onboarding, skills) stays at the end of M2.
   Rationale: without it, the E2 demo in the production account violates the current rule requiring ./bin/factory-infrastructure,
   and E2 deletes that tool.
   Rejected alternatives:
     - Marking v1 deprecated only: leaves the current invariants contradicting v2 operations.
     - Doing the whole documentation switch in E1: documents behaviour that doesn't exist yet.
