# Worker bootstrap

A new worker boots Amazon Linux 2023 x86-64 and runs, once, user data that
builds only the stable base the operator's `fffactory` needs to take over:
two accounts, Tailscale with Tailscale SSH under the host's namespaced
hostname, the root activator and its sudoers entry, and the release
directories. Nothing uses SSM. Every release after that reaches the worker
through the activator. Design:
[fffactory-v2.md §Provisioning and bootstrap](../designs/fffactory-v2.md#provisioning-and-bootstrap)
and [§Integrity and trust](../designs/fffactory-v2.md#integrity-and-trust)
(D3, D4).

Both files live in the Terraform tree, `assets/terraform/bootstrap/`, and ship
in the release bundle under `terraform/bootstrap/`:

| File | Is |
| --- | --- |
| `user-data.sh.tftpl` | The user data template the hosts module renders with Terraform's `templatefile`. |
| `fffactory-activate` | The root activator, embedded in the rendered user data. |

They sit inside the Terraform tree because the provisioner and
`scripts/terraform-check.ts` copy only that tree for an operation
([provisioning §Operations](provisioning.md#operations)); a template outside it
would not exist at plan time.

## User data

### Rendering

`modules/hosts` renders the template for each host
(`templatefile("${path.module}/../../bootstrap/user-data.sh.tftpl", …)`):

| Template variable | Value | From factory.json |
| --- | --- | --- |
| `hostname` | `<factory ID>-<host key>`, the host's Tailscale and OS hostname | `factory_id`, `hosts[].key` |
| `region` | The factory Region, where the key is read | `aws.region` |
| `tailscale_auth_key_secret_arn` | The factory's Tailscale enrollment key reference | `tailscale.auth_key_secret` |
| `tailscale_tag` | The tag the host advertises | `tailscale.tag` |
| `activator_base64` | `filebase64` of `fffactory-activate` | none |

The projection passes the last two factory.json fields to the factory root
module as `tailscale_auth_key_secret_arn` and `tailscale_tag`
([provisioning §Terraform inputs](provisioning.md#terraform-inputs)), whose
validations keep every value free of quotes; the template assigns each to a
single-quoted shell variable. A secret value is never an input: the worker
reads the key itself.

The rendered script must stay within EC2's 16 KB user data limit, activator
included. It runs only at a host's first boot: the hosts module ignores
`user_data` changes, so a changed template never replaces or updates a
running host (design §Base-system maintenance).

### Steps

Run by cloud-init as root with `set -Eeuo pipefail`, logging to standard
error with a UTC timestamp and `fffactory-bootstrap:`:

1. Remove `/var/lib/fffactory/bootstrap-complete`, so a failed rerun leaves no
   marker.
2. Set the OS hostname to `hostname` and write
   `/etc/cloud/cloud.cfg.d/99-fffactory-hostname.cfg`
   (`preserve_hostname: true`) so it survives reboots.
3. Create the accounts, unless they exist.
4. Create the directories, install the activator and the sudoers entry.
5. Add Tailscale's Amazon Linux 2023 repository, unless present, install
   `tailscale`, and `systemctl enable --now tailscaled`. The version is not
   pinned: it is the stable repository's current release at first boot.
6. Unless Tailscale already has an address (`tailscale ip -4`), enroll: read
   the key with `aws secretsmanager get-secret-value` into a mode 0600 file
   in a fresh root-only directory under `/run`, and run
   `tailscale up --auth-key=file:<that file> --hostname=<hostname> --advertise-tags=<tag> --ssh`.
   The directory is removed whether or not enrollment succeeds. The key never
   appears in an argument, the environment or a log.
7. Wait for a Tailscale address: up to 30 checks, 2 seconds apart.
8. Write `/var/lib/fffactory/bootstrap-complete`.

A rerun converges: existing accounts, repository and enrollment are kept, and
the activator, sudoers entry and marker rewritten.

### Accounts

| Account | Purpose |
| --- | --- |
| `fffactory-admin` | The operator's login over Tailscale SSH. Home `/home/fffactory-admin` (0700), shell `/bin/bash`, own group only, no password. Its one sudo rule is the activator. |
| `factory` | The unprivileged runtime account. Home `/home/factory` (0700), shell `/bin/bash`, own group only, no sudo rule. |

Which tailnet identities may log in as `fffactory-admin`, and as `factory`, is
tailnet SSH policy, an administrator's step outside this bootstrap. Operators
need both: `fffactory-admin` for every `fffactory` command that reaches the
worker, and `factory` to enroll the runtime account's GitHub and model-provider
credentials ([readiness §Enrollment](readiness.md#enrollment)), whose next
actions say so.

### Files and directories

| Path | Owner, mode | Holds |
| --- | --- | --- |
| `/usr/local/libexec/fffactory-activate` | root, 0755 | The activator, byte for byte the shipped file. |
| `/etc/sudoers.d/fffactory-admin` | root, 0440 | The sudoers entry below. |
| `/opt/fffactory/releases` | root, 0755 | One directory per activated release. |
| `/var/lib/fffactory` | root, 0755 | Worker state outside releases; `bootstrap-complete` marks a finished bootstrap. |

The sudoers entry lets `fffactory-admin` run the activator, with any
arguments, as root without a password or a terminal, and nothing else:

```text
Defaults:fffactory-admin !requiretty
fffactory-admin ALL=(root) NOPASSWD: /usr/local/libexec/fffactory-activate
```

It is written to a temporary file, checked with `visudo -c -f`, installed,
and the whole configuration checked again with `visudo -c`. A file that fails
the check is never installed.

The activator accepts only three shapes: `TARBALL SHA256` for release
activation; the exact word `repositories` for the active release's fixed
repository endpoint; and `control-plane ACTION`, where `ACTION` is exactly
`activity`, `install`, `reload` or `restart`. The endpoints share the
activation lock and invoke only the active root-owned release. Standard input
carries structured data; no configuration value becomes a command token.

### Package installation and the RPM lock

Every `dnf` call retries when another process holds the RPM database lock
([#17](https://github.com/yaunder/factory/issues/17)): output mentioning
`rpm.lock` or `transaction lock`. It tries at most 5 times, waiting 5, 10, 20
and 40 seconds between attempts, and logs each retry with its attempt number.

| Condition | Result |
| --- | --- |
| A lock failure, then success | Continues; each wait is logged. |
| Still locked after 5 attempts | The bootstrap fails (cloud-init reports it); no marker. |
| Any other failure, such as a failed signature check without a lock | Fails at once, no retry; no marker. |
| Tailscale has no address after 30 checks | Fails; no marker. |

### Failed first boot

The apply that creates a worker's machine waits for its first boot, up to 15
minutes, before installing it
([plan-apply §Waiting for a new worker](plan-apply.md#waiting-for-a-new-worker)).

User data runs once, and nothing reruns it: a bootstrap that fails, even
transiently, leaves an instance that may never join the tailnet, or never
write its marker. That apply then fails the worker at its deadline, and
`fffactory status` names the same recovery for a worker missing from the
tailnet ([status §Workers](status.md#workers)): read the bootstrap in the instance's EC2 console
output and, if it failed, terminate the instance in the EC2 console. Once it
is terminated, Terraform's refresh drops it from state and the next `fffactory
apply` plans the host as a plain create, which the D11 refusals allow
([plan-apply §Refusals](plan-apply.md#refusals-until-lifecycle-work-lands-d11)),
and the new instance boots afresh, its first boot waited for by that apply. Guided replacement arrives with host
replacement in milestone M3 (`TODO(re-evaluate when host replacement lands
in M3)` in `src/domain/status.ts`).

### No SSM

Workers are managed over Tailscale SSH, never SSM. The bootstrap files mention
no SSM at all, and the Terraform modules configure no SSM agent, document,
association or permission: their only SSM use is the operator-side read of the
public Amazon Linux image parameter. The AMI's own SSM agent is left as the
image ships it; the host role grants it nothing, so it cannot register
through the host role. Account-level SSM Default Host Management
Configuration, which registers instances without instance-role permissions,
is outside this bootstrap.

## Activator

```text
sudo /usr/local/libexec/fffactory-activate TARBALL SHA256
```

`TARBALL` is the absolute path of a release bundle
([release §Asset bundle](release.md#asset-bundle)); `SHA256` is the digest the
operator's executable embeds for it, 64 lowercase hexadecimal digits. The
activator is bash, with a fixed `PATH` and the C locale, and writes only to
standard error: standard output belongs to `host apply`.

For release activation, in order, it:

1. **Checks its arguments and privilege**: exactly two, a well-formed digest,
   an absolute path, running as root, and a regular file that is not a
   symbolic link.
2. **Takes the activation lock**, `/run/fffactory-activate.lock`, without
   waiting, and removes any staging directory a killed activation left.
3. **Verifies a private copy**: copies the tarball into a fresh root-only
   staging directory under `/opt/fffactory/releases` and compares the copy's
   SHA-256 with `SHA256`. On a mismatch it stops before reading the archive,
   so nothing is unpacked; it never prints the digest of what it read.
4. **Checks every entry** (`tar -t`, reading only): a regular file with mode
   0644 or 0755 (no directory, link, device or special bit), at a path of
   printable ASCII without backslashes that is relative and has no empty, `.`
   or `..` segment, appearing once, and not `.fffactory-assets.json`. The
   bundle must hold `release.json`.
5. **Reads the version** from `release.json`, which must be exactly
   `{"release": "<version>"}` with a release version as the packer writes it
   (`MAJOR.MINOR.PATCH`, optional `-prerelease`). The version names the
   release directory, so it can hold no `/` and is never `.` or `..`.
6. **Unpacks** into the staging directory, owned by root, with modes 0755 and
   0644, requires an executable regular `bin/fffactory`, writes the marker
   `.fffactory-assets.json` (`{"release", "sha256"}`, as the operator's
   materialized assets have), and renames the tree to
   `/opt/fffactory/releases/<version>`, moving any other directory of that
   name aside first. If that directory's marker already records this release
   and digest, it unpacks nothing and keeps the directory as it is.
7. **Runs host apply**: removes the staging directory, releases the lock,
   changes to `/` and replaces itself with
   `/opt/fffactory/releases/<version>/bin/fffactory host apply`, as root, with
   only `PATH`, `HOME=/root` and `LANG=C.UTF-8` in its environment, and the
   caller's standard input and output.

| Condition | Exit | Unpacked |
| --- | --- | --- |
| Wrong number of arguments, a malformed digest or a relative path | 64, with the usage | nothing |
| The tarball is missing, a directory or a symbolic link | 65 | nothing |
| The digest does not match: `<path> does not match the expected SHA-256; nothing was unpacked` | 65 | nothing |
| Not gzip or tar, an unsafe or duplicate entry, no or a malformed `release.json`, no executable `bin/fffactory` | 65 | nothing |
| The tarball cannot be copied, or tar cannot unpack it (such as a file `bin` beside `bin/fffactory`): `… nothing was unpacked` | 65 | nothing |
| Another activation holds the lock | 75 | nothing |
| Not root | 77 | nothing |
| Activated | `host apply`'s exit status | the release |

A failure leaves `/opt/fffactory/releases` as it was, without staging
leftovers.

### Trust

The activator runs as root on input `fffactory-admin` supplies. It installs
and runs as root whatever release it is given, so `fffactory-admin` is
effectively root: its sudoers entry is a narrow interface, not a security
boundary (design §Integrity and trust, accepted risk). The activator defends
the interface, not the fleet:

- the digest catches a stale or wrong staged file, and the private copy means
  the caller cannot change the file between the check and the unpack;
- the entry checks keep a malformed bundle from writing outside its release
  directory or leaving links, devices or setuid files;
- the version cannot name a path outside `/opt/fffactory/releases`;
- `host apply` inherits no environment from the caller or sudo;
- the lock keeps two activations from replacing the same directory at once.
  It is released before `host apply` runs, so a process `host apply` leaves
  running cannot hold it. `host apply` takes its own install lock instead
  ([host protocol §apply](host-protocol.md#apply)): the operator's
  factory-wide lock serializes whole operations, but an interrupted or
  timed-out operation stops only the operator's `ssh`, and `host apply` runs
  on, so a rerun's `host apply` refuses (`busy`) until it has finished.

The activator reads the tarball as root, so it can read any file; it reveals
only whether that file's digest equals the one given.

## Tests

`bun test` (`just check-all`), without Docker or Terraform:

- `tests/assets/bootstrap/user-data.test.ts`: the hosts module renders the
  template with exactly the variables it uses, and those values; the rendered
  script parses with `bash -n`; the hostname, Region, reference and tag are
  single-quoted literals; the activator is embedded byte for byte and is
  executable bash; the longest inputs fit 16 KB; the bootstrap files mention no
  SSM and the modules' only SSM line is the image parameter.
- `tests/assets/bootstrap/templatefile.test.ts`: `tests/support/templatefile.ts`,
  the subset of Terraform's `templatefile` the template uses (`${name}`,
  `$${`, `%%{`), which refuses directives, strip markers, expressions and
  variables not passed.
- `tests/application/project-terraform-inputs.test.ts`: `tailscale_tag`.

`scripts/bootstrap-test.sh` (`just bootstrap-test [CASE...]`, and CI's
`Worker bootstrap on Amazon Linux 2023` job, which also shellchecks the
activator, the rendered user data and the test scripts) runs each `test_*`
case of `tests/bootstrap/*.test.sh` as root in its own fresh container: a
pinned `amazonlinux:2023` image with the packages the AMI has and the image
lacks (`tar`, `gzip`, `util-linux`, `shadow-utils`, `sudo`, `findutils`,
`diffutils`), no network, the hostname `fff-aaaa1111-builder-1`, and fixtures
from `tests/support/bootstrap-fixtures-main.ts`: the user data rendered for
`fff-aaaa1111-builder-1`, this checkout's `assets/` packed by the `fffactory`
packer with a stand-in `bin/fffactory`, and a worker release: the real
linux-x64 worker executable compiled from this checkout, with stand-in install
steps, and the host projections of builder-1 and builder-2.

- `activator.test.sh`: missing, extra and malformed arguments; a missing,
  directory or symlinked tarball; a digest mismatch that unpacks nothing and
  prints no digest; the unpack location, modes, owner and marker; `host apply`
  run from that release as root, in `/`, with the caller's standard input, a
  clean environment and its exit status; the packed bundle; a rerun that keeps
  the release; another build of a version replacing it; a killed
  activation's staging directory removed; sixteen unsafe
  bundles (traversal, absolute, backslash, symlink, hard link, directory,
  setuid, group-writable, duplicate, marker, no or bad `release.json`, extra
  keys, not gzip, no `bin/fffactory`, a file `bin` beside `bin/fffactory`) each refused for its own reason with
  nothing unpacked; non-root; a held lock.
- `user-data.test.sh`, with stand-in `dnf`, `systemctl`, `hostnamectl`,
  `tailscale`, `aws` and `sleep` that log their arguments, and Amazon Linux's
  own `useradd`, `install`, `visudo` and `sudo`: accounts, directories,
  activator and marker; `visudo -c`, `sudo -l`, and `fffactory-admin`
  activating the packed release through `sudo` while `sudo` refuses it any
  other command and refuses `factory`; enrollment arguments, the key file's
  mode and removal, and the key in no argument or output; no SSM; an RPM lock
  failure retried with backoff; a persistent lock failing after five
  attempts; another `dnf` failure failing at once; Tailscale never coming up;
  and a rerun.
- `host-apply.test.sh`, the activator running the real worker executable's
  `host apply` ([host protocol §apply](host-protocol.md#apply)) over stand-in
  steps that record themselves and install stand-in tools: every step in order,
  then verification, the record, the host configuration and the logs; each
  account pending until it is enrolled, with states only; `host inspect` as
  `fffactory-admin`; a failing step leaving the release active and unhealthy
  until a rerun repairs it; the steps' environment; the install lock held
  while steps run and never inherited, and a second install refused while it
  is held; `fffactory-admin` activating through `sudo -n`, as apply does, with
  the projection on standard input; a directory where the release link belongs
  failing the install with a recorded reason; another worker's projection and
  an unfinished bootstrap refused, changing nothing.

`scripts/terraform-check.ts` compares each planned host's `user_data`,
rendered by the managed Terraform, with `tests/support/user-data.ts`'s
rendering for the same inputs, so the tests exercise what hosts boot with.

Introduced by [#97](https://github.com/yaunder/factory/issues/97).
