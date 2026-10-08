# FFFactory v2 design specification

Status: adopted ([decision 0002](../decisions/0002-fffactory-v2.md)); M1 and
M2 are implemented and M3 is planned as need dictates. See
[issue #80](https://github.com/yaunder/factory/issues/80).

This document describes the agreed target architecture for FFFactory v2 and
the milestones that deliver it. `fffactory` is the operating authority for v2
factory IDs in the production account, and the v1 tooling is frozen; the
rules that govern operation today are in [AGENTS.md](../../AGENTS.md). Only
behavior that has shipped may be operated. In this document, v1 is the frozen
implementation v2 replaced, and "the first cut" is v2's initial scope.
Decision labels such as D11 refer to the roadmap's
`docs/roadmap/fffactory-v2-roadmap/decisions.md`. Updated for #88.

## Purpose

FFFactory should turn an FFFlow-enabled repository into an operable software
factory without requiring the operator to clone this repository, install a
JavaScript runtime, understand SSM orchestration, or remember a collection of
layer-specific commands.

The v1 implementation proved the workflow, but coupled factory software
delivery to Terraform and asynchronous SSM associations. A Terraform apply could
finish before workers had actually converged, so the local result did not
reliably describe worker state.

V2 separates machine provisioning from synchronous worker reconciliation:

```text
factory.json + matching fffactory CLI
                 |
       +---------+---------+
       |                   |
       v                   v
 Terraform             Tailscale SSH
 provisions            plans, installs,
 machines              and verifies workers
       |                   |
       +----------> workers <----------+
                         |
                    Paseo + FFFlow
```

## Goals

- Install one native `fffactory` executable and an optional matching skill.
- Operate without a factory source checkout, Node, Bun, SSM, or a system
  Terraform installation.
- Keep one user-owned, non-secret factory definition separate from released
  factory code.
- Produce Terraform-like local behavior: plan current state, apply an exact
  approved plan, wait for the affected workers, and report partial failure
  honestly.
- Use Terraform for AWS infrastructure and direct Tailscale SSH for worker
  reconciliation.
- Keep AWS, Tailscale, Paseo, and FFFlow as the opinionated initial stack.
- Structure the implementation around internal ports so real alternatives can
  be added later without designing a plugin ecosystem up front.
- Preserve long-running agent work by treating Paseo restarts and machine-base
  changes as maintenance events.
- Guide human authentication and enrollment steps without claiming they were
  automated.

## Non-goals for the first cut

- Migrating existing factory machines or Terraform state in place. V2 is a
  clean deployment proven on new machines; v1 is disposable and is retired at
  the switch.
- Supporting clouds other than AWS, arbitrary existing VPCs, alternate
  control planes, or alternate workflow systems.
- Loading third-party connectors dynamically.
- Supporting worker operating systems other than Amazon Linux 2023 x86-64.
- Supporting operator platforms other than Apple Silicon macOS and x86-64
  Linux.
- Full offline operation.
- Automatic deletion of orphaned machines, Tailscale devices, or repository
  checkouts.
- Automatic rollback or operator-requested downgrade of a factory release.
- Guaranteed complete Tailscale inventory. The first cut uses the operator's
  local Tailscale view.
- Moving dispatch-readiness rules into FFFlow. FFFactory continues owning them
  initially.

## Architectural boundaries

V2 follows the same dependency direction promoted by FFFlow's hexagonal
architecture guidance:

```text
Domain <- Application <- Infrastructure
```

### Domain

The domain contains no AWS, Terraform, Tailscale, Paseo, GitHub, or shell
types. Its core concepts include:

- factory instance;
- factory release and configuration revision;
- stable host;
- desired and observed readiness;
- repository placement;
- dispatch readiness;
- plan, operation, and verification result;
- retirement and maintenance state.

It answers questions such as which hosts differ from desired state, whether a
host can accept a release, and whether dispatch may safely be active.

### Application

The application layer owns the use cases and typed ports:

- initialize and validate an instance;
- diagnose prerequisites;
- plan and apply a factory;
- inspect live status;
- upgrade a factory release and schema;
- retire a host;
- reconcile repositories and dispatch;
- guide protected secret writes.

Initial ports include `Provisioner`, `HostTransport`, `SecretStore`,
`ControlPlane`, `WorkflowQueue`, and release verification. Ports are tested
from both the application and connector sides.

### Infrastructure

The first cut ships one built-in connector per capability:

- AWS and managed Terraform for provisioning;
- Tailscale plus system OpenSSH for host transport;
- AWS Secrets Manager for secrets;
- Paseo for agents, schedules, sessions, and worktrees;
- FFFlow/GitHub rules for work eligibility.

These connector names do not appear as meaningless choices in
configuration. The interfaces remain internal until a second implementation
creates a real need to expose selection.

## Distribution and trust

### Executable

`fffactory` is implemented in TypeScript and compiled with Bun into a native,
runtime-bearing executable. Separate immutable artifacts are published for:

- Apple Silicon macOS (`darwin-arm64`);
- x86-64 Linux (`linux-x64`).

The macOS build carries only the ad-hoc code signature Apple Silicon requires
to run a native binary; it asserts no publisher identity.

### Releases and installation

A version tag triggers a GitHub Release of `yaunder/fffactory`. Its assets are
the two executables, a `SHA256SUMS` file, and `install.sh`. The script
downloads the executable for the operator's platform, checks it against
`SHA256SUMS`, and installs it. Installation is explicit; the CLI does not
update itself.

The public repository supports anonymous installation. `install.sh` also
supports `gh auth token` or `GITHUB_TOKEN` for private mirrors and API rate
limits. GitHub credentials are not required to install public releases or
to run the CLI.

### Integrity and trust

V2's first cut has no release signing (D4). Integrity rests on digests:

- `SHA256SUMS` covers the published executables;
- each executable embeds the SHA-256 of its release tarball;
- the release reaches a worker as that one tarball, and the CLI passes the
  embedded digest to the activator, which compares it before unpacking.

The digest catches a stale or wrong staged file; SSH and gzip already detect
transit corruption and truncation. There is no per-file manifest. The trust
chain is: GitHub-authenticated download, then `SHA256SUMS`, then the
operator's installed CLI, then Tailscale SSH, then the activator.

Accepted risk: anyone who can SSH as `fffactory-admin` can install arbitrary
code as root, so `fffactory-admin` is effectively root. Its activator-only
sudoers entry is a narrow interface, not a security boundary. Re-evaluate
release signing when the repository goes public, a second operator gets fleet
access, or releases are distributed to anyone other than the factory owner.

### Embedded assets

Every executable embeds the matching factory release as one tarball whose
SHA-256 it records. The tarball contains:

- Terraform modules and provider lockfile;
- schemas and schema migrations;
- the Linux `fffactory` executable that serves the worker protocol, wrapped
  shell setup steps, and verifiers;
- factory commands and dispatch program;
- Paseo service definition;
- pinned agent, plugin, and tool versions;
- the matching `fffactory` skill;
- base-migration definitions and release metadata.

The executable materializes assets into an isolated FFFactory-owned work
directory. Terraform and host operations never read assets from an arbitrary
checkout.

### Managed and external tools

FFFactory downloads the exact supported Terraform binary into a private cache,
verifies it, and uses the shipped provider lockfile. Providers use a controlled
cache and isolated per-operation data directory.

The operator still supplies:

- AWS credentials through the standard AWS credential chain;
- AWS CLI only when the chosen login flow, such as SSO, needs it;
- an installed and authenticated Tailscale client;
- system OpenSSH;
- network access when required artifacts or provider packages are not cached.

The operator does not need a factory checkout, Node, Bun, `jq`, `curl`, `git`,
`gh`, SSM, Session Manager, or a globally installed Terraform binary to run the
CLI. Installation needs `curl` and a SHA-256 tool; GitHub credentials are
optional for public releases.

## Instance configuration

### File and discovery

The only editable desired-state file is `.fffactory/factory.json`. Running
`fffactory init` without a path creates it relative to the current directory:

```text
./.fffactory/factory.json
```

Instance selection uses this precedence:

1. `--instance PATH`;
2. `FFFACTORY_INSTANCE`;
3. the nearest `.fffactory/factory.json`, searching upward from the current
   directory;
4. `~/.fffactory/factory.json`, only if the user deliberately created one;
5. otherwise fail with an initialization instruction.

Every plan prominently displays the resolved configuration path, factory name,
AWS account and Region, and release version.

### Contents

The file is versioned and includes, at minimum:

- schema version and pinned factory release;
- permanent factory ID and human-readable name;
- expected AWS account and Region;
- state-backend identity;
- network and Tailscale declarations;
- secret references, never secret values;
- stable host keys and machine declarations;
- repository inventory and host placement;
- desired dispatch settings.

The permanent factory ID namespaces AWS resources and Tailscale hostnames so
multiple factories can share an account, Region, and tailnet. Stable host keys
cannot be renamed. Replacement means declaring a new host and retiring the old
one.

`init` writes a valid partial document and preserves progress on rerun.
`doctor` and the skill report which fields or external steps are still needed.
Generated Terraform files and host projections remain private implementation
details and are never a second editable source.

### Credentials and secrets

An AWS profile name is operator-local and is not desired state. The operator
selects credentials with `--profile`, `AWS_PROFILE`, or the standard AWS
credential chain. Before any plan or mutation, the CLI resolves the caller with
STS and refuses to continue if the actual account differs from `factory.json`.
The same resolved selection is passed to Terraform.

Raw secrets never enter configuration, Terraform inputs, plans, command
arguments, or logs. An occasional protected CLI operation accepts secret
material through a hidden prompt or standard input and writes it directly to
Secrets Manager. Configuration retains only the resulting ARN.

## Release and compatibility model

The instance release pin, local CLI, and worker release use the same release
version.

- A mutating command other than `upgrade` requires the local CLI version to
  match the instance pin.
- A mismatched CLI may provide diagnostics but may not apply changes.
- A newly installed CLI changes nothing by itself.
- `fffactory upgrade` is the only normal path from an older release to the
  running CLI's release.
- The first cut does not acquire arbitrary older releases, support downgrade,
  or silently substitute newer assets.

The release version and configuration schema version are independent.
`upgrade` previews any schema migration, preserves a backup, changes the pin,
builds the complete plan, requests approval, and applies it. If some workers
are offline or busy, the instance remains pinned to the new release and later
applies finish convergence.

Worker releases are installed into root-owned versioned directories. Mutable
repositories, credentials, worktrees, Paseo state, caches, Tailscale state, and
operation records live outside release directories. Previous directories may
be retained briefly for diagnosis, but activation is forward-only. If a newly
activated worker fails verification, it remains on the requested unhealthy
release, the rollout stops, and recovery repairs that release or moves to a
newer one.

## Command surface

The normal public surface is deliberately small:

```text
fffactory init
fffactory doctor
fffactory plan
fffactory apply
fffactory status
fffactory upgrade
```

Advanced options may limit an operation to one stage, for example
`apply --only workers`, without promoting every internal phase into a command
users must memorize. Infrequent setup operations, such as skill installation
or protected secret entry, may live under secondary subcommands.

### `init`

Creates or adopts a partial instance file. It does not provision cloud
resources.

### `doctor`

Performs read-only checks of local tools, credentials, selected account,
configuration completeness, Tailscale, SSH policy, caches, and capability
readiness. Results are available as human-readable output and versioned JSON.

### `plan`

Builds a complete plan from current configuration and live state. It includes:

- backend bootstrap when not yet present;
- Terraform infrastructure changes;
- machine-base maintenance;
- worker release and configuration changes;
- repository placement and synchronization;
- control-plane, dispatch and end-to-end verification changes;
- destructive actions, busy-worker blocks, and required human steps.

Plans contain no raw secrets. A plan used by an agent or automation is saved
under a short-lived plan ID. Applying it rechecks configuration hashes, live
assumptions, release identity, and freshness.

### `apply`

For an established instance, `apply` presents one complete plan and requires
one approval tied to that exact plan. Exceptional destructive or irreversible
maintenance actions receive an additional explicit approval.

The first apply is the exception: it first presents and applies a small backend
bootstrap plan, acquires the newly created factory-wide lock, then creates the
complete factory plan and requests the normal approval.

The full stage order is:

1. infrastructure;
2. worker base and factory release;
3. repository placement and synchronization;
4. control-plane reconciliation;
5. dispatch reconciliation;
6. end-to-end verification.

One remote, factory-wide lock covers every stage, not just Terraform. The lock
lives in the factory state bucket. Terraform retains its own state locking as
an additional safeguard.

Eligible workers update one at a time. Known skips such as offline workers or
workers blocked by active agents do not prevent other eligible workers from
being attempted. An unexpected installation or verification failure stops the
worker rollout before later eligible workers are touched.

### `status`

Status is read-only and based on current synchronous inspection. The first
cut stores no last-known worker result for offline display, so an unreachable
worker's installed version is unknown. For a reachable worker it inspects the
persisted dispatch result and verifies the actual schedule before reporting
dispatch active.

Exit codes are:

- `0`: fully ready and converged;
- `2`: inspection succeeded, but something is missing, drifting, offline,
  unhealthy, or pending;
- `1`: the command itself failed.

### `upgrade`

The running newer CLI previews and applies the move from the pinned older
release to its own release. It includes schema migration, Terraform changes,
base migrations, worker rollout, repository reconciliation, and dispatch state
in one workflow.

That full workflow arrives in M3. Until then a minimal `upgrade` moves the pin
and rolls out the new release (D8); it refuses a release that changes the
configuration schema version or needs a newer base generation (D11).

## Provisioning and bootstrap

Terraform owns AWS machines, networking, storage, IAM, state resources, and
initial user data. It no longer transports normal factory releases or owns
their convergence lifecycle.

Bootstrap creates only the stable base needed before direct management:

- Amazon Linux 2023 x86-64;
- the `fffactory-admin` operator account;
- the unprivileged `factory` runtime account;
- Tailscale enrollment and Tailscale SSH;
- the minimal trusted root activation helper;
- directories and permissions needed to receive the first release.

`fffactory-admin` does not receive unrestricted passwordless root. Its only
sudoers entry is the root-owned shell activator,
`/usr/local/libexec/fffactory-activate`. The activator checks the release
tarball's digest, unpacks it into `/opt/fffactory/releases/<version>`, and runs
`fffactory host apply` from that release as root. Because the activator
installs whatever release it is given, this entry is a narrow interface, not a
security boundary (see Integrity and trust).

The first cut retains the existing reusable tagged Tailscale enrollment key
stored in Secrets Manager. `doctor` checks the reference and surfaces expiry
risks. Replacing this with AWS workload identity federation is an explicit
future improvement, not a first-cut prerequisite.

Tailnet SSH policy is an external administrator action in the first cut. The
CLI tests actual access and emits the exact next step when policy is missing;
it does not mutate tailnet policy.

## Machine identity and connectivity

Status compares three inventories:

- desired stable hosts in `factory.json`;
- factory-tagged EC2 machines visible in AWS;
- peers visible from the operator's local Tailscale client.

The first cut correlates AWS and Tailscale machines by the namespaced
hostname. This is a deliberate simplification, not cryptographic identity
proof. A missing or duplicate name is never guessed. If the desired hostname is
already present during provisioning or replacement, the operation stops and
tells the operator to resolve the stale Tailscale entry manually.

Possible results include ready, missing, disconnected, AWS orphan candidate,
Tailscale orphan candidate, duplicate hostname, and unknown visibility.
Because the local peer view can be restricted by tailnet policy, orphan results
are explicitly described as partial. The first cut reports orphans and never
deletes them.

## Synchronous worker reconciliation

Normal worker management does not use SSM or a persistent FFFactory daemon.
Terraform no longer embeds scripts in SSM documents or associations. The CLI
invokes the release-supplied protocol directly over Tailscale SSH, sequences
the steps in one process instead of polling marker files, and receives
verification results directly.

The Linux `fffactory` executable is the worker's protocol endpoint:
`fffactory host inspect`, `host apply`, and `host verify` exchange versioned
JSON. The protocol, step ordering, and verifiers are TypeScript. Stable v1
setup steps, repository synchronization, and the Paseo CLI dispatch run as
wrapped shell steps. A step is ported to TypeScript only when it is changed for
another reason; no milestone requires the shell steps to be gone (D3).

For each worker, the CLI:

1. verifies hostname, connectivity, supported base, disk space, and privilege;
2. reads the active release, configuration digest, services, repository state,
   Paseo state, and readiness evidence;
3. uploads the matching release tarball and host-specific non-secret
   projection;
4. invokes the root activator with the tarball's expected digest;
5. performs any separately approved base maintenance;
6. activates the versioned release;
7. restarts or reloads only components whose change requires it;
8. synchronizes repositories and reconciles dispatch when safe;
9. runs fixed verifiers and waits for their concrete result.

The local command reports success for a worker only after its checks complete.
An offline worker is an explicit partial result. Rerunning apply recomputes
current state and converges what remains.

## Base-system maintenance

The machine base and normal factory release are separate layers. Normal
releases do not silently change operating-system packages.

Each release declares the minimum base generation it supports. If an upgrade
requires a newer base, the plan shows that fact before normal rollout. Base
updates are tested, forward-only migrations executed in place over Tailscale
SSH. They require:

- automatic dispatch to be paused;
- no active agents;
- an additional maintenance approval;
- a reboot when required;
- reconnection and base verification before worker activation continues.

Base migrations arrive in M3. Until then `plan` refuses an upgrade whose
release needs a newer base generation (D11).

Terraform changes are included in the same upgrade plan when the infrastructure
definition also changes. A changed bootstrap template alone does not pretend to
have updated an existing machine.

Immutable machine replacement and persistent-volume migration are deferred
until the storage and credential lifecycle has been designed and proven.

## Paseo and long-running agents

Paseo agents may run for days. Restarting the currently pinned Paseo daemon
terminates provider processes, active turns, managed terminals, and background
commands. Durable conversations, files, commits, branches, and worktrees
remain, but work does not continue automatically.

Every plan therefore classifies changes:

- schedule, repository, dispatch-helper, skill, and many configuration changes
  are live;
- reload-safe Paseo configuration uses Paseo's reload behavior;
- Paseo package, service definition, listen address, password, host reboot, and
  other non-reloadable changes require maintenance.

When maintenance is required and agents are active, apply pauses automatic
dispatch, leaves the worker on its complete current release, marks the upgrade
pending, and proceeds to other eligible workers. A later apply completes the
upgrade after the agents are closed, verifies Paseo, and resumes dispatch.
The first cut does not automatically interrupt active agents.

## Repositories and dispatch

Repository reconciliation preserves the existing safe posture:

- clone a missing declared repository;
- fast-forward an expected clean primary checkout;
- refuse resets, forced changes, dirty trees, divergence, and unsafe branch
  state;
- keep Paseo-owned worktrees separate;
- leave a removed repository on disk and report it as unmanaged.

FFFactory continues owning the current FFFlow/GitHub readiness logic initially,
isolated behind the `WorkflowQueue` connector. FFFlow continues owning the work
discipline inside the launched agent, and Paseo continues owning agents,
sessions, schedules, timelines, and worktrees.

Requested dispatch and active dispatch are distinct states. Apply keeps
dispatch inactive until the worker release, required human credentials,
repository synchronization, FFFlow adoption, Paseo health, and other readiness
checks pass. A later apply activates dispatch automatically when those gates
are satisfied. Disabled or pending desired state removes an existing schedule;
active state is reported only after the installed schedule matches the complete
cron, timezone, provider, model, mode and working-directory declaration.

## Human enrollment and readiness

Infrastructure success, software success, usability, and dispatch readiness
are different outcomes. The CLI and skill use the following progression:

```text
initialized
  -> environment prepared
  -> machine declared
  -> provisioned
  -> software ready
  -> enrollment pending or usable
  -> dispatch pending or active
```

GitHub, model-provider, and Paseo-client enrollment may require a human. The
managed apply can succeed while the final result states that enrollment is
pending. The CLI returns structured next actions such as authenticating GitHub
as the `factory` user on a named host. The skill explains and guides those same
steps; it does not duplicate the checks.

## Host retirement

Removing a host is a two-step operation.

1. Mark the stable host as retiring. Apply pauses dispatch, prevents new work,
   and reports active agents, unsafe repositories, credentials, and data that
   need attention.
2. After those gates are satisfied, a later reviewed removal may snapshot and
   destroy the AWS machine with a destructive-action approval.

Deleting a host entry without retirement is invalid. Renaming a stable host key
is also invalid; create a new host and retire the old one. Tailscale cleanup
remains manual and report-only in the first cut.

Retirement arrives in M3. Until then `plan` refuses to remove a host key or to
destroy or replace a host machine (D11).

## Companion skill

The executable embeds one matching `fffactory` skill. An explicit secondary
command such as `fffactory skill install` detects supported Codex or Claude
environments and installs it. Installing the CLI alone does not silently modify
agent configuration.

The skill is a thin intent and guidance layer. It:

- selects the appropriate public CLI command;
- reads versioned structured results;
- explains readiness and human next actions;
- may edit `factory.json` and prepare a plan;
- runs apply only after explicit user deployment intent;
- presents a saved plan and applies that exact plan only after approval.

The CLI owns schema validation, AWS calls, Terraform, locks, plan freshness,
release verification, SSH execution, state transitions, and safety policy.

## Failure behavior

| Condition | Behavior |
| --- | --- |
| Wrong AWS account | Refuse before planning or mutation |
| Missing backend | First apply presents a separate bootstrap approval |
| Concurrent apply | Factory-wide remote lock refuses the second operation |
| Worker offline | Mark partial, continue with other eligible workers |
| Worker blocked by active agents | Pause automatic dispatch when maintenance is needed, leave release unchanged, continue elsewhere |
| Duplicate Tailscale hostname | Refuse that host; never guess |
| Unexpected worker install or verify failure | Leave requested release active and unhealthy; stop later worker updates |
| Missing human credential | Managed setup succeeds; readiness remains pending |
| Repository dirty or divergent | Refuse synchronization and keep dispatch pending |
| Removed repository | Leave checkout and report unmanaged |
| Orphan resource | Report only |
| Configuration or live state changed after plan | Invalidate saved plan and require review of a new plan |
| Irreversible base migration | Show separately and require maintenance approval |
| Change needs a lifecycle capability not yet built (D11) | Refuse the plan and name the missing capability |

## Implementation strategy

V2 is built at the repository root: a root `package.json`, code in `src/`,
specs in `docs/specs`, and tests in `tests`, matching `.ffflow/config.yaml`
(D9).

V1 is disposable (D7). It is a single-user, non-critical deployment with
nobody to migrate, so v2 work may break or delete it freely and spends no
effort preserving, fixing, or porting it beyond reusing code where convenient.
Each epic deletes the v1 code it replaces; v1 scripts reused as wrapped steps
move into the release assets. The deployed v1 hosts keep running as-is and
build v2 through Paseo dispatch. That is safe while `main` changes because no
v1 SSM association has a schedule and repository sync is operator-triggered.
The one rule is that no v1 deploy, converge, or sync runs; AGENTS.md states it.

Reuse proven components where they fit the new boundaries:

- Terraform resources and validation;
- safe repository synchronization and FFFlow adoption checks;
- host setup logic and fixed verifiers;
- runtime, plugin, and tool pins;
- Paseo service and schedule reconciliation;
- dispatch behavior and tests.

Replace:

- checkout and `origin/main` deployment authority;
- the four-file user-facing instance model;
- SSM as artifact transport, convergence engine, and command RPC;
- Terraform state as the only operational service registry;
- clone-bound operator skills and shell orchestration.

The implementation preserves CI's rule that ordinary tests read no production
AWS account or factory state. Use fixtures and fakes for domain, application,
AWS, Terraform, SSH, and host-protocol tests. CI runs a packaged-artifact smoke
test of the native executable without Node, Bun, or a checkout.

### Milestones

Delivery is organized around the first real FFFlow run (D2). Each epic proves
its own failure paths. Development and testing use the production AWS account
and Region under a separate v2 factory ID.

M1, one usable worker:

- E1, CLI foundation: `factory.json` schema v1 and instance discovery, `init`,
  `doctor` with the AWS account check, the packaged executable with embedded
  assets, and a GitHub Release with `install.sh`. It also makes `fffactory` the
  operating authority for v2 factory IDs in AGENTS.md. No AWS mutation.
- E2, provision and install one worker: managed Terraform, namespaced modules,
  bootstrap without SSM, backend bootstrap and the factory-wide lock, saved
  plans with exact-plan approval and the D11 refusals, SSH over Tailscale,
  `host inspect|apply|verify` wrapping v1 setup steps, `status`, enrollment
  next actions, and a minimal `upgrade`. It deletes the v1 infrastructure and
  host CLIs.

The minimal `upgrade` ships in M1 because every new build must reach the test
worker, and the pin check blocks apply otherwise (D8).

M2, one completed epic, and the switch to v2:

- E3, repository, dispatch, and the switch: repository placement and
  synchronization, Paseo installation with change classification and
  busy-agent deferral, dispatch readiness gates, and end-to-end verification.

M2 is accepted when, from a workstation without a factory checkout, an operator
provisions one worker, completes human enrollment, and turns one ready epic
into a PR, and rerunning apply is safe. The switch to v2 happens then (D8).

M3, operate and expand, planned as need dictates:

- a second worker and the rollout policy;
- full `upgrade` with schema migration and backup;
- base migrations with reboot and reconnect;
- host retirement with snapshot and destroy approvals;
- inventory and orphan reporting across AWS, Tailscale, and `factory.json`;
- the companion `fffactory` skill and `skill install`;
- the full acceptance exercise.

### Refusals until lifecycle work lands

Deferring lifecycle work to M3 is safe only because `plan` refuses what it
cannot yet do (D11). Until the epic that adds the capability lands, `plan`
refuses:

- removing a host key from `factory.json` (no retirement yet);
- any Terraform plan that destroys or replaces a host machine (no retirement or
  replacement yet);
- an upgrade whose release needs a newer base generation (no base migration
  yet);
- an upgrade that changes the `factory.json` schema version (no schema
  migration yet).

Each refusal has its own spec, names the missing capability, and is removed by
the epic that adds that capability.

## Acceptance

V2 is not complete when the binary builds or Terraform creates an instance.
The switch to v2 requires the M2 acceptance statement above. V2 is complete
only when the M3 acceptance exercise proves this journey under a v2 factory ID,
from an operator workstation containing no factory checkout:

1. install the CLI from a GitHub Release with `install.sh`, and the matching
   skill;
2. initialize a partial instance;
3. diagnose and complete prerequisites;
4. bootstrap state and acquire the factory-wide lock;
5. provision an Amazon Linux worker;
6. observe its Tailscale enrollment and connect through Tailscale SSH;
7. install and synchronously verify the factory release;
8. guide GitHub, provider, and Paseo enrollment;
9. place and synchronize an FFFlow-enabled repository;
10. enable dispatch after readiness gates pass;
11. complete real FFFlow work through Paseo without an automated merge;
12. add a second machine without replacing or mutating the first unexpectedly;
13. exercise interruption, offline-worker, busy-agent, bad-plan, failed-worker,
    retirement, and resume paths.

## Explicitly deferred improvements

- AWS workload identity federation for Tailscale enrollment;
- complete Tailscale inventory through a read-only management API;
- stronger AWS-to-Tailscale identity binding than hostname matching;
- third-party or user-selectable connectors;
- alternate clouds, VPC adoption, operating systems, and CPU architectures;
- immutable AMI replacement and persistent-volume migration;
- automatic or emergency rollback and supported downgrade;
- guaranteed offline installation and operation;
- moving workflow-readiness ownership into FFFlow;
- richer release resolution that lets one CLI operate arbitrary older pins;
- automatic orphan cleanup;
- durable last-observed worker state for offline reporting.

## Adoption impact

Adopting this design intentionally changed the repository invariants:

- reviewed releases, not a fresh `origin/main` clone, became operational
  factory code;
- `fffactory` replaced v1's `./bin/factory-infrastructure` and
  `./bin/factory-host` as the operator interface;
- direct Tailscale SSH replaced SSM for normal worker operations;
- one `factory.json` replaced v1's four-file instance layout;
- multiple instances per account and Region became supported through stable
  namespacing.

The change is staged (D12). E1 rewrites the AGENTS.md invariants: `fffactory`
is the operating authority for v2 factory IDs in the production account; the
v1 `./bin/factory-infrastructure` and `./bin/factory-host` are frozen, with no
deploy, converge, or sync; and the v2 operating rules are stated (AWS account
check, exact-plan approval, factory-wide lock, no raw secrets). Without that,
E2 could not operate in the production account, since it deletes the tools the
old rules require.

The full documentation switch happened at the end of M2, when v2 had the
behavior to document ([#137](https://github.com/yaunder/factory/issues/137)):
README.md, SDLC.md, MACHINE_ONBOARDING.md and the repository skills describe
v2, and [decision 0002](../decisions/0002-fffactory-v2.md) supersedes
decision 0001. The remaining v1 code is deleted
([#139](https://github.com/yaunder/factory/issues/139)), and the v1 hosts are
retired manually.
