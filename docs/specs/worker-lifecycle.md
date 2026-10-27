# Worker lifecycle

`fffactory worker` powers one declared worker's EC2 instance off and on, or
terminates it, removing the host from the factory or keeping it, and inspects
whether terminate would remove a worker. It is the operator's side of a worker's lifecycle; `fffactory
host` stays the worker side of the [host protocol](host-protocol.md). EC2's
state is the truth: no factory.json field records whether a worker is stopped.
Epic: [#5](https://github.com/yaunder/fffactory/issues/5).

## Commands

```text
fffactory worker stop KEY [--force] [--yes] [--instance PATH] [--profile NAME]
fffactory worker start KEY [--yes] [--instance PATH] [--profile NAME]
fffactory worker terminate KEY [--keep] [--force] [--confirm KEY] [--instance PATH] [--profile NAME]
fffactory worker inspect [KEY] [--json] [--instance PATH] [--profile NAME]
```

- `stop` stops compute billing. The instance, its root volume (whose storage is
  still billed), its Terraform state, its tailnet device (offline, with its
  non-ephemeral key) and its factory.json entry all stay.
- `start` brings the same worker back, with the same identity, and reports its
  readiness as [status](status.md) would.
- `terminate` removes the worker from the factory: a scoped Terraform plan
  destroys the instance and its root volume and stops recording the host key,
  factory.json is written without the host, and the worker's Tailscale devices
  are deleted, so the factory has no record of it ([Terminate
  (remove)](#terminate-remove)).
- `terminate --keep` destroys the instance and its root volume and deletes the
  worker's Tailscale devices; the host stays in factory.json, so the next
  `fffactory apply` creates it afresh ([Terminate (keep)](#terminate-keep)).
- `inspect` changes nothing: it tells whether terminate would remove each
  worker, or `KEY` alone, without `--force`, from terminate's own inspection and
  gates, and lists each worker's agents ([Inspect](#inspect)).

A stopped worker is a first-class state, not a fault:
[status](status.md#workers) reports it `stopped`, with `fffactory worker start
KEY` as its next action, and exits 0; [plan and
apply](plan-apply.md#stopped-workers) skip it, never start it, send it nothing
and are not partial for it, and refuse to change its instance type, which would
start it.

`KEY` is a host key factory.json declares (`hosts[].key`). `--force` is stop's
and terminate's ([Gates](#gates), [Gates (terminate)](#gates-terminate));
`--yes` confirms stop and start in advance ([Confirmation](#confirmation)), and
`--confirm KEY` a terminate ([Confirmation (typed
key)](#confirmation-typed-key)); `--keep` is terminate's; `--json` is
inspect's; `--instance` and
`--profile` select the instance and the AWS credentials as for every command.
Anything else, an option of another subcommand (`unknown option --yes`), a
missing subcommand, or not exactly one `KEY` (for inspect, more than one) is
refused, exit 1, before anything is read.

## Order

Stop, start and terminate go in this order, and stop at the first refusal
(inspect has its own, [Inspect](#inspect)):

1. Select, read and validate factory.json, printing `Instance: PATH (SOURCE)`
   ([instance configuration](instance-configuration.md)).
2. Refuse without a terminal and without `--yes` (terminate: `--confirm KEY`):
   the command could never be confirmed ([Confirmation](#confirmation)).
3. Refuse a `KEY` factory.json does not declare, naming the declared keys. An
   argument that is not a well-formed host key is refused without being echoed:
   it could be a pasted secret. Terminate then refuses a `--confirm` that does
   not name `KEY`, never echoing it either.
4. Refuse unless factory.json is complete, listing each missing field as
   `<path>: is required to stop a worker` (or `start`, `terminate`). Terminate
   then refuses without `tailscale.admin_client_secret`, the admin client it
   deletes the worker's tailnet devices with: `factory.json has no Tailscale
   admin client (tailscale.admin_client_secret): terminate deletes the worker's
   tailnet device with it`, next action `fffactory secret set
   tailscale-admin-client` ([secrets](secrets.md#the-tailscale-admin-client)).
5. The account check: the caller must be in `aws.account_id`, resolved in the
   factory Region ([doctor §AWS account](doctor.md#aws-account)).
6. The [CLI/pin match guard](plan-apply.md#clipin-match-guard): only the
   release factory.json pins may stop, start or terminate a worker.
7. Take the factory-wide lock as operation `worker-stop`, `worker-start` or
   `worker-terminate`, and open its [operation record](#operation-record). A
   held lock refuses the command and shows its holder ([provisioning §Lock](provisioning.md#lock)).
8. Locate the one EC2 instance carrying the tags `fffactory:factory-id` = the
   factory ID and `fffactory:host-key` = `KEY`, in every state but
   `terminated` (`DescribeInstances`, as [status](status.md#inventories) lists
   them). Several (each listed) or an inventory that could not be read is
   refused: fffactory never guesses, and never takes an unreadable inventory for
   a machine gone. None is refused for stop and start, `No EC2 instance carries
   the host key KEY`, next action ``There is no machine to stop: `fffactory
   apply` provisions the worker.`` (or `start`). Terminate takes none as the
   machine already gone: without `--keep` it removes the host ([Terminate
   (remove)](#terminate-remove)); with `--keep` it deletes the worker's tailnet
   devices ([Terminate (keep)](#terminate-keep)).
9. The gates: stop's ([Gates](#gates)) or terminate's ([Gates
   (terminate)](#gates-terminate)).
10. Terminate: read the admin client from Secrets Manager and exchange it for a
    token ([Tailnet device removal](#tailnet-device-removal)), so a client that
    cannot delete the worker's devices refuses the terminate rather than leaving
    them behind.
11. The [confirmation](#confirmation).
12. Act: `StopInstances`, `StartInstances` or `TerminateInstances` for exactly
    that instance.
13. Wait for the target state ([Stop](#stop), [Start](#start), [Terminate
    (keep)](#terminate-keep)).
14. Terminate: delete the worker's tailnet devices.
15. Release the lock (`settleFactoryLock`): unless interrupted
    ([Interruption](#interruption)).

Terminate without `--keep` replaces steps 11 to 14 with its removal: the
scoped Terraform plan, its approval, Terraform's apply, factory.json and the
devices ([Terminate (remove)](#terminate-remove)).

Steps 2 to 6 reach nothing that could change: refusals there take no lock and
write no record. From step 7 every refusal, decline and failure is recorded and
releases the lock. No step before 12, or before the removal's apply, calls
EC2's mutating API, applies Terraform, writes factory.json or deletes a device.

## Tiers

Stop and start are operator-tier: non-destructive, and runnable by a narrow
role. Terminate is admin-tier: it destroys a machine and its volume, and its
Tailscale admin client can delete any device in the tailnet. These are the
permissions each command needs; fffactory provisions no IAM role or policy for
them.

| Permission | Resource and condition | For |
| --- | --- | --- |
| `sts:GetCallerIdentity` | `*` | The account check. |
| `ec2:DescribeInstances` | `*` (EC2 does not scope it to resources) | Locating the instance and reading its state while waiting. |
| `ec2:StopInstances` | `arn:aws:ec2:REGION:ACCOUNT:instance/*`, condition `StringEquals` `ec2:ResourceTag/fffactory:factory-id` = the factory ID | `worker stop`. |
| `ec2:StartInstances` | The same resource and condition | `worker start`. |
| `ec2:TerminateInstances` | The same resource and condition | `worker terminate`. |
| `secretsmanager:GetSecretValue` | The secret `tailscale.admin_client_secret` refers to | `worker terminate`: the Tailscale admin client. |
| What `fffactory apply` needs of the factory's Terraform | The state object `factory/terraform.tfstate` and Terraform's lock beside it, and the factory root module's resources: `ec2:TerminateInstances` on the instance, and `iam:PutRolePolicy` on the hosts' role when the host has its own Paseo password | `worker terminate` without `--keep`: the scoped removal plan and its apply. |
| `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion` | `arn:aws:s3:::BUCKET/<factory ID>-lock.json` | The factory-wide lock ([provisioning §Lock](provisioning.md#lock)). |
| `s3:PutObject` | `arn:aws:s3:::BUCKET/<factory ID>-operations/*` | The operation record. |

Stop's and terminate's inspection and start's readiness report go over the
operator's tailnet and Tailscale SSH as `fffactory-admin`, as
[status](status.md) does; they need no AWS permission. Terminate also needs
the factory's Tailscale admin client, an OAuth client with the `devices:core`
scope ([machine onboarding §5](../../MACHINE_ONBOARDING.md#5-prepare-the-tailnet)),
which can delete any device of the tailnet: admin-tier, like the AWS
credentials that can terminate a worker.

## Stop

What stop does depends on the instance's state when it is located:

| State | Stop |
| --- | --- |
| `running` | Runs the [gates](#gates), asks for [confirmation](#confirmation), calls `StopInstances`, then waits for `stopped`. |
| `stopping` | Already on its way: never asked again, no gates and no question; waits for `stopped`, then says so: `Worker KEY (HOSTNAME) is now stopped: it was already on its way, and fffactory waited for it.` |
| `stopped` | Nothing to do: a no-op success, exit 0, with no gates, no question and no EC2 mutation: `Worker KEY (HOSTNAME) is already stopped: nothing to do.` |
| `pending` | Refused: wait until it is running, then rerun. |
| `shutting-down` | Refused: it is being terminated. |

The wait reads the instance's state every 5 s (`POWER_POLL_MS`) through the
injected sleep, for at most 10 min (`POWER_DEADLINE_MS`). A state still on the
way, including a read that lags behind the request or one that failed, is
waited through. The instance being terminated, or no longer listed with the
factory's tag, fails at once; the deadline passing fails with the last state
a read found (`unknown` when none did). Either names the instance to check in
the EC2 console and the command to rerun, and the lock is released.

EC2 refusing the request (`StopInstances` or `StartInstances`) fails, naming
the permission to check. A request EC2 did not answer within its 15 s deadline
(`EC2_CONTROL_TIMEOUT_MS`) fails too, but may have reached EC2: it says `The
request may have reached EC2: instance ID may be stopping.` (or `starting`),
names `fffactory status` to see where the worker is and the command to rerun,
and the lock is released.

```text
Instance: /work/.fffactory/factory.json (nearest .fffactory/factory.json)
Worker builder-1 (fff-abcd1234-builder-1): EC2 instance i-0123456789abcdef0 is running.
Stopping EC2 instance i-0123456789abcdef0; waiting for it to be stopped (up to 10 min).
Stopped worker builder-1 (fff-abcd1234-builder-1). Its instance, volume, tailnet device and factory.json entry stay; `fffactory worker start builder-1` brings it back.
Operation record: s3://fff-abcd1234-state/fff-abcd1234-operations/2026-09-30T12:00:00.000Z-aaaaaaaa.json
```

## Start

| State | Start |
| --- | --- |
| `stopped` | Asks for [confirmation](#confirmation), calls `StartInstances`, then waits for `running`. |
| `pending` | Already on its way: never asked again and no question; waits for `running`, then says so as stop does (`is now running: it was already on its way, ...`). |
| `running` | Nothing to do: a no-op success, exit 0, with no question and no EC2 mutation (`Worker KEY (HOSTNAME) is already running.`); still reports readiness as below. |
| `stopping` | Refused: wait until it has stopped, then rerun. |
| `shutting-down` | Refused: it is being terminated. |

Start has no inspection gate. The wait for `running` is stop's
([Stop](#stop)). Once the instance runs, start waits, still under the lock,
for the worker's tailnet device: it reads the peer view every 15 s
(`ONLINE_POLL_MS`) for at most 5 min (`ONLINE_DEADLINE_MS`) while the device is
missing, offline or lists no Tailscale SSH host key, as a booting worker shows.
Then it reports the worker's verdict under `Status:` in status's words:

- found in the tailnet: the worker is inspected (`host inspect --json`) and
  judged by status's readiness rule (`inspectionVerdict`,
  [status §Readiness](status.md#readiness)). A release or a host configuration
  the worker missed while stopped names `fffactory apply`;
- still joining at the deadline: status's tailnet verdict, such as `Offline in
  the tailnet` with its next action;
- a duplicate name, a device without the factory's tag, or an unavailable peer
  view: status's verdict at once, never waited out.

A worker that is not ready, or not online in time, is reported, not a failure of
start: it exits 0.

```text
Worker builder-1 (fff-abcd1234-builder-1): EC2 instance i-0123456789abcdef0 is stopped.
Starting EC2 instance i-0123456789abcdef0; waiting for it to be running (up to 10 min).
Waiting for fff-abcd1234-builder-1 to come online in the tailnet (up to 5 min).
Started worker builder-1 (fff-abcd1234-builder-1).
Status:
  not ready  It runs release 0.2.0; factory.json pins 0.3.0
  Next: Install release 0.3.0 with `fffactory apply`, then rerun `fffactory status`.
```

## Terminate (remove)

Without `--keep`, terminate removes the worker from the factory
([#10](https://github.com/yaunder/fffactory/issues/10)): Terraform destroys its
machine and stops recording its host key, factory.json no longer declares it,
and its tailnet devices are deleted. It is the only way to remove a host:
removing one from factory.json by hand is still refused by the D11 refusal,
which names this command
([plan-apply §Refusals](plan-apply.md#refusals-until-lifecycle-work-lands-d11)),
and the scoped removal plan is the only plan allowed to destroy one host
machine (teardown's guarded destroy plan destroys them all with the whole
factory: [provisioning §Destroy plan](provisioning.md#destroy-plan)). It is a reduced form of host retirement
([design §Host retirement](../designs/fffactory-v2.md#host-retirement)): no
snapshot, no `retiring` step, and dispatch is not paused first.

What it does depends on the instance's state when it is located:

| State | Terminate (remove) |
| --- | --- |
| `running` | Runs the [gates](#gates-terminate), opens the [admin client](#tailnet-device-removal), then the removal below, whose plan must destroy the instance. |
| `stopped` | The same, but passes the gates uninspected. |
| `shutting-down` | No gates and no question yet; opens the admin client and waits for `terminated`, then the removal below, whose plan must not destroy an instance, and whose question says the instance was already being terminated. |
| No instance carries the key | The machine is already gone: `Worker KEY (HOSTNAME): no EC2 instance carries its key; its machine is already gone.`, no gates; opens the admin client, then the removal below, whose plan must not destroy an instance. |
| `pending`, `stopping` | Refused, as with `--keep`. |

The last host factory.json declares is removed like any other, under the same
lock, plan, typed key and record: an empty factory is a factory
([instance configuration §Completeness](instance-configuration.md#completeness)).
Its machine, its recorded host key, its factory.json entry (and with it its
repository placements and dispatch settings) and its tailnet devices go; the
factory's shared infrastructure stays: the state bucket and Terraform state,
the network, the hosts' IAM role and instance profile, whose policy then allows
only the Tailscale enrollment key and the factory-wide credential references
factory.json sets. factory.json keeps `hosts: []` and its
`repositories` inventory. To change the size of a single-worker factory,
terminate the worker, then declare its replacement with the `instance_type`
and `root_volume_gib` wanted and a Paseo password, as every host needs
([instance configuration §Completeness](instance-configuration.md#completeness)),
under a new key or the same one, and run
`fffactory apply`: Terraform no longer records the removed key, so either is a
plain create, never refused as a removed host key
([provisioning §Stable host keys](provisioning.md#stable-host-keys)).
`--keep` is no substitute: it leaves the host declared, and the next apply
recreates it as declared.

The removal, under the same lock and record:

1. Plan. This release's Terraform tree is materialized as `plan` materializes
   it. The host keys the state records are read as for any plan
   ([provisioning §Stable host keys](provisioning.md#stable-host-keys)); a
   record that cannot be read is refused. factory.json without the host is built
   in memory, by own entries, and projected with the recorded keys less the
   removed one; any other issue, such as another host already removed by hand,
   is refused, listed by field path. The factory root is planned from that
   projection into a plan file of the operation's own in the plan store (kept
   only while the operation runs, never saved), with Terraform's state lock
   taken, and read back with `showPlan`.
2. The scoped removal rule (`removalPlanRefusal`, `src/domain/host-removal.ts`).
   Leaving reads and no-ops aside, the plan may only:
   - delete `module.hosts.aws_instance.host["KEY"]`, a managed `aws_instance`,
     with the single action `delete`. It must when EC2 listed the instance, and
     must not when it listed none: `Terraform's plan does not destroy host KEY's
     machine: its state does not hold the instance EC2 lists for it`, or
     `Terraform's state holds a machine for host KEY that EC2 does not list with
     the factory's tags`, each naming the EC2 console. The instance it deletes,
     the `id` its `before` names, must be the one EC2 lists, which the gates
     inspected and the question names: another, say one the state holds whose
     tags were stripped by hand while EC2 lists a tagged one, would be destroyed
     while the approved instance kept running. Another is refused, `Terraform's
     plan destroys instance ID for host KEY, not LISTED, the instance EC2 lists
     for it`, and so is one it does not name, `Terraform's plan does not
     identify the instance it destroys for host KEY: only LISTED, the instance
     EC2 lists for it, may be destroyed`. The first names both instances in the
     EC2 console, the second the instances carrying the host key;
   - update `module.host_identity.aws_iam_role_policy.read_secrets`, the hosts'
     secret-reading policy, in place, only when no remaining host shares the
     removed host's `paseo_password_secret` and the update only stops allowing
     it: every other
     attribute as before, nothing unknown until apply, and the policy document
     (its statements' actions and resources compared as sets) as before less
     that one ARN. The credential references (`credentials.*_secret`) are
     factory-wide, so removing a host never changes them, and the rule stays as
     it is: a policy update that drops or adds one is another change, refused.

   Any other change, a replacement of the host, another host's change, a pending
   create or update, drift or an action fffactory does not know, fails closed,
   and nothing is applied:

   ```text
   Refusing to terminate the worker: The removal plan changes more than host builder-1's machine: apply factory.json's other changes first
     module.hosts.aws_instance.host["builder-2"] would be created
   Next: Apply factory.json's other changes first with `fffactory apply`, or undo them, then rerun `fffactory worker terminate builder-1`.
   ```

   A plan that cannot be read is refused too.

   The rule is checked against Terraform's own removal plans, not only
   hand-written JSON: `scripts/terraform-check.ts` (CI's `Terraform modules`
   job) plans removals with the managed Terraform and the shipped modules from
   isolated fixtures, reaching no AWS account and reading no factory state. A
   fixture's state is synthesized from Terraform's own plans of the example
   with several hosts (two with their own Paseo passwords, one sharing
   another's) or with one, and every credential reference: each resource as planned, its values unknown
   until apply filled with fake but well-formed IDs and ARNs, until Terraform
   plans no change for it. Each removal is planned as step 1 plans it (the
   recorded keys from the state's outputs, factory.json without the host
   projected, `plan -detailed-exitcode` with the state lock, though with
   `-refresh=false`, and the plan read back with `showPlan`), and the real
   JSON plan judged by `removalPlanRefusal`. Removing a host with its own
   password plans exactly the instance's `delete` and the policy's in-place
   `update`, the policy then allowing the enrollment key, the remaining
   hosts' passwords and the credential references; removing one sharing its
   password with a remaining host, only the `delete`; removing the last host leaves
   the policy allowing only the enrollment key and the credential references. Each is allowed. Refused: the same plan judged with another
   instance listed, or none, and removals planned together with another host's
   instance type, the subnet's CIDR block, another host's Paseo password or a
   credential reference changed, the last two a policy update that is more than
   the removed host's password dropped. With `-refresh=false` each change's `before` values are
   Terraform's planned values, not what AWS returns on refresh, so the check
   proves the plan's shape and the rule's verdicts on it, not that a production
   refresh adds no drift; drift that does appear is another change, which the
   rule refuses.
3. Show the plan, reusing the plan review's words:

   ```text
   Removal plan:
     Configuration: /work/.fffactory/factory.json
     Factory: Test factory (fff-abcd1234)
     AWS account: 123456789012, Region: eu-west-2
     Release: 0.3.0
   Infrastructure changes:
     - module.hosts.aws_instance.host["builder-1"]
     0 to add, 0 to change, 1 to destroy.
   factory.json: remove host builder-1.
   Tailnet: delete the devices named fff-abcd1234-builder-1 that carry the factory's tag.
   ```

4. The typed-key [confirmation](#confirmation-typed-key), or `--confirm KEY`.
5. factory.json must still be the exact text read in step 1 of the
   [order](#order): otherwise `factory.json changed after fffactory read it:
   nothing was applied`.
6. Apply exactly that plan file (`Applying the removal plan. Terraform's output
   is not shown; this can take several minutes.`). Terraform terminates the
   instance and waits for it. A plan that changes nothing is not applied, unless
   the state still records the key (an earlier removal's apply that stopped
   before writing its outputs). Then the recorded host keys are read again: one
   still holding the key fails, `Terraform still records host KEY after
   applying its removal`, factory.json unwritten.
7. Write factory.json without the host (`InstanceStore.write`, atomic), only if
   it is still the text read; `factory.json no longer declares host KEY: PATH`.
   Every other field and host is kept; the document is written as
   `JSON.stringify` with two spaces, as `upgrade` writes it.
8. Delete the worker's tailnet devices ([Tailnet device removal](#tailnet-device-removal)).

```text
Instance: /work/.fffactory/factory.json (nearest .fffactory/factory.json)
Worker builder-1 (fff-abcd1234-builder-1): EC2 instance i-0123456789abcdef0 is running.
Planning the removal of host builder-1. Terraform's output is not shown.
Removal plan:
  ...
Applying the removal plan. Terraform's output is not shown; this can take several minutes.
factory.json no longer declares host builder-1: /work/.fffactory/factory.json
Deleting the Tailscale devices named fff-abcd1234-builder-1.
Removed worker builder-1 (fff-abcd1234-builder-1): its EC2 instance and root volume are gone, and neither Terraform nor factory.json records it.
Deleted Tailscale device nAbCdEf1CNTRL (fff-abcd1234-builder-1).
Operation record: s3://fff-abcd1234-state/fff-abcd1234-operations/2026-10-12T12:00:00.000Z-aaaaaaaa.json
```

Afterwards `fffactory plan` shows no change for the host, since Terraform no
longer records it and factory.json no longer declares it, and
[status](status.md) no longer lists it. Once the last host is removed, `plan`
shows its `Workers` row as `none declared`, with how to declare a host, and no
other change, and `status` reports no workers declared and exits 0
([plan-apply §An empty factory](plan-apply.md#an-empty-factory)).

Each failure leaves a state the next action names, and every one is recorded
and releases the lock:

| Fails | Leaves | Next action |
| --- | --- | --- |
| Planning (`Planning the removal failed: REASON`) | Nothing applied: the machine and factory.json as they were. | Rerun `fffactory worker terminate KEY`. |
| Terraform's apply (`Removing the host failed: REASON`) | Terraform may have destroyed the machine; factory.json untouched, still declaring the host. | Rerun `fffactory worker terminate KEY`: it plans again from what exists, which may be a machine shutting down or gone, and finishes. |
| The key still recorded after the apply | The machine destroyed; factory.json untouched. | Rerun `fffactory worker terminate KEY`. |
| Writing factory.json, or it changed meanwhile (`Terraform destroyed host KEY's machine and no longer records it, but factory.json could not be written (REASON): it still declares the host`) | No machine, no recorded key; factory.json still declaring the host, whose next `fffactory apply` would create it afresh; its devices not yet deleted. | Remove the host KEY from `hosts` in PATH yourself and delete the devices named HOSTNAME at the admin console, or rerun `fffactory worker terminate KEY` once factory.json can be written: it finds the machine gone and finishes. |
| Deleting a device | The host removed everywhere but the tailnet: exit 2, `partial`. | Remove the remaining devices named HOSTNAME at the admin console ([Tailnet device removal](#tailnet-device-removal)). |
| Any other error once factory.json is written, such as the operation record's write before the devices are deleted | The host removed everywhere but the tailnet, whose devices may remain; a rerun would be refused, since factory.json no longer declares the host. | Remove the remaining devices named HOSTNAME at the admin console. |

A failed Terraform command's reason is fffactory's own; its diagnostics are
kept in a private local file whose path alone is printed after the failure, as
for `apply` ([plan-apply §Failure](plan-apply.md#failure)), and never reach the
operation record.

## Terminate (keep)

What terminate does depends on the instance's state when it is located:

| State | Terminate |
| --- | --- |
| `running` | Runs the [gates](#gates-terminate), opens the [admin client](#tailnet-device-removal), asks for [confirmation](#confirmation-typed-key), calls `TerminateInstances`, waits for `terminated`, then deletes the worker's tailnet devices. |
| `stopped` | The same, but passes the gates uninspected ([Gates (terminate)](#gates-terminate)). |
| `shutting-down` | Already on its way: no gates and no EC2 call; opens the admin client, asks for the [typed key](#confirmation-typed-key) before the wait (`Wait for EC2 instance ID, already being terminated, then delete the Tailscale devices of worker KEY (HOSTNAME)? ...`), waits for `terminated`, then deletes the devices, and says so as stop does (`is now terminated: it was already on its way, ...`). Declined, it deletes no device and leaves the instance to EC2: ``Not confirmed: nothing was changed, though EC2 instance ID was already being terminated.``, exit 1, recorded `declined`. |
| No instance carries the key | The machine is already gone, as an interrupted or timed-out terminate leaves it once EC2 lists the instance `terminated`: `Worker KEY (HOSTNAME): no EC2 instance carries its key; its machine is already gone.`, no gates and no EC2 call; opens the admin client, asks for the [typed key](#confirmation-typed-key), then deletes the devices: ``Worker KEY (HOSTNAME) has no machine left to terminate. factory.json keeps the host, so `fffactory apply` creates it afresh.`` It ends `unchanged`, exit 0, or `partial`, exit 2, when a device remains. |
| `pending` | Refused: wait until it is running, then rerun. |
| `stopping` | Refused: wait until it has stopped, then rerun. |

The wait is stop's ([Stop](#stop)): every 5 s for at most 10 min, through the
injected sleep. It ends once a read finds the instance `terminated`, or EC2 no
longer lists it with the factory's tag (`absent`); every other state, and a
read that failed, is waited through, and the deadline fails with the last
state seen. `TerminateInstances` refused fails, naming `ec2:TerminateInstances`;
one EC2 did not answer within 15 s may have reached it: `instance ID may be
shutting down`.

With `--keep`, the host stays in factory.json. Terraform is not run, and its
state still holds the instance until the next plan refreshes it: refresh drops
the terminated instance, and the next `fffactory apply` plans the host as a
plain create, which the D11 refusals allow
([plan-apply §Refusals](plan-apply.md#refusals-until-lifecycle-work-lands-d11)),
and waits for its first boot
([plan-apply §Waiting for a new worker](plan-apply.md#waiting-for-a-new-worker)). Until then [status](status.md#workers)
reports the host `Not provisioned`, since EC2 lists no instance carrying its
key. This is the recovery for a [failed first boot](worker-bootstrap.md#failed-first-boot),
with `--force`: a worker that never joined the tailnet cannot be inspected.

```text
Instance: /work/.fffactory/factory.json (nearest .fffactory/factory.json)
Worker builder-1 (fff-abcd1234-builder-1): EC2 instance i-0123456789abcdef0 is running.
Terminating EC2 instance i-0123456789abcdef0; waiting for it to be terminated (up to 10 min).
Deleting the Tailscale devices named fff-abcd1234-builder-1.
Terminated worker builder-1 (fff-abcd1234-builder-1): its EC2 instance and root volume are gone. factory.json keeps the host, so `fffactory apply` creates it afresh.
Deleted Tailscale device nAbCdEf1CNTRL (fff-abcd1234-builder-1).
Operation record: s3://fff-abcd1234-state/fff-abcd1234-operations/2026-10-12T12:00:00.000Z-aaaaaaaa.json
```

No device left to delete prints `No Tailscale device named HOSTNAME remained to
delete.` A stopped machine prints `The machine is stopped: the worker is not
inspected, and unpushed work on its disk is not reported.` before acting.

## Tailnet device removal

A terminated worker's device would otherwise stay in the tailnet, offline, with
the worker's hostname: the next apply's new device would then share the name,
which the hostname-match rule refuses as a duplicate
([host protocol §Finding the worker](host-protocol.md#finding-the-worker)).
Terminate deletes it through the Tailscale API, as the factory's admin client
(`tailscale.admin_client_secret`, [secrets](secrets.md#the-tailscale-admin-client)):

1. Under the lock and before the confirmation, read the client secret from
   Secrets Manager by its ARN, in the factory Region (`GetSecretValue`, within
   30 s). It is a `SecretMaterial` from then on, and the Tailscale API adapter
   alone reveals it, for each token request. A secret that cannot be read
   refuses the terminate, named by error (`Reading the secret from Secrets
   Manager failed: AccessDeniedException`), next action the
   `secretsmanager:GetSecretValue` permission.
2. Exchange it for a short-lived access token: `POST
   https://api.tailscale.com/api/v2/oauth/token`, form-encoded
   `grant_type=client_credentials`, `client_id=fffactory` and
   `client_secret=SECRET`. factory.json keeps only the client secret, not its
   client ID: like Tailscale's own CLI exchanging a `tskey-client-…` secret, the
   adapter sends a placeholder client ID, which Tailscale ignores. **This relies
   on undocumented behavior**: Tailscale's API reference sends both the client
   ID and the secret. A secret that does not begin `tskey-client-` is refused
   without a request. Tailscale refusing the client (HTTP 400, 401 or 403), any
   other status, an answer without a token, a network failure or the deadline
   refuses the terminate, `The Tailscale admin client could not be used:
   REASON`, next action the OAuth client at the admin console's trust
   credentials and `fffactory secret set tailscale-admin-client`.
3. Once the instance is terminated, list the tailnet's devices (`GET
   /api/v2/tailnet/-/devices`) and select every device whose reported
   hostname is the worker's namespaced hostname, ignoring case (`name-1` is not
   `name`), stale copies included: a stale copy keeps its reported hostname
   (`selectWorkerDevices`, `src/domain/tailnet.ts`). Unlike the hostname-match
   rule, the MagicDNS label never selects a device: host keys may end in `-N`,
   so Tailscale can give a second `builder` device the label of `builder-1`,
   and terminating `builder-1` must not delete it.
4. Delete each selected device that carries the factory's tag (`tailscale.tag`,
   compared exactly), one at a time, by its node ID (`DELETE
   /api/v2/device/ID`); a device already gone (HTTP 404) counts as deleted. An
   ID that is not a plain token is never put in a URL. A matching device
   without the tag is never deleted: any tailnet member can take a name. It is
   reported by its ID, never its tags.

The API is `https://api.tailscale.com`. Only for tests, `fffactory` run from
source reads `FFFACTORY_TAILSCALE_API` (`tailscaleApiBase`, read once by
`src/cli/main.ts`), which points it at a local stand-in
(`tests/cli/teardown-executable.test.ts`); the compiled release
(`Bun.isStandaloneExecutable`) never reads it. The token exchange sends the
admin client's secret itself to the host it names. Unlike
`AWS_ENDPOINT_URL_*`, whose endpoints receive only a SigV4 signature and never
the secret access key, a stand-in there would hold the secret, so it must be
plain `http://` on a literal loopback address, `127.0.0.1` or `[::1]` (never a
name such as `localhost`, which resolves through /etc/hosts or DNS), with no
path, credentials, query or fragment; its origin is used. Anything else, such
as HTTPS or another host, stops every command before it runs, with `fffactory:
FFFACTORY_TAILSCALE_API names no local stand-in for Tailscale's API: it must be
plain http:// on 127.0.0.1 or [::1], with no path`, exit 1: the
variable is named, its value never printed, and Tailscale's API never used in
its place. Unset or empty, it names nothing.

Every request has a 15 s deadline (`TAILSCALE_API_TIMEOUT_MS`) and follows no
redirect: a redirect fails the request as unreachable (`Tailscale could not be
reached (UnexpectedRedirect)`), and its target receives nothing. A failure is
named by HTTP status or network error code (`Tailscale answered HTTP 500`); no
API answer body, token or secret is ever printed, recorded or put in a command
argument, and the token and the secret live only for the operation, in memory.

A token lasts about an hour, and the session opens before the confirmation,
which waits on the operator, and the wait for `terminated`. So a listing or
deletion that Tailscale refuses with HTTP 401 exchanges the secret for a fresh
token once, as in step 2, and is retried with it. A renewal that fails, or a
retry refused again, fails that call, named as above.

The instance is terminated by then, and that is not undone. A listing that
failed, a device that could not be deleted, or an untagged device with the
worker's hostname leaves the terminate partial: exit 2, the operation record
`partial`, and on standard error

```text
Deleting the worker's tailnet devices was not complete: Not every Tailscale device named fff-abcd1234-builder-1 was deleted
  Deleting device nAbCdEf1CNTRL failed: Tailscale answered HTTP 500
  Device nZyXwVu1CNTRL does not carry the factory's tag (tailscale.tag in factory.json): not deleted
Next: Remove the remaining devices named fff-abcd1234-builder-1 at https://login.tailscale.com/admin/machines yourself (one without the factory's tag only if it was this worker), then run `fffactory apply`, which creates the worker afresh.
```

That is `--keep`'s next action. Removing the host, it ends `...: factory.json
no longer declares the host.` instead: there is no next apply to prepare for.

fffactory does not check the token's scope before terminating: a client
without write access to devices (`devices:core`) is found only here.

## Gates

Before stopping a running worker, stop inspects it over the host protocol:

1. Locate it in the operator's peer view by the hostname-match rule and the
   factory's tag ([host protocol §Finding the worker](host-protocol.md#finding-the-worker)).
   A worker that cannot be located (offline, missing, no Tailscale SSH host
   key, a duplicate name, an untagged device, no peer view) cannot be
   inspected: refused, `HOSTNAME could not be inspected: SUMMARY`, with the
   tailnet's next action and `--force stops it uninspected.` A missing worker
   has stop's own next action instead: ``Check the worker with `fffactory
   status`, then rerun `fffactory worker stop KEY`. --force stops it
   uninspected.`` Status's next action for a missing worker is the
   [failed-first-boot](worker-bootstrap.md#failed-first-boot) recovery
   (terminating it), which stop leaves to status.
2. Read its agents (`host control-plane activity`, the
   [control plane](control-plane.md)'s `agents`) and judge them by the
   [busy rule](control-plane.md#the-busy-rule). Busy agents refuse the stop,
   naming how many of each: `2 agents are working on HOSTNAME: stopping it
   would end them` (`1 agent needs input on HOSTNAME: stopping it would end
   it`; `1 agent is working and 1 needs input on HOSTNAME: ...`), next action
   ``Wait until no agent there is working or needs input, then rerun
   `fffactory worker stop KEY`, or pass --force to stop it anyway.`` Agents
   that are only `finished`, `failed` or `stopped` never refuse it. Activity
   that could not be read (SSH could not reach the worker, an unreadable
   answer, no control plane) refuses it too, `HOSTNAME could not be inspected
   for busy agents: REASON`. A worker on a release from before agent states,
   which answers without its agents, is refused with that reason, `its release
   predates fffactory's agent states`, and the detail `Its release answers
   without its agents, so fffactory cannot tell whether any is busy.`; its next
   action is the replacement apply names
   ([control plane §Pre-activation deferral](control-plane.md#pre-activation-deferral)),
   then `Or pass --force to stop it uninspected.`

`--force` skips both: the worker is not inspected, and `--force: the worker is
not inspected for busy agents.` says so. It never skips the account check,
the pin guard, the lock or the confirmation. Stopping an already stopped or
stopping worker runs no gates.

Accepted race ([epic #5](https://github.com/yaunder/fffactory/issues/5)): dispatch may start an agent between the activity check and
the stop, which then ends it. It is marked in `application/worker-lifecycle.ts`
until dispatch gains a pause.

## Gates (terminate)

Before terminating a running worker, terminate inspects it as stop does, and
also reads its last repository result (`host repositories --json`, as
[status](status.md#readiness) reads it) and, fresh, the work in every checkout
and worktree on it ([host protocol §work inspect](host-protocol.md#work-inspect)):

1. Locate it in the operator's peer view. A worker that cannot be located is
   refused, `HOSTNAME could not be inspected: SUMMARY`, with terminate's own
   next action, not the tailnet's: ``Check the worker with `fffactory status`,
   then rerun `fffactory worker terminate KEY --keep`. If the instance's EC2
   console output shows its bootstrap failed, it never joined the tailnet:
   rerun with --force, which terminates it uninspected.`` (without `--keep` in
   the rerun when the command removed the host: every next action reruns the
   command as given). Status's recovery for
   a missing worker is terminating it, so its words here would send the
   operator back to the command refused. The gate stays, though a worker whose
   [bootstrap failed](worker-bootstrap.md#failed-first-boot) is always refused
   by it: a missing device can also be tailnet policy hiding a live worker.
2. Its agents, by the [busy rule](control-plane.md#the-busy-rule), as stop
   judges them: busy agents refuse it, `2 agents are working on HOSTNAME:
   terminating it would end them`, next action ``Wait until no agent there is
   working or needs input, then rerun `fffactory worker terminate KEY --keep`,
   or pass --force to terminate it anyway.``; activity that could not be read,
   or no control plane, refuses it too. A worker whose only agents are
   `finished` (the dispatch and epic agents of a merged epic among them),
   `failed` or `stopped` passes this gate, and with all its work pushed is
   terminated without `--force`
   ([#92](https://github.com/yaunder/fffactory/issues/92)): the work gate
   below protects what an agent left. A worker on a release from before agent
   states is refused as stop refuses it, but checked by hand as an older
   activator is (step 3), its next action ending ``then terminate it with
   --force: `fffactory worker terminate KEY --keep --force`.``
3. Its current work (`sudo -n /usr/local/libexec/fffactory-activate work
   inspect`), asked only once the activity has been read, since the activator
   runs one operation at a time, and never when the activity already refused
   it, which would hold the worker's activator up to 2 min for nothing. The
   worker reads, as the runtime account and changing nothing, every checkout
   under `/workspace/repos`, every worktree under Paseo's
   `~factory/.paseo/worktrees`, every worktree Git lists for their
   repositories, and every populated submodule of those, as a repository of
   its own ([host protocol §work inspect](host-protocol.md#work-inspect)).
   **Unresolved work** is any of:
   - in a worktree: tracked changes, staged or not, or unmerged; untracked files
     Git does not ignore; commits reachable from its HEAD that no
     remote-tracking branch holds (a detached HEAD's too, and a worktree whose
     directory is gone); a merge, rebase, cherry-pick or revert in progress;
   - in a repository: commits on any local branch that no remote-tracking
     branch holds (ahead of its upstream, or on a branch with none); a stash
     entry.

   Ignored files are not work, and anything inside an ignored directory,
   a repository included, is not inspected; nor is anything reached only
   through a symbolic link below a search root. "On a remote" means held by
   any remote-tracking ref, whatever the remote's URL: a remote that is a
   local path counts. Commits reachable only from the reflog, a tag or a note
   are not counted as work. Nothing is fetched, so "on a remote" is as of the
   worker's last fetch or push: a branch merged by squash whose remote branch
   was since pruned counts as unpushed, the safe side. Unresolved work refuses
   it, `HOSTNAME holds work not pushed to any remote: terminating it would lose
   it`, one line for each checkout or worktree holding some (`PATH (branch
   NAME): 1 untracked file, 2 commits not on any remote`; at most 20, then `...
   and N more`), next action ``Push or discard it, then rerun `fffactory worker
   terminate KEY --keep`, or pass --force to terminate it anyway.`` A
   repository or worktree the worker could not read (among them one where Git
   warned while reporting, or where a file Git is told to assume unchanged or
   marked skip-worktree is on disk; a submodule's directory holding files but
   no repository; and a submodule's Git directory no submodule uses), an
   inspection it did not finish within its time or limits (a search root reached through a symbolic
   link, or a checkout deeper than it searches, among them), or a checkout
   factory.json places on the worker that the inspection does not report
   (`/workspace/repos/PATH: placed on this worker, but the work inspection did
   not report it`; one never cloned too), refuses it, `HOSTNAME could not be
   fully inspected for unpushed work`, each listed. An inspection that could
   not be had refuses it, `HOSTNAME could not be inspected for unpushed work:
   REASON`: no answer within 2 min, SSH could not reach it, another host
   operation held the activator (rerun), an answer for another worker, or one
   that is not a work inspection (never quoted). The repository result's own
   refusal (step 4), when it has one, is listed with it, so that what is known
   is seen before `--force` is named. A worker whose activator predates the work
   inspection (it refuses the operation as a usage error, exit 64) cannot get
   it: a worker's activator is installed at its first boot and never updated
   (until base migration, M3, delivers a newer one). It is refused with that
   reason, and the next action ``Log in as `factory` (`tailscale ssh
   factory@HOSTNAME`; tailnet SSH policy must let you log in as `factory`). In
   every checkout under /workspace/repos and ~/.paseo/worktrees, and every
   worktree `git worktree list` shows, run `git status`, `git log --branches
   --not --remotes` and `git stash list`, and push or copy off what you need;
   then terminate it with --force: `fffactory worker terminate KEY --keep
   --force`.`` (`fffactory-admin`, the operator's usual login, cannot read the
   runtime account's home.)
4. Its repository result: placed checkouts left unresolved at the last
   synchronization (a dirty tree, divergence, a wrong or unadopted branch)
   refuse it, `Placed repositories on HOSTNAME are unresolved: terminating it
   would lose their work`, listing any unmanaged checkouts; unmanaged checkouts
   alone (present on the worker, no longer placed there, never removed) refuse
   it, `HOSTNAME holds unmanaged checkouts: terminating it would lose them`,
   each listed, next action `--force`; a result that could not be read refuses
   it, `HOSTNAME could not be inspected for checkouts: REASON`. A worker that
   has never synchronized repositories (`none`) passes.

The gates are judged in that order, and the first that refuses is reported,
but for a work inspection that could not be had, which lists the repository
result's refusal too.
`--force` skips the inspection: `--force: the worker is not inspected for busy
agents, current work or checkouts.` It never skips the account check, the pin guard, the
lock, the admin client or the confirmation.

A worker whose machine is `stopped` passes uninspected, without `--force`: no
agent runs on it, and it cannot be reached. **Accepted risk:** unpushed work on
a stopped worker's disk is not reported, and is destroyed with it. A machine
already `shutting-down` runs no gates. The race stop accepts ([Gates](#gates)) applies to
terminate too, marked in the same place.

## Inspect

`fffactory worker inspect [KEY] [--json]` tells whether `fffactory worker
terminate` would remove each worker without `--force`, so an operator, or an
unattended caller, can learn it without attempting a removal (D12, [epic
#94](https://github.com/yaunder/fffactory/issues/94)). It is read-only: it
takes no lock, writes no operation record, asks no confirmation and changes
nothing. Its answer is as of its own inspection; a terminate run later
inspects afresh, and dispatch may start an agent in between.

It goes in this order, and stops at the first refusal:

1. Select, read and validate factory.json, printing its header
   (`fffactory worker inspect · release R`, then `Instance  PATH (SOURCE)`),
   on standard error with `--json`.
2. Refuse a `KEY` factory.json does not declare, as terminate refuses it
   ([Order](#order), step 3): `Refusing to inspect the worker: factory.json
   declares no host KEY`, listing the declared keys; an argument that is not a
   well-formed host key is never echoed.
3. Refuse unless factory.json is complete: `Refusing to inspect the workers:
   factory.json is not ready:`, each missing field as `<path>: is required to
   inspect a worker`.
4. The account check, as every command: the caller must be in
   `aws.account_id`, resolved in the factory Region ([doctor §AWS
   account](doctor.md#aws-account)); another account, or none, is refused,
   `Refusing to inspect the workers: ...`. Like [status](status.md), it does
   not apply the [CLI/pin match guard](plan-apply.md#clipin-match-guard),
   since it changes nothing: its verdict is the running release's gates, which
   are terminate's only when it is the release factory.json pins.
5. List the factory's EC2 instances once.
6. Judge `KEY`, or every declared host in factory.json's order, all at once,
   by terminate's own rules, code and words:
   - Its one instance, as terminate locates it ([Order](#order), step 8): an
     inventory that could not be read, or several instances, refuse it; none
     is a machine already gone, which terminate removes without gates:
     `not_inspected`, `absent`.
   - Its state, as terminate judges it: `pending` or `stopping` refuse it
     (`EC2 instance ID is pending`, next action ``Wait until it is running,
     then rerun `fffactory worker inspect KEY`.``); `shutting-down`, which
     terminate only waits for, is `not_inspected`, `shutting_down`;
     `stopped`, which terminate passes uninspected, is `not_inspected`,
     `stopped` ([Gates (terminate)](#gates-terminate)).
   - A running worker: terminate's own fresh inspection
     (`inspectForRemoval`: located in the tailnet, its agents and last
     repository result read, then its current work only once the activity does
     not refuse it), judged by terminate's own gates (`removalGate`), in their
     order ([Gates (terminate)](#gates-terminate)). Their refusal is its
     findings; none makes it `removable`.

Each worker gets a verdict and its findings, in fffactory's words:

| Verdict | When | Summary and details | Next action |
| --- | --- | --- | --- |
| `removable` | Terminate's gates pass it. | `HOSTNAME can be terminated: no agent is working or needs input, and no work or checkout would be lost` | None. |
| `refused` | A gate refuses it, a running worker cannot be inspected (the tailnet does not locate it, or its agents, current work or checkouts cannot be read), or its machine's state or the EC2 inventory refuses it. | The refusal terminate would print, word for word: `1 agent is working on HOSTNAME: terminating it would end it`, `HOSTNAME holds work not pushed to any remote: terminating it would lose it` and each checkout or worktree holding some, and so on. | Inspect's own, below. |
| `not_inspected` | The gates never run for it: `stopped`, `shutting_down` or `absent`. | `The machine is stopped: the worker is not inspected, and unpushed work on its disk is not reported.`; `The machine is already being terminated: the worker is not inspected.`; `No EC2 instance carries its key: its machine is already gone.` | None. |

A refusal's next action is terminate's but for what it reruns: ``Wait until no
agent there is working or needs input, then rerun `fffactory worker inspect
KEY`, or terminate it anyway with `fffactory worker terminate KEY --force`.``
(`uninspected` for what could not be inspected); for a worker the tailnet does
not locate, ``Check the worker with `fffactory status`, then rerun `fffactory
worker inspect KEY`. If the instance's EC2 console output shows its bootstrap
failed, it never joined the tailnet: `fffactory worker terminate KEY --force`
terminates it uninspected.``; and what terminate has checked by hand (an
older activator, unmanaged checkouts) ends ``then terminate it with --force:
`fffactory worker terminate KEY --force`.`` A worker on a release from before
agent states is checked by hand too, then replaced rather than removed for
good, as apply's deferral and stop's refusal name it (D4,
[control plane §Pre-activation deferral](control-plane.md#pre-activation-deferral)):
its next action ends ``then replace it: terminate it with --force, keeping its
host, `fffactory worker terminate KEY --keep --force`, then run `fffactory
apply`, which creates it afresh.`` The verdict `not_inspected` with `forced`,
`--force` having skipped the gates, is only a terminate record's
([Operation record](#operation-record)); inspect never reports it.

The summaries name no command's flags, since terminate's and teardown's records
carry the same document ([teardown §Operation record](teardown.md#operation-record)),
and teardown has no `--force`: a `removable` worker's summary says it `can be
terminated`, as teardown terminates its machine too. Only `forced`'s summary
names `--force`, and only a terminate given it records that.

Each worker also lists its agents as terminate's inspection read them through
the activity call ([control plane §Agent states](control-plane.md#agent-states)):
its activity by the busy rule (`busy`, `idle`, or `unknown`, with why when
they could not be read), and every agent with its ID, its state and whether
dispatch launched it. Finished, failed and stopped agents are listed too, by
state: they never refuse a removal, but they are the conversations a terminate
would end (D6). A worker whose agents were not read (not inspected, or not
located) is `unknown` without a reason.

### Output

The report goes to standard output, on the [layout blocks](cli-output.md#layout-blocks):

```text
fffactory worker inspect · release 0.3.0
Instance  ~/factory/.fffactory/factory.json (nearest .fffactory/factory.json)

── Workers ──────────────────────────────────────────
  ✔ builder-1   removable · fff-abcd1234-builder-1 can be terminated: no agent is working or needs input, and no work or checkout would be lost
    Agents   1 finished (idle)
      finished   agent-1 (dispatched)

  ! builder-2   refused · 1 agent is working on fff-abcd1234-builder-2: terminating it would end it
    Agents   1 working, 2 finished (busy)
      working    agent-1 (dispatched)
      finished   agent-2, agent-3 (dispatched)

  ◼ builder-3   not inspected · The machine is stopped: the worker is not inspected, and unpushed work on its disk is not reported.

! 1 removable, 1 refused, 1 not inspected

── Next ─────────────────────────────────────────────
  builder-2: Wait until no agent there is working or needs input, then rerun `fffactory worker inspect builder-2`, or terminate it anyway with `fffactory worker terminate builder-2 --force`.
```

A refusal's details are listed under its worker. Each state's agents are
labelled with the state in the words the count uses (`needing input` for
`needs_input`). A worker not inspected has a `◼` (stopped) or `↷` glyph and no
agents. Every `fffactory` command a next
action names repeats the `--instance` and `--profile` given. A factory that
declares no worker says `none declared`.

### JSON, schema version 1

`--json` prints one document, indented by two spaces, on standard output and
nothing else. Its structure is published as
[`schemas/worker-inspection.schema.json`](../../schemas/worker-inspection.schema.json):

- `schema_version`, `release` (the running CLI's);
- `factory`: `factory_id`, `account_id`, `region` and the pinned `release`, as
  [status](status.md#json-schema-version-2) names them;
- `workers`: one each, in factory.json's order, with two fields:
  - `inspection`, the worker's inspection document: `key`, `hostname`,
    `verdict` (`removable`, `refused`, `not_inspected`), `not_inspected`
    (`stopped`, `shutting_down`, `absent`, `forced`; null unless the verdict is
    `not_inspected`), `summary`, `details`, and `activity`: `state` (`busy`,
    `idle`, `unknown`), `reason` (why the agents could not be read, else null)
    and `agents` (each agent's `id`, `state` and `dispatched`; null unless
    listed), the same object status reports;
  - `next_action`: inspect's own next action, null exactly when the verdict is
    not `refused`.

The `inspection` object names no next action: the next action is the judging
command's (inspect reruns `fffactory worker inspect KEY`, terminate and
teardown rerun themselves), while the verdict, findings and agents are the
worker's. A removal's record carries that `inspection` object as it is
([Operation record](#operation-record)), so for the same inspection the
record's document and `worker inspect --json`'s `inspection` are identical. Adding a field or a value keeps `schema_version`; consumers
ignore what they do not know. Removing, renaming or redefining a field needs a
new version.

### Exit codes (inspect)

| Exit | When |
| --- | --- |
| 0 | No worker is refused: every worker the gates ran for is removable. Workers `not_inspected` (stopped, shutting down, gone), which terminate passes without its gates, never affect the exit code; a factory declaring no worker, or only such workers, exits 0. |
| 2 | Any worker is `refused`. A running worker that could not be inspected (not located in the tailnet, its agents, current work or checkouts unreadable) is `refused`, never `not_inspected`, so it exits 2, as would a refusal by its machine's state or an unreadable EC2 inventory. |
| 1 | Invalid arguments, an undeclared `KEY`, a missing, invalid or incomplete factory.json, or another account. |
| 128 + N | Interrupted by signal N: no report is printed, since the tools it ran were stopped. |

It never prints what [What it never prints](#what-it-never-prints) forbids, and
a summary, detail or reason carrying a worker's words is shown as data, never as
inline code.

## Confirmation

Acting on the instance needs the operator's confirmation:

- At a terminal, without `--yes`, the command asks
  `Stop worker KEY (HOSTNAME), EC2 instance ID? [y/N] ` (or `Start`). Only `y`
  or `yes`, in any case, confirms; anything else, or no answer, declines:
  `Not confirmed: the worker was not stopped.`, exit 1, recorded `declined`.
- `--yes` confirms without asking, for use without a terminal.
- Without a terminal and without `--yes`, the command is refused before
  anything reaches AWS: `Stopping a worker needs your confirmation: rerun at a
  terminal, or pass --yes.`

A stop or start that is a no-op, or finds the instance already on its way, is
never asked about. Terminate asks whenever it deletes a device or removes a
host ([Confirmation (typed key)](#confirmation-typed-key)).

## Confirmation (typed key)

Terminate destroys the machine, so it is confirmed by naming the worker, never
by y/N or `--yes`:

- At a terminal, without `--confirm`, terminate asks `Terminate worker KEY
  (HOSTNAME), EC2 instance ID? Its machine and root volume are destroyed. Type
  the host key to confirm: `. Removing the host, it asks `Terminate worker KEY
  (HOSTNAME), EC2 instance ID, and remove it from factory.json? ...`, after the
  removal plan is shown, and for a machine already gone `Remove worker KEY
  (HOSTNAME) from factory.json? No EC2 instance carries its key: its machine is
  already gone. Type the host key to confirm: `, and for a machine EC2 was
  already terminating `Remove worker KEY (HOSTNAME) from factory.json? Its EC2
  instance ID was already being terminated, and is now terminated. Type the host
  key to confirm: `; with `--keep`, for a machine already gone, `Delete the
  Tailscale devices of worker KEY (HOSTNAME)? No EC2 instance carries its key:
  its machine is already gone. Type the host key to confirm: `, and for a
  machine already being terminated `Wait for EC2 instance ID, already being
  terminated, then delete the Tailscale devices of worker KEY (HOSTNAME)? Type
  the host key to confirm: `. Only the host key itself, exactly (blank space
  around it aside), confirms; `y`, `yes`, another key, or no answer declines:
  `Not confirmed: the worker was not terminated.`, exit 1, recorded `declined`
  (for a machine already being terminated, `Not confirmed: nothing was changed,
  though EC2 instance ID was already being terminated.`).
- `--confirm KEY` confirms without asking, for use without a terminal. Any
  other value refuses before anything reaches AWS, never echoed: `--confirm
  does not name the host KEY`.
- Without a terminal and without `--confirm`: `Terminating a worker needs your
  confirmation: rerun at a terminal, or pass --confirm KEY.`

The question comes after the gates and the admin client, and for a removal
after its plan: a terminate that would be refused is never asked about. Every
terminate that deletes a device or removes a host asks first, whatever state
it finds the machine in. A machine already shutting down is asked about,
though a terminate is under way: waiting for it changes nothing, but deleting
its devices, or removing the host, does. With `--keep` the question comes
before the wait, so the operator is not left waiting up to 10 min for it; a
removal's comes after the wait, since its plan, shown first, can only be made
once the machine is terminated. A machine already gone is asked about, with or
without `--keep`: fffactory cannot tell what took it away (an earlier
terminate, or the EC2 console, or a machine never provisioned), and deleting
the devices, or removing the host, is what is left.

## Operation record

The lock's [operation record](plan-apply.md#operation-records) is written when
the lock is taken and again at each step. Its `operation` is `worker-stop`,
`worker-start` or `worker-terminate`, and it has one stage, named `stop`,
`start` or `terminate`, which goes `locating`, then `inspecting` (the gates of
stop and terminate), `authorizing` (terminate's admin client),
`awaiting_approval` (only when asked), `stopping`, `starting` or `terminating`
(the request and the wait), then `waiting` (start's tailnet wait) or
`removing_devices` (terminate), and ends as below. Terminate removing the host
goes `planning` after `authorizing` (and after `terminating`, for a machine
already shutting down), then `awaiting_approval`, `applying` (Terraform; only
when the plan is applied), `writing` (factory.json) and `removing_devices`:

| Stage ends | Operation `status` | When |
| --- | --- | --- |
| `stopped`, `started`, `terminated` | `succeeded` | This command changed the machine's state. |
| `removed` | `succeeded` | Terminate removed the host: Terraform, factory.json and its devices. |
| `unchanged` | `succeeded` | The machine was already in, or on its way to, the target state; or, terminating with `--keep`, already gone. |
| `partial` | `partial` | Terminate: the machine is terminated, but a tailnet device remains ([Tailnet device removal](#tailnet-device-removal)); `failure` holds the summary. |
| `refused` | `refused` | No single instance, a state it refuses, a gate, terminate's admin client, the removal plan's rule, or factory.json changed before the apply. |
| `declined` | `declined` | The question was not confirmed. |
| `failed` | `failed` | EC2 refused the request or did not answer it in time, the machine vanished, the deadline passed, Terraform failed to plan or apply the removal, factory.json could not be written, or a step failed. |

The record also carries `machine`: `{"key", "hostname", "instance_id",
"state"}`, the instance once located, with its state when located, then the
state that ended the wait: the target state, the state of a machine being
terminated or gone (`absent`), or at the deadline the last state a read found.
A removal whose Terraform destroyed the instance records it `terminated`; a
terminate whose machine was already gone, with or without `--keep`, records
none.
`failure`
names why, in fffactory's words. A record whose final write fails does not
change the outcome: `The operation record could not be finished: REASON` on
standard error.

A `worker-terminate` record also carries `inspection` (D13, [epic
#94](https://github.com/yaunder/fffactory/issues/94)), so a caller can tell
from the record alone whether the gates ran and what they found:

- `forced`: whether `--force` was given;
- `document`: the worker's inspection document, exactly as `worker inspect
  --json` prints it for the same inspection ([JSON, schema version
  1](#json-schema-version-1): `key`, `hostname`, `verdict`, `not_inspected`,
  `summary`, `details`, `activity`), built by the same code
  (`workerRemovability`). It is embedded unchanged, `forced` beside it rather
  than inside, so a reader of either takes it by the same schema
  (`$defs/inspection`).

It is written once terminate knows whether its gates run and what they found,
at the step reached: for a running worker, written again at `inspecting` once
the inspection is judged, `removable` or `refused` with the gate's findings
(an interrupted inspection writes none); without the gates, at `locating`,
`not_inspected` with why: `forced` (a running worker, `--force` given),
`stopped`, `shutting_down` (a machine already being terminated, only waited
for) or `absent` (its machine already gone). The gates never run for the last
three anyway, so given `--force` they say `forced: true` beside their own
reason. A terminate refused by its machine before
that (no single instance, `pending` or `stopping`) carries none, its `failure`
naming why. Stop's record carries none: it has no work gate.

```json
{ "operation": "worker-terminate", "stages": [{ "name": "terminate", "status": "terminated" }], "inspection": { "forced": true, "document": { "key": "builder-1", "hostname": "fff-abcd1234-builder-1", "verdict": "not_inspected", "not_inspected": "forced", "summary": "--force: the worker is not inspected for busy agents, current work or checkouts.", "details": [], "activity": { "state": "unknown", "reason": null, "agents": null } } }, "...": "as every record" }
```

## Interruption

`worker` waits on an interrupt (`waitsOnInterrupt`,
[plan and apply §Interruption](plan-apply.md#interruption)): every wait goes
through the injected sleep, which an interrupt wakes, and the use cases check
the interrupt after every sleep and every call. From the interrupt on, the
command starts nothing more, writes no more of its record and keeps the lock
(`settleFactoryLock`); `fffactory` exits with 128 plus the signal's number.
An interrupt while a step is written to the record lets that write finish, then
asks nothing more of EC2; one during the final write reports the command
interrupted, whatever it reached, since the lock stays.

| Left | Message |
| --- | --- |
| No lock: interrupted before it was taken | `Interrupted before the factory was locked: it is not locked, and nothing was asked of EC2.` |
| The lock, and no record written yet | ``Interrupted: the factory stays locked by this operation, which may have no operation record. Once fffactory has exited, break the lock with `fffactory lock break`, then rerun `fffactory worker stop KEY`.`` |
| The lock and its record | ``Interrupted: the factory stays locked, with a record of this operation. Once fffactory has exited, break the lock with `fffactory lock break`, then rerun `fffactory worker stop KEY`.``, then `Operation record: s3://BUCKET/KEY` on standard output. |

Interrupted once EC2 was asked, it first says `EC2 was asked to change the
instance and may still be doing so.`: the instance goes on stopping or
starting. Terminate says instead `EC2 was asked to terminate the instance and
may still be doing so; its tailnet devices may remain: check them at
https://login.tailscale.com/admin/machines.`, and deletes no more devices; its
rerun is `fffactory worker terminate KEY --keep`, which waits for a machine
still shutting down, then deletes the devices, or, once EC2 lists the instance
`terminated` (and so no instance carries the key), takes the machine as already
gone and deletes the devices, either way asking for the typed key again ([Terminate
(keep)](#terminate-keep)). A `--keep` that timed out waiting for `terminated`
is finished by the same rerun. `fffactory worker terminate KEY`, removing the
host, waits for a machine still shutting down too, or finds it gone, then
removes the host. At the confirmation question, an interrupt wins over the
answer.

A removal interrupted while Terraform applies its plan (Terraform is stopped
gracefully, [plan-apply §Interruption](plan-apply.md#interruption)) says
`Terraform was applying the removal and may have destroyed the machine;
factory.json still declares host KEY, and the rerun finishes the removal.`: its
rerun, `fffactory worker terminate KEY`, finds the machine running, shutting
down or gone and plans again. Interrupted once factory.json is written, it
deletes no device and says `factory.json no longer declares host KEY, and
Terraform destroyed its machine; its tailnet devices may remain: check them at
https://login.tailscale.com/admin/machines.`; there is nothing to rerun, so the
lock line ends at `fffactory lock break`.

## Exit codes

| Exit | When |
| --- | --- |
| 0 | The worker is stopped, started, terminated or removed, including a no-op, and a started worker that is not ready or not online in time. |
| 1 | Refused, declined or failed. |
| 2 | Terminated or removed, but a tailnet device remains ([Tailnet device removal](#tailnet-device-removal)). |
| 128 + N | Interrupted by signal N. |

`worker inspect` has its own ([Exit codes (inspect)](#exit-codes-inspect)).

## What it never prints

AWS or SDK messages, credentials, or configuration values other than the
factory ID, a host key that passed its format check, `aws.account_id` and
`aws.region`; EC2 failures are named by error name or network code (`EC2
StopInstances failed: UnauthorizedOperation`). A `KEY` argument that is not a
well-formed host key, or a `--confirm` value that is not `KEY`, is never echoed.
Nor the Tailscale admin client's secret, its access token, any Tailscale API
answer body, or a device's tags (`tailscale.tag` could hold a pasted secret);
the secret and the token reach no record, progress line or argument. It prints
the hostnames it derived, instance IDs, EC2 states, Tailscale device IDs, and
what status prints of a worker.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/worker-lifecycle.ts` | The host key check, the one target machine, what each EC2 state means for an action (`powerStep`), the gates of stop and terminate (`stopGate`, `terminateGate`, the stopped pass, the current work and the repository result; `removalGate` judges them with the next actions `RemovalGateActions` completes, terminate's own (`terminateGateActions`), [teardown](teardown.md)'s or inspect's; terminate's inspection carries the agents it read, `TerminateInspection`), selecting the machine and judging its state with another command's rerun (`selectMachine`, `powerStep`, inspect's), the confirmation rules (y/N, the typed key, `--confirm`), the admin client's refusals, the device removal's outcome (`deviceRemovalRefusal`), the waits' bounds and steps, the words of every refusal and next action. Pure. |
| Domain | `src/domain/worker-removability.ts` | Inspect's verdict and its inspection document, free of next actions (`RemovalInspection`: removable, refused or not inspected and why, from terminate's inspection or what its machine decides, judged by `removalGate`), with a refusal's next action beside it, completed by the judging command's `RemovalGateActions` (`WorkerRemovability`, `workerRemovability`), inspect's next actions (`inspectGateActions`, `thenRerunInspect`) and its exit code (`removalExitCode`). Pure. |
| Domain | `src/domain/control-plane.ts` | `agentActivity`: a worker's agents as inspect and status report them. Pure. |
| Domain | `src/domain/work-inspection.ts` | The work inspection's document, its parser, the fixed command, and what counts as unresolved work (`workFindings`). Pure. |
| Domain | `src/domain/host-removal.ts` | Terminate's removal: factory.json without the host by own entries (`withoutHost`; the last host leaves `hosts` empty), the scoped removal rule over Terraform's JSON plan (`removalPlanRefusal`, the secret-reading policy's allowed update included), and the words of its refusals and failures. Pure; the removal plan as shown is the CLI's. |
| Domain | `src/domain/plan.ts`, `src/domain/stable-host-keys.ts` | The D11 refusal of a host removed by hand, naming `fffactory worker terminate KEY`. |
| Domain | `src/domain/tailnet.ts` | `selectWorkerDevices`: the devices terminate deletes (the reported hostname, never the MagicDNS label, and the factory's tag) and the untagged ones it reports. |
| Domain | `src/domain/operation.ts` | `startStageOperation`, `withMachine`, terminate's inspection beside `forced` (`InspectionRecord`, `withInspection`) and the lifecycle stage's statuses. |
| Domain | `src/domain/status.ts`, `src/domain/rollout.ts` | The `stopped` machine's verdict, `stopped`, and its next action, `fffactory worker start KEY`; a failed first boot's next action, `fffactory worker terminate KEY --keep --force`. |
| Application | `src/application/machine-control.ts` | The `MachineControl` port: `stop`, `start`, `terminate`, `state`. |
| Application | `src/application/tailnet-admin.ts` | The `TailnetAdmin` port: `open` (the client secret for a session), the session's `devices` and `remove`. |
| Application | `src/application/secret-store.ts` | `SecretStore.read`: the admin client's secret, as `SecretMaterial`. |
| Application | `src/application/worker-lifecycle.ts` | `stopWorker`, `startWorker`, `terminateWorker`: the order above, under the lock and its record; terminate's inspection, admin session and device deletion are `inspectForRemoval`, `openTailnetAdmin` and `deleteDevices` (`src/application/worker-removal.ts`), shared with [teardown](teardown.md), and its record's inspection is `workerRemovability`'s document (`recordInspection`); the inspection reuses `inspectRepositories`, then reads the current work with `inspectWork` (`src/application/inspect-work.ts`); its removal plans and applies over `Provisioner` (the factory root, `planInfrastructure`'s target and projection), keeps its plan file in `PlanStore`, and writes factory.json through `InstanceStore`. |
| Application | `src/application/worker-removability.ts` | `inspectRemovability`: inspect's order above, lock-free, over `inspectForRemoval` and the EC2 inventory read once; the agents through `readAgents` (`src/application/control-plane.ts`). |
| Infrastructure | `src/infrastructure/ec2-machine-control.ts` | `ec2MachineControl` over `StopInstances`, `StartInstances`, `TerminateInstances` and `DescribeInstances` (AWS SDK for JavaScript v3, imported on first use), each call within 15 s (`EC2_CONTROL_TIMEOUT_MS`), failures by error name, a request past its deadline `unanswered`. |
| Infrastructure | `src/infrastructure/aws-secrets-manager-store.ts` | `GetSecretValue` by ARN, within 30 s. |
| Infrastructure | `src/infrastructure/tailscale-api-admin.ts` | `tailscaleApiAdmin`: the token exchange, the device list and deletion over HTTPS with `fetch` (plain HTTP only to a loopback stand-in run from source), each within 15 s, no redirects, failures by HTTP status or network code; `tailscaleApiBase`, the API, or the loopback stand-in `FFFACTORY_TAILSCALE_API` names, refusing anything else unechoed. |
| CLI adapter | `src/cli/commands/worker.ts` | Arguments, progress, the removal plan (the `removal_plan` progress event carries its target, Terraform's changes and the worker, which `describeRemovalPlan` in `src/cli/presentation/plan.ts` lays out before the typed host key is asked for), the reports, Terraform's diagnostics path, the exit code; `waitsOnInterrupt`; this release's Terraform tree, materialized only when a removal runs. |
| CLI adapter | `src/cli/commands/worker-inspect.ts` | `worker inspect`'s arguments, refusals, report, `--json` document (`inspectionJson`, `WORKER_INSPECTION_SCHEMA_VERSION`, published as `schemas/worker-inspection.schema.json`) and exit code; its report and its refusal of a `KEY` (`keyRefusalReport`) laid out by `src/cli/presentation/worker-inspection.ts`, each worker's agents by `src/cli/presentation/agents.ts`. |

Tests: `tests/domain/worker-lifecycle.test.ts` (the host key check, an argument
never echoed, the one machine, every state for each action, each gate, a
worker missing from the tailnet refused with stop's own next action, the
confirmation rule and question, the waits' steps and failures, a request
refused or unanswered),
`tests/application/worker-lifecycle.test.ts` (a stop recorded step by step;
busy agents, an offline worker, unreadable activity, a worker on a release from
before agent states and no control plane refused, and `--force` overriding
them; only finished, failed or stopped agents stopping it; undeclared key, incomplete
factory.json, another account, a pin mismatch, a held lock, and none or several
instances refused before any EC2 mutation; no-ops never calling EC2's mutating
API; start waiting for running and the tailnet, then reporting readiness, a
stale release naming `fffactory apply`, a worker not online in time and a
tailnet refusal reported at once; a request unanswered in time; the record's
last state at the deadline or a vanished machine; confirmation asked, declined
and refused without a terminal; an interrupt before the lock, during each
wait, at the question, right after the lock, while the request's stage is
written and while the final record is written),
`tests/infrastructure/ec2-machine-control.test.ts`
(stubbed calls, deadlines, unknown and absent states, and the real SDK against
`tests/support/stub-ec2-instances.ts`), and `tests/cli/worker.test.ts` (the
reports and exit codes, AWS's message never printed, an argument that is not a
key never echoed, a missing worker's stop refusal, the arguments and help).

Terminate: `tests/domain/worker-lifecycle.test.ts` (each state, the wait for
`terminated` or `absent`, no instance taken as a machine gone only to
terminate and never from an unreadable inventory, each gate and the stopped
pass, the typed key and `--confirm`, the question for a `--keep` whose machine
is gone or already being terminated, and for a removal whose machine was, the
admin client's refusals, the device removal's outcome) and
`tests/domain/tailnet.test.ts` (tagged devices with the hostname selected,
untagged ones reported, the tag compared exactly);
`tests/domain/work-inspection.test.ts` (the document, its parser and limits, what
is unresolved and what uninspected), `tests/host/work.test.ts` (the worker's
inspection over real Git repositories: clean, untracked, ignored only, tracked
and staged changes, ahead of the upstream, a branch without one, a stash, a merge
in progress, a dirty Paseo worktree, one whose directory is gone, one of a
repository kept elsewhere, no remote at all, an unreadable `.git`, no symbolic
link followed, nothing written: no index refresh, lock file or fetch; the time
budget), `tests/application/inspect-work.test.ts` (every transport outcome and
activator exit, an answer for another worker, never quoted),
`tests/application/worker-lifecycle.test.ts` (a terminate recorded step by step;
the admin client missing, an undeclared key, another account, a pin mismatch, a
held lock, a wrong `--confirm`, a wrong typed key, an unreadable secret and a
refused client, all before any mutation; each gate refused and `--force`
overriding it; a stopped worker passing uninspected; the record's inspection,
identical to `worker inspect`'s document for the same world: removable,
refused by busy agents, unpushed work or the tailnet, written again at
`inspecting`; forced, `not_inspected` and never `inspecting`; stopped,
shutting down or gone, with `--force` or without; none for a machine refused
before the gates or in stop's record; a final write that fails leaving the
refusal and the inspection already written; a machine already
shutting down waited for once the typed key, asked before the wait, or
`--confirm`, confirms it, declined or a wrong key deleting no device, and
refused without a terminal; a worker whose only agents are finished terminated
without `--force`, its work still inspected; work made since the last
synchronization refused,
with and without `--keep`, `--force` terminating it all the same; work that could
not be inspected (an older activator, a timeout, a malformed answer, an unreadable
worktree) refused; the work asked only once the activity is read, and not at all
once interrupted; a machine already gone: no gates and no EC2 call,
its devices deleted after the typed key, `unchanged` or partial, the admin
client still required, an unreadable inventory refused, and an interrupted
`--keep` finished by its rerun; only tagged devices deleted, an untagged one
reported, a deletion or listing failure leaving the terminate partial; the
secret in no record, progress or result; status reporting the host not
provisioned afterwards; an interrupt during the wait and between deletions),
`tests/infrastructure/tailscale-api-admin.test.ts` (against
`tests/support/stub-tailscale-api.ts`: the token request with its placeholder
client ID, the listing and deletion, 404 as deleted, an unusable ID never in a
URL, a non-client secret refused without a request, failures by status with no
body, secret or token, the deadline, an expired token renewed once (only on
HTTP 401) and the call retried, a redirect refused with its target never
asked; the API, or the loopback stand-in `FFFACTORY_TAILSCALE_API` names, and
anything else refused unechoed; `tests/cli/main.test.ts` for the refusal before
any command runs), the Secrets Manager read in
`tests/infrastructure/aws-secrets-manager-store.test.ts`, and the terminate
reports, exit 2, an unechoed `--confirm`, unpushed work refused with where it is and
forced, an older activator's refusal and its next action, a worker's answer never printed, a machine already being terminated:
the typed key asked, a decline deleting no device, `--confirm` unasked and no
terminal refused, and a machine already gone, its
devices deleted with exit 0 or 2 and an interrupted `--keep`'s rerun finishing
it, in `tests/cli/worker.test.ts`.
That the next plan creates a terminated worker afresh is
`tests/domain/plan.test.ts` (`a worker terminated outside fffactory plans as a
create`).

Terminate (remove): `tests/domain/host-removal.test.ts` (the host removed by
own entries, the last host leaving a valid and complete empty factory, the scoped removal rule: only the named
delete passes, and extra creates, updates, other deletes, replaces, unknown
actions and an unreadable plan fail closed; a plan that does not destroy the
machine EC2 lists, or destroys one it does not; the policy update dropping
exactly the removed Paseo password and any other policy change refused; the
failures' words); `tests/cli/presentation/plan.test.ts` (the plan as shown);
`scripts/terraform-check.ts` with `scripts/terraform-removal-check.ts` and
`scripts/terraform-state-fixture.ts` (the rule against Terraform's real
removal plans from synthesized fixture states: a host with its own password,
one sharing one, and the last host allowed, each plan exactly the
removal's changes; another instance listed, none listed, and another host's
instance type or Paseo password, or the network's change, planned together
refused);
`tests/application/worker-lifecycle.test.ts` (a removal recorded step by step,
its plan file removed, factory.json written by `InstanceStore`; afterwards the
infrastructure plan shows no change and status no longer lists the host;
another pending change refused before the question; the last host removed, its
Paseo password dropped from the policy, which keeps the enrollment key alone,
and the network kept; the empty factory planning no host and no change, and
status listing none; a replacement declared under a new key or the removed one,
with another instance type, applied as a plain create; the typed key asked after the plan; factory.json changed before the
apply; a machine already being terminated asked about after the wait and the
plan, saying so, and declined changing nothing; a failed plan or apply leaving factory.json untouched with its
diagnostics file, never in the record; factory.json that cannot be written,
then a rerun finishing; a machine already gone, or being terminated; a state
still recording the key applied and checked; the gates; a device left behind;
an interrupt during Terraform's apply and after the write); and
`tests/cli/worker.test.ts` (the plan and reports, a refused plan, Terraform's
diagnostics path, a machine already gone, the last host removed and the empty
factory validated, planned and reported, then a replacement of another size
planned as a create, both interruptions).
The D11 refusal of a host removed by hand naming the command:
`tests/domain/stable-host-keys.test.ts`, `tests/domain/plan.test.ts`,
`tests/cli/presentation/plan.test.ts` and `tests/cli/plan-apply.test.ts`.

Inspect: `tests/domain/worker-removability.test.ts` (each verdict and reason,
terminate's own summary and details for the same inspection, inspect's next
actions, a refused machine's rerun, the exit code; a release from before
agent states replaced, keeping its host, where terminate's own next action
follows what was typed; a stopped, forced, shutting-down or absent machine not
inspected; the same document whichever command's next actions judge it), `tests/domain/control-plane.test.ts`
(`agentActivity`), `tests/application/worker-removability.test.ts` (every
declared worker in order, or KEY alone; a removable worker with its finished
agents; busy agents refused, the work never asked for; unpushed work, and a
placed checkout the inspection does not report, refused; no control plane or
a worker missing from the tailnet refused; shutting down or gone not inspected,
pending refused, a stopped one never asked anything; an unreadable inventory
refusing each worker; an undeclared KEY and an incomplete factory.json refused
before AWS, another account before the inventory; an interrupt),
`tests/cli/presentation/worker-inspection.test.ts` and
`tests/cli/presentation/agents.test.ts` (the report as laid out, each state's
agents labelled in the count's words, a worker's own words as data, the
refusal of a `KEY`), and `tests/cli/worker.test.ts` (the report, exit 0 and 2,
no lock taken and nothing changed, the next action repeating `--instance`, a
stopped worker, `--json` against the schema and its conditions, a next action
exactly when refused and none inside the inspection document, the activity
definition shared with status's schema, a release other than the one
factory.json pins, an interrupt, the refusals with exit 1, a pasted argument
never echoed, the usage, its refusals, lock and exit codes those of stop, start
and terminate).

Introduced by [#6](https://github.com/yaunder/fffactory/issues/6); terminate
`--keep` by [#9](https://github.com/yaunder/fffactory/issues/9); terminate
removing the host by [#10](https://github.com/yaunder/fffactory/issues/10); the
credential references it leaves as they are by
[#68](https://github.com/yaunder/fffactory/issues/68); inspect by
[#101](https://github.com/yaunder/fffactory/issues/101).
