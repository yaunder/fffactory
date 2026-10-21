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

1. resolve and validate factory.json, printing first the command's header,
   laid out as [CLI output](cli-output.md) describes:

   ```text
   fffactory plan · release 0.3.0
   Instance  /work/.fffactory/factory.json (nearest .fffactory/factory.json)
   ```

   The path is the selected factory.json's, whole: under the operator's home
   directory it is shown from `~`
   (`Instance  ~/test-factory/.fffactory/factory.json (--instance)`), and it is
   never shortened further, since it is how the operator tells which
   factory.json the command acts on. The source is named in `describeSource`'s
   words, the ones doctor's JSON summary publishes
   ([instance configuration §Instance discovery](instance-configuration.md#instance-discovery)),
   never a second mapping;
2. run the account check and refuse, with doctor's summary, details and next
   action, unless the caller is in `aws.account_id`
   ([instance configuration §Credentials](instance-configuration.md#credentials));
3. materialize this release's assets, whose SHA-256 is the release's asset
   identity, and run the managed Terraform from their `terraform/` tree;
4. refuse unless this fffactory is the release factory.json pins (the CLI/pin
   match guard), and unless factory.json is
   [complete](instance-configuration.md#completeness), listing each missing
   field `is required to plan`.

### How refusals are shown

A refusal of `plan`, `apply` or `upgrade` that concerns its plan (the pin
guard, an incomplete factory.json, an unready state bucket, a held lock, the
D11 and stopped-worker refusals, an unreadable Terraform plan and a saved
plan's) goes to standard error, after a blank line that separates it from the
header on a terminal: an error status line (`✖`), each reason indented under
it, `Nothing was applied.` where the refusal concerns a change, and, where
there is something to do, a closing Next block. A command it names repeats the
`--instance` and `--profile` the refused command was given, quoted for a POSIX
shell. Each example below shows it. The account check's refusal (2) and an
invalid factory.json keep their own lines, as every other command prints them,
until those commands are restyled.

### CLI/pin match guard

Only the release factory.json pins may plan or change the factory
(`pinRefusal`, `src/domain/plan.ts`). The pin is a configuration value, so it
is never echoed:

```text
✖ Refusing to plan: factory.json pins another fffactory release than this one, 0.3.0: only the pinned release may plan or change this factory. Install the release factory.json pins, or move the pin to 0.3.0 with `fffactory upgrade`.
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
| `worker stop`, `worker start`, `worker terminate` | Yes, after the account check and before the lock: `Refusing to stop the worker: ...` | They change a worker's machine under the lock ([worker lifecycle](worker-lifecycle.md)). |
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
   [backend bootstrap's](provisioning.md#backend-bootstrap): planned as
   bootstrap plans it, create-only, into a new plan directory's
   `backend.tfplan`, and saved as a [bootstrap plan](#saved-plans). It is
   shown as bootstrap shows it, then where it is saved and how to apply
   exactly it; exit 0:

   ```text
   ── Plan: backend bootstrap ──────────────────────────
     Factory   Test factory (fff-abcd1234)
     Account   123456789012 · eu-west-2
     Release   0.3.0

     State bucket     fff-abcd1234-state, which does not exist yet
     Infrastructure   1 to add, 0 to change, 0 to destroy
       + module.state_bucket.aws_s3_bucket.state

   Saved as plan b7q2m9xk, until 2026-09-30T13:00:00.000Z.
   The factory itself is planned once the state bucket exists.

   ── Next ─────────────────────────────────────────────
     Apply exactly this plan:
       $ fffactory apply --plan-id b7q2m9xk --profile factory
     Then plan the factory:
       $ fffactory plan --profile factory
   ```

   Both commands repeat `--instance` and `--profile` as a factory plan's
   does (5). `fffactory apply --plan-id B` then creates the bucket without a
   terminal and stops
   ([Applying a saved bootstrap plan](#applying-a-saved-bootstrap-plan)); the
   next `fffactory plan` finds the bucket and plans the factory. A bootstrap
   plan Terraform shows doing more than create, or nothing, or that cannot be
   read, is refused as Terraform's plan fffactory cannot apply; it saves
   nothing, and its plan directory is removed. `fffactory apply` at a terminal
   still bootstraps interactively, after its own approval
   ([Apply](#apply) 1).
2. A bucket bootstrap did not finish is refused as bootstrap refuses it.
3. While the factory is locked, planning is refused with the holder
   ([provisioning §Lock](provisioning.md#lock)): a plan made during another
   operation would be stale.
4. The infrastructure stage is planned (next section), then the workers stage
   ([below](#the-workers-stage)), Paseo control-plane changes derived from each
   worker's inspection, repository reconciliation for every declared worker,
   the complete requested dispatch projection (or schedule removal), and
   end-to-end verification.
5. The plan is printed, as the `Plan` section, then the plan saved, and a
   closing Next block applying exactly it:

   ```text
   fffactory plan · release 0.3.0
   Instance  /work/.fffactory/factory.json (nearest .fffactory/factory.json)

   ── Plan ─────────────────────────────────────────────
     Factory   Test factory (fff-abcd1234)
     Account   123456789012 · eu-west-2
     Release   0.3.0

     Infrastructure   2 to add, 0 to change, 0 to destroy
       + module.network.aws_vpc.this
       + module.hosts.aws_instance.host["builder-1"]
     Workers          one at a time
       ~ builder-1   install release 0.3.0 and host configuration, then verify
     Control plane    before worker activation
       ~ builder-1   paseo-package, service-definition, listen-address, password
     Repositories     one worker at a time
       ~ builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts
     Dispatch         after every readiness gate
       ~ builder-1   remove the factory dispatch schedule if it exists
     Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule

   Saved as plan k3x9q2ab, until 2026-09-30T13:00:00.000Z.

   ── Next ─────────────────────────────────────────────
     Apply exactly this plan:
       $ fffactory apply --plan-id k3x9q2ab
   ```

   The apply command repeats the `--instance` and `--profile` the plan was
   given, quoted for a POSIX shell where needed (`--instance
   '/elsewhere/it'\''s my factory.json'`), since a saved plan applies only
   with the same factory.json. The section names the factory, its account and
   Region, and the release; the factory.json is the header's. Each stage is a
   row, its label aligned with the others'
   ([CLI output §Rows](cli-output.md#rows)), and its changes are indented under
   it, each worker by its key alone (its hostname is the factory ID and the key).
   The infrastructure row tallies the changes, then shows each with Terraform's
   symbol: `+` create, `~` update, `-` delete, `-/+` and `+/-` replace (in
   color, green, yellow, and red for a delete or replacement); any other set of
   actions is shown by name, and reads and no-ops are left out. Without
   infrastructure changes the row reads `no changes`. A worker's change in a
   stage is marked `~`; a worker the stage sends nothing (stopped, or whose
   Paseo is unchanged) has no glyph. Every plan is saved, even one with nothing
   to change. A factory that declares a worker has the workers, control-plane,
   repository, dispatch and verification stages' changes; one that declares
   none has no stage after the infrastructure
   ([An empty factory](#an-empty-factory)). A saved plan contains the dispatch
   projection; a record without it is damaged and is never applied.

### An empty factory

factory.json may declare no worker, `hosts: []`, as
[`fffactory worker terminate KEY`](worker-lifecycle.md#terminate-remove) leaves
it after removing the last host; it is complete
([instance configuration §Completeness](instance-configuration.md#completeness)).
Its plan is the factory's shared infrastructure alone: the
[projection](provisioning.md#terraform-inputs) has no hosts and no Paseo
passwords, Terraform plans no instance, and the hosts' policy allows only the
Tailscale enrollment key. In place of the workers and later stages the plan
shows how to add one:

```text
── Plan ─────────────────────────────────────────────
  Factory   Test factory (fff-abcd1234)
  Account   123456789012 · eu-west-2
  Release   0.3.0

  Infrastructure   no changes
  Workers          none declared. Declare a host in factory.json's hosts, then create it with `fffactory apply`.
```

Its `fffactory apply` repeats the `--instance` and `--profile` the plan was
given.

Apply asks for the approval of that plan and applies it as any other, under the
lock and its record. It installs nothing and reaches no worker. Its Result keeps
the guidance, with no repository, control-plane or dispatch rows and no Next
block; exit 0, never partial:

```text
── Result ───────────────────────────────────────────
    Infrastructure     no changes
    Workers            none declared. Declare a host in factory.json's hosts, then create it with `fffactory apply`.
  ✔ Verification       The factory is ready: it declares no workers
    Operation record   s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json
```

`upgrade` moves the pin of an empty factory the same way.

A host declared later is a plain create, applied and waited for
([Waiting for a new worker](#waiting-for-a-new-worker)) as any new worker: under
a new key, or under the key just removed, since Terraform no longer records it
and the D11 refusal concerns only a recorded key no longer declared. Its
`instance_type` and `root_volume_gib` need not be the removed host's.

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
`declaredWorkers` (`src/domain/plan.ts`) makes them, and `planSection`
(`src/cli/presentation/plan.ts`) shows them.

Under the lock, after the infrastructure stage (applied, or with no changes
skipped: no Terraform apply runs), `applyWorkers`
(`src/application/apply-workers.ts`) takes the workers one at a time:

1. If the running executable carries no worker executable, as when run from
   source, every worker is skipped before the tailnet is read: `This fffactory
   carries no worker executable: it runs from source, not from a built
   release`.
2. A worker the approved plan skips as stopped is sent nothing
   ([below](#stopped-workers)). The peer view is read once; each other worker
   is found by the [hostname-match rule](host-protocol.md#finding-the-worker),
   or skipped with status's reason and next action. A worker whose machine this
   apply created is instead waited for while it boots
   ([below](#waiting-for-a-new-worker)). Before any upload, an existing worker
   with approved Paseo maintenance is asked for agent activity. Active or
   unknown activity defers it without upload or activation, leaving its
   complete current release in place: it is skipped, `Paseo maintenance is
   deferred while agents may be active` ([control plane §Pre-activation
   deferral](control-plane.md#pre-activation-deferral)).
3. The release tarball is uploaded and activated with its embedded digest and
   the host projection on standard input ([host protocol §apply](host-protocol.md#apply)):
   the one `projectHosts` builds from factory.json's hosts, Paseo secret
   reference included, whose digest plan and `status` expect.
   While it works apply streams a row per step into its `Applying` section,
   the worker by its key alone: `KEY   uploading N MiB`, then `KEY   installing
   and verifying (can take many minutes)` ([Apply](#apply)).
4. A worker counts as installed only once `host apply` answered with its
   verification, in a document for that worker and release. A known skip (not
   found, offline, an SSH login refused, an upload SSH could not finish,
   bootstrap not finished, an install still running on it) leaves the rest to
   be attempted; an install or verification failure stops the rollout, and the
   remaining workers are not attempted. A new worker whose first boot did not
   finish in time fails without stopping the rollout: no install step ran on
   it. Each outcome is written to the operation record as it ends. When the
   activation times out or its connection drops, `host apply` may still be
   installing: the worker fails with that said, and its next action is to wait
   for that install, then rerun.

Apply's Result then has a row per worker, in factory.json's order, by its key
alone: its workers-stage outcome, then, under it, each later stage that ran for
it ([Apply](#apply)). Every pending action is collected in the one closing Next
block. An installed worker with enrollment pending and a skipped one:

```text
── Result ───────────────────────────────────────────
    Infrastructure     no changes
  ! builder-1          installed and verified · enrollment pending (3)
    ✔ Control plane   applied
    ✔ Repositories    synchronized
      Dispatch        not requested
  ↷ builder-2          skipped · Offline in the tailnet
    ↷ Repositories    skipped
    ↷ Dispatch        skipped
  ! Verification       The factory is not ready: 1 of 2 workers need attention · enrollment pending on 1 worker
    Operation record   s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json

── Next ─────────────────────────────────────────────
  builder-2: Check that the instance is running and that Tailscale is up on it, then rerun `fffactory apply`.

  On builder-1, log in as factory (tailnet SSH policy must allow it):
    $ tailscale ssh factory@fff-abcd1234-builder-1

  1. GitHub
     $ gh auth login --hostname github.com --git-protocol https --web
     $ gh auth status --hostname github.com --active
  2. OpenAI Codex
     $ codex login --device-auth
     $ codex login status
  3. Claude Code
     $ claude auth login
     $ claude auth status

  Return to your workstation:
    $ exit
  Refresh enrollment verification, reviewing the new plan:
    $ fffactory apply
  Then confirm:
    $ fffactory status
  Paseo clients: enrollment is checked from each client, not the worker
```

| Worker outcome | Status | Its row says |
| --- | --- | --- |
| Installed, every account enrolled | `✔` ready | `installed and verified · every account enrolled` |
| Installed, accounts to enroll | `!` action needed, never `✔` | `installed and verified · enrollment pending (N)` |
| Skipped | `↷` skipped | `skipped · SUMMARY` |
| Failed | `✖` failed | `failed · SUMMARY` |
| Not attempted after a failure | `◌` not attempted | `not attempted · the rollout stopped at the failure above` |
| Stopped | `◼` stopped | ``stopped · nothing was sent to it; to install it, start it with `fffactory worker start KEY`, then apply again`` |

A worker's status is its worst stage's (a failure, then action needed, then a
skip, then ready): an installed, enrolled worker whose control plane is
deferred or failed, whose repositories are unresolved, or whose dispatch is
pending or failed is not shown ready. A stage row that sends nothing, such as
dispatch not requested, has no glyph; a stopped worker has no stage rows, as no
stage sent it anything. A later stage skipped for the reason the workers stage
already gave says only `skipped`. Summaries are shown as data, never read for
inline code.

Each account's steps are apply's own, named for the hostname it resolved, never
text from the worker ([readiness §Enrollment](readiness.md#enrollment)). An
account whose API credential factory.json delivers to the worker, as the host
projection apply streamed says, is enrolled by apply itself; when the worker
did not accept it, its step comes first, once for every worker it concerns,
with no login: store a valid one, then apply again
([credential delivery §Renewal](credential-delivery.md#renewal)):

```text
── Next: enroll 1 account on builder-1 ──────────────
  Replace the GitHub token, which builder-1 did not accept:
    $ fffactory secret set github-token
  Refresh enrollment verification, reviewing the new plan:
    $ fffactory apply
  Then confirm:
    $ fffactory status
  Paseo clients: enrollment is checked from each client, not the worker
```

Failed and not-attempted workers' rows go to standard error. The exit status is 0 when every
worker was installed and verified or is stopped, 2 when one was skipped and
none failed, and 1 when one failed, including a new worker whose first boot did
not finish in time. The dispatch stage never fails a skipped worker: it reports
it `skipped` and sends it nothing. A deferred worker also bypasses the
control-plane stage, but one skipped for another reason that the tailnet still
locates goes through the control-plane stage, which may fail it (exit 1). Exit
0 means every worker is ready or stopped, but for the accounts a human
enrolls: fffactory cannot enroll them, so pending enrollment still counts as
installed, and the Next block names each step. A failed install leaves that
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
that tailnet policy lets this device see the factory's tag; if the console
output shows the bootstrap failed, terminate it uninspected with `fffactory
worker terminate KEY --keep --force`, or if it is still running wait for it,
then rerun apply. A failure, not a skip, because
apply's exit 0 must mean every worker is ready or stopped, and a machine that never came
up needs the operator; it does not stop the rollout, because no install step
ran on it (the release may have been uploaded and unpacked there, but `host
apply` refused it) and the next worker cannot repeat it.

Only workers this apply created are waited for. A worker whose machine already
existed and is missing from the tailnet, offline or still bootstrapping is
skipped as before: it is not booting because of this apply, and waiting would
hide a real problem behind a quarter of an hour of silence. A rerun installs it
once it is up.

While it waits apply says so in its `Applying` section, then every minute
(`FIRST_BOOT_REPORT_MS`) what it sees, after Terraform's row for the apply that
created the machine:

```text
── Applying ─────────────────────────────────────────
  Infrastructure   applying with Terraform (its output is not shown; can take several minutes)
  builder-1        waiting for its first boot (up to 15 min): this apply just created its machine
  builder-1        still waiting after 1 of up to 15 min: No Tailscale device named fff-abcd1234-builder-1 is visible from this machine
  builder-1        uploading 48.2 MiB
  builder-1        installing and verifying (can take many minutes)
```

A first boot that did not finish in time is the worker's `✖ builder-1 failed ·
Its first boot did not finish within 15 min (last seen: …)` row, on standard
error, and its recovery a step of the Next block.

The wait runs under the same lock and operation record, which shows the
workers stage `installing` throughout; the sleep is injected
(`WorkersStageDependencies.sleep`, `CliContext.sleep`), and `cli/interrupts.ts`'s
wakes at an interrupt. An interrupt while apply waits stops it at once: no
more looks, no more of the record written, the lock kept, and on standard
error ``Interrupted while waiting for KEY to finish its first boot: no install
step ran on it.`` under what the interrupt left
([Interruption](#interruption)). An interrupt while a look's activation runs
is reported as any interrupted install.

### Stopped workers

A worker stopped with `fffactory worker stop` ([worker
lifecycle](worker-lifecycle.md)) is not broken: apply never starts it, sends it
nothing, and it does not make the operation partial. EC2's state is the truth.
Plan and apply read the factory's EC2 inventory (`DescribeInstances`, as
[status](status.md#inventories) lists it), and a declared worker whose one
instance is `stopped` is a stopped worker. One `stopping` or `pending` is not:
the tailnet judges it as before, though a `stopping` one's instance type may
not change ([below](#instance-type-of-a-stopped-worker)). An inventory that
cannot be read names no worker stopped, and the tailnet judges every one, as it
did before stopped workers were planned: a stopped worker is then offline and
skipped, exit 2. The one exception is a change of a worker's instance type,
refused while the inventory cannot be read
([below](#instance-type-of-a-stopped-worker)).

`plan` reads the inventory once, after the lock check and before Terraform
plans. `apply` reads it once under the lock, before it plans or reads back a
saved plan: the plan, its refusals and every stage go by that one look, and
`worker stop|start|terminate` take the same lock, so fffactory changes no
worker's power while apply runs.

- The plan shows a stopped worker's install, and its control-plane, repository
  and dispatch changes, skipped. It is never inspected for its Paseo state:
  its control-plane observation is `stopped`, with no change.

  ```text
    Infrastructure   no changes
    Workers          one at a time
      ~ builder-1   install release 0.3.0 and host configuration, then verify
        builder-2   skipped: stopped; start it with `fffactory worker start builder-2`, then apply again to install it
    Control plane    before worker activation
      ~ builder-1   paseo-package, service-definition
        builder-2   skipped: stopped
    Repositories     one worker at a time
      ~ builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts
        builder-2   skipped: stopped
    Dispatch         after every readiness gate
      ~ builder-1   remove the factory dispatch schedule if it exists
        builder-2   skipped: stopped
    Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule
  ```

  The start command repeats the `--instance` and `--profile` the plan was
  given.
- A saved plan records them in `stopped_workers`, and is stale once a worker
  has been started or stopped since ([Freshness](#freshness)).
- A plan that changes the instance type of a worker stopped or stopping, or of
  any worker while the inventory cannot be read, is refused
  ([below](#instance-type-of-a-stopped-worker)).
- The workers stage reports a stopped worker `stopped`, on standard output: its
  Result row is ``◼ KEY   stopped · nothing was sent to it; to install it,
  start it with `fffactory worker start KEY`, then apply again``, the start
  command repeating the `--instance` and `--profile` apply was given. It is an
  intentional state, not a skip: it is no error, adds nothing to the Next
  block, the rollout goes on, and the stage still ends `installed`.
- The repository, control-plane and dispatch stages send it nothing either and
  report it `stopped`, so its row has no stage rows under it. End-to-end
  verification reports it `stopped` in every column, never `absent`, and the
  factory is ready once every other worker is: `✔ Verification   The factory is
  ready: every worker but the 1 stopped is verified end to end`.

Apply exits 0 when every other worker succeeded. Starting a stopped worker is
the operator's call: `fffactory worker start KEY`, then a plan installs
whatever it missed while stopped.

#### Instance type of a stopped worker

Verified against the pinned AWS provider, `hashicorp/aws` 6.66.0
(`internal/service/ec2/ec2_instance.go`): an in-place change of
`instance_type` runs `modifyInstanceAttributeWithStopStart`, which stops the
instance (nothing to do for a stopped one), modifies its type, then calls
`StartInstances` and waits for it to run, whatever state it was in. For a
`stopping` instance the stop waits for it to be `stopped`, then the same start
follows. Applying it would start a stopped or stopping worker behind the
operator's back. So a plan that updates such a worker's `aws_instance` with
another instance type, or with one Terraform does not show (failing closed), is
refused by `plan` and `apply` alike, and nothing is saved or applied
(`resizeRefusal`, `src/domain/plan.ts`). Apply judges a saved plan by the
inventory it reads under the lock, so a worker stopped since the plan was made,
or stopping now, is refused too:

```text
✖ Refusing to plan: the plan changes the instance type of a stopped worker, and Terraform starts a stopped instance to change its type:
  builder-1   module.hosts.aws_instance.host["builder-1"] would be updated in place

Nothing was applied.

── Next ─────────────────────────────────────────────
  Start it first:
    $ fffactory worker start builder-1
  Then plan again:
    $ fffactory plan
```

Several workers are each named, and started (`Start each first:`). A stopping
worker's line ends `, and it is stopping`, and the Next block says to start it
once it has stopped (`Start it first, once it has stopped:`; `worker start`
refuses a stopping machine, [worker lifecycle](worker-lifecycle.md)). An
upgrade's refusal plans again with `fffactory upgrade`.

With the inventory unreadable no worker is known not to be stopped, so `plan`
and `apply` (fresh or saved, whose staleness cannot see a worker stopped since)
refuse a change of any worker's instance type, failing closed; everything else
goes on as above:

```text
✖ Refusing to apply: the plan changes the instance type of a worker the EC2 inventory could not be read to check is not stopped, and Terraform starts a stopped instance to change its type:
  builder-1   module.hosts.aws_instance.host["builder-1"] would be updated in place

Nothing was applied.

── Next ─────────────────────────────────────────────
  Plan again once the EC2 inventory can be read:
    $ fffactory plan
```

Other in-place updates of a stopped worker's machine, such as its tags or root
volume size, do not start it and are planned as before; the hosts module
ignores `ami` and `user_data`. Apply checks a saved plan's Terraform plan file
again under the lock.

### Refusals until lifecycle work lands (D11)

A host is removed only by `fffactory worker terminate KEY`, whose scoped
removal plan is the only plan allowed to destroy one host machine
([worker lifecycle §Terminate (remove)](worker-lifecycle.md#terminate-remove));
only teardown's guarded destroy plan, which destroys the whole factory, may
destroy them all ([provisioning §Destroy plan](provisioning.md#destroy-plan)).
Until host replacement lands in milestone M3, `plan` and `apply` refuse,
naming the capability the change needs, and nothing is saved or applied:

| Change | Capability named |
| --- | --- |
| factory.json no longer declares a host key the state records (removed by hand, or renamed) | `host removal`, which only `fffactory worker terminate KEY` does |
| The Terraform plan does anything to an `aws_instance` but create it, update it in place or leave it: deletes, replaces (`delete` then `create`, or `create` then `delete`) or forgets it, or takes any action fffactory does not know | `host replacement` |

```text
✖ Refusing: this change needs host removal, which only `fffactory worker terminate KEY` does (D11):
  hosts: host key "builder-2" is provisioned but no longer declared: host keys cannot be renamed, and only `fffactory worker terminate builder-2` removes a host. Restore it, and declare any new host under a new key beside it

Nothing was applied.

── Next ─────────────────────────────────────────────
  Declare every provisioned host key in factory.json again, then remove a host with `fffactory worker terminate KEY`.
```

```text
✖ Refusing: this change needs host replacement, which fffactory does not have yet (D11; it arrives in milestone M3):
  module.hosts.aws_instance.host["builder-1"] would be replaced

Nothing was applied.

── Next ─────────────────────────────────────────────
  Change factory.json so the plan keeps every host machine, then plan again.
```

A host machine is a resource of type `aws_instance` whose mode is `managed`;
a plan that names no mode or type is judged by an address ending
`aws_instance.NAME[...]`, failing closed. Only the actions `no-op`, `read`,
`create` and `update` leave a host machine be; an in-place update, such as a
new instance type, is not refused. Any other action fails closed too, and is
named: `module.hosts.aws_instance.host["builder-1"] would be changed by an
action fffactory does not know (ACTION)`. Actions must be printable text, or
the plan cannot be read. The removal refusal lists each stable
host key issue ([provisioning §Stable host keys](provisioning.md#stable-host-keys)),
each naming the command for its key. The refusals of an upgrade that needs a newer base generation or
changes the schema version are [upgrade's](#compatibility-refusals-d11).

Every removal command in the headline, host key reasons and Next block repeats
the explicit `--instance` and `--profile` of the refused command, with POSIX
shell quoting for spaces and single quotes. Literal backticks in those values
remain part of the command in both plain and colored output. Replacement and
migration refusals keep their existing guidance without adding a removal command.

## Saved plans

A plan with changes is saved in the operator's local plan store,
`<cache>/plans/<factory ID>/<plan ID>/` (directories 0700, files 0600):

| Entry | Holds |
| --- | --- |
| `factory.tfplan` | The factory root's Terraform plan file, written by Terraform. |
| `backend.tfplan` | Backend bootstrap's plan, as a saved bootstrap plan or on a first apply. |
| `factory.tfplan.sha256` | A saved factory plan's `factory.tfplan` SHA-256 when it was saved. |
| `backend.tfplan.sha256` | A saved bootstrap plan's `backend.tfplan` SHA-256 when it was saved. |
| `plan.json` | The plan's record, written last: its presence saves the plan, and removing it spends a saved bootstrap plan. |

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
  "control_plane": [{ "key": "builder-1", "hostname": "fff-abcd1234-builder-1", "observation": "no-release", "changes": ["paseo-package", "service-definition", "listen-address", "password"] }],
  "stopped_workers": []
}
```

A record has a kind. A record without `kind` is a **factory plan**, as above,
bound to `factory.tfplan`; every record made before bootstrap plans existed is
one and reads unchanged. A record with `"kind": "bootstrap"` is a **bootstrap
plan**: backend bootstrap's plan, made while the state bucket does not exist,
bound to `backend.tfplan`. Any other `kind` is unreadable. `schema_version`
stays 1 for both.

```json
{
  "schema_version": 1,
  "kind": "bootstrap",
  "plan_id": "b00tstr4",
  "factory_id": "fff-abcd1234",
  "instance_path": "/work/.fffactory/factory.json",
  "configuration_sha256": "<SHA-256 of factory.json's exact text>",
  "release": "0.3.0",
  "assets_sha256": "<SHA-256 of the release assets>",
  "account_id": "123456789012",
  "created_at": "2026-09-30T12:00:00.000Z",
  "expires_at": "2026-09-30T13:00:00.000Z",
  "changes": [{ "address": "module.state_bucket.aws_s3_bucket.state", "type": "aws_s3_bucket", "actions": ["create"] }]
}
```

A bootstrap plan has no `state_revision`, `control_plane`, `dispatch` or
`stopped_workers`: there is no state, and no worker is reached, before the
bucket exists. A bootstrap record carrying any of them, or with no changes, or
with a change that does anything but create, is unreadable, and so is a factory
record without `state_revision` or `dispatch`.

`fffactory plan` saves a bootstrap plan while the state bucket is missing
([Plan](#plan) 1), and a factory plan once it exists. `apply --plan-id`
applies a bootstrap plan exactly
([Applying a saved bootstrap plan](#applying-a-saved-bootstrap-plan)).

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
| `stopped_workers` | A worker it skipped as stopped is not stopped now, or one it installs is ([Stopped workers](#stopped-workers)); or it skips one and the EC2 inventory cannot be read to check it. A record without the field skips none. |

A bootstrap plan is bound to the same `expires_at`, `instance_path`,
`configuration_sha256`, `release`, `assets_sha256` and `account_id`, and is
stale for the same reasons. The account is the only part of the AWS caller
either kind binds: the caller's principal ARN, whose role-session name changes
from run to run, is not. A bootstrap plan has no state revision. In its place
it is stale when the state bucket exists at apply, ready or not: `the state
bucket was created after it was planned`. Its plan file is `backend.tfplan`,
bound and checked by its SHA-256 as a factory plan's `factory.tfplan` is: a
missing or changed file makes the plan damaged.

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
is damaged and nothing is applied. Under the lock, the Terraform plan file that
will be applied is read back with `showPlan`: the changes shown for approval,
and checked against D11, are the file's, and a file whose changes differ from
its record's is damaged.

Refusal, each reason under it:

```text
✖ Refusing to apply plan k3x9q2ab: it is no longer the plan to apply:
  factory.json changed after it was planned

Nothing was applied.

── Next ─────────────────────────────────────────────
  Review a new plan:
    $ fffactory plan
```

The other reasons: `it expired at T`, `it was planned for another factory.json,
PATH`, `it was planned by fffactory R, not this release`, `it was planned with
other release assets than this fffactory's` (only when the release is the
same), `it was planned in AWS account A, not this one`, `the factory's
Terraform state changed after it was planned`, `the state bucket no longer
exists`, `the state bucket was created after it was planned` (a bootstrap
plan's), `worker KEY was stopped when it was planned, and is not now`, `worker
KEY is stopped now, and was not when it was planned`, `the EC2 inventory could
not be read to check that worker KEY is still stopped`, and `Paseo state on
HOSTNAME changed after it was planned`. An unknown or pruned plan ID is
refused `✖ There is no saved plan ID for this factory here: it expired, was
applied, or was saved elsewhere`, a damaged one `✖ Saved plan ID cannot be
applied: its record cannot be read, or its Terraform plan changed after it was
saved`, each with the same Next block. The `fffactory plan` it names repeats
the `--instance` and `--profile` apply was given.

An existing worker's Paseo state (`control_plane[].observation`) is compared
again under the lock, as the workers stage reaches the worker:

```text
✖ Refusing to apply plan k3x9q2ab: it is no longer the plan to apply:
  Paseo state on fff-abcd1234-builder-1 changed after it was planned

Nothing was applied.

── Next ─────────────────────────────────────────────
  Review a new plan:
    $ fffactory plan
```

TODO(re-evaluate when [#12](https://github.com/yaunder/fffactory/issues/12)
lands): update this refusal's wording and its test to #12's corrected outcome.
That comparison runs after the infrastructure stage has applied the plan's
Terraform changes, so `Nothing was applied.` is known to be misleading for a
plan with infrastructure changes. It is today's wording, kept unchanged by the
restyling, not the intended contract: #12 moves the check before anything is
applied, or reports what was.

Plans are short-lived. Each `plan` and `apply` first prunes the factory's plans
that expired over a day ago, and plan directories without a record that have
not changed for over a day (`PLAN_KEPT_MS`): never saved, as an interrupted
command leaves one, or spent, as an apply killed outright leaves one. Until then
an expired plan is refused as expired, a plan in use as it expires is never
removed under its apply, and an apply waiting at its approval question keeps
its plan. A saved factory plan is removed once apply held the lock for it,
whatever came of it: it is spent. A saved bootstrap plan is spent earlier,
right before its Terraform apply starts, before any lock exists: its
`plan.json` is removed and the removal flushed to disk, so it can never be
loaded again, while `backend.tfplan` stays for Terraform until the apply
settles and the directory is removed
([Applying a saved bootstrap plan](#applying-a-saved-bootstrap-plan)).

## Apply

```text
fffactory apply [--instance PATH] [--profile NAME] [--plan-id ID]
```

Without `--plan-id`, apply needs a terminal to ask for approval; without one it
is refused before reaching AWS: `Applying needs your approval of the plan:
rerun at a terminal, or save a plan with `fffactory plan` and apply exactly it
with --plan-id ID.` A malformed plan ID is refused before anything else. With
`--plan-id ID`, naming the ID approves exactly that saved plan, of either kind,
and no terminal is needed: a factory plan is applied as below, and a bootstrap
plan creates the state bucket and stops
([Applying a saved bootstrap plan](#applying-a-saved-bootstrap-plan)). Nothing
escalates the approval: a plan ID approves only the plan saved under it.

After the checks above, and a saved plan's local freshness:

1. [`beginFactoryOperation`](provisioning.md#backend-bootstrap) bootstraps the
   backend when it is missing, after its own approval, and takes the
   factory-wide lock, recording the time it is taken, after any bootstrap. An
   interrupt before then takes no lock. A saved factory plan never bootstraps: it was made against an
   existing bucket, so a missing one makes it stale (`the state bucket no
   longer exists`). A saved bootstrap plan is applied exactly instead, and the
   apply ends once it is recorded
   ([below](#applying-a-saved-bootstrap-plan)). A held lock refuses the
   apply, showing its holder.
2. Under the lock, the operation's record is written (next section), led by
   the `backend` stage when this apply created the bucket.
3. With a saved plan, the state revision is compared, and the saved Terraform
   plan file is read back: its changes, which must be its record's, are the
   plan, and the D11 refusals apply to them. Without one, the infrastructure stage is planned
   afresh, as `plan` plans it, and every refusal applies.
4. One approval tied to exactly that plan: the plan is printed as `plan`
   prints its `Plan` section (a first apply's bootstrap as its `Plan: backend
   bootstrap` section), then, after a blank line, at a terminal, `Apply this
   plan? Only "yes" applies it: `. Anything but `yes`
   (Ctrl-C included, which cancels the question) applies nothing: `✖ Not
   approved: nothing was applied` on standard error, exit 1. With `--plan-id`,
   naming the plan ID is the approval of exactly the plan `fffactory plan`
   showed under it, so nothing is asked: `Applying saved plan ID, approved by
   naming its ID.`
5. The `Applying` section begins, its rows streamed as each step starts
   ([below](#what-apply-prints)): `Infrastructure   applying with Terraform
   (its output is not shown; can take several minutes)` when the plan has
   infrastructure changes. Exactly the saved Terraform plan file is applied
   (`terraform apply PLANFILE`), never a new plan; a plan without
   infrastructure changes applies none, and has no such row.
6. The workers stage ([above](#the-workers-stage)). It and every later stage
   send a stopped worker nothing ([Stopped workers](#stopped-workers)).
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
   worker's release is left as is, never reported absent. A stopped worker is
   not incomplete.
11. The `Result` section, then the one closing Next block
   ([below](#what-apply-prints)), with the combined exit status of those
   stages. The lock is released.

Every refusal exits 1 and applies nothing. Apply's Terraform deadline is an
hour ([provisioning §Operations](provisioning.md#operations)).

### Applying a saved bootstrap plan

`fffactory apply --plan-id B`, where B is a saved
[bootstrap plan](#saved-plans), is the unattended way to create the state
bucket: it needs no terminal, and naming B approves exactly B. A fresh factory
is created with two exact plans, each approved by naming its ID:

```text
fffactory plan                 # no bucket: saves bootstrap plan B, its Next block names `fffactory apply --plan-id B`
fffactory apply --plan-id B    # applies exactly B, locks, records B, releases, stops
fffactory plan                 # bucket exists: saves factory plan F
fffactory apply --plan-id F    # applies exactly F
```

After the checks every apply runs ([above](#before-anything-reaches-aws): the
account check first, then the assets, the CLI/pin match guard and
completeness), `applySavedBootstrap` (`src/application/bootstrap-backend.ts`):

1. checks B's local [freshness](#freshness): factory.json's path and text, the
   release and its assets, the account, and its expiry. A stale plan is
   refused with the reasons, `✖ Refusing to apply plan B: it is no longer the
   plan to apply:`, as [Freshness](#freshness) shows, and nothing changes;
2. requires the state bucket to be still missing (HeadBucket, as
   [backend bootstrap](provisioning.md#backend-bootstrap) checks it). A bucket
   that exists, ready or not, makes B stale, `the state bucket was created
   after it was planned`, and nothing changes;
3. requires `backend.tfplan` to still have the SHA-256 it was saved with, and
   reads it back with `showPlan`: its changes must be its record's, and may
   only create, and must create something. A file that changed, or whose
   changes differ from the record's, is damaged (`✖ Saved plan B cannot be
   applied: ...`); one that would do more than create, creates nothing or
   cannot be read is refused as Terraform's plan fffactory cannot apply.
   Nothing is applied;
4. shows the plan as its `Plan: backend bootstrap` section, then `Applying
   saved plan B, approved by naming its ID.`, then the `Applying` section's
   `Infrastructure   applying with Terraform (its output is not shown; can
   take several minutes)` row;
5. checks again, immediately before the apply, that the bucket is still
   missing and `backend.tfplan` still the file read back; either refuses as in
   2 or 3;
6. spends B, then applies exactly that file (`terraform apply PLANFILE`),
   never a new plan. Spending removes B's `plan.json` and flushes the removal
   to disk before Terraform starts, so whatever comes of the apply, even a
   second interrupt that exits at once or a kill, B is never found again;
   `backend.tfplan` stays, the file checked in 5, for Terraform to read, and
   B's directory is removed once the apply settles (or pruned, after a kill).
   Only one apply spends B: another that spent it first leaves this one
   refused as no saved plan B, with nothing applied. Any refusal or interrupt
   before this step keeps B;
7. takes the factory-wide lock in the new bucket. A held lock is refused,
   showing its holder, as any apply is ([provisioning §Lock](provisioning.md#lock)),
   with the bucket already created;
8. writes the operation record ([below](#operation-records)): `plan_id` B, the
   one stage `{ "name": "backend", "status": "applied" }`, status
   `succeeded`; then releases the lock.

It then stops, exit 0. It never plans or applies the factory: that is a plan
of its own, with its own approval. Its `Result`, on standard output, is the
bucket it created and the operation record's location, and its Next block
plans the factory:

```text
fffactory apply · release 0.3.0
Instance  /work/.fffactory/factory.json (nearest .fffactory/factory.json)

── Plan: backend bootstrap ──────────────────────────
  Factory   Test factory (fff-abcd1234)
  Account   123456789012 · eu-west-2
  Release   0.3.0

  State bucket     fff-abcd1234-state, which does not exist yet
  Infrastructure   1 to add, 0 to change, 0 to destroy
    + module.state_bucket.aws_s3_bucket.state

Applying saved plan b7q2m9xk, approved by naming its ID.

── Applying ─────────────────────────────────────────
  Infrastructure   applying with Terraform (its output is not shown; can take several minutes)

── Result ───────────────────────────────────────────
  State bucket       created
  Operation record   s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json

── Next ─────────────────────────────────────────────
  Plan the factory next:
    $ fffactory plan
```

The `fffactory plan` it names repeats the `--instance` and `--profile` given,
quoted for a POSIX shell, as `plan`'s Next block does. A record that cannot be
written is reported as any apply's final record is, `✖ The operation record
could not be finished: REASON` in the Result, on standard error, and the exit
stays 0.

A Terraform apply that fails is reported as backend bootstrap's failure is,
`fffactory: REASON` and the diagnostics' path, with no record: no lock was
taken. A rerun of `fffactory plan` finds the bucket missing, and a new plan is
needed, or created but unready, and shows how to complete it. An interrupt
before the lock is taken, including one that stops the Terraform apply, takes
none and says so; one once it is taken leaves it, as any interrupted apply does
([Interruption](#interruption)). Either names `fffactory plan` next, never a
rerun of `fffactory apply`, which needs a terminal, while B may be spent. On
standard error:

```text
── Result ───────────────────────────────────────────
  ! Interrupted before the factory was locked: it is not locked
    Saved plan b7q2m9xk may be spent and the state bucket created.

── Next ─────────────────────────────────────────────
  Plan again from what exists now:
    $ fffactory plan
```

With the lock held, its Result says the factory stays locked, as any
interrupted apply's does, and its Next block breaks the lock, then plans the
factory:

```text
── Next ─────────────────────────────────────────────
  Once fffactory has exited, break the lock:
    $ fffactory lock break
  Then plan the factory next:
    $ fffactory plan
```

Each command repeats the `--instance` and `--profile` given, as the Next block
after a created bucket does.

Bootstrap stays the one step before the lock, which lives in the bucket
([provisioning §Backend bootstrap](provisioning.md#backend-bootstrap)). The
lock is taken right after the bucket is created, and the bucket-missing check
comes right before the apply, so another first apply racing B has only that
window. The AWS account is the only part of the caller B binds: the account
check runs again before anything else, and the backend root's
`allowed_account_ids` is Terraform's own backstop.

### What apply prints

After the plan and its approval, apply prints three parts, laid out as
[CLI output](cli-output.md) describes. The 2026-10-05 test-factory apply, which
installed a new release on its one worker and left its three accounts to
enroll, through every stage:

```text
fffactory apply · release 0.0.0
Instance  ~/test-factory/.fffactory/factory.json (nearest .fffactory/factory.json)

── Plan ─────────────────────────────────────────────
  Factory   Test factory (fff-aaaa1111)
  Account   123456789012 · us-east-1
  Release   0.0.0

  Infrastructure   no changes
  Workers          one at a time
    ~ test-builder-1   install release 0.0.0 and host configuration, then verify
  Control plane    before worker activation
    ~ test-builder-1   paseo-package, service-definition, listen-address, password
  Repositories     one worker at a time
    ~ test-builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts
  Dispatch         after every readiness gate
    ~ test-builder-1   remove the factory dispatch schedule if it exists
  Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule

Apply this plan? Only "yes" applies it: yes

── Applying ─────────────────────────────────────────
  test-builder-1   uploading 35.3 MiB
  test-builder-1   installing and verifying (can take many minutes)

── Result ───────────────────────────────────────────
    Infrastructure     no changes
  ! test-builder-1     installed and verified · enrollment pending (3)
    ✔ Control plane   applied
    ✔ Repositories    synchronized
      Dispatch        not requested
  ! Verification       The factory is ready: every worker is verified end to end · enrollment pending on 1 worker
    Operation record   s3://fff-aaaa1111-state/fff-aaaa1111-operations/2026-10-05T16:05:52.256Z-mlrqnb5n.json

── Next: enroll 3 accounts on test-builder-1 ────────
  Log in as factory (tailnet SSH policy must allow it):
    $ tailscale ssh factory@fff-aaaa1111-test-builder-1

  1. GitHub
     $ gh auth login --hostname github.com --git-protocol https --web
     $ gh auth status --hostname github.com --active
  2. OpenAI Codex
     $ codex login --device-auth
     $ codex login status
  3. Claude Code
     $ claude auth login
     $ claude auth status

  Return to your workstation:
    $ exit
  Refresh enrollment verification, reviewing the new plan:
    $ fffactory apply
  Then confirm:
    $ fffactory status
  Paseo clients: enrollment is checked from each client, not the worker
```

In color the section rules are dim, `!`, `enrollment pending (3)` and
`· enrollment pending on 1 worker` yellow, `✔` green, `✖` red, `$ ` dim and the
commands bold cyan, and the Next heading bold.

- **Applying**, streamed as it happens: a row when Terraform applies the plan,
  an upgrade's `Pin` row ([Upgrade](#the-pin-move-and-the-plan)), and a row per
  worker progress event, the worker by its key alone (its hostname is the
  factory ID and the key), labels as wide as the approved review's widest, so
  the rows align though printed one at a time. A step with nothing to show,
  such as Terraform's for a plan without infrastructure changes, shows no row;
  a run that shows none has no `Applying` section.
- **Result**: the infrastructure's outcome (`applied: matches factory.json`,
  or `no changes`, after `State bucket   created` when the run bootstrapped
  it), each worker's row with its later stages under it
  ([The workers stage](#the-workers-stage)), the end-to-end verification's
  verdict as verification words it (`✔` ready, else `!`), the operation
  record's location, and, on
  standard error, a final record that could not be written
  ([Operation records](#operation-records)). Verification checks the
  software, and counts an account still to enroll only when dispatch needs it
  (GitHub's): while any installed worker has an account to enroll, the
  `Verification` row is `!`, never `✔`, its verdict followed by
  `· enrollment pending on N worker(s)`, so a factory whose enrollment is
  pending is never shown ready, as `status` does not show it ready; the exit
  status is unchanged. No line per worker that is not ready follows it:
  each worker's row and the Next block say what it needs. When nothing is
  left to do, it ends with the muted Paseo clients note.
- **Next**: one block collecting what every stage left for the operator, in
  the stages' order (workers, repositories, control plane, dispatch), each
  next action once, after the workers it concerns, however many stages and
  workers name it: a deferred maintenance the workers, control-plane and
  dispatch stages all report is one step. A dispatch gate another stage's
  action already covers is left out: the GitHub credential gate of a worker
  whose GitHub account is to enroll, the repository gate of one whose
  repositories are unresolved or skipped, the Paseo gate of one whose control
  plane failed or was deferred, the release gate of one not installed. Then
  each delivered credential a worker did not accept, once for every worker it
  concerns, with the `fffactory secret set` that replaces it. Then
  each worker's enrollment still to log in to: the login once, with the requirement it carries
  (`WorkerEnrollment.requirement`; [readiness §Where it is
  reported](readiness.md#where-it-is-reported)), its accounts numbered with
  their command lines, then `exit` back to the workstation. After the last
  worker (or the credentials, when no login is left), `fffactory apply`
  delivers and verifies the enrollment again, since `status`
  only reads the verification apply recorded, and `fffactory status`
  confirms. The Paseo clients note ends the block when a worker was
  installed. Its title names the enrollment when that is all it asks
  (`Next: enroll 3 accounts on KEY`, `Next: enroll accounts on 2 workers`),
  and each worker's login names the worker unless the title does. A run that
  leaves nothing to do, a stopped worker included, has no Next block.

Every `fffactory` command the Result or Next block names repeats the
`--instance` and `--profile` apply was given, quoted for a POSIX shell; the
next actions the stages word themselves (status's and the stages' published
`next_action` wording) are shown as they are, so the `fffactory apply` they
name repeats neither, marked
`TODO(re-evaluate when stage next actions carry their fffactory command as data)`
in `src/cli/presentation/apply.ts`.

Each line goes to the stream it always has, whatever the exit status: the
Applying and Result rows to standard output, but for failed and not-attempted
workers' rows and a record that could not be finished, which go to standard
error. The Next block's steps do the same: a failed worker's next action to
standard error, with its row, even when it is one step with the same action
another worker or stage names, so a failed worker's recovery always reaches
standard error; every other step (a skipped worker's and the later stages'
next actions, the enrollment, `exit`, `fffactory apply`, `fffactory status`
and the Paseo clients note) to standard output. A section's rule, the Next
block's included, goes to the stream of its first row or step, the blank line
before a paragraph to its first step's stream, and rows split
between the streams keep one label width and status column, so they align on a
terminal showing both. The Next block is always last, after the record and any
upgrade pin notice, which goes to standard error. A failed or interrupted
run's Next block ([Failure](#failure), [Interruption](#interruption)) is on
standard error.

### Failure

A failure planning or applying releases the lock and records the failure. Its
`Result` is a failure status line and what the failure may have left, on
standard error, then the private diagnostics file's path, if any, also on
standard error, and the operation record's location, on standard output, then
a Next block, on standard error, when a rerun converges what remains.
Applying may have changed some infrastructure before Terraform stopped:

```text
── Result ───────────────────────────────────────────
  ✖ Applying failed: `terraform apply` exited with status 1
    Terraform may have changed some of the infrastructure before it stopped.

  Terraform's diagnostics   /home/operator/.cache/fffactory/terraform/diagnostics/20260930T120000Z-apply-Ab12Cd.log
  Operation record          s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json

── Next ─────────────────────────────────────────────
  Rerun: it plans again from what exists now and converges what remains:
    $ fffactory apply
```

A planning failure says `✖ Planning failed: REASON`, then `Nothing was
applied.`, and has no Next block.

A Terraform apply that misses its deadline is stopped (SIGINT, then SIGKILL
after the grace period) and reported the same way, as ``did not finish within
3600 s``, even when Terraform happened to finish during the grace period: the
report is conservative, and a rerun plans from what exists. A Terraform killed
by SIGKILL may leave its own S3 state lock held, which fails later plans until
it is released; this is marked
`TODO(re-evaluate when an apply ends with Terraform's state lock left behind)`
in `src/application/apply-factory.ts`.

The reason is fffactory's own message, never Terraform's or AWS's output. It
is shown verbatim, never read for inline code: an unexpected error's message,
an adapter's included, can carry data such as a path.
Terraform's standard error is kept in a private local file
([provisioning §Diagnostics](provisioning.md#diagnostics)), and only its path is
printed, after the failure and before the record's location, as above.

An unexpected error in a later stage is reported the same way and recorded as
that stage `failed`, each with what it may have left and the same Next block:

| Stage | Status line | What it may have left |
| --- | --- | --- |
| Workers, such as the transport failing | `✖ Installing the workers failed: REASON` | `The worker being installed may be on the new release, unhealthy.` |
| Repositories | `✖ Repository synchronization failed: REASON` | `Completed repository changes were left in place.` |
| Control plane | `✖ Control-plane reconciliation failed: REASON` | |
| Dispatch | `✖ Dispatch reconciliation failed: REASON` | |
| Verification | `✖ End-to-end verification failed: REASON` | |

A Terraform command that fails outside the lock, such as `fffactory plan`'s,
prints `fffactory: REASON` and `Terraform's diagnostics: PATH`, until that
command is restyled. Neither the diagnostics nor the file's path reach the
operation record or the state bucket.

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

`plan_id` is null when apply planned for itself. An apply that created the
state bucket (backend bootstrap) writes its first record, once the lock is
taken, with the stages starting `{ "name": "backend", "status": "applied" }`,
before the infrastructure stage. A saved bootstrap plan's apply writes one
record, with its `plan_id`, that one stage alone and status `succeeded`
([above](#applying-a-saved-bootstrap-plan)). The `backend` stage is only ever `applied`,
and present only when this apply created the bucket: an apply that found the
bucket already there has none. A bootstrap that fails or is declined leaves no
record, since without a bucket there is nowhere to write one and no lock is
taken. `schema_version` stays 1: the stage is an addition. The infrastructure stage goes
`planning`, `awaiting_approval`, `applying`, and ends `applied`, `unchanged`,
`declined`, `refused` or `failed`. The workers stage (`workers`) goes
`installing` and ends `installed`, `partial` or `failed`; `workers` lists each
worker as it ends, `{"key", "hostname", "status", "summary"}`, with status
`installed`, `skipped`, `failed`, `not_attempted` or `stopped` and the summary
of a skip, failure or stop. The operation's `status` is `running` until it ends
`succeeded`, `partial` (a worker was skipped; a stopped one is not),
`declined`, `refused` or `failed`, with `failure` naming why (for a worker,
`worker KEY: SUMMARY`). Records are history: nothing reads them to decide
anything. A final record that cannot be written after a successful apply does
not fail it: `✖ The operation record could not be finished: REASON`, on
standard error, last in the Result (only the muted Paseo clients note follows
it, when there is no Next block) and before the Next block, which stays on
standard output; exit 0. After a failure, the same line follows the failure's
record location, the failure's report kept whole, and the exit stays 1.

The repository stage (`repositories`) goes `synchronizing`, then
`synchronized`, `partial` or `failed`. Its `repositories` array records each
worker's key, hostname, result (`synchronized`, `unresolved`, `skipped` or
`stopped`), unmanaged paths and summary. An unresolved or skipped repository
result makes the operation `partial` and apply exit 2. The control-plane stage
goes `reconciling`, then `reconciled`, `deferred` or `failed`. Its
`control_plane` array records each worker's key, hostname, safe outcome
(`applied`, `deferred`, `failed` or `stopped`) and summary; it never records
Paseo or secret output. The dispatch stage goes `reconciling`, then `active`,
`pending` or `failed`; a skipped worker leaves it `pending`, like a pending
one, and the operation `partial` unless another stage failed. Its `dispatch`
array records each worker's safe outcome (`not_requested`, `active`, `pending`,
`failed`, `skipped` or `stopped`), blocker gates and summary, never credentials
or tool output. The verification stage goes `reconciling`, then `verified`,
`pending` or `failed`, and records each composite worker verdict; a skipped
worker's `release` is `skipped`, and a stopped worker's every verdict
`stopped`.

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
`upgrade`, `doctor`, `status` and `worker`
([worker lifecycle §Interruption](worker-lifecycle.md#interruption)). Any other, such as `host apply`, `secret
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
left as its `Result`, on standard error but for the record's location, then how
to recover as its Next block, on standard error, and `fffactory` still exits
with 128 plus the signal's number. Interrupted while a worker's `host apply`
ran, which stopping `ssh` leaves running on the worker, with no terminal to hang
up:

```text
── Result ───────────────────────────────────────────
  ! Interrupted: the factory stays locked, with a record of this operation
    Interrupted while installing on builder-1: host apply may still be running there, and a rerun skips that worker until it has finished.

  Operation record   s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json

── Next ─────────────────────────────────────────────
  Once fffactory has exited, break the lock:
    $ fffactory lock break
  Then rerun:
    $ fffactory apply
```

| Left | Status line | Next block |
| --- | --- | --- |
| No lock: interrupted before it was taken | `! Interrupted before the factory was locked: it is not locked` | `Rerun: it plans again from what exists now:`, then `fffactory apply` |
| The lock, and no record written yet | `! Interrupted: the factory stays locked by this apply, which may have no operation record` | As above: break the lock once fffactory has exited, then rerun |
| The lock and its record | `! Interrupted: the factory stays locked, with a record of this operation`, then `Operation record   s3://BUCKET/KEY` on standard output | As above |

An interrupt during the workers stage names the worker it concerned under the
status line: ``Interrupted while installing on KEY: host apply may still be
running there, and a rerun skips that worker until it has finished.`` while
`host apply` ran, or ``Interrupted while waiting for KEY to finish its first
boot: no install step ran on it.`` while apply waited for a new worker. The
commands repeat the `--instance` and `--profile` apply was given; an upgrade
whose pin was not moved reruns `fffactory upgrade`, after its pin notice.
A saved bootstrap plan's apply names `fffactory plan` in place of each rerun
of `fffactory apply`, and an interrupt before the lock says the plan may be
spent ([above](#applying-a-saved-bootstrap-plan)).

TODO(re-evaluate when [#38](https://github.com/yaunder/fffactory/issues/38)
lands): an interrupt during the final operation-record write is reported as
the run's ordinary Result, which says nothing of the lock it leaves. That is
today's behavior, not the intended contract: #38 reports the interruption and
the retained lock, with the recovery above.

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
the upgrade installs the running release on every declared worker that is not
stopped. A stopped worker is sent nothing, as apply sends it nothing
([Stopped workers](#stopped-workers)): it gets the release once it is started
with `fffactory worker start KEY` and `fffactory apply` runs.

It needs a terminal: without one it is refused before anything else,
`Upgrading needs your approval of the pin move and the plan: rerun at a
terminal.` There is no saved upgrade plan.

### Before anything reaches AWS

1. factory.json is selected (the header, `fffactory upgrade · release R`, then
   `Instance  PATH (SOURCE)`) and read, and its
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
anything is shown, asked, created or locked, on standard error, exit 1:

```text
✖ Refusing to upgrade: the factory has no state bucket yet, and an upgrade never creates it

Nothing was created or applied.

factory.json's pin was not moved: it still pins the release it pinned.

── Next ─────────────────────────────────────────────
  Create it with the release factory.json pins, which applies the factory:
    $ fffactory apply
  Then upgrade again:
    $ fffactory upgrade
```

1. Under the lock, the infrastructure stage is planned afresh from
   factory.json as it will be once the pin moves: the document read, with only
   `release` changed to the running release. Every refusal of plan and apply
   applies, and the workers stage installs the running release.
2. The pin move is shown with the plan, beside the release it moves to, and
   approved together:

   ```text
   fffactory upgrade · release 0.3.0
   Instance  /work/repo/.fffactory/factory.json (nearest .fffactory/factory.json)

   ── Plan ─────────────────────────────────────────────
     Factory   Test factory (fff-abcd1234)
     Account   123456789012 · eu-west-2
     Release   0.3.0
     Pin       factory.json's release pin moves from 0.2.0 to 0.3.0, written once you approve this plan, before anything is applied

     Infrastructure   no changes
     Workers          one at a time
       ~ builder-1   install release 0.3.0 and host configuration, then verify
     Control plane    before worker activation
       ~ builder-1   paseo-package, service-definition, listen-address
     Repositories     one worker at a time
       ~ builder-1   reconcile 0 placed repositories as factory; preserve and report unmanaged checkouts
     Dispatch         after every readiness gate
       ~ builder-1   remove the factory dispatch schedule if it exists
     Verification     end to end: observe each worker's release, repositories, Paseo and actual dispatch schedule

   Move the pin and apply this plan? Only "yes" does: yes
   ```

   The plan shows every stage it approves.
   TODO(re-evaluate when [#11](https://github.com/yaunder/fffactory/issues/11)
   lands): `upgrade` does not yet apply the control-plane, dispatch and
   verification stages its plan shows, so its Result has no control-plane,
   dispatch or verification rows; the plan is right, the run is #11's, and
   its Result then shows those rows as apply's does.
   The earlier pin is shown only when it is a plain `MAJOR.MINOR.PATCH`,
   which cannot hold anything else; otherwise `from the release it pins now`.
3. Once approved, and only then, the new pin is written, the `Applying`
   section's first row, before Terraform's: the document, serialized as `init`
   and `secret set` write it, with only `release` changed. It is written only
   while factory.json is still the exact text the plan was made from; otherwise
   nothing is written or applied: `✖ Refusing to upgrade: factory.json changed
   after the plan was made`, `Nothing was applied.`, the pin notice (below),
   and a Next block reviewing a new plan with `fffactory upgrade`, exit 1.
4. Then the plan is applied exactly as apply applies it: the saved Terraform
   plan file, then the workers stage, and reported as apply reports it
   ([What apply prints](#what-apply-prints)):

   ```text
   ── Applying ─────────────────────────────────────────
     Pin         factory.json now pins release 0.3.0
     builder-1   uploading 48.2 MiB
     builder-1   installing and verifying (can take many minutes)
   ```

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
`factory.json's pin was not moved: it still pins the release it pinned.`, after
the outcome and the record and before any Next block; their Next blocks, where
they have one, name `fffactory upgrade`. A failure moving the pin is `✖ Moving
factory.json's pin failed: REASON`, then `Nothing was applied.`. A failure once
the pin was written and before anything is applied (its record could not be
written) says where the pin is, then how to finish:

```text
── Result ───────────────────────────────────────────
  ✖ Upgrading failed once factory.json's pin moved: S3 answered SlowDown
    Nothing was applied.

  Operation record   s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json

factory.json pins release 0.3.0.

── Next ─────────────────────────────────────────────
  Finish with this release:
    $ fffactory apply
```

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

The exit status is apply's: 0 once every worker is installed and verified, or
stopped, 2 when a worker was skipped, 1 when anything failed or was refused.

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
| The pin is earlier than `base_generation_since` | `base migration` | `release 0.3.1 needs base generation 2, which arrived in release 0.3.0: workers set up by the release factory.json pins have an older base` |

```text
✖ Refusing: this change needs base migration, which fffactory does not have yet (D11; it arrives in milestone M3):
  release 0.3.1 needs base generation 2, which arrived in release 0.3.0: workers set up by the release factory.json pins have an older base

Nothing was applied.

── Next ─────────────────────────────────────────────
  factory.json still pins its release; keep using that release until base migration arrives.
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

The plan an operator approves reaches the CLI as data: a `PlanReview`
(`src/domain/plan.ts`), either a factory plan (its target, infrastructure
changes, every declared worker with its placed repositories, control-plane
changes, dispatch settings, the workers skipped as stopped and, for an upgrade,
the pin move) or backend bootstrap's (its target, bucket and creations). The
`Approval` port takes that review, and `planFactory`, `applyFactory`,
`bootstrapBackend` and `upgradeFactory` return or pass reviews and typed
refusals: each saved plan's staleness is a `StaleReason`, an unreadable or
non-create plan an `UnexpectedPlan`, an unready state bucket an `UnreadyBucket`.
Only `src/cli/presentation/` lays any of them out, in the
[layout blocks](cli-output.md#layout-blocks), so what each command prints is
unchanged by where the plan was made.

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/plan.ts` | Plan IDs, the CLI/pin match guard, reading a JSON plan's resource changes and comparing them with a record's (`sameChanges`), `ChangeKind` and `changeTally`, `PlanReview` (`factoryPlanReview`), `UnexpectedPlan`, the D11 refusals, the refusal to resize a stopped or stopping worker, or any while the EC2 inventory cannot be read (`resizeRefusal`), the saved plan record and its two kinds (`SavedFactoryPlan`, `SavedBootstrapPlan`), its freshness rule as `StaleReason`s (`planStaleness`, `stateStaleness`, `stoppedStaleness`, and `bootstrapStaleness`), `FACTORY_STATE_KEY`, `PLAN_TTL_MS`. Pure; no text layout. |
| Domain | `src/domain/release-compatibility.ts` | `RELEASE_COMPATIBILITY`, release precedence, upgrade's assessment of the pin, the schema version check, the base generation and schema D11 refusals, the `PinMove` an upgrade shows (`pinMove`: a pin that is not a plain release is never carried). Pure. |
| Domain | `src/domain/operation.ts` | The operation record, its key, stage transitions (upgrade's `pin` stage too), workers, repositories and control-plane outcomes. Pure. |
| Domain | `src/domain/repository-placement.ts` | The per-worker repository manifest, fixed worker protocol commands, and completed-result parser. Pure. |
| Domain | `src/domain/stable-host-keys.ts` | `recordedHostKeys`, reading the factory root's `host_keys` output. |
| Application | `src/application/plan-factory.ts` | `checkPlannable`, `planInfrastructure`, `planFactory` (a missing bucket's bootstrap plan saved too), `declaredMachines` (the one inventory read: the stopped workers and the resize guard). |
| Application | `src/application/apply-factory.ts` | `applyFactory`: saved-plan freshness (the state bucket gone, and a worker's Paseo state changed, as `StaleReason`s too), the review approved, the lock, infrastructure, workers, repository and control-plane stages, operation records, interruption; `PinUpdate`, upgrade's pin write beside the `PinMove` it shows; a saved bootstrap plan routed to `applySavedBootstrap`, then its record. |
| Application | `src/application/bootstrap-backend.ts` | `applySavedBootstrap`: a saved bootstrap plan's bucket and file checks, its read-back (its review, a `PlanReview`), its exact apply, then the lock. |
| Application | `src/application/plan-control-plane.ts` | Derives Paseo changes and saved live observations from worker inspections. |
| Application | `src/application/apply-workers.ts` | `applyWorkers`: the workers stage ([host protocol §apply](host-protocol.md#apply)). |
| Application | `src/application/apply-repositories.ts` | `applyRepositories`: projects each approved worker manifest through the fixed repository host protocol and records synchronized, unresolved, and unmanaged results. |
| Application | `src/application/upgrade.ts` | `upgradeFactory`: the refusals, then apply's operation with the pin move shown in the review and written under the lock once approved. |
| Application | `src/application/set-secret.ts` | The CLI/pin match guard on `secret set`. |
| Domain | `src/domain/rollout.ts` | A worker's outcome (`stoppedOutcome` too), the rollout rule, and the first boot wait's rules: its deadline, poll and report intervals, which tailnet states are still joining, a bootstrap refusal to wait for, and the timed-out failure. Pure. |
| Application | `src/application/plan-store.ts` | The `PlanStore` port, which binds a record to the Terraform plan file its kind names, with `digest` for the check under the lock, `spend` (its record durably removed, its Terraform plan kept), and `planStoreDirectory`. |
| Application | `src/application/factory-lock.ts` | `Interrupted` and `settleFactoryLock`: an interrupted operation keeps its lock. |
| Application | `src/application/lock-store.ts` | `writeOperation` and `stateRevision` on the state bucket port. |
| Infrastructure | `src/infrastructure/plan-store.ts` | `filesystemPlanStore`: private plan directories, the bound plan file's digest (`factory.tfplan` or `backend.tfplan`), spending a plan (unlinking `plan.json`, then fsyncing its directory), pruning either kind and spent leftovers. |
| Infrastructure | `src/infrastructure/aws-s3-lock-store.ts` | PutObject of operation records; HeadObject of the state object. |
| CLI adapter | `src/cli/presentation/plan.ts` | Every plan review and refusal in blocks: `planSection` (the target rows and an upgrade's pin move, the infrastructure tally and changes with Terraform's symbols, then each stage's row with each worker's change), `bootstrapSection`, `reviewBlocks`, `savedPlanReport` and `savedBootstrapPlanReport` (`plan`'s saved plan and Next block), `planRefusalReport` (each `PlanRefusal`), `d11Report`, `staleReport`, `unknownPlanReport` and `damagedPlanReport`, with `describeStaleReason` and `describeUnexpectedPlan`, and the unready bucket's AWS CLI commands; `describeRemovalPlan`, still unstyled. |
| CLI adapter | `src/cli/presentation/command-line.ts` | `fffactoryCommand`: a command a Next block names, with the `--instance` and `--profile` given, quoted for a POSIX shell (`shellWord`). |
| CLI adapter | `src/cli/presentation/instance-source.ts` | `instanceHeader`: the command, its release, and the instance (`displayPath`, `describeSource`'s words). |
| CLI adapter | `src/cli/presentation/apply.ts` | Apply's and upgrade's run: the `Applying` rows (`applyingSection`, `applyingRow`, `applyingLabelWidth`, `infrastructureApplyingRow`, `pinnedRow`, `progressRow`), the `Result` and the one Next block laid out from the complete `FactoryApply`, each line on its stream (`appliedLines`, `bootstrappedLines`, `failedLines`, `interruptedLines`), the runs that applied nothing (`refusedRunReport`), and an upgrade's pin notice (`pinNotice`). |
| CLI adapter | `src/cli/presentation/workers.ts` | A worker's Result row across every stage that ran for it (`workerRow`, its status the worst stage's), and its enrollment's Next steps rendered from its `WorkerEnrollment` (`workerEnrollmentOf`, `enrollmentSteps`; [readiness §Where it is reported](readiness.md#where-it-is-reported)). |
| CLI adapter | `src/cli/presentation/lock.ts` | A held lock and the lock refusal (`describeHeldLock`, `lockRefusalReport`; [provisioning §Lock](provisioning.md#lock)). |
| CLI adapter | `src/cli/commands/plan.ts`, `src/cli/commands/apply.ts`, `src/cli/commands/upgrade.ts`, `src/cli/commands/planning.ts` | The commands, the approval at the terminal (`operatorApproval` shows the review), the `Applying` section as it streams (`applyingProgress`), the exit code of every outcome, writing each line on its stream (`reportApply`), and what they share: the header (`planningBasis`), `printReport` and `printPlanRefusal`, and an upgrade's pin state (`ApplyReporting.pin`). |
| CLI adapter | `src/cli/diagnostics.ts`, `src/cli/run.ts` | The path of a failed Terraform command's diagnostics outside apply's Result, printed with the failure. |
| CLI adapter | `src/cli/interrupts.ts` | `interruptible`: the interrupt notice and flag, the sleep an interrupt wakes, stopping running tools, then, for a command that waits on an interrupt, waiting `RETURN_GRACE_MS` at most for it to return, before exiting with 128 plus the signal's number; a second signal kills and exits at once. |
| CLI adapter | `src/cli/run.ts`, `src/cli/context.ts` | `waitsOnInterrupt`: only `apply`, `upgrade`, `doctor`, `status` and `worker` (`Command.waitsOnInterrupt`) are waited for. |
| CLI adapter | `src/cli/main.ts` | Wires `terraformProvisioner`, `filesystemPlanStore`, and `interruptible` over the process, waiting on an interrupt as `waitsOnInterrupt` says for the command run. |

Tests: `tests/domain/plan.test.ts` (plan IDs, the pin guard, change kinds and
their tally, a plan's changes compared with its record's, a factory review
carrying every stage, both D11 refusals, unknown host machine actions refused,
the record round trip and unreadable records, the bootstrap record's round trip
beside factory records without `kind`, every staleness reason of either kind as
a `StaleReason`, the workers whose machine a plan creates, the resize of a
stopped or stopping worker, or of any with the inventory unreadable, refused
and an unreadable change failing closed, `stopped_workers` round-tripping and
every stopped staleness reason),
`tests/domain/release-compatibility.test.ts` (the pin move never carrying a pin
that is not a plain release), `tests/cli/presentation/plan.test.ts` (each review
and refusal as plain text, and the plan section's and a refusal's color: the
target, changes and tally, every stage with stopped workers shown skipped, an
empty factory, the pin move, backend bootstrap's plan, `plan`'s Next block and
its quoted instance and profile, the saved bootstrap plan's Next block applying
it and planning the factory, the instance and profile a plan row's command
repeats, data such as the factory name and dispatch values shown verbatim, an
unready bucket's guidance, both D11 refusals, the resize refusals, every
`StaleReason`'s words and the stale (a bootstrap plan's bucket reason too),
unknown and damaged plan refusals, the
removal plan), `tests/cli/presentation/instance-source.test.ts` (the header, a
path under home shown from `~`, a path shown verbatim),
`tests/cli/presentation/command-line.test.ts` (POSIX quoting of spaces and
single quotes), `tests/cli/presentation/lock.test.ts` (the lock refusal, its
holder shown verbatim, and its Next block), `tests/domain/rollout.test.ts` (a
stopped worker neither stopping the rollout nor making it partial, the first boot's deadline, the
tailnet states still joining, the bootstrap refusal waited for, the timed-out
failure and the rollout going on after it), `tests/domain/operation.test.ts`
(the backend stage leading a bootstrapping apply's stages, and alone in a saved
bootstrap plan's record),
`tests/domain/stable-host-keys.test.ts` (recorded host keys),
`tests/application/plan-factory.test.ts` (a first plan, the state revision
bound before planning, no infrastructure changes still saved with the workers,
the pin guard, incomplete factory.json, another account, a missing bucket's
bootstrap plan saved into its own `backend.tfplan` and bound to the current
circumstances with no lock taken, one that does more than create or whose
Terraform plan fails saving nothing and leaving no plan directory, an unready bucket, a held lock, host key removal refused before
Terraform plans, a host replacement refused and never saved, unreadable outputs
and plans, a failing Terraform plan, no Terraform state lock, pruning, a
stopped worker's install skipped and saved and never inspected, a stopped or
stopping worker's resize refused and a running one's planned, an unreadable EC2
inventory planning every install and refusing any resize),
`tests/application/apply-factory.test.ts` (against
`tests/support/fake-provisioner.ts`'s `fakeFactoryWorld`, a factory whose
Terraform state changes as plans apply: plan, approve and apply under one lock;
a first apply's two approvals; declining either; both D11 refusals before
apply; the pin guard; a held lock; failing plan and apply; a record that cannot
be finished, after applying or after a failure; a saved plan applied exactly,
refused after factory.json changes, from another release or with other assets,
expired, after the state changed, unknown, damaged, whose record no longer
matches its Terraform plan, unreadable, replacing a host, without its bucket,
for another factory.json or account, after a worker's Paseo state changed,
or whose Terraform plan file was swapped after it was loaded or after it was
read back; a saved bootstrap plan applied exactly, then the lock, its record
and the release in that order and nothing of the factory planned, spent so a
rerun names it missing, refused with nothing applied, locked or recorded when
stale (factory.json, release, assets, path, expiry), when the bucket exists,
ready or not, tampered, read back other than its record or doing more than
create, its failed Terraform apply spending it with no lock or record, an
interrupt before the lock taking none, one after it keeping it, and one once
its record is written keeping the lock and the record, an unwritable record
reported, and a lock held meanwhile refused; a lock taken
after bootstrap and never after an interrupt, and `applySavedBootstrap`'s every
refusal, the bucket rechecked and the file checked again right before the
apply, a declined approval, another account, the plan spent before its
Terraform apply starts and never loadable while it runs, every refusal and an
interrupt before the apply keeping it, one another apply spent first not
found and never applied, a failed or interrupted apply spending the plan
(`tests/application/bootstrap-backend.test.ts`); the workers stage after the
infrastructure under the same lock and record, without infrastructure changes
still approved and installed with no Terraform apply, a failed install stopping
the rollout and failing the operation and a rerun repairing it, a skip making
it partial, an interrupt while installing keeping the lock and record and
naming the worker it was installing, a tailscale.tag missing by then an error
rather than a default, and an unexpected error failing the workers stage; a
stopped worker sent nothing and the operation succeeded with the inventory read
once, an unreadable inventory skipping it by the tailnet as before, a stopped
worker's resize refused under the lock, and any with the inventory unreadable,
a saved plan skipping the workers it planned stopped and stale once one was
started or stopped, the resize refusal checked again on the saved Terraform
plan, and a saved resize planned while every worker ran refused once its worker
is stopping or the inventory cannot be read;
`tests/application/apply-factory-pipeline.test.ts` (a stopped worker sent
nothing by any stage, every stage and the record reporting it `stopped`, the
factory verified ready without it); `tests/application/apply-workers.test.ts`
(a stopped worker sent nothing, the rollout going on, stopped even without a
worker executable; a timeout or dropped connection saying the worker may still
be installing, a busy worker skipped, an answer for another worker failed; a
new worker waited for until it joins the tailnet and until its bootstrap
finishes, uploaded once, failing after 15 minutes with the rollout going on,
reporting every minute, bounded under a stalled clock, refused at once for a
duplicate or untagged device appearing, an interrupt while waiting, and a
worker this apply did not create skipped without waiting); in
`apply-factory.test.ts`, a worker the apply creates waited for and installed in
the same run, a provisioned worker missing skipped without waiting, a first
boot timing out failing the operation, and an interrupt while waiting keeping
the lock and record; an apply interrupted part way through leaving its lock and
record, refused until the lock is broken, then converging; interrupts at
approval, whether approved or declined, while Terraform reads a plan back (no
more of the record written), once the record is written, while taking the lock
and before it), `tests/application/factory-lock.test.ts` (an interrupted
operation keeps its lock), `tests/infrastructure/plan-store.test.ts` (including
the plan file's digest as it is now, a bootstrap plan bound to `backend.tfplan`,
damaged once that file changes or vanishes, and pruned once long expired; a
spent plan missing, its `backend.tfplan` kept unchanged, spent only once, and
pruned once long unchanged),
`tests/infrastructure/aws-s3-lock-store.test.ts` (records and state revisions,
stubbed and against `tests/support/stub-s3.ts`),
`tests/infrastructure/terminal-prompt.test.ts` (Ctrl-C cancels an echoed
question), `tests/cli/presentation/workers.test.ts` (each worker outcome's
row and status across its later stages, an installed worker never ready while
enrollment or a later stage is pending or failed, a stopped worker's start
command with the instance and profile, the enrollment's login once and its
accounts numbered, delivered accounts grouped apart), `tests/cli/presentation/apply.test.ts` (the 2026-10-05 run
as [What apply prints](#what-apply-prints) shows it, plain and in color; the
Applying rows; the Result and Next block with nothing pending, one and several
workers to enroll, a delivered credential to replace with no login, and once for
several workers before their logins, mixed failed, skipped and not-attempted workers on both
streams in order, a failed worker's next action that a skipped one's shares
on standard error, enrolled workers with pending or failed dispatch and the
gate their enrollment covers said once, a repository gap, a deferred
maintenance said once, stopped workers, an empty factory and a record that
could not be finished; every failure, interrupt and run that applied nothing,
with an upgrade's pin notice before the Next block; a saved bootstrap plan's
Result and Next block, plain and in color, with the instance and profile, a
record that could not be finished, and its interrupts before and after the
lock naming `fffactory plan`), `tests/cli/apply-stages.test.ts`
(the exit code of each stage's outcomes, each line on its stream in the order
written, a failed worker's next action on standard error and the Next block
of a run with no failed worker on standard output),
`tests/cli/plan-apply.test.ts` (output, exit codes and every refusal
in process, the plan's every stage including a placed repository and requested
dispatch, `plan`'s Next block repeating a quoted instance and profile, a
refusal's Next block repeating them, and human output colored only on the
stream that is, the complete pipeline's Result and enrollment Next block, the
workers' rows and exit codes 0, 2 and 1, mixed outcomes written to both
streams in order with every next action once; an empty factory
planning its shared infrastructure alone with its `Workers` row `none declared`, and
applying it, then nothing, with exit 0; a first apply's record led by
`backend: applied`, and none for an apply that found the bucket; a saved
bootstrap plan applied with no terminal, its output, the next step with the
instance and profile quoted, exit 0 and its record's `plan_id`, then refused as
missing; one refused after factory.json changed or once the bucket exists, and
for another account before anything is planned or applied, with nothing
changed; its failed Terraform apply and an interrupt before the lock, once it
is taken, and once its record is written, printing the record; `plan`
with no bucket printing the bootstrap plan and its Next block, its exact
`apply --plan-id` command and `fffactory plan` with the instance and profile,
exit 0, and saving nothing when refused; the unattended first apply over fakes
with no terminal, `plan` saving B, `apply --plan-id B` creating the bucket,
`plan` saving F and `apply --plan-id F` applying the factory, each command's
account check first and the two records naming B (`backend` alone) then F, and
B applied after factory.json changed refused with nothing changed; a stopped worker
shown skipped in the plan, listed `stopped` by apply with exit 0, its resize
refused, and with the inventory unreadable skipped with exit 2 as before and a
resize refused; one apply creating, waiting for and installing a worker; the
wait's lines and a first boot timing out with exit 1 and its recovery;
instructions a worker sends never printed; what each interrupt left, including
a worker that may still be installing or a new worker being waited for; and,
over the real provisioner and the stand-in Terraform, a failed apply's and
plan's diagnostics kept in a private file whose path alone is printed, out of
the output and the record), `tests/cli/apply-interrupted.test.ts` (the spawned
`fffactory` over the stand-in Terraform and the S3 and STS stubs: SIGINT while
Terraform applies exits 130 with the notice and apply's report of the lock and
record it leaves, and leaves the lock and a `running` record; a rerun is
refused until `lock break`, then applies Terraform and, run from source, skips
the worker; and SIGINT while apply waits for a new worker's first boot, in
`tests/support/apply-first-boot-main.ts` over the in-memory factory, exits 130
only after naming the worker and the lock it keeps),
`tests/cli/interrupts.test.ts` (the exit after the command returns, never
before its tools stop, and at the grace's end at the latest; a command that
does not wait exiting once its tools stop, without waiting for it; each
signal's status; a second signal at once; sleeps woken),
`tests/cli/run.test.ts` (only apply, upgrade, doctor, status and worker wait
on an interrupt; `host`, `secret` and `lock` do not), `tests/cli/main.test.ts`
(doctor's interrupt notice, which offers no second interrupt; the spawned
`plan`'s header plain on an ordinary pipe, colored there only by `FORCE_COLOR`,
and plain again under `NO_COLOR`, `TERM=dumb` or `FORCE_COLOR=0`), and
`tests/assets/terraform/guardrails.test.ts` (the factory root's backend key is
`FACTORY_STATE_KEY`, and it outputs `host_keys`).

Upgrade: `tests/domain/release-compatibility.test.ts` (release precedence, the
pin assessment: an upgrade, nothing to upgrade, a downgrade, no pin, the base
generation refusal and a pin at the generation's release; the schema version
check before validation; the pin move never carrying a prerelease pin),
`tests/cli/presentation/plan.test.ts` (the pin move's preview naming both
releases and never echoing a prerelease pin),
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
`tests/cli/upgrade.test.ts` (the output and question, the pin row before the
install, plan passing the guard once upgraded, declined, a failed apply naming
`fffactory apply`, a failure once the pin moved and how to finish, no state
bucket, factory.json changed, no terminal, a held lock refusing it, each with
the pin notice before the Next block, nothing to upgrade and the other refusals
without reaching AWS, usage),
`tests/application/set-secret.test.ts` and `tests/cli/secret.test.ts` (the guard
on `secret set` before AWS), `tests/cli/lock.test.ts` (`lock break` whatever
the pin), `tests/cli/plan-apply.test.ts` (the guard on plan and apply) and
`tests/assets/bootstrap/base-generation.test.ts` (the bootstrap's digest per
base generation).

Introduced by [#99](https://github.com/yaunder/factory/issues/99); upgrade by
[#102](https://github.com/yaunder/factory/issues/102); stopped workers by
[#7](https://github.com/yaunder/fffactory/issues/7).
