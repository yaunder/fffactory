# Repositories

factory.json's repository inventory and each host's placement decide which
repositories a worker keeps checked out, and apply's repository stage
reconciles them over Tailscale SSH by running `sync-repositories.sh`
on the worker. Design:
[fffactory-v2.md §Repositories and dispatch](../designs/fffactory-v2.md#repositories-and-dispatch)
and [§Synchronous worker reconciliation](../designs/fffactory-v2.md#synchronous-worker-reconciliation).

The repository stage is the third apply stage, after infrastructure and the
workers stage ([plan and apply §Apply](plan-apply.md#apply)), under the same
factory-wide lock and operation record. The dispatch stage consumes the
repository readiness this stage produces
([dispatch §Gate matrix](dispatch.md#gate-matrix)).

## Placement and the per-host manifest

factory.json declares repositories once in a flat inventory and places them per
host ([instance configuration](instance-configuration.md)):

- a repository has a `key`, an `https://github.com/OWNER/NAME` `remote`, a
  relative checkout `path`, and a `branch`;
- a host's `repositories` is an ordered list of inventory keys; validation
  already refuses a key no repository declares.

For one host, placement projects the version-2 manifest the sync script
reads and validates: the repositories placed on the host, one synthetic set
(`placed`) holding them in placement order, and one host entry keyed by the
worker's namespaced hostname `<factory ID>-<host key>`, which the script
resolves with `hostname --short`. Every projected repository carries
`update_policy: "fast-forward-only"`, the only policy v2 synchronizes. The
manifest's text is canonical: two-space indented JSON with a final newline.

The projection is non-secret: factory.json's repository fields hold no secret
and no secret reference. The manifest is configuration, so it reaches the
worker on standard input, never as a command token
([host protocol](host-protocol.md)).

## The repository stage

For each declared worker, in factory.json's order, the stage:

1. locates the worker in the operator's Tailscale peer view by the
   hostname-match rule and the factory's tag, exactly as the workers stage does
   ([status §Workers](status.md#workers)); a worker it cannot locate is a known
   skip that leaves the others to be attempted;
2. streams the host's projected manifest on standard input to the one privileged
   bootstrap command, `sudo -n /usr/local/libexec/fffactory-activate repositories`;
3. the activator runs the active release's fixed `host repositories --apply`
   endpoint as root. The endpoint writes only the manifest and result under
   `/var/lib/fffactory`, then runs the shipped sync program through `runuser -u
   factory` with `HOME=/home/factory`, so Git and GitHub use the runtime
   account's credentials. `fffactory-admin` receives no broader sudo rule.

Every command is a fixed `RemoteCommand` of shell-safe tokens. The stage issues
no destructive command: it never resets, force-updates, moves or deletes a
checkout, and never creates a Paseo worktree. Nothing on this path uses SSM.

The endpoint persists a versioned result containing `synchronized` or
`unresolved` and the unmanaged checkout paths. Each worker's outcome is one of:

| Outcome | When |
| --- | --- |
| `synchronized` | The manifest was delivered and the sync run exited `0`. |
| `unresolved` | The sync run exited non-zero: one or more placed checkouts were left unresolved (dirty tree, divergence, a wrong branch, an unadopted branch), each reported and left untouched. |
| `skipped` | The worker was not located, or the manifest write or the sync run did not complete (unreachable, access denied, host-key mismatch, timed out, ssh missing or unstartable). |

## The repository-sync program

`sync-repositories.sh` and its FFFlow adoption check `check-ffflow-adoption.sh`
ship as shell steps in the release assets (D3; reimplemented in TypeScript only
when next touched for another reason). From the manifest the stage delivers,
against clones under the repository root, the script:

- resolves the adoption check beside itself in the active release, never from
  a v1 installation or global command;
- clones a missing declared repository at its declared branch;
- fast-forwards a clean primary checkout already on its declared branch;
- refuses, reports and leaves untouched a wrong remote, a dirty tree, another
  or detached branch, a locally-ahead or diverged history, and a branch whose
  `.ffflow/config.yaml` is missing or not a valid FFFlow adoption;
- keeps Paseo-owned worktrees separate, never touching them;
- exits non-zero when any declared entry remains unresolved.

Its behavior is held by the shell test that ships beside it,
`assets/steps/repositories/tests/sync-repositories.sh`, run in CI (not by
`bun test`).

## Repository readiness and dispatch

Repository readiness gates dispatch: `ready` only when the sync run
synchronized every placed checkout, `pending` otherwise. A dirty or divergent
checkout therefore keeps dispatch pending until it is resolved and a later
apply synchronizes the worker. The gate is pure; the dispatch stage reads it
([dispatch](dispatch.md)).

## Unmanaged checkouts

Removing a repository from the inventory, or from a host's placement, only stops
managing its checkout. The checkout is left on disk and reported as unmanaged:
nothing deletes it, since v2 has no reviewed checkout-deletion policy. Given the
checkouts present on a worker and those factory.json still places there, the
unmanaged ones are those present but no longer placed.

The sync program finds primary checkouts by their `.git` directory and returns
the sorted difference from placed paths. `fffactory status` runs the active
release's unprivileged `host repositories --json` endpoint, reports that last
completed observation and includes every unmanaged path. An unresolved or
missing result keeps the worker not ready; an unreadable result is an error.

## Layer mapping

| Concern | Layer | Where |
| --- | --- | --- |
| Placement, the per-host manifest, repository readiness, unmanaged checkouts, the worker commands | domain (pure) | `src/domain/repository-placement.ts` |
| The repository stage over `HostTransport` | application | `src/application/apply-repositories.ts` |
| The sync and adoption programs | release assets | `assets/steps/repositories/` |
