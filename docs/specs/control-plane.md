# Control plane

Each worker runs Paseo as the `factory` account. `fffactory plan` derives the
Paseo changes for every worker from factory.json, the release identity and the
worker's inspection. `fffactory apply` installs those release-owned assets and
performs the classified lifecycle action through the worker protocol. It never
uses v1 marker files, deployed input directories, global wrapper paths, SSM or
an operator-selected privileged command.

Paseo agents may run for days, and restarting the daemon ends their turns,
provider processes, terminals and background commands. Apply therefore checks
activity before it activates a worker release whenever the approved plan has a
maintenance change. Design:
[fffactory-v2.md §Paseo and long-running agents](../designs/fffactory-v2.md#paseo-and-long-running-agents).

## Planned state

The plan records, per worker, the inspection observation and every Paseo change
it will make. A worker with no active release, or whose active release differs
from the requested version or asset digest, needs `paseo-package` and
`service-definition`. A host-projection digest mismatch needs the factory-owned
Paseo settings (`listen-address`, and `password` when factory.json declares its
secret reference). The digest planned against is that of the control-plane
part of the projection the workers stage sends: all of it but its
`credentials` ([host protocol §The host projection](host-protocol.md#the-host-projection)).
It is compared with the worker's `configuration.control_plane_sha256`, or, on a
worker that reports none (one from before credential references, or one whose
file carries none), the whole file's `sha256`. So a successful apply leaves no
mismatch to plan again, and adding, changing or removing a credential reference
plans no Paseo change, on an upgraded worker or on one still on an earlier
release. An up-to-date worker is shown as `Paseo is unchanged`. Tested in
`tests/application/plan-control-plane.test.ts` and, across a real apply, the
credential case of `tests/application/apply-factory-pipeline.test.ts`
([#68](https://github.com/yaunder/fffactory/issues/68)).

`listen-address` stands for every factory-owned daemon setting the release
merges into `config.json` ([§Release-owned installation](#release-owned-installation)):
the listen address, the disabled relay and the accepted hostnames
(`daemon.hostnames`). They have no change of their own. Plan never reads
`config.json`, so a change to how a release merges them reaches an existing
worker only through that new release: its version and asset digest plan
`paseo-package` and `service-definition`, and its version, part of the
projection, plans `listen-address`. All three are maintenance, so the
[pre-activation deferral](#pre-activation-deferral) applies unchanged.

The observation and changes are part of saved `plan.json`. Apply re-inspects
existing workers under the factory lock before worker activation; a changed
observation makes the approved plan stale. A secret field in the projection is
only a validated Secrets Manager ARN. Raw secret material is never in the
projection, saved plan, arguments or output.

## Change classification

The table is closed in `src/domain/change-classification.ts`:

| Change | Class |
| --- | --- |
| `schedule`, `repository`, `dispatch-helper`, `skill`, `configuration` | live |
| `paseo-configuration` | reload-safe |
| `paseo-package`, `service-definition`, `listen-address`, `password`, `reboot` | maintenance |

A live change does not touch the daemon. A reload-safe change calls Paseo's
reload and never restarts it. A maintenance change requires restart.

## Pre-activation deferral

For an existing worker whose approved plan has maintenance, apply asks the
current active release for agent activity **before** uploading or activating
the requested worker release. Idle permits the rollout. Active or unknown
activity defers that worker: there is no upload, activation, Paseo install or
restart, and the worker remains on its complete current release. Unknown fails
safe exactly like active, so apply words every deferral as agents that *may* be
active (`maintenanceDeferral`, `src/domain/change-classification.ts`). The
workers stage skips the worker, `Paseo maintenance is deferred while agents may
be active`; the control-plane outcome is `deferred`, `Maintenance (CHANGES) was
deferred while agents may be active on HOSTNAME; it stays on its complete
current release`; both name the next action ``Close the active agents on
HOSTNAME, then rerun `fffactory apply` ``. The dispatch stage sends the worker
nothing, leaving its schedule as it is
([dispatch §Skipped workers](dispatch.md#skipped-workers)), and the
verification reports its release left as is, never absent: apply exits 2.
A later idle apply plans from the old live state and completes the change.

Reload-safe changes may reload with active agents. An active agent with no
maintenance change causes no Paseo activity lookup or lifecycle action on an
up-to-date rerun.

## Worker protocol and privilege boundary

The operator connects as `fffactory-admin`, whose only sudo authority remains:

```text
sudo -n /usr/local/libexec/fffactory-activate control-plane ACTION
```

`ACTION` is exactly `activity`, `install`, `reload` or `restart`. The
root-owned activator rejects every other token, takes the existing host
reconciliation lock, clears the environment and invokes only the active
release's `fffactory host control-plane ACTION`. The endpoint returns a
versioned JSON activity or action document.

- `activity` and `reload` drop to `factory` with `runuser` and a clean
  environment, then invoke the active release's `paseo-auth.sh`.
- `install` reads the validated host projection from standard input and sends
  only its optional secret ARN plus a newline to the active release's
  `setup-host.sh`. No configuration value is an SSH command token.
- `restart` is the fixed `systemctl restart paseo.service` action.

The infrastructure adapter uses only these fixed activator calls. The health
probe is a fixed curl to the resolved worker's Tailscale address.

## Release-owned installation

`assets/steps/control-plane/setup-host.sh` runs as root from the active release.
It installs the pinned and integrity-checked `@getpaseo/cli` as `factory`,
merges the factory-owned daemon settings into
`/home/factory/.paseo/config.json`, installs the service from the same release,
points it at that active release's auth wrapper, stores only the optional secret
ARN in a factory-owned mode 0600 file, reloads systemd and enables the unit. It
deliberately does not start or restart Paseo; the separately classified
lifecycle action does that.

Paseo answers `403 Invalid Host header` to a request whose `Host` (port aside)
is a DNS name other than `localhost` and not one of `daemon.hostnames`; an IP
address passes. Setup therefore resolves the
worker's Tailscale IPv4 address, its MagicDNS name (`tailscale status --json`'s
`.Self.DNSName`, trailing dot removed) and its short hostname, and fails if the
address or the MagicDNS name is missing. As `factory`, `paseo-config.sh` then
sets, in `config.json`:

- `daemon.listen` to `<Tailscale IPv4>:6767`;
- `daemon.relay.enabled` to `false`;
- `daemon.hostnames` to exactly `[<short hostname>, <MagicDNS name>]`, replacing
  any existing value, a `true` (any host) included.

It keeps every other setting, sets `$schema` to Paseo's config schema and
`version` to 1, and leaves the file mode 0600. A config that is not one JSON object, or whose
`daemon` is not an object, fails setup and is left as it was; a rerun leaves the
merged config unchanged. A Paseo client therefore connects to a worker by its
stable MagicDNS name, `tcp://<factory ID>-<host key>.<tailnet>.ts.net:6767`, as
well as by its Tailscale address.

`paseo-auth.sh` reads that one host's reference, fetches the value directly
from Secrets Manager, puts it only in `PASEO_PASSWORD`, and execs Paseo. The
service uses the same wrapper, so a fresh daemon hashes that password at
startup while authenticated CLI calls use it as their credential. The value
never enters an argument or log. This replaces v1's generated per-host secret
map, which v2 does not produce.

After install and its required reload or restart, apply probes health with a
bounded retry; an unhealthy or unreachable daemon fails the worker's
control-plane outcome. The
control-plane operation stage is recorded as `reconciling`, then `reconciled`,
`deferred` or `failed`, with one safe outcome per worker. It runs independently
of dispatch scheduling.

## The Paseo pin

`assets/steps/control-plane/versions.env` pins `@getpaseo/cli` 0.11.4 with its
npm registry integrity value. Setup downloads the package with `npm pack` as
`factory`, refuses one whose integrity differs from the pin, installs it into
`factory`'s npm prefix, and fails unless `paseo --version` then prints exactly
the pinned version; a worker already reporting the pin is left alone. An
existing worker reaches a new pin only through a release that carries it,
applied by `fffactory upgrade` or `apply`: the release plans `paseo-package` and
`service-definition`, both maintenance, so the
[pre-activation deferral](#pre-activation-deferral) holds the rollout while
agents may be active, and the restart that follows installation starts the new
daemon.

fffactory relies on these Paseo contracts, held by 0.11.4
([#46](https://github.com/yaunder/fffactory/issues/46)):

- The service runs `paseo daemon run --home /home/factory/.paseo`. With
  `PASEO_PASSWORD` in its environment the daemon requires that password; a CLI
  call sending a wrong one fails with `AUTH_FAILED`. 0.11.4 also writes a
  per-run `local-credential` file into its home, removed when it stops, which a
  CLI on the worker uses only when `PASEO_PASSWORD` is unset. fffactory's calls
  go through `paseo-auth.sh` and always send the password.
- `GET /api/health` answers `200` without a password, and the `Host` rule
  of [§Release-owned installation](#release-owned-installation) is unchanged.
- `paseo agent ls --json` prints a JSON array of the agents that are not
  archived and sit in a workspace that is not archived, whatever their status.
  Activity counts any entry as an active agent, so a worker is idle only when
  the array is empty.
- `paseo daemon reload` reloads the configuration without restarting.
- 0.11.4 has no migration of Paseo's persisted state from 0.9.1: a 0.9.1 home's
  `config.json` and schedules load unchanged. It needs the same Node.js 22
  runtime.

The daemon still downloads its local speech models at start: a background
download of the speech-to-text and text-to-speech models into
`~/.paseo/models/local-speech`, about 765 MB, that workers never use. Paseo
supports turning it off: with `features.dictation.enabled` and
`features.voiceMode.enabled` both `false` in `config.json` (or
`PASEO_DICTATION_ENABLED` and `PASEO_VOICE_MODE_ENABLED` false in the daemon's
environment) it requests no model and starts no download. The release sets
neither yet: `paseo-config.sh` merges only the settings of
[§Release-owned installation](#release-owned-installation).

## Layer mapping

| Concern | Layer | Where |
| --- | --- | --- |
| Change classification | domain | `src/domain/change-classification.ts` |
| Protocol documents | domain | `src/domain/control-plane.ts` |
| Plan derivation | application | `src/application/plan-control-plane.ts` |
| Deferral and reconciliation | application | `src/application/apply-control-plane.ts`, `apply-factory.ts` |
| Worker endpoint | host | `src/host/control-plane.ts` |
| SSH adapter | infrastructure | `src/infrastructure/paseo-control-plane.ts` |
| Setup, config merge, auth, unit and pin | release assets | `assets/steps/control-plane/` |
