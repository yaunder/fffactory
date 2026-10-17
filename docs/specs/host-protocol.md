# Host protocol

The operator's `fffactory` manages workers directly over Tailscale SSH: it logs
in as `fffactory-admin` with the system OpenSSH client and runs the worker's own
`fffactory host` subcommands, which answer in versioned JSON. Nothing uses SSM
or a daemon. Design:
[fffactory-v2.md §Machine identity and connectivity](../designs/fffactory-v2.md#machine-identity-and-connectivity)
and [§Synchronous worker reconciliation](../designs/fffactory-v2.md#synchronous-worker-reconciliation).

The same program is both sides: its Linux x86-64 worker build, which every
release bundle carries as `bin/fffactory`
([release §Worker executable](release.md#worker-executable)), is the worker's
protocol endpoint. [#100](https://github.com/yaunder/factory/issues/100) shipped
the transport and `inspect`; [#101](https://github.com/yaunder/factory/issues/101)
adds `apply` and `verify` over the same transport.

## Transport

### Finding the worker

A worker is reached only through the operator's own Tailscale peer view,
`tailscale status --json` (this device and every peer). Its output is never
printed: it describes other people's devices.

The **hostname-match rule** (`domain/tailnet.ts`): a device carries the
worker's namespaced hostname `<factory ID>-<host key>` when its reported
`HostName`, or the first label of its MagicDNS `DNSName`, equals it, ignoring
case. Nothing else matches; `name-1` is not `name`. When two devices report
the same hostname, Tailscale renames the second one's DNS label (`name-1`), but
its reported hostname still matches, so both count.

A name is not an identity: once the real device is gone, any tailnet member
can report the worker's hostname. So the one match must also carry the
factory's tag, factory.json's `tailscale.tag`, among the ACL tags the peer
view reports for it (`Tags`), compared exactly. Tags only confirm the one
match; they never narrow the search, so a duplicate name is refused even when
only one copy carries the tag.

| Devices carrying the name | Result |
| --- | --- |
| None | `missing`: refused; never guessed. |
| More than one, online or not, tagged or not | `duplicate`: refused; the operator removes the stale device. |
| One, without the factory's tag | `untagged`: refused; the operator checks the device in the admin console. The tag is never printed, only named as `tailscale.tag`. |
| One, offline | `offline`: not connected to. |
| One, online, without a well-formed Tailscale SSH host key or a Tailscale address | `no_ssh`: refused. |
| One, online, with both | Reached at its Tailscale address (IPv4 first, else IPv6). |

Only this rule creates a `WorkerAddress`, and the `HostTransport` port accepts
nothing else, so no code path can connect to a missing or duplicate name or an
untagged device. A host key is well formed when it is one line
`<type> <base64>` of a type OpenSSH accepts (ed25519, ECDSA, RSA and their
security-key forms); others are dropped.

### Host key policy

Tailscale SSH servers present an SSH host key, which each node advertises to
the tailnet and the tailnet distributes to its peers (`sshHostKeys` in the peer
view). The coordination server that tells the operator's client where the
worker is also vouches for its host key, the same trust `tailscale ssh` uses.
So every connection verifies it strictly, and nothing is learned on first use:

- the host keys of the matched device are written to a known_hosts file in a
  fresh private directory (mode 0700, the file 0600) under the system
  temporary directory, each under the worker's hostname, and the directory is
  removed when the command ends, whatever happens;
- `StrictHostKeyChecking=yes` with that file as `UserKnownHostsFile`,
  `GlobalKnownHostsFile=/dev/null`, `HostKeyAlias=<hostname>` and
  `CheckHostIP=no`, so the key is checked against the name and not the address,
  and `UpdateHostKeys=no`, so nothing is added;
- the operator's own known_hosts is never read or written.

A mismatch is refused (`host_key_mismatch`) and never bypassed: the next action
is to check the device in the Tailscale admin console.

### The ssh command

```text
ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile=<private file> -o GlobalKnownHostsFile=/dev/null
    -o HostKeyAlias=<hostname> -o CheckHostIP=no -o UpdateHostKeys=no
    -o CanonicalizeHostname=no -o ProxyCommand=none -o ProxyJump=none
    -o ControlMaster=no -o ControlPath=none -o IdentityAgent=none -o ForwardAgent=no
    -o ForwardX11=no -o ClearAllForwardings=yes -o PermitLocalCommand=no
    -o RequestTTY=no -o ServerAliveInterval=5 -o ServerAliveCountMax=3
    -o LogLevel=ERROR -o Port=22 -l fffactory-admin -- <address> <command tokens>
```

- `-F /dev/null` reads no configuration file, the operator's or the system's,
  so nothing can redirect, proxy, multiplex or forward the connection. Every
  setting is on the command line.
- `BatchMode=yes` never prompts. Tailscale SSH authenticates the operator by
  tailnet identity; no agent is consulted (`IdentityAgent=none`) or forwarded.
- `ssh` runs through the injected `ProcessRunner`, never a shell, with an
  explicit environment of `PATH` and `HOME` only: no agent socket, askpass or
  AWS variable reaches it.
- A remote command is a `RemoteCommand` of fixed tokens, each of letters,
  digits and `_ / . = : @ % + , -` only. OpenSSH joins them with spaces for the
  worker's login shell, so no token can be interpreted by that shell. Nothing
  from configuration or the peer view is ever a token.

### Outcomes

OpenSSH's own failures exit 255; its standard error is classified and never
printed. Any other exit status is the remote command's.

| Observation | Outcome |
| --- | --- |
| The command ran | `completed`, with its exit status and standard output |
| Exit 255, `Host key verification failed` or `REMOTE HOST IDENTIFICATION HAS CHANGED` | `host_key_mismatch` |
| Exit 255, `Permission denied` or `tailnet policy does not permit` | `access_denied`: tailnet SSH policy |
| Exit 255, anything else | `unreachable`, with a reason fffactory words: timed out, refused, no route, dropped, or "ssh could not connect" |
| Not finished within the command's timeout | `timed_out` |
| `ssh` not on PATH | `client_missing` |
| `ssh` could not be started | `not_started`, with the error code |

Remote commands never exit 255 themselves.

`HostTransport.run(worker, command, { timeoutMs, stdin })` is the port
(`application/host-transport.ts`). `stdin`, when given, is streamed to the
remote command's standard input, which is then closed; without it standard
input is closed at once. An upload is one more fixed command reading it, so no
file name, content or configuration value ever becomes an argument.

The repository stage has one additional privileged command, still through the
same sole sudoers entry:

```text
sudo -n /usr/local/libexec/fffactory-activate repositories
```

The activator accepts that exact word only, takes its existing lock, and
replaces itself with the root-controlled active release's `fffactory host
repositories --apply`. The endpoint writes fixed state paths and drops to the
`factory` account before invoking Git or GitHub. Status reads the result without
sudo using `fffactory host repositories --json`.

The same sole sudo entry exposes four fixed Paseo operations:

```text
sudo -n /usr/local/libexec/fffactory-activate control-plane activity
sudo -n /usr/local/libexec/fffactory-activate control-plane install
sudo -n /usr/local/libexec/fffactory-activate control-plane reload
sudo -n /usr/local/libexec/fffactory-activate control-plane restart
```

The activator accepts no other action, uses the same host-reconciliation lock
and invokes the active root-owned release's `host control-plane` endpoint in a
clean environment. Activity and reload drop to `factory`; install reads the
host projection on standard input and passes only its validated Paseo secret
ARN to the active release's setup program; restart is a fixed systemd action.
Responses are versioned JSON. See [control plane](control-plane.md).

Dispatch adds three more fixed operations through that same activator and lock:

```text
sudo -n /usr/local/libexec/fffactory-activate dispatch adoption
sudo -n /usr/local/libexec/fffactory-activate dispatch reconcile
sudo -n /usr/local/libexec/fffactory-activate dispatch inspect
```

The activator accepts no other dispatch action and always invokes the active
root-owned release. `adoption` drops to `factory` and runs the active release's
dispatcher in adoption-only mode against the placed-repository manifest; it
does not launch work. `reconcile` reads the canonical desired dispatch
projection from standard input. An active projection installs the stable
dispatcher and skill; every projection drops to `factory` to reconcile the
schedule, and persists the desired and observed documents. `inspect` reads that
result and checks the real schedule, without changing it. Exit 2 means a
genuine adoption/readiness pending state; malformed input or reconciliation
failure exits 1. See [dispatch](dispatch.md).

Terminate reads a worker's current work through one more, read-only, fixed
operation of that activator and lock
([work inspect](#work-inspect)):

```text
sudo -n /usr/local/libexec/fffactory-activate work inspect
```

## Versioning

Every document carries `protocol_version`, the protocol's major version,
currently `1`. Adding a field keeps it, and readers ignore fields they do not
know. Removing, renaming or redefining a field, or adding a state value, needs
a new major version. The CLI rejects any other major version
(`unsupported_protocol`) before reading anything else, and names the fix: use
the release factory.json pins. The apply and verify documents and `installation`
first ship in #101's release, so they are part of version 1; no earlier release
sent them.

## inspect

```text
/opt/fffactory/current/bin/fffactory host inspect --json
```

The CLI runs the active release's executable. `host inspect` runs unprivileged
as `fffactory-admin`, needs no factory.json, and reads only the worker's own
filesystem and systemd. It changes nothing, and prints one JSON document,
indented by two spaces, on standard output. Without `--json` it refuses (exit
1).

### What it reads

| Path | Written by | Read as |
| --- | --- | --- |
| `/opt/fffactory/current` | `host apply` | A symbolic link `releases/<version>`. Absent: no release. |
| `/opt/fffactory/releases/<version>/.fffactory-assets.json` | the activator ([worker bootstrap §Activator](worker-bootstrap.md#activator)) | The marker `{"release", "sha256"}`; it must record `<version>` and a SHA-256. |
| `/var/lib/fffactory/host.json` | `host apply` | The host's configuration; its SHA-256 is reported, and, when it is a host projection carrying `credentials`, that of its control-plane part apart ([§The host projection](#the-host-projection)). |
| `/var/lib/fffactory/last-apply.json` | `host apply` | The last install's record ([apply](#apply)), summarized as `installation`. |
| `/var/lib/fffactory/bootstrap-complete` | bootstrap | Present: bootstrap finished. |
| `/etc/os-release` | the base image | `ID` and `VERSION_ID`, quoted or not. |
| `systemctl is-active tailscaled.service` | systemd | The service's state, run with `PATH=/usr/sbin:/usr/bin:/sbin:/bin` and `LANG=C`, with a 5 s timeout. |
| `statfs` of `/opt/fffactory/releases`, or its nearest existing parent | the kernel | Bytes available to unprivileged users. |

The hostname is the OS hostname, and the architecture the machine hardware
name (`uname -m`). A value that is not a short token of letters, digits, `.`,
`_` and `-` is reported as `unknown`.

### Document, protocol version 1

```json
{
  "protocol_version": 1,
  "hostname": "fff-aaaa1111-builder-1",
  "release": { "state": "active", "version": "0.3.0", "sha256": "<64 hex digits>" },
  "configuration": { "state": "present", "sha256": "<64 hex digits>" },
  "installation": {
    "state": "succeeded",
    "release": "0.3.0",
    "configuration_sha256": "<64 hex digits>",
    "failed_step": null,
    "started_at": "2026-09-30T12:00:00.000Z",
    "finished_at": "2026-09-30T12:09:00.000Z",
    "verification": { "...": "the verify document, below" },
    "failure": null
  },
  "services": [{ "name": "tailscaled", "state": "active" }],
  "evidence": {
    "bootstrap_complete": true,
    "os": { "id": "amzn", "version_id": "2023" },
    "architecture": "x86_64",
    "available_bytes": 21474836480
  }
}
```

| Field | Values |
| --- | --- |
| `release` | `{"state": "none"}`: no `current` link, the explicit empty state. `{"state": "active", "version", "sha256"}`: the link names a release whose marker records it. `{"state": "broken"}`: anything else (not a link, another target, a missing or mismatched marker). |
| `configuration` | `{"state": "none"}`: no file. `{"state": "present", "sha256"}`, and `control_plane_sha256` after it when the file is a host projection carrying `credentials`: the SHA-256 of its control-plane part, the projection without them. Absent, the whole file is that part, as on a worker from before credential references. `{"state": "unreadable"}`: it exists but cannot be read. |
| `installation` | `{"state": "none"}`: no record. `{"state": "unreadable"}`: a record that cannot be read as one. Otherwise the record's `state` (`running`, `succeeded` or `failed`), `release`, `configuration_sha256`, `failed_step` (the first failed step's name, or null), `started_at`, `finished_at`, `verification` (the verify document, or null) and `failure` (the record's, below; absent reads as null). A worker that reports no `installation` field, from before #101, reads as `none`. |
| `services[].state` | What `systemctl is-active` prints: `active`, `reloading`, `refreshing`, `inactive`, `failed`, `activating`, `deactivating`, `maintenance`; else `unknown`, as when it cannot run. |
| `evidence.os` | `null` when os-release is unreadable or lacks either value. |
| `evidence.available_bytes` | `null` when it cannot be measured. |

Keys keep this order (`hostInspectionJson`). The worker reports; the CLI
judges (readiness rules: [status §Readiness](status.md#readiness)).

### The CLI side

| Result of running it | Reads as |
| --- | --- |
| Exit 0 and a valid document | `inspected` |
| Exit 127: the worker's shell found no `current/bin/fffactory` | `no_release`, the same empty state as `{"state": "none"}` |
| Exit 0 and output that is not a valid document | `failed`, naming the first malformed field, never quoting the output |
| Another major version | `unsupported_protocol` |
| Any other exit status | `failed` |
| `timed_out` (30 s) or `unreachable` | `unreachable` |
| `access_denied`, `host_key_mismatch`, `client_missing` | themselves |
| `not_started` | `failed` |

## apply

Apply's workers stage ([plan and apply §The workers stage](plan-apply.md#the-workers-stage))
installs the release on a worker with two fixed commands over the transport:

```text
dd of=/home/fffactory-admin/fffactory-release.tar.gz bs=1M status=none
sudo -n /usr/local/libexec/fffactory-activate /home/fffactory-admin/fffactory-release.tar.gz <sha256>
```

1. **Upload.** `dd` writes its standard input, the running executable's embedded
   release tarball, to the upload path in `fffactory-admin`'s private home
   (0700), replacing what was there; 15 minutes at most. The copy needs no
   integrity of its own: the activator verifies what it reads.
2. **Activate.** The activator, through the one sudoers entry bootstrap wrote,
   verifies the tarball against `<sha256>`, the digest the running executable
   embeds for it (D4), unpacks it and replaces itself with that release's
   `bin/fffactory host apply` as root
   ([worker bootstrap §Activator](worker-bootstrap.md#activator)). The host
   projection is streamed on standard input, which the activator passes to
   `host apply`. The CLI waits for every step's timeout plus verification and
   five minutes (`ACTIVATION_TIMEOUT_MS`, 82 minutes).

### The host projection

The part of factory.json one worker needs (`domain/host-projection.ts`), sent
on standard input and kept as `/var/lib/fffactory/host.json`:

```json
{
  "protocol_version": 1,
  "factory_id": "fff-aaaa1111",
  "host_key": "builder-1",
  "hostname": "fff-aaaa1111-builder-1",
  "release": "0.3.0",
  "paseo_password_secret": "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-aaaa1111/paseo-password-builder-1-AbCdEf",
  "credentials": {
    "github_token_secret": "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-aaaa1111/github-token-AbCdEf",
    "anthropic_api_key_secret": "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-aaaa1111/anthropic-api-key-AbCdEf",
    "openai_api_key_secret": "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-aaaa1111/openai-api-key-AbCdEf"
  }
}
```

`paseo_password_secret` is present exactly when the host declares
`hosts[].paseo_password_secret`: a validated Secrets Manager ARN, the
reference the [control plane](control-plane.md) installs Paseo's password
from, never the password it names. `credentials` holds the references of the
API credentials delivered to the host
([instance configuration §API credentials](instance-configuration.md#api-credentials),
`deliveredAccounts`): each `credentials.*_secret` factory.json sets whose
account the host does not list in `interactive_logins`, under the same field
name, in this order. It is absent when none is delivered, never empty. The
`credentials` install step reads them on the worker and delivers each to its
tool ([credential delivery](credential-delivery.md)). The projection holds
no secret material, and never appears in an argument, a plan or a log.
`release` is the release factory.json pins, which the CLI/pin match guard makes
the running one's. No other factory-wide reference is projected: the worker
reads its Tailscale key only at first boot, through Terraform, and the
operator's Tailscale admin client, `tailscale.admin_client_secret`, never
reaches a worker
([secrets §The Tailscale admin client](secrets.md#the-tailscale-admin-client)).
Repositories and dispatch travel in their own documents
([repositories](repositories.md), [dispatch](dispatch.md)).

Its text is canonical: keys in this order, two-space indented, one final
newline. `host apply` refuses any other text, so the file it keeps has exactly
the SHA-256 the CLI computes for it.

Its *control-plane part* (`controlPlaneProjection`) is the projection without
`credentials`: what a projection was before credential references, and all
the control plane installs from. The control-plane plan digests only that part
([control plane §Planned state](control-plane.md#planned-state)), and `host
inspect` reports its digest apart from the file's, so adding, changing or
removing a credential reference plans no Paseo change. `status` still compares
the whole file's digest: a changed reference is a configuration apply has not
delivered yet.

There is one projection per host, built from factory.json's host as it
stands, and its delivered references from the instance's `credentials`: the workers stage sends the ones `projectHosts` builds from the
instance itself, the control-plane stage installs Paseo from it, and plan and
`status` compare its digest with the one `host inspect` reports
([status §Readiness](status.md#readiness),
[control plane §Planned state](control-plane.md#planned-state)); those
build it with `projectHost` from the host they took from factory.json's
`hosts`. So after a successful apply the next plan finds the worker's
configuration current and `status` finds it ready. The types do not prevent a
narrower projection, one built from a host key alone without the Paseo secret
reference ([#132](https://github.com/yaunder/factory/issues/132)): the
instance-taking `projectHosts` keeps the workers stage's caller from holding
one, and the pipeline test catches any stage that drifts from the others: it
applies to a host with a Paseo password reference, checks that `host apply`
and the Paseo install both received the projection with the reference, and
then expects the next plan to find no change and `status` to find the host
ready.

### `host apply` on the worker

```text
fffactory host apply
```

No arguments: the activator passes none. In order, it:

1. **Refuses, changing nothing**, unless it runs as root (`not_root`) and takes
   the **install lock** (`busy`): an exclusive `flock(2)` on
   `/run/fffactory-host-apply.lock` (0600), taken without waiting and held until
   it ends (`host/install-lock.ts`). The kernel releases it when `host apply`
   exits, however it ends, and the file is opened close-on-exec, so no step
   inherits it. The operator's factory lock serializes operations, but an
   activation timeout, a dropped connection or an interrupted `fffactory apply`
   stops only the operator's `ssh`: `host apply` runs on, since it has no
   terminal to hang up, and a rerun must not start a second install beside it.
   Then it refuses unless standard
   input is a canonical host projection of at most 64 KiB
   (`invalid_configuration`), the projection's hostname is this worker's OS
   hostname, compared without case (`other_host`), its release is this
   executable's (`release_mismatch`), that release is unpacked under
   `/opt/fffactory/releases` with the activator's marker
   (`release_missing`), bootstrap has finished (`bootstrap_incomplete`), and
   the base is Amazon Linux 2023 (`unsupported_base`).
2. **Records the install as running** in `/var/lib/fffactory/last-apply.json`
   (0644), every step `not_run`.
3. **Keeps the projection** as `/var/lib/fffactory/host.json` (0644), written
   to a flushed private copy renamed into place.
4. **Makes the release active**: a new symbolic link `releases/<version>`
   renamed over `/opt/fffactory/current`, so the link is never absent or half
   made. From here the requested release is active, healthy or not.
5. **Runs the install steps** in order, in this one process: `packages`,
   `user`, `systemd`, `harness`, `plugins`, `credentials` (`INSTALL_STEPS`,
   `domain/installation.ts`). The first four run `/bin/bash <release>/steps/<name>.sh` as
   root with their own timeouts and only `PATH`, `HOME=/root`, `LANG` and its
   inputs in the environment: `FFFACTORY_RELEASE`, `FFFACTORY_STEPS` (the
   release's steps directory, holding the pins and plugin manifest),
   `FFFACTORY_STATE`, `FFFACTORY_HOSTNAME`, `FFFACTORY_FACTORY_ID` and
   `FFFACTORY_HOST_KEY`. A step's standard output and error go straight to
   `/var/log/fffactory/<step>.log` (truncated, 0644, readable by
   `fffactory-admin`) as it runs, never to the document, so a step that hangs
   or a `host apply` that is killed still leaves what it printed; a last line
   `--- fffactory: step <name> succeeded` (or `failed: <reason>`) ends it. A
   log that cannot be opened fails its step without running it. The record is
   rewritten after each step. It **stops at the first step that fails** (a
   non-zero exit, its timeout, or bash missing or not starting); the later
   steps stay `not_run`. Nothing waits for or polls a marker file: the process
   orders the steps. The `plugins` and `credentials` steps run in TypeScript
   inside the same install lock and record, each with its own command budget and
   log: `plugins` as described below, `credentials` as
   [credential delivery](credential-delivery.md) describes, given the
   projection's `credentials` references.
6. **Verifies**, once every step succeeded: the verifiers of `host verify`, in
   process ([verify](#verify)), within `VERIFY_TIMEOUT_MS` (5 minutes);
   verification that takes longer fails the install.
7. **Records and prints** the final record: `succeeded` when every step
   succeeded and every check passed (enrollment pending or not), else
   `failed`. Exit 0 for `succeeded`, 1 otherwise.

Anything that fails after the install is recorded as running, outside a
step's own exit (a record, configuration or link it cannot write, such as a
directory where `/opt/fffactory/current` belongs, or verification past its
bound), fails the install: `failure` names what it was doing and the error
code, the record is kept as far as it can be, and it is printed all the same,
so the CLI always gets a document.

A `host apply` sent SIGINT, SIGTERM or SIGHUP, such as by a shutdown, stops
its running step and then exits at once with 128 plus the signal's number,
never waiting for the install to finish
([plan and apply §Interruption](plan-apply.md#interruption)): its record may
stay `running`, which `status` reports as an install that has not finished
([status §Readiness](status.md#readiness)).

The shell steps (`assets/steps/`) are v1's development-environment and
agent-harness setup scripts, wrapped (D3; the originals were deleted in
[#102](https://github.com/yaunder/factory/issues/102)): split into install steps, taking
their inputs from the environment above, without their marker waits and state
records. Each is idempotent, so a rerun repairs what a failed run left. A
failed install leaves the requested release active and unhealthy; `status`
reports it and the next apply repairs it. Nothing on this path uses SSM.

| Step | Does |
| --- | --- |
| `packages` | Amazon Linux packages (Git, Git LFS, GCC, Make, jq, Node 22 and npm, Python 3.11, ...), Node 22 as the default, the GitHub CLI, and a checksum-verified ripgrep. |
| `user` | The runtime account's `/workspace` directories, private `.codex` and `.claude`, login profile, npm prefix, and the system's Git defaults. |
| `systemd` | `tailscaled.service` enabled and active. |
| `harness` | Codex's system requirements, then Codex and Claude Code for `factory` at the versions and npm integrity values `versions.env` pins ([Agent pins](#agent-pins)). |
| `plugins` | The Claude Code plugins `plugins.json` pins, from marketplace checkouts at their pinned revisions; undeclared ones removed. |
| `credentials` | The API credentials delivered to the host, read from Secrets Manager with the instance role and written to each tool's own store, the material only on standard input; Claude Code's key file, and its managed settings while they name fffactory's API key helper, removed when Anthropic is not delivered ([credential delivery](credential-delivery.md)). |

### Agent pins

`steps/versions.env` pins Codex 0.163.0 and Claude Code 2.1.302, each with its
npm registry integrity value. The `harness` step downloads each package with
`npm pack` as `factory`, refuses one whose integrity differs from its pin, and
installs both into `factory`'s npm prefix; agents already reporting their pins
are left alone. Readiness's `agents` check compares the same pins
([readiness](readiness.md)).

Before installing, on every worker and whether or not any credential is
delivered, the step writes `/etc/codex/requirements.toml`, root:root 0644 in a
root:root 0755 `/etc/codex`, with exactly:

```toml
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
[features]
daemon_auto_start = false
```

Codex enforces its requirements file on every process, `codex app-server`
(Paseo's launch path) included: neither `factory`'s `~/.codex/config.toml` nor
`-c` overrides it, and `factory` cannot write it. Codex 0.163.0 turns
`daemon_auto_start` on by default: a persistent server that keeps stale keys
across sessions and carries an auto-updater that could move it off the pin.
The file turns that off, stops the update check, and keeps credentials in the
file store, since a headless worker has no keyring. The step writes it whole
beside the target and renames it over whatever was there, resetting the
directory's owner and mode, so a rerun leaves the same bytes. It holds no
trust entries and no credential.

### Plugin installation

`src/host/plugins.ts` implements the `plugins` step and the read-only plugin
verifier; `plugin-manifest.ts` validates the release's `steps/plugins.json`.
The manifest keeps exact semver versions and full Git commit SHAs, unique
plugin IDs and marketplace names, safe relative paths, GitHub sources only,
and no Codex plugins. Invalid or unreadable metadata fails before mutations.

The marketplace catalog supplies the marketplace name and the plugin's source
path. Its catalog version and any per-entry version are not the plugin pin:
`<plugin path>/.claude-plugin/plugin.json` supplies the authoritative plugin
name and version. Both catalog formats, with or without per-entry versions,
are supported. Multiple plugins may be listed in the catalog; only declared
plugins are installed.

Verification requires a clean marketplace checkout at the exact pinned SHA,
the declared catalog mapping and plugin manifest, the directory marketplace
registration, exactly one enabled user-scope installation at its expected
cache path, an installed registry entry recording the pinned SHA, and content
identical to the pinned source. Undeclared user plugins or marketplaces fail
verification. Verification never installs, removes or fetches anything.

Installation removes undeclared user plugins and marketplaces, leaves matching
pins alone, and repairs drift by cloning the declared upstream repository,
checking out its pinned commit detached, validating its metadata, and installing
from that local marketplace. It verifies the result before succeeding. Project
scope plugins are left alone. Failed inspection or commands fail the step;
untrusted names are validated before being used as removal paths.

Git, Claude and content comparison run as `factory` with `runuser` and `env -i`.
Root directory creation and cache cleanup use fixed tools and rooted paths.
One deadline bounds all commands in each install or verification operation;
mutation output streams to the step log and inspection output stays private.
This step runs inside `host apply`'s existing lock; no new mutating CLI is exposed.
Tests: `tests/host/plugins.test.ts`, the native step cases in
`tests/host/apply.test.ts`, and `tests/host/verify.test.ts`.

### Document, protocol version 1

`host apply` prints its record, which is also what it keeps:

```json
{
  "protocol_version": 1,
  "hostname": "fff-aaaa1111-builder-1",
  "state": "failed",
  "release": "0.3.0",
  "configuration_sha256": "<64 hex digits>",
  "started_at": "2026-09-30T12:00:00.000Z",
  "finished_at": "2026-09-30T12:04:00.000Z",
  "steps": [
    { "name": "packages", "status": "succeeded", "reason": null },
    { "name": "user", "status": "succeeded", "reason": null },
    { "name": "systemd", "status": "succeeded", "reason": null },
    { "name": "harness", "status": "failed", "reason": "exited with status 1" },
    { "name": "plugins", "status": "not_run", "reason": null },
    { "name": "credentials", "status": "not_run", "reason": null }
  ],
  "verification": null,
  "failure": null
}
```

A refusal is `{"protocol_version", "hostname", "state": "refused", "reason",
"message"}`, with one of the reasons above. `reason` is given exactly for a
failed step, in fffactory's own words; `failure` is null unless the install
failed outside its steps and checks, and a record without it reads as null.
Keys keep these orders (`hostApplyJson`).

### The CLI side

| Result | Worker outcome |
| --- | --- |
| The worker is not found in the tailnet ([Finding the worker](#finding-the-worker)) | skipped, with status's next action, ending "then rerun `fffactory apply`."; a worker whose machine this apply created is waited for while it is missing, offline or lists no SSH host key ([plan-apply §Waiting for a new worker](plan-apply.md#waiting-for-a-new-worker)) |
| The upload: `unreachable`, `timed_out`, `access_denied`, `host_key_mismatch`, `client_missing` | skipped |
| The upload: `dd` exits non-zero, or ssh does not start | failed |
| A document whose `hostname` is not the worker's (compared without case), or a record of another release than the one installed | failed: nothing else in it is trusted |
| The activation: a document `succeeded` | installed, with its verification |
| A document `failed` | failed: the failed step and its reason, and how to read its log (`tailscale ssh fffactory-admin@<host> cat /var/log/fffactory/<step>.log`); or its `failure`, the release possibly active but unhealthy; or the failed checks |
| A document `refused` for `bootstrap_incomplete` | skipped: wait for the first boot; a worker this apply created is activated again until its bootstrap finishes, or fails at the first boot deadline |
| A document `refused` for `busy` | skipped: "An install is still running on HOST"; wait for it to finish, then rerun `fffactory apply` |
| Any other refusal, a `running` record, or `succeeded` without verification | failed |
| No document: by the activator's exit status (64 arguments, 65 digest or content, 75 another activation, 77 not root, 127 no activator or sudo, 1 sudo refused) | failed |
| Another major version, or output that is not a document (never quoted) | failed |
| The activation times out, or the connection drops | failed: the worker may still be installing; wait for that install to finish (`fffactory status` shows its record), then rerun `fffactory apply`, which skips the worker while it runs |

A skip leaves the rollout going; a failure stops it before the next worker,
except a new worker's first boot not finishing in time, on which no install
step ran.

## verify

```text
fffactory host verify --json
```

The fixed TypeScript verifiers (`host/verify.ts`) and the enrollment checks
([readiness](readiness.md)). They check the runtime account's own tools and
credentials, so they need root: `host apply` runs them in process after its
steps, since only the activator gives root, and `host verify` run without root
refuses (exit 1). They change nothing and never echo what a tool printed.

### Document, protocol version 1

```json
{
  "protocol_version": 1,
  "hostname": "fff-aaaa1111-builder-1",
  "verified_at": "2026-09-30T12:09:00.000Z",
  "checks": [
    { "id": "factory_account", "status": "passed", "summary": "The factory account exists" },
    { "id": "toolchain", "status": "passed", "summary": "Every development tool runs, with Node 22 by default" }
  ],
  "enrollment": [
    { "id": "github", "state": "enrolled" },
    { "id": "openai", "state": "pending" },
    { "id": "anthropic", "state": "pending" }
  ]
}
```

`checks[].status` is `passed` or `failed`; `enrollment[].state` is
`enrolled`, `pending` or `unknown`, for the accounts `github`, `openai` and
`anthropic`. Summaries are fffactory's own printable one-line text. The
document carries states only, never instructions: the CLI names each
account's next action itself, from its `id` and the hostname the CLI resolved
([readiness §Enrollment](readiness.md#enrollment)), and ignores anything else
a worker sends with an account. So a compromised worker cannot put a command
in front of the operator.

## work inspect

```text
sudo -n /usr/local/libexec/fffactory-activate work inspect
```

What terminate destroys with a running worker's root volume, read just before
it does ([worker lifecycle §Gates (terminate)](worker-lifecycle.md#gates-terminate)).
The repository result (`host repositories --json`) is the last
synchronization's, so work made after it, such as an untracked file in a
checkout that synchronized cleanly, is only seen here.

The activator accepts exactly `work inspect`, takes its lock (exit 75 while
another activation or host reconciliation holds it), and replaces itself with
the active root-owned release's `fffactory host work inspect` in a clean
environment (exit 65 without one). An activator from before this operation
refuses it as a usage error, exit 64: a worker's activator is installed at its
first boot and never updated ([worker bootstrap §Activator](worker-bootstrap.md#activator)).
`host work inspect` refuses unless it runs as root, then reads as the runtime
account `factory`, which owns the checkouts.

### What it reads

1. **Working trees.** Every directory holding a `.git` (a directory or a
   file) under `/workspace/repos`, at most 4 levels down, then under
   `/home/factory/.paseo/worktrees`, where Paseo creates its worktrees
   ([SDLC §Worktree ownership](../../SDLC.md#worktree-ownership)), at most 3
   levels down; nothing below a working tree, and no symbolic link, is
   followed. Directories are listed as root, without reading any file. A
   search root reached through a symbolic link (the root itself or any
   directory above it, such as `/home/factory/.paseo`) is not searched, as
   `sync-repositories.sh` refuses a symlinked repository root. A directory at
   the depth limit that is no working tree but holds directories is not
   searched further: a checkout could be below it (factory.json places
   checkouts at any depth). A directory that is no working tree but looks
   like a bare repository (`HEAD`, `objects/` and `refs/`) is not inspected,
   nor searched: a clone whose remote it is would count commits pushed only
   there as on a remote, though they are lost with the worker. Any of these
   leaves the inspection incomplete, never reads as no work. A symbolic link
   to a directory below a search root, unlike a search root reached through
   one, is not followed and reads as no work: work reachable only through it
   is not inspected. Nothing below a working tree is searched: a repository
   inside a checkout that is not a submodule is seen only as the untracked
   directory `git status` reports there, so anything inside a directory Git
   ignores, a repository included, is not inspected.
2. **Repositories.** For each working tree not already covered by an earlier
   repository, `git worktree list --porcelain -z` names its repository's
   worktrees, wherever they are; an answer that does not list the tree itself
   (Git found a repository in a parent directory) makes it unreadable. `git
   rev-parse --git-common-dir` names the repository's own Git directory. Then,
   once per repository: `git rev-list --count --branches --not --remotes`
   (commits on local branches that no remote-tracking branch holds); when there
   are some, at most 10,000, `git rev-list --branches --not --remotes` and
   `git for-each-ref refs/heads`, naming the first 10 branches whose tip is
   among those commits; and `git stash list` (only counted). "On a remote"
   means held by any remote-tracking ref (`refs/remotes/`), whatever the
   remote's URL: a remote that is a local path counts. Commits reachable only
   from the reflog, a tag or a note are not counted as work.
3. **Worktrees.** For each worktree the repository lists (a bare entry
   skipped): commits reachable from its HEAD that no remote-tracking branch
   holds (`git rev-list --count HEAD_ID --not --remotes`); then, unless Git
   marks it prunable or its directory is gone (`missing`), its own Git
   directory (`git rev-parse --absolute-git-dir`), which must be the
   repository's Git directory or one in its `worktrees/`. Git still lists a
   worktree removed without `git worktree prune` when another repository has
   since been made at its path, and does not mark it prunable; such an entry
   is `unreadable` (only its recorded HEAD counted), and that path is not
   covered by this repository: found under a search root, it is inspected as
   the repository it is. Every other worktree is covered. Then `git status
   --porcelain=v2 --untracked-files=normal --ignore-submodules=none -z`, counted
   as tracked changes (`1`, `2`, `u` entries) and untracked files (`?`), and
   whether that Git directory holds `MERGE_HEAD`, `rebase-merge`,
   `rebase-apply`, `CHERRY_PICK_HEAD` or `REVERT_HEAD`. A `git status` that
   writes anything on standard error makes the worktree `unreadable`, though it
   exits 0: it does so for a directory it could not open (`warning: could not
   open directory`), whose files it does not count. Then `git ls-files -v
   --stage -z` reads the index: an entry Git is told to assume unchanged (a
   lowercase tag) or marked skip-worktree (`S`) whose file is on disk hides an
   edit from `git status`, and makes the worktree `unreadable`. A sparse
   checkout's skip-worktree files, absent from the worktree, are not work.
4. **Submodules.** Each submodule (an index entry of mode `160000`) of a
   worktree inspected in step 3 is a repository of its own, reported after
   the repository holding it, its path the submodule's directory. A directory
   without `.git` that is empty, or no directory, holds nothing to lose; one
   holding files is `unreadable`: `git status` does not report files in a
   submodule's directory that is not populated. A populated one (`.git`
   present) is the submodule's own only when `git rev-parse --show-toplevel
   --git-common-dir` there names that directory and a common Git directory in
   the worktree's own Git directory's `modules/` (absorbed), or its own `.git`
   directory; otherwise (its `.git` leads to another repository, or Git found
   one in a parent directory) it is `unreadable`. Its worktrees are those `git
   worktree list` names there, the first, which Git names by the submodule's
   Git directory, being the submodule's directory itself; it is then inspected
   as in steps 2 and 3, and its own submodules as here. A Git directory in the
   worktree's `modules/` (at most 4 levels down) that no populated submodule
   of it uses, left by `git submodule deinit` or by a branch without the
   submodule, is reported `unreadable` at its path: its commits are not read,
   but would be lost with the worker. Submodules count against the 100
   repositories.

Every Git command runs as `/usr/sbin/runuser -u factory -- /usr/bin/env -i
HOME=/home/factory PATH=/usr/local/bin:/usr/bin:/bin LANG=C LC_ALL=C
GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git --no-pager -c
core.fsmonitor=false -c filter.lfs.process= -c filter.lfs.clean= -c
filter.lfs.required=false -C DIRECTORY ...`, each within 20 s. It changes
nothing: optional locks off, `git status` neither refreshes nor writes the index
and takes no lock file; nothing fetches, prunes or writes a ref; no fsmonitor
hook runs. Workers install Git LFS system-wide (`git lfs install --system`),
whose clean filter `git status` would run on a file whose stat no longer
matches the index, writing it into `.git/lfs/objects`; the LFS filter is
disabled instead, so Git compares such a file as it is on disk with the
pointer it committed, and it reads as changed: the safe side. An LFS file
whose stat matches the index reads as it is. One is stat-stale when it was
touched since a Git command last refreshed the index, or written within the
same second as the index, as a fresh clone or checkout leaves it until the
next `git status` refreshes it; `git status` as `factory` in that checkout
clears it. A clean filter a repository's own configuration defines under
another name still runs when such a file is compared, as `factory`, the account
that owns the repository and whose configuration defines it: no more trust
than the runtime account already has. No file's content or name reaches the
document, only counts. It starts no Git command after 75 s, nor inspects more
than 100 repositories (submodules among them) or 100 worktrees of one; any of
these, a directory it could not list, a search root reached through a symbolic
link, a directory at the depth limit that holds directories (or, in a Git
directory's `modules/`, at 4 levels down), or a bare repository, leaves it
`complete: false`.

### Document, protocol version 1

```json
{
  "protocol_version": 1,
  "hostname": "fff-aaaa1111-builder-1",
  "complete": true,
  "repositories": [
    {
      "path": "/workspace/repos/acme/widget",
      "state": "inspected",
      "unpushed_commits": 1,
      "unpushed_branches": ["epic/5"],
      "stashes": 0,
      "worktrees": [
        {
          "path": "/workspace/repos/acme/widget",
          "branch": "main",
          "state": "inspected",
          "tracked_changes": 0,
          "untracked_files": 1,
          "unpushed_commits": 0,
          "operation": null
        }
      ]
    }
  ]
}
```

| Field | Values |
| --- | --- |
| `complete` | `false` when the worker ran out of time or limits (submodules count as repositories), could not list a directory, found a search root reached through a symbolic link, a directory at the depth limit holding directories, or a bare repository. A symbolic link below a search root is not followed and does not make it `false`. |
| `repositories[].path`, `worktrees[].path` | The working tree's absolute path, or `null` when it is not printable ASCII of at most 256 characters. A repository's is the working tree it was found through; a submodule's, its directory; an unused submodule Git directory's, that directory. |
| `repositories[].state` | `inspected`, or `unreadable` (its counts 0, no worktrees): Git could not read it, or it is a submodule that is not the submodule's own, a submodule's directory holding files but no repository, or an unused submodule Git directory. |
| `unpushed_commits` | A repository's: on any local branch; a worktree's: from its HEAD. Commits no remote-tracking branch holds, whatever its remote's URL. |
| `unpushed_branches` | Local branches carrying such commits, at most 10, printable names only. |
| `stashes` | Stash entries. |
| `worktrees[].branch` | The branch checked out there, or `null`: a detached HEAD, or a name that is not printable ASCII without blanks of at most 200 characters. |
| `worktrees[].state` | `inspected`, `missing` (listed by Git, its directory gone: only its commits are counted) or `unreadable` (Git could not report on it, warned while reporting, holds an index entry that hides an edit, or another repository is at its path). |
| `tracked_changes`, `untracked_files` | Counts, 0 unless `inspected`. Ignored files are not counted, nor is anything inside an ignored directory, a repository included. |
| `operation` | `merge`, `rebase`, `cherry_pick`, `revert`, or `null`. |

The worker exits 0 with the document whatever work it found: it reports, the
CLI judges ([worker lifecycle §Gates (terminate)](worker-lifecycle.md#gates-terminate),
`workFindings`). Keys keep this order (`workInspectionJson`). A path or branch
the CLI would print is printable ASCII by the parser's rule, so a worker cannot
put control sequences on the operator's terminal; a document breaking it is
not a work inspection.

### The CLI side

| Result of running it | Reads as |
| --- | --- |
| Exit 0 and a valid document for this worker (its `hostname`, compared without case) | `inspected` |
| Exit 0 and a document for another worker | unknown: "its answer is for another worker" |
| Exit 0 and output that is not a valid document | unknown, naming the first malformed field, never quoting the output |
| Another major version | unknown: "the work inspection speaks protocol version N" |
| Exit 64: an activator from before this operation | unknown and unsupported: "its activator predates the work inspection" |
| Exit 65 / 75 | unknown: no active release / another host operation was running |
| Any other exit status | unknown: "the work inspection exited with status N" |
| `timed_out` (2 min) and every other transport outcome | unknown, in fffactory's words |

The CLI runs it only after reading the worker's agent activity, which goes
through the same activator lock, and only when that activity does not already
refuse terminate (agents active, or activity unreadable), which would hold the
activator for nothing. An unknown inspection refuses terminate; it never reads
as no work. Nor does a checkout the worker did not find: every checkout
factory.json places on the worker (`/workspace/repos/PATH`) must be reported,
as a repository or as a worktree of one, or the inspection reads as
incomplete, `/workspace/repos/PATH: placed on this worker, but the work
inspection did not report it` (`workFindings`). A placed checkout not cloned
yet refuses too: the CLI cannot tell it from one the worker missed.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/protocol-fields.ts` | `HOST_PROTOCOL_VERSION`, the version rule and field readers every document's parser shares. Pure. |
| Domain | `src/domain/host-protocol.ts` | The worker paths, the inspect document's types, `hostInspectionJson`, `parseHostInspection`, `RemoteCommand`, `INSPECT_COMMAND`, `UPLOAD_COMMAND` and `activateCommand`. Pure. |
| Domain | `src/domain/work-inspection.ts` | The work inspection's document, `workInspectionJson`, `parseWorkInspection`, `INSPECT_WORK_COMMAND`, the printable path and branch rules, and `workFindings`. Pure. |
| Domain | `src/domain/host-projection.ts` | The host projection, its canonical text and its parser. Pure. |
| Domain | `src/domain/dispatch-projection.ts` | The dispatch projection, adoption and inspection documents, their parsers, and fixed inspect command. Pure. |
| Domain | `src/domain/installation.ts` | `INSTALL_STEPS`, step results, the install state rule, the apply document and record, `Installation`, and reading the activator's answer. Pure. |
| Domain | `src/domain/readiness.ts` | The verify document, enrollment states, and the next actions the CLI names ([readiness](readiness.md)). Pure. |
| Domain | `src/domain/rollout.ts` | A worker's outcome from its install and the rollout rule. Pure. |
| Domain | `src/domain/tailnet.ts` | Peer views, the hostname-match rule and the tag check, `WorkerAddress`, the host key and address checks, the private known_hosts text. Pure. |
| Application | `src/application/host-transport.ts`, `src/application/tailnet-peers.ts` | The `HostTransport` and `TailnetPeers` ports. |
| Application | `src/application/inspect-worker.ts` | `inspectWorker`: runs inspect over the transport and reads the answer. |
| Application | `src/application/inspect-work.ts` | `inspectWork`: runs `work inspect` through the activator and reads the answer, trusting it only for that worker. |
| Application | `src/application/inspect-dispatch.ts` | Runs fixed dispatch inspection over the transport and reads the answer. |
| Application | `src/application/apply-workers.ts` | `applyWorkers`: the workers stage. |
| Infrastructure | `src/infrastructure/ssh-transport.ts` | `sshTransport`: the private known_hosts file, the ssh command and environment, streamed standard input, outcome classification. |
| Infrastructure | `src/infrastructure/tailscale-peers.ts` | `tailscalePeers` over `tailscale status --json`. |
| Worker | `src/host/inspect.ts` | `workerInspector` over a `WorkerSystem` (root, process runner, hostname, machine, free space); `localWorkerSystem`. |
| Worker | `src/host/apply.ts` | `workerApplier` over an `ApplySystem` (a `WorkerSystem` with the clock, privilege, standard input, release and install lock): the steps, their logs and the record. |
| Worker | `src/host/install-lock.ts` | `flockExclusive`: the install lock over `flock(2)`, through libc. |
| Worker | `src/host/credentials.ts` | `workerCredentials`: the `credentials` install step ([credential delivery](credential-delivery.md)). |
| Worker | `src/host/verify.ts` | `workerVerifier`: the verifiers and enrollment checks. |
| Worker | `src/host/dispatch.ts` | Dispatch adoption, installation, reconciliation and checked observation, with privilege drop. |
| Worker | `src/host/work.ts` | `workerWork`: the work inspection, over the worker's working trees, as `factory`, read-only. |
| Worker | `src/host/endpoint.ts` | `workerEndpoint`: all worker endpoints together. |
| Worker | `assets/steps/` | The wrapped install steps, the pins and the plugin manifest. |
| CLI adapter | `src/cli/commands/host.ts` | The fixed `fffactory host` inspect, apply, verify, repository, control-plane, dispatch and work operations. |

Tests: `tests/host/protocol-contract.test.ts` is the contract: four worker
filesystems (`tests/host/worker-scenarios.ts`: installed with enrollment
pending, a failed install, freshly bootstrapped, damaged) must produce
`tests/host/fixtures/inspect-*.json` byte for byte on the worker side, and the
CLI side must read each fixture back without loss, over the transport, into
the expected verdict; it also checks that the worker speaks the version the
CLI reads, that other majors are rejected, that additions are ignored and that
a worker without `installation` reads as none. It runs `host apply` and `host
verify` over worker filesystems with scripted tools the same way:
`tests/host/fixtures/apply-{succeeded,failed,busy}.json` and
`verify-pending.json` byte for byte on the worker side, and on the CLI side each
read back without loss and each activator answer into the expected worker
outcome. `tests/host/apply.test.ts` runs
`host apply` over real bash stand-in steps in a temporary worker: the order in
one process, each step's result recorded before the next, the logs streamed as
steps run (a hanging step's output kept), the active release, a failing step
leaving it active and unhealthy with the later steps not run, a rerun
repairing it, a failed check failing the install, failures outside the steps
(a directory where the link belongs, a record it cannot keep, verification past
its bound) recorded and printed, the install lock (a second install refused,
held during the steps, never inherited, released), each step's environment and
timeout, every refusal changing nothing, and reading standard input to its
limit. `tests/host/install-lock.test.ts` (one holder at a time, across
processes, never inherited). `tests/host/verify.test.ts` (each check passing and failing,
each enrollment state, factory's commands through `runuser` and `env -i`, no
tool output in the document, the Anthropic key-file check).
`tests/host/credentials.test.ts`, the native credentials step in
`tests/host/apply.test.ts` and `tests/bootstrap/credentials.test.sh` (the
`credentials` step, [credential delivery](credential-delivery.md)). `tests/domain/host-projection.test.ts`,
`tests/domain/installation.test.ts`, `tests/domain/readiness.test.ts`,
`tests/domain/rollout.test.ts` (every outcome; an answer for another worker or
release; a busy worker skipped; a new worker's first boot), `tests/domain/host-protocol.test.ts` (every
malformed field, every state, the version check, command tokens),
`tests/domain/tailnet.test.ts`, `tests/application/inspect-worker.test.ts`,
`tests/application/apply-workers.test.ts` (upload then activation with the
tarball, the digest and the projection on standard input, a Paseo secret
reference included; one worker at a time;
skips continuing and failures stopping the rollout; every transport outcome;
no worker executable; interrupts; a new worker's first boot waited for),
`tests/application/apply-factory-pipeline.test.ts` (a password-bearing host:
`host apply` and the Paseo install receive the projection with its reference,
and the next plan and `status` find it current), `tests/infrastructure/ssh-transport.test.ts`
(the exact arguments, the private known_hosts file and its removal even on a
throw, the environment, streamed standard input, every failure
classification), `tests/infrastructure/tailscale-peers.test.ts`,
`tests/cli/host.test.ts`, `tests/cli/status-executable.test.ts`,
`tests/host/work.test.ts` (`host work inspect` over real Git repositories in a
temporary worker: each kind of work, ignored files, missing and unreadable
worktrees, a stale worktree registration over an independent clone inside and
outside the roots, a bare repository, nothing written, the time budget;
`tests/host/work-scenarios.ts`),
`tests/host/protocol-contract.test.ts`'s `work-unresolved.json` (the worker
produces it byte for byte from real Git, the CLI reads it back over the
transport), `tests/domain/work-inspection.test.ts`,
`tests/application/inspect-work.test.ts`, the activator's `work inspect` in
`tests/bootstrap/activator.test.sh`,
`tests/assets/steps/steps.test.ts` (one script per shell step, parsing with
`bash -n`, no marker polling, jq's re-evaluation markers, the plugin manifest
valid, no SSM anywhere on the worker path), `tests/bootstrap/harness.test.sh`
(the real `harness` step on Amazon Linux 2023 with agents already at their
pins: Codex's requirements, their owner, mode and exact bytes, a rerun leaving
them byte-identical, a factory-writable directory and file replaced, and the
file written even when the install then fails), the container cases of
`tests/bootstrap/host-apply.test.sh`, which run the real linux-x64 worker
executable's `host apply` under the real activator on Amazon Linux 2023 over
stand-in steps (`scripts/bootstrap-test.sh`), including `fffactory-admin`
activating through `sudo` with the projection on standard input and a held
install lock refusing a second install, and `scripts/smoke-test.sh`, which
runs the compiled `host inspect --json` in a clean container that is no worker,
and the bundled worker executable. No test runs the host's `ssh` or `tailscale`
or reaches a worker or tailnet.

Introduced by [#100](https://github.com/yaunder/factory/issues/100); `apply`,
`verify` and the host projection by
[#101](https://github.com/yaunder/factory/issues/101); `work inspect` by
[#9](https://github.com/yaunder/fffactory/issues/9); the Codex 0.163.0 and
Claude Code 2.1.302 pins and Codex's requirements by
[#65](https://github.com/yaunder/fffactory/issues/65); the projection's
credential references and the control-plane part's digest by
[#68](https://github.com/yaunder/fffactory/issues/68); the `credentials` step by
[#69](https://github.com/yaunder/fffactory/issues/69).
