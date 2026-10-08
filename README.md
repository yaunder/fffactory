# Factory

Licensed under the [MIT License](LICENSE), copyright Yaunder.

Maintainers: [prepare and protect a fresh public repository](docs/public-repository.md).

Monorepo for `fffactory`, the CLI that provisions and operates the Yaunder
software factory: AWS workers, reached over Tailscale, that run pinned Codex
and Claude Code harnesses, Paseo and FFFlow dispatch.

## How a factory works

A factory is one user-owned `.fffactory/factory.json`. `fffactory` provisions
its workers with bundled Terraform, then installs and verifies each worker's
release over Tailscale SSH: the toolchain, the agent CLIs and their plugins,
repository synchronization, the Paseo daemon and FFFlow dispatch. Reviewed
releases of this repository are the operational code; the operator needs no
checkout. See [decision 0002](docs/decisions/0002-fffactory-v2.md), the
[v2 design](docs/designs/fffactory-v2.md) and the specs in
[`docs/specs/`](docs/specs/).

v1, four layers converged through SSM from a checkout of `main`, is frozen
history: its infrastructure and host CLIs were removed in
[#102](https://github.com/yaunder/factory/issues/102).

## Install the `fffactory` CLI

`fffactory` ships as GitHub Releases of this repository with executables
for Apple Silicon macOS and x86-64 Linux. `install.sh` downloads the one for
your platform, verifies it against the release's `SHA256SUMS` and installs it
to `~/.local/bin`. Public downloads need no GitHub authentication.

The public repository starts with source only; the first public release has
not been published yet. Once a release is available:

```bash
curl -fsSL https://github.com/yaunder/fffactory/releases/latest/download/install.sh | sh
fffactory --version
```

Set `FFFACTORY_VERSION=0.0.2` to install a given release instead of the
latest, and `FFFACTORY_INSTALL_DIR` to install elsewhere. Installing changes no
factory instance. Then run `fffactory init` and `fffactory doctor`. See
[docs/specs/release.md §Distribution](docs/specs/release.md#distribution).

## Run the software development lifecycle

[`SDLC.md`](SDLC.md) defines the workflow the factory executes: the ownership
split between this repository, Paseo, and FFFlow, the lifecycle stages and
their gates, the readiness convention, worktree ownership, the dispatcher, and
the decisions that make FFFlow the factory's execution model.

## Bring a machine online

[`MACHINE_ONBOARDING.md`](MACHINE_ONBOARDING.md) is the step-by-step runbook
that takes a new factory from `install.sh` to an enrolled worker dispatching
ready FFFlow epics.

## Operate a factory

A factory is operated only with `fffactory`, and only by the release its
factory.json pins, under the rules in [AGENTS.md](AGENTS.md):

```bash
fffactory plan      # show and save the plan; changes nothing
fffactory apply     # apply exactly one approved plan under the factory-wide lock
fffactory status    # read-only readiness of the factory and its workers
fffactory upgrade   # run by a newer fffactory: move the pin to it and apply
```

See [docs/specs/plan-apply.md](docs/specs/plan-apply.md) and
[docs/specs/status.md](docs/specs/status.md). Before committing proposed
factory code changes, run `just check-all`, which needs no AWS credentials and
reads no factory state.

## Roadmap

The discussion draft [Portable execution and supervision](docs/designs/portable-execution.md)
maps the current glue between the factory, Paseo and FFFlow, and proposes
unattended dispatch with reconnectable supervision through alternative execution
backends, starting with terminal/tmux.

The remaining work is the v2 roadmap in
[`docs/roadmap/fffactory-v2-roadmap/`](docs/roadmap/fffactory-v2-roadmap/roadmap.md):
dependency-ordered phases, each captured as a GitHub epic. v1's layer milestones
([Layer 3](https://github.com/yaunder/factory/issues/1) and
[Layer 4](https://github.com/yaunder/factory/issues/8)) are frozen history.
