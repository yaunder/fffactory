# 0002 — fffactory v2

Status: adopted. Supersedes [0001](0001-factory-instance-configuration.md).
See [issue #106](https://github.com/yaunder/factory/issues/106) and the
[v2 design](../designs/fffactory-v2.md).

## Decision

`fffactory` is the only way to operate a factory. It is a self-contained
executable published on this repository's GitHub Releases and installed with
`install.sh`; the operator needs no factory checkout, Node, Bun, or SSM. Its
normal commands are `init`, `doctor`, `plan`, `apply`, `status`, and
`upgrade`, with secondary subcommands such as `secret set` and `lock break`.
Reviewed releases, not a fresh `origin/main` checkout, are the operational
factory code.

A factory instance is one user-owned, non-secret document,
`.fffactory/factory.json`, and it replaces 0001's four-file instance
directory. It holds the schema version, release pin, permanent factory ID,
expected AWS account and Region, state bucket, network and Tailscale
declarations, secret references, hosts, repository inventory and placement,
and dispatch settings. A command selects it with `--instance PATH`,
`FFFACTORY_INSTANCE`, the nearest `.fffactory/factory.json` searching upward,
or `~/.fffactory/factory.json`, in that order. There is no implicit default
instance; a missing or invalid one is an error. The contract is
[docs/specs/instance-configuration.md](../specs/instance-configuration.md).

The factory ID namespaces every AWS resource name and Tailscale hostname, so
several factories can share an account, Region, and tailnet. This lifts 0001's
one-instance-per-account constraint.

Releases are pinned per factory. factory.json's `release` names the one
`fffactory` release that may plan or change the factory; a CLI of another
release may diagnose but not plan or apply. Only `fffactory upgrade`, run by
the newer release, moves the pin, never an edit to factory.json. Workers run
the pinned release.

`fffactory` drives Terraform with its bundled modules to provision machines,
and installs and verifies workers synchronously over Tailscale SSH, never SSM:
there are no SSM documents or associations, and Terraform's only SSM use is
reading the public Amazon Linux image parameter. `apply` sends each worker its
host projection, repository manifest, and dispatch projection. Of factory.json,
Terraform's first-boot user data carries only the hostname, Region, Tailscale
key reference, and tag.

Before any plan or mutation, the CLI checks the AWS caller's account against
factory.json. `apply` applies only the approved plan, and one factory-wide
lock covers every stage of a mutating operation. Secret fields hold only
Secrets Manager ARNs in the factory's own account and Region; raw secrets
never enter configuration, plans, command arguments, or logs.

CI exercises repository code and reads no AWS account or factory state.

v1 is frozen. Its infrastructure and host CLIs were removed in
[#102](https://github.com/yaunder/factory/issues/102), and no v1 command
remains. Its remaining layer directories, including the `environments/example`
instance, are deleted with the switch
([#139](https://github.com/yaunder/factory/issues/139)).

## What replaces 0001

| 0001 | 0002 |
| --- | --- |
| Instance directory with `config.json`, `infrastructure.tfvars`, `backend.s3.tfbackend`, `repositories.json`, and a future `dispatch.json` | `.fffactory/factory.json` |
| `--instance PATH`, `FACTORY_INSTANCE`, or `.fffactory/` in the checkout | `--instance PATH`, `FFFACTORY_INSTANCE`, the nearest `.fffactory/factory.json`, or `~/.fffactory/factory.json` |
| `origin/main` supplies the code; apply needs exact commit approval | The pinned release supplies the code; apply needs the exact approved plan |
| Terraform embeds `repositories.json` in the Layer 2 SSM document | `apply`'s repository stage sends each worker its repository manifest over Tailscale SSH |
| One instance per AWS account and Region | Factory ID namespacing; several factories per account and Region |
| CI validates `environments/example` with backend-disabled Terraform | CI validates `examples/factory.json` and checks the bundled Terraform modules, with no AWS access |
| Secret identifiers, never raw values | Unchanged; secret fields hold Secrets Manager ARNs |

## Acceptance

As of 2026-10-06: the M2 acceptance run on release 0.0.1
([#106](https://github.com/yaunder/factory/issues/106)) provisioned a worker,
completed human enrollment, and dispatched an epic. Its defects kept it from
showing a clean rerun; release 0.0.2
([#136](https://github.com/yaunder/factory/issues/136)) fixes them, and the
rerun on 0.0.2 is the evidence #106 still needs.

## Migration

v2 does not migrate v1 machines, Terraform state, or instance files. A v2
factory is a new deployment: `fffactory init` creates its factory.json.
Instance discovery skips a v1 `.fffactory/` directory holding `config.json`.
The operator removes local v1 instance files, retires the v1 hosts, and
deletes v1 AWS resources manually.
