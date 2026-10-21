# Teardown

Teardown removes a whole factory: everything it owns, under the existing
safety rules, and nothing it only refers to. Epic:
[#56](https://github.com/yaunder/fffactory/issues/56), decisions D1 to D13.
This spec covers the use case with a state bucket present
(`teardownFactory`, `src/application/teardown-factory.ts`), its happy path and
its refusals. Partial failure, rerun and interruption follow in
[#86](https://github.com/yaunder/fffactory/issues/86), the cleanup without a
state bucket in [#87](https://github.com/yaunder/fffactory/issues/87), and the
`fffactory teardown [--confirm FACTORY_ID] [--instance PATH] [--profile NAME]`
command, its output and exit codes in
[#88](https://github.com/yaunder/fffactory/issues/88).

| Removed | How |
| --- | --- |
| Every worker's EC2 instance and root volume, the network, IAM and everything else the `factory` root's Terraform state holds | The guarded destroy plan ([provisioning §Destroy plan](provisioning.md#destroy-plan)) |
| The factory's tailnet devices | The Tailscale API, as the factory's admin client ([Devices](#devices)) |
| The secrets the factory owns | Deleted without a recovery window, their absence confirmed ([secrets §Deleting a factory's secrets](secrets.md#deleting-a-factorys-secrets)) |
| Dispatch's Paseo schedules | Stopped first ([dispatch §Stopping dispatch](dispatch.md#stopping-dispatch)), then gone with the machines |
| The operator's local saved plans for the factory | `<cache>/plans/<factory ID>/` removed (`PlanStore.removeAll`) |
| The state bucket: the Terraform state, the lock, the operation records and the break log | Deleted last ([provisioning §Deleting the state bucket](provisioning.md#deleting-the-state-bucket)) |

Kept: every secret factory.json only refers to (a harness `fffv/*` source, one
made by hand), tagged secrets the factory does not own, tailnet devices that
are not provably the factory's, the Tailscale OAuth client and auth key
themselves, and factory.json, which teardown never writes (D11).

## Order

Teardown goes in this order, and stops at the first refusal:

1. Refuse without a terminal and without `--confirm`: `Removing a factory needs
   your confirmation: rerun at a terminal, or pass --confirm FACTORY_ID.`
   (`TEARDOWN_UNCONFIRMABLE`).
2. Refuse unless factory.json is complete (each missing field listed), then
   without `tailscale.admin_client_secret`: `factory.json has no Tailscale admin
   client (tailscale.admin_client_secret): teardown deletes the factory's
   tailnet devices with it`, next action ``Store it with `fffactory secret set
   tailscale-admin-client`, then rerun `fffactory teardown`.``. Then refuse a
   `--confirm` that is not the factory ID ([Confirmation](#confirmation)).
3. The account check: the caller must be in `aws.account_id`
   ([doctor §AWS account](doctor.md#aws-account)).
4. The [CLI/pin match guard](plan-apply.md#clipin-match-guard): only the
   release factory.json pins may remove the factory.
5. The state bucket: missing is the [no-bucket mode](#no-state-bucket); one
   without every setting backend bootstrap applies is refused as `plan`
   refuses it (`unready_bucket`). Teardown never creates a bucket.
6. Take the factory-wide lock as operation `teardown`, and open its
   [operation record](#operation-record). A held lock refuses teardown and
   shows its holder; it is never broken ([provisioning §Lock](provisioning.md#lock)).
7. Open the Tailscale admin session (`openTailnetAdmin`, as `worker terminate`
   does, [worker lifecycle §Tailnet device removal](worker-lifecycle.md#tailnet-device-removal)):
   a secret that cannot be read, or a client Tailscale does not accept, refuses
   teardown before anything is listed.
8. The inventory: the factory's tagged instances in every state but
   `terminated` and its tagged VPCs (EC2,
   [provisioning §Tagged VPCs](provisioning.md#tagged-vpcs)), its tagged secrets
   ([secrets §Listing](secrets.md#listing)) and the tailnet's devices. A
   listing that fails refuses teardown, naming it
   ([Refusals](#refusals)). A worker whose machine is `pending` or `stopping`
   refuses it too, before anything is asked.
9. The guarded destroy plan: `plan -destroy` of the `factory` root under
   Terraform's state lock, with factory.json projected with the host keys the
   state records, into a plan directory of its own, judged by
   `destroyPlanRefusal` over the instances the inventory listed
   ([provisioning §Destroy plan](provisioning.md#destroy-plan)), and refused
   when Terraform's `-detailed-exitcode` and its JSON plan disagree
   (`destroyPlanMismatch`): changes reported with no resource change, or
   resource changes with none reported.
10. Show what will be removed and kept (`TeardownReview`, the `review`
    progress event): the target (factory.json's path, the factory, its account,
    Region and release), the destroy plan's changes, the instances and VPCs,
    the devices to delete and those only listed, the owned secrets and the kept
    ones, and the state bucket.
11. The [confirmation](#confirmation).
12. Stop dispatch on every running worker the tailnet locates
    ([Gates](#gates)), recording each outcome.
13. The [gates](#gates): EC2's instances listed again, refused unless they
    are as reviewed, then one fresh inspection of each running worker.
14. Apply exactly the saved destroy plan, unless it changes nothing (the
    `factory` root already gone).
15. Verify that nothing tagged with the factory ID remains: EC2 lists no
    instance and no VPC. Anything left, or a listing that fails, stops the run
    before devices, secrets and the bucket (D12).
16. Delete the [devices](#devices), listed afresh.
17. Delete the owned secrets, each confirmed absent
    ([secrets §Deletion and absence](secrets.md#deletion-and-absence)), the
    admin client among them, only after the devices.
18. Remove the local saved plans, `<cache>/plans/<factory ID>/`.
19. Delete the state bucket (`LockStore.deleteBucket`), which deletes the
    lock and the operation record with it.
20. Report what was removed and kept ([Report](#report)).

Steps 1 to 5 reach nothing that could change: refusals there take no lock and
write no record. From step 6 every refusal and decline is recorded and releases
the lock. Nothing is deleted before step 14, and nothing is asked of a worker
before step 12.

## Gates

D3 and D4. Once confirmed, teardown first stops dispatch on every running
worker, then inspects each once, freshly, with terminate's gates
([worker lifecycle §Gates (terminate)](worker-lifecycle.md#gates-terminate)),
so no agent dispatch could start is missed by the inspection:

1. **Dispatch.** The tailnet's view is read once; each running worker (EC2
   `running`, with a well-formed host key tag) it locates gets its
   not-requested projection (`stopDispatch`). A stop that fails refuses
   teardown: `Dispatch could not be stopped on HOSTNAME: REASON`. A worker the
   tailnet does not locate is left to the inspection, which refuses it.
2. **Unchanged machines.** Changed live state invalidates the review: the
   running and stopped workers the gates judge are those EC2 listed before the
   confirmation, so a worker started while the question waited would otherwise
   be destroyed uninspected. Once dispatch is stopped, EC2's tagged instances
   are listed again (`machinesChanged`), and any instance gone, new, in another
   state or with another host key tag than reviewed refuses teardown: `The
   factory's EC2 instances changed after they were reviewed`, each change
   listed (`EC2 instance ID of HOSTNAME: running, reviewed stopped`, `... no
   longer listed`, `... (STATE): not reviewed`, `... its host key tag
   changed`; `of HOSTNAME` only for a well-formed key), next action ``Rerun
   `fffactory teardown` to review the factory as it is now.`` A listing that
   fails refuses as the inventory's does. Nothing is deleted, the lock is
   released, and dispatch stays stopped where it was, for `fffactory apply` to
   restart.
3. **Inspection.** Each running worker's agent activity and last repository
   result, then its current work (`inspectForRemoval`, shared with terminate),
   judged by `removalGate`: active agents, work not pushed to any remote,
   unresolved or unmanaged checkouts, and a worker that cannot be located or
   inspected each refuse, naming the worker, in terminate's words. Every
   running worker is inspected, and every refusal reported.

A `stopped` worker passes uninspected, as with terminate (**accepted risk**:
unpushed work on its disk is not reported, and is destroyed with it). A
machine `shutting-down` is already being terminated and is neither stopped nor
inspected; one `pending` or `stopping` is refused before the confirmation,
`EC2 instance ID of HOSTNAME is pending`, next action ``Wait until it is
running, then rerun `fffactory teardown`.`` (`Wait until it has stopped` for
`stopping`).

Teardown has no `--force`. A gate's next action reruns teardown, or removes
the worker first, uninspected (`teardownGateActions`):

| Gate | Next action |
| --- | --- |
| Active agents, unpushed work, unresolved checkouts | ``STEP, then rerun `fffactory teardown`. To remove the worker anyway, run `fffactory worker terminate KEY --force` first.`` |
| Activity, checkouts or work that could not be inspected | The same, `uninspected` for `anyway` |
| Not located in the tailnet | ``Check the worker with `fffactory status`, then rerun `fffactory teardown`. If it cannot be inspected, remove it uninspected: run `fffactory worker terminate KEY --force`, then rerun `fffactory teardown`.`` |
| Unmanaged checkouts, or an older activator checked by hand | ``... then terminate it with --force: `fffactory worker terminate KEY --force`, and rerun `fffactory teardown`.`` |

A running worker whose key factory.json does not declare cannot be terminated
with `fffactory worker terminate`: its next actions name the EC2 console
instead, `terminate EC2 instance ID in the EC2 console`.

A refusal here leaves dispatch stopped on the workers it was stopped on, and
the result names them (`dispatchStopped`): `fffactory apply` restarts it
(`dispatchLeftStopped`).

## Devices

D9. The tag (`tailscale.tag`) is shared between factories, so a device's
reported hostname tells whose it is (`selectFactoryDevices`,
`src/domain/teardown.ts`):

1. For each known key, declared in factory.json, recorded in the Terraform
   state or carried by an EC2 instance's host key tag (each well-formed key
   once), the devices `selectWorkerDevices` finds for `<id>-<key>`: the
   reported hostname exactly, ignoring case, never the MagicDNS label. Those
   carrying the factory's tag are deleted; the others are listed.
2. Every other device whose hostname, lowercased, is in the factory's namespace
   (`<id>-` and at least one more character): with the factory's tag, deleted
   when the factory ID is generated (`fff-` and eight lowercase letters or
   digits, `isGeneratedFactoryId`), only listed for a hand-chosen ID; without
   it, only listed. Devices shown are devices deleted: when they are deleted,
   such a device is deleted only if the review showed it deleted (by its device
   ID); one that appeared since is listed as possibly this factory's
   (`possible`), never deleted unseen. Step 1's exact names are the factory's
   whenever they appear, and are deleted.

| Factory | Device | Is |
| --- | --- | --- |
| `fff-abcd1234`, key `builder-1` | `fff-abcd1234-builder-1`, or `FFF-ABCD1234-Builder-1`, tagged | deleted |
| `fff-abcd1234` | `fff-abcd1234-stray`, tagged | deleted: no other generated ID extends `fff-abcd1234` |
| `acme`, key `builder-1` | `acme-builder-1`, tagged | deleted |
| `acme` | `acme-lab-builder-1`, tagged | listed, not deleted: possibly `acme-lab`'s |
| Any | A matching hostname without the factory's tag | listed, never deleted |
| `acme` | `acmelab-builder-1` | not the factory's: neither |

The devices are listed before the confirmation, for the review, and again when
they are deleted, after the destroy and the leftover check (the reviewed device
IDs bounding step 2's deletions); each is deleted by
its ID, one at a time, as terminate deletes them (`deleteDevices`), a device
already gone counting as deleted. A listing or deletion that fails stops the
run with the secrets and the bucket kept, the admin client among them.

**Accepted risk:** a hand-chosen ID that extends a generated one
(`fff-abcd1234-lab`) shares its namespace; `fff-abcd1234`'s teardown deletes
its tagged devices that match no known key of `fff-abcd1234`.

## Confirmation

D2. Teardown is confirmed by naming the factory, never by y/N:

- At a terminal, without `--confirm`, once the review is shown, teardown asks
  `Remove factory ID and everything it owns? Its workers, network, IAM,
  Terraform state, tailnet devices, owned secrets and state bucket are deleted,
  and none can be recovered. Type the factory ID to confirm: `. Only the
  factory ID itself, exactly (blank space around it aside), confirms; anything
  else, or no answer, declines: recorded `declined`, nothing removed, dispatch
  not stopped, the lock released. A wrong answer is never echoed.
- `--confirm FACTORY_ID` confirms without asking; the review is still shown.
  Any other value refuses before anything reaches AWS, never echoed:
  `--confirm does not name the factory ID`, next action ``Pass --confirm ID to
  remove it, or type the factory ID when asked at a terminal.``
- Without a terminal and without `--confirm`: refused first
  ([Order](#order), step 1).

The question comes after the inventory and the guarded destroy plan, which
refuse first: a teardown that would be refused there is never asked about.

## Refusals

Every refusal deletes nothing. One under the lock is recorded `refused` and
releases the lock. Each is a summary, details and a next action
(`src/domain/teardown.ts`); several gates may refuse at once, each listed
(`refusals`).

| Refused | Summary | Next action |
| --- | --- | --- |
| No terminal, no `--confirm` | `Removing a factory needs your confirmation: ...` | (in the summary) |
| Incomplete factory.json | each missing field | Complete factory.json |
| No admin client | `factory.json has no Tailscale admin client ...` | ``Store it with `fffactory secret set tailscale-admin-client`, then rerun `fffactory teardown`.`` |
| Wrong `--confirm` | `--confirm does not name the factory ID` | ``Pass --confirm ID ...`` |
| Another account, a pin mismatch | as every command words them ([plan and apply](plan-apply.md#before-anything-reaches-aws)) | |
| Held lock | the holder, as `plan` shows it | never broken: wait for the holder, or `fffactory lock break` for an operation confirmed dead |
| Admin client unreadable | the error, by name | the `secretsmanager:GetSecretValue` permission, then rerun |
| Admin client refused | `The Tailscale admin client could not be used: REASON` | the OAuth client (scope `devices:core`), then rerun |
| EC2 instances, VPCs or secrets cannot be listed | the listing's own failure, such as `EC2 DescribeVpcs failed: UnauthorizedOperation` | the permission (`ec2:DescribeInstances`, `ec2:DescribeVpcs`, `secretsmanager:ListSecrets`), then rerun |
| The tailnet's devices cannot be listed | `The tailnet's devices could not be listed: REASON` | the OAuth client, then rerun |
| A worker's machine `pending` or `stopping` | `EC2 instance ID of HOSTNAME is STATE` | wait, then rerun |
| The state records unreadable host keys | `The host keys the factory's Terraform state records could not be read` | ``Check the factory's Terraform state with `fffactory plan`, then rerun `fffactory teardown`.`` |
| factory.json cannot be projected | `factory.json cannot be projected into the destroy plan's Terraform inputs`, each issue listed | Fix factory.json, then rerun |
| The guarded destroy plan | [provisioning §Destroy plan](provisioning.md#destroy-plan)'s three refusals | as there |
| Exit code and JSON plan disagree | `Terraform's destroy plan reports changes, but its JSON plan changes no resource` (or `reports no change, but its JSON plan changes resources`) | ``Check the factory's Terraform state with `fffactory plan`, then rerun `fffactory teardown`.`` |
| Declined | (declined, not refused) | |
| Dispatch not stopped | `Dispatch could not be stopped on HOSTNAME: REASON` | as an uninspected gate's |
| EC2's instances changed since the review | `The factory's EC2 instances changed after they were reviewed`, each change listed ([Gates](#gates)) | ``Rerun `fffactory teardown` to review the factory as it is now.`` |
| EC2's instances cannot be listed again | the listing's own failure | as the inventory's |
| A gate | terminate's words, naming the worker ([Gates](#gates)) | [Gates](#gates) |

A listing that fails says `Nothing was removed: a listing that failed is never
taken for one that found nothing.`: an empty EC2 listing would read as no
instance the destroy plan may delete, and every one of its instance deletes
would be refused for the wrong reason; an empty secrets or devices listing
would read as nothing to remove.

Terraform failing to plan the destroy fails teardown (`Planning the factory's
destruction failed: REASON`, `Nothing was removed.`), recorded `failed`, with
the private diagnostics file's path, never Terraform's output.

What stops the run once the destroy was applied, or while it was, is
`partial`: the destroy failing, anything tagged left after it, a device, secret
or the bucket left behind. Each says what was kept; reporting what remains of
each kind, and finishing it on a rerun, are
[#86](https://github.com/yaunder/fffactory/issues/86)'s.

## Operation record

The lock's [operation record](plan-apply.md#operation-records) is written when
the lock is taken and again at each step. Its `operation` is `teardown`, and
it has one stage, `teardown`, which goes `authorizing`, `inventorying`,
`planning`, `awaiting_approval` (only when asked), `stopping_dispatch` (written
again with `dispatch` once each running worker's dispatch is stopped:
`not_requested`, or `failed` with its reason), `inspecting`, `applying`,
`verifying`, `removing_devices`, `removing_secrets`, `removing_plans` and
`deleting_bucket`. It ends `refused`, `declined`, `failed` or `partial`, with
the operation's status alike and `failure` naming why.

A teardown that finished has no record: deleting the bucket deletes the record
with the lock, so nothing is written, and the lock is not released, once the
bucket is gone (`LockStore.deleteBucket` answers `absent`). Writing either
would answer `NoSuchBucket` and turn the success into a failure. When the
bucket remains with the lock `held`, the record is finished `partial` and the
lock released. Once the lock's own versions were being deleted (`unknown`,
`deleted`), nothing more is written into the bucket, and the lock is released
by its version, which is harmless either way.

## Report

D11. A finished teardown reports (`TeardownReport`):

- `infrastructure`: `destroyed`, or `absent` when the destroy plan changed
  nothing, the `factory` root already gone; the resources destroyed, and the
  instances EC2 listed before (`ShownMachine`: its host key only when
  well-formed, a malformed tag only marked, `malformedHostKey`);
- the devices deleted, by ID, and those listed but kept (`possible`,
  `untagged`), each by ID and the hostname teardown derived, `<id>-<key>`,
  when its reported hostname is that for a well-formed key (`ShownDevice`);
- the owned secrets deleted, and the kept ones in three groups
  (`keptSecrets`): tagged with the factory ID but not owned (by name and ARN,
  never their tags); referenced by
  factory.json outside the factory's names (such as `fffv/*`); and referenced
  under `<id>/` but not listed with the factory's tag (`unlisted`). The last
  are reported apart, never as kept: they may already be gone, as on a rerun,
  or were never tagged. A reference to a tagged secret is listed once, with
  it;
- the state bucket deleted.

With it, the advice teardown leaves the operator (`FACTORY_JSON_KEPT`,
`REVOKE_SOURCES`, `CHECK_LISTED_DEVICES`): factory.json is left as it is;
teardown revokes nothing it only refers to (the Tailscale auth key and admin
OAuth client, and the API credentials kept), which the operator revokes at
their providers once nothing else uses them; and the devices listed but not
deleted are the operator's to check.

## No state bucket

D10. Teardown never bootstraps a bucket: a missing one ends the use case
(`no_bucket`) before any lock. Cleaning up devices and owned secrets without
the lock when EC2 lists nothing tagged is
[#87](https://github.com/yaunder/fffactory/issues/87)'s.

## What it never prints

As `worker terminate`: no AWS or SDK message, credential, Terraform output,
Tailscale answer body, token or secret, and no configuration value but the
factory ID, well-formed host keys, `aws.account_id` and `aws.region`, and what
`plan` already shows of factory.json: its `name` and path (the review's
target), `state_backend.bucket` (the review, the report, the `deleting_bucket`
progress event and `bucketRemains`), and the secret references it holds
(validated ARNs, kept and listed). A
`--confirm` value or typed answer that is not the factory ID is never echoed,
nor a device's tags, a device's reported hostname teardown did not derive, a
secret's tags, or an EC2 host key tag that is not a well-formed key: the review
and the report (`TeardownReview`, `TeardownReport`) do not carry them
(`ShownMachine`, `ShownDevice`, `ShownSecret`). It prints instance IDs, EC2
states, VPC IDs, Tailscale device IDs, the hostnames it derived and secret
names.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/teardown.ts` | The guarded destroy plan's rule and its consistency with the exit code (`destroyPlanRefusal`, `destroyPlanMismatch`), `VpcInventory`; the devices teardown deletes and lists (`selectFactoryDevices`, `FactoryDevices`); the kept secrets' groups (`keptSecrets`); the confirmation rule (`teardownConfirmation`, `typedIdConfirms`) and question; the gates' next actions (`teardownGateActions`) and the review invalidated by changed machines (`machinesChanged`); the review and report (`TeardownReview`, `TeardownReport`), carrying only what may be printed (`ShownMachine`, `ShownDevice`, `ShownSecret`); the words of every refusal and of the report's advice. Pure. |
| Domain | `src/domain/initialization.ts` | `isGeneratedFactoryId`. |
| Domain | `src/domain/worker-lifecycle.ts` | `removalGate` and `RemovalGateActions`: terminate's gates, their next actions completed by the command refused. |
| Domain | `src/domain/operation.ts` | `TEARDOWN_OPERATION` and the teardown stage's statuses. |
| Domain | `src/domain/secrets.ts` | `classifySecrets` and `refersTo`. |
| Application | `src/application/teardown-factory.ts` | `teardownFactory`: the order above, under the lock and its record, the lock and record never touched once the bucket is gone. |
| Application | `src/application/worker-removal.ts` | Shared with `worker terminate`: `inspectForRemoval`, `openTailnetAdmin`, `deleteDevices`. |
| Application | `src/application/stop-dispatch.ts`, `src/application/delete-owned-secret.ts` | `stopDispatch`, `deleteOwnedSecret`. |
| Application | `src/application/plan-store.ts` | `PlanStore.removeAll`. |
| Application | `src/application/lock-store.ts`, `src/application/provisioner.ts`, `src/application/machine-inventory.ts` | `LockStore.deleteBucket`, `PlanRequest.destroy`, `MachineInventorySource.listVpcs`. |
| Infrastructure | `src/infrastructure/plan-store.ts` | `removeAll`: the factory's plan directory, removed whole. |

Tests: `tests/domain/teardown.test.ts` (device selection: known keys exactly
and ignoring case, untagged look-alikes listed, a generated ID's other tagged
devices deleted and a hand-chosen ID's only listed, `acme` against
`acme-lab`, a malformed key ignored, what a generated ID is; the confirmation
rule, the typed ID, the mismatch never echoing its value; the gates' next
actions, for a declared worker and an undeclared one; the kept secrets'
groups; the destroy plan's consistency with its exit code; once reviewed, a
namespace device not shown only listed; `machinesChanged`; the shown machines
and devices carrying no tag and no malformed host key),
`tests/application/teardown-factory.test.ts` (a factory with no worker, one
running worker, and two with one stopped, each ending with no instance,
network, state, device, owned secret, plan or bucket, its referenced sources
kept, and nothing written or released after the bucket's deletion; the record
step by step; the review and the typed ID at a terminal; dispatch stopped on
every running worker before the first inspection; a `fffv/*` source and a
tagged secret kept; D9's devices; a device appearing after the review listed,
not deleted; no device tag or malformed host key tag in the review or report;
a root already absent; a saved plan's removal never failing a finished
teardown; and each refusal
deleting nothing and leaving the lock released: a held lock, active agents,
unmanaged checkouts, a worker not located, dispatch not stopped, a machine
started, added or gone since the review, or not listed again, the guarded
destroy plan, its exit code disagreeing, each listing that fails, the admin
client refused, a machine pending, a decline, a wrong `--confirm`, no terminal,
no admin client, an incomplete factory.json, another account, a pin mismatch,
no bucket; and once destroyed, a leftover stopping the run before devices,
secrets and the bucket, and a bucket that remains, recorded `partial`), and
`tests/infrastructure/plan-store.test.ts` (`removeAll`). terminate's own tests
(`tests/application/worker-lifecycle.test.ts`) cover the shared helpers.

Introduced by [#85](https://github.com/yaunder/fffactory/issues/85), on the
building blocks of [#81](https://github.com/yaunder/fffactory/issues/81),
[#82](https://github.com/yaunder/fffactory/issues/82),
[#83](https://github.com/yaunder/fffactory/issues/83) and
[#84](https://github.com/yaunder/fffactory/issues/84).
