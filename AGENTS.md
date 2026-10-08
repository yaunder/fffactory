# Repository agent instructions

This repository builds `fffactory`, the CLI and releases that operate the
Yaunder software factory ([decision 0002](docs/decisions/0002-fffactory-v2.md),
design in [docs/designs/fffactory-v2.md](docs/designs/fffactory-v2.md)). Start
with [README.md](README.md) for the architecture.
[MACHINE_ONBOARDING.md](MACHINE_ONBOARDING.md) is the runbook for bringing a
factory and its first worker online. [SDLC.md](SDLC.md) defines the
FFFlow-based workflow the factory executes and the ownership split between
this repository, Paseo, and FFFlow. Where any document conflicts with this
file, this file governs.

## Durable invariants

### All factories

- A missing or invalid instance is an error, never a default.
- CI exercises repository code and reads no AWS account or factory state.
- Never commit credentials or raw secret values. Terraform may contain secret
  identifiers such as ARNs, but secret material stays in its external store.

### v2: `fffactory`

- `fffactory` is the operating authority for v2 factory IDs in the production
  account. Operate only behavior that has shipped; the design is not a license
  to improvise missing capabilities.
- Before any plan or mutation, resolve the AWS caller and refuse to continue if
  the actual account differs from the instance's expected account.
- Apply only the exact plan that was approved. Changed configuration, live
  state, or release identity invalidates it; review a new plan.
- One factory-wide lock covers every stage of a mutating operation. Never
  bypass it, and never break it to make progress. `fffactory lock break` is
  only for an operation confirmed dead, such as an interrupted apply, and only
  on the user's explicit request.
- Change a factory only with the `fffactory` release its factory.json pins.
  Move the pin only with `fffactory upgrade` run by the newer release, never by
  editing factory.json.
- Raw secrets never enter configuration, plans, command arguments, or logs.
  Secret material goes directly to the secret store; configuration keeps only
  its reference.

### v1: frozen

v1 is disposable and frozen. Its deployed hosts keep running as-is and build
v2 through Paseo dispatch. v2 work may change or delete v1 code freely.

- Never deploy, converge, or sync v1. Its infrastructure (`infrastructure/`)
  and host CLIs (`bin/factory-infrastructure`, `bin/factory-host`, `bin/factory`)
  were removed in [#102](https://github.com/yaunder/factory/issues/102), and no
  v1 command, read-only or not, remains. Decline requests to deploy, converge,
  sync, inspect or verify v1 hosts and say that v1 is frozen and its tooling
  removed; never recreate it from Git history or run its steps by hand.
- Never run a direct production Terraform apply against v1 state.
- v1 hosts received instance data only through Terraform-embedded SSM documents
  deployed from `main`, and never fetch it at run time. With deploys frozen and
  the Terraform removed, they receive none; nothing uploads configuration from a
  local checkout.

## Capability routing

Repository-owned runtime skills ship in the release assets. There is no
checkout-local repository skill yet; the operator-facing `fffactory` companion
skill is milestone M3.

| Skill | Capability | Excludes |
| --- | --- | --- |
| `deploy-factory-infrastructure` (removed) | Removed in v2 with v1's infrastructure ([#102](https://github.com/yaunder/factory/issues/102)). For a v2 factory ID use `fffactory plan`, `fffactory apply` and `fffactory upgrade`. | Everything: v1 infrastructure is never deployed or inspected. |
| `operate-factory-host` (removed) | Removed in v2 with v1's host CLIs ([#102](https://github.com/yaunder/factory/issues/102)). For a v2 factory ID use `fffactory status`, and `fffactory apply` to install and verify workers. | Everything: v1 hosts are never converged, synchronized or verified. |
| `dispatch` (ships in the release) | The dispatch skill and program moved into the release assets (`assets/steps/dispatch/`, [docs/specs/dispatch.md](docs/specs/dispatch.md)); apply's dispatch stage installs and activates them on a worker once every readiness gate passes. No longer a canonical repo skill, so it is not invoked from this checkout. | Infrastructure deployment, host convergence, and issue closure. |

No repository skill operates a factory yet. Operate one through `fffactory`
under the v2 rules above.

Run `./scripts/repository-skills.sh` after changing shipped skill metadata,
placement, or referenced repository commands.

## v2 code

`fffactory` is built at the repository root: `package.json`, `src/` (module
rules in [src/CLAUDE.md](src/CLAUDE.md)), release assets in `assets/`, build,
signing, smoke-test, release and repository-check scripts in `scripts/`, specs
in `docs/specs/`, and tests in `tests/`. Each directory's CLAUDE.md holds its
rules. Run `just check-all` before committing v2 code.

Releases are published only by pushing the tag `v<package.json version>`
(`.github/workflows/release.yml`). `install.sh` at the root installs them; it
is POSIX `sh` and follows the rules in [scripts/CLAUDE.md](scripts/CLAUDE.md).
Pushing a release tag is outward-facing: only on the user's request.
