# Plan and apply

`fffactory plan` shows the factory's plan from factory.json and live state, and
saves it; `fffactory apply` applies exactly one approved plan under the
factory-wide lock. Apply is staged: infrastructure is the factory root module's
Terraform; workers install and verify the release; repositories are reconciled;
then the Paseo control plane is installed and reconciled
([#101](https://github.com/yaunder/factory/issues/101)); dispatch is reconciled
from its gates; and the observed outcomes are verified end to end. All stages
run under the same lock, in the same approved plan and operation record. A single `fffactory apply`
therefore provisions a new worker, waits for its first boot, then installs and
verifies it ([below](#waiting-for-a-new-worker)). Design: [fffactory-v2.md §plan](../designs/fffactory-v2.md#plan),
[§apply](../designs/fffactory-v2.md#apply),
[§Failure behavior](../designs/fffactory-v2.md#failure-behavior),
[§Release and compatibility model](../designs/fffactory-v2.md#release-and-compatibility-model),
[§upgrade](../designs/fffactory-v2.md#upgrade) and
[§Refusals until lifecycle work lands](../designs/fffactory-v2.md#refusals-until-lifecycle-work-lands).
`fffactory upgrade` ([below](#upgrade)) runs the same operation after moving
factory.json's release pin to the running release.

## Before anything reaches AWS

Both commands:

1. resolve and validate factory.json and print `Instance: PATH (SOURCE)`;
2. run the account check and refuse, with doctor's summary, details and next
   action, unless the caller is in `aws.account_id`
   ([instance configuration §Credentials](instance-configuration.md#credentials));
3. materialize this release's assets, whose SHA-256 is the release's asset
   identity, and run the managed Terraform from their `terraform/` tree;
4. refuse unless this fffactory is the release factory.json pins (the CLI/pin
   match guard), and unless factory.json is
   [complete](instance-configuration.md#completeness), listing each missing
   field `is required to plan`.

### CLI/pin match guard

Only the release factory.json pins may plan or change the factory
(`pinRefusal`, `src/domain/plan.ts`). The pin is a configuration value, so it
is never echoed:

```text
Refusing to plan: factory.json pins another fffactory release than this one, 0.3.0: only the pinned release may plan or change this factory. Install the release factory.json pins, or move the pin to 0.3.0 with `fffactory upgrade`.
```

When the pin is a later release than the running one, the refusal ends
`Install the release factory.json pins: fffactory never moves a pin back to an
earlier release.` instead. A factory.json without a pin is left to the
completeness check. Moving the pin is [`fffactory upgrade`](#upgrade)'s.

| Command | Guarded | Why |
| --- | --- | --- |
| `plan`, `apply` | Yes | They plan and change the factory. |
| `secret set` | Yes, before reaching AWS: `Refusing to store the secret: ...` | It writes Secrets Manager and factory.json ([secrets](secrets.md)). |
| `upgrade` | By its own rules ([below](#upgrade)) | Moving the pin to the running release is what it does. |
| `init` | No | It changes no factory: it pins the running release in a new document and keeps an existing pin. |
| `lock break` | No | It changes no factory state, and an upgrade interrupted before it moved the pin leaves a lock only its later release is at hand to break; confirming the lock ID guards it ([provisioning §Lock](provisioning.md#lock)). |
| `doctor`, `status`, `validate`, `assets`, `host` | No | They read, or act only on this machine or worker: a mismatched CLI may still diagnose. |

## Plan

```text
fffactory plan [--instance PATH] [--profile NAME]
```

Planning changes nothing and takes no lock, not even Terraform's own: its
`terraform plan` runs with `-lock=false`
([provisioning §Operations](provisioning.md#operations)), so a `plan` that is
killed leaves no Terraform state lock behind. Refusing while the factory is
locked (3) and binding the saved plan to the state's revision guard
consistency instead. The plan `apply` makes for itself, under the factory lock,
keeps Terraform's state lock as well.

1. When the state bucket does not exist, the plan is
   [backend bootstrap's](provisioning.md#backend-bootstrap), shown as bootstrap
   shows it, followed by `The factory itself is planned once the state bucket
   exists: ...`. No plan is saved; exit 0.
2. A bucket bootstrap did not finish is refused as bootstrap refuses it.
3. While the factory is locked, planning is refused with the holder
   ([provisioning §Lock](provisioning.md#lock)): a plan made during another
   operation would be stale.
4. The infrastructure stage is planned (next section), then the workers stage
   ([below](#the-workers-stage)), Paseo control-plane changes derived from each
   worker's inspection, repository reconciliation for every declared worker,
   the complete requested dispatch projection (or schedule removal), and
   end-to-end verification.
5. The plan is printed:

   ```text
   Factory plan:
     Configuration: /work/.fffactory/factory.json
     Factory: Test factory (fff-abcd1234)
     AWS account: 123456789012, Region: eu-west-2
     Release: 0.3.0
   Infrastructure changes:
     + module.network.aws_vpc.this
     + module.hosts.aws_instance.host["builder-1"]
     2 to add, 0 to change, 0 to destroy.
   Worker changes, one worker at a time:
     ~ builder-1 (fff-abcd1234-builder-1): install release 0.3.0 and its host configuration, then verify it
   Control-plane changes, before worker activation:
     ~ builder-1 (fff-abcd1234-builder-1): paseo-package, service-definition, listen-address, password
   Repository changes, one worker at a time:
     ~ builder-1 (fff-abcd1234-builder-1): reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts
   Dispatch changes, after every readiness gate:
     ~ builder-1 (fff-abcd1234-builder-1): remove the factory dispatch schedule if it exists
   End-to-end verification: observe each worker's release, repositories, Paseo and actual dispatch schedule.
   Saved as plan k3x9q2ab, until 2026-09-30T13:00:00.000Z. To apply exactly it:
     fffactory apply --plan-id k3x9q2ab
   ```

   The apply command repeats the `--instance` and `--profile` the plan was
   given, quoted for a POSIX shell where needed, since a saved plan applies
   only with the same factory.json. Each change shows Terraform's symbol: `+`
   create, `~` update, `-` delete, `-/+` and `+/-` replace; any other set of
   actions is shown by name, and reads and no-ops are left out. Without
   infrastructure changes it prints `Infrastructure: no changes.`. A complete
   factory.json declares a worker, so every plan has the workers, control-plane,
   repository, dispatch and verification stages' changes and is saved. A saved
   plan contains the dispatch projection; a record without it is damaged and is
   never applied.

### The infrastructure stage

`planInfrastructure` (`src/application/plan-factory.ts`), which `apply` also
runs under the lock:

1. reads the revision of the factory's Terraform state (below), before
   anything else, so any later state write is seen;
2. reads the host keys the state records, the factory root's `host_keys`
   output, with `Provisioner.output`. Before the first apply the state has no
   outputs and records none. An output that is not a list of strings is
   refused: `the factory's Terraform state records host keys that cannot be
   read`;
3. refuses removing a recorded host key (D11, below);
4. plans the factory root module with factory.json's
   [projection](provisioning.md#terraform-inputs) and the backend setting
   `bucket`, into the plan's private directory, and reads the saved plan back
   with `showPlan`. A plan that cannot be read, including a change naming no
   action, is refused;
5. refuses a plan that does anything to a host machine but create it, update it
   in place or leave it, such as destroying or replacing it (D11, below).

### The workers stage

Every worker factory.json declares, in its order, gets the release
factory.json pins and its [host projection](host-protocol.md#the-host-projection),
and is verified, whatever it runs now: the steps are idempotent, so rerunning
apply converges what remains. The stage's changes therefore depend only on
factory.json's text and the release, which a saved plan is bound to; they are
shown after the infrastructure's, one line per worker, and approved with them.
`declaredWorkers` and `describeWorkers` (`src/domain/plan.ts`) make them.

Under the lock, after the infrastructure stage (applied, or with no changes
skipped: no Terraform apply runs), `applyWorkers`
(`src/application/apply-workers.ts`) takes the workers one at a time:

1. If the running executable carries no worker executable, as when run from
   source, every worker is skipped before the tailnet is read: `This fffactory
   carries no worker executable: it runs from source, not from a built
   release`.
2. The peer view is read once; each worker is found by the
   [hostname-match rule](host-protocol.md#finding-the-worker), or skipped with
   status's reason and next action. A worker whose machine this apply created
   is instead waited for while it boots ([below](#waiting-for-a-new-worker)).
   Before any upload, an existing worker with approved Paseo maintenance is
   asked for agent activity. Active or unknown activity defers it without
   upload or activation, leaving its complete current release in place: it is
   skipped, `Paseo maintenance is deferred while agents may be active`
   ([control plane §Pre-activation deferral](control-plane.md#pre-activation-deferral)).
3. The release tarball is uploaded and activated with its embedded digest and
   the host projection on standard input ([host protocol §apply](host-protocol.md#apply)):
   the one `projectHosts` builds from factory.json's hosts, Paseo secret
   reference included, whose digest plan and `status` expect.
   While it works apply prints `Installing release R on KEY (HOSTNAME):
   uploading N MiB.`, then `... host apply runs the install steps, then
   verifies; this can take many minutes.`
4. A worker counts as installed only once `host apply` answered with its
   verification, in a document for that worker and release. A known skip (not
   found, offline, an SSH login refused, an upload SSH could not finish,
   bootstrap not finished, an install still running on it) leaves the rest to
   be attempted; an install or verification failure stops the rollout, and the
   remaining workers are not attempted. A new worker whose first boot did not
   finish in time fails without stopping the rollout: no install step ran on
   it. Each outcome is written to the
   operation record as it ends. When the activation times out or its
   connection drops, `host apply` may still be installing: the worker fails
   with that said, and its next action is to wait for that install, then rerun.

After Terraform's line (`Applied: the factory's infrastructure matches
factory.json.`, or `Infrastructure: no changes to apply.`), apply lists the
workers:

```text
Workers:
  installed  builder-1 (fff-abcd1234-builder-1): release 0.3.0 installed and verified; enrollment pending: GitHub, OpenAI Codex, Claude Code
             GitHub: Authenticate GitHub as factory on fff-abcd1234-builder-1 (tailnet SSH policy must let you log in as `factory`): run `tailscale ssh factory@fff-abcd1234-builder-1`, then `gh auth login --hostname github.com --git-protocol https --web`, then `gh auth status`
             ...
             Paseo clients: enrollment is checked from each client, not the worker
  skipped    builder-2 (fff-abcd1234-builder-2): Offline in the tailnet
             Next: Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.
```

Each account's steps are apply's own, named for the hostname it resolved,
never text from the worker ([readiness §Enrollment](readiness.md#enrollment)).
Failed and not-attempted workers go to standard error. The exit status is 0
when every worker was installed and verified, 2 when one was skipped and none
failed, and 1 when one failed, including a new worker whose first boot did not
finish in time. The dispatch stage never fails a skipped worker: it reports it
`skipped` and sends it nothing. A deferred worker also bypasses the
control-plane stage, but one skipped for another reason that the tailnet still
locates goes through the control-plane stage, which may fail it (exit 1). Exit 0 means every worker is ready but for the accounts a human
enrolls: fffactory cannot enroll them, so pending enrollment still counts as
installed, and the worker's lines name each step. A failed install leaves that
worker on the requested release, active and unhealthy; its next action names
the failed step's log, and a rerun repairs it.

`plan` inspects each existing worker through the read-only host protocol to
derive its Paseo changes. A worker created by the Terraform plan is known to
have no active release and is not contacted.

#### Waiting for a new worker

When the infrastructure stage created a worker's machine (the approved plan
creates its `aws_instance`, `module.hosts.aws_instance.host["KEY"]`;
`createdWorkers` in `src/domain/plan.ts`), that worker is still booting when
the workers stage reaches it: cloud-init runs its
[bootstrap](worker-bootstrap.md#steps), which joins the tailnet and then writes
its completion marker. Apply waits for it, so one apply provisions, installs
and verifies it (`awaitFirstBoot`, `src/application/apply-workers.ts`; the
rules in `src/domain/rollout.ts`):

1. While the tailnet shows it as a booting worker does before Tailscale is up
   on it (no device with its name, the device offline, or no Tailscale SSH host
   key or address listed yet), apply looks again every 15 s
   (`FIRST_BOOT_POLL_MS`), reading the peer view afresh.
2. Once the match rule finds it, the release is uploaded once and activated.
   While `host apply` refuses with `bootstrap_incomplete`, apply activates the
   same uploaded tarball again every 15 s.
3. Once `host apply` answers otherwise, the worker's outcome is that answer's,
   as for any worker.

A duplicate name, a device without the factory's tag, or an unavailable peer
view, at the first look or any later one, is refused at once and the worker
skipped, as the match rule says: waiting never makes a guess safe.

The wait is bounded by `FIRST_BOOT_DEADLINE_MS`, 15 minutes from the first
look. A first boot usually takes a few minutes; its long steps are `dnf`
(its RPM-lock retries alone back off for up to 75 s) and the wait for a
Tailscale address (up to 60 s), so 15 minutes is several times a normal first
boot, and a bootstrap unfinished by then has failed or is stuck. Each look
first sleeps a poll, so a clock that stalls cannot stretch the wait past 60
looks. At the deadline the worker fails, `Its first boot did not finish within
15 min (last seen: WHAT IT SHOWED LAST)`, with the
[failed first boot's](worker-bootstrap.md#failed-first-boot) recovery as its
next action: read the bootstrap in the instance's EC2 console output and check
that tailnet policy lets this device see the factory's tag; if the bootstrap
failed, terminate the instance and wait until it is terminated, or if it is
still running wait for it, then rerun apply. A failure, not a skip, because
apply's exit 0 must mean every worker is ready, and a machine that never came
up needs the operator; it does not stop the rollout, because no install step
ran on it (the release may have been uploaded and unpacked there, but `host
apply` refused it) and the next worker cannot repeat it.

Only workers this apply created are waited for. A worker whose machine already
existed and is missing from the tailnet, offline or still bootstrapping is
skipped as before: it is not booting because of this apply, and waiting would
hide a real problem behind a quarter of an hour of silence. A rerun installs it
once it is up.

While it waits apply says so, then every minute (`FIRST_BOOT_REPORT_MS`) what it
sees:

```text
Waiting for builder-1 (fff-abcd1234-builder-1) to finish its first boot (up to 15 min): this apply just created its machine.
Still waiting for builder-1 (fff-abcd1234-builder-1) after 1 of up to 15 min: No Tailscale device named fff-abcd1234-builder-1 is visible from this machine.
Installing release 0.3.0 on builder-1 (fff-abcd1234-builder-1): uploading 48.2 MiB.
```

The wait runs under the same lock and operation record, which shows the
workers stage `installing` throughout; the sleep is injected
(`WorkersStageDependencies.sleep`, `CliContext.sleep`), and `cli/interrupts.ts`'s
wakes at an interrupt. An interrupt while apply waits stops it at once: no
more looks, no more of the record written, the lock kept, and on standard
error ``Interrupted while waiting for KEY (HOSTNAME) to finish its first
boot: no install step ran on it.`` before what the interrupt left
([Interruption](#interruption)). An interrupt while a look's activation runs
is reported as any interrupted install.

### Refusals until lifecycle work lands (D11)

Until host retirement and replacement land in milestone M3, a plan is refused,
naming the capability it needs, and nothing is saved or applied:

| Change | Capability named |
| --- | --- |
| factory.json no longer declares a host key the state records (removal, or a rename) | `host retirement` |
| The Terraform plan does anything to an `aws_instance` but create it, update it in place or leave it: deletes, replaces (`delete` then `create`, or `create` then `delete`) or forgets it, or takes any action fffactory does not know | `host retirement and replacement` |

```text
Refusing: this change needs host retirement and replacement, which fffactory does not have yet (D11; it arrives in milestone M3):
  module.hosts.aws_instance.host["builder-1"] would be replaced
Nothing was applied. Change factory.json so the plan keeps every host machine, then plan again.
```

A host machine is a resource of type `aws_instance` whose mode is `managed`;
a plan that names no mode or type is judged by an address ending
`aws_instance.NAME[...]`, failing closed. Only the actions `no-op`, `read`,
`create` and `update` leave a host machine be; an in-place update, such as a
new instance type, is not refused. Any other action fails closed too, and is
named: `module.hosts.aws_instance.host["builder-1"] would be changed by an
action fffactory does not know (ACTION)`. Actions must be printable text, or
the plan cannot be read. The removal refusal lists each stable
host key issue ([provisioning §Stable host keys](provisioning.md#stable-host-keys))
and says `Declare every provisioned host key in factory.json again, then plan
again.` The refusals of an upgrade that needs a newer base generation or
changes the schema version are [upgrade's](#compatibility-refusals-d11).

## Saved plans

A plan with changes is saved in the operator's local plan store,
`<cache>/plans/<factory ID>/<plan ID>/` (directories 0700, files 0600):

| Entry | Holds |
| --- | --- |
| `factory.tfplan` | The factory root's Terraform plan file, written by Terraform. |
| `backend.tfplan` | Backend bootstrap's plan, on a first apply. |
| `factory.tfplan.sha256` | The factory plan file's SHA-256 when the plan was saved. |
| `plan.json` | The plan's record, written last: its presence saves the plan. |

The plan ID is eight random lowercase letters or digits. Only a well-formed
plan ID names a plan directory, so `--plan-id` can never name another path.

The record binds the plan to the circumstances it was planned in; it holds no
configuration value:

```json
{
  "schema_version": 1,
  "plan_id": "k3x9q2ab",
  "factory_id": "fff-abcd1234",
  "instance_path": "/work/.fffactory/factory.json",
  "configuration_sha256": "<SHA-256 of factory.json's exact text>",
  "release": "0.3.0",
  "assets_sha256": "<SHA-256 of the release assets>",
  "account_id": "123456789012",
  "state_revision": "<version and entity tag of the state object, or null>",
  "created_at": "2026-09-30T12:00:00.000Z",
  "expires_at": "2026-09-30T13:00:00.000Z",
  "changes": [{ "address": "module.hosts.aws_instance.host[\"builder-1\"]", "type": "aws_instance", "actions": ["create"] }],
  "control_plane": [{ "key": "builder-1", "hostname": "fff-abcd1234-builder-1", "observation": "no-release", "changes": ["paseo-package", "service-definition", "listen-address", "password"] }]
}
```

### Freshness

A saved plan may be applied only in the circumstances it was planned in. Its
live assumptions are the AWS account and the factory's Terraform state:

| Bound to | Stale when |
| --- | --- |
| `expires_at` | Now is later: a plan lives an hour (`PLAN_TTL_MS`). |
| `instance_path` | Another factory.json is selected. |
| `configuration_sha256` | factory.json's text changed at all, even its formatting. |
| `release` | Another fffactory release applies it. |
| `assets_sha256` | The same release applies it with other assets (a rebuilt development build). |
| `account_id` | The account check allowed a caller in another account. |
| `state_revision` | The factory's Terraform state object (`factory/terraform.tfstate` in the state bucket) has another revision, or appeared or vanished: another apply, or anything else, wrote it. |
| `control_plane[].observation` | The existing worker's active release or host-projection digest changed before activation. |

The revision is the state object's S3 version ID and entity tag, read with
HeadObject (`ExpectedBucketOwner` set); every write changes it. It is read
before planning, and compared again under the lock, where nothing else of
fffactory's can write the state. Terraform's own check backs this up: it
refuses a saved plan whose state lineage or serial changed. The plan's
Terraform file must still have the SHA-256 it was saved with, and its record
must read back as this factory's plan with this ID; otherwise the plan is
damaged. The file's SHA-256 is checked when the plan is loaded, before the
lock, and again under the lock, immediately before the file is read back and
immediately before it is applied: it must still be the file loaded, or the plan
is damaged and nothing is applied. Under the lock, the Terraform plan file that will be applied is read
back with `showPlan`: the changes shown for approval, and checked against D11,
are the file's, and a file whose changes differ from its record's is damaged.

Refusal:

```text
Refusing to apply plan k3x9q2ab: it is no longer the plan to apply:
  factory.json changed after it was planned
Nothing was applied. Review a new plan with `fffactory plan`.
```

The other reasons: `it expired at T`, `it was planned for another
factory.json, PATH`, `it was planned by fffactory R, not this release`, `it was
planned with other release assets than this fffactory's` (only when the release
is the same), `it was planned in AWS account A, not this one`, `the factory's
Terraform state changed after it was planned`, and `the state bucket no longer
exists`. An unknown or pruned plan ID: `There is no saved plan ID for this
factory here: ...`; a damaged one: `Saved plan ID cannot be applied: ...`.

Plans are short-lived. Each `plan` and `apply` first prunes the factory's plans
that expired over a day ago, and plan directories never saved that were made
over a day ago (`PLAN_KEPT_MS`; an interrupted command leaves one). Until then
an expired plan is refused as expired, a plan in use as it expires is never
removed under its apply, and an apply waiting at its approval question keeps
its plan. A saved plan is removed once apply held the lock for it, whatever
came of it: it is spent.

## Apply

```text
fffactory apply [--instance PATH] [--profile NAME] [--plan-id ID]
```

Without `--plan-id`, apply needs a terminal to ask for approval; without one it
is refused before reaching AWS: `Applying needs your approval of the plan:
rerun at a terminal, or save a plan with `fffactory plan` and apply exactly it
with --plan-id ID.` A malformed plan ID is refused before anything else.

After the checks above, and a saved plan's local freshness:

1. [`beginFactoryOperation`](provisioning.md#backend-bootstrap) bootstraps the
   backend when it is missing, after its own approval, and takes the
   factory-wide lock, recording the time it is taken, after any bootstrap. An
   interrupt before then takes no lock. A saved plan never bootstraps: it was made against an
   existing bucket, so a missing one makes it stale. A held lock refuses the
   apply, showing its holder.
2. Under the lock, the operation's record is written (next section).
3. With a saved plan, the state revision is compared, and the saved Terraform
   plan file is read back: its changes, which must be its record's, are the
   plan, and the D11 refusals apply to them. Without one, the infrastructure stage is planned
   afresh, as `plan` plans it, and every refusal applies.
4. One approval tied to exactly that plan: the plan is printed, then, at a
   terminal, `Apply this plan? Only "yes" applies it: `. Anything but `yes`
   (Ctrl-C included, which cancels the question) applies nothing: `Not
   approved: nothing was applied.`, exit 1. With `--plan-id`, naming the plan
   ID is the approval of exactly the plan `fffactory plan` showed under it, so
   nothing is asked: `Applying saved plan ID, approved by naming its ID.`
5. `Applying. Terraform's output is not shown; this can take several minutes.`
   Exactly the saved Terraform plan file is applied (`terraform apply
   PLANFILE`), never a new plan; a plan without infrastructure changes applies
   none.
6. The workers stage ([above](#the-workers-stage)).
7. The repository stage, exactly as shown in the plan, under the same lock.
8. The control-plane stage installs the approved release assets and performs
   only the approved classified lifecycle action. It is independent of dispatch.
9. The dispatch stage checks adoption without launching work, evaluates every
   independent gate, streams the approved desired projection through the fixed
   activator, and observes the resulting real schedule. Pending and disabled
   projections remove an existing schedule; all-passing requested projections
   install the dispatch assets and activate it. A worker the workers stage
   skipped (its maintenance deferred, offline, ...) or the tailnet no longer
   locates is `skipped` before any gate: it is sent nothing, its schedule left
   as it is, with the skip's reason and next action
   ([dispatch §Skipped workers](dispatch.md#skipped-workers)).
10. End-to-end verification joins the worker, repository, control-plane and
   observed dispatch outcomes. Pending, deferred or skipped is incomplete
   (exit 2); a failed reconciliation is a command failure (exit 1). A skipped
   worker's release is left as is, never reported absent.
11. `Operation record: s3://BUCKET/KEY`, with the combined exit status of those
   stages. The lock is released.

Every refusal exits 1 and applies nothing. Apply's Terraform deadline is an
hour ([provisioning §Operations](provisioning.md#operations)).

### Failure

A failure planning (`Planning failed: REASON. Nothing was applied.`) or applying
releases the lock and records the failure. Applying may have changed some
infrastructure before Terraform stopped:

```text
Applying failed: `terraform apply` exited with status 1.
Terraform may have changed some of the infrastructure before it stopped.
Rerun `fffactory apply`: it plans again from what exists now and converges what remains.
```

A Terraform apply that misses its deadline is stopped (SIGINT, then SIGKILL
after the grace period) and reported the same way, as ``did not finish within
3600 s``, even when Terraform happened to finish during the grace period: the
report is conservative, and a rerun plans from what exists. A Terraform killed
by SIGKILL may leave its own S3 state lock held, which fails later plans until
it is released; this is marked
`TODO(re-evaluate when an apply ends with Terraform's state lock left behind)`
in `src/application/apply-factory.ts`.

The reason is fffactory's own message, never Terraform's or AWS's output.
Terraform's standard error is kept in a private local file
([provisioning §Diagnostics](provisioning.md#diagnostics)), and only its path is
printed, after the failure and before the record's location:

```text
Terraform's diagnostics: /home/operator/.cache/fffactory/terraform/diagnostics/20260930T120000Z-apply-Ab12Cd.log
```

An unexpected error in the workers stage, such as the transport failing, is
reported the same way and recorded as the workers stage `failed`:

```text
Installing the workers failed: REASON.
The worker being installed may be on the new release, unhealthy.
Rerun `fffactory apply`: it plans again from what exists now and converges what remains.
```

A Terraform command that fails outside the lock, such as `fffactory plan`'s,
prints `fffactory: REASON` and the same line. Neither the diagnostics nor the
file's path reach the operation record or the state bucket.

### Operation records

Every apply that takes the lock keeps a record of itself in the state bucket
beside the lock, at `<factory ID>-operations/<started_at>-<lock ID>.json`
(`src/domain/operation.ts`), written with PutObject (`ExpectedBucketOwner` set)
when the lock is taken and again at every step:

```json
{
  "schema_version": 1,
  "operation_id": "<the lock ID>",
  "factory_id": "fff-abcd1234",
  "operation": "apply",
  "holder": { "principal": "arn:aws:sts::123456789012:assumed-role/Admin/operator", "host": "operator-laptop" },
  "release": "0.3.0",
  "plan_id": "k3x9q2ab",
  "status": "running",
  "stages": [{ "name": "infrastructure", "status": "applying" }],
  "workers": [],
  "repositories": [],
  "control_plane": [],
  "started_at": "2026-09-30T12:00:00.000Z",
  "updated_at": "2026-09-30T12:00:05.000Z",
  "finished_at": null,
  "failure": null
}
```

`plan_id` is null when apply planned for itself. The infrastructure stage goes
`planning`, `awaiting_approval`, `applying`, and ends `applied`, `unchanged`,
`declined`, `refused` or `failed`. The workers stage (`workers`) goes
`installing` and ends `installed`, `partial` or `failed`; `workers` lists each
worker as it ends, `{"key", "hostname", "status", "summary"}`, with status
`installed`, `skipped`, `failed` or `not_attempted` and the summary of a skip or
failure. The operation's `status` is `running` until it ends `succeeded`,
`partial` (a worker was skipped), `declined`, `refused` or `failed`, with
`failure` naming why (for a worker, `worker KEY: SUMMARY`). Records are history: nothing reads them to decide anything. A final
record that cannot be written after a successful apply does not fail it:
`The operation record could not be finished: REASON` on standard error, exit 0.
After a failure, the same line follows the failure's report, which is kept
whole, and the exit stays 1.

The repository stage (`repositories`) goes `synchronizing`, then
`synchronized`, `partial` or `failed`. Its `repositories` array records each
worker's key, hostname, result, unmanaged paths and summary. An unresolved or
skipped repository result makes the operation `partial` and apply exit 2.
The control-plane stage goes `reconciling`, then `reconciled`, `deferred` or
`failed`. Its `control_plane` array records each worker's key, hostname, safe
outcome and summary; it never records Paseo or secret output.
The dispatch stage goes `reconciling`, then `active`, `pending` or `failed`;
a skipped worker leaves it `pending`, like a pending one, and the operation
`partial` unless another stage failed. Its `dispatch` array records each worker's safe outcome
(`not_requested`, `active`, `pending`, `failed` or `skipped`), blocker gates and
summary, never credentials or tool output. The verification stage goes
`reconciling`, then `verified`, `pending` or `failed`, and records each
composite worker verdict; a skipped worker's `release` is `skipped`.

### Interruption

The first SIGINT, SIGTERM or SIGHUP prints

```text
Interrupted: stopping running tools. Interrupt again to kill them at once (Terraform may lose state).
```

on standard error (only its first sentence when no Terraform is running),
marks the command interrupted, wakes apply if it is sleeping, and stops Terraform
gracefully. Once Terraform has stopped, `fffactory` waits for apply to return and
say what the interrupt left, at most 5 seconds more (`RETURN_GRACE_MS`,
`src/cli/interrupts.ts`), and exits with 128 plus the signal's number
([provisioning §Environment and credentials](provisioning.md#environment-and-credentials)).
Apply returns at once: it starts nothing more, and an interrupt wakes its sleep
while it waits for a new worker. The grace only bounds a return stuck on
something no interrupt reaches, such as an AWS call within its deadline. A
second signal, at any point, kills the running tools and exits at once.

Only a command that checks the interrupt, starts nothing more once it is set
and reports what it left is waited for (`waitsOnInterrupt`): `apply`,
`upgrade`, `doctor` and `status`. Any other, such as `host apply`, `secret
set` or `lock break`, exits with 128 plus the signal's number as soon as its
running tools have stopped, never waiting for it to return, so it does not go
on with its work after the signal.
From the interrupt on, apply starts nothing more, takes no lock it does not
hold yet, writes no more of its record (even if Terraform finishes during its
grace period, or finishes reading back a plan that would be refused or change
nothing), and never releases its lock (`settleFactoryLock`,
`src/application/factory-lock.ts`), whether its work then fails or finishes. So
an interrupted apply deterministically leaves the lock and its operation record
at the step it reached, with `status` `running`, however the exit races the
work. An interrupt while the lock's conditional write is in flight may leave the
lock without a record.

When apply returns within that grace, as it does, it says what the interrupt
left, on standard error, and `fffactory` still exits with 128 plus the
signal's number:

| Left | Message |
| --- | --- |
| No lock: interrupted before it was taken | ``Interrupted before the factory was locked: it is not locked. Rerun `fffactory apply`: it plans again from what exists now.`` |
| The lock, and no record written yet | ``Interrupted: the factory stays locked by this apply, which may have no operation record. Once fffactory has exited, break the lock with `fffactory lock break`, then rerun `fffactory apply`.`` |
| The lock and its record | ``Interrupted: the factory stays locked, with a record of this operation. Once fffactory has exited, ...``, then `Operation record: s3://BUCKET/KEY` on standard output. |

An interrupt during the workers stage first names the worker it concerned:
``Interrupted while installing on KEY (HOSTNAME): host apply may still be
running there, ...`` while `host apply` ran, or ``Interrupted while waiting
for KEY (HOSTNAME) to finish its first boot: no install step ran on it.``
while apply waited for a new worker.

Interrupted while a worker's `host apply` ran, it first says so: stopping `ssh`
leaves `host apply` running on the worker, which has no terminal to hang up:
``Interrupted while installing on KEY (HOSTNAME): host apply may still be running there, and a rerun skips that worker until it has finished.``

A rerun is refused by the lock, which shows the interrupted apply as its
holder. Nothing takes a lock over or expires it, and a rerun cannot resume the
interrupted operation: once the interrupted `fffactory` has exited, the
operator breaks the lock with `fffactory lock break`, confirmed by its lock ID
([provisioning §`fffactory lock break`](provisioning.md#fffactory-lock-break)).
A rerun then plans again from what exists, which is what the interrupted
Terraform persisted, and converges what remains; a saved plan made before the
interruption is stale, since the state changed.

At a terminal, Ctrl-C at an approval question cancels the question instead of
interrupting: the plan is declined and the lock released. An interrupt that
arrives while the question is open wins over the answer: apply reports the
interrupt and keeps the lock, even when the question was declined.

## Upgrade

```text
fffactory upgrade [--instance PATH] [--profile NAME]
```

The minimal upgrade until milestone M3: run by a later fffactory than the
release factory.json pins, it moves the pin to the running release and applies
the factory's complete plan for it, as apply does, under one approval and the
one factory-wide lock (`upgradeFactory`, `src/application/upgrade.ts`). The
running release's own embedded bundle is what the workers stage installs, so
the upgrade installs the running release on every declared worker.

It needs a terminal: without one it is refused before anything else,
`Upgrading needs your approval of the pin move and the plan: rerun at a
terminal.` There is no saved upgrade plan.

### Before anything reaches AWS

1. factory.json is selected (`Instance: PATH (SOURCE)`) and read, and its
   `schema_version` is compared with the running release's before it is
   validated, since a release of another schema version could not validate it
   ([below](#compatibility-refusals-d11)).
2. factory.json is validated.
3. The pin is judged (`assessUpgrade`, `src/domain/release-compatibility.ts`),
   in [semantic versioning precedence](https://semver.org/#spec-item-11):
   - the running release: `factory.json already pins this release, 0.3.0:
     there is nothing to upgrade. `fffactory apply` converges the factory to
     it.`, exit 0;
   - a later release (a downgrade, a design non-goal): `Refusing to upgrade:
     factory.json pins a later fffactory release than this one, 0.3.0:
     fffactory never moves a pin back to an earlier release (downgrade is not
     supported). Install the release factory.json pins.`, exit 1;
   - no pin: `Refusing to upgrade: factory.json is not ready:` and `release: is
     required to upgrade`, exit 1;
   - an earlier release whose workers lack the running release's base
     generation: refused ([below](#compatibility-refusals-d11));
   - otherwise, an earlier release: the upgrade goes on.
4. The account check and the release assets, as for [plan and
   apply](#before-anything-reaches-aws).

### The pin move and the plan

apply's operation runs with the lock and its record named `upgrade`, and a
pin move. An upgrade never bootstraps the backend: its one approval is the pin
move's and the plan's. A factory without its state bucket is refused before
anything is shown, asked, created or locked: `Refusing to upgrade: the factory
has no state bucket yet, and an upgrade never creates it. Nothing was created
or applied. Run `fffactory apply` with the release factory.json pins first,
then rerun `fffactory upgrade`.`, exit 1.

1. Under the lock, the infrastructure stage is planned afresh from
   factory.json as it will be once the pin moves: the document read, with only
   `release` changed to the running release. Every refusal of plan and apply
   applies, and the workers stage installs the running release.
2. The pin move is shown first, then the plan, and approved together:

   ```text
   Upgrade: factory.json's release pin moves from 0.2.0 to 0.3.0. It is written once you approve this plan, before anything is applied.
   Factory plan:
     ...
     Release: 0.3.0
   ...
   Move the pin and apply this plan? Only "yes" does:
   ```

   The earlier pin is shown only when it is a plain `MAJOR.MINOR.PATCH`,
   which cannot hold anything else; otherwise `from the release it pins now`.
3. Once approved, and only then, the new pin is written (`factory.json now
   pins release 0.3.0.`): the document, serialized as `init` and `secret set`
   write it, with only `release` changed. It is written only while factory.json
   is still the exact text the plan was made from; otherwise nothing is
   written or applied: `Refusing to upgrade: factory.json changed after the
   plan was made. Nothing was applied. Review a new plan with `fffactory
   upgrade`.`, exit 1.
4. Then the plan is applied exactly as apply applies it: the saved Terraform
   plan file, then the workers stage.

So the plan applied is the plan approved, made for the factory.json the pin
write leaves. Freshness needs no saved plan: the plan is made under the lock
and applied in the same operation, and the text comparison under the lock
binds it to factory.json.

The pin is written before anything is applied, so from then on factory.json
pins the release being installed, as the design requires when some workers
are offline or busy. A failure applying or installing, an interrupt, or a
skipped worker leaves the pin moved; the failure's rerun line names
`fffactory apply`, which this release may now run and which converges what
remains. Declined, refused, a planning failure, or an interrupt before the pin
was written leave the pin where it was, and add on standard error
`factory.json's pin was not moved: it still pins the release it pinned.`; their
rerun lines, where they have one, name `fffactory upgrade`. A failure moving
the pin is `Moving factory.json's pin failed: REASON. Nothing was applied.`. A
failure once the pin was written and before anything is applied (its record
could not be written) is `Upgrading failed once factory.json's pin moved:
REASON. Nothing was applied.`, followed by `factory.json pins release 0.3.0:
rerun `fffactory apply` with this release to finish.`

The operation record starts with a `pin` stage, `pending`, before the
infrastructure stage; it ends `written`, `refused` (factory.json changed) or
`failed` (writing it failed). An upgrade that ends before the pin is written,
declined, refused or failed while planning, ends the `pin` stage the same way
(`finishOperation`: a stage still `pending` never started). A failure after the
pin was written is the infrastructure stage's; the `pin` stage stays
`written`. An interrupt before the pin was written leaves it `pending`, since
nothing more of the record is written after an interrupt. The lock's and the record's `operation` is `upgrade`, and their
`release` the running release. A lock an interrupted upgrade left is broken
with `fffactory lock break`, which the pin guard does not refuse.

The exit status is apply's: 0 once every worker is installed, 2 when a worker
was skipped, 1 when anything failed or was refused.

### Compatibility refusals (D11)

Each release declares, in its executable (`RELEASE_COMPATIBILITY`,
`src/domain/release-compatibility.ts`):

| Field | Declares |
| --- | --- |
| `schema_version` | The factory.json schema version it reads and writes (`SCHEMA_VERSION`). |
| `base_generation` | The minimum base generation it supports: the base its worker bootstrap sets up, which its install steps and worker executable rely on. |
| `base_generation_since` | The first release that needed that base generation. |

The declaration is not in the bundle's `release.json`, which names the release
alone: the activator every worker's base carries refuses any other
([worker bootstrap §Activator](worker-bootstrap.md#activator)).

Bootstrap sets up a worker's base once, at its first boot, and no upgrade
reruns it, so every worker of a factory pinned to a release earlier than
`base_generation_since` has an older base: no upgrade could have moved that
factory past the release that raised the generation. The CLI therefore judges
the base from the pin alone, without contacting a worker, as `plan` never
does. Until schema and base migrations land in M3, an upgrade is refused,
naming the capability, and nothing is written or applied:

| Upgrade | Capability named | Reason |
| --- | --- | --- |
| factory.json's `schema_version` is earlier than the running release's | `schema migration` | `factory.json has schema version 1, and this release reads and writes schema version 2` |
| The pin is earlier than `base_generation_since` | `base migration` | `release 0.4.0 needs base generation 2, which arrived in release 0.3.5: workers set up by the release factory.json pins have an older base` |

```text
Refusing: this change needs base migration, which fffactory does not have yet (D11; it arrives in milestone M3):
  release 0.4.0 needs base generation 2, which arrived in release 0.3.5: workers set up by the release factory.json pins have an older base
Nothing was applied. factory.json still pins its release; keep using that release until base migration arrives.
```

A factory.json whose `schema_version` is later than the running release's was
written by a later release: it is refused as a downgrade. A `schema_version`
that is not an integer is left to validation.

This release declares schema version 1 and base generation 2 since release
0.0.1, the first release with a worker bootstrap. Generation 2 adds the fixed
dispatch operations to the root activator; the release's worker endpoint
depends on that narrow authority. No released fffactory ever set up a
generation-1 worker, so refusing a pin before 0.0.1 is a precaution, not a
known stranded worker: a factory pinned to 0.0.1 or later may upgrade, and one
pinned to 0.0.0 is refused base migration.
`tests/assets/bootstrap/base-generation.test.ts` records the worker
bootstrap's digest for each base generation, so a change to the bootstrap
fails until whoever changes it decides whether it raises the base generation.
It also requires `base_generation_since` to be no later than the running
release (package.json's version), so the declaration never names a release
that does not exist yet, and checks the shipped declaration: a pin at
`base_generation_since` may move to the running release, and a 0.0.0 pin is
refused (D11).

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/plan.ts` | Plan IDs, the CLI/pin match guard, reading a JSON plan's resource changes, the plan's presentation, the D11 refusals, the saved plan record, its freshness rule, `FACTORY_STATE_KEY`, `PLAN_TTL_MS`. Pure. |
| Domain | `src/domain/release-compatibility.ts` | `RELEASE_COMPATIBILITY`, release precedence, upgrade's assessment of the pin, the schema version check, the base generation and schema D11 refusals, the pin move's preview. Pure. |
| Domain | `src/domain/operation.ts` | The operation record, its key, stage transitions (upgrade's `pin` stage too), workers, repositories and control-plane outcomes. Pure. |
| Domain | `src/domain/repository-placement.ts` | The per-worker repository manifest, fixed worker protocol commands, and completed-result parser. Pure. |
| Domain | `src/domain/stable-host-keys.ts` | `recordedHostKeys`, reading the factory root's `host_keys` output. |
| Application | `src/application/plan-factory.ts` | `checkPlannable`, `planInfrastructure`, `planFactory`. |
| Application | `src/application/apply-factory.ts` | `applyFactory`: saved-plan freshness, the lock, infrastructure, workers, repository and control-plane stages, operation records, interruption. |
| Application | `src/application/plan-control-plane.ts` | Derives Paseo changes and saved live observations from worker inspections. |
| Application | `src/application/apply-workers.ts` | `applyWorkers`: the workers stage ([host protocol §apply](host-protocol.md#apply)). |
| Application | `src/application/apply-repositories.ts` | `applyRepositories`: projects each approved worker manifest through the fixed repository host protocol and records synchronized, unresolved, and unmanaged results. |
| Application | `src/application/upgrade.ts` | `upgradeFactory`: the refusals, then apply's operation with the pin move written under the lock once approved. |
| Application | `src/application/set-secret.ts` | The CLI/pin match guard on `secret set`. |
| Domain | `src/domain/rollout.ts` | A worker's outcome, the rollout rule, and the first boot wait's rules: its deadline, poll and report intervals, which tailnet states are still joining, a bootstrap refusal to wait for, and the timed-out failure. Pure. |
| Application | `src/application/plan-store.ts` | The `PlanStore` port, with `digest` for the check under the lock, and `planStoreDirectory`. |
| Application | `src/application/factory-lock.ts` | `Interrupted` and `settleFactoryLock`: an interrupted operation keeps its lock. |
| Application | `src/application/lock-store.ts` | `writeOperation` and `stateRevision` on the state bucket port. |
| Infrastructure | `src/infrastructure/plan-store.ts` | `filesystemPlanStore`: private plan directories, the plan file's digest, pruning. |
| Infrastructure | `src/infrastructure/aws-s3-lock-store.ts` | PutObject of operation records; HeadObject of the state object. |
| CLI adapter | `src/cli/commands/plan.ts`, `src/cli/commands/apply.ts`, `src/cli/commands/upgrade.ts`, `src/cli/commands/planning.ts` | The commands, the approval at the terminal, and what they share. |
| CLI adapter | `src/cli/diagnostics.ts`, `src/cli/run.ts` | The path of a failed Terraform command's diagnostics, printed with the failure. |
| CLI adapter | `src/cli/interrupts.ts` | `interruptible`: the interrupt notice and flag, the sleep an interrupt wakes, stopping running tools, then, for a command that waits on an interrupt, waiting `RETURN_GRACE_MS` at most for it to return, before exiting with 128 plus the signal's number; a second signal kills and exits at once. |
| CLI adapter | `src/cli/run.ts`, `src/cli/context.ts` | `waitsOnInterrupt`: only `apply`, `upgrade`, `doctor` and `status` (`Command.waitsOnInterrupt`) are waited for. |
| CLI adapter | `src/cli/main.ts` | Wires `terraformProvisioner`, `filesystemPlanStore`, and `interruptible` over the process, waiting on an interrupt as `waitsOnInterrupt` says for the command run. |

Tests: `tests/domain/plan.test.ts` (plan IDs, the pin guard, presentation, both
D11 refusals, unknown host machine actions refused, the record round trip and unreadable records, every staleness
reason, the workers whose machine a plan creates), `tests/domain/rollout.test.ts` (the first boot's
deadline, the tailnet states still joining, the bootstrap refusal waited for,
the timed-out failure and the rollout going on after it), `tests/domain/operation.test.ts`, `tests/domain/stable-host-keys.test.ts`
(recorded host keys), `tests/application/plan-factory.test.ts` (a first plan,
the state revision bound before planning, no infrastructure changes still saved with the workers, the pin guard, incomplete
factory.json, another account, a missing bucket's bootstrap plan, an unready
bucket, a held lock, host key removal refused before Terraform plans, a host
replacement refused and never saved, unreadable outputs and plans, a failing
Terraform plan, no Terraform state lock, pruning), `tests/application/apply-factory.test.ts` (against
`tests/support/fake-provisioner.ts`'s `fakeFactoryWorld`, a factory whose
Terraform state changes as plans apply: plan, approve and apply under one lock;
a first apply's two approvals; declining either; both D11
refusals before apply; the pin guard; a held lock; failing plan and apply; a
record that cannot be finished, after applying or after a failure; a saved plan applied exactly, refused after
factory.json changes, from another release or with other assets, expired,
after the state changed, unknown, damaged, whose record no longer matches its
Terraform plan, unreadable, replacing a host, without its bucket, or whose
Terraform plan file was swapped after it was loaded or after it was read back; a lock
taken after bootstrap and never after an interrupt
(`tests/application/bootstrap-backend.test.ts`); the workers stage after the
infrastructure under the same lock and record, without infrastructure changes
still approved and installed with no Terraform apply, a failed install stopping
the rollout and failing the operation and a rerun repairing it, a skip making
it partial, an interrupt while installing keeping the lock and record and
naming the worker it was installing, a tailscale.tag missing by then an error
rather than a default, and an unexpected error failing the workers stage;
`tests/application/apply-workers.test.ts` (a timeout or dropped connection
saying the worker may still be installing, a busy worker skipped, an answer
for another worker failed; a new worker waited for until it joins the tailnet
and until its bootstrap finishes, uploaded once, failing after 15 minutes with
the rollout going on, reporting every minute, bounded under a stalled clock,
refused at once for a duplicate or untagged device appearing, an interrupt
while waiting, and a worker this apply did not create skipped without waiting);
in `apply-factory.test.ts`, a worker the apply creates waited for and installed
in the same run, a provisioned worker missing skipped without waiting, a first
boot timing out failing the operation, and an interrupt while waiting keeping
the lock and record; an apply
interrupted part way through leaving its lock and record, refused until the
lock is broken, then converging; interrupts at approval, whether approved or
declined, while Terraform reads a
plan back (no more of the record written), once the record is written, while
taking the lock and before it), `tests/application/factory-lock.test.ts` (an
interrupted operation keeps its lock), `tests/infrastructure/plan-store.test.ts`
(including the plan file's digest as it is now),
`tests/infrastructure/aws-s3-lock-store.test.ts` (records and state revisions,
stubbed and against `tests/support/stub-s3.ts`),
`tests/infrastructure/terminal-prompt.test.ts` (Ctrl-C cancels an echoed
question), `tests/cli/plan-apply.test.ts` (output, exit codes and every refusal
in process, the workers' lines and exit codes 0, 2 and 1; one apply creating,
waiting for and installing a worker; the wait's lines and a first boot timing
out with exit 1 and its recovery; instructions a
worker sends never printed; what each interrupt left, including a worker that
may still be installing or a new worker being waited for; and, over the real provisioner and the
stand-in Terraform, a failed apply's and plan's diagnostics kept in a private file
whose path alone is printed, out of the output and the record), `tests/cli/apply-interrupted.test.ts` (the spawned `fffactory`
over the stand-in Terraform and the S3 and STS stubs: SIGINT while Terraform
applies exits 130 with the notice and apply's report of the lock and record it
leaves, and leaves the lock and a `running` record; a rerun is refused until
`lock break`, then applies Terraform and, run from source, skips the worker;
and SIGINT while apply waits for a new worker's first boot, in
`tests/support/apply-first-boot-main.ts` over the in-memory factory, exits 130
only after naming the worker and the lock it keeps), `tests/cli/interrupts.test.ts`
(the exit after the command returns, never before its tools stop, and at the
grace's end at the latest; a command that does not wait exiting once its tools
stop, without waiting for it; each signal's status; a second signal at once;
sleeps woken), `tests/cli/run.test.ts` (only apply, upgrade, doctor and status
wait on an interrupt; `host`, `secret` and `lock` do not),
`tests/cli/main.test.ts`
(doctor's interrupt notice, which offers no second interrupt), and `tests/assets/terraform/guardrails.test.ts` (the
factory root's backend key is `FACTORY_STATE_KEY`, and it outputs `host_keys`).

Upgrade: `tests/domain/release-compatibility.test.ts` (release precedence, the
pin assessment: an upgrade, nothing to upgrade, a downgrade, no pin, the base
generation refusal and a pin at the generation's release; the schema version
check before validation; the preview never echoing a prerelease pin),
`tests/domain/plan.test.ts` (the guard's wording for an earlier and a later pin),
`tests/application/upgrade.test.ts` (the pin move shown with the plan for the
running release, written under the lock once approved and before Terraform
applies, the record's `pin` stage and `upgrade` operation; declined, a planning
refusal and a planning failure ending the `pin` stage the same way; no state
bucket refused with nothing bootstrapped, asked, locked or written; factory.json
changed after planning; a failed apply leaving the pin moved and a plain apply
converging; a failure writing the pin; a failure after the pin was written,
recorded as the infrastructure stage's; an interrupt after the pin was written,
its lock broken and apply finishing; every refusal before AWS: nothing to
upgrade, a downgrade, no pin, base and schema D11),
`tests/cli/upgrade.test.ts` (the output and question, plan passing the guard
once upgraded, declined, a failed apply naming `fffactory apply`, a failure
once the pin moved, no state bucket, no terminal,
nothing to upgrade and the other refusals without reaching AWS, usage),
`tests/application/set-secret.test.ts` and `tests/cli/secret.test.ts` (the guard
on `secret set` before AWS), `tests/cli/lock.test.ts` (`lock break` whatever
the pin), `tests/cli/plan-apply.test.ts` (the guard on plan and apply) and
`tests/assets/bootstrap/base-generation.test.ts` (the bootstrap's digest per
base generation).

Introduced by [#99](https://github.com/yaunder/factory/issues/99); upgrade by
[#102](https://github.com/yaunder/factory/issues/102).
