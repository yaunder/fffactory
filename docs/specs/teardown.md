# Teardown

Teardown removes a whole factory: everything it owns but its log archive,
under the existing safety rules, and nothing it only refers to. Epic:
[#56](https://github.com/yaunder/fffactory/issues/56), decisions D1 to D13.
This spec covers the use case (`teardownFactory`,
`src/application/teardown-factory.ts`): with a state bucket, its happy path,
its refusals, a [partial failure](#partial-failure), the [rerun](#rerun) that
finishes it and an [interruption](#interruption); and the cleanup without a
lock when there is [no state bucket](#no-state-bucket); and the
[command](#command) that runs it, its [output and exit
codes](#output-and-exit-codes) and the [permissions](#permissions) it needs.

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
themselves, the log archive when factory.json enables it ([instance
configuration §Log archive](instance-configuration.md#log-archive)), and
factory.json, which teardown never writes (D11).

fffactory never removes the log archive. Teardown never touches the `archive`
root and asks AWS nothing about the archive: it names it from factory.json
alone (`archiveBucketName`), so its words hold whether or not the archive was
ever created, and says it is kept wherever it says what it keeps: the
question, the review, the report and the advice (`archiveKept`: `Log archive
NAME is kept; fffactory never removes it.`). A factory applied again from the
same factory.json adopts it
([provisioning §Log archive readiness](provisioning.md#log-archive-readiness)).
Whether the archive exists is not checked. Teardown deletes the state bucket,
so factory.json's `state_backend.bucket` may never name the archive: validation
refuses the archive's derived name there, whether or not the archive is
enabled, before teardown reads anything of AWS ([instance configuration §State
bucket](instance-configuration.md#state-bucket)). Evidence a worker had not yet
archived is lost with it: teardown previews each worker's in the review,
before the confirmation, says it again once the [gates](#gates) have inspected
them, before anything is destroyed, and in the [report](#report), and never
refuses over it ([Unarchived evidence](#unarchived-evidence)).

## Command

```text
fffactory teardown [--confirm FACTORY_ID] [--instance PATH] [--profile NAME]
```

D1. A top-level command (`src/cli/commands/teardown.ts`), admin-tier
([worker lifecycle §Tiers](worker-lifecycle.md#tiers)): it destroys every
machine, the network and IAM, deletes the factory's secrets and state bucket,
and uses the factory's Tailscale admin client, which can delete any device in
the tailnet. Its credentials need what [Permissions](#permissions) lists.

- `--confirm FACTORY_ID` confirms in advance ([Confirmation](#confirmation));
  `--instance PATH` selects factory.json as every command does; `--profile
  NAME` the AWS profile, otherwise `AWS_PROFILE`, or else the standard AWS
  credential chain. An empty `--profile` is refused: `fffactory teardown:
  --profile needs a profile name`.
- Anything else is refused before anything is read, never echoed, since an
  argument meant for `--confirm` could be a pasted secret: `fffactory teardown
  takes only --confirm FACTORY_ID, --instance PATH and --profile NAME.` A
  `--force` among them is told instead that ``fffactory teardown has no
  --force: remove a worker it refuses with `fffactory worker terminate KEY
  --force` first.`` (D4).
- It is guarded by the [CLI/pin match guard](plan-apply.md#clipin-match-guard),
  after the account check and before the state bucket is asked anything.
- It checks its interrupt and reports what the interrupt left, so `fffactory`
  waits for it to return (`waitsOnInterrupt`,
  [plan and apply §Interruption](plan-apply.md#interruption)).
- It has no `--json` yet: its result is human text. The marker
  `TODO(re-evaluate when a caller must parse teardown's result)` in
  `src/cli/commands/teardown.ts` records the gap.

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
5. The state bucket: one S3 does not find (404) is the
   [no-bucket mode](#no-state-bucket), which takes no lock; one without every
   setting backend bootstrap applies is refused as `plan` refuses it
   (`unready_bucket`); one S3 answers 403 for is refused, never taken for the
   factory's ([Rerun](#rerun)). Teardown never creates a bucket.
6. Take the factory-wide lock as operation `teardown`, and open its
   [operation record](#operation-record). A held lock refuses teardown and
   shows its holder; it is never broken ([provisioning §Lock](provisioning.md#lock)).
7. Open the Tailscale admin session (`openTailnetAdmin`, as `worker terminate`
   does, [worker lifecycle §Tailnet device removal](worker-lifecycle.md#tailnet-device-removal)):
   a secret that cannot be read, or a client Tailscale does not accept, refuses
   teardown before anything is listed. An admin client an earlier teardown
   already deleted is the [rerun](#rerun)'s: the devices are then not checked.
8. The inventory: the factory's tagged instances in every state but
   `terminated` and its tagged VPCs (EC2,
   [provisioning §Tagged VPCs](provisioning.md#tagged-vpcs)), its tagged secrets
   ([secrets §Listing](secrets.md#listing)) and the tailnet's devices. A
   listing that fails refuses teardown, naming it
   ([Refusals](#refusals)). Each factory.json reference under `<id>/` the
   secrets listing did not find is then looked up with `DescribeSecret` and
   judged as a listed one: owned, kept, or already absent; one whose lookup
   fails or cannot be judged refuses teardown too
   ([secrets §Listing](secrets.md#listing)). A worker whose machine is
   `pending` or `stopping` refuses it too, before anything is asked. Then the
   host keys earlier teardowns remembered as their destroy began, unless an
   apply or upgrade may have changed the factory since, are read back from the
   operation records ([Devices](#devices)): records that cannot be listed or
   read, or one that cannot be judged, refuse teardown.
9. The guarded destroy plan: `plan -destroy` of the `factory` root under
   Terraform's state lock, with factory.json projected with the host keys the
   state records, into a plan directory of its own, judged by
   `destroyPlanRefusal` over the instances the inventory listed
   ([provisioning §Destroy plan](provisioning.md#destroy-plan)), and refused
   when Terraform's `-detailed-exitcode` and its JSON plan disagree
   (`destroyPlanMismatch`): changes reported with no resource or root output
   change, or either changed with none reported. Terraform counts a root
   output change as a change, so a plan deleting only the root outputs, of a
   state that records root outputs but no resource, agrees with exit 2.
10. Show what will be removed and kept (`TeardownReview`, the `review`
    progress event): the target (factory.json's path, the factory, its account,
    Region and release), the destroy plan's changes, the instances and VPCs,
    the devices to delete and those only listed, the owned secrets and the kept
    ones, the state bucket (`TeardownBucket`: its name, and `outcome`
    `deleted`, last of all), each worker's unarchived evidence as previewed
    ([Unarchived evidence](#unarchived-evidence)) and, with the log archive
    enabled, the archive kept.
11. The [confirmation](#confirmation).
12. Stop dispatch on every running worker the tailnet locates
    ([Gates](#gates)), recording each outcome.
13. The [gates](#gates): EC2's instances listed again, refused unless they
    are as reviewed, then one fresh inspection of each running worker.
14. Apply exactly the saved destroy plan, unless it changes nothing (the
    `factory` root already gone). A plan deleting only the root outputs is
    applied too, so the state records none, though no resource is destroyed.
15. Verify that nothing tagged with the factory ID remains: EC2 lists no
    instance and no VPC, and, once the destroy applied, the factory's
    Terraform state records no host key. Anything left, or a listing or read
    that fails, stops the run before devices, secrets and the bucket (D12).
    Against real Terraform the host key check is a weak backstop: a destroy
    deletes the root outputs, `host_keys` among them, before any resource, so
    it mainly catches a Terraform or provider defect, and EC2's listing is the
    primary check.
16. Delete the [devices](#devices), listed afresh.
17. Delete the owned secrets, each confirmed absent
    ([secrets §Deletion and absence](secrets.md#deletion-and-absence)), the
    admin client among them, only after the devices.
18. Remove the local saved plans, `<cache>/plans/<factory ID>/`.
19. Delete the state bucket (`LockStore.deleteBucket`), which deletes the
    lock and the operation record with it.
20. Report what was removed and kept ([Report](#report)).

Steps 1 to 5 reach nothing that could change: refusals there take no lock and
write no record. Without a state bucket, teardown goes on from step 5 without
a lock or a record ([No state bucket](#no-state-bucket)). From step 6 every refusal and decline is recorded and releases
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
   changed`; `of HOSTNAME` only for a well-formed key; a machine reviewed
   `shutting-down` that is no longer listed has finished terminating, no
   change, as right after `worker terminate`), next action ``Rerun
   `fffactory teardown` to review the factory as it is now.`` A listing that
   fails refuses as the inventory's does. Nothing is deleted, the lock is
   released, and dispatch stays stopped where it was, for `fffactory apply` to
   restart.
3. **Inspection.** Each running worker's agent activity and last repository
   result, then its current work (`inspectForRemoval`, shared with terminate),
   judged by `removalGate`: busy agents (by the
   [busy rule](control-plane.md#the-busy-rule): a worker whose only agents
   are `finished`, `failed` or `stopped` passes), work not pushed to any remote,
   unresolved or unmanaged checkouts, and a worker that cannot be located or
   inspected each refuse, naming the worker, in terminate's words. Every
   running worker is inspected, and every refusal reported.

A `stopped` worker passes uninspected, as with terminate (**accepted risk**:
unpushed work on its disk is not reported, and is destroyed with it).

### Unarchived evidence

Each worker's evidence its log archive collector had not archived is lost with
its machine. The inspection counts it as terminate's does
([worker lifecycle §Unarchived evidence (terminate)](worker-lifecycle.md#unarchived-evidence-terminate)),
and each record's `document` carries it as `unarchived`. It never refuses
teardown and never changes a gate's verdict (S2): teardown has no `--force` to
skip it. Once every running worker is inspected, before any refusal is
reported or anything destroyed, the `unarchived` progress event says, for each
worker on a machine EC2 listed, in its order, `Log archive on HOSTNAME:
WORDS.`, in terminate's words; a worker the gates did not inspect (stopped,
already being terminated) is `unarchived evidence unknown`, never nothing
unarchived (S1). The report repeats it ([Report](#report)). It is said for
every worker while factory.json enables the log archive, and otherwise only for
a worker that counted a backlog (`saysUnarchived`).

The review comes before the confirmation and the gates' inspection after it
(D3), so the review carries a preview, so that the operator knows what is
lost before confirming, not after. While factory.json enables the log archive,
right before the review, each running worker the tailnet locates is asked for
its work inspection alone (`previewUnarchived`), every one at once: read-only,
while dispatch still runs, and never its activity, so it never holds the
activator for a gate. Its count is the review's `unarchived`
(`WorkerUnarchived`, in EC2's order), shown under `Unarchived` after the
instances. Without the archive no worker is asked and the review previews
nothing: the collector step removes the collector's configuration
([host protocol §The collector step](host-protocol.md#the-collector-step)), so
`work inspect` reports `not_collected` and no worker can count a backlog. A
worker stopped or not located, or whose inspection cannot be had or carries no
backlog (a release before it), is `unarchived evidence unknown`, never nothing
unarchived (S1). The preview is information only: it never refuses, never
changes a gate or the exit code (S2), and is not recorded. A worker unreachable
then is refused only by the gates, after the confirmation, as before. Since
dispatch still runs, the count can grow before the destroy; the gates count it
again once dispatch is stopped, and that count is the one said under
`Removing`, recorded and reported. A
machine `shutting-down` is already being terminated and is neither stopped nor
inspected; one `pending` or `stopping` is refused before the confirmation,
`EC2 instance ID of HOSTNAME is pending`, next action ``Wait until it is
running, then rerun `fffactory teardown`.`` (`Wait until it has stopped` for
`stopping`).

Teardown has no `--force`. A gate's next action reruns teardown, or removes
the worker first, uninspected (`teardownGateActions`):

| Gate | Next action |
| --- | --- |
| Busy agents, unpushed work, unresolved checkouts | ``STEP, then rerun `fffactory teardown`. To remove the worker anyway, run `fffactory worker terminate KEY --force` first.`` |
| Activity, checkouts or work that could not be inspected | The same, `uninspected` for `anyway` |
| Not located in the tailnet | ``Check the worker with `fffactory status`, then rerun `fffactory teardown`. If it cannot be inspected, remove it uninspected: run `fffactory worker terminate KEY --force`, then rerun `fffactory teardown`.`` |
| Unmanaged checkouts, or an older activator or a release from before agent states checked by hand | ``... then terminate it with --force: `fffactory worker terminate KEY --force`, and rerun `fffactory teardown`.`` |

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
   state's `host_keys` output, carried by an EC2 instance's host key tag or
   remembered by an earlier teardown (below) (each well-formed key once), the
   devices `selectWorkerDevices` finds for `<id>-<key>`: the
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

**Remembered keys.** A destroy that has begun deletes the `host_keys` output
first, a finished one every root output, and EC2 stops listing an instance
once it has terminated. So on a rerun after a destroy began, a host
factory.json does not declare (one EC2 alone tagged, as a machine `worker
terminate` removed is while it shuts down, or a leftover terminated by hand)
would otherwise be no known key, and under a hand-chosen ID its device would
fall to step 2 and only be listed. Teardown therefore remembers its known keys
in its [operation record](#operation-record) (`host_keys`) as its destroy
begins, and reads back, with the inventory, every earlier record under the
factory's prefix (`LockStore.readOperations`, `rememberedHostKeys`): each
teardown record's keys join step 1's, and this teardown remembers them with
its own when its destroy begins, so a chain of reruns that reach the destroy
carries them forward. They only widen step 1's exact `<id>-<key>` matches: an
untagged device is still only listed, and step 2 is unchanged. Their devices
are shown in the review like any other known key's.

Only a teardown whose destroy may have begun remembers keys: they are written
with its `applying` step alone, the last write before the destroy, so a
teardown declined, refused, failed or interrupted before it remembers none,
and the factory it leaves carrying on is not later taken for one being torn
down. And they are remembered only until an apply or upgrade may have changed
the factory: a teardown record is passed over once any record of an apply or an
upgrade started after it, or in the same millisecond, whose infrastructure
stage is `applying`, `applied` or `failed` (the record cannot tell a failed
plan from a failed apply, so it counts). From then on the factory's hosts are
that apply's, and its Terraform state names them again; a key only the earlier
teardown knew is no known key, and its device under a hand-chosen ID is only
listed. An apply declined, refused, unchanged or interrupted before
`applying`, and every worker operation, bound nothing. Records are ordered by
the start time their key names ([plan and apply §Operation
records](plan-apply.md#operation-records)).

Another operation's record remembers nothing; an object under the prefix that
`operationKey` never names is not a record and is passed over. A teardown
record without `host_keys`, written before teardown remembered any, remembers
none. A record that cannot be read (not this factory's JSON record naming its
operation, a teardown's whose `host_keys` is present but not a list of
well-formed host keys, or another operation's whose `stages` is not a list of
stages) may hide a key, or the apply that bounds one, so it refuses teardown
before anything is removed, never taken for either: `An earlier operation
record of the factory could not be read`, each named (`Operation record
s3://BUCKET/KEY`), next action ``Restore each record named from an earlier
version in the state bucket, or delete it if fffactory did not write it, then
rerun `fffactory teardown`.`` (`rememberedKeysUnreadable`). Records that
cannot be listed or read at all refuse as a listing that fails: `The operation
records in the state bucket could not be read: REASON`. The records stay until
the state bucket is deleted, which happens only once the devices are gone
([Order](#order)), so whenever a device teardown would delete remains, so do
they; without a state bucket there is nothing to read, and nothing is missed
([No state bucket](#no-state-bucket)). Every record is listed and read, apply's
too, so the read grows with the factory's history, a few GetObject calls at a
time (`TODO(re-evaluate when a factory's operation records number in the
thousands)` in `src/application/teardown-factory.ts`).

**Accepted risk:** records are ordered by the start time the operator's own
clock gave them. An apply started from a machine whose clock is behind the
teardown's by more than the time between them sorts before it, and the
teardown's keys stay remembered. The other way, an apply started before the
teardown from a machine whose clock is ahead of the teardown's by at least the
time between them sorts after it, or in its millisecond, and the teardown's
keys are passed over: a rerun deletes less than the first run would have, a
key only that teardown knew being no known key, its device under a
hand-chosen ID only listed. **Accepted risk:** while remembered, a key is
matched as a declared key is: under a hand-chosen ID another factory extends
(`acme`, `acme-lab`), a remembered `lab-builder-1` deletes a tagged
`acme-lab-builder-1`, as the declared key would have before the destroy
began, also once `worker terminate` has since removed that host.

## Confirmation

D2. Teardown is confirmed by naming the factory, never by y/N:

- At a terminal, without `--confirm`, once the review is shown, teardown asks
  `Remove factory ID and everything it owns? Its workers, network, IAM,
  Terraform state, tailnet devices, owned secrets and state bucket are deleted,
  and none can be recovered. Type the factory ID to confirm: `. Only the
  factory ID itself, exactly (blank space around it aside), confirms; anything
  else, or no answer, declines: recorded `declined`, nothing removed, dispatch
  not stopped, the lock released. A wrong answer is never echoed.
- With the log archive enabled, the question excepts it, `Remove factory ID
  and everything it owns but its log archive? ...`, and names it kept before
  asking for the ID: `... and none can be recovered. Log archive NAME is kept;
  fffactory never removes it. Type the factory ID to confirm: `
  (`teardownQuestion`, `archiveKept`). Without a state bucket only the latter
  changes.
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
| A reference under `<id>/` not listed cannot be looked up (`secretUnresolved`) | `The secret ARN could not be looked up: REASON`, such as `Secrets Manager DescribeSecret failed: AccessDeniedException`, each such reference listed; details `ListSecrets did not list it, as it may not for a few minutes after a change, so only DescribeSecret can tell whether the factory owns it.` | ``Check your network connection and that the credentials may call secretsmanager:DescribeSecret, then rerun `fffactory teardown`.`` |
| Such a reference described without a usable name or ARN (`unusable`) | `Secrets Manager described the secret ARN without a usable name or ARN`; details add `Secrets Manager answered, but not in full: its ownership is judged on the name, ARN and tags it answers.`: no network or permission problem | ``Rerun `fffactory teardown`; if Secrets Manager answers the same again, check the secret in the Secrets Manager console.`` |
| Such a reference describing another secret | `Secrets Manager described OTHER, another secret than ARN names`; details add `A partial ARN, without the six characters Secrets Manager adds after a hyphen, can resolve to another secret: what it describes is never judged for this reference.` | ``Check that factory.json names the secret by its full ARN, as the Secrets Manager console shows it, then rerun `fffactory teardown`.`` |
| The tailnet's devices cannot be listed | `The tailnet's devices could not be listed: REASON` | the OAuth client, then rerun |
| The operation records cannot be listed or read | `The operation records in the state bucket could not be read: REASON` | the permission (`s3:ListBucket`, `s3:GetObject`), then rerun |
| An earlier operation record cannot be read ([Devices](#devices)) | `An earlier operation record of the factory could not be read`, each named | restore it to its latest version that reads, or delete it if fffactory did not write it, then rerun |
| A worker's machine `pending` or `stopping` | `EC2 instance ID of HOSTNAME is STATE` | wait, then rerun |
| The state records unreadable host keys | `The host keys the factory's Terraform state records could not be read` | ``Check the factory's Terraform state with `fffactory plan`, then rerun `fffactory teardown`.`` |
| factory.json cannot be projected | `factory.json cannot be projected into the destroy plan's Terraform inputs`, each issue listed | Fix factory.json, then rerun |
| The guarded destroy plan | [provisioning §Destroy plan](provisioning.md#destroy-plan)'s three refusals | as there |
| Exit code and JSON plan disagree | `Terraform's destroy plan reports changes, but its JSON plan changes no resource or output` (or `reports no change, but its JSON plan changes resources or outputs`) | ``Check the factory's Terraform state with `fffactory plan`, then rerun `fffactory teardown`.`` |
| Declined | (declined, not refused) | |
| Dispatch not stopped | `Dispatch could not be stopped on HOSTNAME: REASON` | as an uninspected gate's |
| EC2's instances changed since the review | `The factory's EC2 instances changed after they were reviewed`, each change listed ([Gates](#gates)) | ``Rerun `fffactory teardown` to review the factory as it is now.`` |
| EC2's instances cannot be listed again | the listing's own failure | as the inventory's |
| A gate | terminate's words, naming the worker ([Gates](#gates)) | [Gates](#gates) |
| The admin client's secret gone while the factory's resources remain | `The Tailscale admin client's secret no longer exists, but the factory's resources remain` ([Rerun](#rerun)) | ``Store the admin client again with `fffactory secret set tailscale-admin-client`, then rerun `fffactory teardown`.`` |
| The state bucket answers 403 | `The state bucket BUCKET cannot be reached in account ACCOUNT (S3 answered 403)` ([Rerun](#rerun)) | the permission, then rerun; or nothing left, after an earlier teardown |
| No state bucket, but EC2 lists instances or VPCs tagged with the factory ID | `The state bucket BUCKET does not exist, but resources tagged with the factory's ID do`, each listed ([No state bucket](#no-state-bucket)) | ``Check them in the EC2 console and remove those that are this factory's yourself, then rerun `fffactory teardown`.`` |
| No state bucket when reviewed, one by the confirmation | `The state bucket BUCKET exists now, but did not when the factory was reviewed` | ``Rerun `fffactory teardown` to review the factory as it is now.`` |

A listing that fails says `Nothing was removed: a listing that failed is never
taken for one that found nothing.`: an empty EC2 listing would read as no
instance the destroy plan may delete, and every one of its instance deletes
would be refused for the wrong reason; an empty secrets or devices listing
would read as nothing to remove.

The admin client's secret that cannot be read refuses with its error. When it
is under `<id>/` and `DescribeSecret`, in the Region its ARN names, still finds
it, as it finds a secret pending deletion, the refusal adds `Secrets Manager
does not read a secret pending deletion either, as the admin client is for a
while once teardown deleted it: rerun `fffactory teardown` once it is gone.`;
not otherwise, such as when the look fails.

Terraform failing to plan the destroy fails teardown (`Planning the factory's
destruction failed: REASON`, `Nothing was removed.`), recorded `failed`, with
the private diagnostics file's path, never Terraform's output. Any other error
before the destroy fails it the same way (`failed`, `Check the factory with
`fffactory status`, then rerun `fffactory teardown`.`). A failure, like a
refusal, names the workers dispatch was stopped on first (`dispatchStopped`).

What stops the run once the destroy was applied, or while it was, is
`partial` ([Partial failure](#partial-failure)).

## Partial failure

D6, D8, D12. Once Terraform is asked to destroy the factory, whatever stops
the run is `partial`, recorded `partial` (exit 2), and the lock is released.
Each step starts only once the one before finished, so everything before
where it stopped is gone, and everything from there on remains. The result
says how far it got (`stoppedAt`), what remains of each kind (`remaining`,
`TeardownRemaining`), and why (`refusal`): what failed, its details, then one
line per kind that remains (`stoppedPartWay`), and a next action that always
reruns `fffactory teardown`, after a step by hand when one is needed.

| Stopped at (`stoppedAt`) | Fails | Leaves | Next action |
| --- | --- | --- | --- |
| `destroy` | Terraform's apply: `Destroying the factory's resources failed: REASON`, and its diagnostics file | Terraform may have destroyed part of the factory: whatever its state still holds, then everything below | ``Rerun `fffactory teardown`: it plans the destroy again from what exists now.`` |
| `leftovers` | Instances or VPCs tagged with the factory ID after the destroy, outside its state (D12), each by ID | The devices, secrets, plans and bucket | ``Check them in the EC2 console and remove those that are this factory's yourself, then rerun `fffactory teardown`.`` |
| `leftovers` | The state still records host keys after the destroy: `The factory's Terraform state still records hosts after the destroy`, `Host KEY` each (`A host key that is not well-formed` for another) | The same | ``Rerun `fffactory teardown`: it plans the destroy again from what the state records.`` |
| `leftovers` | Listing EC2 again failed: nothing proves the factory gone | The same | The permission, then rerun |
| `leftovers` | The state's recorded host keys cannot be read after the destroy: `The host keys the factory's Terraform state records could not be read` | The same | ``Check the factory's Terraform state with `fffactory plan`, then rerun `fffactory teardown`.`` |
| `devices` | A device not deleted (`Deleting device ID failed: REASON`), or the devices not listed again | Those devices (the review's when unlisted), every owned secret, the admin client among them (`The admin client was kept, so a rerun can delete them.`), the plans and the bucket | ``Check the devices at https://login.tailscale.com/admin/machines, then rerun `fffactory teardown`.`` (the OAuth client when unlisted) |
| `secrets` | A secret not confirmed gone: denied, past the 60 s deadline, a restore of one pending refused ([secrets §Deletion and absence](secrets.md#deletion-and-absence)): `NAME: REASON` each | Those secrets, the plans and the bucket | ``Check the credentials may delete and describe them, then rerun `fffactory teardown`.`` |
| `plans` | Removing the local saved plans | The plans and the bucket | ``Check the factory with `fffactory status`, then rerun `fffactory teardown`.`` |
| `bucket` | The state bucket remains (`The state bucket BUCKET remains`, what is left of it and of the lock, [Operation record](#operation-record)) | The bucket | ``Check that the credentials may list and delete the bucket's object versions, and delete the bucket, then rerun `fffactory teardown`.`` |

Any other error once the destroy started is `partial` at the step it was in,
with teardown's own words for it and ``Check the factory with `fffactory
status`, then rerun `fffactory teardown`.``. The lines that list what remains,
in D6's order, each only when something of its kind is left:

- `Remains: whatever the factory's Terraform state still holds` (only at `destroy`);
- `Remains: tailnet devices ID, ...`, or, the admin client already gone,
  wherever the run stops, ``Tailnet devices: not checked: teardown deletes the
  admin client only after the devices`` followed by `CHECK_UNCHECKED_DEVICES`
  ([Rerun](#rerun));
- once the devices step listed them, the devices it listed but kept (D9's
  `possible` and `untagged`, `listedDevices`): `Listed, not deleted: tailnet
  devices ID (HOSTNAME), ...`, the hostname only when teardown derived it,
  followed by `CHECK_LISTED_DEVICES`;
- `Remains: owned secrets NAME, ...`;
- `Remains: the local saved plans`;
- `Remains: the state bucket BUCKET`, always under the lock; never without a
  state bucket ([No state bucket](#no-state-bucket)).

The devices listed but kept are never listed again once the admin client is
deleted, so every outcome past the devices step carries them: a partial's
`remaining.listedDevices`, an [interruption](#interruption)'s `listedDevices`,
and the [report](#report)'s `possible` and `untagged`.

When the state bucket remains, the lock was released whatever its deletion
reached: `held`, by the release; `unknown`, `Deleting the factory lock's
versions stopped part way: teardown released it by its version.`; `deleted`,
gone with the bucket's versions. Only an [interrupted](#interruption) teardown
keeps it.

## Rerun

A rerun goes through the same [order](#order), confirmed again, and
inventories afresh: it resumes from what actually exists, never from what an
earlier run reported. What is gone is found gone, and reported so:

- The `factory` root already destroyed: the destroy plan changes nothing, and
  the report says `infrastructure: absent`.
- A state that records root outputs but no resource: the destroy plan
  deletes only those outputs, exit 2, which agrees with its JSON plan
  ([provisioning §Destroy plan](provisioning.md#destroy-plan)). It is
  applied, the leftover check reads a state without the `host_keys` output as
  recording no host key, the run goes on through the devices, secrets, plans
  and bucket, and the report says `infrastructure: absent`, with no change
  shown: no resource was destroyed. A stopped destroy does not leave such a
  state: Terraform 1.16.4 deletes the root outputs before any resource, so a
  destroy stopped once it has begun leaves no output, only the resources it
  did not destroy, and one that fails before it begins (a stale saved plan, a
  state lock it cannot take) leaves the state as it was: never outputs alone.
  The rerun destroys what is left. Without the `host_keys` output, a host
  only that output, or a since terminated EC2 instance, named is known from
  the operation record of the run that knew it as its destroy began
  ([Devices](#devices)).
- Devices already deleted are not found: nothing to delete. Those of every
  key an earlier teardown knew as its destroy began are deleted as that run
  would have, its record remembering the key, unless an apply or upgrade may
  have changed the factory since ([Devices](#devices)).
- Owned secrets already deleted are not listed. factory.json's references
  under `<id>/` the listing does not find are each looked up with
  `DescribeSecret`, in the Region their ARN names
  ([secrets §Listing](secrets.md#listing)): those it no longer finds are
  reported already absent (`absent`, in the review and the report); one it
  still finds is judged as a listed one, deleted when owned (as one the
  listing has not caught up with yet) and kept when not; one whose lookup
  fails or cannot be judged refuses the rerun, removing nothing, until the
  lookup succeeds. No
  run ends `done`, or deletes the state bucket, while a reference under
  `<id>/` is unresolved.
- A secret left pending deletion, or still being deleted, is restored, then
  deleted again ([secrets §Deletion and absence](secrets.md#deletion-and-absence)).
- The state bucket is emptied from what is left in it, then deleted. A
  `partial` released the lock, so the rerun takes it again.
- The state bucket already deleted: S3 no longer finds it, and EC2 lists
  nothing tagged, so the rerun is the [no-bucket mode](#no-state-bucket),
  without a lock. Its admin client already gone, the devices are not checked;
  the secrets already gone are `absent`; it ends `done`.

**The admin client already gone.** Teardown deletes the admin client only
after the devices, which come after the destroy and the leftover check, so a
rerun after the secrets' step may find its secret gone. When the admin
client's secret cannot be read, teardown asks whether it is gone as only
teardown leaves it: its name under `<id>/` (teardown deletes nothing else),
and `DescribeSecret`, in the Region its ARN names, no longer finding it. Then
teardown goes on without an admin session: it lists no device, and reports the
devices `not checked: teardown deletes the admin client only after the
devices` (`devicesUnchecked`, `DEVICES_NOT_CHECKED`, in the review, the report
and a partial's remains wherever it stops), never as remaining, with the advice
`CHECK_UNCHECKED_DEVICES`: `The admin client's secret no longer exists, so the
tailnet's devices were not listed: teardown deletes it only once they are gone.
Check the devices at https://login.tailscale.com/admin/machines for any an
earlier teardown listed but did not delete, and, if the secret was deleted
otherwise, for the factory's own.` The earlier run named those it listed but
kept ([Partial failure](#partial-failure)). Once the destroy plan is made, anything teardown
removes before the devices still there refuses it (`The Tailscale admin
client's secret no longer exists, but the factory's resources remain`): EC2
lists an instance or VPC tagged with the factory ID, or the destroy plan
changes a resource (root outputs alone are no resource: their deletion goes
on). Nothing is deleted, and no dispatch is stopped; the next
action stores an admin client again. So a rerun never deletes less than the
first run would have, unless an apply or upgrade may have changed the factory
since, or the operator's clock put the earlier teardown before one
([Devices](#devices)). Any other unreadable admin client, one outside
`<id>/`, one still found (pending deletion, or a denial) or whose look fails,
refuses as before ([Refusals](#refusals)). So an admin client still found
pending deletion past its deadline (`secrets` partial) refuses the reruns until
Secrets Manager no longer finds it; the next rerun then finishes.

**Accepted risk:** an admin client deleted by hand, under `<id>/`, of a
factory with nothing tagged left and nothing in its state is taken the same
way: its devices are reported not checked, never deleted or claimed absent.

**The state bucket's name.** A bucket deleted by an earlier teardown frees its
name, which another account may then take. Every S3 request requires the
factory's account to own the bucket, so `HeadBucket` then answers 403, which
is also its answer when the credentials may not reach the bucket
(`StateBucketUnreachable`, [provisioning §Backend bootstrap](provisioning.md#backend-bootstrap)).
Teardown cannot tell which, refuses before any lock, and never takes it for
the factory's bucket: `The state bucket BUCKET cannot be reached in account
ACCOUNT (S3 answered 403)`, details `S3 answers 403 when these credentials may
not reach the bucket, and when its name belongs to another account, as it may
once an earlier teardown deleted it: teardown cannot tell which, and never
takes it for the factory's bucket.`, next action ``Check that the credentials
may reach the bucket (s3:ListBucket), then rerun `fffactory teardown`. If an
earlier teardown reached the state bucket's deletion, it had removed
everything else of the factory it could before: the name may since be another
account's, and nothing of the factory is left in it.`` A bucket S3 no longer
finds at all is the [no-bucket mode](#no-state-bucket).

## Interruption

Teardown checks its interrupt (`interrupted`) after every step and every call,
and every wait goes through the injected sleep. From the interrupt on it starts
nothing more: no Terraform command (the destroy plan's `output`, `plan
-destroy` and `show`, and the state read after the destroy, each start only
while it is not interrupted), device, secret or S3 deletion, and no more of its
record. It keeps the lock (`settleFactoryLock`), and reports
`interrupted` whatever the run returned once the interrupt landed, even during
its last record write (the pattern of [worker lifecycle
§Interruption](worker-lifecycle.md#interruption) that
[#38](https://github.com/yaunder/fffactory/issues/38) asks apply to adopt), so
the outcome reported and the lock kept never disagree. Interrupted before the
lock, nothing is locked. The one exception: once the bucket is gone, the lock
went with it, and the teardown is done: it prints the `done` report. Its exit
status is still the interrupt's, 128 plus the signal's number:
`src/cli/interrupts.ts`, shared by every command, exits so once an interrupt
landed, whatever the command returned. Nothing it removes remains (the log
archive, when enabled, is kept), and a rerun finds no state bucket ([No state
bucket](#no-state-bucket)).

The result says how far it got (`reached`, the last step started: one the
interrupt landed before is never started, even when the call before it then
succeeded, and `removing`, whether it had begun removing: reached the destroy
step, or [without a state bucket](#no-state-bucket) the devices step; from
there on the factory may be partly removed),
where dispatch is stopped (`dispatchStopped`), the devices listed but kept
(`listedDevices`, [Partial failure](#partial-failure)), the record (only while
it is not being deleted with the bucket) and what became of the lock (`lock`). Its words
(`interruptedTeardown`, `src/domain/teardown.ts`) name `fffactory lock break`
only for this teardown once fffactory has exited, when it is confirmed dead:

| Left | Summary | Next action |
| --- | --- | --- |
| The lock, with the record | `Interrupted: the factory stays locked, with a record of this teardown` | ``Once fffactory has exited, break the lock with `fffactory lock break`, then rerun `fffactory teardown`.`` |
| The lock, no record written, or the record being deleted with the bucket | `Interrupted: the factory stays locked by this teardown, which may have no operation record` | The same |
| The bucket's deletion reached the lock (`unknown`) | `Interrupted while the state bucket was being deleted: the factory lock may already be gone with it` | ``Once fffactory has exited, rerun `fffactory teardown`. If it finds the factory locked by this teardown, break that lock with `fffactory lock break`, then rerun it.`` |
| Every version of the lock deleted (`deleted`) | `Interrupted while the state bucket was being deleted: the factory lock is already gone with it` | ``Once fffactory has exited, rerun `fffactory teardown`.`` |
| No lock: [no state bucket](#no-state-bucket) (`none`) | `Interrupted: the factory is not locked, since it has no state bucket to hold a lock` | ``Once fffactory has exited, rerun `fffactory teardown`.`` |

Its details: `Nothing was removed.`, and where dispatch is stopped
(`dispatchLeftStopped`), before the destroy; once removing, `Teardown had
begun removing the factory, and was DOING: a rerun inventories again and
finishes from what remains.`, DOING the step in words (`destroying the
factory's resources`, `checking that nothing tagged with the factory ID
remains`, `deleting the tailnet devices`, `deleting the owned secrets`,
`removing the local saved plans`, `deleting the state bucket`), then the
devices listed but kept and `CHECK_LISTED_DEVICES`, when there are any.
Deleting an owned secret, interrupted, starts no further Secrets Manager call,
nor the next secret's deletion ([secrets §Deletion and
absence](secrets.md#deletion-and-absence)): a secret whose deletion was refused
may still be pending deletion, one pending deletion may be left restored, no
longer pending, and one whose deletion was requested is not confirmed gone; a
rerun inventories again and finishes them. Deleting the bucket, interrupted,
starts no further S3 call ([provisioning §Deleting the state
bucket](provisioning.md#deleting-the-state-bucket)): the lock is `held` until
the call for its current version was made.

## Operation record

The lock's [operation record](plan-apply.md#operation-records) is written when
the lock is taken and again at each step. Its `operation` is `teardown`, and
it has one stage, `teardown`, which goes `authorizing`, `inventorying`,
`planning`, `awaiting_approval` (only when asked), `stopping_dispatch` (written
again with `dispatch` once each running worker's dispatch is stopped:
`not_requested`, or `failed` with its reason), `inspecting` (written again
with `inspections` once every running worker is inspected), `applying`,
`verifying`, `removing_devices`, `removing_secrets`, `removing_plans` and
`deleting_bucket`. It ends `refused`, `declined`, `failed` or `partial`, with
the operation's status alike and `failure` naming why. An interrupted teardown
writes no more of it, and leaves it `running` at the step it reached. With the
admin client [already gone](#rerun), `removing_devices` is skipped.

Teardown's record alone carries `host_keys`: `[]` when the lock is taken,
and so for every step before `applying`; then, written with `applying`, every
well-formed known key, those earlier teardowns remembered among them
([Devices](#devices)). Every step up to `applying` is written before the
destroy starts, and one whose write fails fails teardown before it, its
record ending without the keys; so the keys are in the bucket whenever a
destroy may have begun. **Accepted risk:** they are there without one only in
a record left `running` at `applying`: one interrupted as that step is
written, or one whose `applying` PutObject timed out on the client after S3
stored it, the `failed` record that would end the teardown without them not
written either. Its keys stay remembered until a later apply or upgrade bounds
them ([Devices](#devices)). A later teardown reads them back, with apply's and
upgrade's records to bound them (`LockStore.readOperations`: ListObjectsV2
under `<factory ID>-operations/`, then GetObject of each, a few at a time);
these are the only records fffactory reads to decide anything
([plan and apply §Operation records](plan-apply.md#operation-records)).

```json
{ "operation": "teardown", "stages": [{ "name": "teardown", "status": "applying" }], "host_keys": ["builder-1", "old-1"], "...": "as every record" }
```

Teardown's record also carries `inspections` (D13, [epic
#94](https://github.com/yaunder/fffactory/issues/94)): one per running worker
the [gates](#gates) inspected, in the order inspected, refusals included, each
as a terminate's record carries its `inspection` ([worker lifecycle
§Operation record](worker-lifecycle.md#operation-record)): `forced`, always
`false`, as teardown has no `--force`, and `document`, exactly the inspection
document `worker inspect --json` prints for the same inspection, `removable`
or `refused` with the gate's findings. It is written once every running worker
is inspected, before any refusal ends the record or the destroy begins; a
stopped worker, which passes uninspected, gets none, so a teardown with no
running worker records `inspections: []`. It is absent before
then: a teardown declined, interrupted during the inspection, or refused
before it (dispatch not stopped, the machines changed since the review)
carries none. A record whose final write fails keeps the outcome, as every
record's does.

```json
{ "operation": "teardown", "stages": [{ "name": "teardown", "status": "refused" }], "inspections": [{ "forced": false, "document": { "key": "builder-1", "hostname": "fff-abcd1234-builder-1", "verdict": "refused", "not_inspected": null, "summary": "1 agent is working on fff-abcd1234-builder-1: terminating it would end it", "details": [], "activity": { "state": "busy", "reason": null, "agents": [{ "id": "agent-1", "state": "working", "dispatched": true }] }, "unarchived": { "state": "unknown", "files": null, "bytes": null, "complete": null, "last_success_at": null } } }], "...": "as every record" }
```

Without a state bucket there is no record at all
([No state bucket](#no-state-bucket)): its endings name no `operation`.

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
  no resource (nothing, or only root outputs), the `factory` root already
  gone; without a state bucket
  `not_found_by_ec2`: no destroy plan was made, EC2 listing no instance or VPC
  tagged with the factory ID, and nothing outside EC2 was looked for
  ([No state bucket](#no-state-bucket)); the resources destroyed, and the
  instances EC2 listed before (`ShownMachine`: its host key only when
  well-formed, a malformed tag only marked, `malformedHostKey`);
- the devices deleted, by ID, and those listed but kept (`possible`,
  `untagged`), each by ID and the hostname teardown derived, `<id>-<key>`,
  when its reported hostname is that for a well-formed key (`ShownDevice`);
- `devicesUnchecked`: `not checked: teardown deletes the admin client only
  after the devices` when the admin client was already gone ([Rerun](#rerun));
- the owned secrets deleted, listed or looked up by their reference
  ([secrets §Listing](secrets.md#listing)), those already absent (`absent`,
  [Rerun](#rerun)), and the kept ones in two groups (`keptSecrets`): tagged
  with the factory ID but not owned (by name and ARN, never their tags); and
  referenced by factory.json but not owned, outside the factory's names (such
  as `fffv/*`) or under them but made by hand. A reference to a tagged secret
  is listed once, with it. Every reference under `<id>/` is one of these by
  the time anything is shown: one whose ownership cannot be told refuses
  teardown ([Refusals](#refusals)). An owned secret neither listed nor
  referenced by factory.json cannot be seen, so `done` does not cover it
  ([secrets §Listing](secrets.md#listing), accepted risk);
- the state bucket (`TeardownBucket`): its name, and `outcome` `deleted`, or
  `not_found` in the [no-bucket mode](#no-state-bucket): not found by this run,
  so not deleted by it;
- `withoutLock`, only in the no-bucket mode: why it ran without the lock
  (`ranWithoutLock`);
- `archive`, only when factory.json enables the log archive: its name
  (`archiveBucketName`), which the report says is kept (`archiveKept`), named
  without an AWS call. The review (`TeardownReview`) carries it too;
- `unarchived`: each worker's unarchived evidence as the gates read it
  (`WorkerUnarchived`: its hostname and `UnarchivedEvidence`), as said before
  the destroy ([Unarchived evidence](#unarchived-evidence)); empty when none
  is said, as without a state bucket, where no worker can be there.

With it, the advice teardown leaves the operator (`factoryJsonKept`,
`REVOKE_SOURCES`, `CHECK_LISTED_DEVICES`, and `CHECK_UNCHECKED_DEVICES` when
the devices were not checked, and `checkOutsideEc2` in the no-bucket mode):
factory.json is left as it is, and still describes the factory, so `fffactory
apply` would create it again: ``factory.json is left as it is: teardown never
changes it. It still describes the factory, so `fffactory apply` would create
it again. Remove it yourself once you no longer need it.`` With the log
archive, apply would adopt the archive rather than create it, if it exists
(teardown never asks), and the advice names it kept: ``factory.json is left as
it is: teardown never changes it. It still describes the factory, so
`fffactory apply` would create it again, adopting its log archive if it
exists. Log archive NAME is kept; fffactory never removes it. Remove
factory.json yourself once you no longer need it.``;
teardown revokes nothing it only refers to (the Tailscale auth key and admin
OAuth client, the tailnet policy entries made for the factory, and the API
credentials kept with any grants given to them), which the operator revokes at
their providers once nothing else uses them; the devices listed but not
deleted, or not checked, are the operator's to check; and without a state
bucket, so are the factory's IAM role and instance profile, which teardown did
not look for.

## Output and exit codes

D12. Teardown prints human text laid out with the blocks of
[CLI output](cli-output.md) (`src/cli/presentation/teardown.ts`), from what the
use case returns: only `ShownMachine`, `ShownDevice` and `ShownSecret`
fields, the domain's words, and nothing it was given. Its header comes first,
`fffactory teardown · release R` and the `Instance` line. Then, on standard
output:

1. **The review** (`review`), the `Teardown` section: the factory, its
   account and Region and release, then one row per kind:
   `Infrastructure` (`N to destroy` and each delete under it, `nothing to
   destroy: the factory root is gone` when the plan destroys no resource: it
   changes nothing, or deletes only root outputs; `no
   destroy plan: EC2 lists nothing tagged with the factory ID` without a state
   bucket), `EC2 instances` (`ID (KEY, STATE)`, a host key tag that is not
   well-formed only marked), `VPCs`, `Tailnet devices` (`delete ID (HOSTNAME),
   ...`, `none to delete`, or `DEVICES_NOT_CHECKED` with
   `CHECK_UNCHECKED_DEVICES` under it), `Owned secrets` (`delete NAME, ...,
   each confirmed gone`, or `none to delete`), `Already absent` and `State bucket` (`BUCKET, deleted last, with the lock`, or
   `BUCKET: not found by this run, so not deleted by it`); without a state
   bucket, `ranWithoutLock` under them. A `Kept` section follows when anything
   is kept: the devices listed but not deleted (`Possibly its devices`, `Untagged look-alikes`), the
   secrets tagged but not owned (`Tagged, not owned`, by name and ARN) and
   those factory.json refers to but the factory does not own (`Referenced`),
   then, with the log archive enabled, `archiveKept` in a line of its own.
   After `EC2 instances`, when any worker's evidence is said, `Unarchived`
   (`what each worker's log archive collector has not archived, destroyed with
   it; counted again before the destroy`), each worker's preview under it by
   hostname, in `unarchivedWords`.
2. **The question**, at a terminal without `--confirm`, on standard error
   after a blank line ([Confirmation](#confirmation)).
3. **Each step** as it starts, under a `Removing` section: `Stopping dispatch
   on HOSTNAME.`, `HOSTNAME is stopped: it is not inspected, and unpushed work
   on its disk is destroyed with it.`, `Destroying the factory's resources.
   Terraform's output is not shown; this can take several minutes.`, `Deleting
   the factory's tailnet devices.`, `Deleting the owned secrets, confirming
   each is gone.` and `Deleting the state bucket BUCKET, the lock last.`;
   once the workers are inspected, each worker's `Log archive on HOSTNAME:
   WORDS.` ([Unarchived evidence](#unarchived-evidence)).
4. **The outcome**, one report on one stream, ending with at most one Next
   block:

| Outcome | Stream | Shows | Exit |
| --- | --- | --- | --- |
| `done` | standard output | `✔ Removed factory ID: only what it kept remains` (without a state bucket, `✔ Removed what was left of factory ID`), claiming only what it can see: an owned secret neither listed nor referenced by factory.json is not ([secrets §Listing](secrets.md#listing), an accepted risk); a `Result` section: `Infrastructure` (`destroyed: N resources` and each, `already absent: the destroy plan destroyed no resource`, or `not found by EC2: no instance or VPC is tagged with the factory ID`), the instances, `Unarchived` (each worker's evidence by hostname, under `what each worker's log archive collector had not archived, gone with it`, when any is said), `Tailnet devices` (`deleted ID, ...`, `none found` or `DEVICES_NOT_CHECKED`), `Owned secrets` (`deleted NAME, ..., each confirmed gone`, or `none found`), `Already absent`, `State bucket` (`BUCKET, deleted`, or not found by this run) and `ranWithoutLock`; the `Kept` section, the log archive in it when enabled; then the Next block of the advice it leaves: `CHECK_UNCHECKED_DEVICES` when the devices were not checked, `CHECK_LISTED_DEVICES` when any were listed but kept, `checkOutsideEc2` without a state bucket, `REVOKE_SOURCES` (the Tailscale auth key and OAuth client, the tailnet policy entries, and the API credentials kept with their grants), and `factoryJsonKept`: factory.json is left as it is and still describes the factory, so `fffactory apply` would create it again, adopting the log archive, when enabled, if it exists, and naming it kept (D11) | 0; 128 + the signal's number when interrupted during the state bucket's last deletion ([Interruption](#interruption)) |
| `refused` | standard error | `✖ Refusing to remove the factory: SUMMARY` and its details, for each refusal; where dispatch was left stopped (`dispatchLeftStopped`); the operation record; a Next block of each next action once | 1 |
| no terminal, no `--confirm` | standard error | `✖` and `TEARDOWN_UNCONFIRMABLE` | 1 |
| incomplete factory.json, another account, a pin mismatch, an unready bucket, a held lock | standard error | as `plan` words them, `Refusing to remove the factory: ...`; each missing field `PATH: is required to remove a factory` | 1 |
| `declined` | standard error | `Not confirmed: nothing was removed.`, and the record | 1 |
| `failed` (before the destroy) | standard error | `✖ Teardown failed: SUMMARY` and its details, where dispatch was left stopped, `Terraform's diagnostics: FILE` (the path only), the record; Next: its next action | 1 |
| `partial` | standard error | `✖ Teardown stopped part way, at STEP: SUMMARY` (STEP: `the destroy`, `the check that nothing tagged remains`, `the tailnet devices`, `the owned secrets`, `the local saved plans`, `the state bucket`), its details with what remains of each kind ([Partial failure](#partial-failure)), the diagnostics file, the record; Next: its next action | 2 |
| `interrupted` | standard error | `interruptedTeardown`'s summary and details, from the whole `TeardownInterruption` (with the lock or without a state bucket), and the record; Next: its next action. Before the lock: `✖ Interrupted before the factory was locked: it is not locked, and nothing was removed` | 128 + the signal's number (`src/cli/interrupts.ts`) |

A `refused` result covers every refusal of [Refusals](#refusals) the use case
words itself, a wrong `--confirm` among them, still never echoed. Every
`fffactory` command a line of fffactory's own words names in backticks, such as
a next action or the advice, is shown as inline code repeating the `--instance`
and `--profile` given (`withCommands`, `fffactoryCommand`); the domain's
summaries and details, which carry data such as secret names and device IDs,
are shown verbatim. `fffactory lock break` is named only where
`interruptedTeardown`'s words, or a held lock's refusal, name it.

```text
fffactory teardown · release 0.0.6
Instance  ~/factory/.fffactory/factory.json (nearest .fffactory/factory.json)

── Teardown ─────────────────────────────────────────
  Factory   Test factory (fff-abcd1234)
  Account   123456789012 · eu-west-2
  Release   0.0.6

  Infrastructure    2 to destroy
    - module.hosts.aws_instance.host["builder-1"]
    - module.network.aws_vpc.this
  EC2 instances     i-0123456789abcdef0 (builder-1, stopped)
  VPCs              vpc-0123456789abcdef0
  Tailnet devices   delete nWorker1CNTRL (fff-abcd1234-builder-1)
  Owned secrets     delete fff-abcd1234/tailscale-auth-key, fff-abcd1234/tailscale-admin-client, each confirmed gone
  State bucket      fff-abcd1234-state, deleted last, with the lock

── Kept ─────────────────────────────────────────────
  Referenced   arn:aws:secretsmanager:eu-west-2:123456789012:secret:fffv/github-token-AbCdEf

── Removing ─────────────────────────────────────────
  fff-abcd1234-builder-1 is stopped: it is not inspected, and unpushed work on its disk is destroyed with it.
  Destroying the factory's resources. Terraform's output is not shown; this can take several minutes.
  Deleting the factory's tailnet devices.
  Deleting the owned secrets, confirming each is gone.
  Deleting the state bucket fff-abcd1234-state, the lock last.

✔ Removed factory fff-abcd1234: only what it kept remains

── Result ───────────────────────────────────────────
  Infrastructure    destroyed: 2 resources
    - module.hosts.aws_instance.host["builder-1"]
    - module.network.aws_vpc.this
  EC2 instances     i-0123456789abcdef0 (builder-1, stopped)
  Tailnet devices   deleted nWorker1CNTRL
  Owned secrets     deleted fff-abcd1234/tailscale-auth-key, fff-abcd1234/tailscale-admin-client, each confirmed gone
  State bucket      fff-abcd1234-state, deleted

── Kept ─────────────────────────────────────────────
  Referenced   arn:aws:secretsmanager:eu-west-2:123456789012:secret:fffv/github-token-AbCdEf

── Next ─────────────────────────────────────────────
  Teardown revokes nothing it only refers to. Once nothing else uses them, revoke the Tailscale auth key and admin OAuth client (https://login.tailscale.com/admin/settings/trust-credentials), remove the tailnet policy entries made for the factory (its tag, grant and SSH rule), and revoke the API credentials kept above, with any grants given to them, at their providers.
  factory.json is left as it is: teardown never changes it. It still describes the factory, so `fffactory apply` would create it again. Remove it yourself once you no longer need it.
```

With the log archive enabled, the same factory's `Kept` sections, in the
review and the report, end with it, and so does the advice; and each worker's
unarchived evidence is previewed in the review, and said under `Removing` and
in the `Result`:

```text
── Teardown ─────────────────────────────────────────
  [...]
  EC2 instances     i-0123456789abcdef0 (builder-1, stopped)
  Unarchived        what each worker's log archive collector has not archived, destroyed with it; counted again before the destroy
    fff-abcd1234-builder-1   unarchived evidence unknown
  [...]

── Removing ─────────────────────────────────────────
  fff-abcd1234-builder-1 is stopped: it is not inspected, and unpushed work on its disk is destroyed with it.
  Log archive on fff-abcd1234-builder-1: unarchived evidence unknown.
  [...]

── Result ───────────────────────────────────────────
  [...]
  EC2 instances     i-0123456789abcdef0 (builder-1, stopped)
  Unarchived        what each worker's log archive collector had not archived, gone with it
    fff-abcd1234-builder-1   unarchived evidence unknown
  [...]

── Kept ─────────────────────────────────────────────
  Referenced   arn:aws:secretsmanager:eu-west-2:123456789012:secret:fffv/github-token-AbCdEf

  Log archive fff-abcd1234-logs-123456789012-eu-west-2-an is kept; fffactory never removes it.

── Next ─────────────────────────────────────────────
  Teardown revokes nothing it only refers to. [...]
  factory.json is left as it is: teardown never changes it. It still describes the factory, so `fffactory apply` would create it again, adopting its log archive if it exists. Log archive fff-abcd1234-logs-123456789012-eu-west-2-an is kept; fffactory never removes it. Remove factory.json yourself once you no longer need it.
```

## Permissions

Teardown is admin-tier. fffactory provisions no IAM role or policy for it; the
operator's credentials need, in the factory's account and Region:

| Permission | Resource | For |
| --- | --- | --- |
| `sts:GetCallerIdentity` | `*` | The account check. |
| `s3:ListBucket`, `s3:GetBucketVersioning`, `s3:GetBucketPublicAccessBlock`, `s3:GetEncryptionConfiguration`, `s3:GetBucketPolicy` | `arn:aws:s3:::BUCKET` | Whether the state bucket exists and is ready, as `plan` asks ([provisioning §Backend bootstrap](provisioning.md#backend-bootstrap)). |
| `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion` | `arn:aws:s3:::BUCKET/<factory ID>-lock.json`, and `s3:PutObject` and `s3:GetObject` on `arn:aws:s3:::BUCKET/<factory ID>-operations/*` (listed with `s3:ListBucket` on the bucket) | The lock and the operation record, and reading back the host keys earlier teardowns remembered ([Devices](#devices), [worker lifecycle §Tiers](worker-lifecycle.md#tiers)). |
| `ec2:DescribeInstances`, `ec2:DescribeVpcs` | `*` (EC2 does not scope them to resources) | The inventory and the leftover check ([provisioning §Tagged VPCs](provisioning.md#tagged-vpcs)). |
| `secretsmanager:GetSecretValue` | The secret `tailscale.admin_client_secret` refers to | The Tailscale admin client. |
| `secretsmanager:ListSecrets`; `secretsmanager:RestoreSecret`, `secretsmanager:DeleteSecret`, `secretsmanager:DescribeSecret` | `*`; `arn:aws:secretsmanager:REGION:ACCOUNT:secret:<factory ID>/*` | Listing, deleting and confirming the absence of the owned secrets ([secrets §Permissions](secrets.md#permissions)); `DescribeSecret` also looks up each reference under `<id>/` the listing left out ([secrets §Listing](secrets.md#listing)): a denial refuses teardown. |
| What Terraform needs to destroy the `factory` root | The state object `factory/terraform.tfstate` and Terraform's lock beside it (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`); refreshing every resource the root holds, and the public Amazon Linux image parameter (`ssm:GetParameter`); deleting them: `ec2:TerminateInstances` on the factory's instances, `ec2:DeleteSecurityGroup`, `ec2:DisassociateRouteTable`, `ec2:DeleteRoute`, `ec2:DeleteRouteTable`, `ec2:DetachInternetGateway`, `ec2:DeleteInternetGateway`, `ec2:DeleteSubnet`, `ec2:DeleteVpc`, and `iam:RemoveRoleFromInstanceProfile`, `iam:DeleteInstanceProfile`, `iam:DeleteRolePolicy`, `iam:DeleteRole` on `<factory ID>-host` | The guarded destroy plan and its apply ([provisioning §Destroy plan](provisioning.md#destroy-plan)). |
| `s3:ListBucketVersions`, `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:DeleteBucket` | `arn:aws:s3:::BUCKET` and `arn:aws:s3:::BUCKET/*` | Emptying and deleting the state bucket ([provisioning §Deleting the state bucket](provisioning.md#deleting-the-state-bucket)). |

It also needs the factory's Tailscale admin client, an OAuth client with the
`devices:core` scope ([machine onboarding §5](../../MACHINE_ONBOARDING.md#5-prepare-the-tailnet)),
to list and delete the tailnet's devices, and the operator's tailnet and
Tailscale SSH as `fffactory-admin` to stop dispatch on and inspect each running
worker, as `status` and `worker terminate` reach them; neither needs an AWS
permission. A permission missing is found where it is used: a listing refused
before anything is removed, or a deletion refused part way, named by its error
and its next action ([Refusals](#refusals), [Partial failure](#partial-failure)).
It needs nothing on the log archive: it makes no AWS call for it.

## No state bucket

D10. The state bucket holds the lock, so a factory whose bucket S3 does not
find (`HeadBucket` 404) has none to take: a first bootstrap that failed after
`secret set` stored the factory's secrets, a bucket deleted by hand, or a
[rerun](#rerun) after a teardown that deleted it. Teardown then runs as
`secret set` does before a bucket exists
([secrets §`fffactory secret set`](secrets.md#fffactory-secret-set)): without the lock
and without an operation record. It never creates or bootstraps a bucket: it
asks S3 only whether the bucket exists and is ready (`stateBucketState`), and
runs no Terraform at all. A bucket S3 answers 403 for is not this mode: it is
refused ([Rerun](#rerun)). Nor is one that exists without every setting
backend bootstrap applies: it is refused as `plan` refuses it
(`unready_bucket`, with its completion commands).

In this mode teardown goes:

1. Steps 1 to 4 of the [order](#order), as with a bucket.
2. The Tailscale admin session (step 7), an admin client an earlier teardown
   already deleted included: the devices are then not checked
   ([Rerun](#rerun)).
3. The inventory (step 8). EC2 listing anything tagged with the factory ID,
   an instance in any state but `terminated` or a VPC, refuses teardown,
   naming each: its Terraform state was in the bucket, so teardown cannot
   destroy it, and removes nothing (`taggedWithoutBucket`): `The state bucket
   BUCKET does not exist, but resources tagged with the factory's ID do`,
   details `Their Terraform state was kept in the state bucket: without it,
   teardown cannot destroy them, and nothing was removed.`, then `EC2 instance
   ID (STATE)` and `VPC ID` each, next action ``Check them in the EC2 console
   and remove those that are this factory's yourself, then rerun `fffactory
   teardown`.`` This refusal comes before an admin client gone
   ([Rerun](#rerun)): storing one again would not help. A listing that fails
   refuses as with a bucket, never taken for nothing tagged.
4. What will be removed and kept (`TeardownReview`): no destroy plan's
   changes, no instance and no VPC, the devices and secrets as with a bucket,
   the state bucket's `outcome` `not_found`, and `withoutLock`, why it runs
   without the lock (`ranWithoutLock`), claiming only what was looked at: `No
   factory lock: S3 does not find the state bucket BUCKET, which would hold
   it, and EC2 lists no instance or VPC tagged with the factory ID; nothing
   outside EC2, such as IAM, was looked for. Without a lock, teardown deletes
   only the factory's tailnet devices, owned secrets and local saved plans, as
   `fffactory secret set` stores secrets before a bucket exists.`; and the log
   archive kept, as with a bucket.
5. The [confirmation](#confirmation), at a terminal asking `Remove what is
   left of factory ID? Its tailnet devices and owned secrets are deleted, and
   none can be recovered. Type the factory ID to confirm: `, with the log
   archive enabled naming it kept before `Type`, as with a bucket.
6. Changed live state invalidates the review: once confirmed (the step
   `verifying`), the bucket must still be missing and EC2 must still list
   nothing tagged, asked one call at a time, the interrupt checked after
   each ([Interruption](#interruption)). A bucket created
   meanwhile (`The state bucket BUCKET exists now, but did not when the
   factory was reviewed`, ``Rerun `fffactory teardown` to review the factory
   as it is now.``), one answering 403, anything tagged or a listing that
   fails refuses, removing nothing.
7. The [devices](#devices) (step 16), listed afresh, by the keys factory.json
   declares: with no state and no tagged instance, there are no others, and
   no record remembering any is needed. An earlier teardown deletes the bucket,
   and its records with it, only once the devices are gone, so a factory with
   no bucket left has no device a record could name. Then
   the owned secrets (step 17), the admin client among them, only after the
   devices, and the local saved plans (step 18), a saved bootstrap plan among
   them. There is no bucket to delete.
8. The [report](#report): `infrastructure` `not_found_by_ec2` (no destroy
   plan was made: it is inferred from EC2 alone), no changes and no instances,
   the devices and secrets as with a bucket, the state bucket's `outcome`
   `not_found`, `withoutLock`, the log archive kept as with a bucket, and with
   the advice `checkOutsideEc2`.

Dispatch, the gates and the destroy have nothing to act on: a worker has no
machine without a tagged instance. Every refusal and a decline remove nothing
and write nothing (`operation` undefined). What stops the run from the devices
on is `partial` at its step, as [with a bucket](#partial-failure), but with no
`operation` and no bucket among what remains (`remaining.bucket` undefined,
no `Remains: the state bucket` line); a rerun finishes it. An interrupt keeps
no lock, since there is none: the result is `interrupted`, `locked: false`,
with `withoutLock` saying how far it got, a `TeardownInterruption` as
`interruptedTeardown` words it ([Interruption](#interruption)): `reached`,
`removing` (from the devices step on), the devices listed but kept, no
`record`, no `dispatchStopped`, and the lock `none`. Interrupted by the time the bucket is
found missing, before the admin session, it is the plain `interrupted`,
`locked: false`, as before a lock. A run that finished is `done`, even when
the interrupt landed at its end.

**Accepted risk:** without a lock, nothing keeps another fffactory out
between the check after the confirmation and the deletions: an `apply` that
bootstraps the bucket in that window finds the secrets it needs deleted under
it, and its workers cannot join the tailnet. This is the window `secret set`
already runs in; the check after the confirmation narrows it to the deletions
themselves.

**Accepted risk:** without the state bucket, teardown looks for nothing
outside EC2. The factory root also creates IAM outside the VPC: the role and
instance profile `<id>-host` with its inline policy `<id>-read-secrets` (and,
with the log archive enabled, `<id>-write-archive`). A
first apply that created them and then failed, say on `VpcLimitExceeded`,
leaves them, and a teardown after the bucket was deleted by hand reports
`not_found_by_ec2` with them still there. The report says so (`ranWithoutLock`)
and leaves them to the operator (`checkOutsideEc2`): ``Without the state
bucket, teardown looked for nothing outside EC2: check IAM for the role and
instance profile ID-host, which a failed first apply may have left, and delete
them yourself if they are this factory's.`` In the IAM console, under Roles
and under the instance profiles (`aws iam get-role --role-name ID-host`,
`aws iam get-instance-profile --instance-profile-name ID-host`): delete the
role's inline policies, remove it from the instance profile, then delete both.

## What it never prints

As `worker terminate`: no AWS or SDK message, credential, Terraform output,
Tailscale answer body, token or secret, and no configuration value but the
factory ID, well-formed host keys, `aws.account_id` and `aws.region`, and what
`plan` already shows of factory.json: its `name` and path (the review's
target), `state_backend.bucket` (the review, the report, the `deleting_bucket`
progress event, `bucketRemains`, `bucketUnreachable`, `taggedWithoutBucket`,
`bucketAppeared` and `ranWithoutLock`), and the secret references it holds
(validated ARNs, kept and listed). A
`--confirm` value or typed answer that is not the factory ID is never echoed,
nor any argument the command refuses ([Command](#command)),
nor a device's tags, a device's reported hostname teardown did not derive, a
secret's tags, or an EC2 host key tag that is not a well-formed key: the review
and the report (`TeardownReview`, `TeardownReport`) do not carry them
(`ShownMachine`, `ShownDevice`, `ShownSecret`). It prints instance IDs, EC2
states, VPC IDs, Tailscale device IDs, the hostnames it derived and secret
names.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/teardown.ts` | The guarded destroy plan's rule and its consistency with the exit code (`destroyPlanRefusal`, `destroyPlanMismatch`), `VpcInventory`; the devices teardown deletes and lists (`selectFactoryDevices`, `FactoryDevices`); the kept secrets' groups (`keptSecrets`), the factory's names (`underFactoryNames`), the references under them to look up (`unlistedReferences`) and the refusal of one that cannot be (`secretUnresolved`); the confirmation rule (`teardownConfirmation`, `typedIdConfirms`) and question (`teardownQuestion`); the gates' next actions (`teardownGateActions`) and the review invalidated by changed machines (`machinesChanged`); the review and report (`TeardownReview`, `TeardownReport`), carrying only what may be printed (`ShownMachine`, `ShownDevice`, `ShownSecret`); the steps (`TeardownStep`), where a partial teardown stopped (`TeardownStop`) and what remains of each kind (`remainingAt`, `TeardownRemaining`, `stoppedPartWay`); an interruption's words (`interruptedTeardown`, its lock `none` without a state bucket); the state bucket's outcome (`TeardownBucket`); without a state bucket, why it runs without the lock (`ranWithoutLock`), what it leaves to the operator outside EC2 (`checkOutsideEc2`) and its refusals (`taggedWithoutBucket`, `bucketAppeared`); the log archive kept (`archiveKept`); each worker's unarchived evidence in the review's preview and the report (`WorkerUnarchived`); the words of every refusal and of the report's advice (`factoryJsonKept`). Pure. |
| Domain | `src/domain/initialization.ts` | `isGeneratedFactoryId`. |
| Domain | `src/domain/worker-lifecycle.ts` | `removalGate` and `RemovalGateActions`: terminate's gates, their next actions completed by the command refused. |
| Domain | `src/domain/worker-removability.ts` | `workerRemovability`: the inspection document the record carries, as `worker inspect --json` prints it. |
| Domain | `src/domain/operation.ts` | `TEARDOWN_OPERATION` and the teardown stage's statuses; its record carrying each running worker's inspection (`InspectionRecord`, `withInspections`); its record remembering host keys (`startTeardownOperation`, `withHostKeys`) and reading them back from the records under `operationsPrefix`, bounded by the last apply or upgrade that may have changed the factory (`rememberedHostKeys`, `StoredOperation`). |
| Domain | `src/domain/secrets.ts` | `classifySecrets`, which judges listed and described secrets alike, and `refersTo`. |
| Application | `src/application/teardown-factory.ts` | `teardownFactory`: the order above, under the lock and its record, the log archive named from factory.json (`archiveBucketName`) in the question, review and report, the lock and record never touched once the bucket is gone; without a state bucket, the same steps from the admin session on without them (`withoutBucket`, `cleanUp`, a `TeardownLog` that writes nothing), the secrets listed then each reference under `<id>/` not listed looked up (`resolvedSecrets`), the factory rechecked once confirmed (`stillWithoutBucket`); each worker's unarchived evidence previewed for the review by its work inspection alone (`previewUnarchived`), and once the gates inspected them (`unarchivedOn`, `saysUnarchived`); how far it got and what is left (`Progress`), every ending (`refusedUnder`, `failedUnder`, `partialUnder`, `interruptedUnder`), the interrupt checked once the run returns. |
| Application | `src/application/worker-removal.ts` | Shared with `worker terminate`: `inspectForRemoval`, `openTailnetAdmin`, `deleteDevices`. |
| Application | `src/application/stop-dispatch.ts`, `src/application/delete-owned-secret.ts` | `stopDispatch`, `deleteOwnedSecret`. |
| Application | `src/application/plan-store.ts` | `PlanStore.removeAll`. |
| Application | `src/application/lock-store.ts`, `src/application/provisioner.ts`, `src/application/machine-inventory.ts` | `LockStore.deleteBucket` (and its `interrupted`), `LockStore.readOperations`, `StateBucketUnreachable`, `PlanRequest.destroy`, `MachineInventorySource.listVpcs`. |
| Infrastructure | `src/infrastructure/plan-store.ts` | `removeAll`: the factory's plan directory, removed whole. |
| Infrastructure | `src/infrastructure/aws-s3-lock-store.ts` | `readOperations`: ListObjectsV2 under the operation records' prefix, page by page, then GetObject of each, a few at a time, each with its own deadline. |
| Infrastructure | `src/infrastructure/tailscale-api-admin.ts` | `tailscaleApiBase`: Tailscale's API, or the loopback stand-in `FFFACTORY_TAILSCALE_API` names, read only run from source ([worker lifecycle §Tailnet device removal](worker-lifecycle.md#tailnet-device-removal)). |
| CLI adapter | `src/cli/commands/teardown.ts` | `fffactory teardown`: its arguments, refused unechoed; the use case wired to the context; the review and each step streamed; the account check's refusal; the exit code (0 done, 2 partial, 1 otherwise; 128 + N by `src/cli/interrupts.ts`); `waitsOnInterrupt`. |
| CLI adapter | `src/cli/presentation/teardown.ts` | The review (`teardownReviewBlocks`), each step (`teardownProgressLine`, each worker's unarchived evidence in `unarchivedWords` from `src/cli/presentation/worker-inspection.ts`), and every outcome as one report on one stream (`teardownOutcome`), with `withCommands` (`src/cli/presentation/command-line.ts`) for fffactory's words that name commands. |

Tests: `tests/domain/teardown.test.ts` (device selection: known keys exactly
and ignoring case, untagged look-alikes listed, a generated ID's other tagged
devices deleted and a hand-chosen ID's only listed, `acme` against
`acme-lab`, a malformed key ignored, what a generated ID is; the confirmation
rule, the typed ID, the mismatch never echoing its value; the gates' next
actions, for a declared worker and an undeclared one; the kept secrets'
groups, those already absent left out, and the references under the
factory's names to look up, never `acme-lab/`'s for `acme`; a reference whose
lookup failed, answered without a usable name or ARN, or described another
secret, each worded for why; the destroy plan's consistency with its exit code,
root output changes counted, a plan deleting only outputs agreeing with exit 2; the refusals of
operation records that cannot be read, naming each; once reviewed, a
namespace device not shown only listed; `machinesChanged`, a machine reviewed
shutting down and gone since no change; the shown machines and devices
carrying no tag and no malformed host key; what remains where it stopped and
its lines, devices not checked and devices listed but kept carried past the
devices step with their advice; the admin client's pending-deletion hint only
when it is still found; an interruption's words, its step in words, the devices
listed but kept, `fffactory lock break` only for this teardown once exited,
and never without a lock; without a state bucket, why it runs without the lock,
claiming only what it observed, the IAM it leaves to the operator,
the tagged resources named and never a malformed host key, a bucket created
since the review, the question about what is left, no bucket among what
remains; the log archive kept, in both questions and in the factory.json
advice, and that advice without it),
`tests/application/teardown-factory.test.ts` (a factory with no worker, one
running worker, and two with one stopped, each ending with no instance,
network, state, device, owned secret, plan or bucket, its referenced sources
kept, and nothing written or released after the bucket's deletion; the record
step by step; its inspections, one per running worker and none for a stopped
one, identical to `worker inspect`'s documents, written at `inspecting` before
the destroy, a refusal among them kept to the record's end, none when the
machines changed before the inspection, and a final write that fails leaving
the refusal and the inspections already written; the review and the typed ID at a terminal; dispatch stopped on
every running worker before the first inspection; a `fffv/*` source and a
tagged secret kept; D9's devices; a device appearing after the review listed,
not deleted; no device tag or malformed host key tag in the review or report;
a root already absent, with no root output either; a saved plan's removal never failing a finished
teardown; the log archive named kept in the question, review and report,
nothing about it asked of S3 nor the `archive` root planned, with a state
bucket and without one, and none named while factory.json does not enable it;
each worker's unarchived evidence, counted or a stopped one's unknown, said
before the destroy and reported, never refusing, and none said without the log
archive; its preview in the review, before the question and before dispatch is
stopped, unknown for a release without a backlog and for a worker not located
(which the gates still refuse), never refusing, and without the log archive
none, no worker asked for it;
and each refusal
deleting nothing and leaving the lock released: a held lock, busy agents, a
worker on a release from before agent states,
unmanaged checkouts, a worker not located, dispatch not stopped, a machine
started, added or gone since the review, or not listed again, the guarded
destroy plan, its exit code disagreeing, each listing that fails, the admin
client refused, a machine pending, a decline, a wrong `--confirm`, no terminal,
no admin client, an incomplete factory.json, another account, a pin mismatch,
an unready bucket; and once destroyed, a leftover stopping the run before devices,
secrets and the bucket, and a bucket that remains, recorded `partial`; each
failure point, the destroy failing part way (resources left and no root
output, as Terraform deletes the outputs first), a state recording only root
outputs (its output-only plan applied, ending `done`), tagged leftovers, a state still
recording hosts or whose host keys cannot be read after the destroy (a stubbed
state read: a consistent world's EC2 lists a recorded host's instance first;
after an output-only plan's apply too, the read following whether the plan
applied, not whether it destroyed a resource),
a device, a secret denied, past its deadline or pending with its restore
refused, the local plans, the bucket with its lock in each state, listing what
remains, its next action, and a rerun over the world it left ending with
nothing owned, the admin client already gone among them; devices listed but
kept reported past the devices step, and reruns without the admin client
reporting the devices not checked wherever they stop; the admin client still
found past its deadline, refusing the rerun until it is gone; a secret listed
pending deletion; an admin client gone while only root outputs remain, ending
`done`; an admin client gone while resources remain, or outside
`<id>/`, refused; an admin client in another Region looked for there; the
admin client unreadable, the pending-deletion hint only when it is still
found; a reference ListSecrets did not list (secrets §Listing): an owned
one described, deleted and confirmed gone, the run `done` and the bucket
deleted; one not owned, by hand or without both tags, kept; one no longer
found already absent; one named by its full and its partial ARN described,
deleted once and confirmed gone; one also pending deletion restored, deleted
and confirmed gone; one whose lookup is denied, answers without a usable name
or ARN, or describes another secret, refusing in its own words and removing
nothing; the denied one's rerun finishing once the lookup succeeds, also after
the admin client was deleted; remembered host keys under a hand-chosen ID (a
key EC2 alone named, its device not deleted once the destroy completed, then
deleted by the rerun and shown deleted in its review; an interrupt after the
destroy, and tagged leftovers removed by hand, each then a rerun deleting it;
a chain of reruns carrying the keys forward without the first record; the keys
written with the applying step alone, well-formed only, none before; a
teardown declined or refused at the gates remembering none, its host's device
then only listed; an apply that changed the factory since passing them over,
a declined one not; a record write failing at each step up to `applying`
failing teardown before its destroy, its record ending without the keys; an
interrupt as the records are read starting nothing more; an earlier record
that cannot be read, and records that cannot be listed, refusing before
anything is removed); a bucket answering 403; a machine reviewed shutting down gone since; a
failure after dispatch was stopped naming it; a plan directory not removed
never overwriting a refusal; an interrupt at each step, during each of the
destroy plan's Terraform commands, during EC2's listing after the destroy,
during a destroy that then succeeds (reaching no further step), past the
devices step (naming the devices listed but kept), during one secret's restore
or deletion (no further Secrets Manager call, for it or the next secret), as the bucket is emptied
before and after its lock, during the bucket's last deletion, and during each
final record write, keeping the lock; and without a state bucket (§No state
bucket): a factory with only secrets cleaned up without a lock, saying so,
devices and secrets after the review and the typed question about what is
left, a decline, an instance tagged with the factory ID in each listed state
and a tagged VPC refused even with the admin client gone, each EC2 listing
that fails, a bucket created, answering 403, a tagged instance or VPC, or a
listing failing once confirmed, each removing nothing, never a lock, record,
bucket or Terraform call, a rerun after a teardown that deleted the bucket
ending done with the devices not checked and the secrets already absent, a
device or a secret left partial with no bucket among what remains and a rerun
finishing it, a reference not listed whose lookup is denied refusing and, once
it succeeds, the owned secret deleted, the state bucket's outcome `not_found` and `infrastructure`
`not_found_by_ec2`, the admin client gone indeed when a tagged VPC is refused,
an interrupt at the question, while deleting the secrets, once confirmed as
S3 or each EC2 listing answers (no further call started), and before anything
is listed, keeping no lock, its `withoutLock` worded by `interruptedTeardown`
as returned, and a run interrupted at its end still `done`; only
`bucketExists` asked of the state bucket), `tests/infrastructure/plan-store.test.ts`
(`removeAll`), `tests/infrastructure/aws-s3-lock-store.test.ts` (an
interrupted bucket deletion, the typed 403, the operation records read back
page by page against stubbed calls and the local S3 stub, and an unreadable
listing or a failure named), and `tests/domain/operation.test.ts` (a
teardown's remembered host keys: written well-formed and once, read back from
every teardown record, one without `host_keys` remembering none, another
operation's and an object never keyed as a record passed over, those started
before an apply or upgrade whose infrastructure stage is `applying`,
`applied` or `failed`, or in its millisecond, passed over, and those before
one that changed nothing or a worker operation kept, and each record that
cannot be read named). terminate's own tests
(`tests/application/worker-lifecycle.test.ts`) cover the shared helpers.

`tests/cli/presentation/teardown.test.ts` (the review: the target, each
kind, the kept apart, the references already absent apart from them, a malformed
host key only marked, devices not checked with their advice, no state bucket
without a destroy plan, the log archive kept alone and after the secrets kept,
each worker's unarchived evidence previewed after the instances;
each step, each worker's unarchived evidence among them; every outcome on its
stream: a finished
teardown with its advice, with the log archive kept, each worker's unarchived evidence and its advice, with a state
bucket and without one, and naming no archive without it, the devices listed but kept, without a state bucket
not found by EC2 with `checkOutsideEc2`, a wrong `--confirm` unechoed, the
refusals, dispatch left stopped, a decline, a failure with its diagnostics
file, a partial with what remains, an interruption with the lock, before
removing, without a state bucket and before the lock, `fffactory lock break`
only in `interruptedTeardown`'s words; the commands named repeating the
instance and profile), `tests/cli/teardown.test.ts` (in process over the use
case's in-memory factory: `--confirm` without a terminal and the typed ID at a
terminal, exit 0; the log archive named kept in the question, review, report
and advice, nothing about it asked of S3; a wrong `--confirm`, a typed answer, unknown arguments and
`--force` refused, never echoed, before anything is read or asked; no terminal;
another account; factory.json naming the log archive as its state bucket,
archive enabled or not, refused as invalid before AWS is asked anything, the
archive never emptied or deleted; exit 2 part way and a rerun finishing it; an interrupt; help)
and `tests/cli/teardown-executable.test.ts` (the spawned `main.ts` with the real
AWS SDK and Tailscale adapter against `support/stub-sts.ts`, `stub-s3.ts`,
`stub-secrets-manager.ts`, `stub-ec2-instances.ts` (its instances and VPC gone
once the stand-in Terraform applied) and `stub-tailscale-api.ts`
(`FFFACTORY_TAILSCALE_API`), the stand-in Terraform as the managed one, and a
private PATH, HOME and cache: a full teardown exiting 0 with the secrets
force-deleted and the source kept, a wrong `--confirm` reaching no stand-in,
a device not deleted exiting 2 and a rerun finishing it, and no secret value in
any output or Terraform argument).

Partial failure, rerun and interruption by
[#86](https://github.com/yaunder/fffactory/issues/86); the cleanup without a
state bucket by [#87](https://github.com/yaunder/fffactory/issues/87); the
command, its output, exit codes and permissions by
[#88](https://github.com/yaunder/fffactory/issues/88). Introduced by
[#85](https://github.com/yaunder/fffactory/issues/85), on the
building blocks of [#81](https://github.com/yaunder/fffactory/issues/81),
[#82](https://github.com/yaunder/fffactory/issues/82),
[#83](https://github.com/yaunder/fffactory/issues/83) and
[#84](https://github.com/yaunder/fffactory/issues/84).
