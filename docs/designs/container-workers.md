# Container workers and portable execution

Status: planning brief from the October 2026 architecture discussion. This
captures the intended direction and open decisions for further planning. It
does not change shipped behavior or supersede [AGENTS.md](../../AGENTS.md),
[SDLC.md](../../SDLC.md), or the [v2 design](fffactory-v2.md).

## Intended outcome

Make a factory worker a reproducible development environment running in a
Docker container. A worker can hold multiple repositories and use a selected
execution backend: Paseo, SSH/tmux, or eventually Herdr. The factory's dispatch
rules and FFFlow development cycle remain consistent across backends.

Users can supply a base image containing their preferred development tools.
fffactory extends that image with the additional software and configuration
needed to operate a worker. Users do not need to reproduce factory directory
layouts, repository placement, or dispatch conventions in their base image.

Bryon's use case is a concrete example: retain his existing tools and supervise
agents through SSH/tmux, while another operator can use Paseo with the same
factory workflow.

## Architecture

The worker is a logical development environment. The compute host, image,
workspace, and execution backend are separate choices.

| Component | Responsibility |
| --- | --- |
| Compute host | Provides CPU, memory, storage, networking, and the container runtime. EC2 remains the initial host platform. |
| Base image | Supplies the user's preferred OS, runtimes, and development tools within a supported compatibility range. |
| Derived worker image | Adds factory integration, required tools, workflow software, backend support, and stable conventions. |
| Persistent workspace | Holds repository checkouts, task worktrees, unfinished work, and required run and session records. |
| Execution backend | Hosts agent execution and provides inspection, connection, and stop capabilities. |
| Factory dispatcher | Selects eligible work, reserves capacity, prevents duplicate launches, and records execution attempts. |
| FFFlow | Defines implementation, testing, review discipline, and the PR handoff. |

```text
User base image
  + factory software and conventions
  = versioned worker image
                |
                v
Compute host: EC2, Tailscale, container runtime
  |
  +-- Worker container
        +-- Attached persistent workspace
        |     +-- Repository A and task worktrees
        |     +-- Repository B and task worktrees
        |     +-- Run and session records
        +-- Factory dispatch and run coordination
        +-- Selected execution backend
              +-- Coding agent executing FFFlow
```

One host could eventually run several worker containers. That is a capacity
and coordination feature to plan explicitly, not an automatic consequence of
introducing Docker.

## Building and configuring the environment

The base image is a starting point, not a complete worker contract. The factory
build process may install the coding agent, FFFlow, dispatch tools, Git,
GitHub CLI, and the selected backend's dependencies. An SSH/tmux worker must
be operable without installing or running Paseo.

fffactory continues to own the expected user, directory conventions,
repository placement, startup behavior, verification, and dispatch setup.
These conventions move inside the container.

Build-time content and runtime state have different lifecycles:

| Built into the image | Supplied or attached at runtime |
| --- | --- |
| Development tools and required system packages | Repository assignments and checkouts |
| Pinned agent, workflow, and backend software | Persistent worktrees and unfinished changes |
| Factory programs and stable path conventions | Worker identity, schedule, and configuration |
| Startup and compatibility checks | Credentials and durable run/session state |

Credentials never enter the image, configuration, plans, command arguments, or
logs. Configuration retains secret references; runtime delivery must preserve
the existing secret-handling rules.

The final image must have an immutable identity tied to the reviewed worker
configuration and compatible factory release. Image replacement must protect
active work and preserve attached workspace data. Persistent files do not by
themselves guarantee that a running agent can resume after replacement.

Planning must settle how existing tools in the base image interact with
factory-managed versions. Options include accepting a verified compatible
version or installing the pinned version in a factory-owned location.

## Dispatch and execution backends

The factory already owns work eligibility policy. Today it relies on Paseo
for scheduling, launches, worktree creation, and activity observations. The
proposal removes those dependencies from shared dispatch logic.

Each backend must fulfill a common run contract:

- **Start:** launch the requested execution attempt in an isolated workspace.
- **Inspect:** report execution observations and its session/workspace mapping.
- **Connect:** provide an authorized way to observe and interact with that run.
- **Stop:** stop the intended execution while preserving work and evidence.

