# Worker lifecycle

`fffactory worker` powers one declared worker's EC2 instance off and on. It is
the operator's side of a worker's lifecycle; `fffactory host` stays the worker
side of the [host protocol](host-protocol.md). EC2's state is the truth: no
factory.json field records whether a worker is stopped. Epic:
[#5](https://github.com/yaunder/fffactory/issues/5).

## Commands

```text
fffactory worker stop KEY [--force] [--yes] [--instance PATH] [--profile NAME]
fffactory worker start KEY [--yes] [--instance PATH] [--profile NAME]
```

- `stop` stops compute billing. The instance, its root volume (whose storage is
  still billed), its Terraform state, its tailnet device (offline, with its
  non-ephemeral key) and its factory.json entry all stay.
- `start` brings the same worker back, with the same identity, and reports its
  readiness as [status](status.md) would.

`KEY` is a host key factory.json declares (`hosts[].key`). `--force` is stop's
alone ([Gates](#gates)); `--yes` confirms in advance
([Confirmation](#confirmation)); `--instance` and `--profile` select the
instance and the AWS credentials as for every command. Anything else, a missing
subcommand, or not exactly one `KEY` is refused, exit 1, before anything is
read.

## Order

Both commands go in this order, and stop at the first refusal:

1. Select, read and validate factory.json, printing `Instance: PATH (SOURCE)`
   ([instance configuration](instance-configuration.md)).
2. Refuse without a terminal and without `--yes`: the command could never be
   confirmed ([Confirmation](#confirmation)).
3. Refuse a `KEY` factory.json does not declare, naming the declared keys. An
   argument that is not a well-formed host key is refused without being echoed:
   it could be a pasted secret.
4. Refuse unless factory.json is complete, listing each missing field as
   `<path>: is required to stop a worker` (or `start`).
5. The account check: the caller must be in `aws.account_id`, resolved in the
   factory Region ([doctor §AWS account](doctor.md#aws-account)).
6. The [CLI/pin match guard](plan-apply.md#clipin-match-guard): only the
   release factory.json pins may stop or start a worker.
7. Take the factory-wide lock as operation `worker-stop` or `worker-start`, and
   open its [operation record](#operation-record). A held lock refuses the
   command and shows its holder ([provisioning §Lock](provisioning.md#lock)).
8. Locate the one EC2 instance carrying the tags `fffactory:factory-id` = the
   factory ID and `fffactory:host-key` = `KEY`, in every state but
   `terminated` (`DescribeInstances`, as [status](status.md#inventories) lists
   them). None, several (each listed) or an inventory that could not be read is
   refused: fffactory never guesses.
9. Stop's [gates](#gates).
10. The [confirmation](#confirmation).
11. Act: `StopInstances` or `StartInstances` for exactly that instance.
12. Wait for the target state ([Stop](#stop), [Start](#start)).
13. Release the lock (`settleFactoryLock`): unless interrupted
    ([Interruption](#interruption)).

Steps 2 to 6 reach nothing that could change: refusals there take no lock and
write no record. From step 7 every refusal, decline and failure is recorded and
releases the lock. No step before 11 calls EC2's mutating API.

## Tiers

Stop and start are operator-tier: non-destructive, and runnable by a narrow
role. Terminate, a later task of the epic, is admin-tier. These are the
permissions each command needs; fffactory provisions no IAM role or policy for
them.

| Permission | Resource and condition | For |
| --- | --- | --- |
| `sts:GetCallerIdentity` | `*` | The account check. |
| `ec2:DescribeInstances` | `*` (EC2 does not scope it to resources) | Locating the instance and reading its state while waiting. |
| `ec2:StopInstances` | `arn:aws:ec2:REGION:ACCOUNT:instance/*`, condition `StringEquals` `ec2:ResourceTag/fffactory:factory-id` = the factory ID | `worker stop`. |
| `ec2:StartInstances` | The same resource and condition | `worker start`. |
| `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion` | `arn:aws:s3:::BUCKET/<factory ID>-lock.json` | The factory-wide lock ([provisioning §Lock](provisioning.md#lock)). |
| `s3:PutObject` | `arn:aws:s3:::BUCKET/<factory ID>-operations/*` | The operation record. |

Stop's inspection and start's readiness report go over the operator's tailnet
and Tailscale SSH as `fffactory-admin`, as [status](status.md) does; they need
no AWS permission.

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

## Gates

Before stopping a running worker, stop inspects it over the host protocol:

1. Locate it in the operator's peer view by the hostname-match rule and the
   factory's tag ([host protocol §Finding the worker](host-protocol.md#finding-the-worker)).
   A worker that cannot be located (offline, missing, no Tailscale SSH host
   key, a duplicate name, an untagged device, no peer view) cannot be
   inspected: refused, `HOSTNAME could not be inspected: SUMMARY`, with the
   tailnet's next action and `--force stops it uninspected.`
2. Read its agent activity (`host control-plane activity`, the
   [control plane](control-plane.md)'s `activeAgents`). Active agents refuse
   the stop: `N agents are active on HOSTNAME: stopping it would end them`.
   Activity that could not be read (SSH could not reach the worker, an
   unreadable answer, no control plane) refuses it too.

`--force` skips both: the worker is not inspected, and `--force: the worker is
not inspected for active agents.` says so. It never skips the account check,
the pin guard, the lock or the confirmation. Stopping an already stopped or
stopping worker runs no gates.

Accepted race (D5): dispatch may start an agent between the activity check and
the stop, which then ends it. It is marked in `application/worker-lifecycle.ts`
until dispatch gains a pause.

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

A no-op, or an instance already on its way, is never asked about.

## Operation record

The lock's [operation record](plan-apply.md#operation-records) is written when
the lock is taken and again at each step. Its `operation` is `worker-stop` or
`worker-start`, and it has one stage, named `stop` or `start`, which goes
`locating`, then `inspecting` (stop's gates), `awaiting_approval` (only when
asked), `stopping` or `starting` (the request and the wait), and `waiting`
(start's tailnet wait), and ends:

| Stage ends | Operation `status` | When |
| --- | --- | --- |
| `stopped`, `started` | `succeeded` | This command changed the machine's state. |
| `unchanged` | `succeeded` | The machine was already in, or on its way to, the target state. |
| `refused` | `refused` | No single instance, a state it refuses, or a gate. |
| `declined` | `declined` | The question was not confirmed. |
| `failed` | `failed` | EC2 refused the request or did not answer it in time, the machine vanished, the deadline passed, or a step failed. |

The record also carries `machine`: `{"key", "hostname", "instance_id",
"state"}`, the instance once located, with its state when located, then the
state that ended the wait: the target state, the state of a machine being
terminated or gone (`absent`), or at the deadline the last state a read found.
`failure`
names why, in fffactory's words. A record whose final write fails does not
change the outcome: `The operation record could not be finished: REASON` on
standard error.

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
starting. At the confirmation question, an interrupt wins over the answer.

## Exit codes

| Exit | When |
| --- | --- |
| 0 | The worker is stopped or started, including a no-op, and a started worker that is not ready or not online in time. |
| 1 | Refused, declined or failed. |
| 128 + N | Interrupted by signal N. |

## What it never prints

AWS or SDK messages, credentials, or configuration values other than the
factory ID, a host key that passed its format check, `aws.account_id` and
`aws.region`; EC2 failures are named by error name or network code (`EC2
StopInstances failed: UnauthorizedOperation`). A `KEY` argument that is not a
well-formed host key is never echoed. It prints the hostnames it derived,
instance IDs, EC2 states, and what status prints of a worker.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/worker-lifecycle.ts` | The host key check, the one target machine, what each EC2 state means for an action (`powerStep`), stop's gates (`stopGate`), the confirmation rule, the waits' bounds and steps, the words of every refusal and next action. Pure. |
| Domain | `src/domain/operation.ts` | `startStageOperation`, `withMachine` and the power stage's statuses. |
| Domain | `src/domain/status.ts` | The `stopped` machine's next action, `fffactory worker start KEY`. |
| Application | `src/application/machine-control.ts` | The `MachineControl` port: `stop`, `start`, `state`. |
| Application | `src/application/worker-lifecycle.ts` | `stopWorker`, `startWorker`: the order above, under the lock and its record. |
| Infrastructure | `src/infrastructure/ec2-machine-control.ts` | `ec2MachineControl` over `StopInstances`, `StartInstances` and `DescribeInstances` (AWS SDK for JavaScript v3, imported on first use), each call within 15 s (`EC2_CONTROL_TIMEOUT_MS`), failures by error name, a request past its deadline `unanswered`. |
| CLI adapter | `src/cli/commands/worker.ts` | Arguments, progress, the reports, the exit code; `waitsOnInterrupt`. |

Tests: `tests/domain/worker-lifecycle.test.ts` (the host key check, an argument
never echoed, the one machine, every state for each action, each gate, the
confirmation rule and question, the waits' steps and failures, a request
refused or unanswered),
`tests/application/worker-lifecycle.test.ts` (a stop recorded step by step;
active agents, an offline worker, unreadable activity and no control plane
refused, and `--force` overriding them; undeclared key, incomplete
factory.json, another account, a pin mismatch, a held lock, and none or several
instances refused before any EC2 mutation; no-ops never calling EC2's mutating
API; start waiting for running and the tailnet, then reporting readiness, a
stale release naming `fffactory apply`, a worker not online in time and a
tailnet refusal reported at once; a request unanswered in time; the record's
last state at the deadline or a vanished machine; confirmation asked, declined
and refused without a terminal; an interrupt before the lock, during each
wait, at the question, right after the lock, while the request's stage is
written and while the final record is written), `tests/infrastructure/ec2-machine-control.test.ts`
(stubbed calls, deadlines, unknown and absent states, and the real SDK against
`tests/support/stub-ec2-instances.ts`), and `tests/cli/worker.test.ts` (the
reports and exit codes, AWS's message never printed, an argument that is not a
key never echoed, the arguments and help).

Introduced by [#6](https://github.com/yaunder/fffactory/issues/6).
