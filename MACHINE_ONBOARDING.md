# Machine onboarding

This runbook brings a new v2 factory and its first worker online with
`fffactory` alone, from a workstation that has no factory checkout. It ends
with an enrolled worker that Paseo clients can reach and that can dispatch
ready FFFlow epics.

Each step names who acts, the exact commands, what success looks like and
what to do otherwise, so that each one can later become a step of the
companion skill ([design §Companion skill](docs/designs/fffactory-v2.md#companion-skill)).
The specs in [`docs/specs/`](docs/specs/) are the contract; where this runbook
and a spec disagree, the spec wins.

It describes fffactory release 0.0.2 or later. Release 0.0.1 predates a
worker's `status` reaching exit 0 ([#132](https://github.com/yaunder/factory/issues/132)),
Paseo clients connecting by MagicDNS name ([#133](https://github.com/yaunder/factory/issues/133))
and apply's deferral exiting 2 ([#134](https://github.com/yaunder/factory/issues/134)).

v1's onboarding (SSM State Manager, the `factory-host` and
`factory-infrastructure` CLIs, the four-file instance) is history: it was
removed in [#102](https://github.com/yaunder/factory/issues/102) and superseded
by [decision 0002](docs/decisions/0002-fffactory-v2.md). Never run or recreate
it.

## Conventions

| Name | Means |
| --- | --- |
| `FACTORY_ID` | The permanent factory ID `fffactory init` generates, such as `fff-k3x9q2ab`. |
| `KEY` | A host key from factory.json, such as `builder-1`. |
| `HOSTNAME` | The worker's namespaced hostname, `<FACTORY_ID>-<KEY>`, such as `fff-k3x9q2ab-builder-1`. It is its OS, EC2 `Name` and Tailscale hostname. |
| `TAILNET` | The tailnet's full MagicDNS suffix, such as `tail1234.ts.net`, so that the worker's MagicDNS name is `HOSTNAME.TAILNET`. |

**Actors.** *Agent* steps run unattended and read their result from the exit
status (or `--json`). *Human* steps need a person: a browser login, the
Tailscale admin console, typing a secret into a hidden prompt, or approving a
plan at a terminal. An agent driving this runbook stops at a human step,
shows the operator the exact action, and resumes once it is done.

**Exit statuses.** `doctor`, `status`, `apply` and `upgrade` exit 0 when
everything is ready, 2 when something observed is not ready yet (pending,
skipped or deferred: read the next action and continue), and 1 when the
command failed or refused (fix the reported cause before going on). `init`,
`validate` and `secret set` exit 0 on success and 1 otherwise. Every next
action fffactory prints is the authoritative instruction for that state.

**Instance selection.** Run every command from the directory where you ran
`fffactory init`, or select the document with `--instance PATH` or
`FFFACTORY_INSTANCE`
([instance configuration §Instance discovery](docs/specs/instance-configuration.md#instance-discovery)).

**AWS credentials.** Select them with `--profile NAME` or `AWS_PROFILE` on
every command that talks to AWS, or rely on the standard AWS credential
chain. Every such command first refuses unless the caller is in factory.json's
`aws.account_id`.

## Step overview

| Step | Actor | Command | Done when |
| --- | --- | --- | --- |
| [0. Prerequisites](#0-prerequisites) | Human | none | Accounts, workstation tools and AWS credentials exist. |
| [1. Install fffactory](#1-install-fffactory) | Agent | `install.sh` | `fffactory --version` prints the release. |
| [2. Create the instance](#2-create-the-instance) | Agent | `fffactory init` | `Created PATH.` and a new factory ID. |
| [3. Declare the factory](#3-declare-the-factory) | Agent, with the operator's choices | edit factory.json, `fffactory validate` | Only `tailscale.auth_key_secret` is still needed. |
| [4. Check the workstation](#4-check-the-workstation) | Agent | `fffactory doctor` | Every check is ready but the instance check. |
| [5. Prepare the tailnet](#5-prepare-the-tailnet) | Human (tailnet admin) | Tailscale admin console | Tag, grant, SSH rule and auth key exist. |
| [6. Store the secrets](#6-store-the-secrets) | Human | `fffactory secret set` | `validate` reports `Complete` and `doctor` exits 0. |
| [7. Bootstrap and provision](#7-bootstrap-and-provision) | Human (approves at a terminal) | `fffactory plan`, `fffactory apply` | apply exits 0; the worker is installed, enrollment pending. |
| [8. Enroll the worker's accounts](#8-enroll-the-workers-accounts) | Human | `tailscale ssh factory@HOSTNAME`, then each login | Each login's status command succeeds. |
| [9. Verify enrollment](#9-verify-enrollment) | Agent, after plan approval | `fffactory plan`, `fffactory apply --plan-id ID`, `fffactory status` | status exits 0: `Ready on release R`. |
| [10. Enroll Paseo clients](#10-enroll-paseo-clients) | Human | Paseo Desktop or iOS | The client connects to `HOSTNAME.TAILNET:6767`. |
| [11. Place repositories and request dispatch](#11-place-repositories-and-request-dispatch) | Agent, after plan approval | edit factory.json, `plan`, `apply --plan-id ID` | Repositories `synchronized`, dispatch `active`. |
| [12. Mark an epic ready](#12-mark-an-epic-ready) | Human | GitHub | The dispatcher starts a Paseo agent that opens a PR. |

## 0. Prerequisites

**Actor:** human, once per AWS account, tailnet and operator workstation.

- **Workstation:** Apple Silicon macOS or x86-64 Linux (the release targets),
  with the OpenSSH client and the Tailscale client logged in to the factory's
  tailnet, plus `curl` for the public installer. No Node, Bun, Terraform or
  factory checkout is needed: fffactory downloads its own managed Terraform.
  The AWS CLI is needed only to set up credentials, such as with `aws
  configure sso` and `aws sso login`.
- **AWS:** credentials for the factory's account. In the factory's Region,
  fffactory and its bundled Terraform call STS (`GetCallerIdentity`), EC2
  (the VPC, subnet, internet gateway, route table, security group and
  instances, and `DescribeVpcs`, `DescribeInstances`), SSM `GetParameter` (only
  the public Amazon Linux image parameter), IAM (the hosts' role, instance
  profile and inline policy, and passing the role to EC2), S3 (creating and
  configuring the state bucket, and reading and writing its state, lock and
  operation objects), Secrets Manager (`CreateSecret`, `PutSecretValue`, with
  tags) and Service Quotas (`GetServiceQuota`, `GetAWSDefaultServiceQuota`).
  The Region needs room for one more VPC; `doctor` checks it. No
  least-privilege operator policy ships yet: use an identity whose policies
  allow those calls, such as an administrator of the account.
  <!-- TODO(re-evaluate when fffactory ships an operator IAM policy): replace this list with that policy. -->
- **Tailscale:** admin rights on the tailnet for [step 5](#5-prepare-the-tailnet),
  or a tailnet admin who will do it.
- **Accounts to enroll on the worker:** a GitHub account for the factory's
  work, an OpenAI account for Codex and an Anthropic account for Claude Code.
- **Paseo client:** Paseo Desktop or Paseo for iOS on each device that will
  reach the worker, joined to the same tailnet.

## 1. Install fffactory

**Actor:** agent. **Spec:** [release §install.sh](docs/specs/release.md#installsh).

The first release in the new public repository must be published before this
installation step can run. The source migration does not publish a release.

```bash
curl -fsSL https://github.com/yaunder/fffactory/releases/latest/download/install.sh | sh
fffactory --version
```

install.sh installs the latest release for this platform into
`~/.local/bin`, after checking it against the release's `SHA256SUMS`. Set
`FFFACTORY_VERSION=0.0.2` (for example) to install a given release instead,
and `FFFACTORY_INSTALL_DIR` to install elsewhere.

**Done when** install.sh prints `Installed fffactory <version> (<platform>) at
<path>` and `fffactory --version` prints that version.

**Otherwise:**

- install.sh warns that the directory is not on `PATH`: run the `export PATH=…`
  line it prints.
- An unsupported platform, a missing `curl` or SHA-256 tool, or a digest
  mismatch is refused and installs nothing: fix the cause it names and rerun.
- An existing factory is operated only by the release its factory.json pins:
  install that release with `FFFACTORY_VERSION`, never a different one.

## 2. Create the instance

**Actor:** agent. **Spec:** [instance configuration §Initialization](docs/specs/instance-configuration.md#initialization).

In the directory where you will operate the factory:

```bash
fffactory init
```

It writes `./.fffactory/factory.json` (or the `PATH` given as `fffactory init
PATH`, such as `~/.fffactory/factory.json`) with a new permanent factory ID and
this CLI's release as the pin, and contacts nothing.

**Done when** it prints `Created PATH.`, `New factory ID: FACTORY_ID`, `Release
pin: R` and the fields still needed.

**Otherwise:** rerunning on an existing document keeps every value and fills
only what is missing (`Unchanged PATH: nothing to fill.`); an invalid document
is refused with each issue and left as it is. Never edit `factory_id` or
`release`: the ID is permanent, and only `fffactory upgrade` moves the pin.

factory.json holds no secret, only Secrets Manager ARNs, but it is your
factory's only desired state: keep it, and back it up. This repository
git-ignores `.fffactory/`.

## 3. Declare the factory

**Actor:** agent, with the operator's choices. **Spec:**
[instance configuration](docs/specs/instance-configuration.md);
[`examples/factory.json`](examples/factory.json) is a complete example.

Fill in the fields `init` listed, except the secret references, which
[step 6](#6-store-the-secrets) sets:

| Field | Decide |
| --- | --- |
| `name` | A human-readable name. |
| `aws.account_id`, `aws.region` | The factory's account (12 digits) and Region. |
| `state_backend.bucket` | A globally unique S3 bucket name starting with `FACTORY_ID-`, such as `FACTORY_ID-state-<account ID>`. The first apply creates it. |
| `network.vpc_cidr`, `network.public_subnet_cidr`, `network.availability_zone` | The factory's own VPC, a subnet inside it, and an Availability Zone in the Region, such as `10.78.0.0/16`, `10.78.1.0/24` and `us-east-1a`. |
| `tailscale.tag` | The tag workers advertise, such as `tag:software-factory`. Step 5 makes it assignable. |
| `hosts[]` | One host: `key` (permanent, never renamed), `instance_type` and `root_volume_gib`, such as `builder-1`, `m7i.xlarge` and `200`. |

Leave `repositories` and `hosts[].dispatch` out for now;
[step 11](#11-place-repositories-and-request-dispatch) adds them once the
worker is enrolled. Then:

```bash
fffactory validate
```

**Done when** it prints `Valid factory.json (schema version 1).` and
`Incomplete: 1 fields still needed:` naming only `tailscale.auth_key_secret`.

**Otherwise:** fix each `path: message` it prints to standard error (exit 1).
Never put a key, password or token in factory.json: a secret field accepts
only a Secrets Manager ARN, and anything else is refused as a raw secret.

## 4. Check the workstation

**Actor:** agent. **Spec:** [doctor](docs/specs/doctor.md).

```bash
fffactory doctor --profile NAME
```

**Done when** every check is ready except `factory.json`, which reports the
document incomplete for `tailscale.auth_key_secret`; doctor exits 2.
`fffactory doctor --json` gives the same report as a versioned document.

**Otherwise:** follow each check's `Next:` line, then rerun doctor. The usual
ones: log in to Tailscale (`tailscale login`, or `tailscale up`), configure or
renew AWS credentials (`aws sso login`), select credentials for factory.json's
account, or request a higher "VPCs per Region" quota.

## 5. Prepare the tailnet

**Actor:** human, a tailnet admin, in the Tailscale admin console. Workers
join the tailnet unattended at first boot, and every `fffactory` command that
reaches one does so over Tailscale SSH, so the tailnet policy must allow both
before the first apply. fffactory never changes the tailnet policy.

Edit the tailnet policy file, replacing `operator@example.com` with the
operator's Tailscale user or group and `tag:software-factory` with
factory.json's `tailscale.tag`:

```json
{
  "tagOwners": {
    "tag:software-factory": ["operator@example.com"]
  },
  "grants": [
    {
      "src": ["operator@example.com"],
      "dst": ["tag:software-factory"],
      "ip": ["tcp:22", "tcp:6767"]
    }
  ],
  "ssh": [
    {
      "action": "accept",
      "src": ["operator@example.com"],
      "dst": ["tag:software-factory"],
      "users": ["fffactory-admin", "factory"]
    }
  ]
}
```

Merge these entries into the existing policy rather than replacing it, and
let the admin console validate it before saving.

- **`tagOwners`** lets the operator's auth key assign the tag. A worker whose
  device lacks the factory's tag is refused (`untagged`).
- **The grant** lets the operator's devices reach tagged workers: port 22 for
  Tailscale SSH, which fffactory's SSH connection uses, and 6767 for Paseo
  clients ([step 10](#10-enroll-paseo-clients)). Tailscale authorization is the
  network boundary; the Paseo password is the application boundary.
- **The SSH rule** lets the operator log in as `fffactory-admin`, the account
  every `fffactory` command uses on a worker, and as `factory`, the runtime
  account whose credentials [step 8](#8-enroll-the-workers-accounts) enrolls
  ([worker bootstrap §Accounts](docs/specs/worker-bootstrap.md#accounts)). Its
  action must be `accept`: fffactory's SSH never prompts.

Then, under **Settings → Keys**, generate an auth key that is **reusable**,
**tagged** with factory.json's tag, **pre-approved**, and **not ephemeral**.
Every worker that first-boots reads it, including one recreated after a failed
first boot ([step 7](#7-bootstrap-and-provision)). Keep its value only until step 6 stores it;
never put it in a file in a repository or in factory.json.

**Done when** the policy is saved and the key is generated.

**Otherwise:** the admin console refuses a policy that does not validate:
fix the entry it names and save again. A key generated without these options
cannot be changed: revoke it and generate a new one.

## 6. Store the secrets

**Actor:** human: the values are typed at hidden prompts. **Spec:**
[secrets](docs/specs/secrets.md).

```bash
fffactory secret set tailscale-auth-key --profile NAME
fffactory secret set paseo-password --host KEY --profile NAME
fffactory validate
fffactory doctor --profile NAME
```

Each `secret set` asks for the value with a hidden prompt (`DESCRIPTION
(input is hidden): `), stores it in Secrets Manager in the factory's account
and Region as `FACTORY_ID/tailscale-auth-key` or `FACTORY_ID/KEY/paseo-password`,
and writes only the ARN into factory.json. A value is never an argument;
without a terminal it is read from standard input, such as `fffactory secret
set tailscale-auth-key < key.txt`.

The Paseo password is the one every Paseo client of that worker types in
[step 10](#10-enroll-paseo-clients): choose a strong, unique one and keep it in
a password manager. factory.json does not require it, but the worker's Paseo
daemon cannot start without it.

**Done when** each `secret set` prints `Stored the … in Secrets Manager as NAME
(a new secret).` and the field it set, `validate` prints `Complete: nothing
further is needed.`, and doctor prints `Ready: all 8 checks are ready.` and
exits 0.

**Otherwise:** a refusal names its cause and stores nothing (exit 1).
Rerunning `secret set` stores a new value under the same secret, which workers
that boot later read for the Tailscale key. Do not rotate a running worker's
Paseo password: its daemon keeps the password it started with until Paseo
restarts, while fffactory's own Paseo calls read the new value at once, and
fffactory has no way yet to restart Paseo onto a rotated password.

## 7. Bootstrap and provision

**Actor:** human: the first apply asks for two approvals at a terminal.
**Specs:** [plan and apply](docs/specs/plan-apply.md),
[provisioning §First apply](docs/specs/provisioning.md#first-apply).

```bash
fffactory plan --profile NAME
fffactory apply --profile NAME
```

Before the first apply the state bucket does not exist, so `plan` shows only
backend bootstrap's plan, ending `The factory itself is planned once the state
bucket exists: …`, and saves nothing. `apply` then:

1. shows the bootstrap plan and asks `Apply this plan? Only "yes" applies it: `.
   Approving creates the state bucket;
2. takes the factory-wide lock, plans the whole factory, and asks the same
   question. Review it: the infrastructure creates the network, the hosts'
   IAM role and the worker's instance, and the worker, control-plane,
   repository and dispatch lines show what each stage will do. Anything but
   `yes` applies nothing;
3. applies the infrastructure (`Applying. Terraform's output is not shown;
   this can take several minutes.`);
4. waits for the new worker's first boot, up to 15 minutes (`Waiting for KEY
   (HOSTNAME) to finish its first boot …`), as it joins the tailnet;
5. uploads the release over Tailscale SSH, installs and verifies it (`Installing
   release R on KEY (HOSTNAME): …`), then reconciles repositories, installs
   Paseo and reconciles dispatch;
6. prints each stage's outcome, the end-to-end verification and `Operation
   record: s3://…`, and releases the lock.

**Done when** apply exits 0 and its `Workers:` section shows `installed  KEY
(HOSTNAME): release R installed and verified; enrollment pending: GitHub,
OpenAI Codex, Claude Code`, each account followed by its exact steps, and
`Paseo clients: enrollment is checked from each client, not the worker`.
Pending enrollment is expected here: fffactory never enrolls an account.

**Otherwise:**

- Exit 1 with `Its first boot did not finish within 15 min`: read the bootstrap
  in the instance's EC2 console output, and check that the tailnet policy lets
  this device see the factory's tag. If the bootstrap failed, terminate the
  instance in the EC2 console, wait until it is terminated, remove its stale
  device in the Tailscale admin console if one remains (a second device with
  the same hostname is refused as `duplicate`), and rerun `fffactory apply`,
  which creates it afresh ([worker bootstrap §Failed first boot](docs/specs/worker-bootstrap.md#failed-first-boot)).
- An install or verification failure leaves the worker on the new release,
  unhealthy: its next action names the failed step's log; rerun `fffactory
  apply` once the cause is fixed.
- `Applying failed: …`: Terraform may have changed some infrastructure; rerun
  `fffactory apply`, which plans again from what exists and converges.
- Interrupted (Ctrl-C): the factory stays locked. See
  [An interrupted operation](#an-interrupted-operation).

## 8. Enroll the worker's accounts

**Actor:** human: each login opens a browser or device-code flow. **Spec:**
[readiness §Enrollment](docs/specs/readiness.md#enrollment).

Run the steps apply printed for each pending account. They are, as `factory`
on the worker:

```bash
tailscale ssh factory@HOSTNAME
gh auth login --hostname github.com --git-protocol https --web
gh auth status
codex login --device-auth
codex login status
claude auth login
claude auth status
exit
```

Log in as `factory` and nowhere else: agents run as `factory`, and
`fffactory-admin` cannot switch to it. Credentials stay on the worker; never
copy them into factory.json, a prompt or a repository.

**Done when** `gh auth status`, `codex login status` and `claude auth status`
each succeed.

**Otherwise:** `tailscale ssh` refused means the tailnet SSH rule does not let
you log in as `factory`: fix [step 5](#5-prepare-the-tailnet).

## 9. Verify enrollment

**Actor:** agent, once the operator has approved the plan. **Specs:**
[status](docs/specs/status.md), [readiness](docs/specs/readiness.md).

`status` runs unprivileged and reads the verification the last install
recorded, so enrollment counts only once an apply has verified the worker
again:

```bash
fffactory plan --profile NAME
fffactory apply --plan-id ID --profile NAME
fffactory status --profile NAME
```

`plan` saves its plan for an hour and prints the exact apply command naming
it. Naming the plan ID is the approval of exactly that plan, so `apply
--plan-id` needs no terminal; an agent runs it only after the operator has
reviewed and approved that plan. Without `--plan-id`, apply asks at a terminal.
A plan refused as stale (factory.json, the release, the account or the state
changed) is never forced: plan again and review the new plan.

**Done when** apply exits 0 with `installed  KEY (HOSTNAME): release R
installed and verified; every account is enrolled`, and `status` exits 0,
showing the worker `Ready on release R` and ending `Ready: all 1 workers are
ready.`
`fffactory status --json` gives the same report as a versioned document.

**Otherwise:** status exit 2 lists each not-ready finding with its next action;
an account still pending names its steps again (back to
[step 8](#8-enroll-the-workers-accounts)).

## 10. Enroll Paseo clients

**Actor:** human, on each client device. **Spec:**
[control plane §Release-owned installation](docs/specs/control-plane.md#release-owned-installation).

The worker's Paseo daemon listens only on its Tailscale address, port 6767,
and accepts its MagicDNS name. Find `TAILNET` as the tailnet DNS name on the
admin console's DNS page, or as `MagicDNSSuffix` in `tailscale status --json`;
either already ends in `.ts.net`. On a device signed in to the tailnet as an
identity the grant of [step 5](#5-prepare-the-tailnet) allows:

1. In Paseo Desktop or Paseo for iOS, choose **Add host**, then **Direct
   connection**.
2. Enter the host `HOSTNAME.TAILNET` and port `6767`, that is
   `tcp://HOSTNAME.TAILNET:6767`, with TLS off: Tailscale carries and
   authorizes the connection.
3. Enter the Paseo password stored for that host in
   [step 6](#6-store-the-secrets), and connect.

The exact labels may move between Paseo client releases; the values do not.

**Done when** the client connects and shows the worker.

**Otherwise:**

<!-- TODO(re-evaluate when no factory pins 0.0.1): remove this fallback. -->
- `403 Invalid Host header`: the worker runs release 0.0.1, which predates
  accepting the MagicDNS name ([#133](https://github.com/yaunder/factory/issues/133)).
  Connect by its Tailscale IPv4 address (`tailscale ip -4 HOSTNAME`) until the
  factory is [upgraded](#upgrade-the-factory).
- No connection: check that the device is on the tailnet and the grant covers
  `tcp:6767`.
- Authentication fails: enter the password exactly as stored in step 6. Its
  value is in Secrets Manager as `FACTORY_ID/KEY/paseo-password`.

Paseo client enrollment is checked only from each client: `status` mentions it
but never counts it.

## 11. Place repositories and request dispatch

**Actor:** agent, once the operator has approved the plan. **Specs:**
[repositories](docs/specs/repositories.md), [dispatch](docs/specs/dispatch.md).

Declare each repository once and place it on the host. A repository must
already have adopted FFFlow on its declared branch (`.ffflow/config.yaml`):
synchronization leaves an unadopted one untouched, and dispatch stays pending
until every placed repository passes the adoption check.

```json
"repositories": [
  { "key": "app", "remote": "https://github.com/OWNER/NAME", "path": "app", "branch": "main" }
],
"hosts": [
  {
    "key": "builder-1",
    "instance_type": "m7i.xlarge",
    "root_volume_gib": 200,
    "paseo_password_secret": "arn:aws:secretsmanager:…",
    "repositories": ["app"],
    "dispatch": {
      "enabled": true,
      "cron": "*/15 * * * *",
      "timezone": "UTC",
      "provider": "claude",
      "model": "claude-sonnet-5",
      "mode": "default",
      "cwd": "/home/factory"
    }
  }
]
```

Every dispatch field is required when `enabled` is true; nothing is
defaulted. `provider`, `model` and `mode` apply to the schedule's dispatch
agent and to every epic agent it starts; with `mode` `default`, those agents
ask for permissions through Paseo, to be answered from an enrolled client.
Then `fffactory validate`, `fffactory plan`, and, once the plan is approved,
`fffactory apply --plan-id ID`.

**Done when** apply exits 0 with the repositories `synchronized` and dispatch
`active` for the worker, and `fffactory status` exits 0.

**Otherwise:** dispatch `pending` names each blocking gate and its next action
(`github_credential`, `repository_sync`, `ffflow_adoption`, `paseo_health`,
`worker_release`); resolve them and apply again, which activates dispatch once
every gate passes. Repositories `unresolved` lists each checkout left untouched
(a dirty tree, divergence, a wrong branch or an unadopted branch): resolve it
on the worker as `factory`, then apply again. fffactory never resets, moves or
deletes a checkout.

## 12. Mark an epic ready

**Actor:** human, in GitHub. **Spec:** [SDLC §Readiness](SDLC.md#readiness).

Apply the `ready` label to an open FFFlow epic issue (labelled `ffflow-epic`
by `plan-capture`) in a placed repository. On its
next scheduled run the dispatcher starts one Paseo agent in its own worktree
running `/fff:work-epic <id>`, which ends by opening a pull request. Watch it
from any enrolled Paseo client. Nothing in the factory merges: review and
merge the pull request yourself.

**Done when** the epic's pull request is open.

**Otherwise:** the dispatcher skips an epic it cannot start yet, and the
dispatch agent's timeline names the exact reason
([SDLC §Readiness](SDLC.md#readiness),
`assets/steps/dispatch/factory-dispatch`):

- the epic has no captured tasks (issues labelled `ffflow-task` and
  `epic-<id>`);
- one of its tasks is not open, or an open pull request mentions it;
- a task depends on an open issue outside the epic;
- an `epic/<id>` branch already exists on the remote;
- the host is at its cap of running agents: wait for the running agent to
  finish, or answer its permission request;
- a Paseo agent already dispatched for the epic still exists: the epic stays
  skipped while it does;
- the repository fails the FFFlow adoption check, or its checkout is not
  clean, on its declared branch and remote: every ready epic in the
  repository is skipped;
- repository synchronization fails for any repository placed on the host
  (an unadopted branch, a dirty, ahead or diverged checkout, a wrong branch
  or remote, or a failed clone or fetch), or the checkout is still not at
  its remote branch's tip after synchronization: the epic about to start is
  skipped, and so is every later one, in any repository on the host, while
  the cause remains. A checkout that is only behind is fast-forwarded, not
  skipped.

Resolve the cause; the next scheduled run considers the epic again. Never
start an agent by hand to work around a skip.

## Operating after onboarding

### Rerunning apply

Rerunning `fffactory apply` is safe: every stage converges what remains, and
an up-to-date worker gets no Paseo lifecycle action. Paseo maintenance
(`paseo-package`, `service-definition`, `listen-address`, `password`) restarts
the daemon, which would end running agents, so when agents may be active apply
defers it: the worker is `skipped` with `Paseo maintenance is deferred while
agents may be active`, stays on its complete current release, and apply exits
2. Close the active agents on HOSTNAME, then rerun `fffactory apply`. Live
changes such as the dispatch schedule or repositories never restart Paseo
([control plane §Pre-activation deferral](docs/specs/control-plane.md#pre-activation-deferral)).

### Upgrade the factory

Install the newer release with `FFFACTORY_VERSION`, then run `fffactory
upgrade` at a terminal. It shows the pin move with the factory's plan for the
new release, and on `yes` writes the new pin and applies, exiting as apply
does. Never edit `release` in factory.json yourself. Upgrades that need a
schema or base migration are refused until milestone M3
([plan and apply §Upgrade](docs/specs/plan-apply.md#upgrade)).

Installing the newer release replaced the pinned one in place. If `upgrade` is
refused, reinstall the pinned release (install.sh with
`FFFACTORY_VERSION=<pin>`, as in [step 1](#1-install-fffactory)) to keep
operating the factory until the cause is resolved.

### An interrupted operation

An interrupted apply or upgrade leaves the factory-wide lock held, and every
later plan and apply is refused, naming the holder. Once you are sure the
interrupted operation is dead, run `fffactory lock break` and confirm its lock
ID; then rerun `fffactory apply`. Never break a lock to make progress past an
operation that may still be running
([provisioning §`fffactory lock break`](docs/specs/provisioning.md#fffactory-lock-break)).

### Not available yet

Until milestone M3, a plan that removes or renames a host key, or that would
destroy or replace a worker, is refused (D11): there is no retirement or
guided replacement, and the failed-first-boot recovery above is the only
replacement path. A worker's root volume, with its credentials, checkouts and
any uncommitted work, is deleted with its instance: treat Git as the
durability boundary. Second workers, a rollout policy and the companion skill
are M3 items ([design §Milestones](docs/designs/fffactory-v2.md#milestones)).