The backend adapter owns workspace creation and lifecycle, either through
native support or factory integration. FFFlow runs inside that workspace.
There must be one clear owner, without nested or competing worktree managers.

The dispatch trigger must work independently of Paseo. A timer inside the
worker container is the initial proposal; a central scheduling service is
not required. Workers must pick up ready work while the operator's laptop is
disconnected.

Factory run records associate a work item and execution attempt with its
worker, backend, session, and workspace. An uncertain launch must be reconciled
before retrying. An exited process is not proof of successful work; issues,
PRs, and workflow gates remain authoritative. Multiple workers competing for
the same work require coordinated claims or enforced dispatch ownership.

The [portable execution draft](portable-execution.md) defines these guarantees
in more detail. This brief adds container packaging and custom base images;
it does not replace that contract.

## Connecting and supervising

Keep Tailscale and SSH access on the compute host for administration and
terminal entry. The selected backend runs inside the worker container.

| Backend | Human connection path |
| --- | --- |
| Paseo | Laptop or phone → Tailscale → the container's exposed Paseo endpoint → existing agent session. |
| SSH/tmux | Laptop → SSH over Tailscale to host → enter container → attach to the agent's tmux session. |
| Herdr | Future adapter, after its execution and supervision capabilities satisfy the same contract. |

Paseo also supports terminal access to its own agents. Its documented CLI can
list agents, stream output, send messages, and handle permissions. A user can
therefore access the same Paseo-managed agent through the app and the CLI.
That is different from attaching to the coding agent's native interactive
terminal. A shared native terminal session controllable through both tmux and
Paseo is not established by this plan. See the
[Paseo 0.11.4 CLI reference](https://github.com/getpaseo/paseo/blob/v0.11.4/public-docs/cli.md).

Reconnectability means surviving a client disconnect while the host and
container remain healthy. Container restarts, host failures, agent recovery,
and live backend migration need separate policies.

## Repository and workflow scope

A worker may contain several repositories, as today's host placement already
allows. Repository content belongs in persistent storage rather than in the
base image. Each development run still uses an isolated task workspace.

Multiple repositories in one environment do not imply that one epic can
coordinate changes and PRs across them. Cross-repository workflow orchestration
is outside this proposal.

Retain the current GitHub readiness rules, Claude Code/FFFlow execution path,
and human review and merge boundary for the initial implementation. A backend
change does not automatically add coding-agent or tracker compatibility.

## Suggested implementation sequence

This sequence is a planning recommendation, not an approved delivery schedule.

1. Define the run contract and separate shared dispatch from Paseo calls.
   Prove equivalent unattended execution and reconnectable supervision with
   Paseo and SSH/tmux on the existing worker platform.
2. Package the worker environment in a derived image, initially with one
   persistent worker container on one host. Preserve existing capacity limits.
3. Support a user-supplied base image within a documented compatibility range,
   including additional software installation and image verification.
4. Consider multiple containers per host and Herdr after the lifecycle and
   coordination guarantees are established.

Useful acceptance scenarios include: a ready epic starts with the laptop
closed; a user reconnects to the same run; a permission request can be answered;
a lost launch response does not cause a duplicate; container replacement keeps
unfinished files; and unknown activity blocks disruptive maintenance.

## Decisions needed for detailed planning

- Supported base distributions, architectures, users, and required system capabilities.
- Where images are built and stored, and how private base images are accessed.
- How image identities and compatibility are represented in factory configuration and releases.
- The policy for tools already installed in a supplied base image.
- Exact persistent storage boundaries, backup, retention, and host replacement behavior.
- Backend-neutral run records, activity detection, and launch reconciliation.
- Network endpoint assignment and access controls when a host has multiple containers.
- Dispatch timer placement and ownership when multiple workers are introduced.
- Whether development needs additional services or container-building capabilities inside workers.

All implementation must retain AWS account verification, exact approved plans,
the factory-wide mutation lock, pinned releases, and readiness gates. Backend
selection must not silently change permission policy. v1 remains frozen; this
proposal concerns future v2 capabilities only.
