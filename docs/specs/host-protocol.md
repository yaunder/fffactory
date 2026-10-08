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
| `/var/lib/fffactory/host.json` | `host apply` | The host's configuration; its SHA-256 is reported. |
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
| `configuration` | `{"state": "none"}`: no file. `{"state": "present", "sha256"}`. `{"state": "unreadable"}`: it exists but cannot be read. |
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
   five minutes (`ACTIVATION_TIMEOUT_MS`, 72 minutes).

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
  "paseo_password_secret": "arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-aaaa1111/paseo-password-builder-1-AbCdEf"
}
```

`paseo_password_secret` is present exactly when the host declares
`hosts[].paseo_password_secret`: a validated Secrets Manager ARN, the
reference the [control plane](control-plane.md) installs Paseo's password
from, never the password it names. The projection holds no secret material,
and never appears in an argument, a plan or a log. `release` is the release
factory.json pins, which the CLI/pin match guard makes the running one's.
Repositories and dispatch travel in their own documents
([repositories](repositories.md), [dispatch](dispatch.md)).

Its text is canonical: keys in this order, two-space indented, one final
newline. `host apply` refuses any other text, so the file it keeps has exactly
the SHA-256 the CLI computes for it.

There is one projection per host, built from factory.json's host as it
stands: the workers stage sends the ones `projectHosts` builds from the
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
   `user`, `systemd`, `harness`, `plugins` (`INSTALL_STEPS`,
   `domain/installation.ts`), each `/bin/bash <release>/steps/<name>.sh` as
   root with its own timeout and only `PATH`, `HOME=/root`, `LANG` and its
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
   orders the steps.
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

The steps (`assets/steps/`) are v1's development-environment and
agent-harness setup scripts, wrapped (D3; the originals were deleted in
[#102](https://github.com/yaunder/factory/issues/102)): split into those five steps, taking
their inputs from the environment above, without their marker waits and state
records. Each is idempotent, so a rerun repairs what a failed run left. A
failed install leaves the requested release active and unhealthy; `status`
reports it and the next apply repairs it. Nothing on this path uses SSM.

| Step | Does |
| --- | --- |
| `packages` | Amazon Linux packages (Git, Git LFS, GCC, Make, jq, Node 22 and npm, Python 3.11, ...), Node 22 as the default, the GitHub CLI, and a checksum-verified ripgrep. |
| `user` | The runtime account's `/workspace` directories, private `.codex` and `.claude`, login profile, npm prefix, and the system's Git defaults. |
| `systemd` | `tailscaled.service` enabled and active. |
| `harness` | Codex and Claude Code for `factory` at the versions and npm integrity values `versions.env` pins. |
| `plugins` | The Claude Code plugins `plugins.json` pins, from marketplace checkouts at their pinned revisions; undeclared ones removed. |

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
    { "name": "plugins", "status": "not_run", "reason": null }
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

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/protocol-fields.ts` | `HOST_PROTOCOL_VERSION`, the version rule and field readers every document's parser shares. Pure. |
| Domain | `src/domain/host-protocol.ts` | The worker paths, the inspect document's types, `hostInspectionJson`, `parseHostInspection`, `RemoteCommand`, `INSPECT_COMMAND`, `UPLOAD_COMMAND` and `activateCommand`. Pure. |
| Domain | `src/domain/host-projection.ts` | The host projection, its canonical text and its parser. Pure. |
| Domain | `src/domain/dispatch-projection.ts` | The dispatch projection, adoption and inspection documents, their parsers, and fixed inspect command. Pure. |
| Domain | `src/domain/installation.ts` | `INSTALL_STEPS`, step results, the install state rule, the apply document and record, `Installation`, and reading the activator's answer. Pure. |
| Domain | `src/domain/readiness.ts` | The verify document, enrollment states, and the next actions the CLI names ([readiness](readiness.md)). Pure. |
| Domain | `src/domain/rollout.ts` | A worker's outcome from its install and the rollout rule. Pure. |
| Domain | `src/domain/tailnet.ts` | Peer views, the hostname-match rule and the tag check, `WorkerAddress`, the host key and address checks, the private known_hosts text. Pure. |
| Application | `src/application/host-transport.ts`, `src/application/tailnet-peers.ts` | The `HostTransport` and `TailnetPeers` ports. |
| Application | `src/application/inspect-worker.ts` | `inspectWorker`: runs inspect over the transport and reads the answer. |
| Application | `src/application/inspect-dispatch.ts` | Runs fixed dispatch inspection over the transport and reads the answer. |
| Application | `src/application/apply-workers.ts` | `applyWorkers`: the workers stage. |
| Infrastructure | `src/infrastructure/ssh-transport.ts` | `sshTransport`: the private known_hosts file, the ssh command and environment, streamed standard input, outcome classification. |
| Infrastructure | `src/infrastructure/tailscale-peers.ts` | `tailscalePeers` over `tailscale status --json`. |
| Worker | `src/host/inspect.ts` | `workerInspector` over a `WorkerSystem` (root, process runner, hostname, machine, free space); `localWorkerSystem`. |
| Worker | `src/host/apply.ts` | `workerApplier` over an `ApplySystem` (a `WorkerSystem` with the clock, privilege, standard input, release and install lock): the steps, their logs and the record. |
| Worker | `src/host/install-lock.ts` | `flockExclusive`: the install lock over `flock(2)`, through libc. |
| Worker | `src/host/verify.ts` | `workerVerifier`: the verifiers and enrollment checks. |
| Worker | `src/host/dispatch.ts` | Dispatch adoption, installation, reconciliation and checked observation, with privilege drop. |
| Worker | `src/host/endpoint.ts` | `workerEndpoint`: all worker endpoints together. |
| Worker | `assets/steps/` | The wrapped install steps, the pins and the plugin manifest. |
| CLI adapter | `src/cli/commands/host.ts` | The fixed `fffactory host` inspect, apply, verify, repository, control-plane and dispatch operations. |

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
tool output in the document). `tests/domain/host-projection.test.ts`,
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
`tests/assets/steps/steps.test.ts` (one script per step, parsing with
`bash -n`, no marker polling, jq's re-evaluation markers, the plugin manifest
valid, no SSM anywhere on the worker path), the container cases of
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
[#101](https://github.com/yaunder/factory/issues/101).
